import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMs } from '../db/client';
import { LIST_POST_COLUMNS, postColumns } from './mapping';
import { PUBLIC_POST_PREDICATE } from './public';
import { rowToPublicPost } from './public-projection';
import { FeaturedConflictError, NotFeaturableError, NotFoundError } from './errors';
import type { NotFeaturableReason } from './errors';
import { MAX_FEATURED } from '../../shared/types';
import type { CoverImage, FeaturedItem, PublicPost } from '../../shared/types';

/**
 * The curated rail — the four posts the storefront's `/posts` page leads with.
 *
 * The contract is written in the STOREFRONT repo, in the TODO block above
 * `listFeaturedPosts()` in `packages/blog/src/data/posts.ts`. Four invariants,
 * all of them server-side. This file holds two of them and proves the other
 * two are already held elsewhere:
 *
 * 1. Only a publicly visible post can be featured — here, as
 *    `PUBLIC_POST_PREDICATE` (see `featurable` below).
 * 2. At most `MAX_FEATURED` at a time — held by `posts_featured_rank_ck` and
 *    `posts_featured_rank_uq` in migration 0280; this file only makes the
 *    refusal useful by naming the current four.
 * 3. Unpublishing, archiving or trashing clears the flag — held in
 *    `server/repo/posts.ts`, inside the same statement as the status change.
 * 4. A reorder rewrites every rank at once — here, as one guarded statement
 *    that validates in its own snapshot.
 *
 * ═══ NOTHING HERE OPENS A TRANSACTION ═══
 * `db.transaction` throws unconditionally on the neon-http driver while PGlite
 * supports it, so a transaction here would pass every test in this repository
 * and 500 in production (CLAUDE.md §3). Every mutation below is ONE statement,
 * which is atomic by construction, and the deferred unique constraint is what
 * makes the multi-row ones expressible that way.
 *
 * ═══ CURATION TOUCHES ONLY THESE TWO COLUMNS ═══
 * Not `revision`, not `updated_at`, and it writes no revision snapshot.
 * `revision` is the editor's CAS token, so moving it would 409 the next
 * autosave from an open editor against a change its writer did not make.
 * `updated_at` is PUBLIC — it is `PublicPost.updatedAt` and it feeds the detail
 * route's `Last-Modified` — so moving it would tell every reader the post had
 * been edited when only its position in a rail changed. Featuring is an
 * editorial act, not authorship, and the row records it as one.
 */

/**
 * Re-exported so this module reads as the one place curation is defined, while
 * the number itself lives in `shared/` — the admin UI draws its "n of 4"
 * counter from the same constant, and two copies of a cap are a cap.
 *
 * The storefront keeps its own `MAX_FEATURED` (`packages/blog/src/data/
 * config.ts`), independently the same 4, and slices to it defensively. That is
 * a different repository and a deliberate duplicate: the edge declining to
 * render a rail that outgrew its design is not the same statement as the
 * database refusing to store one.
 */
export { MAX_FEATURED } from '../../shared/types';

/** Enough to draw a card and to name a post in a 409. Never a document. */
const FEATURED_COLUMNS = sql.raw(
  ['id', 'title', 'slug', 'cover_image', 'published_at', 'featured_rank']
    .map((c) => `p.${c}`)
    .join(', '),
);

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

function rowToFeaturedItem(row: Record<string, unknown>): FeaturedItem {
  return {
    id: String(row.id),
    // Non-null because only a row satisfying `PUBLIC_POST_PREDICATE` can be
    // featured and invariant 3 clears the flag when it stops satisfying it.
    slug: String(row.slug),
    title: String(row.title),
    coverImage: json<CoverImage>(row.cover_image),
    publishedAt: toEpochMs(row.published_at),
    rank: Number(row.featured_rank),
  };
}

// ---------------------------------------------------------------------- reads

/**
 * The rail as the ADMIN sees it: what is actually flagged, in rank order.
 *
 * `WHERE p.featured` AND NOT the public predicate, deliberately. Invariant 3
 * means the two sets are the same, but if they ever diverge the admin must see
 * the FLAG — because the flag is what it manages and what the cap counts. A
 * manager that filtered by visibility would show three cards while the cap
 * refused a fourth, with nothing on screen to explain the disagreement.
 *
 * `listPublicFeatured` is the one that filters, and it filters because it is a
 * public surface, not because it is trusting this.
 */
