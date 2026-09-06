import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { resetOrderTables } from '../orders/test/harness';
import { EMAIL_ATTEMPT_LIMIT } from '../orders/repo/emails';
import { seedSellable, seedVariant } from '../catalog/test/catalog-harness';
import { reserve } from '../catalog/inventory';
import { trashProduct } from '../catalog/products';
import { LOW_STOCK_PREVIEW, shopStats } from './stats';
import { S0, seedEmailIntent, seedOrder } from './test/seed';
import type { AnalyticsMoney } from './analytics';

/** A window's money split from its parts — charged and net derived the way
 *  the server derives them, so an assertion states only what was seeded. */
function mon(p: Partial<Pick<AnalyticsMoney, 'sales' | 'discounts' | 'delivery' | 'tax' | 'refunded'>>): AnalyticsMoney {
  const sales = p.sales ?? 0;
  const discounts = p.discounts ?? 0;
  const delivery = p.delivery ?? 0;
  const tax = p.tax ?? 0;
  const refunded = p.refunded ?? 0;
  const charged = sales + discounts + delivery + tax;
  return { sales, discounts, delivery, tax, charged, refunded, net: charged - refunded };
}

/**
 * The dashboard's arithmetic (HANDOFF §2 A4).
 *
 * WHAT THIS SUITE IS ACTUALLY FOR: every number on a shop dashboard is a claim
 * about money, and a wrong one is not a visual bug — it is an operator
 * reconciling a bank statement against a screen that disagrees with it. So the
 * cases below are the ones where a plausible implementation is quietly wrong:
 * an unpaid order counted as revenue, a refund that removes an order instead of
 * reducing it, two currencies added together, a permanently failed email sitting
 * in the same tile as one that is about to go out.
 *
 * THE CLOCK IS PASSED IN, NEVER READ. `shopStats` takes `now` precisely so the
 * three trailing windows can be asserted rather than approximated; a suite that
 * used `Date.now()` would be a suite that is one slow CI machine away from a
 * boundary flake.
 */

let ctx: TestCtx;
const NOW = S0;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const stats = (threshold?: number) => shopStats(ctx.db, { now: NOW, threshold });

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

describe('orders by status', () => {
  it('counts and totals each status, and omits the ones with no orders', async () => {
    await seedOrder(ctx.db, { status: 'paid', grandTotal: 1000 });
    await seedOrder(ctx.db, { status: 'paid', grandTotal: 2500 });
    await seedOrder(ctx.db, { status: 'pending', grandTotal: 400, paidAt: null });

    const { ordersByStatus } = await stats();

    expect(ordersByStatus).toEqual([
      { status: 'paid', currency: 'GBP', count: 2, total: 3500 },
      { status: 'pending', currency: 'GBP', count: 1, total: 400 },
    ]);
    /*
     * No `refunded`, no `cancelled`, no `fulfilled`. A zero row would have to
     * carry a currency, and there is no order to take one from — see the note on
     * `ordersByStatus` about why inventing one is worse than omitting the row.
     */
    expect(ordersByStatus.map((row) => row.status)).not.toContain('refunded');
  });

  it('never adds two currencies together', async () => {
    /*
     * The money bug this grouping exists to prevent. Summed blind, these two
     * orders produce `total: 3000` in a currency nobody chose — a number that
     * looks like a total and reconciles against nothing. Contract §13 gives the
     * shop one store currency in v1, so this is the case that only ever appears
     * the day that stops being true.
     */
    await seedOrder(ctx.db, { status: 'paid', currency: 'GBP', grandTotal: 1000 });
    await seedOrder(ctx.db, { status: 'paid', currency: 'EUR', grandTotal: 2000 });

    const { ordersByStatus } = await stats();
    expect(ordersByStatus).toEqual([
      { status: 'paid', currency: 'EUR', count: 1, total: 2000 },
      { status: 'paid', currency: 'GBP', count: 1, total: 1000 },
    ]);
  });

  it('totals are gross — the refund shows up in revenue, not here', async () => {
    await seedOrder(ctx.db, {
      status: 'partially_refunded',
      grandTotal: 5000,
      refundedTotal: 1500,
    });
    const { ordersByStatus, revenue } = await stats();
    expect(ordersByStatus[0].total).toBe(5000);
    expect(revenue[0].last24h.net).toBe(3500);
  });
});

