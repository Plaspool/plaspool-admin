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
  /**
   * The part of this day that was RECORDED BY HAND (migration 1110). The
   * fields above stay the day's WHOLE, so a chart that ignores this one is
   * still correct, and the online half is always `charged - manual.charged`
   * — there is no third bucket for a reader to forget.
   */
  manual: { charged: number; orders: number };
}

/** Online against manual over the window. A source that sold nothing is absent. */
export interface AnalyticsSourceRow extends AnalyticsMoney {
  source: 'online' | 'manual';
  orders: number;
  items: number;
}

/**
 * Manual sales cut by one of the two things the owner types when recording one:
 * where it came from (`sales_channel`) and how it was paid (`payment_method`).
 * `key` is NULL for "not recorded", which is an ordinary answer rather than a
 * gap — both fields are optional on the form, and only `payment_method` is
 * required by the database.
 */
export interface AnalyticsBreakdownRow {
  key: string | null;
  orders: number;
  charged: number;
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
  /**
   * WHERE THE SALES CAME FROM: the storefront, or the owner's own record of a
   * sale made elsewhere. Same window and same `paid_at` predicate as `totals`,
   * so the rows add up to the headline exactly — a split that did not would be
   * worse than no split at all.
   */
  bySource: AnalyticsSourceRow[];
  /** Manual sales only, by where they came from and by how they were paid. */
  manualByChannel: AnalyticsBreakdownRow[];
  manualByMethod: AnalyticsBreakdownRow[];
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

/**
 * The money split as SQL over shop_orders o — field name to expression. ONE
 * map for this file's day series and window total AND for `shopStats`'s
 * revenue windows (the Home tiles), so no two screens can disagree about
 * what "sales" or "a discount" is.
 */
export const MONEY_EXPRESSIONS = {
  sales: 'o.subtotal',
  discounts: 'o.grand_total - o.subtotal - o.shipping_total - o.tax_total',
  delivery: 'o.shipping_total',
  tax: 'o.tax_total',
  charged: 'o.grand_total',
  refunded: 'o.refunded_total',
  net: 'o.grand_total - o.refunded_total',
} as const satisfies Record<keyof AnalyticsMoney, string>;

export const MONEY_FIELDS = Object.keys(MONEY_EXPRESSIONS) as (keyof AnalyticsMoney)[];

/** Every field summed over the rows in scope, named as itself. */
const MONEY_COLUMNS = sql.raw(
  MONEY_FIELDS.map((f) => `COALESCE(sum(${MONEY_EXPRESSIONS[f]}), 0)::bigint AS ${f}`).join(
    ',\n             ',
  ),
);

/** Read the split off a row; `suffix` selects a window when one row carries
 * several (`sales_7d`, `net_24h`, …). */
export function readMoney(row: Record<string, unknown>, suffix = ''): AnalyticsMoney {
  const num = (f: keyof AnalyticsMoney) => Number(row[f + suffix] ?? 0);
  return {
    sales: num('sales'),
    discounts: num('discounts'),
    delivery: num('delivery'),
    tax: num('tax'),
    charged: num('charged'),
    refunded: num('refunded'),
    net: num('net'),
  };
}

export async function shopAnalytics(
  db: Db,
  a: { now: number; days: number },
): Promise<ShopAnalytics> {
  const since = a.now - a.days * DAY_MS;

  const [byDay, byStatus, totals, products, bySource, byChannel, byMethod] = await Promise.all([
    db.execute(sql`
      SELECT ${WAT_DAY} AS day,
             ${MONEY_COLUMNS},
             count(*)::int AS orders,
             /* The hand-recorded part of the same day, so the chart can stack
              * the two without a second round trip or a second window. */
             COALESCE(sum(o.grand_total) FILTER (WHERE o.source = 'manual'), 0)::bigint AS manual_charged,
             count(*) FILTER (WHERE o.source = 'manual')::int AS manual_orders
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
    db.execute(sql`
      SELECT o.source,
             ${MONEY_COLUMNS},
             count(*)::int AS orders,
             /* Units, counted the way the window total counts them: over the
              * lines of the paid orders in scope, joined back to this source. */
             COALESCE((SELECT sum(l.qty)::int
                         FROM shop_order_lines l
                         JOIN shop_orders p ON p.id = l.order_id
                        WHERE p.source = o.source
                          AND p.paid_at IS NOT NULL AND p.paid_at >= ${since}), 0) AS items
        FROM shop_orders o
       WHERE o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       GROUP BY o.source ORDER BY o.source ASC`),
    db.execute(sql`
      SELECT o.sales_channel AS key, count(*)::int AS orders,
             COALESCE(sum(o.grand_total), 0)::bigint AS charged
        FROM shop_orders o
       WHERE o.source = 'manual' AND o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       GROUP BY 1 ORDER BY charged DESC, 1 ASC`),
    db.execute(sql`
      SELECT o.payment_method AS key, count(*)::int AS orders,
             COALESCE(sum(o.grand_total), 0)::bigint AS charged
        FROM shop_orders o
       WHERE o.source = 'manual' AND o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       GROUP BY 1 ORDER BY charged DESC, 1 ASC`),
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
      manual: {
        charged: Number(row.manual_charged ?? 0),
        orders: Number(row.manual_orders ?? 0),
      },
    })),
    ordersByStatus: byStatus.rows.map((row) => ({
      status: String(row.status),
      count: Number(row.count),
    })),
    bySource: bySource.rows.map((row) => ({
      source: row.source === 'manual' ? ('manual' as const) : ('online' as const),
      ...readMoney(row),
      orders: Number(row.orders),
      items: Number(row.items ?? 0),
    })),
    manualByChannel: byChannel.rows.map(readBreakdown),
    manualByMethod: byMethod.rows.map(readBreakdown),
    topProducts: products.rows.map((row) => ({
      variantId: String(row.variant_id),
      sku: String(row.sku),
      title: String(row.title),
      units: Number(row.units),
      gross: Number(row.gross),
    })),
  };
}

/** One `(key, orders, charged)` row; a NULL key means the owner left it blank. */
function readBreakdown(row: Record<string, unknown>): AnalyticsBreakdownRow {
  return {
    key: row.key == null ? null : String(row.key),
    orders: Number(row.orders ?? 0),
    charged: Number(row.charged ?? 0),
  };
}
