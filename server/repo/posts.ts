import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DbError, uniqueViolation } from '../db/client';
import { derive, nextExcerpt } from '../domain/derive';
import { SLUG_ATTEMPTS, uniqueSlug } from '../domain/slug';
import { POST_COLUMNS, postColumns, rowToPost } from './mapping';
import {
  InvalidDocumentError,
  NotFoundError,
  PreconditionFailedError,
  StaleWriteError,
} from './errors';
import { deriveExcerpt, slugify } from '../../shared/doc';
import { checkPostMeta, validateDoc } from '../../shared/validate';
import type {
  AuthUser,
  CoverImage,
  DocNode,
  Post,
  PostPatch,
  ReadingTemplate,
  Revision,
} from '../../shared/types';

/**
 * The write path (spec §4).
 *
 * ONE STATEMENT PER MUTATION, AND NEVER `db.transaction`. The Neon HTTP driver
 * throws unconditionally on `transaction()` while PGlite supports it, so a
 * transaction here would pass every test and 500 in production — the exact
 * divergence spec §9 exists to eliminate. Atomicity comes from the statement
 * instead: the revision insert SELECTs FROM the update, so a CAS that matches
 * nothing structurally inserts nothing.
 */

/** Same shape as the client's `newId`, so ids are indistinguishable by origin. */
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * `''` is not a slug.
 *
 * `createDraftShape({ slug: '' })` still yields `''` — `'' ?? null` is `''`, not
 * null — so the client's empty-string convention arrives here intact. `slug` is
 * UNIQUE and Postgres permits many NULLs but exactly one `''`, so the SECOND
 * untitled draft is the one that would fail, with a raw 23505 nobody expects.
 * Normalised at the write boundary rather than trusting any caller.
 */
function normaliseSlug(slug: string | null | undefined): string | null {
  return slug ? slug : null;
}

const jsonbOrNull = (value: unknown) =>
  value == null ? sql`NULL::jsonb` : sql`${JSON.stringify(value)}::jsonb`;

// --------------------------------------------------------------------- reads

export async function getPost(db: Db, id: string): Promise<Post | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p'))}, u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = ${id}`);
  const row = res.rows[0];
  return row ? rowToPost(row, String(row.author_name)) : null;
}

/**
 * The same read, plus the lifecycle generation.
 *
 * `lifecycleGeneration` is deliberately NOT a field on `Post`. It is a
 * concurrency token for one code path, like `content_text` is a storage detail
 * for one column — putting it on the shared domain type would ship it to the
 * client, invite a caller to compare it, and make a server-side schema decision
 * part of the frontend's compile surface for no benefit.
 */
interface LifecycleRead {
  post: Post;
  generation: number;
}

async function readLifecycle(db: Db, id: string): Promise<LifecycleRead | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p'))}, p.lifecycle_generation,
           u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.id = ${id}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    post: rowToPost(row, String(row.author_name)),
    generation: Number(row.lifecycle_generation),
  };
}

// -------------------------------------------------------------------- create

/**
 * A new post and its first revision, in one statement.
 *
 * `partial` is `Partial<Post>` rather than `PostPatch` because import and
 * duplicate legitimately carry system fields — but `authorId`, `authorName` and
 * `revision` are still taken from the session and from here, never from the
 * caller.
 */
