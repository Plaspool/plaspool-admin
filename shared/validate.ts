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

/**
 * The other five inputs to the same `search` tsvector, and why they need
 * ceilings of their own.
 *
 * `MAX_CONTENT_TEXT_BYTES` bounds `content_text` — one of SIX columns the
 * generated column concatenates. `title`, `subtitle`, `excerpt`, `category` and
 * `tags` are the other five and were unbounded, so a 1.2 MB title raises the
 * same SQLSTATE 54000 on the same INSERT/UPDATE. That surfaces as a `DbError`
 * with no row in spec §8 — a 500, which the client's retry policy treats as
 * transient and retries forever, for a request that can never succeed.
 *
 * The numbers are the UI's own limits with room to spare, in BYTES rather than
 * characters for the reason `MAX_CONTENT_TEXT_BYTES` documents: `TITLE_MAX` is
 * 160 characters and `SUBTITLE_MAX` 220 (`src/routes/Editor.tsx`), category 40
 * and excerpt 320 (`src/editor/MetaPanel.tsx`), tags 32 each — every one of
 * which fits inside its ceiling here even at 4 bytes per character, so nothing
 * a writer can type is refused. Their worst-case sum is ~34 KB against the
 * ~240 KB of headroom left over `MAX_CONTENT_TEXT_BYTES`'s measured 808 580.
 */
export const MAX_TITLE_BYTES = 2_000;
export const MAX_SUBTITLE_BYTES = 2_000;
export const MAX_EXCERPT_BYTES = 4_000;
export const MAX_CATEGORY_BYTES = 400;
export const MAX_TAG_BYTES = 400;
export const MAX_TAGS = 64;

