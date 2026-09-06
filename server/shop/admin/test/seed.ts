import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { ID, newId } from '../../orders/ids';
import { formatOrderNumber } from '../../orders/order-number';
import type { OrderStatus } from '../../orders/repo/orders';

/**
 * Seeding for the dashboard suites.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE ORDERS ARE INSERTED DIRECTLY, AND THAT IS A DELIBERATE DEPARTURE FROM
 * `server/shop/orders/test/fixtures.ts`, WHICH DRIVES THE REAL EVENT PATH.
 *
 * Every number this directory computes is a function of four columns —
 * `status`, `currency`, `grand_total`, `refunded_total` — and two clocks:
 * `placed_at` and `paid_at`. Producing a corpus that spans thirty days, four
 * statuses and three buyers through `checkout.completed` → sweep →
 * `markOrderPaid` would mean minting an event per order and then UPDATE-ing the
 * two timestamps back into the past anyway, because a transition writes `now`.
 * That is more machinery between the test and the assertion, not less, and it
 * would make a suite about arithmetic read as a suite about the outbox.
 *
 * WHAT KEEPS THAT HONEST is `routes.test.ts`'s "the real path lands in the
 * aggregates" case, which builds ONE order through `insertEvents` +
 * `sweepCommerceEvents` + `markOrderPaid` and asserts the stats route counts it.
 * A column this helper forgot to set, or set differently from the way production
 * sets it, fails there. Hand-built rows plus one end-to-end pin is the trade;
 * hand-built rows alone would not be.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOTHING HERE BYPASSES A CONSTRAINT. An INSERT is still checked by
 * `shop_orders_status_ck`, `shop_orders_currency_ck`, `shop_orders_revision_ck`,
 * `shop_orders_refunded_ck` and `shop_orders_email_ck`, and every UNIQUE index
 * still applies — so a seed that writes a state the schema forbids fails loudly
 * rather than producing a corpus production could never contain.
 */

/** A fixed clock, as `fixtures.ts` has one, so no assertion depends on today. */
export const S0 = 1_780_000_000_000;

/**
 * Order numbers must be unique (`shop_orders_order_number_uq`) and the sequence
 * that normally mints them is not involved here, so the counter lives beside the
 * helper. Monotonic across a whole suite, which also makes the numbers readable
 * in a failure message.
 */
let sequence = 0;

export interface SeedOrderOptions {
  email?: string;
  customerId?: string | null;
  status?: OrderStatus;
  currency?: string;
  /** Minor units. */
  grandTotal?: number;
  /** The split under the grand total. Defaults: no delivery, no tax, and the
   *  subtotal carrying whatever is left — so an order seeded with only a
   *  grand total is all item prices, and one seeded with a subtotal that
   *  does not add up to the grand total carries a discount of the gap. */
  subtotal?: number;
  shippingTotal?: number;
  taxTotal?: number;
  refundedTotal?: number;
  placedAt?: number;
  /** Null for an order that was never paid — which is what excludes it from revenue. */
  paidAt?: number | null;
}

export interface SeededOrder {
  id: string;
  orderNumber: string;
  email: string;
  placedAt: number;
}

/**
 * One order row, with the totals and both clocks under the caller's control.
 *
 * BY DEFAULT `subtotal` carries the whole of `grandTotal` and shipping and
 * tax are zero. Since 2026-09-06 the aggregates DO read the split (sales are
 * item prices; delivery, VAT and discounts are named separately), so a test
 * about that split passes the three components explicitly.
 */
export async function seedOrder(db: Db, o: SeedOrderOptions = {}): Promise<SeededOrder> {
  sequence += 1;
  const id = newId(ID.order);
  const orderNumber = formatOrderNumber(2026, sequence);
  const email = o.email ?? 'buyer@example.test';
  const placedAt = o.placedAt ?? S0;
  const grandTotal = o.grandTotal ?? 5000;
  const shippingTotal = o.shippingTotal ?? 0;
  const taxTotal = o.taxTotal ?? 0;
  const subtotal = o.subtotal ?? grandTotal - shippingTotal - taxTotal;

  await db.execute(sql`
    INSERT INTO shop_orders (
      id, order_number, customer_id, email, currency,
      subtotal, shipping_total, tax_total, grand_total, refunded_total,
      status, shipping_address, billing_address,
      placed_at, paid_at, revision, source_event_id, checkout_id)
    VALUES (
      ${id}, ${orderNumber}, ${o.customerId ?? null}, ${email}, ${o.currency ?? 'GBP'},
      ${subtotal}, ${shippingTotal}, ${taxTotal}, ${grandTotal}, ${o.refundedTotal ?? 0},
      ${o.status ?? 'paid'}, '{}'::jsonb, '{}'::jsonb,
      ${placedAt}, ${o.paidAt === undefined ? placedAt : o.paidAt}, 1,
      ${`evt_seed_${id}`}, ${`chk_seed_${id}`})`);

  return { id, orderNumber, email, placedAt };
}

export interface SeedIntentOptions {
  sentAt?: number | null;
  attempts?: number;
  lastError?: string | null;
}

/**
 * One row of the order email outbox.
 *
 * `dedupe_key` IS DERIVED FROM THE ROW ID rather than from the order, because
 * `shop_order_email_intents_dedupe_uq` enforces "one confirmation per order" and
 * a suite that wants three unsent intents on one order would otherwise be
 * fighting a constraint that exists for production's benefit, not this test's.
 */
export async function seedEmailIntent(
  db: Db,
  orderId: string,
  o: SeedIntentOptions = {},
): Promise<string> {
  const id = newId(ID.emailIntent);
  await db.execute(sql`
    INSERT INTO shop_order_email_intents (
      id, order_id, kind, to_email, subject, body,
      created_at, sent_at, attempts, last_error, dedupe_key)
    VALUES (
      ${id}, ${orderId}, 'confirmation', 'buyer@example.test', 'Order confirmed', 'body',
      ${S0}, ${o.sentAt ?? null}, ${o.attempts ?? 0}, ${o.lastError ?? null}, ${id})`);
  return id;
}

/**
 * A `shop_customers` row — an account, which is NOT the same thing as a buyer.
 *
 * Seeded only so the buyer list has something to LEFT JOIN to. The point of
 * `listBuyers` is that a buyer with no row here still appears, so most of that
 * suite deliberately does not call this.
 */
export async function seedCustomer(
  db: Db,
  o: { id?: string; email: string; displayName?: string },
): Promise<string> {
  const id = o.id ?? `cus_${Math.random().toString(36).slice(2, 12)}`;
  await db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${id}, ${o.email}, ${o.displayName ?? null}, ${S0})`);
  return id;
}