export async function createPost(
  db: Db,
  author: AuthUser,
  partial: Partial<Post> = {},
): Promise<Post> {
  const now = Date.now();
  const id = partial.id ?? newId('p_');

  const content = validated(partial.content) ?? { type: 'doc', content: [] };
  const derived = derive(content);
  checkMeta(partial);

  /*
   * A SUPPLIED SLUG IS NORMALISED IN SHAPE, NOT ONLY IN UNIQUENESS.
   *
   * `slug` becomes a URL path segment, and this function is what `duplicatePost`
   * and `POST /import` go through — both of which carry a slug from outside.
   * Sending it through the uniqueness walk alone stored `../../admin` verbatim,
   * which is not what "slugs are server-authoritative" (spec §4.5) means.
   * `slugify` is the same function the title path uses, so a slug that arrives
   * is held to the same charset as one that is derived.
   */
  const supplied = normaliseSlug(partial.slug);
  const base = supplied === null ? null : slugify(supplied);
  const excerpt = partial.excerpt ?? '';
  const excerptSource = partial.excerptSource ?? (excerpt ? 'author' : 'derived');
  const revId = newId('r_');

  const row = await withSlugRetry(async (attempt) => {
    // A supplied slug goes through the uniqueness walk rather than being
    // trusted: spec §4.5 makes slugs server-authoritative, and an import
    // carrying a taken slug must not become a raw unique_violation 500.
    // Inside the retry, so a candidate lost to a concurrent insert is replaced
    // rather than surfaced.
    const slug = base ? await uniqueSlug(db, base, id, attempt) : null;
    const res = await db.execute(sql`
    WITH ins AS (
      INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                         content_text, cover_image, category, tags, template, status,
                         created_at, updated_at, published_at, deleted_at,
                         word_count, reading_time, author_id, revision)
      VALUES (${id}, ${partial.title ?? ''}, ${partial.subtitle ?? ''}, ${slug},
              ${excerpt}, ${excerptSource}, ${JSON.stringify(content)}::jsonb,
              ${derived.contentText}, ${jsonbOrNull(partial.coverImage)},
              ${partial.category ?? ''}, ${sql.param(partial.tags ?? [])},
              ${partial.template ?? null}, ${partial.status ?? 'draft'},
              ${partial.createdAt ?? now}, ${partial.updatedAt ?? now},
              ${partial.publishedAt ?? null}, ${partial.deletedAt ?? null},
              ${derived.wordCount}, ${derived.readingTime}, ${author.id}, 1)
      RETURNING ${sql.raw(POST_COLUMNS.join(', '))}
    ), rev AS (
      INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                             title, subtitle, content, word_count, kind, note)
      SELECT ${revId}, ins.id, ins.revision, ${now}, ${author.id},
             ins.title, ins.subtitle, ins.content, ins.word_count, 'manual', NULL
        FROM ins
      RETURNING 1
    )
    SELECT ${sql.raw(POST_COLUMNS.join(', '))} FROM ins`);
    return res.rows[0];
  }).catch((err: unknown) => {
    if (isProgramLimitExceeded(err)) throw tooLargeForSearchIndex();
    throw err;
  });

  return rowToPost(row, author.displayName);
}

// ---------------------------------------------------------------------- save

export interface SavePostOptions {
  actor: AuthUser;
  kind?: Revision['kind'];
  /** When set, refuse the write if the stored post has moved on. */
  baseRevision?: number;
  /**
   * Human-readable summary for the revision this save writes.
   *
   * Here rather than in a second CAS statement so `restoreRevision` can say
   * which revision it restored while still going through the one write path —
   * a parallel statement would be a second place for the CAS to be got wrong.
   */
  note?: string;
}

/**
 * The single mutation path for content and metadata.
 *
 * Order of operations mirrors `src/data/posts.ts:101-153`:
 *
 * 1. Read current. Absent → `NotFoundError`.
 * 2. `baseRevision` present and ≠ stored → `StaleWriteError` immediately. This
 *    is only the cheap path; the CAS is what is authoritative.
 * 3. Merge — by naming each patchable field, so a system field cannot be
 *    smuggled in at all rather than being spread in and then overwritten.
 * 4. If `patch.content` is present, validate IT. Never the merged document.
 * 5. Derive, normalise the slug, assign one if titled and unslugged.
 * 6. CAS on `baseRevision ?? current.revision`.
 */
