import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * SERVER-SIDE ANALYTICS (owner's 2026-08-31 batch) — the aggregates the v2
 * Analytics screen used to fake by paging `GET /admin/orders` client-side
 * (its own header carried the TODO this file closes: "real server-side
 * aggregates, a date-range picker — backend work").
 *
 * FOUR STATEMENTS, ONE INSTANT. Like `shopStats`, `now` is read once by the
 * route and every window is measured from it; `generatedAt` echoes it so a
 * reader can reconstruct each boundary from the body alone.
 *
 * DAYS ARE WAT, BY FIXED OFFSET. Charts bucket by calendar day, and a
 * calendar needs a timezone; the store is Nigerian and West Africa Time has
 * been UTC+1 without daylight saving since 1919, so the bucket is
 * `paid_at + 1h`, formatted as a UTC date. A named-zone conversion
 * (AT TIME ZONE 'Africa/Lagos') would say the same thing while betting every
 * test run on the WASM build shipping a full tz database — the fixed offset
 * is the same answer with no bet. If the store ever moves timezones, this
 * constant is the whole migration.
 *
 * MEASURED OVER paid_at, exactly as `shopStats.revenue` is (money that never
 * arrived is not revenue).
 *
 * SALES ARE ITEM PRICES, AND THE REST IS NAMED SEPARATELY (owner, 2026-09-06).
 * The screen used to print `grand_total - refunded_total` under "Sales", so a
 * 28,000 order with 3,000 delivery read as 31,000 of sales. Every money
 * figure is now split the way the order itself is frozen:
 *
 *   sales      sum(subtotal)       - item prices, after bulk discounts, before
 *                                    everything else. THE headline.
 *   discounts  sum(grand - subtotal - shipping - tax) - codes and points; the
 *                                    order row has no adjustment column, so it
 *                                    is read off the gap. <= 0, and exact,
 *                                    because grandTotal = subtotal +
 *                                    adjustmentTotal + shippingTotal + taxTotal
 *                                    is the engine's own identity
 *                                    (`shared/commerce/ports.ts`).
 *   delivery   sum(shipping_total)
 *   tax        sum(tax_total)
 *   charged    sum(grand_total)     - what customers actually paid.
 *   refunded   sum(refunded_total)  - order-level money that cannot honestly
 *                                    be pinned to items or delivery, so it nets
 *                                    ONLY the bottom line and never `sales`.
 *   net        charged - refunded   - collected after refunds; a fully refunded
 *                                    order nets to zero rather than vanishing.
 */

export const WAT_OFFSET_MS = 60 * 60 * 1000;

/** The ranges the picker offers. A set, not a free integer: every value here
 * is a scan bound, and "3650" typed for "365" would be a full-table scan
 * served with a straight face. */
export const ANALYTICS_RANGES = ['7', '30', '90', '365'] as const;

/** The money split every window and every day carries. Minor units. */
export interface AnalyticsMoney {
  /** Item prices only: sum of subtotals, gross of refunds. */
  sales: number;
  /** Codes and points, <= 0. */
  discounts: number;
  delivery: number;
  tax: number;
  /** Sum of grand totals: sales + discounts + delivery + tax. */
  charged: number;
  refunded: number;
  /** charged - refunded. */
  net: number;
}

export interface AnalyticsDay extends AnalyticsMoney {
  /** YYYY-MM-DD in WAT. Days with no paid order are absent — the client
   * draws the gap, exactly as the old inline chart did. */
  day: string;
  orders: number;
}

export interface AnalyticsStatusRow {
  status: string;
  count: number;
}

export interface AnalyticsProductRow {
  variantId: string;
  sku: string;
  title: string;
  units: number;
  gross: number;
}

export interface ShopAnalytics {
  generatedAt: number;
  days: number;
  totals: AnalyticsMoney & {
    orders: number;
    items: number;
    /** Sales (item prices) over orders, minor units, 0 when there were none. */
    averageOrder: number;
  };
  revenueByDay: AnalyticsDay[];
  ordersByStatus: AnalyticsStatusRow[];
  /** Every seller in the window, best first, capped far above any real
   * catalog — the table subpage wants the whole list, not a top-10. */
  topProducts: AnalyticsProductRow[];
}

export const TOP_PRODUCTS_CAP = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** paid_at, shifted to WAT and named as a calendar day. */
const WAT_DAY = sql.raw(
  `to_char(to_timestamp((o.paid_at + 3600000) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
);

/** The money split, as aggregate columns over shop_orders o. One fragment
 * for the day series and the window total, so the two cannot disagree about
 * what a discount is. */
const MONEY_COLUMNS = sql.raw(`
  COALESCE(sum(o.subtotal), 0)::bigint AS sales,
  COALESCE(sum(o.grand_total - o.subtotal - o.shipping_total - o.tax_total), 0)::bigint AS discounts,
  COALESCE(sum(o.shipping_total), 0)::bigint AS delivery,
  COALESCE(sum(o.tax_total), 0)::bigint AS tax,
  COALESCE(sum(o.grand_total), 0)::bigint AS charged,
  COALESCE(sum(o.refunded_total), 0)::bigint AS refunded,
  COALESCE(sum(o.grand_total - o.refunded_total), 0)::bigint AS net`);

function readMoney(row: Record<string, unknown>): AnalyticsMoney {
  return {
    sales: Number(row.sales ?? 0),
    discounts: Number(row.discounts ?? 0),
    delivery: Number(row.delivery ?? 0),
    tax: Number(row.tax ?? 0),
    charged: Number(row.charged ?? 0),
    refunded: Number(row.refunded ?? 0),
    net: Number(row.net ?? 0),
  };
}

export async function shopAnalytics(
  db: Db,
  a: { now: number; days: number },
): Promise<ShopAnalytics> {
  const since = a.now - a.days * DAY_MS;

  const [byDay, byStatus, totals, products] = await Promise.all([
    db.execute(sql`
      SELECT ${WAT_DAY} AS day,
             ${MONEY_COLUMNS},
             count(*)::int AS orders
        FROM shop_orders o
       WHERE o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       GROUP BY 1 ORDER BY 1 ASC`),
    /* EVERY order placed in the window, not only the paid — the status strip
     * answers "what is the pipeline doing", and a pipeline of cancellations
     * is exactly what it must not hide. */
    db.execute(sql`
      SELECT o.status, count(*)::int AS count
        FROM shop_orders o
       WHERE o.placed_at >= ${since}
       GROUP BY o.status ORDER BY o.status ASC`),
    db.execute(sql`
      SELECT ${MONEY_COLUMNS},
             count(*)::int AS orders,
             COALESCE((SELECT sum(l.qty)::int FROM shop_order_lines l
                        JOIN shop_orders po ON po.id = l.order_id
                       WHERE po.paid_at IS NOT NULL AND po.paid_at >= ${since}), 0) AS items
        FROM shop_orders o
       WHERE o.paid_at IS NOT NULL AND o.paid_at >= ${since}`),
    db.execute(sql`
      SELECT l.variant_id, l.sku,
             max(l.title) AS title,
             sum(l.qty)::int AS units,
             sum(l.line_total)::bigint AS gross
        FROM shop_order_lines l
        JOIN shop_orders o ON o.id = l.order_id
       WHERE o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       GROUP BY l.variant_id, l.sku
       ORDER BY gross DESC, units DESC, l.sku ASC
       LIMIT ${TOP_PRODUCTS_CAP}`),
  ]);

  const totalRow = totals.rows[0] ?? {};
  const money = readMoney(totalRow);
  const orders = Number(totalRow.orders ?? 0);

  return {
    generatedAt: a.now,
    days: a.days,
    totals: {
      ...money,
      orders,
      items: Number(totalRow.items ?? 0),
      averageOrder: orders === 0 ? 0 : Math.round(money.sales / orders),
    },
    revenueByDay: byDay.rows.map((row) => ({
      day: String(row.day),
      ...readMoney(row),
      orders: Number(row.orders),
    })),
    ordersByStatus: byStatus.rows.map((row) => ({
      status: String(row.status),
      count: Number(row.count),
    })),
    topProducts: products.rows.map((row) => ({
      variantId: String(row.variant_id),
      sku: String(row.sku),
      title: String(row.title),
      units: Number(row.units),
      gross: Number(row.gross),
    })),
  };
}
