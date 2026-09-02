import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CoverImage,
  DocNode,
  PostStatus,
  ReadingTemplate,
  Revision,
} from '../../shared/types';

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
    /** The six-role model of `shared/roles.ts` (migration 0680). */
    role: text('role').$type<import('../../shared/roles').Role>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** Revoke without deleting authored posts. */
    disabledAt: bigint('disabled_at', { mode: 'number' }),
    /** Login demands an emailed code after the password (migration 0700).
     * DDL-default false so column-less inserts — the test seeds — stay
     * single-factor; the migration flips existing rows and `createUser`
     * names the column for real accounts. */
    twoFactorEmail: boolean('two_factor_email').notNull().default(false),
  },
  (t) => [
    check(
      'users_role_ck',
      sql`${t.role} IN ('owner', 'developer', 'writer', 'supply_chain', 'support', 'marketing')`,
    ),
  ],
);

/**
 * A password-verified login waiting on its emailed code (migration 0700).
 *
 * `ticket_hash`/`code_hash` are HMACs under SESSION_SECRET — `tokenId` in
 * `server/repo/users.ts`, the same treatment sessions and invites get — so a
 * database dump alone is inert. `attempts` is the CAS the verify route spends;
 * five wrong guesses consume the challenge. `resends` bounds the mail one
 * password-holder can aim at an inbox.
 */
