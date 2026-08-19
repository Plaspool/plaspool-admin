/**
 * The ports — the only way one commerce subsystem reaches another (contract §5).
 *
 * SHARED AND APPEND-ONLY. Each agent appends its own port interface and edits
 * nobody else's. This file was created by **Payments** because it did not exist
 * yet; Catalog's `CatalogPort` and Cart's `CheckoutPort` belong below the
 * marker at the bottom and are theirs to write.
 *
 * A PORT IS A TYPE, NOT AN IMPORT PATH. The implementation lives in
 * `server/shop/<owner>/port.ts` and reaches its consumer by injection. Nothing
 * here may import a `server/` module: `shared/` is compiled into the browser
 * bundle as well as the server, and a port that dragged a repo module with it
 * would take Drizzle and the Neon driver into the client.
 *
 * `Db` is therefore a TYPE PARAMETER rather than an import of
 * `server/db/client`. Contract §5 writes the signatures as `quote(db: Db, …)`,
 * and that is what they are — but naming the concrete type here is what would
 * make this file server-only.
 */

// ============================================================================
// PAYMENTS — owned by the Payments subsystem (`03-payments.md`).
// ============================================================================

/**
 * The intent's lifecycle, and the order it may move in.
 *
 * MONOTONIC BY RANK, and that is load-bearing rather than descriptive. Webhooks
 * arrive out of order — `charge.success` can land before the event that was
 * supposed to precede it — so the status is derived from the HIGHEST-WATER
 * event seen rather than from a transition table that requires the previous
 * state to have been observed (`03-payments.md` §4). `paymentStatusRank()`
 * below is the JS half of that ordering; `shop_payment_status_rank()` in
 * migration 0140 is the SQL half, and the two are pinned to each other by test.
 */
export type PaymentStatus =
  | 'requires_payment'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'requires_payment',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
];

/**
 * How far along the ladder a status is. Higher wins.
 *
 * `failed` and `cancelled` SHARE RANK 1 WITH EACH OTHER AND SIT BELOW
 * `authorized` ON PURPOSE. Both are terminal only in the sense that we stopped
 * expecting money; neither is terminal in the sense that money cannot still
 * arrive. Paystack lets a customer retry a failed attempt on the same
 * reference, and a customer can pay a checkout we locally gave up on — so
 * `failed → captured` is a real transition and the ladder has to admit it. The
 * anomaly it represents is RECORDED (`shop_payment_events.anomaly`) rather than
 * refused, because refusing it would mean holding money we deny having.
 */
export function paymentStatusRank(status: PaymentStatus): number {
  switch (status) {
    case 'requires_payment':
      return 0;
    case 'cancelled':
    case 'failed':
      return 1;
    case 'authorized':
      return 2;
    case 'captured':
      return 3;
    case 'partially_refunded':
      return 4;
    case 'refunded':
      return 5;
  }
}

/**
 * What Orders may know about a payment. READ-ONLY, and deliberately thin.
 *
 * Note what contract §5 does NOT declare and this does not add: Payments has no
 * port into Orders, and Orders has no port into Payments for state changes. A
 * capture does not call `createOrder`; it appends `payment.captured` to the
 * outbox and Orders reacts (§6). This interface exists so an order page can
 * render "paid" without a second system of record, and for nothing else.
 */
