/**
 * `commerce_events` — the outbox, typed (contract §6).
 *
 * SHARED AND APPEND-ONLY. Four subsystems write into this file; each appends
 * its own payload types and its own arm of `CommerceEventPayloads` and edits
 * nobody else's. The scaffolding above the blocks — `CommerceEventType`, the
 * envelope, the payload map, `commerceEvent()` — was created by **Payments**
 * because the file did not exist when the first agent needed it. It is not
 * Payments' to own; treat it as shared and do not duplicate it further down.
 *
 * WHY A CENTRAL UNION AND NOT A TYPE PER SUBSYSTEM. Contract §6 rule 4: a
 * consumer that meets an unknown `type` logs and ignores it, never throws. That
 * is what lets Payments ship `payment.captured` before Orders has heard of it —
 * the entire reason these four are built in parallel. A consumer can only make
 * that promise if "the set of types" is one enumerable thing rather than four
 * files it would have to import (and thereby couple to, against §2 R2).
 *
 * PAYLOADS ARE SELF-SUFFICIENT ON PURPOSE. A consumer reacting to
 * `payment.captured` must not have to call back into Payments to learn the
 * amount — that is a synchronous cross-subsystem call wearing an event's
 * clothes, and it reintroduces exactly the coupling §2 R4 removes. Every field
 * a reasonable consumer needs rides in the payload.
 */

/**
 * The fixed list from contract §6. Fixed THERE, in advance, so all four agents
 * could code against it before any of them had shipped.
 */
export const COMMERCE_EVENT_TYPES = [
  'catalog.variant.published',
  'catalog.variant.unpublished',
  'catalog.inventory.adjusted',
  'checkout.completed',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'payment.refunded',
  'order.created',
  'order.fulfilled',
  'order.cancelled',
] as const;

export type CommerceEventType = (typeof COMMERCE_EVENT_TYPES)[number];

/**
 * A type this build knows about, or `null`.
 *
 * The narrowing half of §6 rule 4. A consumer calls this on the string it read
 * out of the row; `null` is the "log and ignore" branch, and it is a branch
 * rather than a throw because a Payments deploy that starts emitting a type an
 * older Orders deploy has never seen must not turn that consumer into a crash
 * loop against a table it cannot drain.
 */
export function asCommerceEventType(value: string): CommerceEventType | null {
  return (COMMERCE_EVENT_TYPES as readonly string[]).includes(value)
    ? (value as CommerceEventType)
    : null;
}

import type { Money } from './money';

// ---------------------------------------------------------------- money shape
/**
 * Contract §10's `Money`, spelled out as two fields rather than imported.
 *
 * `shared/commerce/money.ts` is the Catalog agent's to write and did not exist
 * when this file was created. Rather than create it — which would take a file
 * this subsystem does not own — every amount here is an `(amount, currency)`
 * pair, which is what §10 says a `Money` *is* and what the payment tables store
 * as two columns anyway. When `money.ts` lands, `Money` will be structurally
 * assignable to these fields and nothing here has to change.
 *
 * `amount` is an INTEGER IN MINOR UNITS. Negative means credit (§10).
 */
interface AmountFields {
  amount: number;
  currency: string;
}

// ============================================================================
// PAYMENTS — owned by the Payments subsystem (`03-payments.md`).
// ============================================================================

/**
 * Common to all four `payment.*` events.
 *
 * `checkoutId` rides in every one of them because Orders keys on it: the
 * payment intent is not the aggregate Orders cares about, the checkout is, and
 * an event that forced Orders to resolve one from the other through Payments
 * would be the call §2 R4 forbids.
 */
interface PaymentEventBase extends AmountFields {
  intentId: string;
  checkoutId: string;
  /** Epoch-ms, from the same clock reading as the state change. */
  occurredAt: number;
}

/**
 * The provider has a hold on the funds but has not taken them.
 *
 * EMITTED BY NO PROVIDER TODAY, and that is deliberate rather than dead code.
 * Paystack — the provider chosen for this build — has no authorize/capture
 * split: a card transaction succeeds or it does not, so its adapter goes
 * straight to `payment.captured`. The state and its event exist because the
 * intent's status ladder models both shapes, and a provider added later that
 * *does* authorize separately must not require Orders to learn a new event
 * type before it can be wired up.
 */
