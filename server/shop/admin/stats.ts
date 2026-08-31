import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../db/client';
import type { Db } from '../../db/client';
import { EMAIL_ATTEMPT_LIMIT } from '../orders/repo/emails';
import type { OrderStatus } from '../orders/repo/orders';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  listInventory,
  type InventoryRow,
} from './inventory';

/**
 * The shop dashboard, in one request (HANDOFF §2 A4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROUTE AND FIVE STATEMENTS, AND THE COUNT OF STATEMENTS IS FIXED.
 *
 * Five aggregates run per call whether the shop holds ten orders or ten
 * thousand: orders by status, revenue by window, the low-stock head, the email
 * backlog, the latest five orders. Nothing here loops over rows issuing queries —
 * the shape this file exists to avoid is a dashboard that reads every order and
 * then asks the database something about each one, which is fine on the developer's
 * machine and is a timeout on the deployment.
 *
 * WHY NOT ONE STATEMENT WITH FIVE CTEs. It would be one round trip instead of
 * five, and it would also make every one of these numbers unreadable and
 * untestable in isolation — and four of the five are already index-backed, so the
 * saving is latency rather than work. Five named functions' worth of SQL in one
 * statement is how the aggregate nobody can explain gets shipped.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO NEW TABLE, NO ROLLUP, NO CACHE. Every number below is computed from the rows
 * that already exist, at read time. A materialised summary would be a second
 * source of truth about money, and the failure mode of one that drifts is a
 * dashboard that is confidently wrong — which is worse than a dashboard that
 * takes 40 ms.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** HANDOFF §2 A4: "latest 5 orders". */
export const LATEST_ORDER_COUNT = 5;

/**
 * How many low-stock variants the dashboard carries.
 *
 * A HEAD, NOT THE LIST, and `lowStockMore` says so rather than leaving the caller
 * to guess. The full list is `GET /api/shop/admin/inventory?belowOnly=1`, which
 * paginates; a stat tile that silently showed the first twenty of two hundred
 * would be the truncation `pageLimit` refuses to do elsewhere ("silently handing
 * back 100 makes a truncated page indistinguishable from a complete one").
 */
export const LOW_STOCK_PREVIEW = 20;

export interface OrderStatusTotal {
  status: OrderStatus;
  currency: string;
  count: number;
  /** Sum of `grandTotal`, MINOR UNITS. Not net of refunds — see `revenue`. */
  total: number;
}

export interface RevenueWindow {
  currency: string;
  /** All three are MINOR UNITS, net of refunds, over orders that were paid. */
  last24h: number;
  last7d: number;
  last30d: number;
}

export interface EmailBacklog {
  /** Written, not yet handed to a mailer, still inside the attempt budget. */
  pending: number;
  /** Written, not sent, and out of attempts. Nothing will retry these. */
  stuck: number;
  /** Delivered. Counted so "0 pending" can be told from "no email ever". */
  sent: number;
}

export interface LatestOrder {
  id: string;
  orderNumber: string;
  email: string;
  status: OrderStatus;
  currency: string;
  grandTotal: number;
  placedAt: number;
}

export interface ShopStats {
  /** The instant every number below was taken at. The windows are relative to it. */
  generatedAt: number;
  ordersByStatus: OrderStatusTotal[];
  revenue: RevenueWindow[];
  lowStockThreshold: number;
  lowStock: InventoryRow[];
  /** There are more low-stock variants than `lowStock` carries. */
  lowStockMore: boolean;
  emails: EmailBacklog;
  latestOrders: LatestOrder[];
}

export interface StatsQuery {
  /** Passed in rather than read from the clock, so the windows are testable. */
  now: number;
  threshold?: number;
}

/**
 * Orders by status, with their money.
 *
 * GROUPED BY `(status, currency)` AND NOT BY STATUS ALONE. Money is an integer
 * count of minor units plus an ISO-4217 code, and two codes cannot be added —
 * summing GBP and EUR into one integer produces a number that looks like a total
 * and reconciles against nothing. Contract §13 gives the shop one store currency
 * in v1, so in practice this returns one row per status; the grouping is what
 * makes the day that stops being true visible instead of silently wrong.
 *
 * A STATUS WITH NO ORDERS HAS NO ROW, and that is deliberate rather than an
 * oversight the client has to work around. A `{ status: 'refunded', count: 0 }`
 * row would have to carry a currency, and there is no order to take one from —
 * inventing `'GBP'` there would be this file asserting a fact it does not have.
 * The six statuses are a closed set the client already knows (`OrderStatus`), so
 * rendering a zero for an absent row is one line there and a lie here.
 */