export interface PaymentSnapshot {
  intentId: string;
  checkoutId: string;
  status: PaymentStatus;
  /** Minor units, frozen at creation, never recomputed (`03-payments.md` §1). */
  amount: number;
  currency: string;
  /** Sum of refunds that have not failed. `0` when none. */
  refundedTotal: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Implemented by Payments in `server/shop/payments/port.ts`. Consumed by Orders.
 */
export interface PaymentPort<Db> {
  /** `null` when no intent by that id exists. */
  status(db: Db, intentId: string): Promise<PaymentSnapshot | null>;
}

// ============================================================================
// CATALOG / CART — append your port interfaces below this line.
//
// `CatalogPort` (Catalog) and `CheckoutPort` (Cart) are declared in contract §5
// and belong here, written by their owners. Payments consumes `CheckoutPort`
// and, until it lands, depends on the narrowest structural subset it needs —
// see `server/shop/payments/ports.ts`, which carries a drift guard that fails
// the moment a real `CheckoutPort` appears in this file.
// ============================================================================

// ============================================================================
// CART — owned by the Cart + Checkout subsystem (`02-cart-checkout.md`).
// ============================================================================

import type { Money, RoundingMode } from './money';

/**
 * One cart line's contribution to the total, and the arithmetic that produced it.
 *
 * MONEY FACTS ONLY — no title, no SKU, no image. This is the output of a PURE
 * function whose whole point is that every input is passed in (brief §5); a
 * field the arithmetic does not use would be a field the totals engine has to
 * be handed and cannot check. The product snapshot Orders needs travels
 * separately, in `CheckoutCompletedLine`, joined on `variantId`.
 */
export interface TotalsLine {
  variantId: string;
  qty: number;
  /** The LIVE price at the moment of freezing. Never read from a cart line —
   * a cart stores no prices (brief §3). */
  unit: Money;
  /** `unit × qty`, exact: both are integers, so no rounding happens here. */
  lineTotal: Money;
  /** Whether this line was taxed at all. False makes `taxAmount` zero. */
  taxable: boolean;
  /** Rounded ONCE, on this line, before any summing (brief §5). */
  taxAmount: Money;
}

/** A chosen delivery method and what it costs. Priced by Cart, not by Catalog. */
export interface ShippingQuote {
  id: string;
  label: string;
  amount: Money;
  /** Most jurisdictions tax delivery; some do not. Explicit rather than assumed. */
  taxable: boolean;
}

/**
 * A flat rate per shipping zone (contract §13 — tax as a provider integration is
 * explicitly out of scope for v1).
 *
 * `rateBps` is BASIS POINTS, an integer: `725` is 7.25%. A decimal rate would be
 * a float, and `shared/commerce/money.ts` exists to keep floats out of money.
 * The seam is a plain input so that swapping a provider in later is an
 * implementation change and not a rewrite (brief §5).
 */
export interface TaxRate {
  zone: string;
  label: string;
  rateBps: number;
}

/**
 * The documented extension point (contract §13). EMPTY IN V1.
 *
 * Discounts, coupons and gift cards are out of scope; this exists so that adding
 * one later does not change `FrozenTotals`, and so that the shape of "something
 * that moves the total and must appear on the invoice" is fixed now rather than
 * invented under pressure. Negative `amount` is a discount.
 */
export interface Adjustment {
  code: string;
  label: string;
  amount: Money;
}

/**
 * The frozen, authoritative totals for a checkout. **Never recomputed** (§5).
 *
 * IT CARRIES ITS OWN DERIVATION, and that is not decoration. `subtotal`,
 * `taxTotal` and `grandTotal` are three numbers a customer can dispute; `lines`,
 * `shipping`, `tax`, `adjustments` and `rounding` are the evidence that answers
 * the dispute, and they are stored together so the answer cannot drift from the
 * charge. A totals object that carried only the four sums would make "why is it
 * £41.98?" unanswerable the moment a price changed.
 *
 * `rounding` names the mode used at every step, so a total can be reproduced
 * exactly years later even if the default changes.
 */
export interface FrozenTotals {
  currency: string;
  lines: TotalsLine[];
  shipping: ShippingQuote | null;
  tax: TaxRate;
  adjustments: Adjustment[];
  /** Σ lineTotal. */
  subtotal: Money;
  /** Σ adjustment amounts. Negative for a discount. Zero in v1. */
  adjustmentTotal: Money;
  /** The shipping amount, or zero when nothing is chosen yet. */
  shippingTotal: Money;
  /** Σ per-line tax + shipping tax. Rounded per line, THEN summed. */
  taxTotal: Money;
  /** subtotal + adjustmentTotal + shippingTotal + taxTotal. */
  grandTotal: Money;
  rounding: RoundingMode;
}

/**
 * Implemented by Cart in `server/shop/cart/port.ts`. Consumed by Payments.
 *
 * `checkoutId` IS THE CART ID (`crt_…`). Checkout is a state machine over the
 * cart (brief §5), not a second aggregate with its own identity, so inventing a
 * separate id would create a mapping table whose only job is to be got wrong.
 *
 * READS STORAGE; NEVER RECOMPUTES. Contract §5 and brief §5 both make this the
 * defining property: Payments charges this number and Orders snapshots it, so a
 * `totals()` that re-ran the engine at capture time is a system that can charge
 * a number the customer never saw — a price change or a tax-table edit between
 * freeze and capture is all it would take.
 *
 * Throws the shared `NotFoundError` (404 `gone`) when the checkout does not
 * exist or has not been frozen. Deliberately not a `null` return: the contract
 * fixes this signature as `Promise<FrozenTotals>`, and "no totals" is not a
 * value Payments could do anything useful with — it means the caller has a
 * checkout id that is wrong, which is a 404 and a permanent stop under spec §8's
 * retry policy rather than something to retry.
 */
export interface CheckoutPort<Db> {
  totals(db: Db, checkoutId: string): Promise<FrozenTotals>;