export async function listFeatured(db: Db): Promise<FeaturedItem[]> {
  const res = await db.execute(sql`
    SELECT ${FEATURED_COLUMNS} FROM posts p
     WHERE p.featured
     ORDER BY p.featured_rank ASC`);
  return res.rows.map(rowToFeaturedItem);
}

/**
 * The rail as a READER sees it: `PublicPost`, in curated order.
 *
 * BEHIND `PUBLIC_POST_PREDICATE` LIKE EVERY OTHER PUBLIC QUERY, even though
 * invariant 3 already guarantees a featured post is visible. Visibility is
 * decided in exactly one place (`server/repo/public.ts`), and a public query
 * that leaned on a different invariant instead would be one refactor away from
 * being the exception that leaks.
 *
 * `LIMIT MAX_FEATURED` is likewise belt-and-braces over a constraint that
 * already bounds it — the same defensive slice the storefront does at its own
 * edge.
 */
export async function listPublicFeatured(db: Db): Promise<PublicPost[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p', LIST_POST_COLUMNS))},
           u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE ${PUBLIC_POST_PREDICATE}
       AND p.featured
     ORDER BY p.featured_rank ASC
     LIMIT ${MAX_FEATURED}`);
  return res.rows.map((row) => rowToPublicPost(row, String(row.author_name)));
}

// ----------------------------------------------------------------- explaining

interface StateRow {
  status: string;
  deleted_at: unknown;
  slug: unknown;
  published_at: unknown;
  featured: boolean;
}

/**
 * Why a row failed `PUBLIC_POST_PREDICATE`, in the predicate's own order.
 *
 * READ AFTER THE FACT AND USED ONLY TO EXPLAIN — never to decide whether the
 * write may proceed. That is the same rule `transition()` states for `holds()`,
 * and for the same reason: a precondition judged in TypeScript is judged
 * against a row that has already been read, i.e. against exactly the stale
 * value the guarded statement exists to distrust.
 */
function whyNotFeaturable(row: StateRow): NotFeaturableReason {
  if (row.status === 'archived') return 'archived';
  if (row.status !== 'published') return 'draft';
  // Checked after `status` because trash is a VIEW rather than a status: a
  // trashed post keeps whatever status it had, so a published post in the bin
  // reaches here reading `published`.
  if (row.deleted_at != null) return 'trashed';
  if (row.slug == null) return 'no_slug';
  return 'no_publish_date';
}

async function readState(db: Db, id: string): Promise<StateRow | null> {
  const res = await db.execute(sql`
    SELECT p.status, p.deleted_at, p.slug, p.published_at, p.featured
      FROM posts p WHERE p.id = ${id}`);
  const row = res.rows[0];
  return row ? (row as unknown as StateRow) : null;
}

// -------------------------------------------------------------------- feature

export interface FeatureOptions {
  /**
   * Take this post's slot. The newcomer inherits its RANK, so the swap lands
   * where the operator pointed rather than at the end of the rail.
   */
  replace?: string;
}

/**
 * Put a post on the rail, optionally in place of one that is already on it.
 *
 * ONE STATEMENT DECIDES ALL OF IT. The target's eligibility, the victim's
 * removal, the free slot and the promotion are four CTEs over ONE snapshot, so
 * there is no window in which the rail is short by one, and no read-then-write
 * for a concurrent call to slip through.
 *
 * WHY `replace` IS A PARAMETER AND NOT TWO CALLS. Unfeature-then-feature is two
 * statements, and between them the live rail is three posts long for everyone
 * reading the storefront. It also loses the position: the newcomer would take
 * the lowest free rank, which is the vacated one only by luck.
 *
 * THE VACATED RANK IS READ IN A NON-MODIFYING CTE, before the clearing one.
 * Every CTE in a statement sees the same snapshot, so `victim` reads the
 * pre-update value; `RETURNING` from the UPDATE would hand back the new one
 * (NULL), and `RETURNING OLD.*` is Postgres 18.
 *
 * The transient state where two rows hold the same rank — the victim in the
 * snapshot and the newcomer being written — is legal only because
 * `posts_featured_rank_uq` is DEFERRABLE. See migration 0280.
 */
export async function featurePost(
  db: Db,
  id: string,
  opts: FeatureOptions = {},
): Promise<FeaturedItem[]> {
  const replace = opts.replace ?? null;
  const swapping = replace !== null;

  const res = await db.execute(sql`
    WITH target AS (
      SELECT p.id FROM posts p
       WHERE p.id = ${id}
         AND NOT p.featured
         AND ${PUBLIC_POST_PREDICATE}
    ), victim AS (
      SELECT p.id, p.featured_rank AS rank FROM posts p
       WHERE ${swapping} AND p.id = ${replace}::text AND p.featured
    ), cleared AS (
      UPDATE posts SET featured = false, featured_rank = NULL
       WHERE id IN (SELECT id FROM victim)
         -- Never strip the victim for a promotion that is not going to happen.
         AND EXISTS (SELECT 1 FROM target)
      RETURNING id
    ), slot AS (
      SELECT COALESCE(
        (SELECT rank FROM victim),
        -- The LOWEST free rank, not max+1, so a slot vacated by an unpublish is
        -- refilled instead of leaving a permanent hole. NOT EXISTS and never
        -- NOT IN, which answers NULL the moment a NULL reaches it.
        (SELECT min(r) FROM generate_series(1, ${MAX_FEATURED}) AS r
          WHERE NOT EXISTS (
            SELECT 1 FROM posts f WHERE f.featured AND f.featured_rank = r))
      ) AS rank
    ), promoted AS (
      UPDATE posts SET featured = true, featured_rank = (SELECT rank FROM slot)
       WHERE id IN (SELECT id FROM target)
         AND (SELECT rank FROM slot) IS NOT NULL
         -- A swap whose victim has already left the rail is refused rather than
         -- quietly demoted to a plain feature: the rail moved under the
         -- operator, and "just add it anyway" is not what they asked for.
         AND (NOT ${swapping} OR EXISTS (SELECT 1 FROM victim))
      RETURNING id
    )
    SELECT (SELECT count(*) FROM promoted)::int AS promoted,
           (SELECT count(*) FROM cleared)::int  AS cleared`);

  if (Number(res.rows[0].promoted) === 1) return listFeatured(db);

  /*
   * Nothing was promoted, so nothing at all was written — `cleared` is guarded
   * on `target` existing. Read the row back to find out which clause said no.
   * This read is the ONLY thing the explanation is derived from.
   */
  const state = await readState(db, id);
  if (!state) throw new NotFoundError(id);

  // Already on the rail. The caller asked for a state the row is in, which is
  // not a conflict — a double-clicked toggle must not be an error.
  if (state.featured) return listFeatured(db);

  const items = await listFeatured(db);
  const featurable =
    state.status === 'published' &&
    state.deleted_at == null &&
    state.slug != null &&
    state.published_at != null;
  if (!featurable) throw new NotFeaturableError(id, whyNotFeaturable(state));

  // Eligible and not promoted: either the swap's victim is gone, or there was
  // no free slot. Both are 409s carrying the rail, and they differ only in the
  // sentence the admin puts above it.
  const stale = swapping && !items.some((item) => item.id === replace);
  throw new FeaturedConflictError(
    stale ? 'featured_stale' : 'featured_full',
    items,
    MAX_FEATURED,
  );
}

// ------------------------------------------------------------------ unfeature

/**
 * Take a post off the rail. Idempotent, and it clears BOTH columns.
 *
 * The rank matters as much as the flag: a rank left behind would hold a slot no
 * post appears in, so the rail would render three cards and then refuse a
 * fourth for a reason nothing on screen could show. `posts_featured_rank_ck`
 * refuses that state outright, so this is the constraint's shape rather than an
 * extra precaution.
 *
 * NO EXISTENCE CHECK, unlike `featurePost`. There is nothing to distinguish: a
 * post that is absent is a post that is not featured, and both are answered by
 * the rail as it now stands. The route reads the post first anyway, so a 404
 * for a destroyed id still comes from where every other post route's does.
 *
 * GAPS ARE NOT CLOSED. Removing rank 2 of three leaves 1 and 3, which orders
 * and renders exactly as it should. Compacting would rewrite posts the operator
 * did not touch to fix nothing anyone can see; a reorder is the one operation
 * that normalises.
 */
export async function unfeaturePost(db: Db, id: string): Promise<FeaturedItem[]> {
  await db.execute(sql`
    UPDATE posts SET featured = false, featured_rank = NULL
     WHERE id = ${id} AND featured`);
  return listFeatured(db);
}

// -------------------------------------------------------------------- reorder

/** SQLSTATE 23505 against the rank constraint — see `reorderFeatured`. */
function isRankCollision(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  const text = String(e?.message ?? '');
  return (
    (e?.code === '23505' || text.includes('23505')) &&
    (e?.constraint === 'posts_featured_rank_uq' ||
      text.includes('posts_featured_rank_uq'))
  );
}

/**
 * Rewrite the whole rail's ranks — invariant 4.
 *
 * `ids` must be exactly what is featured now, in the desired order. It is not a
 * patch and there is no single-row form, because there cannot be one: two rows
 * exchanging ranks is the ordinary case, and any decomposition of it leaves a
 * moment where they share a rank or a moment where one has none.
 *
 * ═══ THE VALIDATION IS IN THE STATEMENT, NOT BEFORE IT ═══
 * Reading the rail, comparing it in TypeScript and then writing would leave a
 * window: the check would be against a row set that had already moved. `ok`
 * below is evaluated in the SAME snapshot as the update it guards, so a rail
 * that changed cannot be half-reordered — the update simply matches nothing and
 * the caller is told.
 *
 * Three ways the list can be wrong, and all three mean "the rail moved between
 * the render and the drop": wrong length, an id that is not featured, and a
 * repeated id. The third needs its own clause — it passes a length check, and
 * without it `UPDATE … FROM` would pick one of the duplicate rows arbitrarily
 * and leave another post unranked.
 *
 * ═══ AND A COLLISION IS STILL POSSIBLE, SO IT IS CAUGHT ═══
 * A post featured by somebody else AFTER this statement's snapshot is invisible
 * to `ok` and can hold a rank this reorder is about to assign. The deferred
 * constraint catches it at commit; that is a lost race, not a bug, so it
 * becomes the same `featured_stale` the caller already knows how to render
 * rather than a 500 the client would retry five times.
 */
export async function reorderFeatured(db: Db, ids: string[]): Promise<FeaturedItem[]> {
  const stale = async (): Promise<never> => {
    throw new FeaturedConflictError('featured_stale', await listFeatured(db), MAX_FEATURED);
  };

  const res = await db
    .execute(
      sql`
    WITH want AS (
      SELECT id, rank FROM unnest(${sql.param(ids)}::text[])
        WITH ORDINALITY AS t(id, rank)
    ), ok AS (
      SELECT (SELECT count(*) FROM posts WHERE featured) = (SELECT count(*) FROM want)
         AND (SELECT count(DISTINCT id) FROM want) = (SELECT count(*) FROM want)
         AND (SELECT count(*) FROM want w
               JOIN posts p ON p.id = w.id AND p.featured) = (SELECT count(*) FROM want)
        AS valid
    ), upd AS (
      UPDATE posts p SET featured_rank = w.rank
        FROM want w
       WHERE p.id = w.id AND p.featured AND (SELECT valid FROM ok)
      RETURNING p.id
    )
    SELECT (SELECT count(*) FROM upd)::int AS n, (SELECT valid FROM ok) AS valid`,
    )
    .catch(async (err: unknown) => {
      if (isRankCollision(err)) return stale();
      throw err;
    });

  // An empty rail reordered to an empty list is valid and updates nothing, so
  // `valid` — not the row count — is what decides.
  if (res.rows[0].valid !== true) return stale();
  return listFeatured(db);
}
