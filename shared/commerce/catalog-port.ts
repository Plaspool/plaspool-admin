/**
 * `CatalogPort` and its types (contract §5), in a file **Catalog owns
 * exclusively** and which `shared/commerce/ports.ts` re-exports.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT WRITTEN DIRECTLY INTO `ports.ts`, WHICH IS WHERE §5 PUTS IT. Because
 * "shared, append-only" is a convention with no mechanism behind it, and it did
 * not hold. During this build `shared/commerce/ports.ts` was WHOLESALE
 * OVERWRITTEN by successive agents rather than appended to, and Catalog's block
 * was silently lost twice — as was the same block in
 * `server/db/commerce-schema.ts`. Raised as amendment A-CAT-009.
 *
 * A file per owner, re-exported from the shared one, keeps §5's actual purpose
 * — one import path where every port is reachable — while reducing the
 * contested surface to a single `export *` line. A clobber then costs one line
 * that `tsc` names immediately, instead of two hundred that vanish quietly. And
 * a consumer whose re-export has been clobbered can still import
 * `shared/commerce/catalog-port` directly and keep working.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING HERE IMPORTS A `server/` MODULE. `shared/` is compiled into the
 * browser bundle as well as the server, so `Db` is a TYPE PARAMETER rather than
 * an import of `server/db/client` — the convention `PaymentPort<Db>` set in
 * `ports.ts`. Contract §5 writes the signatures as `quote(db: Db, …)` and that
 * is exactly what they are; naming the concrete type here is the one thing that
 * would make this file server-only.
 */

/**
 * `draft` → not for sale. `active` → sellable. `archived` → withdrawn.
 *
 * NOT `published`, deliberately: a product's sellable state and a blog post's
 * public state are different words for different things, and reusing the word
 * would invite the two lifecycles to be merged later.
 *
 * The array is exported beside the union because `server/shop/catalog/schema.ts`
 * builds its `check()` list from it. A check whose literals were retyped by hand
 * is a check that disagrees with its TypeScript union the first time either
 * changes, and the disagreement surfaces as a 23514 in production rather than as
 * a type error.
 */
export type ProductStatus = 'draft' | 'active' | 'archived';
export const PRODUCT_STATUSES: readonly ProductStatus[] = ['draft', 'active', 'archived'];

/**
 * A variant is sellable or it is retired. There is no `draft` variant: the
 * PRODUCT's status decides whether anything beneath it may be sold, so a second
 * draft-ness on the variant would be two answers to one question.
 */
export type VariantStatus = 'active' | 'discontinued';
export const VARIANT_STATUSES: readonly VariantStatus[] = ['active', 'discontinued'];

/**
 * The state of one stock hold, in Catalog's own ledger (`shop_inventory_holds`,
 * amendment A-CAT-002).
 *
 * `held` is counted in `shop_inventory.reserved`; the other two are terminal and
 * are not. Both `release` and `commitReservation` require `held`, which is what
 * makes the sweeper/capture race a no-op for whichever loses rather than a
 * double decrement (brief §5).
 */
export type HoldState = 'held' | 'released' | 'committed';
export const HOLD_STATES: readonly HoldState[] = ['held', 'released', 'committed'];

/**
 * One rung of a bulk quantity ladder (migration 0600).
 *
 * IN THIS FILE, NOT UNDER `server/shop/catalog/`, AND THAT PLACEMENT IS FORCED.
 * `server/shop/cart/totals/compute.ts` is a pure function that "imports nothing
 * from `server/` at all" — a property its own header defends at length, because
 * a totals engine that could reach a price is one whose answer depends on when
 * it ran. It needs this type and `pickTier`, so both live here beside
 * `TotalsLine` where Catalog and Cart can each import them without either
 * depending on the other.
 *
 * `percentBps` is basis points, matching `TaxRate.rateBps`: 10 000 is 100%, so
 * 1000 is 10%. An integer, because a rate stored as a float eventually renders
 * as 9.999999%.
 */
