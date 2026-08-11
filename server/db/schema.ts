import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CoverImage, DocNode, PostStatus, Revision } from '../../shared/types';

/**
 * Seven tables, mirroring spec §3.
 *
 * Two rules that hold everywhere here:
 *
 * - **Timestamps are `bigint` epoch-milliseconds, never `timestamptz`.** The
 *   entire frontend model uses `number` epoch-ms; converting at the boundary
 *   would create two representations of every date and a rounding seam.
 * - **Every enum-ish column carries a `check()`.** `.$type<>()` is compile-time
 *   only and buys nothing at runtime — without the check, a bug anywhere could
 *   persist `role = 'admin'`.
 *
 * The `search` tsvector on `posts` is NOT declared here. It is a
 * `GENERATED ALWAYS AS (...) STORED` column appended by hand to the generated
 * migration, because it needs an IMMUTABLE wrapper around `array_to_string`
 * that drizzle-kit cannot express.
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lowercased. */
    email: text('email').notNull().unique(),
    /** `scrypt$N$r$p$salt$hash`. Never a raw password, never logged. */
    passwordHash: text('password_hash').notNull(),
    /** Replaces the hardcoded `'You'`. */
    displayName: text('display_name').notNull(),
    role: text('role').$type<'owner' | 'writer'>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** Revoke without deleting authored posts. */
    disabledAt: bigint('disabled_at', { mode: 'number' }),
  },
  (t) => [check('users_role_ck', sql`${t.role} IN ('owner', 'writer')`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the token, hex. The raw token is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    /** So a user can recognise a session to revoke. */
    userAgent: text('user_agent'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Role granted on acceptance. */
    role: text('role').$type<'owner' | 'writer'>().notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** Single use — non-null means spent. */
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
  },
  (t) => [check('invites_role_ck', sql`${t.role} IN ('owner', 'writer')`)],
);

export const posts = pgTable(
  'posts',
  {
    /** Client-generated `p_…`, stable and never reused. Import preserves it. */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    subtitle: text('subtitle').notNull(),
    /**
     * Nullable, and UNIQUE. A UNIQUE column cannot hold twenty empty strings,
     * but Postgres permits many NULLs — so drafts hold NULL until titled or
     * published, at which point the server assigns one.
     */
    slug: text('slug').unique(),
    excerpt: text('excerpt').notNull(),
    excerptSource: text('excerpt_source').$type<'derived' | 'author'>().notNull(),
    content: jsonb('content').$type<DocNode>().notNull(),
    /**
     * `docToText(content)`, derived on write. A server-side storage detail:
     * it is never on `Post` and never rides along into a response.
     */
    contentText: text('content_text').notNull(),
    coverImage: jsonb('cover_image').$type<CoverImage | null>(),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').$type<PostStatus>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    publishedAt: bigint('published_at', { mode: 'number' }),
    /** Non-null == in trash, regardless of status. */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    wordCount: integer('word_count').notNull(),
    readingTime: integer('reading_time').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** The CAS token. Monotonic per post. */
    revision: integer('revision').notNull(),
  },
  (t) => [
    check('posts_status_ck', sql`${t.status} IN ('draft', 'published', 'archived')`),
    check(
      'posts_excerpt_source_ck',
      sql`${t.excerptSource} IN ('derived', 'author')`,
    ),
    check('posts_revision_ck', sql`${t.revision} > 0`),
    index('posts_status_updated_idx').on(t.status, t.updatedAt.desc()),
    index('posts_deleted_idx').on(t.deletedAt),
    index('posts_author_idx').on(t.authorId),
    index('posts_category_idx').on(t.category),
  ],
);

export const revisions = pgTable(
  'revisions',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** Who made this revision. */
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    subtitle: text('subtitle').notNull(),
    content: jsonb('content').$type<DocNode>().notNull(),
    wordCount: integer('word_count').notNull(),
    kind: text('kind').$type<Revision['kind']>().notNull(),
    /** Human-readable summary, used by 'status' entries. */
    note: text('note'),
  },
  (t) => [
    /**
     * Dexie's `[postId+revision]` compound index is non-unique, so this is a
     * free integrity upgrade from moving to a real database: two different
     * revision-15s become an error rather than silent corruption. It is also
     * the production backstop for the CAS write path under true parallelism.
     */
    uniqueIndex('revisions_post_revision_uq').on(t.postId, t.revision),
    check('revisions_revision_ck', sql`${t.revision} > 0`),
    check(
      'revisions_kind_ck',
      sql`${t.kind} IN ('autosave', 'manual', 'publish', 'status')`,
    ),
  ],
);

export const images = pgTable(
  'images',
  {
    /** Keeps the frontend's `img_` prefix convention. */
    id: text('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    /** `images/<owner>/<id>`. */
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** SHA-256, for content addressing later. */
    checksum: text('checksum'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** NULL = upload issued but never confirmed. Swept after 24h. */
    committedAt: bigint('committed_at', { mode: 'number' }),
  },
  (t) => [
    index('images_owner_idx').on(t.ownerId),
    index('images_committed_idx').on(t.committedAt),
  ],
);

/**
 * Rate limiting lives in Postgres, not module memory (spec §6). Serverless
 * instances do not share memory, so an in-process counter bounds one warm
 * instance and nothing else — it stops a serial script and stops nothing that
 * adds concurrency, survives a cold start, or survives a deploy.
 */
export const authAttempts = pgTable('auth_attempts', {
  /** 'login:ip|email' or 'login:ip'. */
  key: text('key').primaryKey(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  count: integer('count').notNull(),
});

export type DbPost = typeof posts.$inferSelect;
