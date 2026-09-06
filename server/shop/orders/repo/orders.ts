import { sql, type SQL } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../../../db/client';
import type { Db } from '../../../db/client';
import {
  BadRequestError,
  NotFoundError,
  PreconditionFailedError,
  StaleWriteError,
} from '../../../repo/errors';
import { encodeCursor, pageLimit, requireCursor } from '../../../repo/cursor';
import { ID, newId } from '../ids';
import { formatOrderNumber } from '../order-number';
import type { CheckoutCompletedInput } from '../inbound';
import type { OrderCancelReason, OrderLineRef } from '../../../../shared/commerce/events';
import type { Post } from '../../../../shared/types';
import { mintGuestToken } from '../tokens';
import type { AccessLink } from '../mailer';
import {
  renderCancellation,
  renderConfirmation,
  renderPlaced,
  renderRefund,
  renderRefundFailed,
} from '../mailer';
import { BUILT_IN } from '../../../email/system-templates';
import type { TemplateSet } from '../../../email/system-templates';

/**
 * The order write path (brief `04` §1–§4).
 *
 * ONE STATEMENT PER MUTATION, AND NEVER `db.transaction`. The Neon HTTP driver
 * throws unconditionally on `transaction()` while PGlite supports it, so a
 * transaction here would pass every test and 500 in production — the divergence
 * `server/repo/posts.ts` already documents. Atomicity comes from the statement
 * instead: the timeline insert, the outbox emit, the email intent and the
 * idempotency claim all `SELECT … FROM upd`, so a CAS that matches nothing
 * structurally writes nothing at all.
 *
 * THAT IS ALSO WHAT "IN THE SAME TRANSACTION" MEANS FOR CONTRACT §6 RULE 1 AND
 * BRIEF §5. An event that can be lost while its cause commits is worse than no
 * event, because the system then believes something happened that nobody will act
 * on. A single data-modifying-CTE statement is one transaction by definition, so
 * the emit cannot be lost independently of the state change — and neither can the
 * email intent, nor the record that the event was consumed.
 */

/** Three attempts, then 409. Bounded on purpose, as `posts.ts` is. */
export const LIFECYCLE_ATTEMPTS = 3;

/** This consumer's name in `shop_order_event_consumptions` (contract §6 rule 2). */
export const CONSUMER = 'orders';

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'fulfilled'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export type OrderTimelineType =
  | 'placed'
  | 'payment_authorized'
  | 'payment_failed'
  | 'paid'
  | 'fulfillment_created'
  | 'shipped'
  | 'delivered'
  | 'fulfillment_cancelled'
  | 'cancelled'
  | 'refunded'
  | 'refund_failed';

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  /** All four FROZEN: copied from `checkout.completed`, never recomputed. */
  subtotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  /** Σ add-on amounts, frozen. 0 for every order placed before add-ons. */
  addOnTotal: number;
  refundedTotal: number;
  status: OrderStatus;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  placedAt: number;
  paidAt: number | null;
  fulfilledAt: number | null;
  /**
   * Every non-cancelled parcel on this order has been marked delivered, and this
   * is when the last of them was. `null` while any is still in flight, and `null`
   * when there are no parcels at all.
   *
   * DERIVED IN THE QUERY, NOT STORED. There is no `delivered` order status —
   * `shop_orders.status` stops at `fulfilled` — and delivery lives on the
   * FULFILMENT rows, which the list deliberately does not return. Without this
   * the board could not tell a shipped order from a delivered one and left
   * delivered parcels sitting in the Shipped lane forever.
   */
  deliveredAt: number | null;
  cancelledAt: number | null;
  revision: number;
  checkoutId: string;
  /** Payments' intent id, for `PaymentPort` display only. Null until a payment event. */
  paymentIntentId: string | null;
}

export interface OrderLine {
  id: string;
  lineNo: number;
  variantId: string;
  sku: string;
  title: string;
  optionValues: Record<string, string>;
  qty: number;
  unitAmount: number;
  lineTotal: number;
  /** How much of this line is covered by non-cancelled fulfilments. */
  fulfilledQty: number;
  /**
   * The variant's photograph AS IT WAS WHEN THE ORDER WAS PLACED (migration
   * 0340), or `null` — for a variant with no photograph, or for any order
   * placed before that migration.
   *
   * A SNAPSHOT LIKE EVERY OTHER FIELD HERE. Resolving it from `shop_variants`
   * at render time would show a customer re-reading their confirmation a
   * picture of whatever the product looks like now.
   */
  imageId: string | null;
}

/** One add-on the order carried (migration 0940). A snapshot, like a line. */
export interface OrderAddOn {
  id: string;
  position: number;
  addOnId: string;
  title: string;
  mode: 'chosen' | 'included';
  amount: number;
  listPrice: number;
  currency: string;
}

function rowToAddOn(row: Record<string, unknown>): OrderAddOn {
  return {
    id: String(row.id),
    position: Number(row.position),
    addOnId: String(row.add_on_id),
    title: String(row.title),
    mode: row.mode === 'included' ? 'included' : 'chosen',
    amount: Number(row.amount),
    listPrice: Number(row.list_price),
    currency: String(row.currency),
  };
}

export interface OrderTimelineEntry {
  id: string;
  type: string;
  message: string;
  occurredAt: number;
  actorId: string | null;
}

const ORDER_COLUMNS = [
  'id',
  'order_number',
  'customer_id',
  'email',
  'currency',
  'subtotal',
  'shipping_total',
  'tax_total',
  'grand_total',
  'add_on_total',
  'refunded_total',
  'status',
  'shipping_address',
  'billing_address',
  'placed_at',
  'paid_at',
  'fulfilled_at',
  'cancelled_at',
  'revision',
  'checkout_id',
  'payment_intent_id',
];

const orderColumns = (alias: string) =>
  ORDER_COLUMNS.map((column) => `${alias}.${column}`).join(', ');

function rowToOrder(row: Record<string, unknown>): Order {
  return {
    id: String(row.id),
    orderNumber: String(row.order_number),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    email: String(row.email),
    currency: String(row.currency),
    subtotal: Number(row.subtotal),
    shippingTotal: Number(row.shipping_total),
    taxTotal: Number(row.tax_total),
    grandTotal: Number(row.grand_total),
    addOnTotal: Number(row.add_on_total),
    refundedTotal: Number(row.refunded_total),
    status: row.status as OrderStatus,
    shippingAddress: row.shipping_address as Record<string, unknown>,
    billingAddress: row.billing_address as Record<string, unknown>,
    placedAt: toEpochMs(row.placed_at),
    paidAt: toEpochMsOrNull(row.paid_at),
    fulfilledAt: toEpochMsOrNull(row.fulfilled_at),
    deliveredAt: toEpochMsOrNull(row.delivered_at),
    cancelledAt: toEpochMsOrNull(row.cancelled_at),
    revision: Number(row.revision),
    checkoutId: String(row.checkout_id),
    paymentIntentId: row.payment_intent_id == null ? null : String(row.payment_intent_id),
  };
}

function rowToLine(row: Record<string, unknown>): OrderLine {
  return {
    id: String(row.id),
    lineNo: Number(row.line_no),
    variantId: String(row.variant_id),
    sku: String(row.sku),
    title: String(row.title),
    optionValues: row.option_values as Record<string, string>,
    qty: Number(row.qty),
    unitAmount: Number(row.unit_amount),
    lineTotal: Number(row.line_total),
    fulfilledQty: Number(row.fulfilled_qty),
    imageId: row.image_id == null ? null : String(row.image_id),
  };
}

const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/** The event-payload shape for a line, from the order's own snapshot. */
export function lineRefs(lines: readonly OrderLine[]): OrderLineRef[] {
  return lines.map((line) => ({
    orderLineId: line.id,
    variantId: line.variantId,
    sku: line.sku,
    qty: line.qty,
  }));
}

// --------------------------------------------------------------------- reads