describe('revenue windows', () => {
  it('are trailing, nested, and measured from paid_at', async () => {
    await seedOrder(ctx.db, { grandTotal: 100, paidAt: NOW - HOUR });
    await seedOrder(ctx.db, { grandTotal: 200, paidAt: NOW - 3 * DAY });
    await seedOrder(ctx.db, { grandTotal: 400, paidAt: NOW - 10 * DAY });
    // Outside every window: it must appear in no total at all.
    await seedOrder(ctx.db, { grandTotal: 800, paidAt: NOW - 40 * DAY });

    const { revenue, generatedAt } = await stats();
    expect(generatedAt).toBe(NOW);
    expect(revenue).toEqual([
      {
        currency: 'GBP',
        last24h: mon({ sales: 100 }),
        last7d: mon({ sales: 300 }),
        last30d: mon({ sales: 700 }),
      },
    ]);
  });

  it('splits item prices from delivery, VAT and discounts, and nets refunds only at the bottom line', async () => {
    /* The owner's 2026-09-06 order: 28,000 of product + 3,000 Abuja delivery,
     * which the Home tile printed as 31,000 of "Revenue". */
    await seedOrder(ctx.db, {
      grandTotal: 3_100_000,
      subtotal: 2_800_000,
      shippingTotal: 300_000,
      paidAt: NOW - HOUR,
    });
    /* A code took 500 off 4,500 of items with 200 of VAT, then 1,000 came back. */
    await seedOrder(ctx.db, {
      grandTotal: 4_200,
      subtotal: 4_500,
      taxTotal: 200,
      refundedTotal: 1_000,
      status: 'partially_refunded',
      paidAt: NOW - 3 * DAY,
    });

    const { revenue } = await stats();
    expect(revenue).toEqual([
      {
        currency: 'GBP',
        last24h: mon({ sales: 2_800_000, delivery: 300_000 }),
        last7d: mon({
          sales: 2_804_500,
          delivery: 300_000,
          tax: 200,
          discounts: -500,
          refunded: 1_000,
        }),
        last30d: mon({
          sales: 2_804_500,
          delivery: 300_000,
          tax: 200,
          discounts: -500,
          refunded: 1_000,
        }),
      },
    ]);
    expect(revenue[0].last7d.charged).toBe(3_104_200);
    expect(revenue[0].last7d.net).toBe(3_103_200);
  });

  it('an order that was never paid is not revenue, however recent', async () => {
    /*
     * `placed_at` is now and `paid_at` is null: the order exists, the money does
     * not. A window over `placed_at` — the obvious mistake, since that column is
     * never null and is the one the list sorts by — would report 9 999 of income
     * the shop has not received.
     */
    await seedOrder(ctx.db, { status: 'pending', grandTotal: 9999, placedAt: NOW, paidAt: null });
    const { revenue } = await stats();
    expect(revenue).toEqual([]);
  });

  it('a refund reduces the window it was taken in rather than removing the order', async () => {
    await seedOrder(ctx.db, {
      status: 'refunded',
      grandTotal: 5000,
      refundedTotal: 5000,
      paidAt: NOW - HOUR,
    });
    await seedOrder(ctx.db, { grandTotal: 1000, paidAt: NOW - HOUR });

    const { revenue, ordersByStatus } = await stats();
    // Net revenue is the unrefunded order alone; sales still count both...
    const both = mon({ sales: 6000, refunded: 5000 });
    expect(both.net).toBe(1000);
    expect(revenue).toEqual([{ currency: 'GBP', last24h: both, last7d: both, last30d: both }]);
    // ...and the refunded order is still visible as an order.
    expect(ordersByStatus).toContainEqual({
      status: 'refunded',
      currency: 'GBP',
      count: 1,
      total: 5000,
    });
  });

  it('keeps two currencies on two rows here too', async () => {
    await seedOrder(ctx.db, { currency: 'GBP', grandTotal: 1000, paidAt: NOW - HOUR });
    await seedOrder(ctx.db, { currency: 'USD', grandTotal: 2000, paidAt: NOW - HOUR });
    const { revenue } = await stats();
    expect(revenue.map((row) => [row.currency, row.last30d.net])).toEqual([
      ['GBP', 1000],
      ['USD', 2000],
    ]);
  });
});

describe('the email backlog', () => {
  it('separates what will be retried from what never will', async () => {
    const order = await seedOrder(ctx.db);
    await seedEmailIntent(ctx.db, order.id, { attempts: 0 });
    await seedEmailIntent(ctx.db, order.id, { attempts: EMAIL_ATTEMPT_LIMIT - 1 });
    /*
     * At the limit `sweepEmailIntents` stops selecting the row — deliberately, so
     * one undeliverable address cannot consume every sweep's budget. Folded into
     * one "unsent" number this row would sit in the same tile as the two above
     * and the operator would watch the count fail to drop with no way to tell
     * which half was moving.
     */
    await seedEmailIntent(ctx.db, order.id, {
      attempts: EMAIL_ATTEMPT_LIMIT,
      lastError: 'mailbox unavailable',
    });
    await seedEmailIntent(ctx.db, order.id, { sentAt: NOW, attempts: 1 });

    const { emails } = await stats();
    expect(emails).toEqual({ pending: 2, stuck: 1, sent: 1 });
  });

  it('is three zeros when nothing has ever been queued', async () => {
    expect((await stats()).emails).toEqual({ pending: 0, stuck: 0, sent: 0 });
  });
});

