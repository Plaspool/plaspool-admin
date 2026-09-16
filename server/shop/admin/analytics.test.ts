/**
 * The analytics aggregates, through the real app: WAT day buckets, net of
 * refunds, paid_at as the clock, and the range enum refusing what it does not
 * offer.
 *
 * ONE order rides the real pipeline (events → sweep — the shape §2 demands);
 * the rest are SQL CLONES of that row with shifted clocks, because these are
 * AGGREGATE tests: they read tables, and three more trips through the
 * pipeline would prove the pipeline again while making every timestamp a
 * derived value nothing in the test controls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from '../orders/test/app';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents, paymentCaptured } from '../orders/test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from '../orders/repo/consumer';
import { readOrderByCheckout } from '../orders/repo/orders';
import type { ShopAnalytics } from './analytics';
import { seedSellable } from '../catalog/test/catalog-harness';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };
const DAY = 24 * 60 * 60 * 1000;

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
});

async function login(user: AuthUser): Promise<OrdersClient> {
  const c = ordersClient(ctx.db, { now: () => NOW });
  await c.signIn(user);
  return c;
}

/** The pipeline order: paid at `at`, refunded by `refunded`. Returns id and
 * grand total. */
async function pipelineOrder(at: number, refunded = 0): Promise<{ id: string; grand: number }> {
  await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await ctx.db.execute(sql`
    UPDATE shop_orders
       SET paid_at = ${at}, placed_at = ${at}, refunded_total = ${refunded}
     WHERE id = ${read.order.id}`);
  return { id: read.order.id, grand: read.order.grandTotal };
}

/** A clone of `sourceId` — new identity, its own clock and refund. */
async function cloneOrder(
  sourceId: string,
  n: number,
  at: number,
  refunded = 0,
  withLines = true,
): Promise<void> {
  const id = `ord_clone_${n}`;
  /* Column lists on BOTH sides — a positional clone would silently shear the
   * first time the table grows a column. */
  await ctx.db.execute(sql`
    INSERT INTO shop_orders (id, order_number, customer_id, email, currency,
                             subtotal, shipping_total, tax_total, grand_total,
                             refunded_total, status, shipping_address,
                             billing_address, placed_at, paid_at, fulfilled_at,
                             cancelled_at, revision, checkout_id,
                             payment_intent_id, source_event_id,
                             lifecycle_generation)
    SELECT ${id}, ${'2026-90000' + n}, customer_id, email, currency,
           subtotal, shipping_total, tax_total, grand_total,
           ${refunded}, status, shipping_address,
           billing_address, ${at}, ${at}, fulfilled_at,
           cancelled_at, revision, ${'chk_clone_' + n},
           payment_intent_id, source_event_id || ${'_c' + n},
           lifecycle_generation
      FROM shop_orders WHERE id = ${sourceId}`);
  if (!withLines) return;
  await ctx.db.execute(sql`
    INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                  option_values, qty, unit_amount, line_total,
                                  fulfilled_qty, image_id)
    SELECT id || ${'_c' + n}, ${id}, line_no, variant_id, sku, title,
           option_values, qty, unit_amount, line_total, fulfilled_qty, image_id
      FROM shop_order_lines WHERE order_id = ${sourceId}`);
}

