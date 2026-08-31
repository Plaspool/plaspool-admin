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
 * MEASURED OVER paid_at AND NET OF REFUNDS, exactly as `shopStats.revenue`
 * is, and for the same reasons (money that never arrived is not revenue that
 * disappeared; a fully refunded order nets to zero rather than vanishing).
 */

export const WAT_OFFSET_MS = 60 * 60 * 1000;

/** The ranges the picker offers. A set, not a free integer: every value here
 * is a scan bound, and "3650" typed for "365" would be a full-table scan
 * served with a straight face. */
export const ANALYTICS_RANGES = ['7', '30', '90', '365'] as const;

export interface AnalyticsDay {
  /** YYYY-MM-DD in WAT. Days with no paid order are absent — the client
   * draws the gap, exactly as the old inline chart did. */
  day: string;
  net: number;
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
  totals: {
    net: number;
    orders: number;
    items: number;
    /** Net over orders, minor units, 0 when there were none. */
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

export async function shopAnalytics(
  db: Db,
  a: { now: number; days: number },
): Promise<ShopAnalytics> {
  const since = a.now - a.days * DAY_MS;

  const [byDay, byStatus, totals, products] = await Promise.all([
    db.execute(sql`
      SELECT ${WAT_DAY} AS day,
             COALESCE(sum(o.grand_total - o.refunded_total), 0)::bigint AS net,
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
      SELECT COALESCE(sum(o.grand_total - o.refunded_total), 0)::bigint AS net,
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
  const net = Number(totalRow.net ?? 0);
  const orders = Number(totalRow.orders ?? 0);

  return {
    generatedAt: a.now,
    days: a.days,
    totals: {
      net,
      orders,
      items: Number(totalRow.items ?? 0),
      averageOrder: orders === 0 ? 0 : Math.round(net / orders),
    },
    revenueByDay: byDay.rows.map((row) => ({
      day: String(row.day),
      net: Number(row.net),
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
