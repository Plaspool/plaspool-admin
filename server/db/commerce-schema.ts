/**
 * Commerce tables (contract §4). **SHARED AND APPEND-ONLY: each agent appends its
 * own block and edits no other block.**
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL, AND IT MUST NOT BECOME
 *     ONE. `drizzle.config.ts` declares `schema: './server/db/schema.ts'` and
 *     nothing else, so drizzle-kit has never seen this file. The tables below
 *     exist because a hand-written migration in the range contract §8 allocated
 *     created them; this file exists so a reader has one place to see the shape
 *     and so `$inferSelect` types are available to the repositories.
 *
 *     Adding this path to `drizzle.config.ts` would make the next `db:generate`
 *     emit `CREATE TABLE` for every commerce table that already exists. If it is
 *     ever done, it has to be done together with a baseline snapshot — see the
 *     warning at the top of `drizzle.config.ts` about the chain skipping 0001.
 *
 * Two rules carry over from `server/db/schema.ts` and are not optional:
 *
 * - **Timestamps are `bigint` epoch-milliseconds, never `timestamptz`.**
 * - **Every enum-ish column carries a `check()`,** because `.$type<>()` is
 *   compile-time only and buys nothing at runtime.
 *
 * Both are asserted against a migrated database, not against this file:
 * `server/shop/orders/schema.test.ts` reads them back out of `pg_catalog`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ============================================== THE OUTBOX (shared, contract §6)

/**
 * `commerce_events` — the single mechanism by which one subsystem causes work in
 * another (contract §2 R4, §6).
 *
 * DECLARED HERE BY WHICHEVER AGENT GOT HERE FIRST, and created `IF NOT EXISTS` by
 * every commerce migration that needs it. Contract §4 calls the table shared and
 * names no owning subsystem, while §8 gives each of the four agents a private
 * migration range — so the DDL has to be commutative or three of four migrations
 * fail. `server/shop/orders/schema.test.ts` reads the column set back out of the
 * catalog so that a divergent shape created first is loud rather than silent.
 */
