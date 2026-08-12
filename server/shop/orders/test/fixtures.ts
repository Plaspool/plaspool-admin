import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';

/**
 * A FIXTURE FILE OF `commerce_events` ROWS. This is the artefact brief §4 asks for
 * "from hour one", and it is what keeps this subsystem off everybody's critical path:
 * every test in this directory drives the whole thing from rows written here, with
 * **Catalog, Cart and Payments not existing**.
 *
 * THE ROWS ARE WRITTEN AS RAW `jsonb`, NOT BUILT THROUGH `commerceEvent()`. Two
 * reasons, and both are the point rather than a shortcut:
 *
 *  1. `CommerceEventPayloads['checkout.completed']` is `never` — Cart owns that arm
 *     and has not declared it. A typed builder literally cannot construct one.
 *  2. Even when it can, a typed builder would test the wrong thing. The payload this
 *     subsystem actually reads came out of a `jsonb` column, written by a different
 *     deploy of a different subsystem, possibly by a backfill. A fixture that is
 *     type-checked against the consumer's own expectations cannot exercise the case
 *     where the two disagree — which is the case every round of both gauntlets has
 *     found. So the fixtures are plain data, and some of them are deliberately wrong.
 *
 * `occurredAt` IS EXPLICIT ON EVERY ROW, never `Date.now()`. The sweeper processes in
 * `occurred_at` order, so "out of order" has to be something a test can state rather
 * than something it has to arrange by timing.
 */

export interface EventFixture {
  id: string;
  type: string;
  subjectId: string;
  payload: unknown;
  occurredAt: number;
}

/** A fixed clock. Every fixture time is an offset from it, so nothing depends on today. */
export const T0 = 1_700_000_000_000;

export const CHECKOUT = 'chk_0001';
export const INTENT = 'pi_0001';
export const CUSTOMER_A = 'cus_aaaa';
export const CUSTOMER_B = 'cus_bbbb';
export const CURRENCY = 'USD';

/**
 * The canonical two-line checkout.
 *
 * `subtotal + shipping + tax` HAPPENS TO EQUAL `grandTotal` here, and no code
 * anywhere checks that. It is arithmetic Cart owns; the fixture in
 * `checkoutWithInconsistentTotals` deliberately breaks it to prove this subsystem
 * copies rather than derives.
 */
export function checkoutCompleted(overrides: Partial<CheckoutPayload> = {}): EventFixture {
  return {
    id: 'evt_checkout_1',
    type: 'checkout.completed',
    subjectId: CHECKOUT,
    occurredAt: T0,
    payload: { ...basePayload(), ...overrides },
  };
}

export interface CheckoutPayload {
  checkoutId: string;
  customerId: string | null;
  email: string;
  currency: string;
  subtotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  lines: unknown[];
}

function basePayload(): CheckoutPayload {
  return {
    checkoutId: CHECKOUT,
    customerId: CUSTOMER_A,
    email: 'Buyer@Example.test',
    currency: CURRENCY,
    subtotal: 4500,
    shippingTotal: 500,
    taxTotal: 400,
    grandTotal: 5400,
    shippingAddress: { name: 'A Buyer', line1: '1 Test Street', country: 'GB' },
    billingAddress: { name: 'A Buyer', line1: '1 Test Street', country: 'GB' },
    lines: [
      {
        variantId: 'var_mug_navy',
        sku: 'MUG-NAVY',
        title: 'Enamel Mug',
        optionValues: { Colour: 'Navy' },
        qty: 2,
        unitAmount: 1500,
        lineTotal: 3000,
      },
      {
        variantId: 'var_tee_m',
        sku: 'TEE-M',
        title: 'Logo T-Shirt',
        optionValues: { Size: 'M' },
        qty: 1,
        unitAmount: 1500,
        lineTotal: 1500,
      },
    ],
  };
}

/**
 * The same checkout with totals that do not add up.
 *
 * IT MUST BE STORED VERBATIM. The brief's working rule is "never recompute a total —
 * copy the frozen ones", and the only way to prove a consumer obeys that is to hand it
 * numbers that a recomputation would visibly change. A subsystem that "helpfully"
 * corrected these would be one that disagreed with the amount actually charged.
 */