export interface BulkTier {
  minQty: number;
  percentBps: number;
}

/**
 * The rung that applies at `qty`, or `null` below the first one.
 *
 * PURE AND SEPARATELY TESTABLE, because this is the function whose boundary
 * behaviour decides what a customer is charged.
 *
 * THE LADDER IS NOT ASSUMED SORTED. A caller handing these over unordered — an
 * admin PUT, a hand-written fixture — would otherwise get whichever rung
 * happened to come last rather than the highest one that qualifies.
 *
 * `minQty <= qty` is INCLUSIVE: a rung the shop advertises as "3+" that did not
 * apply at exactly 3 would be a lie told in the shop's own UI.
 */
export function pickTier(tiers: readonly BulkTier[], qty: number): BulkTier | null {
  let best: BulkTier | null = null;
  for (const tier of tiers) {
    if (tier.minQty <= qty && (best === null || tier.minQty > best.minQty)) best = tier;
  }
  return best;
}

/**
 * A priced, sellable snapshot of one variant AT THIS INSTANT.
 *
 * Everything a cart line needs to be built without asking Catalog a second
 * question, and everything it needs to be FROZEN: contract §5 says a checkout's
 * totals are computed once and never recomputed, so a quote that made its caller
 * re-read the price later would defeat that by construction.
 *
 * "Sellable" is decided HERE and once — the product is `active` and not deleted,
 * the variant is `active`, and a current price row exists. A consumer that had to
 * assemble that predicate itself would be a second implementation of Catalog's
 * publication rules living in Cart, and the two would disagree the first time
 * either changed.
 */
export interface VariantQuote {
  variantId: string;
  productId: string;
  sku: string;
  /** The PRODUCT's title. A variant has options, not a name of its own. */
  title: string;
  /** `{ "Size": "M", "Colour": "Navy" }` — the option tuple, for display. */
  optionValues: Record<string, string>;
  /**
   * Contract §10's `Money`, spelled structurally so this file needs no import
   * at all. `shared/commerce/money.ts`'s `Money` is assignable to it.
   */
  price: { amount: number; currency: string };
  /**
   * What the shop SHOWS — the spool size. NULL is honest for a variant nobody
   * has weighed. Frozen onto the order line as part of the product snapshot.
   */
  weightGrams: number | null;
  /**
   * What DELIVERY is priced on (migration 1180), ALREADY RESOLVED: the
   * variant's shipping-weight override when it has one, else `weightGrams`.
   * NULL only when neither exists, and a courier caller must substitute rather
   * than send zero — a parcel booked as weightless is one the courier reprices
   * on the doorstep.
   */
  shippingWeightGrams: number | null;
  /**
   * `on_hand - reserved`, DERIVED (brief §5). A number to SHOW a shopper, never
   * a number to decide a sale on: between this read and a `reserve`, any
   * quantity of it can be taken. `reserve` re-checks inside its own conditional
   * statement rather than trusting this, which is why the two are separate
   * calls rather than one.
   */
  available: number;
  /** When true, `available <= 0` does not refuse a reservation. */
  backorderable: boolean;
  /**
   * The RESOLVED bulk ladder for this variant's product (migration 0600).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ON THE QUOTE, AND NOT FETCHED BY CART, BECAUSE OF CONTRACT §5.
   *
   * Cart reaches Catalog only through this injected port and never imports it,
   * which is what lets both be built and tested independently. `resolveTiers`
   * lives under `server/shop/catalog/`, so Cart calling it directly would be
   * exactly the dependency the port exists to prevent.
   *
   * WHAT IT COSTS, HONESTLY: one extra statement per quoted line, because
   * `resolveTiersFor` is its own query rather than a join. It is not free.
   *
   * A join onto the quote row would be free and is WRONG: the tiers are one-to-
   * many, so joining them multiplies the variant row by the number of rungs and
   * `res.rows[0]` becomes a coin toss over which rung's copy won. The honest
   * alternatives are a batched resolve across the whole basket — which the port
   * cannot express, since `quote` is per variant — or this. Cart baskets are
   * small and both callers already fan out with `Promise.all`, so the added
   * latency is one round trip, not N.
   *
   * ALREADY RESOLVED — `bulkDiscountEnabled` and the store-wide default are both
   * applied before it gets here, so an EMPTY ARRAY means "no bulk discount on
   * this product" and the totals engine needs no second rule. Ascending by
   * `minQty`.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  bulkTiers: BulkTier[];
}

export interface ReservationRequest {
  /**
   * CALLER-SUPPLIED, AND THE IDEMPOTENCY KEY (brief §5). Reserving twice with
   * the same id holds stock once — enforced by a unique row inside Catalog, not
   * by a JS check on a prior read, because a check on a stale read is exactly
   * what GAUNTLET II Part 2b measured as having zero effect across 254 tests.
   */
  reservationId: string;
  variantId: string;
  /** A positive integer. Anything else is `{ ok: false, reason: 'invalid_qty' }`. */
  qty: number;
  /**
   * epoch-ms. Recorded by Catalog and acted on by NOTHING in Catalog: Cart owns
   * the expiry policy and sweeps expired holds through `release` (brief §5). The
   * count is Catalog's, the clock is Cart's.
   */
  expiresAt: number;
}

