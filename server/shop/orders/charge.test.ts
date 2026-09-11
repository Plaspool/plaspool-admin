/**
 * WHAT WAS CHARGED, carried from `payment.captured` to the order (migration 1140).
 *
 * Naira is the only real price; a non-naira amount becomes real money only when
 * the payment link is created, and Payments puts what the gateway was asked for
 * on the capture as `charge`. Orders must:
 *
 *  1. parse it when present and keep parsing captures that predate it;
 *  2. store it in the SAME statement as the paid transition, idempotently, and
 *     never touch the naira totals;
 *  3. expose it beside the naira totals on every order read — driven here
 *     through the real `createApp()`, customer, guest and admin alike;
 *  4. show it in the confirmation and staff emails, and change NOTHING about a
 *     naira-only order's messages.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json, TEST_ORIGIN } from '../../test/http';
import { resetOrderTables } from './test/harness';
import { ordersClient, resetOrdersDeps, CUSTOMER_HEADER } from './test/app';
import {
  CHECKOUT,
  CUSTOMER_A,
  INTENT,
  T0,
  checkoutCompleted,
  consumptionOf,
  insertEvents,
  type EventFixture,
} from './test/fixtures';
import { parsePaymentCaptured } from './inbound';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { readOrderByCheckout, type OrderCharge } from './repo/orders';
import { listIntents } from './repo/emails';
import { formatAmount, formatCharged, renderConfirmation, type OrderMailView } from './mailer';
import { mintGuestToken } from './tokens';

let ctx: TestCtx;
const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: TEST_ORIGIN };
const STAFF_ADDRESS = 'packing@plaspool.com';

/** The worked example from `shared/commerce/fx.ts`: ₦83,300 charged as GH₵707.72. */
const NGN_TOTAL = 8_330_000;
const BREAKDOWN = {
  currency: 'GHS',
  exponent: 2,
  multiplier: '0.008496176720',
  amount: 70772,
  ngnTotal: NGN_TOTAL,
  components: [
    { kind: 'line', ref: 'var_x', ngnMinor: 7_980_000, multiplier: '0.008496176720', amount: 67799 },
    { kind: 'shipping', ref: null, ngnMinor: 350_000, multiplier: '0.008496176720', amount: 2974 },
  ],
};
const CEDI_CHARGE = {
  currency: 'GHS',
  amount: 70772,
  ratesRevision: 12,
  country: 'GH',
  breakdown: BREAKDOWN,
};
const NAIRA_CHARGE = {
  currency: 'NGN',
  amount: NGN_TOTAL,
  ratesRevision: null,
  country: 'NG',
  breakdown: null,
};

/** A naira checkout whose grand total is the worked example's. */
function nairaCheckout(): EventFixture {
  return checkoutCompleted({
    currency: 'NGN',
    subtotal: 7_980_000,
    shippingTotal: 350_000,
    taxTotal: 0,
    grandTotal: NGN_TOTAL,
    lines: [
      {
        variantId: 'var_x',
        sku: 'PLA-SILK',
        title: 'PLA Silk',
        optionValues: {},
        qty: 3,
        unitAmount: 2_660_000,
        lineTotal: 7_980_000,
      },
    ],
  });
}

/** The capture Payments emits, with or without a `charge` key. */
function capture(charge: unknown | undefined, id = 'evt_captured_1'): EventFixture {
  return {
    id,
    type: 'payment.captured',
    subjectId: INTENT,
    occurredAt: T0 + 1000,
    payload: {
      intentId: INTENT,
      checkoutId: CHECKOUT,
      amount: NGN_TOTAL,
      currency: 'NGN',
      occurredAt: T0 + 1000,
      ...(charge === undefined ? {} : { charge }),
    },
  };
}

async function paidWith(charge: unknown | undefined) {
  await insertEvents(ctx.db, [nairaCheckout(), capture(charge)]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  /* One staff recipient, so the staff alert is a single legible intent. */
  await ctx.db.execute(sql`
    UPDATE shop_notification_settings
       SET notify_team = false, notify_on_order = true,
           order_recipients = ARRAY[${STAFF_ADDRESS}]::text[]
     WHERE id = 'main'`);
});

// ------------------------------------------------------------------ 1. parse