export async function savePost(
  db: Db,
  id: string,
  patch: PostPatch,
  opts: SavePostOptions,
): Promise<Post> {
  const current = await getPost(db, id);
  if (!current) throw new NotFoundError(id);

  const base = opts.baseRevision ?? current.revision;
  if (opts.baseRevision != null && opts.baseRevision !== current.revision) {
    throw new StaleWriteError(opts.baseRevision, current.revision, current);
  }

  /*
   * ONLY `patch.content` IS VALIDATED, NEVER THE MERGE.
   *
   * TipTap always supplies the document whole, so validating the patch IS
   * validating what gets stored. Validating the merge instead would mean a
   * single pre-existing violation — an import, or a later tightening of these
   * rules — makes that post permanently unsavable, and every word written into
   * it from then on is lost. Spec §4.6.
   */
  const content = patch.content !== undefined ? validatedOrThrow(patch.content) : current.content;

  /*
   * And for the same reason, only the PATCH's metadata. `title`, `subtitle`,
   * `excerpt`, `category` and `tags` are the other five inputs to the generated
   * `search` tsvector that `MAX_CONTENT_TEXT_BYTES` bounds; unbounded, a 1.2 MB
   * title is SQLSTATE 54000 on this statement, which spec §8 has no row for and
   * the client's policy would retry forever.
   */
  checkMeta(patch);

  const next = {
    title: patch.title ?? current.title,
    subtitle: patch.subtitle ?? current.subtitle,
    content,
    coverImage: (patch.coverImage !== undefined
      ? patch.coverImage
      : current.coverImage) as CoverImage | null,
    category: patch.category ?? current.category,
    tags: patch.tags ?? current.tags,
    template: (patch.template !== undefined
      ? patch.template
      : current.template) as ReadingTemplate | null,
  };

  const derived = derive(content);
  const excerpt = nextExcerpt({
    patchExcerpt: patch.excerpt,
    currentExcerpt: current.excerpt,
    currentSource: current.excerptSource,
    content,
  });

  const now = Date.now();
  const revId = newId('r_');
  const kind = opts.kind ?? 'autosave';

  const row = await withSlugRetry(async (attempt) => {
    /*
     * Slugs are derived, never supplied — `PostPatch` has no `slug` key.
     * Assigned on the first save that has a title, and never rewritten
     * afterwards: a published URL is a promise, not a value that follows the
     * heading around.
     *
     * Inside the retry, and carrying the attempt index. `uniqueSlug` reads, then
     * this statement writes, and between the two another writer can take the
     * candidate — the loop is an optimisation and the UNIQUE index is the
     * authority (spec §4.5). The index is what makes the next candidate
     * DIFFERENT rather than the same one every racer just lost.
     */
    let slug = normaliseSlug(current.slug);
    if (!slug && next.title) slug = await uniqueSlug(db, slugify(next.title), id, attempt);

    const res = await db.execute(sql`
    WITH upd AS (
      UPDATE posts
         SET title = ${next.title}, subtitle = ${next.subtitle},
             content = ${JSON.stringify(content)}::jsonb,
             content_text = ${derived.contentText},
             slug = ${slug},
             excerpt = ${excerpt.excerpt}, excerpt_source = ${excerpt.excerptSource},
             category = ${next.category}, tags = ${sql.param(next.tags)},
             cover_image = ${jsonbOrNull(next.coverImage)},
             template = ${next.template},
             word_count = ${derived.wordCount}, reading_time = ${derived.readingTime},
             revision = revision + 1, updated_at = ${now}
       WHERE id = ${id} AND revision = ${base}
      RETURNING ${sql.raw(POST_COLUMNS.join(', '))}
    ), rev AS (
      INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                             title, subtitle, content, word_count, kind, note)
      SELECT ${revId}, upd.id, upd.revision, ${now}, ${opts.actor.id},
             upd.title, upd.subtitle, upd.content, upd.word_count, ${kind},
             ${opts.note ?? null}
        FROM upd
      RETURNING 1
    )
    SELECT ${sql.raw(POST_COLUMNS.join(', '))} FROM upd`);
    return res.rows;
  }).catch(async (err: unknown) => {
    if (isProgramLimitExceeded(err)) throw tooLargeForSearchIndex();
    // The `UNIQUE (post_id, revision)` backstop. Reached only under real
    // parallelism, where the row-level CAS above cannot be trusted to have
    // decided first — and it means precisely what the CAS losing means.
    if (isRevisionCollision(err)) {
      const actual = await getPost(db, id);
      if (!actual) throw new NotFoundError(id);
      throw new StaleWriteError(base, actual.revision, actual);
    }
    throw err;
  });

  /*
   * `rows.length`, never `affectedRows` — measured to be 0 even on a winning
   * CAS. Zero rows means the CAS lost and NOTHING happened: no bumped revision,
   * and no revision row, because `INSERT … SELECT FROM upd` had no rows to
   * insert.
   */
  if (row.length === 0) {
    const actual = await getPost(db, id);
    if (!actual) throw new NotFoundError(id);
    throw new StaleWriteError(base, actual.revision, actual);
  }

  /*
   * `authorName` is the POST's author, not the actor: a second writer editing
   * someone else's draft must not rename its byline. `authorId` is never in the
   * SET list, so the stored value is `current.authorId` and `current.authorName`
   * is the display name that goes with it.
   */
  return rowToPost(row[0], current.authorName);
}

