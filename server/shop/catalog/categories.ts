import { sql } from 'drizzle-orm';
import { slugify } from '../../../shared/doc';
import { MAX_CATEGORY_BYTES } from '../../../shared/validate';
import { uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError, PreconditionFailedError } from '../../repo/errors';
import { newCatalogId } from './mapping';
import type { Db } from '../../db/client';
import type { Post } from '../../../shared/types';

/**
 * Managed shop categories — the repo (migration 0200).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A PORT OF `server/repo/categories.ts`, THE BLOG'S EQUIVALENT, AND THE
 * DUPLICATION IS DELIBERATE RATHER THAN LAZY.
 *
 * Every statement below is shaped by that file's arguments and they are not
 * repeated here in full — the union's FULL OUTER JOIN, the one-statement rename,
 * the refusal decided inside the DELETE. What could not be shared is the two
 * things that make it a different surface: this table has `slug`, `blurb`,
 * `accent_hex` and `position`, and it groups over `shop_products` rather than
 * `posts`. `server/shop/catalog/slug.ts` records the same finding about
 * `server/domain/slug.ts` — a repo function that hardcodes its table cannot be
 * reused across two of them, and generalising a file this subsystem does not own
 * is raised rather than done (contract §9).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The index whose violation is a duplicate name rather than a bug. */
const NAME_UQ = 'shop_categories_name_lower_uq';
/** The index whose violation is a slug collision the allocator should retry. */
const SLUG_UQ = 'shop_categories_slug_uq';

/** `shared/validate.ts`'s ceiling for the blurb, which no tsvector feeds. */
const MAX_BLURB_BYTES = 600;

/**
 * How many suffixed slugs to try before giving up.
 *
 * DELIBERATELY NOT `server/shop/catalog/slug.ts`'S FOUR-RUNG LADDER, and the
 * contrast is the justification. That ladder exists because N concurrent product
 * saves all derive the SAME next candidate and so need diversification to avoid
 * N rounds — measured at ten writers leaving seven with a raw 23505. Categories
 * are created by hand, a handful of times, by one or two owners; there is no
 * crowd to diversify against. A bounded read-then-insert with a retry on the
 * unique violation is the honest shape for that, and the index is still the
 * arbiter, so a race loses a round rather than writing a duplicate.
 */
const SLUG_ATTEMPTS = 50;

/**
 * One row of the categories surface.
 *
 * `id` IS NULLABLE AND THE NULL IS LOAD-BEARING: it means "in use, not managed"
 * — a value sitting in `shop_products.category` with no row here. Such a row can
 * be adopted (POST the name to create the managed row) but cannot be renamed,
 * recoloured or deleted, because there is nothing to change. `managed` is the
 * same fact as a boolean, derived from `id` rather than selected, because
 * boolean parsing is one of the places PGlite and Neon have diverged.
 *
 * `slug` is null for exactly the same rows, and that is why the PUBLIC read
 * returns managed rows only: an unmanaged category has no URL to route to.
 * Migration 0200 backfilled a managed row for every category in use at the time,
 * so this state only arises for a category typed AFTER it — which the admin list
 * surfaces precisely so somebody can adopt it.
 */
export interface ShopCategorySummary {
  id: string | null;
  slug: string | null;
  name: string;
  blurb: string;
  accentHex: string | null;
  position: number;
  /** Products carrying this name case-insensitively. */
  count: number;
  managed: boolean;
}

/** What the storefront renders. Managed rows only, so every field is present. */
export interface PublicShopCategory {
  slug: string;
  name: string;
  blurb: string;
  accentHex: string | null;
  position: number;
  /** Active, non-trashed products carrying this name case-insensitively. */
  count: number;
}

/**
 * A 409 about a category, carrying the category.
 *
 * Extends `PreconditionFailedError` rather than replacing it, exactly as
 * `ProductPreconditionFailedError` does and for the same two reasons: the
 * fallback is the safety property — one escaping to
 * `server/middleware/errors.ts` is still a correct 409 rather than a 500 — and
 * the payload is what could not be reused, since the shared class carries a
 * `Post`.
 */
export class ShopCategoryPreconditionFailedError extends PreconditionFailedError {
  readonly category: ShopCategorySummary;