describe('parsePaymentCaptured and the optional charge', () => {
  it('a capture with no charge key parses exactly as before', () => {
    const parsed = parsePaymentCaptured(capture(undefined).payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.charge).toBeUndefined();
    expect(parsed.value.amount).toBe(NGN_TOTAL);
  });

  it('reads a cedi charge, breakdown passed through as evidence', () => {
    const parsed = parsePaymentCaptured(capture(CEDI_CHARGE).payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.charge).toEqual(CEDI_CHARGE);
  });

  it('reads a naira charge with a null breakdown and revision', () => {
    const parsed = parsePaymentCaptured(capture(NAIRA_CHARGE).payload);
    expect(parsed.ok && parsed.value.charge).toEqual(NAIRA_CHARGE);
  });

  it.each([
    ['a lower-case currency', { ...CEDI_CHARGE, currency: 'ghs' }],
    ['a zero amount', { ...CEDI_CHARGE, amount: 0 }],
    ['a fractional amount', { ...CEDI_CHARGE, amount: 707.72 }],
    ['a three-letter country', { ...CEDI_CHARGE, country: 'GHA' }],
    ['a string revision', { ...CEDI_CHARGE, ratesRevision: '12' }],
    ['an array breakdown', { ...CEDI_CHARGE, breakdown: [] }],
  ])('refuses %s, naming the charge field', (_label, charge) => {
    const parsed = parsePaymentCaptured(capture(charge).payload);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toMatch(/charge/);
  });
});

// ------------------------------------------------------------------ 2. store