export type PaymentAuthorizedPayload = PaymentEventBase;

/** The money has been taken. This is the one Orders acts on. */
export type PaymentCapturedPayload = PaymentEventBase;

export interface PaymentFailedPayload extends PaymentEventBase {
  /**
   * A STABLE, ENUMERABLE REASON — never the provider's prose.
   *
   * A provider's `gateway_response` is free text that changes without notice
   * and, worse, can quote the input that caused it. A consumer switching on it
   * is a consumer that breaks on a copy edit, and a log holding it is one
   * string away from holding something that should never have been written
   * down (`03-payments.md` §8).
   */
  reason: PaymentFailureReason;
}

export type PaymentFailureReason =
  | 'declined'
  | 'abandoned'
  | 'expired'
  | 'reversed'
  | 'provider_error'
  | 'unknown';

export interface PaymentRefundedPayload extends PaymentEventBase {
  refundId: string;
  /** This refund alone, minor units, positive. */
  refundedAmount: number;
  /** Every succeeded refund against the intent, including this one. */
  refundedTotal: number;
  /**
   * `amount - refundedTotal`. Carried rather than left to the consumer to
   * subtract, because §7 names it and because a consumer that derives it is a
   * consumer that can derive it differently.
   */
  remainingBalance: number;
}

// ============================================================================
// CATALOG / CART / ORDERS — append your block below this line.
// Add your arms to `CommerceEventPayloads` in the same commit.
// ============================================================================

// ============================================================================
// CATALOG — owned by the Catalog subsystem (`01-catalog.md`).
// ============================================================================

/**
 * A variant became sellable — `publishProduct` took its product to `active`.
 *
 * ONE EVENT PER VARIANT, NOT ONE PER PRODUCT, and the contract's fixed type list
 * says so by naming `catalog.variant.published` rather than
 * `catalog.product.published`. The variant is the sellable unit (brief §2); a
 * consumer that indexes a search catalogue, warms a price cache or notifies a
 * back-in-stock list is acting on something with a SKU and a price, and a
 * product-level event would make every one of them fan out through Catalog to
 * find out which variants it meant — a synchronous cross-subsystem call wearing
 * an event's clothes (§2 R4).
 *
 * `price` RIDES ALONG rather than being looked up. An event carrying only
 * identifiers forces its consumer to read whatever is true *now*, which differs
 * from what was true when the event was written exactly when it matters — during
 * a price change. Null only when the variant went active with no current price
 * row; `publishProduct` refuses that, but a backfill can leave it.
 */
export interface CatalogVariantPublishedPayload {
  variantId: string;
  productId: string;
  sku: string;
  price: Money | null;
}

/** The inverse. No price: nothing downstream may quote it. */
export interface CatalogVariantUnpublishedPayload {
  variantId: string;
  productId: string;
  sku: string;
  reason: CatalogUnpublishReason;
}

/**
 * Why it stopped being sellable. Enumerable rather than prose, for the same
 * reason `PaymentFailureReason` is: a consumer switching on free text breaks on
 * a copy edit.
 */
export type CatalogUnpublishReason =
  | 'unpublished'
  | 'archived'
  | 'discontinued'
  | 'deleted';

/**
 * On-hand stock moved by an ADMIN, deliberately, with a stated reason.
 *
 * NOT EMITTED BY `reserve`/`release`/`commitReservation`, and that omission is
 * the design. Those are the ordinary traffic of selling — one per add-to-cart,
 * one per abandoned-cart sweep, one per capture — and an outbox row per cart
 * interaction is a table nobody can read at 2am to find the one event that
 * matters. What this records is the thing you cannot reconstruct from anywhere
 * else: a human changed the count, and here is why (brief §6).
 *
 * `onHand` is the value AFTER the adjustment, so a consumer never has to re-read
 * — and so the log line still means something when it is read a month later
 * against a count that has moved since.
 */