  constructor(operation: string, category: ShopCategorySummary) {
    super(operation, {} as Post);
    this.name = 'ShopCategoryPreconditionFailedError';
    this.category = category;
  }
}

// ------------------------------------------------------------------ validate

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Trim, refuse empty, refuse oversized — BYTES, NOT CHARACTERS.
 *
 * `MAX_CATEGORY_BYTES` bounds `posts.category` because that column feeds a
 * tsvector; it is restated for `shop_products.category` so the two free-text
 * category columns in this database cannot disagree about what fits. A Zod
 * `.max(400)` alone counts UTF-16 units and undercounts by up to 4x, which would
 * let a name through that the rename's bulk UPDATE then fails on.
 */
export function normaliseShopCategoryName(raw: string, field: string): string {
  const name = raw.trim();
  if (name === '') throw new BadRequestError(field);
  if (utf8Bytes(name) > MAX_CATEGORY_BYTES) throw new BadRequestError(field);
  return name;
}

/** The blurb is optional copy: empty is legal, oversized is not. */
export function normaliseShopCategoryBlurb(raw: string, field: string): string {
  const blurb = raw.trim();
  if (utf8Bytes(blurb) > MAX_BLURB_BYTES) throw new BadRequestError(field);
  return blurb;
}

/**
 * Lowercase six-digit hex, or null.
 *
 * LOWERCASED RATHER THAN REFUSED when the caller sends `#FFFFFF`, matching
 * `catalog/variants.ts`'s handling of `colorHex`: a colour picker that emits
 * uppercase is not a client error, and the check constraint only accepts one
 * casing, so normalising here is the difference between a working form and a
 * 400 nobody can explain.
 */
export function normaliseAccentHex(raw: string | null, field: string): string | null {
  if (raw === null) return null;
  const hex = raw.trim().toLowerCase();
  if (hex === '') return null;
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new BadRequestError(field);
  return hex;
}

/**
 * A caller-supplied slug, put through the same function that mints one.
 *
 * `slugify` RATHER THAN A REGEX TEST, so "ABS & ASA" typed into the slug field
 * becomes `abs-asa` instead of a 400. The check constraint accepts exactly what
 * `slugify` emits, so anything that survives this is storable by construction —
 * and a value already in that form passes through unchanged, which is what makes
 * re-submitting an unedited form a no-op rather than a walk.
 */
export function normaliseSlug(raw: string): string {
  return slugify(raw);
}

function toSummary(row: Record<string, unknown>): ShopCategorySummary {
  const id = row.id == null ? null : String(row.id);
  return {
    id,
    slug: row.slug == null ? null : String(row.slug),
    name: String(row.name),
    blurb: row.blurb == null ? '' : String(row.blurb),
    accentHex: row.accent_hex == null ? null : String(row.accent_hex),
    position: Number(row.position ?? 0),
    // `count(*)::int` in every statement below, so this is a JS number in both
    // drivers. An unqualified `count(*)` is int8, which PGlite parses as a
    // number and Neon hands back as a string.
    count: Number(row.count),
    managed: id !== null,
  };
}

// ---------------------------------------------------------------------- read

/**
 * The admin list: the UNION of the managed table and the values actually in use.
 *
 * A `FULL OUTER JOIN`, because both sides can have rows the other does not — a
 * managed category nobody has used yet (count 0) and a value typed after the
 * backfill (`id: null`). An inner join would hide the first; reading only
 * `shop_categories` would hide the second.
 *
 * COUNTS EVERY PRODUCT, ANY STATUS, INCLUDING TRASH — and that deliberately
 * inverts the published-only rule the public read below follows.
 * `server/shop/admin/categories.ts` makes the argument: this feeds the category
 * filter on the admin product list, a filter that must be able to select the
 * drafts, the archived products and the trash, because the list it filters can
 * show all three. `?status=trash&category=…` is a real query somebody makes when
 * looking for the thing they deleted last week.
 *
 * `used` GROUPS BY `lower(category)` AND NOT BY `category`, so 'PLA' and 'pla'
 * are one row rather than two that both join to the same managed row.
 *
 * THE UNMANAGED SPELLING IS THE CANONICAL ONE, NOT `min()`. The blog's
 * equivalent takes `min(p.category)` and says so is "a stable spelling"; this
 * subsystem already had a stricter answer and it is the one every other read
 * gives — most products wins, ties to the most recently updated product's, then
 * alphabetical. `0010_catalogue_case_fold.sql`, `canonicalCategory`
 * (`catalog/fold.ts`) and the backfill in `0200_shop_categories.sql` all make
 * that identical pick, so a pre-migration straggler and a racing write resolve
 * to the same spelling this list offers. `min()` would sometimes disagree with
 * all three — 'foldables' on two products would lose to 'Foldables' on one,
 * purely because uppercase sorts first.
 */