async function ordersByStatus(db: Db): Promise<OrderStatusTotal[]> {
  const res = await db.execute(sql`
    SELECT o.status                  AS status,
           o.currency                AS currency,
           count(*)::int             AS count,
           sum(o.grand_total)::bigint AS total
      FROM shop_orders o
     GROUP BY o.status, o.currency
     ORDER BY o.status ASC, o.currency ASC`);
  return res.rows.map((row) => ({
    status: row.status as OrderStatus,
    currency: String(row.currency),
    count: Number(row.count),
    // `sum(int)` is int8: a number under PGlite's default parser and a string
    // under Neon and under the Neon-like parser the suites run (spec §9).
    total: Number(row.total),
  }));
}

/**
 * Revenue over three trailing windows.
 *
 * "TRAILING 24 HOURS", NOT "TODAY", AND THE NAME IS THE HONEST ONE. A calendar
 * "today" needs a timezone, and this deployment has none: there is no store
 * timezone column, no operator preference, and `Intl` in a serverless function
 * would answer UTC. A midnight boundary computed in UTC and labelled "today"
 * is a number that changes at 1 a.m. for a London shop in summer and at 4 p.m.
 * for one in Auckland, with nothing on the screen to explain it. A trailing
 * window is the same number for every reader, reproducible from `generatedAt`.
 *
 * IT COUNTS MONEY TAKEN, NOT ORDERS PLACED: the window is over `paid_at`, and an
 * order that has not been paid contributes nothing however recently it was
 * placed. `grand_total - refunded_total` is the net — a fully refunded order
 * nets to zero rather than disappearing, which is what makes a refunded day's
 * revenue go DOWN instead of the order silently leaving the count.
 *
 * ONE PASS OVER THE 30-DAY SET, WITH `FILTER` NARROWING IT TWICE. The `WHERE`
 * bounds the scan to the widest window; the two narrower ones are aggregate
 * filters over the same rows rather than two more queries.
 */
async function revenue(db: Db, now: number): Promise<RevenueWindow[]> {
  const net = sql.raw('sum(o.grand_total - o.refunded_total)');
  const res = await db.execute(sql`
    SELECT o.currency AS currency,
           COALESCE(${net} FILTER (WHERE o.paid_at >= ${now - DAY_MS}), 0)::bigint      AS last24h,
           COALESCE(${net} FILTER (WHERE o.paid_at >= ${now - 7 * DAY_MS}), 0)::bigint  AS last7d,
           COALESCE(${net}, 0)::bigint                                                  AS last30d
      FROM shop_orders o
     WHERE o.paid_at IS NOT NULL AND o.paid_at >= ${now - 30 * DAY_MS}
     GROUP BY o.currency
     ORDER BY o.currency ASC`);
  return res.rows.map((row) => ({
    currency: String(row.currency),
    last24h: Number(row.last24h),
    last7d: Number(row.last7d),
    last30d: Number(row.last30d),
  }));
}

/**
 * The order-email outbox, as three numbers.
 *
 * `stuck` IS SEPARATE FROM `pending` BECAUSE NOTHING WILL EVER RETRY IT.
 * `sweepEmailIntents` stops at `EMAIL_ATTEMPT_LIMIT` attempts and leaves the row
 * in place with its `last_error` — deliberately, so one undeliverable address
 * cannot consume every sweep's budget forever. Folded into one "unsent" number,
 * a permanently failed confirmation would sit in the same tile as a message that
 * goes out in the next sweep, and the operator would watch the count fail to
 * drop with no way to tell which half was moving.
 *
 * ⚠️  `sent` MEANS "HANDED TO THE MAILER", exactly as the admin order view's
 *     `emails` do. The default `LoggingMailer` records the message and delivers
 *     nothing (HANDOFF §1.11), so a non-zero `sent` on a deployment with no real
 *     mailer wired is truthful about this system and says nothing about anybody's
 *     inbox.
 */