  /**
   * The checkout is paid: move it `converting → converted` and emit
   * `checkout.completed` (admin#27).
   *
   * WHY THIS IS ON THE PORT AT ALL. Brief §7 emits `checkout.completed` "when
   * the cart freezes AND payment is authorised", and Cart cannot learn the
   * second half — `completeCheckout` sat with no caller from the day it was
   * written, so `checkout.completed` had never been emitted for any cart and a
   * paid customer got no order. Payments knows the moment; Cart owns the
   * transition; contract R2 forbids Payments importing `server/shop/cart/`. A
   * port method is the only shape that satisfies all three.
   *
   * IT RETURNS A RESULT AND DOES NOT THROW FOR THE ORDINARY REFUSALS, which is
   * the whole reason it is not just `completeCheckout` re-exported. Paystack
   * redelivers `charge.success` and the webhook is retried, so the SECOND
   * capture for a cart is expected traffic, not an error — `completeCheckout`
   * answers it with `CartPreconditionError` because the cart is already
   * `converted`. Mapping that to a value here keeps the knowledge of Cart's
   * error classes inside Cart, where it belongs, and leaves Payments with a
   * total function it cannot mishandle by forgetting a `catch`.
   *
   * - `completed`         — this call performed the transition and wrote exactly
   *                         one `checkout.completed`.
   * - `already-completed` — somebody else already did (a duplicate delivery, or
   *                         the cart is not `converting`). Nothing was written.
   *                         **A success from the caller's point of view.**
   * - `unavailable`       — no such cart, or it was never frozen. Also not an
   *                         error to the caller: the payment still gets
   *                         recorded, and an operator reconciles.
   *
   * A genuine race (`CartStaleWriteError`) still throws. It is transient by
   * definition, and the caller's next drain — or the outbox sweep — retries.
   */
  complete(db: Db, checkoutId: string): Promise<CheckoutCompletion>;