// ----------------------------------------------------------------- lifecycle

/**
 * Publish, unpublish, archive, unarchive, trash, restore (spec §4.2).
 *
 * TASK 6'S STATEMENT CANNOT SERVE THESE. Its `SET` list deliberately omits
 * `status`, `published_at` and `deleted_at` — that is what stops a `PATCH` body
 * smuggling a status change past the lifecycle rules — so each transition needs
 * its own statement, differing only in what it assigns and what it demands.
 *
 * The three halves of the contract:
 *
 * - **No client base revision, so a bounded internal retry.** There is no human
 *   decision to surface here; the derivation simply needs a fresh row. Three
 *   attempts, then 409.
 * - **The retry re-bases on the row it just read, and PINS THE LIFECYCLE
 *   GENERATION it first read.** Retry answers "the row moved under me". It must
 *   never answer "someone did the opposite thing on purpose": an `unpublish`
 *   that lost a race and blindly retried would flip a post someone deliberately
 *   archived back to draft, and a `trash` that blindly retried would overwrite
 *   the trash timestamp of whoever actually put it there — the clock a
 *   retention sweep reads before destroying the post and its whole history.
 *
 *   The precondition alone could not carry that, and this is the defect the
 *   generation column exists for. `trash`'s precondition is `deleted_at IS
 *   NULL`; a concurrent trash-then-restore returns the row to `deleted_at IS
 *   NULL`, so the precondition accepted it, the retry fired, and the post went
 *   back into the bin somebody had just taken it out of. `emptyTrash` then
 *   destroyed it and CASCADEd away every revision. `posts.lifecycle_generation`
 *   moves on any change to `status`, `published_at` or `deleted_at` and on
 *   nothing else, so A→B→A is visible where the state is not — and a concurrent
 *   CONTENT edit still leaves the retry free to win and re-derive.
 * - **The CAS predicate is the ONLY authority.** No JS check short-circuits it,
 *   and that is deliberate: a precondition judged in TypeScript is judged
 *   against a row that has already been read, i.e. against exactly the stale
 *   value the CAS exists to distrust. `holds()` is used only to CLASSIFY a
 *   predicate that has already matched nothing, on a row read after the fact.
 */
export const LIFECYCLE_ATTEMPTS = 3;

interface Transition {
  /** For the refusal message — `publish`, `trash`, … */
  name: string;
  /**
   * The precondition. Used only to explain a CAS that matched nothing, never to
   * decide whether the write may proceed — see `guard`.
   */
  holds(post: Post): boolean;
  /** The same precondition, in the CAS predicate — this is the authoritative one. */
  guard: SQL;
  kind: Revision['kind'];
  note: string | null;
  /** What the transition assigns, beyond `revision` and `updated_at`. */
  set(post: Post, now: number, slug: string | null): SQL;
  /** Publish is the only transition that can assign a slug. */
  slugs?: boolean;
}