describe('GET /api/shop/admin/analytics', () => {
  /* The ROUTE reads the real clock (Date.now()), so windowed rows must sit on
   * that clock — the fixture epoch T0 is months away from it. */
  it('buckets net revenue by WAT day, nets refunds, and totals the window', async () => {
    const REAL = Date.now();
    const { id, grand } = await pipelineOrder(REAL, 100_000);
    await cloneOrder(id, 1, REAL - 2 * DAY);

    const c = await login(ctx.users.supplyChain);
    const res = await c.get('/api/shop/admin/analytics?days=7');
    expect(res.status).toBe(200);
    const body = await json<ShopAnalytics>(res);

    expect(body.days).toBe(7);
    expect(body.totals.orders).toBe(2);
    expect(body.totals.net).toBe(grand - 100_000 + grand);
    /* Average order is ITEM PRICES over orders, not the charged total — the
     * fixture's 4500 subtotal, twice. */
    expect(body.totals.averageOrder).toBe(4500);
    expect(body.revenueByDay).toHaveLength(2);
    const today = body.revenueByDay[body.revenueByDay.length - 1];
    expect(today.net).toBe(grand - 100_000);
    expect(today.orders).toBe(1);
    expect(body.revenueByDay[0].day < today.day).toBe(true);
    expect(today.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a paid order outside the window is invisible to it and visible to a wider one', async () => {
    const { id } = await pipelineOrder(Date.now() - 10 * DAY);
    void id;
    const c = await login(ctx.users.owner);
    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));
    expect(body.totals.orders).toBe(0);
    expect(body.revenueByDay).toHaveLength(0);
    const wide = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=30'));
    expect(wide.totals.orders).toBe(1);
  });

  it('splits what was charged into item prices, delivery, VAT and discounts, and nets refunds only at the bottom line', async () => {
    /* The owner's 2026-09-06 finding: "Sales" on the analytics screen was the
     * GRAND total — delivery and VAT rolled into a number labelled sales. The
     * fixture order is 4500 of items + 500 delivery + 400 VAT = 5400; the
     * clone below carries a 700 discount, so its grand total no longer equals
     * the sum of its parts and the discount has to be READ OFF the gap. */
    const REAL = Date.now();
    const { id } = await pipelineOrder(REAL, 1_000);
    await cloneOrder(id, 1, REAL - DAY);
    await ctx.db.execute(sql`
      UPDATE shop_orders SET grand_total = grand_total - 700 WHERE id = 'ord_clone_1'`);

    const c = await login(ctx.users.owner);
    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));

    expect(body.totals).toMatchObject({
      sales: 9_000,
      delivery: 1_000,
      tax: 800,
      discounts: -700,
      charged: 10_100,
      refunded: 1_000,
      net: 9_100,
      orders: 2,
      averageOrder: 4_500,
    });

    /* Per day the same split, oldest first. Refunds are order-level money,
     * so they touch `net` and nothing else. */
    expect(body.revenueByDay).toHaveLength(2);
    expect(body.revenueByDay[0]).toMatchObject({
      sales: 4_500,
      delivery: 500,
      tax: 400,
      discounts: -700,
      net: 4_700,
      orders: 1,
    });
    expect(body.revenueByDay[1]).toMatchObject({
      sales: 4_500,
      delivery: 500,
      tax: 400,
      discounts: 0,
      net: 4_400,
      orders: 1,
    });
  });

  it('counts items and ranks products by gross', async () => {
    await pipelineOrder(Date.now());
    const c = await login(ctx.users.owner);
    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics'));
    expect(body.totals.items).toBeGreaterThan(0);
    expect(body.topProducts.length).toBeGreaterThan(0);
    const first = body.topProducts[0];
    expect(first.units).toBeGreaterThan(0);
    expect(first.gross).toBeGreaterThan(0);
    expect(typeof first.title).toBe('string');
  });

  /* Migration 1300: cost is the one frozen on the line, and a line with no cost
   * anywhere is left OUT of profit rather than counted as free. */
  it('prices profit off the cost frozen on each line, and never treats an uncosted item as free', async () => {
    const REAL = Date.now();
    const { id } = await pipelineOrder(REAL);
    /* The pipeline line keeps whatever the catalogue had; force a known shape by
     * cloning the order bare and writing lines with explicit costs (the lines
     * table refuses UPDATE and DELETE). */
    await cloneOrder(id, 7, REAL - DAY, 0, false);
    await ctx.db.execute(sql`
      INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                    option_values, qty, unit_amount, line_total,
                                    fulfilled_qty, unit_cost_minor)
      VALUES ('lin_cost_a', 'ord_clone_7', 0, 'var_no_such_a', 'COST-A', 'Costed', '{}'::jsonb,
              2, 5000, 10000, 0, 3000),
             ('lin_cost_b', 'ord_clone_7', 1, 'var_no_such_b', 'COST-B', 'Uncosted', '{}'::jsonb,
              1, 7000, 7000, 0, NULL)`);

    const c = await login(ctx.users.owner);
    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));

    const a = body.topProducts.find((r) => r.sku === 'COST-A')!;
    expect(a).toMatchObject({ units: 2, gross: 10000, costedUnits: 2, costedGross: 10000, cost: 6000, estimatedUnits: 0 });
    const b = body.topProducts.find((r) => r.sku === 'COST-B')!;
    expect(b).toMatchObject({ units: 1, gross: 7000, costedUnits: 0, costedGross: 0, cost: 0 });

    /* The window total includes both, and profit covers only the costed one. */
    expect(body.profit.units).toBe(body.totals.items);
    expect(body.profit.costedSales - body.profit.cost).toBe(body.profit.profit);
    expect(body.profit.costedUnits).toBeLessThan(body.profit.units);
  });

  it('refuses a range it does not offer, and the analytics-less roles', async () => {
    const c = await login(ctx.users.owner);
    expect((await c.get('/api/shop/admin/analytics?days=3650')).status).toBe(400);
    expect((await c.get('/api/shop/admin/analytics?day=7')).status).toBe(400);
    const writer = await login(ctx.users.writer);
    expect((await writer.get('/api/shop/admin/analytics')).status).toBe(403);
  });
});

