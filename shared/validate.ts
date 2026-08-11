/**
 * Document validation shared by the client and the server (spec §4.6).
 *
 * THE DEPENDENCY RUNS ONE WAY. This file owns `ALLOWED_NODES`/`ALLOWED_MARKS`
 * and `src/components/DocRenderer.tsx` imports them — never the reverse, since
 * `shared/` must not import a `.tsx` file. The renderer's `switch` is also not
 * a transcribable source: its `default` arm is deliberately permissive (an
 * unknown block keeps its words as text) and it has no `doc` case at all,
 * because the root is handled by the walk. A literal transcription would reject
 * every valid document. The lists below are derived from what the editor
 * actually produces — `createEditorExtensions()` in `src/editor/extensions.ts`.
 */
import { docToText, imageIdFromSrc, isValidDoc } from './doc';
import type { DocNode } from './types';

/** Serialised `content`, spec §4.6. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** Spec §4.6. Enforced by Task 4's `validateDoc`. */
export const MAX_DOC_DEPTH = 40;

/** Spec §4.6. Enforced by Task 4's `validateDoc`. */
export const MAX_DOC_NODES = 20_000;

/**
 * The ceiling on `docToText(content)` — the `posts.content_text` column, and
 * therefore the input to the generated `search` tsvector.
 *
 * THIS IS NOT A STYLE CHOICE, IT IS THE DATABASE'S LIMIT. A `tsvector` cannot
 * hold more than MAXSTRPOS = 1 048 575 bytes of lexemes and positions; past
 * that Postgres raises SQLSTATE 54000 and the row cannot be written at all.
 * Without a ceiling here a document this validator calls VALID — comfortably
 * under `MAX_DOC_BYTES` — is physically unstorable, and because the failure is
 * on an UPDATE it makes an existing post permanently unwritable rather than
 * merely refusing a new one.
 *
 * **Bytes, not characters.** `left(content_text, n)` in SQL counts characters,
 * so a character ceiling bounds nothing for multibyte text: 600 000 CJK
 * characters are 1.4 MB and still raise 54000 (measured on PGlite 18.3).
 *
 * **Why 500 000.** The worst of twelve adversarial shapes measured at this size
 * (2/3/4/5/6/8-character ASCII tokens, and 1/2/3-character tokens over 2-byte
 * and 3-byte alphabets) produced a 808 580-byte lexeme area — 22.9% under the
 * limit. Ordinary prose is nowhere near: lexemes dedupe, so 2 MB of an
 * eight-word vocabulary is a 1 572-byte tsvector. The shapes that get close are
 * the high-diversity ones — a glossary, an index, an SKU table, a changelog of
 * hashes, a CSV paste.
 *
 * The same number is the `CASE` threshold in
 * `server/db/migrations/0001_bound_search_input.sql`, and the two must stay
 * equal. The validator rejects at exactly the point the database starts
 * truncating, so a document that passes here is always indexed whole, and the
 * database's truncation branch is reachable only by a row that never came
 * through this validator — an import, a backfill, manual SQL.
 */
export const MAX_CONTENT_TEXT_BYTES = 500_000;

export interface DocViolation {
  /** JSON path of the offending node, or `content` for a whole-document limit. */
  path: string;
  reason:
    | 'unknown_node'
    | 'unknown_mark'
    | 'bad_protocol'
    | 'too_deep'
    | 'too_large'
    | 'too_many_nodes'
    | 'malformed';
}

/** UTF-8 length. `String.length` counts UTF-16 units and undercounts by up to 3× . */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The two size ceilings, checked without walking the document.
 *
 * Returns the violation rather than throwing, so a route can map it straight
 * onto the 422 `{ error: 'invalid_document', path }` of spec §8. Both are
 * checked here because they fail for different reasons and neither implies the
 * other: `MAX_DOC_BYTES` bounds what the request body and the `jsonb` column
 * carry, `MAX_CONTENT_TEXT_BYTES` bounds what the search index can be built
 * from, and a document can be small in one and over the line in the other.
 */
export function checkDocSize(value: unknown): DocViolation | null {
  const serialised = serialise(value);
  if (serialised === null) {
    // Circular, or too deeply nested for `JSON.stringify` to finish. Callers
    // that need to tell those apart use `validateDoc`, which walks; here
    // too_large is the honest answer for "we cannot measure it, so we will not
    // store it".
    return TOO_LARGE;
  }
  if (utf8Bytes(serialised) > MAX_DOC_BYTES) return TOO_LARGE;
  // `docToText` walks `content` arrays; anything that is not a document shape
  // is `validateDoc`'s `malformed`, not this function's business.
  if (!isValidDoc(value)) return null;
  return checkContentTextSize(value);
}