export interface CatalogInventoryAdjustedPayload {
  variantId: string;
  /** Signed. Negative is a write-off, positive is a restock. Never zero. */
  delta: number;
  onHand: number;
  reason: string;
  /** `users.id` of the admin who did it. */
  actorId: string;
}

// ============================================================================
// CART + CHECKOUT — owned by the Cart subsystem (`02-cart-checkout.md`).
// ============================================================================

/**
 * A postal address, snapshotted at the moment of checkout.
 *
 * A COPY, NOT A REFERENCE. `shop_addresses` is Cart's table (contract §4) and
 * R3 forbids Orders from reading it, so an event carrying only an address id
 * would force Orders to call back into Cart — the coupling §2 R4 exists to
 * remove. It is also simply correct: an order ships to where the customer said
 * at the time, and a later edit to a saved address must not silently retarget a
 * parcel that has already left.
 */
export interface AddressSnapshot {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  /** ISO-3166-1 alpha-2, uppercase. The shipping zone is derived from it. */
  countryCode: string;
  phone: string | null;
}

/**
 * One purchased line, as the PRODUCT rather than as arithmetic.
 *
 * Joined to `totals.lines` on `variantId`. The split is deliberate: the totals
 * breakdown is the evidence for the charge and is produced by a pure function
 * that must not need a title to do its job, while this is what an order line and
 * a packing slip are made of. `sku` and `title` are copied because Catalog may
 * rename or discontinue the variant tomorrow and an order is a record of what
 * was actually sold.
 */
export interface CheckoutCompletedLine {
  variantId: string;
  productId: string;
  sku: string;
  title: string;
  optionValues: Record<string, string>;
  qty: number;
  /** The frozen unit price. Repeated from `totals.lines` so a consumer building
   * an order line never has to correlate two arrays to get a price. */
  unit: AmountFields;
  /**
   * `unit` AND `lineTotal` UNDER THE NAMES ORDERS ACTUALLY READS (admin#27).
   *
   * Both are copies of frozen values, never a recomputation: `unitAmount` is
   * `unit`, and `lineTotal` is `totals.lines[].lineTotal` — the figure the
   * totals engine produced at freeze time and the customer was charged.
   *
   * THEY ARE HERE BECAUSE THE TWO HALVES OF THIS CONTRACT DISAGREED IN
   * PRODUCTION AND NOTHING COULD SEE IT. `checkout.completed` had never been
   * emitted for any cart, so Orders' `parseCheckoutCompleted` — which requires
   * `unitAmount` and `lineTotal` on every line and parks the event naming the
   * missing field otherwise — had never met a real one. Emitting the event
   * without these would have replaced "no order is created" with "the event
   * parks at `lines.0.unitAmount` twenty times and is abandoned", which is a
   * worse bug because it looks like progress.
   *
   * `shared/commerce/events.test.ts` now drives Cart's real payload through
   * Orders' real parser, so the two cannot disagree silently again.
   */
  unitAmount: AmountFields;
  lineTotal: AmountFields;
  /** Nullable, matching `VariantQuote`: NULL is honest for a variant nobody has
   * weighed, and a shipping estimator has to be able to say so. */
  weightGrams: number | null;
}

/**
 * The checkout is paid for and the order may be built. **Self-sufficient.**
 *
 * BRIEF §7 IS BINDING ON THIS PAYLOAD: "This event is what Orders builds an
 * order from, so it must be self-sufficient: Orders must never need to call back
 * into Cart to construct an order. If Orders needs a field, it goes in this
 * payload." Everything below is here for that reason, and the test
 * `checkout-completed.test.ts` asserts the payload is sufficient by building a
 * complete order shape from it with no database access at all.
 *
 * `reservationIds` rides along for a reason worth stating: whoever commits the
 * stock on capture needs to know WHICH holds belong to this checkout, and the
 * only alternative is a query into `shop_reservations`, which is Cart's table
 * under R3. See AMENDMENTS A-007 for who is supposed to make that call — the
 * contract names an event but no consumer.
 */
