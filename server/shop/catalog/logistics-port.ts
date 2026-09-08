import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { LogisticsCatalog } from '../logistics/deps';

/**
 * The real `LogisticsCatalog` — Catalog's side of the weights seam.
 *
 * IN `server/shop/catalog/` AND NOT IN `server/shop/logistics/`, deliberately.
 * `shop_variants` is Catalog's table and "which variants can be sold" is
 * Catalog's rule; a weight query written in the logistics subsystem would be a
 * second copy of that rule, and the two would disagree the first time either
 * moved. Logistics declares the interface, receives this by injection at
 * `shop/app.ts`, and never imports it — the same shape `catalogPort` uses for
 * Cart.
 *
 * A PLAIN OBJECT TAKING `db` PER CALL, holding no handle of its own, so a port
 * call participates in whatever the caller is already doing.
 */
export const logisticsCatalogPort: LogisticsCatalog = {
  /**
   * Grams per variant id. **A variant that does not exist is simply absent from
   * the map** rather than present as `null`, so a caller can tell "we do not
   * know this variant's weight" from "we do not know this variant".
   *
   * NO STATUS FILTER HERE, unlike `weightCoverage` below. These ids come off an
   * order that has already been placed, and a variant discontinued between the
   * sale and the parcel still has to be weighed and shipped.
   */
  async weightsFor(db: Db, variantIds: readonly string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    /* An empty `IN ()` is a syntax error, and asking is pointless anyway. */
    if (variantIds.length === 0) return out;

    const res = await db.execute(sql`
      SELECT id, weight_grams
        FROM shop_variants
       WHERE id = ANY(ARRAY[${sql.join(
         variantIds.map((id) => sql`${id}`),
         sql`, `,
       )}]::text[])`);

    for (const row of res.rows) {
      out.set(String(row.id), row.weight_grams == null ? null : Number(row.weight_grams));
    }
    return out;
  },

  /**
   * How much of the SELLABLE catalogue could be quoted for.
   *
   * Live variants of live products only: a discontinued variant or a trashed
   * product with no weight is not a problem anybody needs to fix, and counting
   * them would put a number on the settings screen that can never reach zero.
   */
  async weightCoverage(db: Db): Promise<{ missing: number; total: number }> {
    const res = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE v.weight_grams IS NULL)::int AS missing
        FROM shop_variants v
        JOIN shop_products p ON p.id = v.product_id
       WHERE v.status = 'active'
         AND p.deleted_at IS NULL`);

    const row = res.rows[0] ?? {};
    return { missing: Number(row.missing ?? 0), total: Number(row.total ?? 0) };
  },
};