/**
 * The order, its lines, and the LIFECYCLE GENERATION.
 *
 * `lifecycleGeneration` is deliberately NOT a field on `Order`, for the reason
 * `server/repo/posts.ts` states: it is a concurrency token for one code path, and
 * putting it on the shared type would ship it to a client and invite a caller to
 * compare it.
 *
 * The lines come back in the same statement as a `json_agg` rather than in a second
 * query, because the transitions need them (an `order.cancelled` payload names the
 * variants so a consumer can release the reservations, and an email renders the
 * line table) and two reads would give two different instants.
 */
export interface OrderRead {
  order: Order;
  lines: OrderLine[];
  addOns: OrderAddOn[];
  generation: number;
}

/**
 * WHEN THE LAST PARCEL ARRIVED, or NULL while any is still out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO `delivered` ORDER STATUS, AND THAT IS WHY THIS EXISTS.
 *
 * `shop_orders.status` stops at `fulfilled` — delivery is recorded on the
 * FULFILMENT rows (`shop_fulfillments.status`, `delivered_at`), which the list
 * deliberately does not return. So the board could not tell a shipped order
 * from a delivered one, and a parcel marked delivered sat in the Shipped lane
 * for ever: the operator did the work and the card did not move.
 *
 * ALL-OR-NOTHING, AND CANCELLED PARCELS DO NOT COUNT. An order is delivered
 * only when EVERY parcel still standing has arrived — a two-box order with one
 * delivered and one in transit is still in flight, and calling it delivered
 * would take a live parcel off the board. A cancelled fulfilment is not a
 * parcel any more, so it neither blocks the state nor satisfies it; an order
 * whose only fulfilment was cancelled has no parcels at all and answers NULL,
 * which puts it back in the lanes that count units rather than in a terminal
 * one.
 *
 * `HAVING` WITH NO `GROUP BY` is what makes "no parcels" answer NULL rather
 * than a row of nulls: the aggregate collapses to a single group, the HAVING
 * rejects it, the correlated subquery yields no row, and the column is NULL.
 * `MAX(delivered_at)` is the last arrival, which is the honest instant for an
 * order that arrived in pieces.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const DELIVERED_AT = sql`
  (SELECT MAX(f.delivered_at)
     FROM shop_fulfillments f
    WHERE f.order_id = o.id AND f.status <> 'cancelled'
   HAVING count(*) > 0
      AND count(*) FILTER (WHERE f.status = 'delivered') = count(*)
  ) AS delivered_at`;

const LINE_AGG = sql`
  COALESCE((
    SELECT json_agg(to_jsonb(l) ORDER BY l.line_no)
      FROM shop_order_lines l WHERE l.order_id = o.id
  ), '[]'::json) AS lines`;

const ADD_ON_AGG = sql`
  COALESCE((
    SELECT json_agg(to_jsonb(a) ORDER BY a.position)
      FROM shop_order_add_ons a WHERE a.order_id = o.id
  ), '[]'::json) AS add_ons`;

function rowToRead(row: Record<string, unknown>): OrderRead {
  const lines = (row.lines as Record<string, unknown>[]) ?? [];
  return {
    order: rowToOrder(row),
    lines: lines.map(rowToLine),
    addOns: ((row.add_ons as Record<string, unknown>[]) ?? []).map(rowToAddOn),
    generation: Number(row.lifecycle_generation),
  };
}

async function readByColumn(db: Db, column: SQL, value: string): Promise<OrderRead | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${DELIVERED_AT}, ${LINE_AGG}, ${ADD_ON_AGG}
      FROM shop_orders o
     WHERE ${column} = ${value}`);
  const row = res.rows[0];
  return row ? rowToRead(row) : null;
}

export const readOrder = (db: Db, id: string): Promise<OrderRead | null> =>
  readByColumn(db, sql`o.id`, id);

/**
 * By checkout id — THE LOOKUP EVERY `payment.*` EVENT USES.
 *
 * `payment.captured` names a payment intent, not an order, and Orders must not ask
 * Payments to resolve one from the other: contract §5 gives Payments no port into
 * Orders and §2 R4 makes cross-subsystem causation an event rather than a call. So
 * every `payment.*` payload carries `checkoutId` — Payments put it there for
 * exactly this — and `shop_orders.checkout_id` is UNIQUE, so this is a single-row
 * lookup on an index.
 *
 * `null` here is what PARKS an event: it means the `checkout.completed` that would
 * have created the order has not arrived yet, which is ordinary and not an error.
 */
export const readOrderByCheckout = (db: Db, checkoutId: string): Promise<OrderRead | null> =>
  readByColumn(db, sql`o.checkout_id`, checkoutId);