export const authLoginChallenges = pgTable(
  'auth_login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ticketHash: text('ticket_hash').notNull().unique(),
    codeHash: text('code_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    resends: integer('resends').notNull().default(0),
    /** Non-null means spent — by success, or by the attempt ceiling. */
    consumedAt: bigint('consumed_at', { mode: 'number' }),
  },
  (t) => [
    check('auth_login_challenges_attempts_ck', sql`${t.attempts} >= 0`),
    check('auth_login_challenges_resends_ck', sql`${t.resends} >= 0`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /**
     * HMAC-SHA-256 of the token under `SESSION_SECRET`, hex — see `tokenId` in
     * `server/repo/users.ts`. The raw token is never stored, and the digest is
     * keyed so a stolen dump cannot be attacked offline (spec §3.2).
     */
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
    /** Role granted on acceptance. `owner` stays LEGAL here — history may
     * carry it — but no route mints it (shared/roles.ts, migration 0680). */
    role: text('role').$type<import('../../shared/roles').Role>().notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** Single use — non-null means spent. */
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
  },
  (t) => [
    check(
      'invites_role_ck',
      sql`${t.role} IN ('owner', 'developer', 'writer', 'supply_chain', 'support', 'marketing')`,
    ),
  ],
);

/**
 * A proposal to hand the store to somebody else (migration 0800).
 *
 * `shared/roles.ts` still says the owner is singular by construction, and it
 * still is: `PATCH /users/:id/role` refuses `owner` in both directions, and the
 * ONE route that may move it does so as a swap inside a single statement — the
 * recipient is promoted and the outgoing owner demoted to `developer` together,
 * so there is never an instant with two owners or none.
 *
 * A ROW IS A LIFETIME, not a flag: both timestamps NULL is pending,
 * `acceptedAt` is done, `cancelledAt` is withdrawn by the sender or declined by
 * the recipient. Expiry is the clock, exactly as it is for `invites`.
 */
export const ownershipTransfers = pgTable(
  'ownership_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The owner proposing it. Their role is what gets demoted on acceptance. */
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
    cancelledAt: bigint('cancelled_at', { mode: 'number' }),
  },
  (t) => [
    check('ownership_transfers_distinct_ck', sql`${t.fromUserId} <> ${t.toUserId}`),
    check(
      'ownership_transfers_outcome_ck',
      sql`${t.acceptedAt} IS NULL OR ${t.cancelledAt} IS NULL`,
    ),
    /*
     * AT MOST ONE PENDING TRANSFER FOR THE WHOLE INSTANCE. Two live proposals
     * are two people who each believe they are about to own the store, and
     * whichever accepts first silently voids the other. Declared here for
     * parity with the migration; the index in `0800` is what enforces it.
     */
    uniqueIndex('ownership_transfers_one_pending_uq')
      .on(sql`(true)`)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
    index('ownership_transfers_to_idx').on(t.toUserId),
    index('ownership_transfers_from_idx').on(t.fromUserId),
  ],
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
    /**
     * Layout override for this one post, NULL to follow the blog's default.
     *
     * Nullable rather than defaulted: "no opinion" and "deliberately Magazine"
     * are different states, and only the first should follow the default when
     * it changes. It is a real domain field — `PostPatch` carries it and
     * `createDraftShape` preserves it through an export/import round trip — so
     * a server that dropped it would silently lose a writer's choice.
     */
    template: text('template').$type<ReadingTemplate>(),
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
    /**
     * The LIFECYCLE CAS token. Monotonic per post, and moved by exactly one
     * thing: a change to `status`, `published_at` or `deleted_at`.
     *
     * `revision` cannot answer the question a lifecycle retry has to ask.
     * `revision` moves on every save, so pinning it would 409 a publish that
     * merely raced an autosave — and the publish genuinely wants to re-derive
     * its slug and excerpt from the newer text. But a predicate over the
     * CURRENT lifecycle state cannot tell "never left draft" from "was trashed
     * and restored back to draft", so a retry re-applied a trash somebody had
     * deliberately undone, and the next `emptyTrash` destroyed the post and
     * every revision with it (spec §4.2).
     *
     * A generation counter answers it: content edits leave it alone, so the
     * retry still wins and re-derives; any lifecycle change by anyone moves it,
     * so a retry pinned to the old value cannot win and the caller gets a 409.
     *
     * MAINTAINED BY A TRIGGER, NOT BY THE REPOSITORY. `posts_lifecycle_generation`
     * (hand-appended to migration 0003, because drizzle-kit cannot express a
     * trigger) bumps it in the database, so an import, a backfill or manual SQL
     * moves it exactly as `trashPost` does. A counter the application increments
     * would only be honest about writes that went through the application —
     * which is precisely the guarantee a CAS predicate must not depend on.
     */
    lifecycleGeneration: integer('lifecycle_generation').notNull().default(0),
    /**
     * On the curated rail the storefront's `/posts` page leads with.
     *
     * NOT ON `Post`, and that is a decision rather than an omission. Curation
     * is its own small aggregate — at most four rows — read through
     * `GET /api/featured` and written only by the feature/unfeature/reorder
     * statements in `server/repo/featured.ts`. Putting it on `Post` would put
     * it in the local Dexie mirror, the export bundle and every fixture, for a
     * field the editor reads once and never edits inline.
     *
     * `PublicPost` cannot leak it either way: the public projection is an
     * allow-list built field by field, so a column it does not name has nowhere
     * to appear.
     */
    featured: boolean('featured').notNull().default(false),
    /** 1..4, the display order. Meaningful only while `featured`. */
    featuredRank: integer('featured_rank'),
  },
  (t) => [
    check('posts_status_ck', sql`${t.status} IN ('draft', 'published', 'archived')`),
    check(
      'posts_excerpt_source_ck',
      sql`${t.excerptSource} IN ('derived', 'author')`,
    ),
    check('posts_revision_ck', sql`${t.revision} > 0`),
    check(
      'posts_template_ck',
      sql`${t.template} IS NULL OR ${t.template} IN ('magazine', 'minimal', 'editorial', 'technical')`,
    ),
    /**
     * Both halves, in one CHECK — see `0280_featured_posts.sql`. The second is
     * not decoration: an unfeature that cleared only the boolean would leave a
     * rank behind, holding a slot no post appears in.
     *
     * The `IS NOT NULL` is not implied by the `BETWEEN`. A CHECK admits a NULL
     * expression, so without it `featured = true, featured_rank = NULL` came
     * out as `false OR NULL` = NULL and was accepted.
     */
    check(
      'posts_featured_rank_ck',
      sql`(NOT ${t.featured} AND ${t.featuredRank} IS NULL)
       OR (${t.featured} AND ${t.featuredRank} IS NOT NULL
                        AND ${t.featuredRank} BETWEEN 1 AND 4)`,
    ),
    /*
     * `posts_featured_rank_uq` IS DELIBERATELY NOT MODELLED HERE.
     *
     * It is `UNIQUE (featured_rank) DEFERRABLE INITIALLY DEFERRED`, and Drizzle
     * has no way to spell the deferral — `unique()` here would emit an IMMEDIATE
     * constraint, which is precisely the one that refuses a rank swap and would
     * make invariant 4 need a transaction the neon-http driver throws on. A
     * model that quietly downgraded it would be worse than one that says so.
     * The real constraint is in the migration; `schema.test.ts` proves the
     * deferred behaviour against a live database.
     */
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
    /**
     * NULLABLE, and it has to be: a row is inserted when the SLOT is issued, and
     * at that moment the server has not seen a single byte of the image. There
     * is nothing honest to put here.
     *
     * Measured against PGlite before migration 0004: `NOT NULL` made
     * `createSlot` a hard `23502` on the very first insert, so the whole media
     * flow was unreachable. Filling them with 0 instead would be worse than the
     * failure — `readDimensions` returns `null` rather than a guess precisely so
     * that "unknown" survives to storage, and a stored 0 is a number every
     * consumer downstream believes. Written at commit, from the object's own
     * bytes, and left NULL when the format's header could not be read.
     */
    width: integer('width'),
    height: integer('height'),
    /**
     * The CLIENT-DECLARED size at slot time, CORRECTED from `headObject` at
     * commit.
     *
     * It is a claim until the bytes exist, and it is load-bearing as a claim:
     * it is signed into the presigned PUT as `content-length`, so R2 itself
     * refuses an upload of a different size. The correction at commit is what
     * makes the per-user storage quota count real bytes rather than declared
     * ones.
     */
    byteSize: integer('byte_size').notNull(),
    /** SHA-256, for content addressing later. */
    checksum: text('checksum'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** NULL = upload issued but never confirmed. Swept after 24h. */
    committedAt: bigint('committed_at', { mode: 'number' }),
    /**
     * THE QUARANTINE CLOCK (spec §5.4). NULL = the last orphan-collection mark
     * pass reached this image; non-NULL = the epoch-ms at which it FIRST went
     * unreferenced and has been unreferenced ever since.
     *
     * "Unreferenced at this instant" is not a property it is safe to delete
     * bytes on, and no age floor on `created_at` or `committed_at` can rescue
     * it: cutting a months-old image out of one post to paste it into another
     * leaves it referenced by nothing for the length of one autosave debounce,
     * and its creation age passed the floor long ago. The property that IS safe
     * is "unreferenced continuously for 24 hours", which needs a remembered
     * timestamp — hence a column rather than a cleverer predicate.
     *
     * The mark pass CLEARS it on every image the reference walk reaches, so a
     * re-referenced image starts its clock again from scratch rather than
     * carrying a stale one to the delete pass.
     */
    unreferencedSince: bigint('unreferenced_since', { mode: 'number' }),
  },
  (t) => [
    index('images_owner_idx').on(t.ownerId),
    index('images_committed_idx').on(t.committedAt),
    /** The delete pass's driving predicate. */
    index('images_unreferenced_idx').on(t.unreferencedSince),
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

/**
 * Password resets (studio auth).
 *
 * The same shape as `invites`, for the same reasons: only the HMAC of the token
 * is stored (`token_hash`, UNIQUE), the row carries its own expiry, and
 * "single use" is a nullable timestamp rather than a boolean so a spent row
 * still says WHEN it was spent.
 *
 * `ON DELETE cascade` on `user_id` — unlike `invites.invited_by`, which is
 * `no action`. An invite records history about the inviter; a reset row is a
 * live credential FOR the user it names, and a credential that outlives its
 * account is the one state this table must never be in.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** Single use — non-null means spent. */
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

export type DbPost = typeof posts.$inferSelect;
