import { sql } from 'drizzle-orm';
import { uniqueViolation } from '../db/client';
import { BadRequestError, NotFoundError, PreconditionFailedError } from './errors';
import { MAX_CATEGORY_BYTES, utf8Bytes } from '../../shared/validate';
import type { Db } from '../db/client';
import type { Post } from '../../shared/types';

/**
 * Managed categories (HANDOFF §2 A3).
 *
 * ONE RULE DECIDES EVERY STATEMENT IN THIS FILE: a category is identified by
 * `lower(name)`. The unique index is over `lower(name)`, the union below joins on
 * `lower(name)`, the rename moves posts on `lower(name)` and the delete counts on
 * `lower(name)`. Applied anywhere less than everywhere it stops being a rule and
 * starts being a bug you can only find by counting: a list that shows 'Design'
 * with 12 posts, next to a rename that moves 9 of them because the other 3 were
 * typed 'design'.
 *
 * WHAT THIS TABLE DOES NOT DO. It does not own where a post's category is
 * stored. `posts.category` remains denormalised `text` — it feeds the `search`
 * tsvector generated column and `GET /api/public/categories` groups on it — so
 * every statement here is "the managed list" on one side and "the values actually
 * in use" on the other, and the two are reconciled at read time rather than by a
 * foreign key. The consequence is deliberate and is the whole shape of the
 * feature: a value can be in use without being managed (every category typed
 * before this table existed), and a managed row can name a value no post carries.
 *
 * COUNTS INCLUDE EVERY POST, not just published ones and not just drafts. The
 * count is the row set the rename's UPDATE will actually move, trash included —
 * `movedPosts` and `count` have to be the same number or the UI's "N posts will
 * move" is a promise the server does not keep. That is the opposite rule from
 * `publicCategories`, which is a reading surface and must not publish the working
 * vocabulary of every draft; this one is behind `requireAuth()`.
 */

/**
 * One row of `GET /api/categories`.
 *
 * PINNED BY `src/data/api-categories.ts`, which was written before this route
 * existed because three frontend surfaces are being built against it in parallel.
 * The shape is copied there field for field; `server/routes/categories.test.ts`
 * is what stops the two drifting.
 *
 * `id` IS NULLABLE AND THE NULL IS LOAD-BEARING: it means "in use, not managed".
 * Such a row can be selected and it can be adopted (POST the name to create the
 * managed row), but it cannot be renamed or deleted, because there is no row to
 * name. `managed` is the same fact stated as a boolean — redundant, and part of
 * the pinned contract, so it is derived from `id` here rather than selected
 * separately.
 */
export interface CategorySummary {
  id: string | null;
  name: string;
  /** Posts carrying this name case-insensitively. Drafts, archived and trash. */
  count: number;
  managed: boolean;
}

/** `posts.category` for "no category". Not a name; see the CHECK in 0007. */
export const UNCATEGORISED = '';

/** The index whose violation is a duplicate name rather than a bug. */
const NAME_UQ = 'categories_name_lower_uq';

/**
 * A 409 about a category, carrying the category.
 *
 * EXTENDS `PreconditionFailedError` RATHER THAN REPLACING IT, exactly as
 * `ProductPreconditionFailedError` does, and for the same two reasons. The
 * fallback is the safety property — one of these escaping to
 * `server/middleware/errors.ts` is still a correct 409 rather than a 500 — and
 * the payload is what could not be reused: the shared class carries a `Post`, and
 * a category is not one.
 *
 * The payload is not decoration. Every one of the three refusals is a question
 * the UI has to answer immediately and cannot answer from the status code:
 * "'Design' already exists" wants the existing row so the picker can select it,
 * and "12 posts still use this" wants the count so the reassign dialog can open
 * with a number in it. Without it every refusal costs a second round trip.
 */
export class CategoryPreconditionFailedError extends PreconditionFailedError {
  readonly category: CategorySummary;

  constructor(operation: string, category: CategorySummary) {
    /*
     * The base requires a non-null `Post` and this has none. The same contained
     * cast `server/shop/catalog/errors.ts` documents: nothing reads `.post` on
     * one of these, because the renderer in `server/routes/categories.ts` reads
     * `.category`, and the global fallback only ever serialises it — where `{}`
     * is a strictly better answer than a category masquerading as a post.
     */
    super(operation, {} as Post);
    this.name = 'CategoryPreconditionFailedError';
    this.category = category;
  }
}