describe('the paid transition stores the charge', () => {
  it('writes the cedi charge onto the order and leaves the naira totals alone', async () => {
    const read = await paidWith(CEDI_CHARGE);
    expect(read.order.status).toBe('paid');
    expect(read.order.grandTotal).toBe(NGN_TOTAL);
    expect(read.order.currency).toBe('NGN');
    expect(read.order.charge).toEqual<OrderCharge>(CEDI_CHARGE);

    const raw = await ctx.db.execute(sql`
      SELECT charge_currency, charge_amount_minor, charge FROM shop_orders
       WHERE id = ${read.order.id}`);
    expect(raw.rows[0]).toMatchObject({
      charge_currency: 'GHS',
      charge_amount_minor: 70772,
      charge: { ratesRevision: 12, country: 'GH', breakdown: BREAKDOWN },
    });
  });

  it('stores a naira charge as NGN with no breakdown', async () => {
    const read = await paidWith(NAIRA_CHARGE);
    expect(read.order.charge).toEqual(NAIRA_CHARGE);
  });

  it('a pre-1140 capture pays the order and leaves the charge null', async () => {
    const read = await paidWith(undefined);
    expect(read.order.status).toBe('paid');
    expect(read.order.charge).toBeNull();
  });

  it('a redelivered capture is refused and cannot overwrite the charge', async () => {
    const read = await paidWith(CEDI_CHARGE);
    /* A second capture for the same checkout under a fresh event id, claiming
       a different charge — the realistic replay a leaked webhook could mint. */
    await insertEvents(ctx.db, [
      capture({ ...CEDI_CHARGE, amount: 1, ratesRevision: 99 }, 'evt_captured_2'),
    ]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 1);

    expect((await consumptionOf(ctx.db, 'evt_captured_2'))?.outcome).toBe('ignored');
    const after = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    expect(after.order.charge).toEqual(CEDI_CHARGE);
    expect(after.order.revision).toBe(read.order.revision);
  });

  it('a capture this build cannot read parks and pays nothing', async () => {
    await insertEvents(ctx.db, [nairaCheckout(), capture({ ...CEDI_CHARGE, currency: 'cedi' })]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    expect(read.order.status).toBe('pending');
    expect(read.order.charge).toBeNull();
  });
});

// ------------------------------------------------------ 3. expose, via createApp

describe('every order read exposes the charge beside the naira totals', () => {
  type Body = { order: { grandTotal: number; currency: string; charge: unknown } };

  it('customer detail, customer list, guest token view, admin detail and admin list', async () => {
    const read = await paidWith(CEDI_CHARGE);
    const c = ordersClient(ctx.db, { now: () => NOW });

    const own = { [CUSTOMER_HEADER]: CUSTOMER_A };
    const detail = await json<Body>(
      await c.get(`/api/shop/orders/${read.order.orderNumber}`, { headers: own }),
    );
    expect(detail.order.grandTotal).toBe(NGN_TOTAL);
    expect(detail.order.currency).toBe('NGN');
    expect(detail.order.charge).toEqual(CEDI_CHARGE);

    const list = await json<{ items: Body[] }>(await c.get('/api/shop/orders', { headers: own }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].order.charge).toEqual(CEDI_CHARGE);

    const token = mintGuestToken({ orderNumber: read.order.orderNumber, email: read.order.email }, NOW);
    const guest = await json<Body>(
      await c.get(`/api/shop/orders/${read.order.orderNumber}?token=${encodeURIComponent(token)}`),
    );
    expect(guest.order.charge).toEqual(CEDI_CHARGE);

    await c.signIn(ctx.users.owner);
    const admin = await json<Body>(await c.get(`/api/shop/admin/orders/${read.order.id}`));
    expect(admin.order.grandTotal).toBe(NGN_TOTAL);
    expect(admin.order.charge).toEqual(CEDI_CHARGE);

    const byNumber = await json<Body>(
      await c.get(`/api/shop/admin/orders/by-number/${read.order.orderNumber}`),
    );
    expect(byNumber.order.charge).toEqual(CEDI_CHARGE);

    const adminList = await json<{ items: Body[] }>(await c.get('/api/shop/admin/orders'));
    expect(adminList.items[0].order.charge).toEqual(CEDI_CHARGE);

    const searched = await json<{ items: Body[] }>(
      await c.get(`/api/shop/admin/orders?search=${encodeURIComponent(read.order.orderNumber)}`),
    );
    expect(searched.items[0].order.charge).toEqual(CEDI_CHARGE);
  });

  it('is null — present, not absent — on an order with no recorded charge', async () => {
    const read = await paidWith(undefined);
    const c = ordersClient(ctx.db, { now: () => NOW });
    const detail = await json<Body>(
      await c.get(`/api/shop/orders/${read.order.orderNumber}`, {
        headers: { [CUSTOMER_HEADER]: CUSTOMER_A },
      }),
    );
    expect(detail.order).toHaveProperty('charge', null);
  });
});

// ------------------------------------------------------------------ 4. emails

describe('the confirmation and staff emails show the charge', () => {
  it('the confirmation says "charged GH₵707.72" beside the naira total', async () => {
    const read = await paidWith(CEDI_CHARGE);
    const intents = await listIntents(ctx.db, read.order.id);

    const confirmation = intents.find((i) => i.kind === 'confirmation')!;
    expect(confirmation.body).toContain('Total: 83300.00 NGN · charged GH₵707.72');
    expect(confirmation.html).toContain('83300.00 NGN · charged GH₵707.72');

    /* The "we have your order" mail was written before any payment, so it
       cannot know the charge — and must not pretend to. */
    const placed = intents.find((i) => i.kind === 'placed')!;
    expect(placed.body).not.toContain('charged');

    const staff = intents.find((i) => i.kind === 'staff_new_order')!;
    expect(staff.to).toBe(STAFF_ADDRESS);
    expect(staff.subject).toContain('83300.00 NGN · charged GH₵707.72');
    expect(staff.body).toContain('Total: 83300.00 NGN · charged GH₵707.72');
  });

  it('a naira charge and no charge both render the confirmation byte-for-byte as before', async () => {
    const view: OrderMailView = {
      orderNumber: '2026-000001-X',
      email: 'buyer@example.test',
      currency: 'NGN',
      grandTotal: NGN_TOTAL,
      placedAt: T0,
      lines: [{ title: 'PLA Silk', sku: 'PLA-SILK', qty: 3, lineTotal: 7_980_000 }],
    };
    const before = renderConfirmation(view, null);
    expect(renderConfirmation({ ...view, charge: null }, null)).toEqual(before);
    expect(
      renderConfirmation({ ...view, charge: { amount: NGN_TOTAL, currency: 'NGN' } }, null),
    ).toEqual(before);
    expect(before.body).toContain(`Total: ${formatAmount(NGN_TOTAL, 'NGN')}\n`);
    expect(before.body).not.toContain('charged');

    /* And through the consumer: the stored intents carry no "charged". */
    const read = await paidWith(NAIRA_CHARGE);
    for (const intent of await listIntents(ctx.db, read.order.id)) {
      expect(intent.body).not.toContain('charged');
      expect(intent.subject).not.toContain('charged');
    }
  });

  it('formats each currency by its own exponent, never an assumed /100', () => {
    expect(formatCharged(70772, 'GHS')).toBe('GH₵707.72');
    expect(formatCharged(123450, 'KES')).toBe('KSh 1,234.50');
    expect(formatCharged(70772, 'UGX')).toBe('USh 70,772');
    expect(formatCharged(70772, 'XOF')).toBe('CFA 70,772');
    expect(formatCharged(70772, 'XAF')).toBe('FCFA 70,772');
    expect(formatCharged(5005, 'RWF')).toBe('RF 5,005');
    expect(formatCharged(199, 'USD')).toBe('$1.99');
    expect(formatCharged(5, 'GBP')).toBe('£0.05');
    expect(formatCharged(100000, 'ZAR')).toBe('R1,000.00');
    /* A currency with no known exponent prints nothing rather than a guess. */
    expect(formatCharged(100, 'JPY')).toBeNull();
  });
});
