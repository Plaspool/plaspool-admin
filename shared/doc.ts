import type { DocNode } from './types';

/**
 * Inline images are persisted as `idb:<blobId>` and resolved from the local
 * image store at render time. An object URL would be dead after a reload and
 * base64 would bloat every save and every revision snapshot.
 */
export const IDB_SCHEME = 'idb:';

/** Walk a ProseMirror doc collecting text, block by block. */
export function docToText(doc: DocNode | null | undefined): string {
  if (!doc) return '';
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (typeof n.text === 'string') out.push(n.text);
    if (n.content) n.content.forEach(walk);
    // Treat block boundaries as whitespace so "a</p><p>b" isn't "ab".
    if (n.content && n.type !== 'text') out.push(' ');
  };
  walk(doc);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/**
 * The text of the document's FIRST top-level block — the product overview
 * fallback (migration 0580).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS NOT `docToText(doc).split('\n')[0]`, AND THAT IS THE WHOLE REASON THIS
 * FUNCTION EXISTS RATHER THAN A ONE-LINER AT THE CALL SITE.
 *
 * `docToText` above ends with `.replace(/\s+/g, ' ')`. Every newline in the
 * document is already gone by the time it returns, so splitting its output on
 * `\n` yields exactly one element: the ENTIRE description. The fallback would
 * silently be the whole document on every product, which on a card renders as
 * a wall of text and in a `<meta>` tag is worse — and it would look completely
 * correct in any test whose fixture happened to have one paragraph.
 *
 * `content[0]` instead: ProseMirror's top-level children ARE the blocks, so the
 * first one is the first paragraph or heading, and running the existing walker
 * over just that node reuses the mark/nesting handling rather than reimplementing
 * it. This is the same class of bug as migration 0520's lax-jsonpath doubling —
 * an extractor that looked obviously right and was not — which is why this is a
 * unit-tested TypeScript function and not an expression inside SQL.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A LEADING EMPTY BLOCK IS SKIPPED. The editor leaves an empty paragraph at the
 * top of a document more often than anyone would like, and "the first block" of
 * such a document is honestly the first one with words in it.
 */
export function firstBlockText(doc: DocNode | null | undefined): string {
  if (!doc?.content) return '';
  for (const block of doc.content) {
    const text = docToText(block);
    if (text !== '') return text;
  }
  return '';
}

/**
 * `firstBlockText`, cut to `max` characters on a word boundary.
 *
 * The cut is at a SPACE and never mid-word, and the ellipsis is the single
 * character `…` rather than three dots, because the three-dot spelling costs
 * two more of the characters the caller was trying to save.
 */
export function summarise(doc: DocNode | null | undefined, max = 300): string {
  const text = firstBlockText(doc);
  if (text.length <= max) return text;
  // `max - 1` leaves room for the ellipsis, so the result never exceeds `max`.
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // A single word longer than `max` has no space to cut at; hard-cut it rather
  // than return the whole thing and break the caller's ceiling.
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** 225 wpm is the usual publishing figure; never report 0 for non-empty posts. */
export function readingTime(words: number): number {
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / 225));
}

export function deriveExcerpt(doc: DocNode | null | undefined, limit = 180): string {
  const text = docToText(doc);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : limit).trimEnd()}…`;
}

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return base || 'untitled';
}

/** Guard against a corrupted or foreign `content` value crashing the editor. */
export function isValidDoc(value: unknown): value is DocNode {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as DocNode).type === 'doc' &&
    Array.isArray((value as DocNode).content)
  );
}

/** Canonical scheme once bytes live in object storage. */
export const ASSET_SCHEME = 'asset:';

/** Accepts both schemes — `idb:` is what every pre-migration document uses. */
export function imageIdFromSrc(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  if (src.startsWith(ASSET_SCHEME)) return src.slice(ASSET_SCHEME.length) || null;
  if (src.startsWith(IDB_SCHEME)) return src.slice(IDB_SCHEME.length) || null;
  return null;
}
