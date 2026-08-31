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
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from '../orders/test/app';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents, paymentCaptured } from '../orders/test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from '../orders/repo/consumer';
import { readOrderByCheckout } from '../orders/repo/orders';
import type { ShopAnalytics } from './analytics';
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
  const res = await c.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
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
    expect(body.totals.averageOrder).toBe(Math.round(body.totals.net / 2));
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

  it('refuses a range it does not offer, and the analytics-less roles', async () => {
    const c = await login(ctx.users.owner);
    expect((await c.get('/api/shop/admin/analytics?days=3650')).status).toBe(400);
    expect((await c.get('/api/shop/admin/analytics?day=7')).status).toBe(400);
    const writer = await login(ctx.users.writer);
    expect((await writer.get('/api/shop/admin/analytics')).status).toBe(403);
  });
});
