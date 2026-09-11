/**
 * NAIRA IS THE ONLY REAL PRICE; A CURRENCY BECOMES MONEY AT THE PAYMENT LINK
 * (migration 1140). Driven through the REAL `createApp()` — CLAUDE.md §2: every
 * money-adjacent bug this codebase shipped hid behind a test app — with a
 * `FakeProvider` standing in for each gateway's network boundary only.
 *
 * The frozen checkout is the owner's worked example: three spools at the
 * ₦26,600 bulk price (7,980,000 kobo), ₦4,500 delivery, ₦1,000 of points.
 * At GHS 0.008496176720 its components convert to 67799 + 3823 − 850 = 70772
 * pesewas, where converting the ₦83,300 total would give 70773.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, TEST_ORIGIN } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { FakeProvider } from './provider/fake';
import { getIntent } from './intents';
import { processEvent, storeEvent } from './webhook';
import { providerReferenceFor } from './ids';
import { seedProduct, seedVariant } from '../catalog/test/catalog-harness';
import { convertMinor, parseMultiplier } from '../../../shared/commerce/fx';
import type { ProviderEvent } from './provider/types';

let ctx: TestCtx;
let paystack: FakeProvider;
let flw: FakeProvider;
let client: HttpClient;

const GHS_E12 = 8496176720n;
const REVISION = 5;
const HOUR = 3_600_000;
let seq = 0;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  paystack = new FakeProvider({ name: 'paystack' });
  flw = new FakeProvider({ name: 'flutterwave', capabilities: { currencies: ['NGN', 'GHS', 'UGX', 'USD'] } });
  client = httpClient(ctx.db, { factories: { paystack: () => paystack, flutterwave: () => flw } });
  await ctx.db.execute(sql`TRUNCATE shop_refunds, shop_payment_events, shop_payment_intents CASCADE`);
  await ctx.db.execute(sql`DELETE FROM shop_fx_rates`);
  await ctx.db.execute(sql`DELETE FROM shop_variant_multipliers`);
  await ctx.db.execute(sql`
    UPDATE shop_payment_settings SET flutterwave_currencies = '{NGN,GHS,UGX,USD}' WHERE id = 'main'`);
  await ctx.db.execute(sql`
    UPDATE shop_currency_settings SET enabled = '{NGN,GHS,UGX}', revision = ${REVISION},
           staleness_hours = 168 WHERE id = 'main'`);
  await ctx.db.execute(sql`
    INSERT INTO shop_fx_rates (currency, multiplier_e12, source, updated_at) VALUES
      ('GHS', ${GHS_E12.toString()}::bigint, 'feed', ${Date.now()}),
      ('UGX', 2387654321000, 'manual', 0)`);
});

// ─────────────────────────────────────────────────────────────── fixtures

const ngn = (amount: number) => ({ amount, currency: 'NGN' });

/** A frozen (`converting`) cart — the owner's example — addressed to `country`. */
async function frozenCart(country = 'GH', variantId = 'var_spool'): Promise<string> {
  seq += 1;
  const cartId = `crt_fx_${seq}_${Date.now().toString(36)}`;
  const totals = {
    currency: 'NGN',
    lines: [
      {
        variantId,
        qty: 3,
        unit: ngn(2800000),
        bulkQty: 3,
        bulkPercentBps: 500,
        effectiveUnit: ngn(2660000),
        lineTotal: ngn(7980000),
        taxable: true,
        taxAmount: ngn(0),
      },
    ],
    shipping: { id: 'ship_standard', label: 'Delivery', amount: ngn(450000), taxable: false },
    tax: { zone: 'test', label: 'none', rateBps: 0 },
    adjustments: [{ code: 'points', label: 'SpoolPoints', amount: ngn(-100000) }],
    discount: null,
    addOns: [],
    addOnTotal: ngn(0),
    subtotal: ngn(7980000),
    discountTotal: ngn(0),
    adjustmentTotal: ngn(-100000),
    shippingTotal: ngn(450000),
    taxTotal: ngn(0),
    grandTotal: ngn(8330000),
    rounding: 'half-up',
  };
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO shop_carts
      (id, customer_id, currency, status, email, tax_zone,
       frozen_totals, frozen_lines, frozen_at, created_at, updated_at, expires_at, revision)
    VALUES (${cartId}, NULL, 'NGN', 'converting', 'buyer@fx.test', 'test',
            ${JSON.stringify(totals)}::jsonb, '[]'::jsonb, ${now}, ${now}, ${now}, ${now + 900_000}, 1)`);
  await ctx.db.execute(sql`
    INSERT INTO shop_addresses (id, cart_id, kind, name, line1, city, country_code)
    VALUES (${`adr_${cartId}`}, ${cartId}, 'shipping', 'A Buyer', '1 Oxford Street', 'Accra', ${country})`);
  return cartId;
}

type IntentBody = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  charged: { amount: number; currency: string; breakdown: null | { components: Array<{ kind: string; amount: number; multiplier: string }> } };
};

async function pay(cartId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  seq += 1;
  return client.post(
    '/api/shop/payments/intents',
    { checkoutId: cartId, email: 'buyer@fx.test', idempotencyKey: `idem_fx_${seq}_${cartId}`, ...extra },
    { headers: { Origin: TEST_ORIGIN, ...headers } },
  );
}

function capturedEvent(intentId: string, amount: number | null, currency: string | null): ProviderEvent {
  seq += 1;
  return {
    providerEventId: `evt_fx_${seq}`,
    type: 'charge.completed',
    providerIntentId: providerReferenceFor(intentId),
    providerRefundId: null,
    intentStatus: 'captured',
    refundStatus: null,
    failureReason: null,
    amount,
    currency,
    payload: {},
  };
}

// ─────────────────────────────────────────────────────── published config

describe('GET /api/public/shop/currency-config', () => {
  it('publishes each multiplier as a 12-digit string, cookieless, for a minute', async () => {
    const res = await client.get('/api/public/shop/currency-config');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const { config } = (await res.json()) as { config: Record<string, unknown> };
    expect(config).toMatchObject({
      base: 'NGN',
      default: 'NGN',
      revision: REVISION,
      currencies: ['NGN', 'GHS', 'UGX'],
      rates: {
        NGN: { multiplier: '1.000000000000', exponent: 2 },
        GHS: { multiplier: '0.008496176720', exponent: 2 },
        UGX: { multiplier: '2.387654321000', exponent: 0 },
      },
      fallbackCurrency: 'NGN',
    });
    expect((config.countries as Record<string, string>).GH).toBe('GHS');
    expect((config.countries as Record<string, string>).FR).toBe('EUR');
  });

  it('withdraws a stale FEED multiplier but never a manual one', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_fx_rates SET updated_at = ${Date.now() - 169 * HOUR} WHERE currency = 'GHS'`);
    const { config } = (await (await client.get('/api/public/shop/currency-config')).json()) as {
      config: { currencies: string[] };
    };
    // UGX's manual row is dated 1970 and still offered.
    expect(config.currencies).toEqual(['NGN', 'UGX']);
  });

  it('offers nothing no gateway can charge', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_payment_settings SET flutterwave_currencies = '{NGN}' WHERE id = 'main'`);
    const { config } = (await (await client.get('/api/public/shop/currency-config')).json()) as {
      config: { currencies: string[] };
    };
    expect(config.currencies).toEqual(['NGN']);
  });

  it('publishes a variant multiplier under its currency', async () => {
    const product = await seedProduct(ctx.db, ctx.users.owner);
    const variant = await seedVariant(ctx.db, product.id, ctx.users.owner);
    await ctx.db.execute(sql`
      INSERT INTO shop_variant_multipliers (variant_id, currency, multiplier_e12, updated_at)
      VALUES (${variant.id}, 'GHS', 9000000000, ${Date.now()})`);
    const { config } = (await (await client.get('/api/public/shop/currency-config')).json()) as {
      config: { variantMultipliers: Record<string, Record<string, string>> };
    };
    expect(config.variantMultipliers).toEqual({ GHS: { [variant.id]: '0.009000000000' } });
  });
});

// ──────────────────────────────────────────────────────────── payment link

describe('POST /api/shop/payments/intents — the currency handshake', () => {
  it('charges an old storefront (none of the three fields) exactly as before, in naira', async () => {
    const cart = await frozenCart('GH');
    const res = await pay(cart);
    expect(res.status).toBe(201);
    const body = (await res.json()) as IntentBody;
    expect(body).toMatchObject({ amount: 8330000, currency: 'NGN' });
    expect(body.charged).toEqual({ amount: 8330000, currency: 'NGN', breakdown: null });
    expect(paystack.calls.filter((c) => c.op === 'createIntent').map((c) => c.amount)).toEqual([8330000]);
    expect(flw.countOf('createIntent')).toBe(0);
  });

  it('charges the sum of converted components — 70772, not the 70773 a converted total gives', async () => {
    const cart = await frozenCart('GH');
    const res = await pay(cart, { country: 'GH', currency: 'GHS', ratesRevision: REVISION });
    expect(res.status).toBe(201);
    const body = (await res.json()) as IntentBody;
    // The naira total stays the order's figure; `charged` is what the gateway asks for.
    expect(body).toMatchObject({ amount: 8330000, currency: 'NGN' });
    expect(body.charged.amount).toBe(70772);
    expect(body.charged.currency).toBe('GHS');
    expect(body.charged.breakdown!.components.map((c) => [c.kind, c.amount])).toEqual([
      ['line', 67799],
      ['adjustment', -850],
      ['shipping', 3823],
    ]);
    expect(convertMinor(8330000, GHS_E12, 'GHS')).toBe(70773);

    // Routed to the gateway that can charge cedis, and asked for exactly that.
    expect(flw.calls.filter((c) => c.op === 'createIntent').map((c) => c.amount)).toEqual([70772]);
    expect(paystack.countOf('createIntent')).toBe(0);
    const row = (await ctx.db.execute(sql`
      SELECT provider, charge_currency, charge_amount_minor, rates_revision, country
        FROM shop_payment_intents WHERE id = ${body.id}`)).rows[0];
    expect(row).toMatchObject({
      provider: 'flutterwave',
      charge_currency: 'GHS',
      charge_amount_minor: 70772,
      rates_revision: REVISION,
      country: 'GH',
    });
  });

  it("uses a variant's own multiplier on its line, and the currency's everywhere else", async () => {
    const product = await seedProduct(ctx.db, ctx.users.owner);
    const variant = await seedVariant(ctx.db, product.id, ctx.users.owner);
    await ctx.db.execute(sql`
      INSERT INTO shop_variant_multipliers (variant_id, currency, multiplier_e12, updated_at)
      VALUES (${variant.id}, 'GHS', 9000000000, ${Date.now()})`);
    const cart = await frozenCart('GH', variant.id);
    const res = await pay(cart, { country: 'GH' });
    const body = (await res.json()) as IntentBody;
    const components = body.charged.breakdown!.components;
    expect(components[0]).toMatchObject({ kind: 'line', amount: 71820, multiplier: '0.009000000000' });
    expect(components[2]).toMatchObject({ kind: 'shipping', amount: 3823, multiplier: '0.008496176720' });
    expect(body.charged.amount).toBe(71820 - 850 + 3823);
  });

  it('charges an exponent-0 currency in whole units', async () => {
    const cart = await frozenCart('UG');
    const res = await pay(cart, { country: 'UG', currency: 'UGX', ratesRevision: REVISION });
    const body = (await res.json()) as IntentBody;
    // 7980000 → 190535, −100000 → −2388, 450000 → 10744 (÷100, ×2.387654321).
    expect(body.charged).toMatchObject({ amount: 190535 - 2388 + 10744, currency: 'UGX' });
    expect(flw.calls.filter((c) => c.op === 'createIntent').map((c) => c.amount)).toEqual([198891]);
  });

  it('answers 409 rates_changed, and creates nothing, when the revision moved', async () => {
    const cart = await frozenCart('GH');
    const res = await pay(cart, { country: 'GH', currency: 'GHS', ratesRevision: REVISION - 1 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; config: { revision: number; currencies: string[] } };
    expect(body.error).toBe('rates_changed');
    expect(body.config.revision).toBe(REVISION);
    expect(body.config.currencies).toContain('GHS');
    const count = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_payment_intents`);
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  it('answers 409 when the displayed currency is not what this country pays in', async () => {
    const cart = await frozenCart('GH');
    const res = await pay(cart, { country: 'GH', currency: 'NGN', ratesRevision: REVISION });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('rates_changed');
  });

  it("reads Vercel's country header once the storefront has joined the handshake", async () => {
    const cart = await frozenCart('NG');
    const res = await pay(cart, { currency: 'GHS', ratesRevision: REVISION }, { 'x-vercel-ip-country': 'GH' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as IntentBody).charged).toMatchObject({ amount: 70772, currency: 'GHS' });
  });

  it('never takes an amount or a multiplier from the body', async () => {
    const cart = await frozenCart('GH');
    const res = await pay(cart, { country: 'GH', amount: 1, multiplier: '0.000000000001' });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────── does the payment count?

describe('a converted payment counts only at the charged currency and amount', () => {
  async function cediIntent(): Promise<string> {
    const res = await pay(await frozenCart('GH'), { country: 'GH' });
    return ((await res.json()) as IntentBody).id;
  }

  it('refuses an underpaid cedi webhook and records why', async () => {
    const id = await cediIntent();
    const stored = await storeEvent(ctx.db, capturedEvent(id, 70000, 'GHS'), 'flutterwave');
    const result = await processEvent(ctx.db, stored.rowId);
    expect(result.outcome).toBe('ignored');
    expect((await getIntent(ctx.db, id))!.status).toBe('requires_payment');
    const ev = await ctx.db.execute(sql`SELECT anomaly FROM shop_payment_events WHERE id = ${stored.rowId}`);
    expect(ev.rows[0]?.anomaly).toBe('charge_underpaid:70000<70772');
  });

  it('refuses the naira figure for a cedi charge', async () => {
    const id = await cediIntent();
    const stored = await storeEvent(ctx.db, capturedEvent(id, 8330000, 'NGN'), 'flutterwave');
    await processEvent(ctx.db, stored.rowId);
    expect((await getIntent(ctx.db, id))!.status).toBe('requires_payment');
  });

  it('refuses a cedi charge the gateway verified no amount for', async () => {
    const id = await cediIntent();
    const stored = await storeEvent(ctx.db, capturedEvent(id, null, null), 'flutterwave');
    await processEvent(ctx.db, stored.rowId);
    expect((await getIntent(ctx.db, id))!.status).toBe('requires_payment');
  });

  it('captures the exact charge', async () => {
    const id = await cediIntent();
    const stored = await storeEvent(ctx.db, capturedEvent(id, 70772, 'GHS'), 'flutterwave');
    expect((await processEvent(ctx.db, stored.rowId)).outcome).toBe('applied');
    expect((await getIntent(ctx.db, id))!.status).toBe('captured');
  });

  it('/confirm applies the same check to what the gateway verifies', async () => {
    const short = await cediIntent();
    flw.settle(providerReferenceFor(short), 'captured', { amount: 70771 });
    let res = await client.post(`/api/shop/payments/intents/${short}/confirm`, {}, { headers: { Origin: TEST_ORIGIN } });
    expect(((await res.json()) as IntentBody).status).toBe('requires_payment');

    const full = await cediIntent();
    flw.settle(providerReferenceFor(full), 'captured');
    res = await client.post(`/api/shop/payments/intents/${full}/confirm`, {}, { headers: { Origin: TEST_ORIGIN } });
    expect(((await res.json()) as IntentBody).status).toBe('captured');
  });
});

// ─────────────────────────────────────────────────────────────── refunds

describe('refunds are paid back in the charged currency, at the stored multiplier', () => {
  it('converts a partial refund at the multiplier it was charged at, and the last one takes the rest', async () => {
    const res = await pay(await frozenCart('GH'), { country: 'GH' });
    const id = ((await res.json()) as IntentBody).id;
    const stored = await storeEvent(ctx.db, capturedEvent(id, 70772, 'GHS'), 'flutterwave');
    await processEvent(ctx.db, stored.rowId);

    // The rate moves after the charge. Refunds must not care.
    await ctx.db.execute(sql`UPDATE shop_fx_rates SET multiplier_e12 = 9000000000 WHERE currency = 'GHS'`);

    const owner = client;
    await owner.signIn(ctx.users.owner);
    const refund = (amount: number, key: string) =>
      owner.post(`/api/shop/admin/payments/intents/${id}/refunds`, { amount, idempotencyKey: key }, { headers: { Origin: TEST_ORIGIN } });

    expect((await refund(2660000, 'rf-fx-one')).status).toBe(201);
    expect((await refund(2660000, 'rf-fx-two')).status).toBe(201);
    expect((await refund(3010000, 'rf-fx-last')).status).toBe(201);

    const refundsSent = flw.calls.filter((c) => c.op === 'refund').map((c) => c.amount);
    const partial = convertMinor(2660000, parseMultiplier('0.008496176720'), 'GHS');
    expect(partial).toBe(22600);
    // 22600 + 22600, then exactly what is left of the 70772 — not a fresh conversion (25573).
    expect(refundsSent).toEqual([22600, 22600, 70772 - 45200]);

    const intent = (await getIntent(ctx.db, id))!;
    expect(intent.refundedTotal).toBe(8330000);
    expect(intent.chargeRefundedMinor).toBe(70772);
    const rows = await ctx.db.execute(sql`
      SELECT amount, charge_currency, charge_amount_minor FROM shop_refunds
       WHERE intent_id = ${id} ORDER BY created_at, id`);
    expect(rows.rows.map((r) => [Number(r.amount), r.charge_currency, Number(r.charge_amount_minor)])).toEqual([
      [2660000, 'GHS', 22600],
      [2660000, 'GHS', 22600],
      [3010000, 'GHS', 25572],
    ]);
  });
});
