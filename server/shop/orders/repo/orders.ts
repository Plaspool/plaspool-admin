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
import type { AccessLink } from '../mailer';
import { renderCancellation, renderConfirmation, renderRefund } from '../mailer';

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
  | 'refunded';

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
  refundedTotal: number;
  status: OrderStatus;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  placedAt: number;
  paidAt: number | null;
  fulfilledAt: number | null;
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
    refundedTotal: Number(row.refunded_total),
    status: row.status as OrderStatus,
    shippingAddress: row.shipping_address as Record<string, unknown>,
    billingAddress: row.billing_address as Record<string, unknown>,
    placedAt: toEpochMs(row.placed_at),
    paidAt: toEpochMsOrNull(row.paid_at),
    fulfilledAt: toEpochMsOrNull(row.fulfilled_at),
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
  generation: number;
}

const LINE_AGG = sql`
  COALESCE((
    SELECT json_agg(to_jsonb(l) ORDER BY l.line_no)
      FROM shop_order_lines l WHERE l.order_id = o.id
  ), '[]'::json) AS lines`;

function rowToRead(row: Record<string, unknown>): OrderRead {
  const lines = (row.lines as Record<string, unknown>[]) ?? [];
  return {
    order: rowToOrder(row),
    lines: lines.map(rowToLine),
    generation: Number(row.lifecycle_generation),
  };
}

async function readByColumn(db: Db, column: SQL, value: string): Promise<OrderRead | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${LINE_AGG}
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
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${LINE_AGG}
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
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${LINE_AGG}
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
    SELECT ${sql.raw(orderColumns('o'))}, o.lifecycle_generation, ${LINE_AGG}
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

    try {
      const res = await db.execute(sql`
        WITH ord AS (
          INSERT INTO shop_orders (
            id, order_number, customer_id, email, currency,
            subtotal, shipping_total, tax_total, grand_total,
            status, shipping_address, billing_address, placed_at,
            revision, source_event_id, checkout_id,
            redemption_points, redemption_email)
          VALUES (
            ${orderId}, ${orderNumber}, ${input.customerId}, ${input.email}, ${input.currency},
            ${input.subtotal}, ${input.shippingTotal}, ${input.taxTotal}, ${input.grandTotal},
            'pending', ${jsonb(input.shippingAddress)}, ${jsonb(input.billingAddress)},
            ${event.occurredAt}, 1, ${event.id}, ${input.checkoutId},
            ${input.redemption?.points ?? null}::integer,
            ${input.redemption?.email ?? null}::text)
          RETURNING ${sql.raw(ORDER_COLUMNS.join(', '))}
        ), ins_lines AS (
          INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                        option_values, qty, unit_amount, line_total)
          SELECT l.id, ord.id, l.line_no, l.variant_id, l.sku, l.title,
                 l.option_values, l.qty, l.unit_amount, l.line_total
            FROM ord, jsonb_to_recordset(${jsonb(lines)}) AS l(
                   id text, line_no integer, variant_id text, sku text, title text,
                   option_values jsonb, qty integer, unit_amount integer, line_total integer)
          RETURNING id, line_no, variant_id, sku, title, option_values, qty,
                    unit_amount, line_total, fulfilled_qty
        ), timeline AS (
          INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
          SELECT ${newId(ID.timeline)}, ord.id, 'placed',
                 'Order placed', ${event.occurredAt}, NULL
            FROM ord
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
  mail?: { kind: 'confirmation' | 'cancellation' | 'refund'; dedupeKey: string; to: string; subject: string; body: string };
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
                                              created_at, dedupe_key)
        SELECT ${newId(ID.emailIntent)}, upd.id, ${effects.mail.kind}, ${effects.mail.to},
               ${effects.mail.subject}, ${effects.mail.body}, ${now}, ${effects.mail.dedupeKey}
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

// ------------------------------------------------------------ the transitions

const MARK_PAID: Transition<{ link: AccessLink | null; intentId: string | null }> = {
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
      ...renderConfirmation(mailView(read), arg.link),
    },
  }),
};

const CANCEL: Transition<{
  reason: OrderCancelReason;
  actorId: string | null;
  link: AccessLink | null;
  intentId?: string | null;
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
    sql`status = 'cancelled', cancelled_at = ${now}${rememberIntent(arg.intentId)}`,
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
            ...renderCancellation(mailView(read), arg.link),
          },
  }),
};

const APPLY_REFUND: Transition<{
  refundedAmount: number;
  refundedTotal: number;
  link: AccessLink | null;
  eventId: string;
  intentId?: string | null;
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
      ),
    },
  }),
};

function mailView(read: OrderRead) {
  return {
    orderNumber: read.order.orderNumber,
    email: read.order.email,
    currency: read.order.currency,
    grandTotal: read.order.grandTotal,
    lines: read.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      qty: line.qty,
      lineTotal: line.lineTotal,
    })),
  };
}

// ----------------------------------------------------------------- operations

export const markOrderPaid = (
  db: Db,
  orderId: string,
  now: number,
  link: AccessLink | null,
  claim: EventClaim | null,
  intentId: string | null = null,
): Promise<Order> => transition(db, orderId, MARK_PAID, { link, intentId }, now, claim);

export const cancelOrder = (
  db: Db,
  orderId: string,
  arg: {
    reason: OrderCancelReason;
    actorId: string | null;
    link: AccessLink | null;
    intentId?: string | null;
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