/**
 * A name the database will accept, or a 400 naming the FIELD it came from.
 *
 * `detail` is the field name and never the value — spec §8, and the reason
 * `zodDetail` exists. The field differs by call site: the same rules bound
 * `{ name }` in a body and `?reassign=` in a query string, and a 400 that said
 * `name` for a rejected query parameter would send the caller looking at the
 * wrong input.
 *
 * BYTES, NOT CHARACTERS. `MAX_CATEGORY_BYTES` bounds `posts.category` because
 * that column feeds the `search` tsvector, and `String.length` counts UTF-16
 * units — it undercounts by up to 4x, so a Zod `.max(400)` alone would let a name
 * through that the rename's bulk UPDATE then fails 54000 halfway into.
 */
export function normaliseCategoryName(raw: string, field: string): string {
  const name = raw.trim();
  if (name === '') throw new BadRequestError(field);
  if (utf8Bytes(name) > MAX_CATEGORY_BYTES) throw new BadRequestError(field);
  return name;
}

function toSummary(row: Record<string, unknown>): CategorySummary {
  const id = row.id == null ? null : String(row.id);
  return {
    id,
    name: String(row.name),
    // `count(*)::int` in every statement below, so this is a JS number in both
    // drivers. An unqualified `count(*)` is int8, which PGlite parses as a number
    // and Neon hands back as a string (spec §9) — and `count` is a number in the
    // pinned client contract.
    count: Number(row.count),
    // The same fact as `id !== null`, which is why it is derived rather than
    // selected: a `(c.id IS NOT NULL) AS managed` column would be a boolean, and
    // boolean parsing is the one other place the two drivers have diverged.
    managed: id !== null,
  };
}

// ---------------------------------------------------------------------- read

/**
 * The UNION of the managed list and the values actually in use.
 *
 * A `FULL OUTER JOIN`, because both sides can have rows the other does not: a
 * managed category nobody has used yet (count 0, `managed: true`) and a value
 * typed before this table existed (`id: null`, `managed: false`). An inner join
 * would hide the first, and reading only `categories` would hide the second and
 * make every legacy category vanish from every picker the day this shipped.
 *
 * `used` GROUPS BY `lower(category)` AND NOT BY `category`. Grouping by the raw
 * value would emit 'Design' and 'design' as two rows, both of which then join to
 * the same managed row — one category appearing twice in the list with its posts
 * split across the entries. `min(p.category)` picks a stable spelling for the
 * unmanaged case; the managed spelling wins wherever there is one, because that
 * is the one an owner chose.
 */
export async function listCategories(db: Db): Promise<CategorySummary[]> {
  const res = await db.execute(sql`
    WITH used AS (
      SELECT lower(p.category) AS key,
             min(p.category)   AS name,
             count(*)::int     AS count
        FROM posts p
       WHERE p.category <> ''
       GROUP BY lower(p.category)
    )
    SELECT c.id                     AS id,
           COALESCE(c.name, u.name) AS name,
           COALESCE(u.count, 0)     AS count
      FROM categories c
      FULL OUTER JOIN used u ON u.key = lower(c.name)
     ORDER BY lower(COALESCE(c.name, u.name)) ASC`);
  return res.rows.map(toSummary);
}

/**
 * The managed row whose name matches case-insensitively, or `null`.
 *
 * Only ever called on the losing side of a 23505, to put the row that won into
 * the 409. It is a second read and it can therefore be raced — the winner could
 * be renamed again before this runs — which is why the caller falls back to
 * describing the name rather than failing: a 409 with a slightly stale payload is
 * a better answer than a 500.
 */
async function findByName(db: Db, name: string): Promise<CategorySummary | null> {
  const res = await db.execute(sql`
    SELECT c.id AS id,
           c.name AS name,
           (SELECT count(*)::int FROM posts p WHERE lower(p.category) = lower(c.name)) AS count
      FROM categories c
     WHERE lower(c.name) = lower(${name})
     LIMIT 1`);
  const row = res.rows[0];
  return row ? toSummary(row) : null;
}