async function transition(
  db: Db,
  id: string,
  actor: AuthUser,
  t: Transition,
): Promise<Post> {
  let read = await readLifecycle(db, id);
  if (!read) throw new NotFoundError(id);

  /*
   * READ ONCE, ON THE FIRST ATTEMPT, AND PINNED FOR THE REST.
   *
   * Re-reading it per attempt would defeat the whole point: the retry would
   * adopt whatever generation the concurrent lifecycle op left behind and win
   * against it, which is the original defect with an extra column.
   */
  const pinned = read.generation;
  const derivedFrom = read.post.revision;

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const current = read.post;
    // Re-based every attempt, unlike the generation: a concurrent AUTOSAVE must
    // not 409 a publish, it must be re-derived from.
    const base = current.revision;

    const now = Date.now();
    const revId = newId('r_');

    const row = await withSlugRetry(async (attempt) => {
      /*
       * A published post needs an address. `slugify('')` is already
       * `'untitled'`, so the `|| 'untitled'` only makes the intent visible.
       * Inside the slug retry and carrying the attempt index, for the same
       * reason `savePost` is: `uniqueSlug` reads and then this statement
       * writes, and the UNIQUE index — not the read — is the authority.
       */
      const slug =
        t.slugs && !current.slug
          ? await uniqueSlug(db, slugify(current.title || 'untitled'), id, attempt)
          : current.slug;

      const res = await db.execute(sql`
        WITH upd AS (
          UPDATE posts
             SET ${t.set(current, now, slug)},
                 revision = revision + 1, updated_at = ${now}
           WHERE id = ${id} AND revision = ${base}
             AND lifecycle_generation = ${pinned}
             AND ${t.guard}
          RETURNING ${sql.raw(POST_COLUMNS.join(', '))}
        ), rev AS (
          INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                                 title, subtitle, content, word_count, kind, note)
          SELECT ${revId}, upd.id, upd.revision, ${now}, ${actor.id},
                 upd.title, upd.subtitle, upd.content, upd.word_count,
                 ${t.kind}, ${t.note}
            FROM upd
          RETURNING 1
        )
        SELECT ${sql.raw(POST_COLUMNS.join(', '))} FROM upd`);
      return res.rows[0];
    }).catch((err: unknown) => {
      if (isProgramLimitExceeded(err)) throw tooLargeForSearchIndex();
      /*
       * The `UNIQUE (post_id, revision)` backstop. Under real parallelism two
       * writers can reach the same revision number even though the row-level
       * CAS decided one of them lost — which means exactly what a lost CAS
       * means, so it re-enters the loop rather than escaping as a 500.
       */
      if (isRevisionCollision(err)) return undefined;
      throw err;
    });

    // `rows[0]`, never `affectedRows` — measured to be 0 even on a winning CAS.
    // Undefined means the CAS matched nothing, so nothing at all was written:
    // `INSERT … SELECT FROM upd` had no rows to insert.
    if (row) return rowToPost(row, current.authorName);

    /*
     * The predicate matched nothing. Read the row back to find out which half
     * of it said no — and note that this read is the ONLY thing `holds()` is
     * ever consulted about.
     *
     * Generation unchanged means no lifecycle op has happened since the first
     * read at all, so a false precondition NOW was already false THEN: the
     * request is refused, not lost, and retrying it two more times would only
     * cost two more statements to reach the same answer. Anything else — a
     * moved revision, a moved generation — is a genuine race, so it re-bases
     * and tries again.
     */
    const after = await readLifecycle(db, id);
    if (!after) throw new NotFoundError(id);
    if (after.generation === pinned && !t.holds(after.post)) {
      throw new PreconditionFailedError(t.name, after.post);
    }
    read = after;
  }

  /*
   * Three attempts, three lost races. Bounded on purpose — an unbounded retry
   * against a row that never settles is a hung request, not a resilient one.
   *
   * `expected` is the revision the FIRST read derived from, not the last one
   * tried: that is the version the caller's request was actually about, and it
   * is what makes `expected !== actual` true here and only here.
   */
  throw new StaleWriteError(derivedFrom, read.post.revision, read.post);
}