export async function listShopCategoriesUnion(db: Db): Promise<ShopCategorySummary[]> {
  const res = await db.execute(sql`
    WITH spellings AS (
      SELECT p.category        AS value,
             lower(p.category) AS folded,
             count(*)          AS cnt,
             max(p.updated_at) AS latest
        FROM shop_products p
       WHERE p.category <> ''
       GROUP BY p.category
    ), used AS (
      SELECT folded AS key,
             (array_agg(value ORDER BY cnt DESC, latest DESC, value ASC))[1] AS name,
             sum(cnt)::int AS count
        FROM spellings
       GROUP BY folded
    )
    SELECT c.id                     AS id,
           c.slug                   AS slug,
           COALESCE(c.name, u.name) AS name,
           COALESCE(c.blurb, '')    AS blurb,
           c.accent_hex             AS accent_hex,
           COALESCE(c.position, 0)  AS position,
           COALESCE(u.count, 0)     AS count
      FROM shop_categories c
      FULL OUTER JOIN used u ON u.key = lower(c.name)
     ORDER BY COALESCE(c.position, 0) ASC, lower(COALESCE(c.name, u.name)) ASC`);
  return res.rows.map(toSummary);
}

/**
 * The storefront list: managed rows only, counting only what a customer can buy.
 *
 * MANAGED ONLY, because an unmanaged category has no slug and `/store/<slug>`
 * has nothing to route to. The backfill in migration 0200 gave every category
 * in use at the time a row, so this excludes only categories typed since — which
 * the admin list surfaces for adoption.
 *
 * ACTIVE AND NOT TRASHED, matching `listProducts`' storefront predicate exactly
 * (`server/shop/catalog/query.ts`: `p.deleted_at IS NULL AND p.status =
 * 'active'`). The two must agree or a tile reads "6 spools" and its page shows
 * four.
 *
 * A ZERO-COUNT CATEGORY IS STILL RETURNED. It is a real editorial state — a
 * category created ahead of the products going into it — and the storefront can
 * decide whether to render an empty tile. Filtering here would make that
 * decision for it, invisibly.
 */
export async function listPublicShopCategories(db: Db): Promise<PublicShopCategory[]> {
  const res = await db.execute(sql`
    SELECT c.slug        AS slug,
           c.name        AS name,
           c.blurb       AS blurb,
           c.accent_hex  AS accent_hex,
           c.position    AS position,
           (SELECT count(*)::int
              FROM shop_products p
             WHERE lower(p.category) = lower(c.name)
               AND p.deleted_at IS NULL
               AND p.status = 'active') AS count
      FROM shop_categories c
     ORDER BY c.position ASC, lower(c.name) ASC`);
  return res.rows.map((row) => ({
    slug: String(row.slug),
    name: String(row.name),
    blurb: row.blurb == null ? '' : String(row.blurb),
    accentHex: row.accent_hex == null ? null : String(row.accent_hex),
    position: Number(row.position),
    count: Number(row.count),
  }));
}

/** One managed row by slug — the storefront's `/store/<slug>` page header. */
export async function getPublicShopCategory(
  db: Db,
  slug: string,
): Promise<PublicShopCategory | null> {
  const all = await listPublicShopCategories(db);
  return all.find((c) => c.slug === slug) ?? null;
}

/**
 * The managed row whose name matches case-insensitively, or `null`.
 *
 * Only ever called on the losing side of a 23505, to put the row that won into
 * the 409. It is a second read and can therefore be raced, which is why callers
 * fall back to describing the name: a 409 with a slightly stale payload is a
 * better answer than a 500.
 */