export interface DocViolation {
  /**
   * JSON path of the offending node, `content` for a whole-document limit, or
   * the field name (`title`, `tags`, …) for a metadata limit — spec §8's 422
   * body is `{ error: 'invalid_document', path }` either way.
   */
  path: string;
  reason:
    | 'unknown_node'
    | 'unknown_mark'
    | 'bad_protocol'
    | 'bad_attrs'
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

/** The five non-document fields that feed the same `search` tsvector. */
export interface PostMetaInput {
  title?: unknown;
  subtitle?: unknown;
  excerpt?: unknown;
  category?: unknown;
  tags?: unknown;
}

const META_LIMITS: [field: keyof PostMetaInput, max: number][] = [
  ['title', MAX_TITLE_BYTES],
  ['subtitle', MAX_SUBTITLE_BYTES],
  ['excerpt', MAX_EXCERPT_BYTES],
  ['category', MAX_CATEGORY_BYTES],
];

/**
 * The metadata half of the tsvector bound (spec §4.6).
 *
 * Only the fields PRESENT on `meta` are checked, exactly as `savePost`
 * validates `patch.content` and never the merge: a stored value already over
 * the line — an import, a backfill — must not make the post permanently
 * unsavable, which is the failure this whole ceiling exists to prevent.
 *
 * Returns the violation rather than throwing, so a route maps it straight onto
 * the 422 of spec §8 instead of letting a 54000 arrive as a retryable 500.
 */
export function checkPostMeta(meta: PostMetaInput): DocViolation | null {
  for (const [field, max] of META_LIMITS) {
    const value = meta[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return { path: field, reason: 'malformed' };
    if (utf8Bytes(value) > max) return { path: field, reason: 'too_large' };
  }

  const tags = meta.tags;
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) return { path: 'tags', reason: 'malformed' };
  if (tags.length > MAX_TAGS) return { path: 'tags', reason: 'too_large' };
  for (let i = 0; i < tags.length; i += 1) {
    if (typeof tags[i] !== 'string') return { path: `tags[${i}]`, reason: 'malformed' };
    if (utf8Bytes(tags[i] as string) > MAX_TAG_BYTES) {
      return { path: `tags[${i}]`, reason: 'too_large' };
    }
  }
  return null;
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

// ----------------------------------------------------------------- attributes

/**
 * The attribute NAMES each node and mark type may carry.
 *
 * Attributes were not checked at all, so `{type:'heading', attrs:{level:999}}`,
 * a link mark carrying `onclick`, and a code block whose `language` is
 * `"><script>alert(1)</script>` all round-tripped into `jsonb`. Today's
 * `DocRenderer` enumerates the attributes it reads and is therefore inert
 * against every one of them — but spec §6's public renderer inherits whatever
 * is stored, and "the renderer happens to ignore it" is not a property the
 * database can rely on.
 *
 * READ THIS BEFORE ADDING AN EXTENSION. These sets are transcribed from the
 * live ProseMirror schema, so an extension that adds an attribute — or a TipTap
 * upgrade that adds one to an existing node — makes every document carrying it
 * unsavable, which is the same class of defect as the link-protocol one above.
 * `src/editor/schema-drift.test.tsx` drives a real `Editor` and fails on
 * exactly that, before a writer can meet it. An empty set means the live schema
 * defines no attributes for that type, not that the type was forgotten.
 */
const NODE_ATTRS: Record<string, ReadonlySet<string>> = {
  doc: new Set(),
  text: new Set(),
  paragraph: new Set(),
  heading: new Set(['level']),
  blockquote: new Set(),
  bulletList: new Set(),
  orderedList: new Set(['start', 'type']),
  listItem: new Set(),
  taskList: new Set(),
  taskItem: new Set(['checked']),
  codeBlock: new Set(['language']),
  horizontalRule: new Set(),
  hardBreak: new Set(),
  image: new Set(['src', 'alt', 'title', 'width', 'height']),
  table: new Set(),
  tableRow: new Set(),
  tableHeader: new Set(['colspan', 'rowspan', 'colwidth', 'align']),
  tableCell: new Set(['colspan', 'rowspan', 'colwidth', 'align']),
};

/** A type not in the tables above carries no attributes at all. */
const EMPTY_ATTRS: ReadonlySet<string> = new Set();

const MARK_ATTRS: Record<string, ReadonlySet<string>> = {
  bold: new Set(),
  italic: new Set(),
  underline: new Set(),
  strike: new Set(),
  code: new Set(),
  // `target`/`rel`/`class` are the Link extension's own attributes and are in
  // every stored href — dropping them from this list would 422 every post that
  // contains a link.
  link: new Set(['href', 'target', 'rel', 'class', 'title']),
};

/**
 * `heading.level` is bounded because it is the one attribute a renderer turns
 * into a TAG NAME. Six, not the editor's configured `[2, 3]`: a document
 * imported from elsewhere legitimately carries `1`, and refusing it would lose
 * the import rather than the attack.
 */
const MAX_HEADING_LEVEL = 6;

/**
 * A code block's `language` reaches the highlighter and a `class` attribute.
 * The editor only ever writes a registered grammar name, and the paste repair
 * only keeps `[a-z0-9+#-]` out of a `language-*` class, so this charset refuses
 * nothing the app produces.
 */
const CODE_LANGUAGE = /^[A-Za-z0-9+#._-]{1,32}$/;

function checkAttrs(
  node: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: () => string,
): DocViolation | null {
  const attrs = node.attrs;
  if (attrs === undefined || attrs === null) return null;
  if (typeof attrs !== 'object' || Array.isArray(attrs)) {
    return { path: path(), reason: 'malformed' };
  }
  for (const name of Object.keys(attrs)) {
    if (!allowed.has(name)) return { path: path(), reason: 'bad_attrs' };
  }
  return null;
}

function checkAttrValues(
  type: string,
  attrs: Record<string, unknown>,
  path: () => string,
): DocViolation | null {
  if (type === 'heading') {
    const level = attrs.level;
    // Absent is fine — ProseMirror fills the schema default and a renderer
    // falls back the same way. A level that is PRESENT and out of range is the
    // one that becomes `<h999>`.
    if (
      level != null &&
      (typeof level !== 'number' ||
        !Number.isInteger(level) ||
        level < 1 ||
        level > MAX_HEADING_LEVEL)
    ) {
      return { path: path(), reason: 'bad_attrs' };
    }
  }
  if (type === 'codeBlock') {
    const language = attrs.language;
    if (language != null && (typeof language !== 'string' || !CODE_LANGUAGE.test(language))) {
      return { path: path(), reason: 'bad_attrs' };
    }
  }
  return null;
}

// ------------------------------------------------------------------- protocols

/**
 * One URL allow-list, on both sides of the app.
 *
 * Moved here from `src/data/docguards.ts` (which now re-exports it) because
 * `shared/` cannot import from `src/` and the server must apply exactly the
 * rule the editor and the reader apply.
 *
 * WHY THE LIST IS THIS LONG. TipTap's Link `protocols` option only *appends* to
 * a hardcoded baseline — `http https ftp ftps mailto tel callto sms cid xmpp`,
 * read out of `@tiptap/extension-link`'s own `isAllowedUri` — so
 * `protocols: ['http','https','mailto']` restricts nothing and the editor
 * happily writes a `tel:` link. A validator narrower than the editor does not
 * make the app safer; it makes the post **unsavable**, because `savePost`
 * validates `patch.content` on every save and spec §8 makes 422 a permanent
 * stop in the client's retry policy. So the two lists are the same list, and
 * the drift guard in `src/editor/schema-drift.test.tsx` drives a real `Editor`
 * to keep them that way.
 *
 * Widening this beyond what the editor admits is the only real hazard here, and
 * `javascript:`, `data:` and `vbscript:` are absent by construction: it is an
 * allow-list, not a deny-list.
 */
export const ALLOWED_LINK_PROTOCOLS: readonly string[] = [
  'http:',
  'https:',
  'mailto:',
  'ftp:',
  'ftps:',
  'tel:',
  'callto:',
  'sms:',
  'cid:',
  'xmpp:',
];

/**
 * Everything a browser throws away before it parses a URL, and therefore
 * everything that can hide a scheme from a naive `startsWith`.
 *
 * `value.trim()` was not enough: it removes nothing from the MIDDLE, so
 * `java\nscript:alert(1)` used to survive only because it failed the scheme
 * regex outright and fell into the reject branch. Now that a scheme-less href
 * is ACCEPTED (see `isAllowedHref`), "no scheme matched" can no longer mean
 * "reject", and a href that hides its colon behind a control character would be
 * waved through as if it were `/about`. Stripping first is what keeps
 * `java\nscript:` a `javascript:` — this is the same character class
 * `@tiptap/extension-link` strips, plus the C1 controls and U+FEFF.
 */
// eslint-disable-next-line no-control-regex -- matching them IS the job here
const URL_INVISIBLES = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000\ufeff]/g;

/**
 * Anchored and charset-restricted on the *de-obfuscated* string, so neither a
 * leading space nor an embedded control character (` javascript:`,
 * `java\nscript:`) can smuggle a protocol past it.
 *
 * `null` means "this href names no scheme at all" — a relative, root-relative,
 * protocol-relative, fragment or query-only URL. It does NOT mean "unsafe".
 */
export function protocolOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(value.replace(URL_INVISIBLES, ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * What a stored link `href` may be.
 *
 * A SCHEME-LESS HREF IS VALID AND MUST STAY VALID. `#footnote`, `/about`,
 * `//cdn.example/x` and `?ref=1` are all things the editor writes — verified by
 * driving a real `Editor` in `src/editor/schema-drift.test.tsx` — and every one
 * of them was refused as `bad_protocol` before, which made any post containing
 * one permanently unsavable: `savePost` validates `patch.content` on every
 * save, the 422 is a permanent stop in the client's retry policy (spec §8), and
 * the pending write is dropped rather than retried. The writer keeps typing
 * into a post that can never be persisted.
 *
 * The rule is therefore: a href that names a scheme must name an allowed one; a
 * href that names no scheme is relative and is allowed. `protocolOf` does the
 * de-obfuscation, so "names no scheme" cannot be faked.
 */
export function isAllowedHref(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const p = protocolOf(value);
  if (p === null) return true;
  return ALLOWED_LINK_PROTOCOLS.includes(p);
}

/**
 * The remote protocols a *stored* image `src` may name — the same two
 * `src/data/docguards.ts`'s `ALLOWED_IMAGE_PROTOCOLS` renders, and that
 * identity is the whole point of the list.
 *
 * `http:` IS HERE BECAUSE THE EDITOR EMITS IT, NOT BECAUSE IT IS GOOD.
 * Measured before the change, on this repo's own TipTap 3.29: an `http://…`
 * image survives `repairPastedHTML` intact (`stripHostile` keeps any src that
 * passes `isAllowedImageSrc`, which is http/https) and the ProseMirror parse
 * keeps the node. This validator refused it. Because `savePost` validates
 * `patch.content` on EVERY save and spec §8 makes a 422 a permanent stop in the
 * client's retry policy, **one pasted `http://` image made a post unsavable
 * forever** — the writer keeps typing into a document that can never be
 * persisted. That is the same class of defect as the scheme-less-href one this
 * file already records, and it was fixed the same way both previous times: one
 * list wide enough for everything the editor emits, enforced identically on
 * both surfaces.
 *
 * NARROWING THE EDITOR INSTEAD WAS CONSIDERED AND REJECTED. It loses the
 * picture on paste *and* strands every document already holding one, which is
 * strictly worse under this project's prime directive — a stored document must
 * never become unwritable.
 *
 * The privacy consequence is stated rather than hidden: a remote `src` already
 * leaks the reader's IP (the `https:` case is on the carried-hazard list) and
 * `http:` adds plaintext. The real fix is the server-side fetch-and-store with
 * a host allow-list `ARCHITECTURE.md` already specifies. It is not this list.
 *
 * NAMED `STORABLE_…` AND NOT `ALLOWED_IMAGE_PROTOCOLS`, deliberately.
 * `src/data/docguards.ts` already exports that name for the render-side copy of
 * the same two members, and this slice does not own that file — a second export
 * under the identical name would read as one shared constant while being two.
 * The two lists are held equal by `src/editor/schema-drift.test.tsx`, which
 * drives a real `Editor` and a real `repairPastedHTML` over an `IMAGE_SRCS`
 * table: whatever the editor keeps must be storable. Collapsing them into one
 * re-export is a one-line follow-up in `docguards.ts`.
 */
export const STORABLE_IMAGE_PROTOCOLS: readonly string[] = ['https:', 'http:'];

/**
 * What an image `src` may be in a *stored* document: an allowed remote
 * protocol, plus the two opaque local-reference schemes (spec §4.6).
 *
 * `idb:` stays accepted because it is what every pre-cutover document uses and
 * refusing it would make migration impossible; `asset:` is canonical after.
 * Neither carries protocol risk — they are ids, resolved by the app. A
 * scheme-less src stays refused, unlike a scheme-less *href*: nothing in this
 * application writes a relative image, `stripHostile` deletes one on paste
 * (measured), and there is no server route a relative image path could resolve
 * against, so accepting one would widen the list past what the editor emits for
 * no reachable document's benefit.
 *
 * Widening this beyond what the editor admits is the only real hazard here, and
 * `javascript:`, `data:` and `vbscript:` are absent by construction: it is an
 * allow-list, not a deny-list.
 */
export function isStorableImageSrc(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const id = imageIdFromSrc(value);
  if (id !== null) return IMAGE_ID.test(id);
  const protocol = protocolOf(value);
  return protocol !== null && STORABLE_IMAGE_PROTOCOLS.includes(protocol);
}

/**
 * The id shape `asset:` and `idb:` may carry, and the reason this is not simply
 * "any non-empty suffix".
 *
 * Spec §3.6 makes `storage_key = images/<owner>/<id>`, so the id IS a path
 * segment of an object key. `asset:../../etc/passwd` used to validate, which
 * means a document could name an object outside its own prefix the moment
 * anything joined the id into a key. Constrained to the frontend's `img_`
 * convention — `newId('img_')` in `src/data/db.ts` is `img_` + base36 millis +
 * 16 hex — so no separator, dot or slash can appear at all.
 */
const IMAGE_ID = /^img_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

  const badAttrs = checkAttrs(node, NODE_ATTRS[type] ?? EMPTY_ATTRS, () => pathOf(frame));
  if (badAttrs) return badAttrs;
  const badValues = checkAttrValues(
    type,
    (node.attrs as Record<string, unknown>) ?? {},
    () => pathOf(frame),
  );
  if (badValues) return badValues;

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
  const badAttrs = checkAttrs(mark, MARK_ATTRS[mark.type] ?? EMPTY_ATTRS, path);
  if (badAttrs) return badAttrs;
  if (mark.type === 'link') {
    const href = (mark.attrs as Record<string, unknown>)?.href;
    /*
     * A link mark with NO href is inert, not hostile — there is no protocol to
     * refuse. It is also reachable: `Link`'s `href` attribute defaults to
     * `null`, and `setMark('link', {})` leaves exactly that in the document
     * (verified by driving a real Editor; TipTap itself throws on the way, but
     * the mark still lands). Refusing it would make that document unsavable
     * forever, which is the same defect as refusing `#fn1`.
     *
     * `''` takes the same path through `isAllowedHref`, and `DocRenderer`
     * renders both as plain text rather than as an anchor.
     */
    if (href != null && !isAllowedHref(href)) {
      return { path: path(), reason: 'bad_protocol' };
    }
  }
  return null;
}
