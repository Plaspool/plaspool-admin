import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Every tag in use, one row per case-fold group — the vocabulary the tag box
 * offers while somebody types.
 *
 * WHY THIS EXISTS. Tags are free text with no managed list behind them, and the
 * tag box was the door the `PLA / pla / Pla / pLA` mess (migration 0010) came in
 * through: with nothing offered, every writer re-invents the spelling. The box
 * now shows what already exists and adopts it on a case-match, and this route is
 * where "what already exists" comes from.
 *
 * THE SAME INVERSION AS `categories.ts`, FOR THE SAME REASON: every row of
 * `shop_products`, drafts and trash included — behind `requireAuth()`, this is
 * the working vocabulary, and hiding a draft's tags would make the box offer a
 * spelling on Tuesday and a twin of it on Wednesday depending on publish state.
 *
 * Canonical spelling per group: most products, ties alphabetical — `updated_at`
 * deliberately does NOT tie-break here, unlike categories: a tag has no single
 * owning row to take a timestamp from once it is unnested, and `max(updated_at)`
 * over carriers would let an unrelated edit to one product flip the canon of a
 * tag it happens to carry. (`canonicalTags` in `catalog/fold.ts` uses the same
 * count-then-alphabetical rule, so the box and the write path agree.)
 */

/** One row of `GET /api/shop/admin/tags`. */
export interface ShopTag {
  name: string;
  /** Products carrying this tag, any spelling. Drafts, archived and trash included. */
  count: number;
}

export async function listShopTags(db: Db): Promise<ShopTag[]> {
  const res = await db.execute(sql`
    WITH spellings AS (
      SELECT tag AS value, lower(tag) AS folded, count(*) AS cnt
        FROM shop_products, unnest(tags) AS tag
       WHERE tag <> ''
       GROUP BY tag
    )
    SELECT (array_agg(value ORDER BY cnt DESC, value ASC))[1] AS name,
           /* ::int for the PGlite/Neon int8 divergence — see categories.ts. */
           sum(cnt)::int AS count
      FROM spellings
     GROUP BY folded
     ORDER BY folded ASC`);
  return res.rows.map((row) => ({
    name: String(row.name),
    count: Number(row.count),
  }));
}
