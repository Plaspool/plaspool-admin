import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type {
  CatalogPort,
  ReservationRequest,
  ReservationResult,
  VariantQuote,
} from '../../../shared/commerce/catalog-port';
import { commitHold, releaseHold, reserve } from './inventory';

/**
 * The real `CatalogPort` (contract §5). Consumed by Cart, and by Payments for
 * the capture-time commit.
 *
 * A PLAIN OBJECT, EXPORTED AS A VALUE, TAKING `db` PER CALL. Every consumer
 * receives it by injection and never imports it directly (§5), so every consumer
 * can be tested against `test/fake-catalog-port.ts` and none is blocked on this
 * file. Nothing here holds a handle: `db` is the caller's request-scoped one, so
 * a port call participates in whatever the caller is doing rather than opening a
 * second connection with its own view of the world.
 */

/**
 * "Sellable" IS DECIDED HERE AND ONCE, and this predicate is the whole of it:
 * the product is `active` and not trashed, the variant is `active`, and a
 * current price row exists.
 *
 * A consumer assembling that itself would be a second implementation of
 * Catalog's publication rules living in Cart, and the two would disagree the
 * first time either changed — which on a shop means a cart line for something
 * the storefront no longer offers. It is also the same predicate `reserve`
 * enforces inside its own conditional statement, which is what keeps "you can
 * see it" and "you can buy it" from drifting apart.
 *
 * The join to `shop_prices` is INNER, unlike the one in `listVariantsWithPrices`.
 * A variant with no price is a real state the admin surface has to show; it is
 * not a thing a cart may hold, because there is no amount to charge.
 */
async function quote(db: Db, variantId: string): Promise<VariantQuote | null> {
  const res = await db.execute(sql`
    SELECT v.id, v.product_id, v.sku, v.option_values, v.weight_grams,
           p.title,
           pr.amount, pr.currency,
           i.on_hand - i.reserved AS available,
           i.backorderable
      FROM shop_variants v
      JOIN shop_products p ON p.id = v.product_id
      JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
      JOIN shop_inventory i ON i.variant_id = v.id
     WHERE v.id = ${variantId}
       AND v.status = 'active'
       AND p.status = 'active'
       AND p.deleted_at IS NULL`);

  const row = res.rows[0];
  if (!row) return null;

  return {
    variantId: String(row.id),
    productId: String(row.product_id),
    sku: String(row.sku),
    title: String(row.title),
    optionValues: (typeof row.option_values === 'string'
      ? (JSON.parse(row.option_values) as Record<string, string>)
      : (row.option_values as Record<string, string>)) ?? {},
    /*
     * Minor units and a currency code, straight out of two integer/text columns.
     * Not built through `money()`: the database's own `amount >= 0` and
     * `currency ~ '^[A-Z]{3}$'` checks already hold, and a constructor that
     * THREW here would turn one malformed legacy row into a 500 on a storefront
     * read rather than a product that simply cannot be quoted.
     */
    price: { amount: Number(row.amount), currency: String(row.currency) },
    weightGrams: row.weight_grams == null ? null : Number(row.weight_grams),
    /*
     * DERIVED IN SQL. A number to show a shopper, and never the number the sale
     * is decided on — between this read and a `reserve` any quantity of it can
     * be taken, which is why `reserve` re-checks in its own predicate rather
     * than trusting whatever this returned.
     */
    available: Number(row.available),
    backorderable: row.backorderable === true,
  };
}

export const catalogPort: CatalogPort<Db> = {
  quote,

  reserve: (db: Db, req: ReservationRequest): Promise<ReservationResult> => reserve(db, req),

  /**
   * `Promise<void>` per contract §5, so the boolean the repository returns is
   * discarded here.
   *
   * That discard is deliberate and it is also the subject of amendment
   * A-CAT-012: a `commitReservation` that silently does nothing — because the
   * hold was already released by Cart's expiry sweeper — is a payment captured
   * against stock that was handed back, and the port as specified gives its
   * caller no way to notice. `commitHold` in `inventory.ts` returns the fact for
   * any caller inside Catalog; the port cannot pass it on without a signature
   * change, which is not Catalog's to make.
   */
  release: async (db: Db, reservationId: string): Promise<void> => {
    await releaseHold(db, reservationId);
  },

  commitReservation: async (db: Db, reservationId: string): Promise<void> => {
    await commitHold(db, reservationId);
  },
};
