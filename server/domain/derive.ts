import { countWords, deriveExcerpt, docToText, readingTime } from '../../shared/doc';
import type { DocNode } from '../../shared/types';

/**
 * The fields the server computes rather than accepts (spec §4.4).
 *
 * `wordCount`, `readingTime`, a derived `excerpt` and `content_text` are all
 * functions of the document, so a client may compute them optimistically for
 * instant feedback but the response overwrites. They are derived here, from
 * `shared/doc.ts`, so the two sides cannot disagree by a word.
 */
export interface Derived {
  /** `posts.content_text`. Storage detail: never on `Post`, never returned. */
  contentText: string;
  wordCount: number;
  readingTime: number;
}

export function derive(content: DocNode): Derived {
  const contentText = docToText(content);
  const wordCount = countWords(contentText);
  return { contentText, wordCount, readingTime: readingTime(wordCount) };
}

/**
 * The excerpt branch from `src/data/posts.ts:135-141`, reproduced exactly.
 *
 * A 'derived' excerpt tracks the opening of the post; an 'author' one is left
 * exactly as written. Without the distinction the first derivation froze
 * forever and cards advertised text the post no longer contained.
 *
 * `currentExcerpt` IS REQUIRED and the plan's signature omits it. The last
 * branch — patch silent, source already 'author' — has to return the stored
 * excerpt unchanged, and with only `currentSource` there is nothing to return.
 * Written to the plan's signature this function would blank every
 * author-written excerpt on the next autosave.
 */
export function nextExcerpt(a: {
  /** `patch.excerpt`. `undefined` means the caller did not mention it. */
  patchExcerpt?: string;
  currentExcerpt: string;
  currentSource: 'derived' | 'author';
  /** The document the excerpt would be derived from — i.e. the NEXT content. */
  content: DocNode;
}): { excerpt: string; excerptSource: 'derived' | 'author' } {
  if (a.patchExcerpt !== undefined) {
    const written = a.patchExcerpt.trim();
    // Clearing the field is the gesture for "track the post again", so it flips
    // the source back rather than storing an empty author excerpt.
    return written
      ? { excerpt: written, excerptSource: 'author' }
      : { excerpt: deriveExcerpt(a.content), excerptSource: 'derived' };
  }
  if (a.currentSource !== 'author') {
    return { excerpt: deriveExcerpt(a.content), excerptSource: 'derived' };
  }
  return { excerpt: a.currentExcerpt, excerptSource: 'author' };
}