const TOO_LARGE: DocViolation = { path: 'content', reason: 'too_large' };

/**
 * `JSON.stringify`, or `null` when it cannot finish.
 *
 * It fails on two different documents and both matter: a circular one, and a
 * deeply nested one — measured, V8 gives up at ~2 389 levels with a RangeError,
 * which is *shallower* than the ~3 942 at which a recursive JS walk of the same
 * document overflows. That ordering is why `checkDocSize` can call `docToText`
 * (which recurses) at all: any document deep enough to overflow the walk has
 * already been refused here.
 */
function serialise(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return null;
  }
}

function checkContentTextSize(doc: DocNode): DocViolation | null {
  return utf8Bytes(docToText(doc)) > MAX_CONTENT_TEXT_BYTES ? TOO_LARGE : null;
}

// ------------------------------------------------------------- the allow-list

/**
 * Every node type `createEditorExtensions()` can put in a document: StarterKit
 * (headings [2,3], `codeBlock`/`link`/`underline` disabled) + CodeBlockLowlight
 * + TableKit + Underline + Link + StudioImage + TaskList + TaskItem.
 *
 * `doc` is in the list and is deliberately not a `DocRenderer` case. The four
 * table types are in it because `TableKit` is in the editor and the renderer has
 * real arms for all four — the plan's list predates the table work, and a
 * validator that omitted them would 422 every post containing a table.
 *
 * Additive changes are safe; removals are not. A node type dropped from here
 * makes every stored post containing it unsavable, so a type only leaves this
 * list together with a migration that rewrites the documents holding it.
 */
export const ALLOWED_NODES: ReadonlySet<string> = new Set([
  'doc',
  'text',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
]);

/** StarterKit's bold/italic/strike/code, plus the standalone Underline and Link. */
export const ALLOWED_MARKS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
]);

// ------------------------------------------------------------------- protocols

/**
 * One URL allow-list, on both sides of the app.
 *
 * Moved here from `src/data/docguards.ts` (which now re-exports it) because
 * `shared/` cannot import from `src/` and the server must apply exactly the
 * rule the editor and the reader apply — TipTap's Link `protocols` option only
 * *appends* to a hardcoded baseline containing `tel`, `ftp`, `xmpp` and `sms`,
 * so configuring it restricts nothing and this predicate is the real gate.
 */
export const ALLOWED_LINK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

/**
 * Anchored and charset-restricted on the trimmed string, so neither a leading
 * space nor an embedded control character (` javascript:`, `java\nscript:`) can
 * smuggle a protocol past it.
 */
export function protocolOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(value.trim());
  return m ? m[1].toLowerCase() : null;
}

export function isAllowedHref(value: unknown): boolean {
  const p = protocolOf(value);
  return p !== null && ALLOWED_LINK_PROTOCOLS.includes(p);
}

/**
 * What an image `src` may be in a *stored* document: `https:`, plus the two
 * opaque local-reference schemes (spec §4.6).
 *
 * `idb:` stays accepted because it is what every pre-cutover document uses and
 * refusing it would make migration impossible; `asset:` is canonical after.
 * Neither carries protocol risk — they are ids, resolved by the app.
 *
 * DELIBERATELY NARROWER THAN THE CLIENT'S RENDER GUARD, which still allows
 * `http:` (`isAllowedImageSrc` in `src/data/docguards.ts`). A pasted `http://…`
 * image is therefore producible in the editor and refused here. Spec §4.6 and
 * the plan both list https-only, so that is what this enforces; closing the gap
 * means tightening the editor, which is a frontend change with a visible effect
 * on existing documents and is not this task's to make.
 */
export function isStorableImageSrc(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (imageIdFromSrc(value) !== null) return true;
  return protocolOf(value) === 'https:';
}

// ----------------------------------------------------------------- validateDoc

/**
 * The full document check: size, shape, allow-lists, protocols.
 *
 * ORDER IS PART OF THE CONTRACT.
 *
 * 1. The serialised byte ceiling first, so a hostile payload cannot buy a full
 *    traversal before being refused.
 * 2. The structural walk, with an EXPLICIT STACK and never recursion — a
 *    10 000-deep document must come back as a violation, not a `RangeError`.
 *    A `RangeError` is a 500, and a 500 is retried by the client's policy.
 * 3. The derived-text ceiling last, because `docToText` recurses and is only
 *    safe once the walk has capped depth at `MAX_DOC_DEPTH`.
 *
 * Note step 1 does not *report* when it cannot measure. `JSON.stringify` throws
 * on a document deeper than ~2 389, and answering `too_large` there would name
 * the wrong problem; the walk reaches `too_deep` in 41 pops, so it decides.
 *
 * Returns the violation rather than throwing, so a route maps it straight onto
 * the 422 `{ error: 'invalid_document', path }` of spec §8. Rejection is never
 * a silent repair.
 */
