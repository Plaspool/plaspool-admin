import { toEpochMs } from '../db/client';
import type {
  CoverImage,
  DocNode,
  Post,
  PublicCoverImage,
  PublicPost,
  PublicPostDetail,
  ReadingTemplate,
} from '../../shared/types';

/**
 * The public projection (plan D3) — an ALLOW-LIST, built rather than filtered.
 *
 * Nothing in this file may be written as "a `Post`/`ListPost` with keys
 * removed". `{ ...rowToListPost(row), authorId: undefined }` is a deny-list
 * wearing a disguise: the next field added to `Post` arrives on the public
 * surface the moment it is added, which is threat T2 exactly. Every mapper below
 * names each field it emits, reading the raw driver row.
 */

/**
 * EVERY FIELD OF `Post`, CLASSIFIED. THIS OBJECT IS THE CONTROL FOR T2.
 *
 * `Record<keyof Post, …>` is exhaustive, so adding a field to `Post` makes this
 * object fail to typecheck (TS2741 — missing property) until somebody decides,
 * in writing, whether the public API may see it. That compile error is the
 * security control; it is not documentation of one.
 *
 * The v1 mechanism a reviewer proved inert — `keyof PublicPost extends keyof
 * Post` — compiles clean under `--strict` when `Post` gains a field, and an
 * interface has no runtime keys to enumerate. This does bite, and
 * `public.test.ts` additionally pins the built object's runtime keys against the
 * `'public'` entries here so the map cannot drift away from the mappers.
 *
 * Note `author: { name }` is a RESHAPE, not a passthrough: `author` is not a key
 * of `Post`, so what is classified is the underlying `authorName` and the mapper
 * renames it.
 */
export const FIELD_DISPOSITION: Record<keyof Post, 'public' | 'private'> = {
  id: 'public',
  title: 'public',
  subtitle: 'public',
  slug: 'public',
  excerpt: 'public',
  coverImage: 'public',
  category: 'public',
  tags: 'public',
  template: 'public',
  publishedAt: 'public',
  updatedAt: 'public',
  wordCount: 'public',
  readingTime: 'public',
  authorName: 'public',
  content: 'public', // detail route only — see PUBLIC_LIST_OMITS
  authorId: 'private',
  deletedAt: 'private',
  revision: 'private',
  status: 'private',
  excerptSource: 'private',
  createdAt: 'private',
};

/**
 * `'public'` fields that the LIST shape still does not carry.
 *
 * `content` is public on the detail route and absent from the list for the
 * reason `ListPost` exists at all (ARCHITECTURE.md §6): a list response ships no
 * documents.
 */
export const PUBLIC_LIST_OMITS: readonly (keyof Post)[] = ['content'];

/**
 * ONE definition of the public URL for an image id, shared by the projection,
 * the docs and the client.
 *
 * The `asset:<id>` sources inside a stored document are NOT rewritten (plan D4);
 * the resolution rule is published instead, and this is it.
 */
export function publicImageUrl(id: string): string {
  return `/api/public/images/${id}`;
}

/**
 * `coverImage.blobId` is stored BOTH bare and `asset:`/`idb:`-prefixed —
 * historically it is either, which is why `server/repo/images.ts:539-547` reads
 * it both ways. Normalised before the URL is built, or a live published cover
 * resolves to `/api/public/images/asset:img_x` and 404s.
 */
export function normalizeBlobId(blobId: string): string {
  return blobId.replace(/^(?:asset|idb):/, '');
}

/**
 * jsonb arrives parsed from both drivers today; the string form is handled for
 * the same reason `mapping.ts` handles it — a divergence between PGlite and
 * `@neondatabase/serverless` is invisible until it is a production 500.
 */
function json<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

/** The cover, resolved to a public URL. Built field by field, like everything here. */
export function rowToPublicCoverImage(value: unknown): PublicCoverImage | null {
  const cover = json<CoverImage>(value);
  if (!cover || typeof cover !== 'object') return null;
  const id = typeof cover.blobId === 'string' ? normalizeBlobId(cover.blobId) : '';
  if (!id) return null;
  return {
    url: publicImageUrl(id),
    alt: typeof cover.alt === 'string' ? cover.alt : '',
    focalPoint: typeof cover.focalPoint === 'string' ? cover.focalPoint : '50% 50%',
    width: Number(cover.width) || 0,
    height: Number(cover.height) || 0,
  };
}

/**
 * A row → the list shape. FIELD BY FIELD, deliberately verbose.
 *
 * `slug` and `published_at` are asserted non-null by `PUBLIC_POST_PREDICATE`
 * rather than by this mapper — every caller of this function selects behind that
 * predicate, which is the only reason the types below can be non-nullable.
 */
export function rowToPublicPost(row: Record<string, unknown>, authorName: string): PublicPost {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    subtitle: String(row.subtitle),
    excerpt: String(row.excerpt),
    coverImage: rowToPublicCoverImage(row.cover_image),
    category: String(row.category),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    template: (row.template == null ? null : row.template) as ReadingTemplate | null,
    publishedAt: toEpochMs(row.published_at),
    updatedAt: toEpochMs(row.updated_at),
    wordCount: Number(row.word_count),
    readingTime: Number(row.reading_time),
    author: { name: authorName },
  };
}

/**
 * A row → the detail shape.
 *
 * Spelled out rather than `{ ...rowToPublicPost(row), content }` would be
 * safe here — but the list mapper is itself an allow-list, so composing them is
 * not a deny-list. `content` is the one addition and it is named.
 */
export function rowToPublicPostDetail(
  row: Record<string, unknown>,
  authorName: string,
): PublicPostDetail {
  const base = rowToPublicPost(row, authorName);
  return {
    id: base.id,
    slug: base.slug,
    title: base.title,
    subtitle: base.subtitle,
    excerpt: base.excerpt,
    coverImage: base.coverImage,
    category: base.category,
    tags: base.tags,
    template: base.template,
    publishedAt: base.publishedAt,
    updatedAt: base.updatedAt,
    wordCount: base.wordCount,
    readingTime: base.readingTime,
    author: base.author,
    content: json<DocNode>(row.content) ?? { type: 'doc', content: [] },
  };
}