/**
 * INSUFFICIENT STOCK IS A RETURN VALUE, NOT AN EXCEPTION (brief §5).
 *
 * A shopper adding the last two of an item to their basket is the most ordinary
 * event a shop has. Thrown, it is indistinguishable at every layer above from a
 * database being down — same `catch`, same 500, same five client retries for a
 * request whose answer will never change — and the one thing the customer has to
 * be told, HOW MANY ARE ACTUALLY LEFT, is the thing an exception has nowhere to
 * put.
 */
export type ReservationResult =
  | {
      ok: true;
      reservationId: string;
      variantId: string;
      qty: number;
      /** Availability AFTER this hold. */
      available: number;
      /**
       * True when the call found the hold already recorded and changed nothing.
       * The caller succeeded either way; this exists so a retry is visible in a
       * log rather than looking like a second sale.
       */
      replayed: boolean;
    }
  | {
      ok: false;
      /**
       * - `insufficient` — the stock is not there. `available` says how much is.
       * - `unknown_variant` — no inventory row: the variant does not exist, or
       *   was deleted between the quote and the reservation.
       * - `not_sellable` — it exists but may not be sold right now: the product
       *   is draft, archived or trashed, or the variant is discontinued.
       * - `invalid_qty` — non-positive or non-integer. A return value rather
       *   than a throw so a malformed cart line cannot become a 500.
       */
      reason: 'insufficient' | 'unknown_variant' | 'not_sellable' | 'invalid_qty';
      available: number;
    };

/**
 * Implemented by Catalog in `server/shop/catalog/port.ts`. Consumed by Cart, and
 * by Payments for the capture-time commit.
 *
 * Consumed BY INJECTION, never by importing the implementation (contract §5), so
 * every consumer can be tested against
 * `server/shop/catalog/test/fake-catalog-port.ts` and no consumer is ever
 * blocked on Catalog's code landing.
 */
export interface CatalogPort<Db> {
  /** Priced, sellable snapshot of a variant at this instant, or null. */
  quote(db: Db, variantId: string): Promise<VariantQuote | null>;
  /** Atomically hold `qty` of `variantId` until `expiresAt`. */
  reserve(db: Db, req: ReservationRequest): Promise<ReservationResult>;
  /** Idempotent by reservationId, and safe after expiry. */
  release(db: Db, reservationId: string): Promise<void>;
  /** Reservation → permanent decrement. Idempotent. Called on payment capture. */
  commitReservation(db: Db, reservationId: string): Promise<void>;
}