async function findByName(db: Db, name: string): Promise<ShopCategorySummary | null> {
  const res = await db.execute(sql`
    SELECT c.id AS id, c.slug AS slug, c.name AS name, c.blurb AS blurb,
           c.accent_hex AS accent_hex, c.position AS position,
           (SELECT count(*)::int FROM shop_products p
             WHERE lower(p.category) = lower(c.name)) AS count
      FROM shop_categories c
     WHERE lower(c.name) = lower(${name})
     LIMIT 1`);
  const row = res.rows[0];
  return row ? toSummary(row) : null;
}

// -------------------------------------------------------------------- create

export interface ShopCategoryInput {
  name: string;
  blurb: string;
  accentHex: string | null;
  position: number;
}

/**
 * Promote a name to a managed row, allocating its slug.
 *
 * The count comes back non-zero when the name was ALREADY IN USE as free text,
 * which is the ordinary way this is called rather than an edge case: "adopt the
 * category I have been typing" and "create a new one" are the same request and
 * the client cannot tell them apart without asking.
 *
 * A duplicate NAME is a 409 and not a silent success — two writers naming the
 * same category differently want to be told a spelling already exists, because
 * the one in the table is the one every product will end up carrying. A
 * duplicate SLUG is different: it is not a disagreement, just an occupied URL,
 * so it is suffixed and retried rather than reported.
 */
export async function createShopCategory(
  db: Db,
  input: ShopCategoryInput,
): Promise<ShopCategorySummary> {
  const base = slugify(input.name);
  const now = Date.now();

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const res = await db.execute(sql`
        WITH created AS (
          INSERT INTO shop_categories
            (id, slug, name, blurb, accent_hex, position, created_at, updated_at)
          VALUES (${newCatalogId('cat_')}, ${slug}, ${input.name}, ${input.blurb},
                  ${input.accentHex}, ${input.position}, ${now}, ${now})
          RETURNING id, slug, name, blurb, accent_hex, position
        )
        SELECT c.id AS id, c.slug AS slug, c.name AS name, c.blurb AS blurb,
               c.accent_hex AS accent_hex, c.position AS position,
               (SELECT count(*)::int FROM shop_products p
                 WHERE lower(p.category) = lower(c.name)) AS count
          FROM created c`);
      return toSummary(res.rows[0]);
    } catch (err) {
      const violated = uniqueViolation(err);
      // An occupied URL: take the next suffix and try again.
      if (violated === SLUG_UQ) continue;
      if (violated !== NAME_UQ) throw err;
      const existing = await findByName(db, input.name);
      throw new ShopCategoryPreconditionFailedError(
        'create',
        existing ?? {
          id: null,
          slug: null,
          name: input.name,
          blurb: '',
          accentHex: null,
          position: 0,
          count: 0,
          managed: false,
        },
      );
    }
  }

  /* Fifty occupied suffixes for one base is not a race, it is a caller looping.
   * A 400 naming the field is a better answer than a fifty-first attempt. */
  throw new BadRequestError('slug');
}

// -------------------------------------------------------------------- update

export interface ShopCategoryPatch {
  name?: string;
  blurb?: string;
  accentHex?: string | null;
  position?: number;
  /** Changing the URL. Absent means "leave it", which is the normal case. */
  slug?: string;
}

export interface ShopCategoryUpdateResult {
  category: ShopCategorySummary;
  /** Products the one UPDATE actually moved off the old name. */
  movedProducts: number;
}

/**
 * Rename the managed row and rewrite every product carrying the old value, IN
 * ONE STATEMENT — and apply the presentation fields in the same statement.
 *
 * ONE STATEMENT IS ONE IMPLICIT TRANSACTION, which is the only thing that makes
 * the pair atomic on this stack: `db.transaction` is forbidden on the hot path
 * because the Neon HTTP driver rejects it unconditionally. Split into two round
 * trips, a failure between them leaves the list saying 'PLA+' and every product
 * saying 'PLA' — a category that is managed, renamed, and attached to nothing.
 *
 * A RENAME IS ALSO THE MERGE TOOL, which falls out of the `lower()` rule rather
 * than being bolted on: renaming 'pla' to 'PLA' normalises every casing in the
 * catalogue, and renaming onto an existing UNMANAGED value folds that legacy
 * value into this row. Renaming onto another MANAGED name is refused by
 * `shop_categories_name_lower_uq`, because merging two managed rows is a
 * different operation with a different confirmation and doing it silently would
 * destroy one of them.
 *
 * THE SLUG IS NOT TOUCHED BY A RENAME. It only moves when `patch.slug` says so,
 * which is the rule `ProductPatch` states — a published URL is a promise. A
 * rename that silently moved `/store/abs` would 404 every shared link.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: `shop_products.revision` and
 * `updated_at`. A category rename is not an edit of anybody's product. Bumping
 * `revision` would 409 every open product form for a typo fix, and bumping
 * `updated_at` would reorder the admin list, which sorts by it.
 */
