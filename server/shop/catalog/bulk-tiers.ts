import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { BulkTier } from '../../../shared/commerce/ports';

export { pickTier } from '../../../shared/commerce/ports';

/**
 * The bulk quantity ladder (migration 0600).
 *
 * ONE TABLE, TWO SCOPES: `product_id IS NULL` is the store-wide default every
 * product inherits; a non-NULL row overrides exactly one product.
 *
 * WHY A PERCENTAGE LADDER AND NOT A SECOND PRICE ROW. `shop_prices` is the
 * price HISTORY — effective-dated, and the authority on what one unit costs. A
 * quantity discount is not a different price, it is a rule about a basket, and
 * writing it into the price table would make "what did this cost on Tuesday"
 * unanswerable.
 */

/** 10 000 basis points is 100%; the denominator every rate here is scaled by. */
export const BPS = 10_000;

/**
 * The default ladder as 0600 seeds it. Duplicated here ONLY as the seed for a
 * store that has somehow lost every global row — `resolveTiers` reads the
 * database, never this constant, so the two cannot silently disagree about
 * live pricing.
 */
export const DEFAULT_LADDER: readonly BulkTier[] = [
  { minQty: 3, percentBps: 500 },
  { minQty: 5, percentBps: 1000 },
  { minQty: 10, percentBps: 1500 },
];

function rowToTier(row: Record<string, unknown>): BulkTier {
  return { minQty: Number(row.min_qty), percentBps: Number(row.percent_bps) };
}

/**
 * The ladders that apply to `productIds`, already resolved.
 *
 * WHAT "RESOLVED" MEANS HERE, in the order the rules fire:
 *
 * 1. `bulk_discount_enabled = false` → an EMPTY ladder. The switch wins over
 *    every row, including the product's own overrides, so turning it off does
 *    not require deleting anything.
 * 2. the product owns at least one row → exactly its own rows. FULL
 *    REPLACEMENT, NOT MERGE (0600's header says why: a merged ladder is
 *    unpredictable from either input, and "drop the 10+ rung here" becomes
 *    unexpressible).
 * 3. otherwise → the store-wide default rows.
 *
 * An empty array is therefore a COMPLETE answer meaning "no bulk discount",
 * which is what lets `toStorefrontProduct` and the totals engine take it at
 * face value with no second rule of their own.
 *
 * ONE STATEMENT, NO TRANSACTION. The Neon HTTP driver rejects `db.transaction`
 * unconditionally while PGlite supports it, so a transaction here would pass
 * every test and 500 in production.
 *
 * EVERY REQUESTED ID IS IN THE MAP, including products with no rows and
 * products that do not exist. An omission would make every caller write the
 * same "missing means empty" branch, and one of them would forget.
 */
export async function resolveTiers(
  db: Db,
  productIds: readonly string[],
): Promise<Map<string, BulkTier[]>> {
  const out = new Map<string, BulkTier[]>();
  for (const id of productIds) out.set(id, []);
  if (productIds.length === 0) return out;

  const res = await db.execute(sql`
    SELECT p.id AS product_id,
           t.min_qty AS min_qty,
           t.percent_bps AS percent_bps
      FROM shop_products p
      JOIN shop_bulk_tiers t
        ON t.product_id = p.id
        OR (t.product_id IS NULL
            -- The default applies only where the product has NO ladder of its
            -- own. This NOT EXISTS is rule 2 above; without it every
            -- overriding product would receive its own rungs AND the defaults
            -- merged together.
            AND NOT EXISTS (SELECT 1 FROM shop_bulk_tiers own
                             WHERE own.product_id = p.id))
     WHERE p.id = ANY(${sql.param(productIds as string[])}::text[])
       AND p.bulk_discount_enabled
     ORDER BY t.min_qty ASC`);

  for (const row of res.rows) {
    /* `get` and then a guard, NOT `(out.get(id) ?? []).push(…)` — that spelling
       pushes into a fresh array which is immediately discarded, so a row for an
       unseeded id would vanish silently instead of landing anywhere. */
    const bucket = out.get(String(row.product_id));
    if (bucket) bucket.push(rowToTier(row));
  }
  return out;
}

/** One product's ladder, resolved. Convenience over `resolveTiers` for detail. */
export async function resolveTiersFor(db: Db, productId: string): Promise<BulkTier[]> {
  return (await resolveTiers(db, [productId])).get(productId) ?? [];
}

/**
 * The rows of ONE scope, exactly as stored — no inheritance applied.
 *
 * This is the admin editor's read, and it is deliberately NOT `resolveTiers`:
 * the editor has to be able to tell "this product has no rows and inherits"
 * apart from "this product has rows that happen to equal the default", and a
 * resolved ladder collapses those two into the same answer.
 */