/**
 * The excerpt rule at publish time, from `src/data/posts.ts:283-286`.
 *
 * Deliberately not `nextExcerpt`: publishing re-derives when the source is
 * 'author' but the text is empty, which `nextExcerpt` would leave blank. A
 * published card advertising nothing is worse than one advertising the opening
 * line. `excerpt_source` itself is not in the SET list — publishing is not the
 * gesture that changes who owns the excerpt.
 */
function publishExcerpt(post: Post): string {
  return post.excerptSource === 'author' && post.excerpt
    ? post.excerpt
    : deriveExcerpt(post.content);
}

/**
 * PUBLISH ALSO UNTRASHES, ON PURPOSE.
 *
 * `deleted_at = NULL` is in the SET list while the guard is only
 * `status <> 'published'`, so publishing a post that is in the trash takes it
 * out of the trash — without RESTORE's precondition ever being consulted. That
 * matches `src/data/posts.ts`, and it is the behaviour a writer expects:
 * "publish this" cannot sensibly mean "publish it and leave it in the bin,
 * where the next `emptyTrash` destroys it". It is spelled out in spec §4.2's
 * table rather than left as an undocumented side effect of the SET list.
 */
const PUBLISH: Transition = {
  name: 'publish',
  holds: (p) => p.status !== 'published',
  guard: sql`status <> 'published'`,
  kind: 'publish',
  note: null,
  slugs: true,
  set: (p, now, slug) => sql`
    status = 'published',
    published_at = ${p.publishedAt ?? now},
    deleted_at = NULL,
    slug = ${slug},
    excerpt = ${publishExcerpt(p)}`,
};

const UNPUBLISH: Transition = {
  name: 'unpublish',
  holds: (p) => p.status === 'published',
  guard: sql`status = 'published'`,
  kind: 'status',
  note: 'Moved back to drafts',
  set: () => sql`status = 'draft'`,
};

const ARCHIVE: Transition = {
  name: 'archive',
  holds: (p) => p.status !== 'archived',
  guard: sql`status <> 'archived'`,
  kind: 'status',
  note: 'Archived',
  set: () => sql`status = 'archived'`,
};

const UNARCHIVE: Transition = {
  name: 'unarchive',
  holds: (p) => p.status === 'archived',
  guard: sql`status = 'archived'`,
  kind: 'status',
  note: 'Restored from archive',
  set: () => sql`status = 'draft'`,
};

/** Soft delete. The row and every revision stay intact. */
const TRASH: Transition = {
  name: 'trash',
  holds: (p) => p.deletedAt == null,
  guard: sql`deleted_at IS NULL`,
  kind: 'status',
  note: 'Moved to trash',
  set: (_p, now) => sql`deleted_at = ${now}`,
};

const RESTORE: Transition = {
  name: 'restore',
  holds: (p) => p.deletedAt != null,
  guard: sql`deleted_at IS NOT NULL`,
  kind: 'status',
  note: 'Restored from trash',
  set: () => sql`deleted_at = NULL`,
};

export const publishPost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, PUBLISH);
export const unpublishPost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, UNPUBLISH);
export const archivePost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, ARCHIVE);
export const unarchivePost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, UNARCHIVE);
export const trashPost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, TRASH);
export const restorePost = (db: Db, id: string, actor: AuthUser): Promise<Post> =>
  transition(db, id, actor, RESTORE);

/**
 * A copy, authored by whoever asked for it.
 *
 * Everything system-owned is reset rather than copied: a duplicate is a new
 * draft, not a second published post at the same address. `slug: null` because
 * two posts cannot hold one slug and the copy has not earned an address yet —
 * the first save with a title, or the first publish, assigns one.
 */
export async function duplicatePost(
  db: Db,
  id: string,
  actor: AuthUser,
): Promise<Post> {
  const src = await getPost(db, id);
  if (!src) throw new NotFoundError(id);
  const now = Date.now();
  return createPost(db, actor, {
    ...src,
    id: undefined,
    title: src.title ? `${src.title} (copy)` : '',
    slug: null,
    status: 'draft',
    publishedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });
}

// ------------------------------------------------------------------- deletes