export const checkoutWithInconsistentTotals = (): EventFixture =>
  checkoutCompleted({ subtotal: 1, shippingTotal: 1, taxTotal: 1, grandTotal: 5400 });

/** Tolerance 3 (see `inbound.ts`): the totals nested under `totals`. */
export function checkoutWithNestedTotals(): EventFixture {
  const { subtotal, shippingTotal, taxTotal, grandTotal, ...rest } = basePayload();
  return {
    id: 'evt_checkout_nested',
    type: 'checkout.completed',
    subjectId: CHECKOUT,
    occurredAt: T0,
    payload: { ...rest, totals: { subtotal, shippingTotal, taxTotal, grandTotal } },
  };
}

/** Tolerances 1 and 2: no `checkoutId` in the payload, and `Money` objects for amounts. */
export function checkoutWithMoneyObjects(): EventFixture {
  const base = basePayload();
  const money = (amount: number) => ({ amount, currency: CURRENCY });
  const { checkoutId: _omitted, ...rest } = base;
  return {
    id: 'evt_checkout_money',
    type: 'checkout.completed',
    subjectId: CHECKOUT,
    occurredAt: T0,
    payload: {
      ...rest,
      subtotal: money(base.subtotal),
      shippingTotal: money(base.shippingTotal),
      taxTotal: money(base.taxTotal),
      grandTotal: money(base.grandTotal),
      lines: [
        {
          variantId: 'var_mug_navy',
          sku: 'MUG-NAVY',
          title: 'Enamel Mug',
          optionValues: { Colour: 'Navy' },
          qty: 2,
          unitAmount: money(1500),
          lineTotal: money(3000),
        },
      ],
    },
  };
}

/** A payload this build cannot read: `lines` is not an array. */
export const checkoutMalformed = (): EventFixture => ({
  id: 'evt_checkout_bad',
  type: 'checkout.completed',
  subjectId: CHECKOUT,
  occurredAt: T0,
  payload: { ...basePayload(), lines: 'two things' },
});

/** A line priced in a currency the order is not in. Never guessed at. */
export const checkoutCurrencyMismatch = (): EventFixture => ({
  id: 'evt_checkout_ccy',
  type: 'checkout.completed',
  subjectId: CHECKOUT,
  occurredAt: T0,
  payload: {
    ...basePayload(),
    lines: [
      {
        variantId: 'var_mug_navy',
        sku: 'MUG-NAVY',
        title: 'Enamel Mug',
        optionValues: {},
        qty: 1,
        unitAmount: { amount: 1500, currency: 'GBP' },
        lineTotal: { amount: 1500, currency: 'GBP' },
      },
    ],
  },
});

// -------------------------------------------------------------------- payment.*

interface PaymentOverrides {
  id?: string;
  checkoutId?: string;
  amount?: number;
  occurredAt?: number;
}

const paymentBase = (o: PaymentOverrides) => ({
  intentId: INTENT,
  checkoutId: o.checkoutId ?? CHECKOUT,
  amount: o.amount ?? 5400,
  currency: CURRENCY,
  occurredAt: o.occurredAt ?? T0 + 1000,
});

export const paymentAuthorized = (o: PaymentOverrides = {}): EventFixture => ({
  id: o.id ?? 'evt_auth_1',
  type: 'payment.authorized',
  subjectId: INTENT,
  occurredAt: o.occurredAt ?? T0 + 500,
  payload: paymentBase(o),
});

export const paymentCaptured = (o: PaymentOverrides = {}): EventFixture => ({
  id: o.id ?? 'evt_captured_1',
  type: 'payment.captured',
  subjectId: INTENT,
  occurredAt: o.occurredAt ?? T0 + 1000,
  payload: paymentBase(o),
});