async function emailBacklog(db: Db): Promise<EmailBacklog> {
  /* `dismissed_at IS NULL` on both unsent buckets (migration 0660): a dismissed
   * intent is one the operator has ruled on, and counting it in `stuck` would
   * make the Home banner un-clearable by the very screen built to clear it. */
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE e.sent_at IS NULL AND e.dismissed_at IS NULL
                              AND e.attempts <  ${EMAIL_ATTEMPT_LIMIT})::int AS pending,
           count(*) FILTER (WHERE e.sent_at IS NULL AND e.dismissed_at IS NULL
                              AND e.attempts >= ${EMAIL_ATTEMPT_LIMIT})::int AS stuck,
           count(*) FILTER (WHERE e.sent_at IS NOT NULL)::int                AS sent
      FROM shop_order_email_intents e`);
  const row = res.rows[0];
  return {
    pending: Number(row.pending),
    stuck: Number(row.stuck),
    sent: Number(row.sent),
  };
}

/**
 * The five most recent orders, as a strip rather than as order objects.
 *
 * NO LINES, and that is what keeps this cheap: `GET /admin/orders` aggregates
 * every line of every order it returns, which is right for a list an operator
 * works from and wrong for a dashboard strip nobody reads the contents of. Seven
 * columns, five rows, and the client links each to `/admin/orders/:id` for the
 * rest.
 *
 * ⚠️  THE ONE PART OF THIS ROUTE THAT IS NOT INDEX-BACKED. `shop_orders` carries
 *     `(customer_id, placed_at DESC, id)` and `(status, placed_at DESC, id)` but
 *     nothing on `placed_at` alone, so this is a top-N sort over the table.
 *     Postgres does it as a bounded heapsort and it costs nothing at the scale a
 *     dashboard is for; a shop that outgrows it wants
 *     `CREATE INDEX … ON shop_orders (placed_at DESC, id)`, which is a migration
 *     and HANDOFF §2 A4 explicitly allocates none to this work. Recorded here so
 *     it is a known cost rather than a surprise.
 */
async function latestOrders(db: Db): Promise<LatestOrder[]> {
  const res = await db.execute(sql`
    SELECT o.id, o.order_number, o.email, o.status, o.currency, o.grand_total, o.placed_at
      FROM shop_orders o
     ORDER BY o.placed_at DESC, o.id ASC
     LIMIT ${LATEST_ORDER_COUNT}`);
  return res.rows.map((row) => ({
    id: String(row.id),
    orderNumber: String(row.order_number),
    email: String(row.email),
    status: row.status as OrderStatus,
    currency: String(row.currency),
    grandTotal: Number(row.grand_total),
    placedAt: toEpochMs(row.placed_at),
  }));
}

/**
 * The whole dashboard.
 *
 * THE FIVE READS RUN IN PARALLEL. They are independent — no result feeds
 * another — and the production driver is Neon over HTTP, where each statement is
 * its own request: sequentially that is five round trips of latency for work that
 * costs one. `Promise.all` is safe here for the same reason it would not be on a
 * write path: nothing below writes anything, so there is no ordering to preserve
 * and no statement whose failure should abandon another's effect.
 *
 * THE SNAPSHOT IS NOT ATOMIC AND DOES NOT NEED TO BE. Five statements see five
 * instants, so an order paid between the first and the third appears in one
 * number and not another. On a dashboard refreshed every few seconds that is
 * invisible; buying atomicity would mean a repeatable-read transaction, which the
 * Neon HTTP driver refuses outright (`db.transaction` throws on it — the
 * divergence `server/repo/posts.ts` documents). Stated rather than pretended.
 */
export async function shopStats(db: Db, q: StatsQuery): Promise<ShopStats> {
  const lowStockThreshold = q.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;

  const [statuses, revenues, low, emails, latest] = await Promise.all([
    ordersByStatus(db),
    revenue(db, q.now),
    listInventory(db, {
      belowOnly: true,
      threshold: lowStockThreshold,
      limit: LOW_STOCK_PREVIEW,
    }),
    emailBacklog(db),
    latestOrders(db),
  ]);

  return {
    generatedAt: q.now,
    ordersByStatus: statuses,
    revenue: revenues,
    lowStockThreshold,
    lowStock: low.items,
    // `nextCursor` is `listInventory`'s own "there is another page" evidence,
    // reused rather than recomputed with a second COUNT.
    lowStockMore: low.nextCursor !== null,
    emails,
    latestOrders: latest,
  };
}