describe('the latest orders strip', () => {
  it('is the five newest, newest first', async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedOrder(ctx.db, { grandTotal: 100 + i, placedAt: NOW - (7 - i) * HOUR });
    }
    const { latestOrders } = await stats();
    expect(latestOrders).toHaveLength(5);
    expect(latestOrders.map((order) => order.grandTotal)).toEqual([106, 105, 104, 103, 102]);
    // Seven columns and no lines: the strip links out for the rest.
    expect(Object.keys(latestOrders[0]).sort()).toEqual([
      'currency',
      'email',
      'grandTotal',
      'id',
      'orderNumber',
      'placedAt',
      'status',
    ]);
  });
});

describe('low stock', () => {
  /*
   * The catalog corpus is built ONCE and never reset, because `beforeEach` above
   * only truncates the order tables — products and their stock are Catalog's and
   * nothing in this suite writes them after this hook.
   */
  beforeAll(async () => {
    const actor = ctx.users.owner;
    /*
     * EVERY VARIANT GETS A DISTINCT `available`, on purpose. The ordering is
     * `available ASC, v.id ASC` and the ids carry a millisecond time prefix, so
     * two rows tying on availability would be ordered by the random half of an id
     * minted in the same millisecond — a test that passes most afternoons.
     */
    const plenty = await seedSellable(ctx.db, actor, {
      title: 'Plenty',
      sku: 'LOW-PLENTY',
      onHand: 40,
    });
    await seedVariant(ctx.db, plenty.product.id, actor, { sku: 'LOW-TWO', onHand: 2 });
    await seedVariant(ctx.db, plenty.product.id, actor, { sku: 'LOW-ZERO', onHand: 0 });

    // 40 on hand, 39 held: available 1, and stock held for a cart is not stock
    // anybody else can be sold — which is the whole reason `available` subtracts.
    await reserve(ctx.db, {
      reservationId: 'res_stats_1',
      variantId: plenty.variant.id,
      qty: 39,
      expiresAt: S0 + 60_000,
    });

    const oversold = await seedSellable(ctx.db, actor, {
      title: 'Backorder',
      sku: 'LOW-BACK',
      onHand: 0,
      backorderable: true,
    });
    await reserve(ctx.db, {
      reservationId: 'res_stats_2',
      variantId: oversold.variant.id,
      qty: 3,
      expiresAt: S0 + 60_000,
    });

    // In the trash, and therefore not stock anybody is restocking.
    const binned = await seedSellable(ctx.db, actor, { title: 'Binned', sku: 'LOW-BIN', onHand: 0 });
    await trashProduct(ctx.db, binned.product.id, actor);
  });

  it('is available ≤ 5 by default, lowest first, oversold backorders included', async () => {
    const { lowStock, lowStockThreshold, lowStockMore } = await stats();
    expect(lowStockThreshold).toBe(5);
    expect(lowStockMore).toBe(false);

    expect(lowStock.map((row) => [row.sku, row.available])).toEqual([
      // -3: a backorderable variant is deliberately sold past zero, and clamping
      // it to 0 would bury the one row an operator most needs to see.
      ['LOW-BACK', -3],
      ['LOW-ZERO', 0],
      ['LOW-PLENTY', 1],
      ['LOW-TWO', 2],
    ]);
    expect(lowStock.map((row) => row.sku)).not.toContain('LOW-BIN');
  });

  it('carries the product it belongs to, not just a variant id', async () => {
    const { lowStock } = await stats();
    const row = lowStock.find((item) => item.sku === 'LOW-TWO')!;
    expect(row).toMatchObject({
      productTitle: 'Plenty',
      productStatus: 'active',
      variantStatus: 'active',
      onHand: 2,
      reserved: 0,
      backorderable: false,
    });
  });

  it('the threshold moves the line', async () => {
    // 0 is the sold-out list. Everything with stock left drops off it.
    const soldOut = await stats(0);
    expect(soldOut.lowStock.map((row) => row.sku)).toEqual(['LOW-BACK', 'LOW-ZERO']);

    const wide = await stats(1000);
    expect(wide.lowStock.map((row) => row.sku)).toContain('LOW-BACK');
    expect(wide.lowStock.length).toBeGreaterThan(soldOut.lowStock.length);
    expect(wide.lowStockThreshold).toBe(1000);
  });

  it('never returns more than the preview, and says so when it truncates', async () => {
    /*
     * `lowStockMore` is the whole of the anti-truncation contract: a tile showing
     * the first twenty of two hundred with nothing to say so is the failure
     * `pageLimit` refuses elsewhere. Asserted as a property of the numbers rather
     * than by seeding 21 variants, which would cost a minute of PGlite for one
     * boolean.
     */
    const { lowStock } = await stats(1000);
    expect(lowStock.length).toBeLessThanOrEqual(LOW_STOCK_PREVIEW);
  });
});