// -------------------------------------------------------------------- create

/**
 * Promote a name to a managed row.
 *
 * The count comes back non-zero when the name was ALREADY IN USE as free text —
 * which is the ordinary way this route is called, not an edge case: "adopt the
 * category I have been typing for six months" is the same request as "create a
 * new one", and the client cannot tell them apart without asking.
 *
 * A duplicate is a 409 and not a silent success. `POST` twice returning the same
 * row would be friendlier and would also hide a real disagreement: two writers
 * naming the same category differently ('Design' vs 'design') want to be told
 * that a spelling already exists, because the one in the table is the one every
 * post will end up carrying.
 */
export async function createCategory(db: Db, name: string): Promise<CategorySummary> {
  try {
    const res = await db.execute(sql`
      WITH created AS (
        INSERT INTO categories (name, created_at)
        VALUES (${name}, ${Date.now()})
        RETURNING id, name
      )
      SELECT c.id AS id,
             c.name AS name,
             (SELECT count(*)::int FROM posts p
               WHERE lower(p.category) = lower(c.name)) AS count
        FROM created c`);
    return toSummary(res.rows[0]);
  } catch (err) {
    if (uniqueViolation(err) !== NAME_UQ) throw err;
    const existing = await findByName(db, name);
    throw new CategoryPreconditionFailedError(
      'create',
      existing ?? { id: null, name, count: 0, managed: false },
    );
  }
}

// -------------------------------------------------------------------- rename

export interface CategoryRenameResult {
  category: CategorySummary;
  /** Posts the one UPDATE actually moved off the old name. */
  movedPosts: number;
}

/**
 * Rename the managed row and rewrite every post carrying the old value, IN ONE
 * STATEMENT.
 *
 * One statement is one implicit transaction, which is the only thing that makes
 * the pair atomic on this stack: spec §4.3a forbids `db.transaction` on the hot
 * path because the Neon HTTP driver rejects it unconditionally. Split into two
 * round trips, a failure between them leaves the list saying 'Product Design' and
 * every post saying 'Design' — a category that is managed, renamed, and attached
 * to nothing.
 *
 * A RENAME IS ALSO THE MERGE TOOL, and that falls out of the `lower()` rule
 * rather than being bolted on. Renaming 'design' to 'Design' normalises every
 * casing in the blog; renaming 'Design' to an existing UNMANAGED value folds that
 * legacy value into this row. Renaming onto another MANAGED name is refused by
 * `categories_name_lower_uq` — merging two managed rows is a different operation
 * with a different confirmation, and doing it silently would destroy one of them.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `posts.revision`, `posts.updated_at` and
 * `posts.lifecycle_generation`. A category rename is not an edit of anybody's
 * text. Bumping `revision` would 409 every open editor in the building for a typo
 * fix, and bumping `updated_at` would reorder the entire dashboard, which sorts
 * by it. The lifecycle trigger already ignores this write on its own — it watches
 * `status`, `published_at` and `deleted_at` — so a lifecycle retry racing a
 * rename still wins, which is correct: they are about different things.
 */
export async function renameCategory(
  db: Db,
  id: string,
  name: string,
): Promise<CategoryRenameResult> {
  let res;
  try {
    res = await db.execute(sql`
      WITH target AS (
        SELECT id, name FROM categories WHERE id = ${id}::uuid
      ), moved AS (
        UPDATE posts p
           SET category = ${name}
          FROM target t
         WHERE lower(p.category) = lower(t.name)
        RETURNING 1
      ), renamed AS (
        UPDATE categories c
           SET name = ${name}
          FROM target t
         WHERE c.id = t.id
        RETURNING c.id, c.name
      )
      SELECT r.id AS id,
             r.name AS name,
             (SELECT count(*)::int FROM moved) AS moved_posts,
             /*
              * Posts that ALREADY carried the new name and are therefore being
              * merged in. Counted separately from the moved set AND with the old
              * name excluded, or a case-only rename ('design' -> 'Design') counts
              * every post twice: once as moved, once as already matching.
              */
             (SELECT count(*)::int FROM posts p, target t
               WHERE lower(p.category) = lower(${name})
                 AND lower(p.category) <> lower(t.name)) AS merged_posts
        FROM renamed r`);
  } catch (err) {
    if (uniqueViolation(err) !== NAME_UQ) throw err;
    const existing = await findByName(db, name);
    throw new CategoryPreconditionFailedError(
      'rename',
      existing ?? { id: null, name, count: 0, managed: false },
    );
  }

  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);

  const movedPosts = Number(row.moved_posts);
  return {
    category: {
      id: String(row.id),
      name: String(row.name),
      // The post-statement count, assembled from the two pre-statement sets the
      // statement itself measured. Re-reading `posts` afterwards would be a
      // second round trip AND a different snapshot.
      count: movedPosts + Number(row.merged_posts),
      managed: true,
    },
    movedPosts,
  };
}

