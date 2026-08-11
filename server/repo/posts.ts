import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DbError, uniqueViolation } from '../db/client';
import { derive, nextExcerpt } from '../domain/derive';
import { SLUG_ATTEMPTS, uniqueSlug } from '../domain/slug';
import { POST_COLUMNS, postColumns, rowToPost } from './mapping';
import { InvalidDocumentError, NotFoundError, StaleWriteError } from './errors';
import { slugify } from '../../shared/doc';
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
             upd.title, upd.subtitle, upd.content, upd.word_count, ${kind}, NULL
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
