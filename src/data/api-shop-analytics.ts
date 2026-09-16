/**
 * The admin analytics read (owner's 2026-08-31 batch) — the server-side
 * aggregates the v2 Analytics screen used to fake by paging `GET /admin/orders`
 * client-side.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api-shop.ts`, for the reason that
 * file itself gives about `api.ts`: another session is editing it right now,
 * and a file two writers append to is a file that loses a block. Nothing here
 * is a different convention — `apiFetch` is the shared request function, so
 * `credentials: 'include'`, the error envelope and spec §8's status table are
 * the shared ones.
 *
 * Every path, shape and field below is copied from
 * `server/shop/admin/analytics.ts` and `server/shop/admin/routes.ts` rather
 * than remembered.
 */
import { apiFetch } from './api';

const BASE = '/shop/admin';

/**
 * The ranges the picker offers. The route's schema is `z.enum(['7','30','90',
 * '365'])`, not a free integer — every value is a scan bound server-side — so
 * the type spells the four values rather than saying `number` and letting a
 * fifth one become a 400 at runtime.
 */
export type AnalyticsDays = 7 | 30 | 90 | 365;

/** The server's default window, `Number(q.days ?? '30')` in the route. */
export const ANALYTICS_DEFAULT_DAYS: AnalyticsDays = 30;

/**
 * The money split every window and every day carries, minor units, over paid
 * orders. SALES ARE ITEM PRICES: the screen used to print the grand total
 * under "Sales", so delivery and VAT read as product revenue (owner,
 * 2026-09-06). Now `sales + discounts + delivery + tax = charged`, and
 * `charged - refunded = net`, exactly as the server sums them.
 */
export interface AnalyticsMoney {
  /** Item prices only — the order subtotals, after bulk discounts. */
  sales: number;
  /** Codes and points, zero or negative. */
  discounts: number;
  delivery: number;
  tax: number;
  /** What customers actually paid: the grand totals. */
  charged: number;
  /** Order-level, so it nets ONLY `net` — never `sales`. */
  refunded: number;
  /** `charged - refunded`: collected after refunds. */
  net: number;
}

export interface AnalyticsDay extends AnalyticsMoney {
  /** YYYY-MM-DD in WAT (UTC+1, fixed — the server's own bucketing). Days with
   *  no paid order are ABSENT; a client drawing a calendar fills the gaps. */
  day: string;
  orders: number;
  /** The hand-recorded PART of this day. The money above stays the whole, so
   *  the online half is `charged - manual.charged` and never a third bucket. */
  manual: { charged: number; orders: number };
}

/** One source over the window. A source that sold nothing is absent. */
export interface AnalyticsSourceRow extends AnalyticsMoney {
  source: 'online' | 'manual';
  orders: number;
  items: number;
}

/** Manual sales cut by channel or by payment method; `key` null = not recorded. */
export interface AnalyticsBreakdownRow {
  key: string | null;
  orders: number;
  charged: number;
}

export interface AnalyticsStatusRow {
  status: string;
  /** Over `placed_at` — the pipeline strip, cancellations included. */
  count: number;
}

export interface AnalyticsProductRow {
  variantId: string;
  sku: string;
  title: string;
  units: number;
  /** GROSS line revenue, minor units — refunds are order-level and cannot be
   *  pinned to a line honestly, so they are netted in `totals`, not here. */
  gross: number;
  /** The part of `units`/`gross` with a known cost, and what those units cost
   *  us. Cost is frozen on each order line at sale time (migration 1300);
   *  older lines use the variant's cost today, counted in `estimatedUnits`.
   *  Optional: a server older than this change does not send them. */
  costedUnits?: number;
  costedGross?: number;
  cost?: number;
  estimatedUnits?: number;
}

/** Item sales against what those items cost, over the whole window. */
export interface AnalyticsProfit {
  sales: number;
  costedSales: number;
  cost: number;
  /** costedSales - cost. */
  profit: number;
  units: number;
  costedUnits: number;
  estimatedUnits: number;
}

export interface ShopAnalytics {
  /** The one instant every window below was measured from. */
  generatedAt: number;
  days: number;
  totals: AnalyticsMoney & {
    orders: number;
    items: number;
    /** `sales` over orders, minor units, 0 when there were none. */
    averageOrder: number;
  };
  /** Absent from a server older than this change — read it defensively. */
  profit?: AnalyticsProfit;
  revenueByDay: AnalyticsDay[];
  ordersByStatus: AnalyticsStatusRow[];
  /** The storefront against sales recorded by hand. Adds up to `totals`. */
  bySource: AnalyticsSourceRow[];
  manualByChannel: AnalyticsBreakdownRow[];
  manualByMethod: AnalyticsBreakdownRow[];
  /** Every seller in the window, best first, capped at 200 server-side. */
  topProducts: AnalyticsProductRow[];
}

/**
 * The aggregate carries NO currency field: the store settles everything in
 * naira and the server sums minor units without splitting by currency, so the
 * formatter is told NGN here once rather than each screen guessing it from a
 * row that does not exist.
 */
export const ANALYTICS_CURRENCY = 'NGN';

export const analyticsApi = {
  /**
   * `GET /api/shop/admin/analytics`. At the server's own default the `days`
   * param is OMITTED, not echoed — the wire carries only what differs from
   * the default, so the route's answer is its default and never a client's
   * copy of it.
   */
  async get(days: AnalyticsDays, signal?: AbortSignal): Promise<ShopAnalytics> {
    return apiFetch<ShopAnalytics>(`${BASE}/analytics`, {
      query: { days: days === ANALYTICS_DEFAULT_DAYS ? undefined : String(days) },
      signal,
    });
  },
};

export type AnalyticsApi = typeof analyticsApi;