export async function updateShopCategory(
  db: Db,
  id: string,
  patch: ShopCategoryPatch,
): Promise<ShopCategoryUpdateResult> {
  const now = Date.now();
  /*
   * `COALESCE(${value}, column)` with an explicit null means "leave it", which
   * works for every field except `accent_hex`, where null is a REAL VALUE
   * meaning "no tint". A separate boolean discriminates the two rather than
   * overloading null — the same problem `deleteCategory`'s `reassign` solves by
   * distinguishing "omitted" from "the empty string".
   */
  const clearAccent = patch.accentHex === null;
  const nextAccent = patch.accentHex ?? null;
  const touchAccent = 'accentHex' in patch;

  /*
   * EVERY NULLABLE BOUND PARAMETER CARRIES AN EXPLICIT CAST, and that is not
   * decoration. A bare `NULL` parameter inside `COALESCE(...)` or `… IS NOT
   * NULL` gives the planner nothing to infer from, and Postgres refuses the
   * whole statement with **42P18, "could not determine data type of
   * parameter"** — which arrives as a 500 on every patch that omits a field,
   * i.e. on the ordinary case rather than an edge one. Caught by
   * `categories.test.ts`; the casts are what make "leave this field alone"
   * expressible at all.
   */
  const nextName = patch.name ?? null;
  const nextSlug = patch.slug ?? null;
  const nextBlurb = patch.blurb ?? null;
  const nextPosition = patch.position ?? null;

  let res;
  try {
    res = await db.execute(sql`
      WITH target AS (
        SELECT id, name FROM shop_categories WHERE id = ${id}
      ), moved AS (
        UPDATE shop_products p
           SET category = COALESCE(${nextName}::text, p.category)
          FROM target t
         WHERE ${nextName}::text IS NOT NULL
           AND lower(p.category) = lower(t.name)
        RETURNING 1
      ), updated AS (
        UPDATE shop_categories c
           SET name       = COALESCE(${nextName}::text, c.name),
               slug       = COALESCE(${nextSlug}::text, c.slug),
               blurb      = COALESCE(${nextBlurb}::text, c.blurb),
               accent_hex = CASE WHEN ${touchAccent}::boolean
                                 THEN ${clearAccent ? null : nextAccent}::text
                                 ELSE c.accent_hex END,
               position   = COALESCE(${nextPosition}::int, c.position),
               updated_at = ${now}
          FROM target t
         WHERE c.id = t.id
        RETURNING c.id, c.slug, c.name, c.blurb, c.accent_hex, c.position
      )
      SELECT u.id AS id, u.slug AS slug, u.name AS name, u.blurb AS blurb,
             u.accent_hex AS accent_hex, u.position AS position,
             (SELECT count(*)::int FROM moved) AS moved_products,
             /*
              * Products that ALREADY carried the new name and are therefore
              * being merged in. Counted separately from the moved set AND with
              * the old name excluded, or a case-only rename counts every product
              * twice: once as moved, once as already matching.
              */
             (SELECT count(*)::int FROM shop_products p, target t
               WHERE ${nextName}::text IS NOT NULL
                 AND lower(p.category) = lower(${nextName}::text)
                 AND lower(p.category) <> lower(t.name)) AS merged_products
        FROM updated u`);
  } catch (err) {
    const violated = uniqueViolation(err);
    if (violated === SLUG_UQ) throw new BadRequestError('slug');
    if (violated !== NAME_UQ) throw err;
    const existing = patch.name ? await findByName(db, patch.name) : null;
    throw new ShopCategoryPreconditionFailedError(
      'rename',
      existing ?? {
        id,
        slug: null,
        name: patch.name ?? '',
        blurb: '',
        accentHex: null,
        position: 0,
        count: 0,
        managed: true,
      },
    );
  }

  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);

  const movedProducts = Number(row.moved_products);
  return {
    category: {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      blurb: row.blurb == null ? '' : String(row.blurb),
      accentHex: row.accent_hex == null ? null : String(row.accent_hex),
      position: Number(row.position),
      /* The post-statement count, assembled from the two pre-statement sets the
       * statement itself measured. Re-reading afterwards would be a second round
       * trip AND a different snapshot. A patch that did not rename moved
       * nothing, so the count is read fresh below only in that case. */
      count: patch.name
        ? movedProducts + Number(row.merged_products)
        : await countFor(db, String(row.name)),
      managed: true,
    },
    movedProducts,
  };
}