export function validateDoc(
  value: unknown,
): { ok: true; doc: DocNode } | { ok: false; violation: DocViolation } {
  const serialised = serialise(value);
  if (serialised !== null && utf8Bytes(serialised) > MAX_DOC_BYTES) {
    return { ok: false, violation: TOO_LARGE };
  }

  const structural = walkDoc(value);
  if (structural) return { ok: false, violation: structural };

  const doc = value as DocNode;
  const oversized = checkContentTextSize(doc);
  if (oversized) return { ok: false, violation: oversized };

  return { ok: true, doc };
}

/**
 * A node on the walk stack.
 *
 * `parent` rather than a precomputed path string: a 2 MB document can hold
 * ~160 000 nodes, and building a path for every one of them to report at most
 * one is work no valid document should pay for. Walking the chain on a
 * violation is bounded by `MAX_DOC_DEPTH`.
 */
interface Frame {
  node: unknown;
  parent: Frame | null;
  index: number;
  depth: number;
}

function pathOf(frame: Frame): string {
  const parts: string[] = [];
  for (let f: Frame | null = frame; f && f.parent; f = f.parent) {
    parts.push(`content[${f.index}]`);
  }
  return parts.length ? parts.reverse().join('.') : 'content';
}

function isNodeLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkDoc(value: unknown): DocViolation | null {
  if (!isNodeLike(value) || value.type !== 'doc' || !Array.isArray(value.content)) {
    return { path: 'content', reason: 'malformed' };
  }

  let nodes = 0;
  const stack: Frame[] = [{ node: value, parent: null, index: 0, depth: 0 }];

  while (stack.length) {
    // Non-null: the loop condition is the length check.
    const frame = stack.pop() as Frame;

    nodes += 1;
    // The node cap is also what terminates a circular document. That cannot
    // arrive over HTTP (`JSON.parse` builds no cycles) but is reachable
    // in-process, and an unbounded walk there is a hung request.
    if (nodes > MAX_DOC_NODES) return { path: pathOf(frame), reason: 'too_many_nodes' };
    if (frame.depth > MAX_DOC_DEPTH) return { path: pathOf(frame), reason: 'too_deep' };

    const violation = checkNode(frame);
    if (violation) return violation;

    const content = (frame.node as DocNode).content;
    if (content === undefined) continue;
    if (!Array.isArray(content)) return { path: pathOf(frame), reason: 'malformed' };
    // Reversed, so siblings pop in document order and the violation reported is
    // the first one a reader would meet.
    for (let i = content.length - 1; i >= 0; i -= 1) {
      stack.push({ node: content[i], parent: frame, index: i, depth: frame.depth + 1 });
    }
  }

  return null;
}

function checkNode(frame: Frame): DocViolation | null {
  const node = frame.node;
  if (!isNodeLike(node)) return { path: pathOf(frame), reason: 'malformed' };

  const type = node.type;
  if (typeof type !== 'string' || type === '') {
    return { path: pathOf(frame), reason: 'malformed' };
  }
  if (!ALLOWED_NODES.has(type)) return { path: pathOf(frame), reason: 'unknown_node' };
  // A text node with no string in it is not a document the editor wrote, and
  // `docToText` would silently drop it rather than fail.
  if (type === 'text' && typeof node.text !== 'string') {
    return { path: pathOf(frame), reason: 'malformed' };
  }

  const marks = node.marks;
  if (marks !== undefined) {
    if (!Array.isArray(marks)) return { path: pathOf(frame), reason: 'malformed' };
    for (let i = 0; i < marks.length; i += 1) {
      const violation = checkMark(marks[i], () => `${pathOf(frame)}.marks[${i}]`);
      if (violation) return violation;
    }
  }

  if (type === 'image' && !isStorableImageSrc((node.attrs as Record<string, unknown>)?.src)) {
    return { path: pathOf(frame), reason: 'bad_protocol' };
  }

  return null;
}

function checkMark(mark: unknown, path: () => string): DocViolation | null {
  if (!isNodeLike(mark) || typeof mark.type !== 'string') {
    return { path: path(), reason: 'malformed' };
  }
  if (!ALLOWED_MARKS.has(mark.type)) return { path: path(), reason: 'unknown_mark' };
  if (mark.type === 'link') {
    const href = (mark.attrs as Record<string, unknown>)?.href;
    if (!isAllowedHref(href)) return { path: path(), reason: 'bad_protocol' };
  }
  return null;
}