export const paymentFailed = (
  o: PaymentOverrides & { reason?: string } = {},
): EventFixture => ({
  id: o.id ?? 'evt_failed_1',
  type: 'payment.failed',
  subjectId: INTENT,
  occurredAt: o.occurredAt ?? T0 + 1000,
  payload: { ...paymentBase(o), reason: o.reason ?? 'declined' },
});

export const paymentRefunded = (
  o: PaymentOverrides & { refundedAmount?: number; refundedTotal?: number; refundId?: string } = {},
): EventFixture => {
  const refundedAmount = o.refundedAmount ?? 5400;
  const refundedTotal = o.refundedTotal ?? refundedAmount;
  return {
    id: o.id ?? 'evt_refund_1',
    type: 'payment.refunded',
    subjectId: INTENT,
    occurredAt: o.occurredAt ?? T0 + 2000,
    payload: {
      ...paymentBase(o),
      refundId: o.refundId ?? 'ref_0001',
      refundedAmount,
      refundedTotal,
      remainingBalance: 5400 - refundedTotal,
    },
  };
};

/**
 * A type nobody in this build has heard of.
 *
 * §6 rule 4's whole reason for existing: this subsystem must ignore and log it rather
 * than throw, or Payments could not ship an event type before Orders was rebuilt —
 * which is the entire premise of building four subsystems at once.
 */
export const unknownType = (): EventFixture => ({
  id: 'evt_unknown_1',
  type: 'loyalty.points.awarded',
  subjectId: 'lty_0001',
  occurredAt: T0 + 10,
  payload: { points: 40 },
});

/** A type this build knows and does not handle — including its own emissions. */
export const otherSubsystemEvent = (): EventFixture => ({
  id: 'evt_catalog_1',
  type: 'catalog.inventory.adjusted',
  subjectId: 'var_mug_navy',
  occurredAt: T0 + 20,
  payload: { variantId: 'var_mug_navy', delta: -1, onHand: 9, reason: 'breakage', actorId: 'u1' },
});

// -------------------------------------------------------------------- writing

/**
 * Write fixtures into the outbox exactly as a producer would.
 *
 * `processed_at` IS LEFT NULL AND `attempts` AT 0, because a producer never sets them
 * — contract §6 says they are consumer bookkeeping, and an emitter that could write
 * them could mark its own event handled.
 */
export async function insertEvents(db: Db, rows: EventFixture[]): Promise<void> {
  for (const row of rows) {
    await db.execute(sql`
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
      VALUES (${row.id}, ${row.type}, ${row.subjectId},
              ${sql`${JSON.stringify(row.payload)}::jsonb`}, ${row.occurredAt})`);
  }
}

/** The state of an outbox row, for asserting on a park. */
export interface OutboxState {
  processedAt: number | null;
  attempts: number;
  lastError: string | null;
}

export async function outboxState(db: Db, eventId: string): Promise<OutboxState> {
  const res = await db.execute(sql`
    SELECT processed_at, attempts, last_error FROM commerce_events WHERE id = ${eventId}`);
  const row = res.rows[0];
  return {
    processedAt: row.processed_at == null ? null : Number(row.processed_at),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

/** Everything this consumer has recorded about an event, or `null`. */
export async function consumptionOf(
  db: Db,
  eventId: string,
): Promise<{ outcome: string; detail: string | null } | null> {
  const res = await db.execute(sql`
    SELECT outcome, detail FROM shop_order_event_consumptions
     WHERE consumer = 'orders' AND event_id = ${eventId}`);
  const row = res.rows[0];
  return row
    ? { outcome: String(row.outcome), detail: row.detail == null ? null : String(row.detail) }
    : null;
}

/** Every event this subsystem has EMITTED, oldest first. */
export async function emittedEvents(
  db: Db,
): Promise<{ id: string; type: string; subjectId: string; payload: Record<string, unknown> }[]> {
  const res = await db.execute(sql`
    SELECT id, type, subject_id, payload FROM commerce_events
     WHERE type LIKE 'order.%' ORDER BY occurred_at ASC, id ASC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    subjectId: String(row.subject_id),
    payload: row.payload as Record<string, unknown>,
  }));
}