/** Products carrying a name, any status. Only used when a patch did not rename,
 *  where the statement above has no moved/merged sets to add up. */
async function countFor(db: Db, name: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS count FROM shop_products p
     WHERE lower(p.category) = lower(${name})`);
  return Number(res.rows[0]?.count ?? 0);
}

// -------------------------------------------------------------------- delete

export interface ShopCategoryDeleteResult {
  /** 0 unless a reassignment target was given. */
  movedProducts: number;
}

/**
 * Delete the managed row.
 *
 * `reassign === null` means "only if nothing uses it": in use, the whole thing
 * is refused with a 409 carrying the count, because silently orphaning twelve
 * products' category into unmanaged free text is exactly the state this table
 * exists to end. `reassign` non-null moves them first — and `''` is a REAL
 * CHOICE distinct from omitting it: it means "make them uncategorised", which
 * somebody has to be able to say out loud.
 *
 * THE REFUSAL IS DECIDED INSIDE THE DELETE STATEMENT rather than by a read
 * followed by a delete, because a read-then-write decides against a snapshot a
 * concurrent writer may already have invalidated. It is worth noting what that
 * race would cost, because it is the reason there is no foreign key here: the
 * worst outcome is a category value that stops being managed and shows up in the
 * next admin list with `id: null`. No product loses anything.
 */
export async function deleteShopCategory(
  db: Db,
  id: string,
  reassign: string | null,
): Promise<ShopCategoryDeleteResult> {
  if (reassign === null) {
    const res = await db.execute(sql`
      WITH target AS (
        SELECT id, slug, name, blurb, accent_hex, position
          FROM shop_categories WHERE id = ${id}
      ), used AS (
        SELECT count(*)::int AS n
          FROM shop_products p, target t
         WHERE lower(p.category) = lower(t.name)
      ), removed AS (
        DELETE FROM shop_categories c
         USING target t
         WHERE c.id = t.id AND (SELECT n FROM used) = 0
        RETURNING c.id
      )
      SELECT t.id AS id, t.slug AS slug, t.name AS name, t.blurb AS blurb,
             t.accent_hex AS accent_hex, t.position AS position,
             (SELECT n FROM used) AS count,
             (SELECT count(*)::int FROM removed) AS removed
        FROM target t`);

    const row = res.rows[0];
    if (!row) throw new NotFoundError(id);
    if (Number(row.removed) === 0) {
      throw new ShopCategoryPreconditionFailedError('delete', toSummary(row));
    }
    return { movedProducts: 0 };
  }

  /*
   * The reassignment target is NOT required to be a managed category, and that
   * is not laxity. `shop_products.category` is free text by design, so a target
   * with no row simply becomes an in-use unmanaged value the next admin list
   * reports with `id: null`. Refusing it would mean the only way to move twelve
   * products to a new name is to create the name first — two requests for one
   * intention.
   */
  const res = await db.execute(sql`
    WITH target AS (
      SELECT id, name FROM shop_categories WHERE id = ${id}
    ), moved AS (
      UPDATE shop_products p
         SET category = ${reassign}
        FROM target t
       WHERE lower(p.category) = lower(t.name)
      RETURNING 1
    ), removed AS (
      DELETE FROM shop_categories c
       USING target t
       WHERE c.id = t.id
      RETURNING c.id
    )
    SELECT t.id AS id,
           (SELECT count(*)::int FROM moved)   AS moved_products,
           (SELECT count(*)::int FROM removed) AS removed
      FROM target t`);

  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  return { movedProducts: Number(row.moved_products) };
}