export interface CheckoutCompletedPayload {
  /** The cart id. Checkout is a state machine over the cart, not a second
   * aggregate — `CheckoutPort.totals(db, checkoutId)` takes this same value. */
  checkoutId: string;
  customerId: string | null;
  /** Where the receipt goes. Null only if the shop allows a checkout with no
   * contact at all, which this one does not — but the type admits it so that a
   * consumer never assumes rather than checks. */
  email: string | null;
  currency: string;
  /** The FROZEN totals, including the itemised breakdown that justifies them.
   * Structurally `FrozenTotals` from `./ports`; spelled through `AmountFields`
   * so this file stays free of a cross-import that would couple the two blocks. */
  totals: FrozenTotalsShape;
  lines: CheckoutCompletedLine[];
  shippingAddress: AddressSnapshot | null;
  billingAddress: AddressSnapshot | null;
  /** The holds taken at checkout start, so they can be committed on capture. */
  reservationIds: string[];
  /** Epoch-ms, from the same clock reading as the state change that caused it. */
  occurredAt: number;
}

/**
 * `FrozenTotals` as this file needs to see it.
 *
 * Structurally identical to `./ports`' `FrozenTotals`; declared rather than
 * imported so the events file has no dependency on the ports file and each block
 * stays independently editable. `shared/commerce/ports.test.ts` pins the two
 * together, so a change to one that is not made to the other fails a test rather
 * than drifting.
 */
export interface FrozenTotalsShape {
  currency: string;
  lines: Array<{
    variantId: string;
    qty: number;
    unit: AmountFields;
    lineTotal: AmountFields;
    taxable: boolean;
    taxAmount: AmountFields;
  }>;
  shipping: { id: string; label: string; amount: AmountFields; taxable: boolean } | null;
  tax: { zone: string; label: string; rateBps: number };
  adjustments: Array<{ code: string; label: string; amount: AmountFields }>;
  subtotal: AmountFields;
  adjustmentTotal: AmountFields;
  shippingTotal: AmountFields;
  taxTotal: AmountFields;
  grandTotal: AmountFields;
  rounding: string;
}

// ============================================================================
// ORDERS + FULFILLMENT — owned by the Orders subsystem (`04-orders-fulfillment.md`).
// ============================================================================

/**
 * One line of an order, as it appears in an `order.*` payload.
 *
 * IT CARRIES THE SNAPSHOT, NOT A POINTER TO THE CATALOG. `variantId` is here so a
 * consumer can act on stock, and `sku`/`qty` are here so it can act *correctly* a
 * week later: brief §2's rule is that everything on an order line is a snapshot,
 * and an event that named only `variantId` would push every consumer into reading
 * whatever Catalog says now — which differs from what the customer bought exactly
 * when somebody has renamed or repriced the product.
 */
export interface OrderLineRef {
  orderLineId: string;
  variantId: string;
  sku: string;
  /** The quantity this event is about. Always positive. */
  qty: number;
}

/**
 * An order became real: the money arrived and the order is `paid`.
 *
 * EMITTED ON `payment.captured`, NOT ON `checkout.completed` (brief §4's table).
 * The row is inserted when the checkout completes, but it is `pending` then — an
 * unpaid order is not a thing any consumer should act on, and a `created` event at
 * insert time would have every downstream reader guessing whether it had been paid
 * for.
 *
 * `total` is the FROZEN grand total, copied from `checkout.completed` and never
 * recomputed anywhere in this subsystem.
 */
export interface OrderCreatedPayload {
  orderId: string;
  /** Customer-facing (brief §3), e.g. `2026-000042-K`. */
  orderNumber: string;
  /** The checkout this order came from — the key every `payment.*` event carries. */
  checkoutId: string;
  /** NULL for a guest order, which is the default path (contract §7). */
  customerId: string | null;
  email: string;
  total: Money;
  lines: OrderLineRef[];
  placedAt: number;
  paidAt: number;
}

/**
 * Every line of the order is now covered by a shipped fulfilment.
 *
 * ONE EVENT PER ORDER, NOT PER FULFILMENT. Partial fulfilment is real (brief §2),
 * so an order can ship in three parcels — but "this order is done" happens once,
 * and it is what a consumer wants to hear. `fulfillmentId` names the shipment that
 * completed it, for traceability.
 */
