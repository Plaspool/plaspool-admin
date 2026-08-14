import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * The product categories an ADMIN picker offers (HANDOFF §2 A4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS DELIBERATELY INVERTS THE PUBLISHED-ONLY RULE, AND THE INVERSION IS THE
 * FEATURE.
 *
 * `GET /api/public/categories` groups over PUBLISHED posts only, and
 * `server/repo/categories.ts` states why in the opposite direction: a reading
 * surface "must not publish the working vocabulary of every draft". That rule is
 * about anonymous readers. This route is behind `requireAuth()` and feeds the
 * category filter on the admin product list — a filter that must be able to
 * select the drafts, the archived products and the trash, because the list it
 * filters can show all three (`server/shop/catalog/query.ts`, `filters()`).
 *
 * So: every row of `shop_products`, no status filter and no `deleted_at`
 * filter. A category that exists only on a trashed product still appears, because
 * `?status=trash&category=…` is a real query somebody makes when they are looking
 * for the thing they deleted last week.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GROUPED CASE-INSENSITIVELY SINCE MIGRATION 0010, AND ONLY SINCE THEN. An
 * earlier version of this file grouped by the raw value and documented why that
 * was forced: `listProducts` compared `p.category = $1` exactly, so a folded
 * option here would have offered 'Design' while three products spelled it
 * 'design', and clicking it silently lost those rows. That coupling is the
 * thing 0010 dissolved — the filter now folds too (`lower(p.category) =
 * lower($1)`), the migration merged the stored twins, and the write path adopts
 * the stored spelling (`catalog/fold.ts`). The two sides fold together or not
 * at all; this file must never fold ahead of the filter again.
 *
 * ONE ROW PER FOLD-GROUP, under its canonical spelling: the one on the most
 * products, ties to the most recently updated product's, then alphabetical —
 * the identical pick 0010 and `canonicalCategory` make, so a pre-migration
 * straggler and a racing write both resolve to the spelling this list offers.
 */

/** One row of `GET /api/shop/admin/categories`. */
export interface ShopCategory {
  name: string;
  /** Products carrying this category, any spelling. Drafts, archived and trash included. */
  count: number;
}

/**
 * Every category in use, one row per case-fold group, alphabetically.
 *
 * `WHERE p.category <> ''` — the empty string is EXCLUDED, and it is not the same
 * thing as a category named "Uncategorised". `shop_products.category` is
 * `NOT NULL` and `''` is what a product with no category carries, and
 * `listProducts` treats an empty `?category=` as "no filter" rather than as a
 * value to match (`if (q.category)`). So an `''` row here would be an option that
 * cannot be selected: choosing it would clear the filter instead of narrowing it.
 * `publicCategories` excludes it for the same reason.
 */
export async function listShopCategories(db: Db): Promise<ShopCategory[]> {
  const res = await db.execute(sql`
    WITH spellings AS (
      SELECT p.category      AS value,
             lower(p.category) AS folded,
             count(*)        AS cnt,
             max(p.updated_at) AS latest
        FROM shop_products p
       WHERE p.category <> ''
       GROUP BY p.category
    )
    SELECT (array_agg(value ORDER BY cnt DESC, latest DESC, value ASC))[1] AS name,
           /*
            * The ::int cast matters twice over: an unqualified sum over bigint
            * is numeric, which PGlite parses as a number and Neon hands back
            * as a string (spec §9) — the cast is what makes this a number in
            * production rather than only in the suite.
            */
           sum(cnt)::int AS count
      FROM spellings
     GROUP BY folded
     ORDER BY folded ASC`);
  return res.rows.map((row) => ({
    name: String(row.name),
    count: Number(row.count),
  }));
}