describe('where the sales came from', () => {
  /**
   * A manual sale counts in every figure (that is the point of it being an
   * ordinary row), so the split has to ADD UP to the headline — these tests
   * assert the arithmetic, not just the presence of the new fields.
   */
  const REAL = Date.now();
  const day = (n: number) =>
    new Date(REAL + 3_600_000 - n * DAY).toISOString().slice(0, 10);

  async function manualSale(
    c: OrdersClient,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; revision: number; grand: number }> {
    const product = await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Recorded by hand',
      amount: 250_000,
      onHand: 10,
    });
    const res = await c.post('/api/shop/admin/orders/manual', {
      soldAt: day(1),
      lines: [{ variantId: product.variant.id, qty: 2 }],
      paymentMethod: 'bank_transfer',
      advanced: { salesChannel: 'whatsapp' },
      ...body,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const detail = await json<{ order: { id: string; revision: number; grandTotal: number } }>(res);
    return { id: detail.order.id, revision: detail.order.revision, grand: detail.order.grandTotal };
  }

  it('splits the window by source, and the two halves add up to the totals', async () => {
    const online = await pipelineOrder(REAL);
    const c = await login(ctx.users.owner);
    const manual = await manualSale(c);

    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));
    expect(body.totals.orders).toBe(2);
    expect(body.totals.charged).toBe(online.grand + manual.grand);

    const rows = Object.fromEntries(body.bySource.map((r) => [r.source, r]));
    expect(rows.manual.orders).toBe(1);
    expect(rows.manual.charged).toBe(manual.grand);
    expect(rows.online.orders).toBe(1);
    expect(rows.online.charged).toBe(online.grand);
    expect(rows.manual.charged + rows.online.charged).toBe(body.totals.charged);
    expect(rows.manual.orders + rows.online.orders).toBe(body.totals.orders);
    expect(rows.manual.items).toBe(2);
  });

  it('cuts the manual half by where it came from and how it was paid', async () => {
    const c = await login(ctx.users.owner);
    const first = await manualSale(c);
    const second = await manualSale(c, {
      paymentMethod: 'cash',
      advanced: {},
    });

    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));
    expect(body.manualByChannel).toEqual([
      { key: 'whatsapp', orders: 1, charged: first.grand },
      // Left blank on the form: an ordinary answer, reported as null.
      { key: null, orders: 1, charged: second.grand },
    ]);
    expect(body.manualByMethod.map((r) => r.key).sort()).toEqual(['bank_transfer', 'cash']);
    expect(body.manualByMethod.reduce((n, r) => n + r.charged, 0)).toBe(first.grand + second.grand);
  });

  it('carries the manual part of each day, leaving the day total whole', async () => {
    const online = await pipelineOrder(REAL);
    const c = await login(ctx.users.owner);
    const manual = await manualSale(c);

    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));
    const manualDay = body.revenueByDay.find((d) => d.day === day(1))!;
    expect(manualDay.manual).toEqual({ charged: manual.grand, orders: 1 });
    expect(manualDay.charged).toBe(manual.grand);

    const onlineDay = body.revenueByDay.find((d) => d.day === day(0))!;
    expect(onlineDay.manual).toEqual({ charged: 0, orders: 0 });
    expect(onlineDay.charged).toBe(online.grand);
  });

  it('drops a voided sale out of the split, as it does out of the totals', async () => {
    const c = await login(ctx.users.owner);
    const manual = await manualSale(c);
    const voided = await c.post(`/api/shop/admin/orders/${manual.id}/void`, {
      baseRevision: manual.revision,
    });
    expect(voided.status).toBe(200);

    const body = await json<ShopAnalytics>(await c.get('/api/shop/admin/analytics?days=7'));
    expect(body.bySource).toEqual([]);
    expect(body.manualByChannel).toEqual([]);
    expect(body.totals.orders).toBe(0);
  });
});