export async function listTiers(db: Db, productId: string | null): Promise<BulkTier[]> {
  const res = await db.execute(sql`
    SELECT min_qty, percent_bps
      FROM shop_bulk_tiers
     WHERE product_id IS NOT DISTINCT FROM ${productId}::text
     ORDER BY min_qty ASC`);
  return res.rows.map(rowToTier);
}

/**
 * Replace one scope's ladder wholesale.
 *
 * `IS NOT DISTINCT FROM` AND NOT `=`. `product_id = NULL` is NULL, not true, so
 * a plain `=` would delete nothing at all when targeting the store-wide scope
 * and then insert a SECOND default ladder — which the `COALESCE` unique index
 * would refuse, turning a routine edit into a 23505. The null-safe comparison
 * is what makes the global scope addressable.
 *
 * ONE STATEMENT WITH CTEs, NOT A TRANSACTION, per the driver constraint above.
 * The delete and the insert are ordered by the CTE dependency, so a reader
 * either sees the old ladder or the new one, never neither.
 *
 * AN EMPTY `tiers` IS A LEGITIMATE INPUT and means "this scope has no ladder" —
 * for a product that is "inherit the default again", which is exactly how the
 * editor's Reset button is expressed.
 */
export async function replaceTiers(
  db: Db,
  productId: string | null,
  tiers: readonly BulkTier[],
  now: number,
): Promise<BulkTier[]> {
  /* Sorted and de-duplicated before it reaches SQL: the unique index would
     refuse a duplicate `minQty` with a 23505 naming an index the caller has
     never heard of, and answering "you sent qty 5 twice" needs it done here. */
  const byQty = new Map<number, number>();
  for (const tier of tiers) byQty.set(tier.minQty, tier.percentBps);
  const rows = [...byQty.entries()]
    .map(([minQty, percentBps]) => ({ minQty, percentBps }))
    .sort((a, b) => a.minQty - b.minQty);

  /*
   * IDS ARE DETERMINISTIC — `blk_<scope>_<minQty>` — and that is what makes the
   * statement below an UPSERT rather than a delete-and-reinsert.
   *
   * It matters. A DELETE and an INSERT of the SAME key inside one statement is
   * exactly the case Postgres does not promise: a data-modifying CTE's effects
   * are not visible to the rest of the statement, so re-inserting a rung the
   * CTE just deleted races the unique index for a 23505 on a routine edit. The
   * padding keeps `blk_default_0010` sorting after `blk_default_0003` for
   * anyone reading the table by hand.
   */
  const scope = productId ?? 'default';
  const values = rows.map(
    (t) =>
      sql`(${`blk_${scope}_${String(t.minQty).padStart(4, '0')}`}, ${productId}::text,
           ${t.minQty}::integer, ${t.percentBps}::integer, ${now}::bigint, ${now}::bigint)`,
  );

  /* An empty ladder is legitimate ("inherit the default again"), and `VALUES`
     cannot be empty — so the empty case is a typed zero-row relation, which
     makes the prune below delete everything in scope and insert nothing. The
     casts are not decoration: a bare NULL bound parameter inside a UNION-shaped
     relation is a 42P18, "could not determine data type". */
  const incoming =
    rows.length === 0
      ? sql`SELECT NULL::text AS id, NULL::text AS product_id,
                   NULL::integer AS min_qty, NULL::integer AS percent_bps,
                   NULL::bigint AS created_at, NULL::bigint AS updated_at
              WHERE false`
      : sql`SELECT * FROM (VALUES ${sql.join(values, sql`, `)})
              AS v(id, product_id, min_qty, percent_bps, created_at, updated_at)`;

  await db.execute(sql`
    WITH incoming AS (${incoming}),
    upserted AS (
      INSERT INTO shop_bulk_tiers
        (id, product_id, min_qty, percent_bps, created_at, updated_at)
      SELECT id, product_id, min_qty, percent_bps, created_at, updated_at
        FROM incoming
      ON CONFLICT (id) DO UPDATE
        SET percent_bps = EXCLUDED.percent_bps,
            updated_at  = EXCLUDED.updated_at
      RETURNING id
    )
    -- The prune. Rungs the caller did not send are gone; created_at survives
    -- on the ones that stayed, because an edit to 10% is not a new tier.
    DELETE FROM shop_bulk_tiers
     WHERE product_id IS NOT DISTINCT FROM ${productId}::text
       AND id NOT IN (SELECT id FROM incoming)`);

  return rows;
}
