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
 * GROUPED BY THE RAW VALUE, NOT BY `lower(category)`, AND THAT IS THE ONE THING
 * IN THIS FILE THAT IS NOT A JUDGEMENT CALL. `listProducts` filters with
 * `p.category = $1` — an EXACT, case-sensitive comparison. A list that folded
 * case would offer 'Design' as an option while three of the products under it are
 * spelled 'design', and clicking it would return a subset with no error anywhere
 * to explain the missing rows. The blog's managed categories fold case because
 * they own a `categories` table whose unique index is over `lower(name)`; the
 * shop has no such table (HANDOFF §2 A4: no new tables), so the values ARE the
 * vocabulary and the picker must offer them exactly as they are stored.
 *
 * That is also why two spellings appear as two rows. It is honest — they really
 * are two categories as far as every query in the shop is concerned — and it is
 * the only way an operator ever finds out they have a typo to fix.
 */

/** One row of `GET /api/shop/admin/categories`. */
export interface ShopCategory {
  name: string;
  /** Products carrying this exact value. Drafts, archived and trash included. */
  count: number;
}

/**
 * Every category value in use, alphabetically.
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
    SELECT p.category   AS name,
           count(*)::int AS count
      FROM shop_products p
     WHERE p.category <> ''
     GROUP BY p.category
     ORDER BY lower(p.category) ASC, p.category ASC`);
  return res.rows.map((row) => ({
    name: String(row.name),
    /*
     * `count(*)::int` in the statement, not a bare `count(*)`. An unqualified
     * count is int8, which PGlite parses as a number and Neon hands back as a
     * string (spec §9) — so the cast is what makes this a number in production
     * rather than only in the suite.
     */
    count: Number(row.count),
  }));
}