export const commerceEvents = pgTable(
  'commerce_events',
  {
    /** ULID-ish, monotonic — `evt_…`. */
    id: text('id').primaryKey(),
    /** One of `shared/commerce/events.ts`'s eleven. An unknown one is ignored and logged. */
    type: text('type').notNull(),
    /** The aggregate this is about: a variant id, a checkout id, an intent id. */
    subjectId: text('subject_id').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
    /**
     * Consumer bookkeeping. NULL until a consumer has handled it.
     *
     * ONE COLUMN, SO IT CANNOT EXPRESS PER-CONSUMER PROGRESS. §6 rule 2 keys
     * idempotency on `(consumer, eventId)`, which anticipates more than one
     * consumer; this column cannot say "consumer A is done and B is not". Orders
     * therefore treats it as the shared, advisory signal and keeps its own
     * authority in `shop_order_event_consumptions`.
     */
    processedAt: bigint('processed_at', { mode: 'number' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('commerce_events_occurred_idx').on(t.occurredAt, t.id)],
);

// ================================================ ORDERS + FULFILLMENT (owner: Orders)

/**
 * `shop_orders` — brief `04` §2.
 *
 * THE TOTALS ARE FROZEN AND COPIED, NEVER DERIVED. They arrive on
 * `checkout.completed` and are written verbatim. Recomputing them anywhere in this
 * subsystem would mean the customer's receipt and the charge could disagree, and
 * the disagreement would appear exactly when a price changed between checkout and
 * order creation.
 *
 * `customerId` and `checkoutId` ARE NOT FOREIGN KEYS (contract §2 R3): they name
 * rows in Cart's tables, and an FK would let a Cart-side delete decide whether a
 * financial record may exist.
 */
export const shopOrders = pgTable(
  'shop_orders',
  {
    id: text('id').primaryKey(),
    /** Customer-facing (brief §3), `2026-000042-K`. Not `ord_01H…` on an invoice. */
    orderNumber: text('order_number').notNull(),
    /** NULL for a guest order, which is the default path (contract §7). */
    customerId: text('customer_id'),
    /** Always present, guest or not: it is where the confirmation goes. */
    email: text('email').notNull(),
    currency: text('currency').notNull(),
    subtotal: integer('subtotal').notNull(),
    shippingTotal: integer('shipping_total').notNull(),
    taxTotal: integer('tax_total').notNull(),
    grandTotal: integer('grand_total').notNull(),
    addOnTotal: integer('add_on_total').notNull().default(0),
    /**
     * Cumulative refunded minor units, accumulated from `payment.refunded`.
     *
     * Additive to brief §2's column list, and it has to be: §4 requires the
     * status to become `refunded` or `partially_refunded` "per amount", and the
     * amounts live in `shop_refunds` — Payments' table, which R3 forbids reading.
     * The only source available is the events actually received.
     */
    refundedTotal: integer('refunded_total').notNull().default(0),
    status: text('status')
      .$type<'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded' | 'partially_refunded'>()
      .notNull(),
    /** SNAPSHOT, not a reference (brief §2). */
    shippingAddress: jsonb('shipping_address').notNull(),
    /** SNAPSHOT, not a reference (brief §2). */
    billingAddress: jsonb('billing_address').notNull(),
    placedAt: bigint('placed_at', { mode: 'number' }).notNull(),
    paidAt: bigint('paid_at', { mode: 'number' }),
    fulfilledAt: bigint('fulfilled_at', { mode: 'number' }),
    cancelledAt: bigint('cancelled_at', { mode: 'number' }),
    /** The CAS token, as on `posts`. Monotonic per order. */
    revision: integer('revision').notNull(),
    /**
     * The LIFECYCLE CAS token, MAINTAINED BY A TRIGGER (brief §1).
     *
     * `revision` cannot answer the question a lifecycle retry has to ask, and
     * neither can a predicate over the current status: it cannot tell "never left
     * `paid`" from "was cancelled and put back to `paid`". A re-applied cancel
     * after an operator reinstated an order is a PAID ORDER THAT NEVER SHIPS; a
     * re-applied fulfil is a DOUBLE SHIPMENT.
     *
     * `shop_orders_lifecycle_generation` (hand-appended to migration 0160) bumps
     * it whenever `status`, `paid_at`, `fulfilled_at`, `cancelled_at` or
     * `refunded_total` changes. NOT a counter this repository increments —
     * GAUNTLET II Part 2b records that the application-maintained version failed
     * its own reproduction, because a hand-run `UPDATE` never goes through the
     * transition function, and reinstating a cancelled order is precisely that.
     */
    lifecycleGeneration: integer('lifecycle_generation').notNull().default(0),
    /** The `checkout.completed` that made this order. UNIQUE is the dedupe. */
    sourceEventId: text('source_event_id').notNull(),
    /** The checkout it was about. Also UNIQUE — see the migration's comment. */
    checkoutId: text('checkout_id').notNull(),
    /**
     * The payment intent, remembered from the first `payment.*` event seen, and existing
     * only so `PaymentPort.status(db, intentId)` can be called for display (brief `04`
     * header). Not an FK — `shop_payment_intents` is Payments' (R3) — and deliberately
     * outside the lifecycle trigger's watched set, because it is an identifier rather
     * than a state.
     */
    paymentIntentId: text('payment_intent_id'),
  },
  (t) => [
    uniqueIndex('shop_orders_order_number_uq').on(t.orderNumber),
    uniqueIndex('shop_orders_source_event_uq').on(t.sourceEventId),
    uniqueIndex('shop_orders_checkout_uq').on(t.checkoutId),
    check(
      'shop_orders_status_ck',
      sql`${t.status} IN ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded', 'partially_refunded')`,
    ),
    check('shop_orders_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('shop_orders_revision_ck', sql`${t.revision} > 0`),
    check('shop_orders_refunded_ck', sql`${t.refundedTotal} >= 0`),
    check('shop_orders_add_on_total_ck', sql`${t.addOnTotal} >= 0`),
    check('shop_orders_email_ck', sql`length(${t.email}) > 0`),
    index('shop_orders_customer_idx').on(t.customerId, t.placedAt.desc(), t.id),
    index('shop_orders_status_idx').on(t.status, t.placedAt.desc(), t.id),
  ],
);

/**
 * `shop_order_lines` — IMMUTABLE after insert, and `ON DELETE RESTRICT`.
 *
 * EVERY FIELD IS A SNAPSHOT: sku, title, options, unit price. A join to
 * `shop_variants` to render an order silently rewrites history the first time
 * somebody renames a product, and nothing errors.
 *
 * The immutability is a `BEFORE UPDATE OR DELETE` trigger, not a comment — see
 * migration 0160. `fulfilledQty` is the one column it lets through.
 */
export const shopOrderLines = pgTable(
  'shop_order_lines',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => shopOrders.id, { onDelete: 'restrict' }),
    /** Stable display order, and a stable handle for a fulfilment request. */
    lineNo: integer('line_no').notNull(),
    /** Not an FK: `shop_variants` is Catalog's (contract §2 R3). */
    variantId: text('variant_id').notNull(),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull(),
    qty: integer('qty').notNull(),
    unitAmount: integer('unit_amount').notNull(),
    lineTotal: integer('line_total').notNull(),
    /**
     * The variant's photograph AS IT WAS AT ORDER TIME (migration 0340).
     *
     * Not an FK, exactly like `variant_id` above and for the same reason plus
     * one of its own: `images` is the blog's table, and an image referenced only
     * from here must not become undeletable by constraint — `REFERENCE_SET` in
     * `server/repo/images.ts` is what decides that question.
     *
     * Nullable permanently: every order placed before 0340 has none, and a
     * variant with no photograph has nothing to snapshot.
     */
    imageId: text('image_id'),
    /**
     * The over-fulfilment bound, materialised so it can be DECLARATIVE.
     *
     * A `CHECK` cannot aggregate across rows, and a trigger running
     * `SELECT sum(qty)` cannot either: under READ COMMITTED two concurrent
     * inserts each read a set without the other's row, both pass, and the line
     * ships twice. Kept as a counter on this row instead, maintained by
     * `shop_fulfillment_lines_apply`, so the bound is a CHECK against `qty` on a
     * value taken under a row lock.
     */
    fulfilledQty: integer('fulfilled_qty').notNull().default(0),
  },
  (t) => [
    uniqueIndex('shop_order_lines_order_line_uq').on(t.orderId, t.lineNo),
    check('shop_order_lines_qty_ck', sql`${t.qty} > 0`),
    check('shop_order_lines_line_no_ck', sql`${t.lineNo} >= 0`),
    check(
      'shop_order_lines_fulfilled_ck',
      sql`${t.fulfilledQty} >= 0 AND ${t.fulfilledQty} <= ${t.qty}`,
    ),
    index('shop_order_lines_order_idx').on(t.orderId, t.lineNo),
  ],
);

/** The add-ons an order carried (migration 0940). A snapshot: no FK to shop_add_ons. */
export const shopOrderAddOns = pgTable(
  'shop_order_add_ons',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => shopOrders.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    addOnId: text('add_on_id').notNull(),
    title: text('title').notNull(),
    mode: text('mode').$type<'chosen' | 'included'>().notNull(),
    amount: integer('amount').notNull(),
    listPrice: integer('list_price').notNull(),
    currency: text('currency').notNull(),
  },
  (t) => [
    uniqueIndex('shop_order_add_ons_position_uq').on(t.orderId, t.position),
    index('shop_order_add_ons_add_on_idx').on(t.addOnId),
    check('shop_order_add_ons_mode_ck', sql`${t.mode} IN ('chosen','included')`),
    check('shop_order_add_ons_amount_ck', sql`${t.amount} >= 0 AND ${t.listPrice} >= 0`),
    check('shop_order_add_ons_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
export type DbShopOrderAddOn = typeof shopOrderAddOns.$inferSelect;

/** Partial fulfilment is real (brief §2): an order can have several. */
export const shopFulfillments = pgTable(
  'shop_fulfillments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => shopOrders.id, { onDelete: 'restrict' }),
    status: text('status').$type<'pending' | 'shipped' | 'delivered' | 'cancelled'>().notNull(),
    carrier: text('carrier'),
    trackingNumber: text('tracking_number'),
    shippedAt: bigint('shipped_at', { mode: 'number' }),
    deliveredAt: bigint('delivered_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    revision: integer('revision').notNull(),
    /** Its own trigger-maintained pin: a re-applied `ship` is a double shipment. */
    lifecycleGeneration: integer('lifecycle_generation').notNull().default(0),
    /* ── courier booking (migration 0960); all NULL for a parcel shipped by
     * hand. The unions mirror server/shop/orders/repo/fulfillments.ts's
     * CourierProvider/CourierState, inlined rather than imported so this
     * schema file takes no dependency on a repo module. ── */
    provider: text('provider').$type<'fez' | 'terminal'>(),
    providerRef: text('provider_ref'),
    providerStatus: text('provider_status'),
    courierState: text('courier_state').$type<
      | 'draft' | 'booked' | 'picked_up' | 'in_transit' | 'delivered'
      | 'returned' | 'cancelled' | 'failed' | 'unknown'
    >(),
    trackingUrl: text('tracking_url'),
    labelUrl: text('label_url'),
    providerCostMinor: bigint('provider_cost_minor', { mode: 'number' }),
    providerSyncedAt: bigint('provider_synced_at', { mode: 'number' }),
    providerLastError: text('provider_last_error'),
  },
  (t) => [
    check(
      'shop_fulfillments_status_ck',
      sql`${t.status} IN ('pending', 'shipped', 'delivered', 'cancelled')`,
    ),
    check('shop_fulfillments_revision_ck', sql`${t.revision} > 0`),
    check(
      'shop_fulfillments_provider_ck',
      sql`${t.provider} IS NULL OR ${t.provider} IN ('fez', 'terminal')`,
    ),
    check(
      'shop_fulfillments_courier_state_ck',
      sql`${t.courierState} IS NULL OR ${t.courierState} IN ('draft', 'booked', 'picked_up',
        'in_transit', 'delivered', 'returned', 'cancelled', 'failed', 'unknown')`,
    ),
    /* A waybill with no courier behind it names nothing anybody could track. */
    check(
      'shop_fulfillments_provider_ref_ck',
      sql`${t.provider} IS NOT NULL OR ${t.providerRef} IS NULL`,
    ),
    /* What a courier charged us cannot be negative. */
    check(
      'shop_fulfillments_provider_cost_ck',
      sql`${t.providerCostMinor} IS NULL OR ${t.providerCostMinor} >= 0`,
    ),
    index('shop_fulfillments_order_idx').on(t.orderId, t.createdAt),
    /**
     * PARTIAL UNIQUE, the same shape as `shop_refunds.provider_refund_id` and
     * for the same reason: a plain UNIQUE cannot hold the many rows sharing
     * "shipped by hand", and Postgres permits many NULLs. What it buys is that
     * an inbound webhook naming a waybill resolves to EXACTLY ONE parcel —
     * `server/shop/orders/repo/courier.ts` classifies its 23505 into a 409
     * rather than letting a retried booking answer 500.
     */
    uniqueIndex('shop_fulfillments_provider_ref_uq')
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} IS NOT NULL`),
    /**
     * The sweep's queue, and partial so it stays the size of the live bookings
     * rather than of the whole shipping history. `NULLS FIRST` is not the ASC
     * default and is load-bearing: a parcel booked but never yet polled must
     * sort ahead of one polled an hour ago, or a slice-per-pass sweep would
     * never reach it (`listCourierParcelsToSync`).
     */
    index('shop_fulfillments_courier_sync_idx')
      .on(t.providerSyncedAt.nullsFirst())
      .where(sql`${t.providerRef} IS NOT NULL AND ${t.status} IN ('pending', 'shipped')`),
  ],
);

export const shopFulfillmentLines = pgTable(
  'shop_fulfillment_lines',
  {
    id: text('id').primaryKey(),
    fulfillmentId: text('fulfillment_id')
      .notNull()
      .references(() => shopFulfillments.id, { onDelete: 'restrict' }),
    orderLineId: text('order_line_id')
      .notNull()
      .references(() => shopOrderLines.id, { onDelete: 'restrict' }),
    qty: integer('qty').notNull(),
  },
  (t) => [
    uniqueIndex('shop_fulfillment_lines_pair_uq').on(t.fulfillmentId, t.orderLineId),
    check('shop_fulfillment_lines_qty_ck', sql`${t.qty} > 0`),
    index('shop_fulfillment_lines_line_idx').on(t.orderLineId),
  ],
);

/**
 * Customer-visible history.
 *
 * `actorId` is TEXT WITH NO FOREIGN KEY to `users`, deliberately: contract §3
 * lists `users` as read-only and never modified, and an FK is a constraint added
 * to that table. It would also make an order's history unwritable the day an
 * account is removed.
 */
export const shopOrderEvents = pgTable(
  'shop_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => shopOrders.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
    actorId: text('actor_id'),
  },
  (t) => [
    check(
      'shop_order_events_type_ck',
      sql`${t.type} IN ('placed', 'payment_authorized', 'payment_failed', 'paid',
                        'fulfillment_created', 'shipped', 'delivered',
                        'fulfillment_cancelled', 'cancelled', 'refunded',
                        'refund_failed')`,
    ),
    index('shop_order_events_order_idx').on(t.orderId, t.occurredAt, t.id),
  ],
);

/**
 * The email outbox (brief §5).
 *
 * The intent is written in the SAME STATEMENT as the state change that caused it
 * and delivered later by a sweeper, because an order that is paid must not depend
 * on an email provider being up and a send failure must not roll back a capture
 * that genuinely happened.
 */
export const shopOrderEmailIntents = pgTable(
  'shop_order_email_intents',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => shopOrders.id, { onDelete: 'restrict' }),
    kind: text('kind')
      .$type<
        | 'placed'
        | 'confirmation'
        | 'shipment'
        | 'delivered'
        | 'cancellation'
        | 'refund'
        /** A refund the provider accepted failed to settle (migration 0380). */
        | 'refund_failed'
        /** Review lifecycle mail (migration 0640). */
        | 'review_invite'
        | 'review_approved'
      >()
      .notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    /** The plain-text part, and the RECORD of what a customer was told. */
    body: text('body').notNull(),
    /** The designed HTML part (migration 0320). Nullable because rows written
     * before it have none and are history, not a gap to backfill. */
    html: text('html'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    sentAt: bigint('sent_at', { mode: 'number' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** An operator gave up on this unsent intent (migration 0660). The sweeper
     * skips it and the backlog stops counting it; retry clears it. */
    dismissedAt: bigint('dismissed_at', { mode: 'number' }),
    /** "One confirmation per order" as a CONSTRAINT rather than as a convention. */
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('shop_order_email_intents_dedupe_uq').on(t.dedupeKey),
    check(
      'shop_order_email_intents_kind_ck',
      sql`${t.kind} IN ('placed', 'confirmation', 'shipment', 'delivered', 'cancellation',
                        'refund', 'refund_failed', 'review_invite', 'review_approved')`,
    ),
  ],
);

/**
 * A generated catalog CSV waiting to be downloaded (migration 0720). The file
 * is stored inline (a catalog is text, not media); the emailed link's whole
 * authority is the HMAC'd token; expiry is enforced at read time, seven days
 * from created_at, so nothing sweeps this table.
 */
export const productExports = pgTable(
  'product_exports',
  {
    id: text('id').primaryKey(),
    /** uuid WITH NO FK, the actor_id rule: contract §3 makes users read-only
     * from this side, and an FK is a constraint on a table commerce does not
     * own. */
    requestedBy: uuid('requested_by').notNull(),
    /** Snapshotted — "where did this file go" must not move with an edit. */
    requestedEmail: text('requested_email').notNull(),
    csv: text('csv').notNull(),
    rowCount: integer('row_count').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    downloadedAt: bigint('downloaded_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('product_exports_token_uq').on(t.tokenHash),
    check('product_exports_row_count_ck', sql`${t.rowCount} >= 0`),
  ],
);

/**
 * Idempotency, keyed on `(consumer, eventId)` — contract §6 rule 2, as a PRIMARY
 * KEY rather than as a convention.
 *
 * It is what makes the dispatch statement idempotent BY CONSTRAINT: the claim is
 * `INSERT … ON CONFLICT DO NOTHING RETURNING event_id` and every downstream CTE
 * selects FROM that claim, so a redelivery has nothing to act on. No prior read is
 * involved. A PARKED event has no row here at all, which is what makes it
 * retryable — the sweeper's candidate set is "events with no consumption row".
 */
export const shopOrderEventConsumptions = pgTable(
  'shop_order_event_consumptions',
  {
    consumer: text('consumer').notNull(),
    eventId: text('event_id').notNull(),
    handledAt: bigint('handled_at', { mode: 'number' }).notNull(),
    outcome: text('outcome').$type<'applied' | 'ignored' | 'abandoned'>().notNull(),
    detail: text('detail'),
  },
  (t) => [
    primaryKey({ name: 'shop_order_event_consumptions_pk', columns: [t.consumer, t.eventId] }),
    check(
      'shop_order_event_consumptions_outcome_ck',
      sql`${t.outcome} IN ('applied', 'ignored', 'abandoned')`,
    ),
  ],
);

export type DbShopOrder = typeof shopOrders.$inferSelect;
export type DbShopOrderLine = typeof shopOrderLines.$inferSelect;
export type DbShopFulfillment = typeof shopFulfillments.$inferSelect;

// ============================================================================
// CATALOG — owned by the Catalog subsystem (`01-catalog.md`).
//
// RE-EXPORTED FROM A FILE CATALOG OWNS EXCLUSIVELY, rather than declared here.
// Not a preference: this file was WHOLESALE OVERWRITTEN three times during a
// single afternoon by three different agents, each replacing it rather than
// appending, and Catalog's block was silently lost twice. "Shared, append-only"
// is a convention with no mechanism behind it (amendment A-CAT-009). One
// `export *` line is a surface a clobber costs one line to restore and that
// `tsc` names immediately, instead of three hundred lines that vanish quietly.
//
// §4's actual purpose is preserved: every commerce table is still reachable
// from this one import path.
// ============================================================================
export * from '../shop/catalog/schema';

// ============================================================================
// PAYMENTS — owned by the Payments subsystem (`03-payments.md`).
//
// RE-EXPORTED FROM A FILE PAYMENTS OWNS EXCLUSIVELY, for the reason Catalog
// gives above and for the same measured cause: this subsystem's block was
// declared here and lost to a wholesale overwrite within the hour. One
// `export *` is a surface `tsc` names immediately instead of two hundred lines
// that vanish quietly.
//
// `shop_payment_intents`, `shop_payment_events`, `shop_refunds` — §4's purpose
// is preserved: all three are still reachable from this one import path.
// ============================================================================
export * from '../shop/payments/schema';

// ============================================================================
// CART + CHECKOUT — owned by the Cart subsystem (`02-cart-checkout.md`).
//
// RE-EXPORTED FROM A FILE CART OWNS EXCLUSIVELY, following Catalog and Payments
// above and for the same measured reason: a block declared here is a block a
// wholesale overwrite deletes silently, and this file has already lost two.
//
// `shop_customers`, `shop_customer_sessions`, `shop_carts`, `shop_cart_lines`,
// `shop_reservations`, `shop_addresses`. Kept honest rather than decorative by
// `server/shop/cart/schema.test.ts`, which reads every column name back out of
// `information_schema` and fails if the declaration and the applied DDL
// disagree — §4's rules are asserted against a migrated database, never against
// this file.
// ============================================================================
export * from '../shop/cart/schema';

// ============================================================================
// REVIEWS — owned by the Reviews subsystem (issue #4, migration range
// 0180–0199). RE-EXPORTED FROM A FILE REVIEWS OWNS EXCLUSIVELY, following
// Catalog, Payments and Cart above and for the reason they record: a block
// declared here is a block a wholesale overwrite deletes silently.
//
// `shop_reviews`. §4's purpose is preserved: the table is reachable from this
// one import path, and its applied shape is asserted against a migrated
// database by `server/shop/reviews/schema.test.ts`.
// ============================================================================
export * from '../shop/reviews/schema';

// ============================================================================
// DELIVERY SETTINGS — owned by `server/shop/settings/` (migration range
// 0760–0779). RE-EXPORTED FROM A FILE THAT SUBSYSTEM OWNS EXCLUSIVELY,
// following Catalog, Payments, Cart and Reviews above and for the reason they
// record: a block declared here is a block a wholesale overwrite deletes
// silently, while a lost `export *` is one line `tsc` names immediately.
//
// `shop_delivery_settings` — the CHECK-pinned singleton that decides how
// checkout asks for an address. §4's purpose is preserved: the table is
// reachable from this one import path, and its applied shape is asserted
// against a migrated database by `server/shop/settings/schema.test.ts`.
// ============================================================================
export * from '../shop/settings/schema';

// ============================================================================
// DELIVERY COURIERS — owned by `server/shop/logistics/` (migration range
// 0960–0979). RE-EXPORTED FROM A FILE THAT SUBSYSTEM OWNS EXCLUSIVELY,
// following Catalog, Payments, Cart, Reviews and Delivery settings above and
// for the reason they record: a block declared here is a block a wholesale
// overwrite deletes silently, while a lost `export *` is one line `tsc` names
// immediately.
//
// `shop_logistics_settings` — the CHECK-pinned singleton naming the one courier
// that is switched on, the ship-from address and the packaging Terminal quotes
// against — and `shop_logistics_webhooks`, the inbound delivery log. The
// courier columns those two write back to live on `shop_fulfillments` above,
// which Orders owns. §4's purpose is preserved: both tables are reachable from
// this one import path, and their applied shapes are asserted against a
// migrated database by `server/shop/logistics/schema-parity.test.ts`.
// ============================================================================
export * from '../shop/logistics/schema';