export interface OrderFulfilledPayload {
  orderId: string;
  orderNumber: string;
  /** The fulfilment whose shipment completed the order. */
  fulfillmentId: string;
  carrier: string | null;
  trackingNumber: string | null;
  lines: OrderLineRef[];
  fulfilledAt: number;
}

/**
 * The order will not ship. Status, never a delete (brief §2).
 *
 * `lines` IS THE POINT OF THIS PAYLOAD, not decoration. Brief §4 requires a
 * `payment.failed` to cancel the order *and release its reservations*, and
 * releasing a reservation is Catalog's `release`, reached through Cart — which
 * contract §2 R4 says is caused by an event and never by a call. A consumer can
 * only do that if the event says which variants and how many, so it does.
 */
export interface OrderCancelledPayload {
  orderId: string;
  orderNumber: string;
  checkoutId: string;
  /**
   * Enumerable rather than prose, for the same reason `PaymentFailureReason` is:
   * a consumer switching on free text breaks on a copy edit.
   *
   * - `payment_failed` — reacted to `payment.failed`; nobody chose this.
   * - `admin` — a human with owner rights cancelled it.
   */
  reason: OrderCancelReason;
  /** `users.id` of the admin, or null when the cause was an event. */
  actorId: string | null;
  lines: OrderLineRef[];
  cancelledAt: number;
}

export type OrderCancelReason = 'payment_failed' | 'admin';

/**
 * `type` → payload. The map every consumer narrows through.
 *
 * An arm typed `never` is a type this build knows the NAME of (it is in
 * contract §6's fixed list) but whose payload its owning subsystem has not
 * declared yet. That is the honest state during a parallel build and it is
 * deliberately not `unknown`: `never` makes any attempt to *construct* one a
 * compile error, so nobody can emit a `catalog.*` event out of Payments by
 * accident, while a consumer can still read the row and ignore it.
 */
export interface CommerceEventPayloads {
  'payment.authorized': PaymentAuthorizedPayload;
  'payment.captured': PaymentCapturedPayload;
  'payment.failed': PaymentFailedPayload;
  'payment.refunded': PaymentRefundedPayload;

  // Owned by Catalog:
  'catalog.variant.published': CatalogVariantPublishedPayload;
  'catalog.variant.unpublished': CatalogVariantUnpublishedPayload;
  'catalog.inventory.adjusted': CatalogInventoryAdjustedPayload;
  // Owned by Cart:
  'checkout.completed': CheckoutCompletedPayload;
  // Owned by Orders:
  'order.created': OrderCreatedPayload;
  'order.fulfilled': OrderFulfilledPayload;
  'order.cancelled': OrderCancelledPayload;
}

/**
 * A row of `commerce_events`, as a consumer reads it (contract §6).
 *
 * `processedAt`/`attempts`/`lastError` are CONSUMER bookkeeping and are not the
 * producer's to set: §6 rule 3 says a failed consumer marks `lastError` and
 * leaves `processedAt` NULL, so a producer that wrote either would be
 * pre-answering a question only the consumer can answer.
 */
export interface CommerceEvent<T extends CommerceEventType = CommerceEventType> {
  id: string;
  type: T;
  subjectId: string;
  payload: CommerceEventPayloads[T];
  occurredAt: number;
  processedAt: number | null;
  attempts: number;
  lastError: string | null;
}

/**
 * A well-typed event ready for insertion — id and bookkeeping excluded, because
 * the id is minted at the insert and the bookkeeping belongs to the consumer.
 */
export interface NewCommerceEvent<T extends CommerceEventType = CommerceEventType> {
  type: T;
  subjectId: string;
  payload: CommerceEventPayloads[T];
  occurredAt: number;
}

/**
 * Build one, with the payload checked against the type.
 *
 * Exists so `{ type: 'payment.captured', payload: <a refund payload> }` is a
 * compile error at the emit site rather than a shape Orders discovers at 3am.
 */
export function commerceEvent<T extends CommerceEventType>(
  type: T,
  subjectId: string,
  payload: CommerceEventPayloads[T],
  occurredAt: number,
): NewCommerceEvent<T> {
  return { type, subjectId, payload, occurredAt };
}