// -------------------------------------------------------------------- delete

export interface CategoryDeleteResult {
  /** 0 unless a reassignment target was given. */
  movedPosts: number;
}

/**
 * Delete the managed row.
 *
 * `reassign === null` means "only if nothing uses it": in use, the whole thing is
 * refused with a 409 carrying the count, because silently orphaning twelve posts'
 * category into unmanaged free text is exactly the state this table exists to
 * end. `reassign` non-null moves them first — and `''` is a REAL CHOICE that is
 * not the same as omitting the parameter: it means "make them uncategorised",
 * which somebody has to be able to say out loud.
 *
 * The refusal is decided INSIDE the delete statement (`AND (SELECT n FROM used) =
 * 0`) rather than by a read followed by a delete. A read-then-write here is the
 * shape GAUNTLET II Part 2b measured on posts: the read decides against a
 * snapshot a concurrent writer has already invalidated, so a post assigned to the
 * category in between is deleted out from under. It is worth noting what that
 * race would and would not cost, because it is the reason there is no foreign key
 * here: the worst outcome is a category value that stops being managed and shows
 * up in the next list with `id: null`. No post loses anything. The one statement
 * is still the right shape, because "refused" and "deleted" must not both be
 * possible answers to one request.
 */
export async function deleteCategory(
  db: Db,
  id: string,
  reassign: string | null,
): Promise<CategoryDeleteResult> {
  if (reassign === null) {
    const res = await db.execute(sql`
      WITH target AS (
        SELECT id, name FROM categories WHERE id = ${id}::uuid
      ), used AS (
        SELECT count(*)::int AS n
          FROM posts p, target t
         WHERE lower(p.category) = lower(t.name)
      ), removed AS (
        DELETE FROM categories c
         USING target t
         WHERE c.id = t.id AND (SELECT n FROM used) = 0
        RETURNING c.id
      )
      SELECT t.id AS id,
             t.name AS name,
             (SELECT n FROM used) AS count,
             (SELECT count(*)::int FROM removed) AS removed
        FROM target t`);

    const row = res.rows[0];
    if (!row) throw new NotFoundError(id);
    if (Number(row.removed) === 0) {
      throw new CategoryPreconditionFailedError('delete', toSummary(row));
    }
    return { movedPosts: 0 };
  }

  /*
   * The reassignment target is NOT required to be a managed category, and that is
   * not laxity. `posts.category` is free text by design, so a target that has no
   * row simply becomes an in-use unmanaged value that the very next
   * `GET /api/categories` reports with `id: null` — the same state every category
   * typed before this table existed is already in. Refusing it would mean the
   * only way to move twelve posts to a new name is to create the name first,
   * which is two requests for one intention.
   */
  const res = await db.execute(sql`
    WITH target AS (
      SELECT id, name FROM categories WHERE id = ${id}::uuid
    ), moved AS (
      UPDATE posts p
         SET category = ${reassign}
        FROM target t
       WHERE lower(p.category) = lower(t.name)
      RETURNING 1
    ), removed AS (
      DELETE FROM categories c USING target t WHERE c.id = t.id RETURNING c.id
    )
    SELECT (SELECT count(*)::int FROM moved) AS moved_posts,
           (SELECT count(*)::int FROM removed) AS removed
      FROM target`);

  const row = res.rows[0];
  if (!row || Number(row.removed) === 0) throw new NotFoundError(id);
  return { movedPosts: Number(row.moved_posts) };
}