  /**
   * Record the email the customer gave at the payment step, against the
   * checkout (admin#27).
   *
   * ═══ WHY THIS EXISTS, AND IT IS NOT A CONVENIENCE ═══
   * `shop_carts.email` is nullable and, before this, NOTHING IN THE APPLICATION
   * EVER WROTE IT. No cart route takes an email, `putAddresses` does not carry
   * one, and adoption by a signed-in customer does not copy one across — so
   * `checkout.completed` would have been emitted with `email: null` for every
   * checkout ever made, and Orders' parser requires it: `min(1)`, so a null
   * parks the event at `email`, twenty times, and then abandons it.
   *
   * That would have been admin#27 again in a new costume — a customer charged,
   * no order, a pipeline that looks wired — and no test could have seen it,
   * because Orders' fixtures supply an email and Cart's suites never emitted a
   * real event.
   *
   * THE PAYMENT STEP IS THE ONLY MOMENT THE EMAIL IS KNOWN. `POST
   * /api/shop/payments/intents` carries it (the provider needs it for the
   * receipt) and it is the sole place a guest ever types one. Payments cannot
   * write Cart's table — R2 — so it hands it back through the port, which is
   * precisely what a port is for.
   *
   * BEST EFFORT AND NEVER FATAL. It must not be able to fail an intent: a
   * checkout that cannot be paid for is strictly worse than one whose
   * confirmation email needs reconciling. Implementations return rather than
   * throw when the cart is gone or no longer accepting writes.
   */
  recordContact(db: Db, checkoutId: string, email: string): Promise<void>;
}

/** What `CheckoutPort.complete` answers. See the doc comment above. */
export type CheckoutCompletion = 'completed' | 'already-completed' | 'unavailable';

// ============================================================================
// CATALOG — owned by the Catalog subsystem (`01-catalog.md`).
// ============================================================================

/**
 * `draft` → not for sale. `active` → sellable. `archived` → withdrawn.
 *
 * NOT `published`, deliberately: a product's sellable state and a blog post's
 * public state are different words for different things, and reusing the word
 * would invite the two lifecycles to be merged later.
 *
 * The array is exported beside the union because `server/db/commerce-schema.ts`
 * builds its `check()` list from it. A check whose literals were retyped by hand
 * is a check that disagrees with its TypeScript union the first time either
 * changes, and the disagreement surfaces as a 23514 in production rather than as
 * a type error.
 */
export type ProductStatus = 'draft' | 'active' | 'archived';
export const PRODUCT_STATUSES: readonly ProductStatus[] = ['draft', 'active', 'archived'];

/** A variant is sellable or it is retired. There is no draft variant: the
 *  PRODUCT's status decides whether anything under it may be sold. */
export type VariantStatus = 'active' | 'discontinued';
export const VARIANT_STATUSES: readonly VariantStatus[] = ['active', 'discontinued'];

/**
 * The state of one stock hold, in Catalog's own ledger.
 *
 * `held` is counted in `shop_inventory.reserved`; the other two are terminal and
 * are not. Both `release` and `commitReservation` require `held`, which is what
 * makes the sweeper/capture race a no-op for whichever loses rather than a
 * double decrement (brief §5).
 */
export type HoldState = 'held' | 'released' | 'committed';
export const HOLD_STATES: readonly HoldState[] = ['held', 'released', 'committed'];

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
  /** Minor units plus an ISO-4217 code — contract §10's `Money`, structurally. */
  price: { amount: number; currency: string };
  /** Shipping needs it; NULL is honest for a variant nobody has weighed. */
  weightGrams: number | null;
  /**
   * `on_hand - reserved`, DERIVED (brief §5). A number to SHOW a shopper, never
   * a number to decide a sale on: between this read and a `reserve`, any
   * quantity of it can be taken. `reserve` re-checks in its own conditional
   * statement rather than trusting this, and that is the whole reason the two
   * are separate calls.
   */
  available: number;
  /** When true, `available <= 0` does not refuse a reservation. */
  backorderable: boolean;
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
   * epoch-ms. Recorded by Catalog and acted on by NOBODY there: Cart owns the
   * expiry policy and sweeps expired holds through `release` (brief §5). The
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
 * request whose answer will never change — and the one thing the customer needs
 * to be told, HOW MANY ARE ACTUALLY LEFT, is the thing an exception has nowhere
 * to put.
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
 * `Db` is a TYPE PARAMETER, following `PaymentPort` above and for the same
 * reason: naming `server/db/client`'s concrete type here would make this file
 * server-only, and `shared/` is compiled into the browser bundle too.
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

// ============================================================================
// CATALOG — owned by the Catalog subsystem (`01-catalog.md`).
//
// RE-EXPORTED FROM A FILE CATALOG OWNS EXCLUSIVELY, rather than declared here.
// Not a preference: this file was wholesale overwritten by successive agents
// rather than appended to, and Catalog's block was silently lost twice
// (amendment A-CAT-009). One `export *` line is a surface a clobber costs one
// line to restore and that `tsc` names immediately. A consumer whose re-export
// has been clobbered can import `shared/commerce/catalog-port` directly.
// ============================================================================
export * from './catalog-port';
