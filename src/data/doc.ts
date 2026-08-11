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