/*
 * THE THREE MULTI-ROW MUTATIONS, AND WHY NONE OF THEM IS A TRANSACTION.
 *
 * `db.transaction` throws unconditionally on the neon-http driver
 * (`node_modules/drizzle-orm/neon-http/session.js`) while PGlite supports it —
 * so a transaction here would pass every test in this repository and 500 on
 * every production call. Spec §4.3a exists to stop exactly that, and the
 * `ON DELETE CASCADE` already on `revisions.post_id` makes the separate
 * revisions delete unnecessary anyway.
 */

/**
 * The only destructive operation in the app, and it is idempotent: destroying an
 * already-destroyed post is not an error, because the caller cannot tell the two
 * apart and spec §8 answers both with `gone`.
 */
export async function destroyPost(db: Db, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM posts WHERE id = ${id}`);
}

/** All-or-nothing by construction: one statement either runs or it does not. */
export async function emptyTrash(db: Db): Promise<number> {
  const res = await db.execute(sql`
    WITH gone AS (DELETE FROM posts WHERE deleted_at IS NOT NULL RETURNING id)
    SELECT count(*)::int AS n FROM gone`);
  return Number(res.rows[0].n);
}

/**
 * The age guard from `src/data/posts.ts:401`. A draft someone is staring at in
 * another tab is never pulled out from under them.
 */
const BLANK_DRAFT_GRACE_MS = 60_000;

/**
 * Sweep drafts left behind by an exit route the editor cannot see — browser
 * Back, a closed tab, a crash.
 *
 * `word_count = 0` IS NOT EMPTINESS, and this is the frontend gauntlet's
 * sharpest finding: an image-only or divider-only draft has no words at all, and
 * treating that as blank destroyed the draft *and* its image bytes the moment
 * the writer clicked away — no confirmation, no grace period, no undo. So the
 * recursive term below walks the document exactly as `isBlankDoc` does and an
 * unrecognised node counts as content, which is the safe direction to fail.
 *
 * Three things the SQL is careful about, each mirroring the JS predicate:
 *
 * - it descends through `content` arrays ONLY, never into `attrs` or `marks`,
 *   so a paragraph carrying `attrs: { type: 'image' }` is still blank;
 * - a node with no `type` at all counts as content (`coalesce(…,'')` is in no
 *   allow-list), which is what makes a corrupt or foreign document survive;
 * - `text` counts only when it really is a JSON string, matching
 *   `typeof n.text === 'string'`.
 *
 * One statement, so a draft cannot be half-swept, and `WITH RECURSIVE` is legal
 * around a data-modifying CTE as long as that CTE is not itself the recursive
 * term.
 */
export async function sweepBlankDrafts(db: Db, exceptId?: string): Promise<number> {
  const cutoff = Date.now() - BLANK_DRAFT_GRACE_MS;
  const res = await db.execute(sql`
    WITH RECURSIVE candidates AS (
      SELECT id, content
        FROM posts
       WHERE status = 'draft'
         AND deleted_at IS NULL
         AND btrim(title) = ''
         AND btrim(subtitle) = ''
         AND word_count = 0
         AND cover_image IS NULL
         AND coalesce(array_length(tags, 1), 0) = 0
         AND category = ''
         AND updated_at < ${cutoff}
         AND id IS DISTINCT FROM ${exceptId ?? null}::text
    ), nodes AS (
      SELECT id AS post_id, content AS node FROM candidates
      UNION ALL
      SELECT n.post_id, child
        FROM nodes n
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(n.node -> 'content') = 'array'
               THEN n.node -> 'content'
               ELSE '[]'::jsonb
          END) AS child
    ), occupied AS (
      SELECT DISTINCT post_id
        FROM nodes
       WHERE coalesce(node ->> 'type', '') NOT IN ('doc', 'paragraph', 'text')
          OR (jsonb_typeof(node -> 'text') = 'string' AND btrim(node ->> 'text') <> '')
    ), gone AS (
      DELETE FROM posts
       WHERE id IN (SELECT id FROM candidates)
         AND id NOT IN (SELECT post_id FROM occupied)
      RETURNING id
    )
    SELECT count(*)::int AS n FROM gone`);
  return Number(res.rows[0].n);
}

// ------------------------------------------------------------------- helpers

function validated(content: unknown): DocNode | null {
  if (content === undefined) return null;
  return validatedOrThrow(content);
}

function validatedOrThrow(content: unknown): DocNode {
  const result = validateDoc(content);
  if (!result.ok) throw new InvalidDocumentError(result.violation);
  return result.doc;
}

/**
 * The metadata half of the document ceiling, as a 422 rather than as a 500.
 *
 * `InvalidDocumentError` and not a new error type: spec §8's row is
 * `422 { error: 'invalid_document', path }`, and `path` is already a field name
 * for whole-document limits (`content`). A caller that refuses a 1.2 MB title
 * needs to know which field, which is exactly what it carries.
 */
function checkMeta(meta: {
  title?: unknown;
  subtitle?: unknown;
  excerpt?: unknown;
  category?: unknown;
  tags?: unknown;
}): void {
  const violation = checkPostMeta(meta);
  if (violation) throw new InvalidDocumentError(violation);
}

function isSlugCollision(err: unknown): boolean {
  return uniqueViolation(err) === 'posts_slug_unique';
}

/**
 * `UNIQUE (post_id, revision)` — spec §3.5's integrity upgrade over Dexie's
 * non-unique compound index.
 *
 * Unreachable through the CAS as written: the revision row is inserted by
 * `SELECT … FROM upd`, so a losing CAS inserts nothing at all. It is the
 * BACKSTOP, the thing that holds under real parallelism where PGlite's single
 * connection proves nothing (spec §9) — and a backstop that surfaces as a
 * generic rethrow is a 500 for the one condition the client already knows how
 * to handle. Two writers reaching the same revision number IS a lost CAS,
 * whichever layer notices it, so it maps onto the same 409.
 */
function isRevisionCollision(err: unknown): boolean {
  return uniqueViolation(err) === 'revisions_post_revision_uq';
}

/**
 * SQLSTATE 54000 `program_limit_exceeded` — the tsvector ceiling, reached.
 *
 * `shared/validate.ts` bounds every input to the generated `search` column so
 * this is unreachable through the API, but a row written by an import, a
 * backfill or manual SQL can still trip it on its next UPDATE. Spec §8 has no
 * row for 54000, so untranslated it is a 500 — and a 500 is retried by the
 * client's policy, forever, for a write that can never succeed. Mapped to the
 * 422 instead: permanent, and it names the reason.
 */
function isProgramLimitExceeded(err: unknown): boolean {
  return err instanceof DbError && err.code === '54000';
}

function tooLargeForSearchIndex(): InvalidDocumentError {
  return new InvalidDocumentError({ path: 'content', reason: 'too_large' });
}

/**
 * Spec §4.5: "A `unique_violation` from a concurrent insert is caught and
 * retried rather than surfaced — the uniqueness index is the authority, the
 * loop is only an optimisation."
 *
 * `uniqueSlug` reads the taken set, then the write happens; between the two,
 * another writer can take the candidate. Retrying is safe precisely because the
 * mutation is ONE statement: a constraint violation rolls the whole thing back,
 * so a failed attempt wrote neither the post nor its revision, and the next
 * attempt re-reads and picks a free candidate.
 *
 * THE ATTEMPT INDEX IS THE WHOLE FIX. Re-running the same closure re-derives the
 * same candidate from the same taken set, so every writer in a crowd collides
 * again on the same slug and each round admits exactly one of them — measured,
 * ten concurrent writers left seven with a raw `23505`. `uniqueSlug` takes the
 * index and climbs a ladder that ends in a random suffix, so the loop terminates
 * in success rather than in an exhausted counter.
 *
 * Bounded, because an unbounded loop turns a genuine schema problem into a hung
 * request. The last rung cannot realistically collide, so the bound is never the
 * thing that decides the outcome.
 */
async function withSlugRetry<T>(
  attempt: (index: number) => Promise<T>,
  attempts = SLUG_ATTEMPTS,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt(i);
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
      last = err;
    }
  }
  throw last;
}
