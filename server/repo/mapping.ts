import { toEpochMs, toEpochMsOrNull } from '../db/client';
import type {
  CoverImage,
  DocNode,
  ListPost,
  Post,
  PostStatus,
  ReadingTemplate,
  Revision,
  RevisionMeta,
} from '../../shared/types';

/**
 * The ONLY place a database row becomes a domain object.
 *
 * It exists because `db.execute(sql`…`)` hands back raw driver rows —
 * snake_case keys (`content_text`, `author_id`, `word_count`), int8 as a
 * string, jsonb as whatever the driver decided — so a row is not a `Post` and
 * casting one to `Post` is a lie the type system will happily accept.
 */

/**
 * Every column needed to build a `Post`, enumerated (spec §3.4).
 *
 * NO `SELECT *` AND NO `RETURNING *` ANYWHERE. `posts` also holds
 * `content_text` and the generated `search` tsvector; a star would put both in
 * every list response — the second is an unbounded blob of lexemes and
 * positions, and neither is on `Post`. `authorName` is not here because it is
 * `users.display_name`, joined or supplied by the caller.
 */
export const POST_COLUMNS: string[] = [
  'id',
  'title',
  'subtitle',
  'slug',
  'excerpt',
  'excerpt_source',
  'content',
  'cover_image',
  'category',
  'tags',
  'template',
  'status',
  'created_at',
  'updated_at',
  'published_at',
  'deleted_at',
  'word_count',
  'reading_time',
  'author_id',
  'revision',
];

/**
 * A list response ships no documents — `ListPost` is `Omit<Post,'content'>` and
 * ARCHITECTURE.md §6 calls shipping every document to render a list out by
 * name.
 */
export const LIST_POST_COLUMNS: string[] = POST_COLUMNS.filter((c) => c !== 'content');

/** `POST_COLUMNS` qualified for a join, e.g. `p.id, p.title, …`. */
export function postColumns(alias: string, columns: string[] = POST_COLUMNS): string {
  return columns.map((c) => `${alias}.${c}`).join(', ');
}

/**
 * jsonb arrives parsed from both drivers today. Handling the string form as
 * well is the same insurance `toEpochMs` is: the int8 divergence between PGlite
 * and `@neondatabase/serverless` was invisible until it was a production 500,
 * and a document silently becoming the string `"[object Object]"` is worse.
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

export function rowToListPost(row: Record<string, unknown>, authorName: string): ListPost {
  return {
    id: String(row.id),
    title: String(row.title),
    subtitle: String(row.subtitle),
    // Nullable and UNIQUE — drafts hold NULL until titled or published.
    slug: row.slug == null ? null : String(row.slug),
    excerpt: String(row.excerpt),
    excerptSource: row.excerpt_source as 'derived' | 'author',
    coverImage: json<CoverImage>(row.cover_image),
    category: String(row.category),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    template: (row.template == null ? null : row.template) as ReadingTemplate | null,
    status: row.status as PostStatus,
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    publishedAt: toEpochMsOrNull(row.published_at),
    deletedAt: toEpochMsOrNull(row.deleted_at),
    wordCount: Number(row.word_count),
    readingTime: Number(row.reading_time),
    authorId: String(row.author_id),
    /**
     * Denormalised for display only. Never trust it for a permission decision —
     * `authorId` is the authority (shared/types.ts).
     */
    authorName,
    revision: Number(row.revision),
  };
}

export function rowToPost(row: Record<string, unknown>, authorName: string): Post {
  return {
    ...rowToListPost(row, authorName),
    content: json<DocNode>(row.content) ?? { type: 'doc', content: [] },
  };
}

// ------------------------------------------------------------------ revisions

/**
 * Every column a `RevisionMeta` needs, enumerated for the same reason
 * `POST_COLUMNS` is: `content` is the one column on this table that is
 * unbounded, and history is unbounded in rows as well, so a `SELECT *` behind a
 * list endpoint ships the entire document store to draw a sidebar.
 */
export const REVISION_META_COLUMNS: string[] = [
  'id',
  'post_id',
  'revision',
  'created_at',
  'author_id',
  'title',
  'subtitle',
  'word_count',
  'kind',
  'note',
];

/** The full snapshot — the only place `content` is read from this table. */
export const REVISION_COLUMNS: string[] = [...REVISION_META_COLUMNS, 'content'];

export function rowToRevisionMeta(row: Record<string, unknown>): RevisionMeta {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    // `not null` in the schema, so a server-written row always has one. Read
    // defensively anyway: this mapper is also what an imported or backfilled
    // row would come through.
    authorId: row.author_id == null ? undefined : String(row.author_id),
    title: String(row.title),
    subtitle: String(row.subtitle),
    wordCount: Number(row.word_count),
    kind: row.kind as Revision['kind'],
    note: row.note == null ? undefined : String(row.note),
  };
}

export function rowToRevision(row: Record<string, unknown>): Revision {
  return {
    ...rowToRevisionMeta(row),
    content: json<DocNode>(row.content) ?? { type: 'doc', content: [] },
  };
}