export async function listTimeline(db: Db, orderId: string): Promise<OrderTimelineEntry[]> {
  const res = await db.execute(sql`
    SELECT id, type, message, occurred_at, actor_id
      FROM shop_order_events
     WHERE order_id = ${orderId}
     ORDER BY occurred_at ASC, id ASC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    message: String(row.message),
    occurredAt: toEpochMs(row.occurred_at),
    actorId: row.actor_id == null ? null : String(row.actor_id),
  }));
}

// ------------------------------------------------------- scoped customer reads

/**
 * THE AUTHORIZATION CHECK BRIEF §6 CALLS "THE ONE TO GET RIGHT".
 *
 * "Scope every query by the resolved customer id *in the SQL*, never by a JS check
 * after fetching." Both functions below take the identity as a bound parameter of
 * the `WHERE` clause, so there is no instant at which a row the caller may not see
 * exists in this process. A `getOrder(...)` followed by
 * `if (order.customerId !== me) throw` would be the version that leaks: it is one
 * early `return`, one refactor, or one `catch` away from answering with the row —
 * and it cannot be mutation-tested, because the guard would not be in the SQL to
 * neutralise.
 *
 * `customerId` is NEVER NULL here. A guest order has `customer_id IS NULL`, and
 * `column = NULL` is NULL rather than true, so a null identity would match nothing
 * — but relying on that would mean an anonymous caller's authorization depended on
 * SQL three-valued logic. It is refused explicitly instead.
 */
export async function getOrderForCustomer(
  db: Db,
  customerId: string,
  orderNumber: string,
): Promise<OrderRead | null> {
  if (customerId.length === 0) throw new BadRequestError('customerId');
  const res = await db.execute(sql`
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${DELIVERED_AT}, ${LINE_AGG}, ${ADD_ON_AGG}
      FROM shop_orders o
     WHERE o.order_number = ${orderNumber} AND o.customer_id = ${customerId}`);
  const row = res.rows[0];
  return row ? rowToRead(row) : null;
}

/**
 * Guest access, scoped by BOTH values out of a VERIFIED token (brief §6).
 *
 * The order number reaching this function comes from the token's signed payload,
 * not from the URL — `routes.ts` compares the two and 404s on a mismatch — and the
 * email is matched case-insensitively against the same index the migration builds
 * on `lower(email)`. So a valid token for one order cannot read another even if the
 * path names it, and there is no code path in which an attacker-chosen order number
 * reaches this query.
 */
export async function getOrderForGuest(
  db: Db,
  orderNumber: string,
  email: string,
): Promise<OrderRead | null> {
  if (email.length === 0) throw new BadRequestError('email');
  const res = await db.execute(sql`
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${DELIVERED_AT}, ${LINE_AGG}, ${ADD_ON_AGG}
      FROM shop_orders o
     WHERE o.order_number = ${orderNumber} AND lower(o.email) = lower(${email})`);
  const row = res.rows[0];
  return row ? rowToRead(row) : null;
}

// ---------------------------------------------------------------- keyset lists

/**
 * `server/repo/cursor.ts`, verbatim (brief §6). Not a second codec.
 *
 * The cursor carries the sort key that minted it, which is what stops a cursor
 * being spent under a different ordering — GAUNTLET II Part 2b Round 1 #2 measured
 * both failure modes: an `alphabetical` cursor under `updated` was SQLSTATE 22P02
 * (a 500 the client retries five times for a request that can never succeed), and a
 * `published` cursor under `oldest` silently returned 1 of 8 rows.
 *
 * One ordering here, and one only: `placed_at DESC, id ASC`. An order list is read
 * newest-first and nothing else has been asked for; adding a second sort would add
 * a second way to be wrong for no user.
 */
const SORT_KEY = 'placed';

export interface OrderPage {
  items: { order: Order; lines: OrderLine[] }[];
  nextCursor: string | null;
}

interface ListQuery {
  status?: OrderStatus;
  cursor?: string;
  limit?: number;
}

async function listOrders(db: Db, scope: SQL, q: ListQuery): Promise<OrderPage> {
  const size = pageLimit(q.limit);
  const where: SQL[] = [scope];
  if (q.status !== undefined) where.push(sql`o.status = ${q.status}`);

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const placedAt = Number(cursor.sortValues[0]);
    /*
     * COERCED TO THE TYPE THE COLUMN HAS, exactly as `server/repo/query.ts` does.
     * The payload is base64 JSON that anyone can write, so a hand-made cursor can
     * name the right sort and still carry a string — which against a `bigint`
     * column is 22P02, a 500, and five retries.
     */
    if (!Number.isFinite(placedAt)) throw new BadRequestError('cursor');
    // `placed_at DESC, id ASC`, expanded so each component keeps its own direction.
    where.push(sql`(o.placed_at < ${placedAt}
                    OR (o.placed_at = ${placedAt} AND o.id > ${cursor.id}))`);
  }

  const res = await db.execute(sql`
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${DELIVERED_AT}, ${LINE_AGG}, ${ADD_ON_AGG}
      FROM shop_orders o
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY o.placed_at DESC, o.id ASC
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const rows = res.rows.slice(0, size);
  const items = rows.map((row) => {
    const read = rowToRead(row);
    return { order: read.order, lines: read.lines };
  });
  const last = items[items.length - 1];
  const more = res.rows.length > size;
  return {
    items,
    nextCursor:
      more && last ? encodeCursor(SORT_KEY, [last.order.placedAt], last.order.id) : null,
  };
}

/** The signed-in customer's OWN orders. Scoped in the SQL; see `getOrderForCustomer`. */
export function listCustomerOrders(
  db: Db,
  customerId: string,
  q: ListQuery,
): Promise<OrderPage> {
  if (customerId.length === 0) throw new BadRequestError('customerId');
  return listOrders(db, sql`o.customer_id = ${customerId}`, q);
}

/**
 * The distinct addresses this customer has actually shipped to, most recent
 * first.
 *
 * ═══ WHY THE ORDERS AND NOT AN ADDRESS BOOK ═══
 * `shop_addresses` is keyed on the CART (`(cart_id, kind)` unique, `ON DELETE
 * CASCADE`) and is snapshotted onto the order at conversion, so there has never
 * been anything a returning shopper could pick from — every checkout started at
 * an empty form. The obvious fix is a `customer_id` on that table and a new
 * write path to maintain it; this is the same answer with no migration, no
 * backfill and no second source of truth to drift: an order IS the record that
 * an address was used, and it is already scoped to the customer.
 *
 * What it deliberately cannot do is remember an address typed into a checkout
 * that never completed. That is the correct trade — "somewhere I have had
 * something delivered" is a stronger claim than "somewhere I once typed", and
 * it is the one a shopper is actually choosing between.
 *
 * GROUPED ON THE JSONB ITSELF, so two orders to the same address collapse and a
 * changed flat number does not. `jsonb` has equality, so this needs no
 * normalisation function that would then have to agree with the one on the
 * write side.
 */
export async function listCustomerShippingAddresses(
  db: Db,
  customerId: string,
  limit = 5,
): Promise<{ address: Record<string, unknown>; lastUsedAt: number }[]> {
  if (customerId.length === 0) throw new BadRequestError('customerId');
  const res = await db.execute(sql`
    SELECT shipping_address, MAX(placed_at) AS last_used
      FROM shop_orders
     WHERE customer_id = ${customerId}
       AND shipping_address IS NOT NULL
       AND shipping_address <> '{}'::jsonb
     GROUP BY shipping_address
     ORDER BY last_used DESC
     LIMIT ${limit}`);
  return res.rows.map((row) => ({
    address: (row.shipping_address ?? {}) as Record<string, unknown>,
    lastUsedAt: toEpochMs(row.last_used),
  }));
}

/** Admin: every order. Behind `requireAuth()` at the route. */
export function listAllOrders(db: Db, q: ListQuery): Promise<OrderPage> {
  return listOrders(db, sql`true`, q);
}

// -------------------------------------------------------------------- create

export type CreateOutcome =
  | { kind: 'created'; order: Order; lines: OrderLine[] }
  /** This consumer has already handled this event id. Nothing was written. */
  | { kind: 'replayed' }
  /** An order for this checkout (or from this event) already exists. */
  | { kind: 'duplicate'; on: 'checkout' | 'event' };

/** How many fresh order numbers to try before giving up. See the catch below. */
const NUMBER_ATTEMPTS = 3;

/**
 * The order, its lines, its first timeline entry and the record that the event was
 * consumed — in ONE statement.
 *
 * IDEMPOTENCY IS THREE CONSTRAINTS AND NO PRIOR READ (brief §4). None of them is a
 * `SELECT` that decides whether to insert, because such a read is evaluated against
 * a snapshot a concurrent writer has already invalidated — the whole of Part 2b's
 * finding:
 *
 *  1. `shop_order_event_consumptions` PK `(consumer, event_id)` — the same event
 *     row applied twice. Written FROM `ord`, so it records "applied" only if the
 *     order was in fact inserted.
 *  2. `shop_orders_source_event_uq` — brief §4's named backstop, and the one that
 *     still holds if somebody clears a consumption row to force a retry.
 *  3. `shop_orders_checkout_uq` — TWO DIFFERENT events for one checkout, which
 *     neither of the above can see. A provider or an operator re-emitting
 *     `checkout.completed` under a fresh id is the realistic case.
 *
 * The status is `pending`, and NO `order.created` IS EMITTED HERE (brief §4's
 * table). An unpaid order is not something a consumer should act on, and `paid` is
 * where the event belongs.
 */
export async function createOrderFromCheckout(
  db: Db,
  event: { id: string; occurredAt: number },
  input: CheckoutCompletedInput,
  now: number,
  /*
   * THE ORIGIN, NOT AN `AccessLink`, and the difference is that the token cannot
   * be minted before this function runs: it is an HMAC over the ORDER NUMBER, and
   * the order number is minted inside the retry loop below. A caller handing in a
   * finished link would be handing in one for an order that does not exist yet.
   *
   * `null` means the message carries no link — degraded but honest, exactly as
   * `ConsumerDeps.origin` documents.
   */
  origin: string | null = null,
  templates: TemplateSet = BUILT_IN,
): Promise<CreateOutcome> {
  const year = new Date(now).getUTCFullYear();

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    const orderId = newId(ID.order);
    /*
     * `nextval` PER ATTEMPT, so a lost number is replaced rather than retried. It
     * is a separate round trip because the check character is computed in
     * TypeScript, and a plpgsql copy of that arithmetic would be a second
     * implementation of it — the mistake `server/repo/query.ts` records, where two
     * copies of a sort key disagreeing became a page boundary that skipped rows.
     */
    const seq = await db.execute(sql`SELECT nextval('shop_order_number_seq') AS n`);
    const orderNumber = formatOrderNumber(year, Number(seq.rows[0].n));

    /*
     * THE "WE HAVE YOUR ORDER" MESSAGE, WRITTEN IN THE SAME STATEMENT AS THE ORDER
     * (migration 0320 added the `placed` kind).
     *
     * WHY IT IS WORTH A MESSAGE AT ALL, given the confirmation follows within the
     * minute: on this deployment it does not reliably follow within the minute.
     * The sweep does the post-payment work rather than the webhook, and CLAUDE.md
     * records that the storefront's confirmation page gives up after sixty
     * seconds. Sending nothing here means the customer's only feedback in that
     * window is a page that eventually says it cannot confirm — and their
     * conclusion is that the payment failed, so they pay again.
     *
     * IT DOES NOT CLAIM THE MONEY ARRIVED, and the wording in
     * `server/mail/defaults.ts` is careful about that: the order is `pending` at
     * this point and the capture may yet fail, in which case the next message is
     * a cancellation. Saying "payment received" here and cancelling an hour later
     * is worse than saying nothing.
     */
    const placed = renderPlaced(
      {
        orderNumber,
        email: input.email,
        currency: input.currency,
        grandTotal: input.grandTotal,
        placedAt: event.occurredAt,
        /*
         * NO `imageId` HERE, AND THAT IS NOT AN OVERSIGHT. This view is built
         * from the CHECKOUT EVENT's payload, which carries no image — the
         * snapshot is resolved by the LEFT JOIN in the statement below, which
         * has not run yet at this point in the function. So the "we have your
         * order" mail is the one message in the lifecycle with no thumbnails;
         * every later one reads the stored line and has them.
         *
         * Fixable only by carrying an image through `checkout.completed`, i.e.
         * by changing a shared event contract on a live money path. Not worth
         * it for the first of six messages.
         */
        lines: input.lines.map((line) => ({
          title: line.title,
          sku: line.sku,
          qty: line.qty,
          lineTotal: line.lineTotal,
        })),
        addOns: input.addOns.map((a) => ({ title: a.title, amount: a.amount, mode: a.mode })),
      },
      origin === null
        ? null
        : { origin, token: mintGuestToken({ orderNumber, email: input.email }, now) },
      templates,
    );

    const lines = input.lines.map((line, index) => ({
      id: newId(ID.orderLine),
      line_no: index,
      variant_id: line.variantId,
      sku: line.sku,
      title: line.title,
      option_values: line.optionValues,
      qty: line.qty,
      unit_amount: line.unitAmount,
      line_total: line.lineTotal,
    }));

    const addOns = input.addOns.map((addOn, index) => ({
      id: newId(ID.orderAddOn),
      position: index,
      add_on_id: addOn.id,
      title: addOn.title,
      mode: addOn.mode,
      amount: addOn.amount,
      list_price: addOn.listPrice,
      currency: input.currency,
    }));

    try {
      const res = await db.execute(sql`
        WITH ord AS (
          INSERT INTO shop_orders (
            id, order_number, customer_id, email, currency,
            subtotal, shipping_total, tax_total, grand_total, add_on_total,
            status, shipping_address, billing_address, placed_at,
            revision, source_event_id, checkout_id,
            redemption_points, redemption_email,
            discount_code, discount_amount_minor)
          VALUES (
            ${orderId}, ${orderNumber}, ${input.customerId}, ${input.email}, ${input.currency},
            ${input.subtotal}, ${input.shippingTotal}, ${input.taxTotal}, ${input.grandTotal}, ${input.addOnTotal},
            'pending', ${jsonb(input.shippingAddress)}, ${jsonb(input.billingAddress)},
            ${event.occurredAt}, 1, ${event.id}, ${input.checkoutId},
            ${input.redemption?.points ?? null}::integer,
            ${input.redemption?.email ?? null}::text,
            /* The code AND what it took off, carried from the cart through
               the event (migration 0820). Both, because the capture counts the
               use on a LATER event and Orders may not read the cart tables to
               go and find the number then — contract §2, and the reason
               redemption_points sits on this table too.
               (Bare column names: a backtick here would end the sql template
               and the error would name neither SQL nor the backtick.) */
            ${input.discount?.code ?? null}::text,
            ${input.discount?.amountMinor ?? null}::integer)
          RETURNING ${sql.raw(ORDER_COLUMNS.join(', '))}
        ), ins_lines AS (
          INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                        option_values, qty, unit_amount, line_total,
                                        image_id)
          SELECT l.id, ord.id, l.line_no, l.variant_id, l.sku, l.title,
                 l.option_values, l.qty, l.unit_amount, l.line_total,
                 /*
                  * THE PHOTOGRAPH, SNAPSHOTTED HERE AND NEVER READ AGAIN
                  * (migration 0340, which carries the full argument).
                  *
                  * LEFT, not INNER: a variant with no photograph, or one the
                  * catalogue has since removed, must still produce an order
                  * line. An INNER JOIN here would make a missing picture drop
                  * a paid item from the order, which is the worst possible
                  * failure for the least important column on the row.
                  */
                 v.image_id
            FROM ord, jsonb_to_recordset(${jsonb(lines)}) AS l(
                   id text, line_no integer, variant_id text, sku text, title text,
                   option_values jsonb, qty integer, unit_amount integer, line_total integer)
            LEFT JOIN shop_variants v ON v.id = l.variant_id
          RETURNING id, line_no, variant_id, sku, title, option_values, qty,
                    unit_amount, line_total, fulfilled_qty, image_id
        ), ins_add_ons AS (
          /* The add-ons (migration 0940), a snapshot beside the lines. An
             empty array yields no rows and no error. */
          INSERT INTO shop_order_add_ons (id, order_id, position, add_on_id, title, mode, amount, list_price, currency)
          SELECT a.id, ord.id, a.position, a.add_on_id, a.title, a.mode, a.amount, a.list_price, a.currency
            FROM ord, jsonb_to_recordset(${jsonb(addOns)}) AS a(
                   id text, position integer, add_on_id text, title text, mode text,
                   amount integer, list_price integer, currency text)
          RETURNING 1
        ), timeline AS (
          INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
          SELECT ${newId(ID.timeline)}, ord.id, 'placed',
                 'Order placed', ${event.occurredAt}, NULL
            FROM ord
          RETURNING 1
        ), mail AS (
          /* One per ORDER, as a constraint rather than a promise: a redelivered
             checkout.completed that somehow reached here twice writes one row. */
          INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject,
                                                body, html, created_at, dedupe_key)
          SELECT ${newId(ID.emailIntent)}, ord.id, 'placed', ${placed.to},
                 ${placed.subject}, ${placed.body}, ${placed.html ?? null}::text,
                 ${now}, 'placed:' || ord.id
            FROM ord
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING 1
        ), claim AS (
          INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
          SELECT ${CONSUMER}, ${event.id}, ${now}, 'applied', NULL FROM ord
          ON CONFLICT DO NOTHING
          RETURNING event_id
        ), mark AS (
          UPDATE commerce_events SET processed_at = ${now}, last_error = NULL
            FROM ord WHERE commerce_events.id = ${event.id}
          RETURNING 1
        )
        SELECT ${sql.raw(orderColumns('ord'))},
               (SELECT COALESCE(json_agg(to_jsonb(x) ORDER BY x.line_no), '[]'::json)
                  FROM ins_lines x) AS lines
          FROM ord`);

      const row = res.rows[0];
      /*
       * No row means the INSERT wrote nothing, which for a plain `VALUES` insert
       * can only happen if a concurrent statement already claimed this event and
       * the constraint below caught it — handled in the `catch`. Reaching here
       * without a row is therefore a replay of a statement that has already run.
       */
      if (!row) return { kind: 'replayed' };
      return {
        kind: 'created',
        order: rowToOrder(row),
        lines: ((row.lines as Record<string, unknown>[]) ?? []).map(rowToLine),
      };
    } catch (err: unknown) {
      const constraint = uniqueViolation(err);
      /*
       * A BURNT ORDER NUMBER IS A RETRY, NOT A FAILURE. With a sequence this is
       * only reachable if somebody has reset it (an import, a restore), but the
       * answer is the same as `withSlugRetry`'s: mint a fresh candidate rather than
       * surface a 23505 the caller cannot act on.
       */
      if (constraint === 'shop_orders_order_number_uq') continue;
      // The two dedupe backstops. Permanent, so the caller records `ignored`.
      if (constraint === 'shop_orders_checkout_uq') return { kind: 'duplicate', on: 'checkout' };
      if (constraint === 'shop_orders_source_event_uq') return { kind: 'duplicate', on: 'event' };
      throw err;
    }
  }
  /*
   * Three fresh numbers, three collisions. Not a `StaleWriteError`: that error's
   * contract is `expected !== actual`, and reporting this as one would arrive with
   * `0 === 0`, which is exactly the unrenderable shape `server/repo/errors.ts`
   * split `PreconditionFailedError` out to avoid. A plain `Error` reaches the
   * dispatcher's catch-all and PARKS the event, which is the right outcome: the
   * only way to get here is a sequence that has been reset behind an existing set
   * of orders, and that is an operator problem the event must survive.
   */
  throw new Error(`could not mint an unused order number in ${NUMBER_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------- transitions

/**
 * What a transition may write beyond the order row itself.
 *
 * Every one of these lands in the SAME STATEMENT as the `UPDATE`, gated by
 * `SELECT … FROM upd`. That is what makes contract §6 rule 1 and brief §5 true
 * rather than intended: the outbox row cannot be lost while the status change
 * commits, and the email intent cannot be written for a transition that did not
 * happen.
 */
interface Effects {
  timeline: { type: OrderTimelineType; message: string; actorId: string | null };
  emit?: { type: 'order.created' | 'order.fulfilled' | 'order.cancelled'; payload: unknown };
  /**
   * `html` RIDES ALONG WITH `body` and is stored beside it (migration 0320).
   * Optional in the type only so a caller mid-refactor still compiles; every
   * render in `../mailer.ts` produces both parts, and a message stored with no
   * HTML falls back to `textToHtml` at delivery — which is what every row
   * written before 0320 does.
   */
  mail?: {
    kind: 'confirmation' | 'cancellation' | 'refund';
    dedupeKey: string;
    to: string;
    subject: string;
    body: string;
    html?: string | null;
  };
}

interface Transition<A> {
  /** For the refusal message — `pay`, `cancel`, … */
  name: string;
  /**
   * The precondition, used ONLY to explain a CAS that matched nothing — never to
   * decide whether the write may proceed. A precondition judged in TypeScript is
   * judged against a row that has already been read, i.e. against exactly the
   * stale value the CAS exists to distrust.
   */
  holds(order: Order): boolean;
  /** The same precondition IN THE CAS PREDICATE. This is the authoritative one. */
  guard: SQL;
  set(read: OrderRead, arg: A, now: number): SQL;
  effects(read: OrderRead, arg: A, now: number): Effects;
}

/** Optional: the outbox row whose consumption this transition records atomically. */
export interface EventClaim {
  eventId: string;
}

/**
 * Read, PIN THE GENERATION, then CAS — up to three times.
 *
 * THE PIN IS READ ONCE, ON THE FIRST ATTEMPT, AND HELD FOR THE REST. Re-reading it
 * per attempt would defeat the entire mechanism: the retry would adopt whatever
 * generation the concurrent lifecycle op left behind and win against it, which is
 * the original defect with an extra column (GAUNTLET II Part 2b Round 1 #1).
 *
 * WHY A PIN AND NOT A BETTER PREDICATE. `status = 'paid'` cannot distinguish "never
 * left paid" from "was cancelled and put back to paid" — the row is identical. A
 * `cancel` that lost that race and blindly retried would cancel an order somebody
 * had deliberately reinstated: a PAID ORDER THAT NEVER SHIPS. `revision` cannot
 * serve either, because it moves on writes that are none of this operation's
 * business, so pinning it would refuse transitions that should succeed.
 *
 * `revision` IS STILL RE-BASED EVERY ATTEMPT, and the asymmetry is the point: a
 * concurrent NON-lifecycle write should be re-derived from, and a concurrent
 * lifecycle write should refuse.
 */
async function transition<A>(
  db: Db,
  orderId: string,
  t: Transition<A>,
  arg: A,
  now: number,
  claim: EventClaim | null,
): Promise<Order> {
  let read = await readOrder(db, orderId);
  if (!read) throw new NotFoundError(orderId);

  const pinned = read.generation;
  const derivedFrom = read.order.revision;

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const base = read.order.revision;
    const effects = t.effects(read, arg, now);

    /*
     * THE CTE LIST IS ASSEMBLED, NOT TEMPLATED WITH `WHERE false` BRANCHES.
     *
     * The alternative — one fixed statement whose unused arms bind NULLs and are
     * switched off by `WHERE false` — puts a NULL into a bound parameter for a NOT
     * NULL column and asks Postgres to infer its type from an INSERT that will
     * never run. It also makes every statement claim to do things this transition
     * does not do, which is the opposite of what a statement should say. A
     * transition with no email simply has no `mail` CTE.
     *
     * What does NOT change is that every arm present selects `FROM upd`, so a CAS
     * that matches nothing writes none of them.
     */
    const ctes: SQL[] = [
      sql`upd AS (
        UPDATE shop_orders
           SET ${t.set(read, arg, now)}, revision = revision + 1
         WHERE id = ${orderId}
           AND revision = ${base}
           AND lifecycle_generation = ${pinned}
           AND ${t.guard}
        RETURNING ${sql.raw(ORDER_COLUMNS.join(', '))}
      )`,
      sql`timeline AS (
        INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
        SELECT ${newId(ID.timeline)}, upd.id, ${effects.timeline.type},
               ${effects.timeline.message}, ${now}, ${effects.timeline.actorId}
          FROM upd
        RETURNING 1
      )`,
    ];

    if (effects.emit) {
      ctes.push(sql`emit AS (
        INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
        SELECT ${newId(ID.event)}, ${effects.emit.type}, upd.id,
               ${jsonb(effects.emit.payload)}, ${now}
          FROM upd
        RETURNING 1
      )`);
    }

    if (effects.mail) {
      ctes.push(sql`mail AS (
        INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject, body,
                                              html, created_at, dedupe_key)
        SELECT ${newId(ID.emailIntent)}, upd.id, ${effects.mail.kind}, ${effects.mail.to},
               ${effects.mail.subject}, ${effects.mail.body},
               ${effects.mail.html ?? null}::text, ${now}, ${effects.mail.dedupeKey}
          FROM upd
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )`);
    }

    if (claim) {
      ctes.push(sql`consumed AS (
        INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
        SELECT ${CONSUMER}, ${claim.eventId}, ${now}, 'applied', NULL FROM upd
        ON CONFLICT DO NOTHING
        RETURNING 1
      )`);
      ctes.push(sql`mark AS (
        UPDATE commerce_events SET processed_at = ${now}, last_error = NULL
          FROM upd WHERE commerce_events.id = ${claim.eventId}
        RETURNING 1
      )`);
    }

    const res = await db.execute(sql`
      WITH ${sql.join(ctes, sql`, `)}
      SELECT ${sql.raw(ORDER_COLUMNS.join(', '))} FROM upd`);

    // `rows[0]`, never `affectedRows` — measured to be 0 even on a winning CAS.
    const row = res.rows[0];
    if (row) return rowToOrder(row);

    /*
     * The predicate matched nothing. Read back to find out which half said no —
     * and this read is the ONLY thing `holds()` is ever consulted about.
     *
     * An unmoved generation means no lifecycle op has happened since the first
     * read, so a false precondition NOW was already false THEN: the request is
     * REFUSED, not lost, and two more attempts would cost two more statements to
     * reach the same answer. Anything else is a genuine race, so it re-bases.
     */
    const after = await readOrder(db, orderId);
    if (!after) throw new NotFoundError(orderId);
    if (after.generation === pinned && !t.holds(after.order)) {
      throw new PreconditionFailedError(t.name, asPostShaped(after.order));
    }
    read = after;
  }

  /*
   * Three attempts, three lost races. `expected` is the revision the FIRST read
   * derived from, not the last one tried: that is the version the caller's request
   * was actually about, and it is what makes `expected !== actual` true here and
   * only here — the property that distinguishes a real conflict from a refusal.
   */
  throw new StaleWriteError(derivedFrom, read.order.revision, null);
}

/**
 * `PreconditionFailedError` and `StaleWriteError` both carry a `Post`.
 *
 * REUSED RATHER THAN REPLACED, because contract §10 says to add a new error class
 * only for genuinely new CLIENT BEHAVIOUR, and there is none here: a refused
 * lifecycle op on an order needs the same 409 `precondition_failed` and the same
 * client handling it needs on a post. What differs is only the payload's shape.
 *
 * `server/middleware/errors.ts` serialises `err.post` straight into the body, so
 * what the client receives is this object — the ORDER — under a key named `post`.
 * That key name is wrong for this subsystem and is the smallest defect worth
 * living with until a shared file can be changed: renaming it is an amendment to
 * `server/repo/errors.ts` and `server/middleware/errors.ts`, both of which contract
 * §2 R1 puts out of reach. **AMENDMENTS.md A-CAT-011 already records it** — the
 * Catalog agent hit the same wall — so Orders does not raise a duplicate. The cast
 * is confined to this one function so there is exactly one place to change when a
 * resolution lands.
 */
export function asErrorSubject(value: unknown): Post {
  return value as Post;
}

const asPostShaped = asErrorSubject;


/**
 * `payment_intent_id`, remembered first-wins.
 *
 * Appended to a SET list rather than always present, because the ADMIN cancel path has no
 * payment event behind it and binding a NULL there would clear a value the order legitimately
 * holds. `COALESCE` makes it first-wins: a retried payment under a second intent must not
 * silently re-point an order at a different charge, and an operator chasing a chargeback
 * needs the intent that was actually taken.
 */
function rememberIntent(intentId: string | null | undefined): SQL {
  return intentId == null
    ? sql``
    : sql`, payment_intent_id = COALESCE(payment_intent_id, ${intentId})`;
}

/**
 * `refunded_total`, ADDED TO rather than SET, so this can never overwrite a
 * figure written some other way. Absent or zero appends nothing — the
 * ordinary cancel-with-no-refund path is byte-identical to what it always was.
 *
 * ONLY `CANCEL` USES THIS (task-d3). The amount is never computed in this
 * file: `routes.ts`'s admin cancel calls the refund FIRST, through the
 * injected `RefundIssuer`, and only reaches this transition once that call has
 * NOT thrown — so by the time a positive number reaches here the money has
 * already moved (or is irreversibly in flight with the provider). This only
 * records it.
 *
 * WHY A CANCELLED ORDER CARRIES A REFUND FIGURE AT ALL, given the design
 * decided `status` becomes `'cancelled'` rather than `'refunded'` /
 * `'partially_refunded'` (see the task's report: cancelled wins, because the
 * order stops shipping either way and `status` holds one word). `refunded_
 * total` is a SEPARATE COLUMN, read by the customer-facing order view, and
 * losing it — silently reverting to 0 while real money moved — would tell a
 * customer re-reading their cancelled order that they were never refunded.
 * The AUTHORITATIVE figure for an operator remains the payment intent's own
 * `refunded_total` (synchronous, via `shop_refunds`/`PaymentPort`); this is
 * the customer-facing mirror of it for this one order.
 */
function withRefundedAmount(amount: number | undefined): SQL {
  return !amount ? sql`` : sql`, refunded_total = refunded_total + ${amount}`;
}

// ------------------------------------------------------------ the transitions

const MARK_PAID: Transition<{
  link: AccessLink | null;
  intentId: string | null;
  templates: TemplateSet;
}> = {
  name: 'pay',
  holds: (o) => o.status === 'pending',
  guard: sql`status = 'pending'`,
  set: (_read, arg, now) =>
    sql`status = 'paid', paid_at = ${now}${rememberIntent(arg.intentId)}`,
  effects: (read, arg, now) => ({
    timeline: { type: 'paid', message: 'Payment received', actorId: null },
    /*
     * `order.created` IS EMITTED HERE AND NOT AT INSERT (brief §4's table). The row
     * exists from `checkout.completed`, but it is `pending` then, and an event
     * called `created` on an unpaid order would have every consumer guessing
     * whether money had arrived.
     */
    emit: {
      type: 'order.created',
      payload: {
        orderId: read.order.id,
        orderNumber: read.order.orderNumber,
        checkoutId: read.order.checkoutId,
        customerId: read.order.customerId,
        email: read.order.email,
        total: { amount: read.order.grandTotal, currency: read.order.currency },
        lines: lineRefs(read.lines),
        placedAt: read.order.placedAt,
        paidAt: now,
      },
    },
    mail: {
      kind: 'confirmation',
      /* One confirmation per order, as a UNIQUE constraint rather than a promise. */
      dedupeKey: `confirmation:${read.order.id}`,
      /* `renderConfirmation` addresses it from the ORDER's email snapshot, not from
       * anything a request supplied — the address a confirmation goes to is the one
       * the customer bought with. */
      ...renderConfirmation(mailView(read), arg.link, arg.templates),
    },
  }),
};

const CANCEL: Transition<{
  reason: OrderCancelReason;
  actorId: string | null;
  link: AccessLink | null;
  intentId?: string | null;
  templates?: TemplateSet;
  /** Minor units, already refunded before this runs. See `withRefundedAmount`. */
  refundedAmount?: number;
}> = {
  name: 'cancel',
  /*
   * A FULFILLED OR REFUNDED ORDER CANNOT BE CANCELLED, and that is a decision
   * rather than an omission. Once goods have shipped, "cancelled" is a false record
   * of what happened — the correct action is a refund, which has its own transition
   * and leaves the shipment in the history. Cancelling `pending` (no money taken)
   * and `paid` (money taken, nothing shipped) are the two real cases.
   */
  holds: (o) => o.status === 'pending' || o.status === 'paid',
  guard: sql`status IN ('pending', 'paid')`,
  set: (_read, arg, now) =>
    sql`status = 'cancelled', cancelled_at = ${now}${rememberIntent(arg.intentId)}${withRefundedAmount(arg.refundedAmount)}`,
  effects: (read, arg, now) => ({
    timeline: {
      type: arg.reason === 'payment_failed' ? 'payment_failed' : 'cancelled',
      message: arg.reason === 'payment_failed' ? 'Payment failed — order cancelled' : 'Order cancelled',
      actorId: arg.actorId,
    },
    emit: {
      type: 'order.cancelled',
      payload: {
        orderId: read.order.id,
        orderNumber: read.order.orderNumber,
        checkoutId: read.order.checkoutId,
        reason: arg.reason,
        actorId: arg.actorId,
        /*
         * The lines are what make this event actionable. Brief §4 requires a
         * `payment.failed` to cancel the order AND RELEASE ITS RESERVATIONS, and
         * releasing one is Catalog's `release` reached through Cart — caused by an
         * event, never by a call (contract §2 R4). A consumer can only do that if
         * the event says which variants and how many.
         */
        lines: lineRefs(read.lines),
        cancelledAt: now,
      },
    },
    /*
     * NO CANCELLATION EMAIL FOR AN UNPAID ORDER. A `pending` order is a checkout
     * that never completed payment; the customer has not been charged and has no
     * reason to hear from us. Mailing them would turn every abandoned card decline
     * into a message about an order they do not believe they placed.
     */
    mail:
      read.order.status === 'pending'
        ? undefined
        : {
            kind: 'cancellation',
            dedupeKey: `cancellation:${read.order.id}`,
            ...renderCancellation(
              { ...mailView(read), reason: cancelReasonText(arg.reason) },
              arg.link,
              arg.templates ?? BUILT_IN,
            ),
          },
  }),
};

const APPLY_REFUND: Transition<{
  refundedAmount: number;
  refundedTotal: number;
  link: AccessLink | null;
  eventId: string;
  intentId?: string | null;
  templates?: TemplateSet;
}> = {
  name: 'refund',
  holds: (o) =>
    o.status === 'paid' ||
    o.status === 'fulfilled' ||
    o.status === 'partially_refunded' ||
    o.status === 'refunded',
  guard: sql`status IN ('paid', 'fulfilled', 'partially_refunded', 'refunded')`,
  /**
   * THE STATUS IS DECIDED IN SQL AGAINST THE FROZEN TOTAL, not in TypeScript.
   *
   * `refundedTotal` is CUMULATIVE and comes from the payload, so it is COPIED
   * rather than accumulated: `+= refundedAmount` would double-count a redelivery
   * and would end on whichever of two out-of-order events arrived last.
   * `GREATEST` makes a late OLDER event unable to walk the figure backwards.
   *
   * The full-versus-partial decision compares that figure against this order's own
   * frozen `grand_total` in the same statement — a comparison, never a
   * recomputation.
   */
  set: (_read, arg, _now) => sql`
    refunded_total = GREATEST(refunded_total, ${arg.refundedTotal}),
    status = CASE
      WHEN GREATEST(refunded_total, ${arg.refundedTotal}) >= grand_total THEN 'refunded'
      ELSE 'partially_refunded'
    END${rememberIntent(arg.intentId)}`,
  effects: (read, arg, _now) => ({
    timeline: { type: 'refunded', message: 'Refund issued', actorId: null },
    mail: {
      kind: 'refund',
      /* Per REFUND EVENT, not per order: a second partial refund is a second mail. */
      dedupeKey: `refund:${read.order.id}:${arg.eventId}`,
      ...renderRefund(
        { ...mailView(read), refundedAmount: arg.refundedAmount, refundedTotal: arg.refundedTotal },
        arg.link,
        arg.templates ?? BUILT_IN,
      ),
    },
  }),
};

/**
 * `{{cancel_reason}}` — the stored enum as a sentence a customer can read.
 *
 * NOT `arg.reason` RAW. `payment_failed` in an email reads as a system error the
 * reader is somehow responsible for, and `admin` reads as nothing at all.
 *
 * `OrderCancelReason` admits exactly two values today, so this switch is total
 * and the `default` is unreachable. It is there for the third: a reason added to
 * the shared type should degrade to a vague sentence in a customer's inbox rather
 * than leak a bare identifier, and TypeScript cannot warn about this file when
 * the union widens in `shared/commerce/events.ts`.
 */
function cancelReasonText(reason: OrderCancelReason): string {
  switch (reason) {
    case 'payment_failed':
      return 'The payment did not go through';
    case 'admin':
      return 'Cancelled by the shop';
    default:
      return 'Cancelled by the shop';
  }
}

function mailView(read: OrderRead) {
  return {
    orderNumber: read.order.orderNumber,
    email: read.order.email,
    currency: read.order.currency,
    grandTotal: read.order.grandTotal,
    /* `{{order_date}}`. From the ORDER's own column and never `Date.now()`: a
     * confirmation rendered by a sweep that ran an hour late must still say the
     * day the customer actually bought. */
    placedAt: read.order.placedAt,
    lines: read.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      qty: line.qty,
      lineTotal: line.lineTotal,
      imageId: line.imageId,
    })),
    addOns: read.addOns.map((a) => ({ title: a.title, amount: a.amount, mode: a.mode })),
  };
}

// ----------------------------------------------------------------- operations

/**
 * `templates` IS TRAILING AND DEFAULTED, and that is what makes this change safe
 * to land on a live pipeline: every existing caller and every existing test
 * compiles untouched and gets the built-in wording, while the sweep — the one
 * caller that has a database handle to read overrides with — passes the set it
 * loaded. See `server/email/system-templates.ts` for why a failed load is not an
 * error but simply this default.
 */
export const markOrderPaid = (
  db: Db,
  orderId: string,
  now: number,
  link: AccessLink | null,
  claim: EventClaim | null,
  intentId: string | null = null,
  templates: TemplateSet = BUILT_IN,
): Promise<Order> =>
  transition(db, orderId, MARK_PAID, { link, intentId, templates }, now, claim);

export const cancelOrder = (
  db: Db,
  orderId: string,
  arg: {
    reason: OrderCancelReason;
    actorId: string | null;
    link: AccessLink | null;
    intentId?: string | null;
    templates?: TemplateSet;
    /** Minor units, already refunded before this call. See `withRefundedAmount`. */
    refundedAmount?: number;
  },
  now: number,
  claim: EventClaim | null,
): Promise<Order> => transition(db, orderId, CANCEL, arg, now, claim);

export const refundOrder = (
  db: Db,
  orderId: string,
  arg: {
    refundedAmount: number;
    refundedTotal: number;
    link: AccessLink | null;
    eventId: string;
    intentId?: string | null;
    templates?: TemplateSet;
  },
  now: number,
  claim: EventClaim | null,
): Promise<Order> => transition(db, orderId, APPLY_REFUND, arg, now, claim);

/**
 * The line-coverage half of the `paid → fulfilled` guard.
 *
 * "Every line of this order is covered by a fulfilment that has actually shipped."
 * Written as a correlated `NOT EXISTS` over an aggregate so that it is evaluated
 * INSIDE THE CAS PREDICATE, atomically with the status change — not read first and
 * trusted, which under READ COMMITTED would decide against a snapshot that a
 * concurrent cancel-fulfilment had already invalidated.
 *
 * `shipped` and `delivered` count; `pending` and `cancelled` do not. A parcel that
 * has been packed but not handed over has not fulfilled anything.
 *
 * NOTE THAT THIS IS NOT `fulfilled_qty`. That counter bounds how much MAY be
 * fulfilled and counts non-cancelled fulfilments including pending ones, which is
 * the right basis for the over-fulfilment CHECK and the wrong one for "has it
 * shipped". Two questions, two expressions, deliberately.
 */
const NOTHING_UNSHIPPED = sql`NOT EXISTS (
  SELECT 1 FROM shop_order_lines ol
   WHERE ol.order_id = shop_orders.id
     AND ol.qty > COALESCE((
           SELECT sum(fl.qty) FROM shop_fulfillment_lines fl
             JOIN shop_fulfillments f ON f.id = fl.fulfillment_id
            WHERE fl.order_line_id = ol.id
              AND f.status IN ('shipped', 'delivered')
         ), 0)
)`;

/**
 * `paid → fulfilled`, OPPORTUNISTICALLY. Returns `null` when there is nothing to do.
 *
 * WHY THIS IS NOT A `transition`. Every other lifecycle op is something a caller
 * ASKED for, so a guard that does not hold is a refusal the caller must be told
 * about — a 409. This one is asked for by nobody: it is called after each shipment
 * and its ordinary answer is "not yet, there are two parcels left". Raising
 * `PreconditionFailedError` for the common case would make the caller catch an
 * exception to discover that nothing was wrong, and would turn a partial shipment
 * into an error in a log.
 *
 * EXACTLY-ONCE `order.fulfilled` COMES FROM `status = 'paid'`, which can match only
 * once, and from the emit being in the same statement as the update. Not from a
 * check that the event has not already been written.
 *
 * The pin is still here and still load-bearing: a concurrent cancel moves the
 * generation, so a settle that raced it cannot mark a cancelled order fulfilled.
 */
export async function settleOrderFulfilled(
  db: Db,
  orderId: string,
  arg: { fulfillmentId: string; carrier: string | null; trackingNumber: string | null },
  now: number,
): Promise<Order | null> {
  let read = await readOrder(db, orderId);
  if (!read) return null;
  const pinned = read.generation;

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const base = read.order.revision;
    const payload = {
      orderId: read.order.id,
      orderNumber: read.order.orderNumber,
      fulfillmentId: arg.fulfillmentId,
      carrier: arg.carrier,
      trackingNumber: arg.trackingNumber,
      lines: lineRefs(read.lines),
      fulfilledAt: now,
    };

    const res = await db.execute(sql`
      WITH upd AS (
        UPDATE shop_orders
           SET status = 'fulfilled', fulfilled_at = ${now}, revision = revision + 1
         WHERE id = ${orderId}
           AND revision = ${base}
           AND lifecycle_generation = ${pinned}
           AND status = 'paid'
           AND ${NOTHING_UNSHIPPED}
        RETURNING ${sql.raw(ORDER_COLUMNS.join(', '))}
      ), emit AS (
        INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
        SELECT ${newId(ID.event)}, 'order.fulfilled', upd.id, ${jsonb(payload)}, ${now}
          FROM upd
        RETURNING 1
      )
      SELECT ${sql.raw(ORDER_COLUMNS.join(', '))} FROM upd`);

    const row = res.rows[0];
    if (row) return rowToOrder(row);

    const after = await readOrder(db, orderId);
    if (!after) return null;
    /*
     * An unmoved generation AND an unmoved revision means nothing changed under us,
     * so the guard is genuinely false — the order is not fully shipped, or is not
     * `paid`. That is the ordinary answer, so it is `null` rather than a retry.
     */
    if (after.generation === pinned && after.order.revision === base) return null;
    read = after;
  }
  return null;
}

/**
 * `payment.authorized` — RECORD ON THE TIMELINE, CHANGE NO STATUS (brief §4).
 *
 * There is no `authorized` order status, and adding one would be inventing a state
 * the brief's own table does not have. What the event is worth is the audit line:
 * "the provider had a hold at 14:02", which is the difference between a support
 * conversation that can be answered and one that cannot.
 *
 * NOT a `transition`: nothing is CAS'd because nothing on the order changes, so
 * there is no lost-update to protect against. The `(consumer, event_id)` primary key
 * is still what makes it exactly-once.
 */
export async function recordAuthorization(
  db: Db,
  orderId: string,
  eventId: string,
  now: number,
  intentId: string | null = null,
): Promise<boolean> {
  const res = await db.execute(sql`
    WITH claim AS (
      INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
      VALUES (${CONSUMER}, ${eventId}, ${now}, 'applied', NULL)
      ON CONFLICT DO NOTHING
      RETURNING event_id
    ), timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, ${orderId}, 'payment_authorized',
             'Payment authorized', ${now}, NULL
        FROM claim
      RETURNING 1
    ), intent AS (
      UPDATE shop_orders SET payment_intent_id = COALESCE(payment_intent_id, ${intentId})
        FROM claim WHERE shop_orders.id = ${orderId} AND ${intentId}::text IS NOT NULL
      RETURNING 1
    ), mark AS (
      UPDATE commerce_events SET processed_at = ${now}, last_error = NULL
        FROM claim WHERE commerce_events.id = ${eventId}
      RETURNING 1
    )
    SELECT event_id FROM claim`);
  return res.rows.length > 0;
}

/**
 * A refund the provider accepted later FAILED to settle — task-d4, and the
 * closest existing precedent is `recordAuthorization` immediately above: an
 * event that records something on the order WITHOUT a `shop_orders` status
 * transition, because none is wanted here either way.
 *
 * DELIBERATELY DOES NOT TOUCH `shop_orders.status`, and does not gate on what
 * it currently is. Two reasons, not one:
 *
 *  - By the time this webhook lands the order may already be `cancelled`
 *    (`b9051ab` refunds a paid order before cancelling it). Un-cancelling
 *    would be a SECOND, messier failure: the reservations were already
 *    released on cancel and the goods may already be gone. There is no
 *    transition back to `paid` to retry a refund from, and inventing one here
 *    would be a bigger, riskier change than this task is.
 *  - A refund can also fail on an order that was never cancelled at all — the
 *    standalone refund box against a `paid`/`fulfilled` order. This function
 *    does not need to know which case it is in: either way the money did not
 *    move and an operator needs to see that, which is all a timeline entry
 *    claims to do.
 *
 * The recovery is human — retry the refund, or pay the customer another way —
 * so this only makes the failure VISIBLE where an operator already looks: the
 * order's own history (`GET /admin/orders/:id`'s `timeline`, rendered by
 * `src/routes/ShopOrders.tsx`'s "History" panel). No new mechanism, matching
 * how `recordAuthorization` and every lifecycle transition already report to
 * the same place.
 *
 * AND THE CUSTOMER IS TOLD, which task-d4 scoped out and named as a follow-up
 * (§5 of its own report). The `mail` CTE below is the same shape `transition()`
 * gives `cancelOrder` and `refundOrder`, moved into a function that is not a
 * transition — because the ordering property it exists for is not about the
 * status change, it is about the CLAIM: the intent row is written in the SAME
 * STATEMENT as the timeline entry and the consumption, gated `FROM claim` like
 * everything else here, so a redelivered webhook cannot send the message twice
 * and a message cannot be written for a failure that was already recorded.
 *
 * UNCONDITIONAL, unlike `CANCEL`'s mail, which skips an order that was never
 * paid. There is no equivalent case to skip: a refund can only fail against a
 * capture that happened, so every order reaching this function has money of the
 * customer's that did not come back.
 *
 * TAKES THE `OrderRead` RATHER THAN AN `orderId`, and that is the one place its
 * signature departs from `cancelOrder`/`refundOrder`. Those pass an id because
 * `transition()` re-reads the order to CAS against a fresh revision; there is
 * no CAS here, so a re-read would buy nothing and cost the guarantee that the
 * guest link in the email and the message around it were rendered from the same
 * snapshot — the consumer has already read it, and mints the link from it.
 *
 * IDEMPOTENT THE SAME WAY AS `recordAuthorization`, AND TWICE OVER. Two
 * independent redelivery paths, two independent guards:
 *
 *  - THE PROVIDER REDELIVERS THE SAME WEBHOOK. `applyRefundEvent`'s own
 *    `settled` CTE (`refunds.ts`) is gated on `r.status = 'pending'`, so once
 *    a refund has settled to `failed` a second delivery of the same webhook
 *    updates nothing and `emitted_failed` mints no second `commerce_events`
 *    row. At most one `payment.refund_failed` row ever exists per refund.
 *  - THAT ONE ROW IS SWEPT MORE THAN ONCE (two overlapping cron runs). This
 *    is what `claim`'s `ON CONFLICT DO NOTHING` on `(consumer, event_id)` is
 *    for: every other CTE here reads `FROM claim`, so whichever call loses
 *    the race writes nothing at all — no second timeline entry, no error.
 */
export async function recordRefundFailure(
  db: Db,
  read: OrderRead,
  eventId: string,
  arg: {
    /** Minor units, positive — this refund alone, the money that did NOT move. */
    failedAmount: number;
    link: AccessLink | null;
    templates?: TemplateSet;
  },
  now: number,
): Promise<boolean> {
  const orderId = read.order.id;
  /*
   * Rendered BEFORE the statement, exactly as `transition()` renders in
   * `effects()` before assembling its CTEs: `renderRefundFailed` is pure and
   * synchronous, which is the whole reason `TemplateSet` resolves once per sweep
   * instead of being read here (see `server/email/system-templates.ts`).
   */
  const message = renderRefundFailed(
    { ...mailView(read), failedAmount: arg.failedAmount },
    arg.link,
    arg.templates ?? BUILT_IN,
  );
  /*
   * PER FAILURE EVENT, NOT PER ORDER — `APPLY_REFUND`'s key has the same shape
   * and the same reason. Two refunds against one order can each fail, and those
   * are two separate sums of money that did not arrive; collapsing them onto
   * `refund_failed:${orderId}` would silently swallow the second. The `FROM
   * claim` gate already stops a REDELIVERY of one failure, since at most one
   * outbox row exists per refund (`refunds.ts`'s `settled` CTE is gated on
   * `r.status = 'pending'`) — this is the second, independent guard, held by a
   * UNIQUE constraint rather than by that argument being right.
   */
  const dedupeKey = `refund_failed:${orderId}:${eventId}`;
  const res = await db.execute(sql`
    WITH claim AS (
      INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
      VALUES (${CONSUMER}, ${eventId}, ${now}, 'applied', NULL)
      ON CONFLICT DO NOTHING
      RETURNING event_id
    ), timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, ${orderId}, 'refund_failed',
             'Refund failed — needs attention', ${now}, NULL
        FROM claim
      RETURNING 1
    ), mail AS (
      INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject, body,
                                            html, created_at, dedupe_key)
      SELECT ${newId(ID.emailIntent)}, ${orderId}, 'refund_failed', ${message.to},
             ${message.subject}, ${message.body}, ${message.html ?? null}::text, ${now},
             ${dedupeKey}
        FROM claim
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING 1
    ), mark AS (
      UPDATE commerce_events SET processed_at = ${now}, last_error = NULL
        FROM claim WHERE commerce_events.id = ${eventId}
      RETURNING 1
    )
    SELECT event_id FROM claim`);
  return res.rows.length > 0;
}
