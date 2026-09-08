import { shopApi } from '../../data/api-shop';
import { ForbiddenError } from '../../data/errors';
import { listReviews } from '../../data/api-reviews';
import { money } from '../lib/format';

/**
 * The bell's content — REAL operational alerts assembled from endpoints that
 * already exist, not a notifications table this backend does not have. Each
 * alert is a standing FACT (emails are stuck, reviews are waiting), so
 * "read" is stored per-fact: the id names the fact, the `signature` encodes
 * its current magnitude, and a read alert whose signature changes counts as
 * unread again — three MORE stuck emails is news even if two were yesterday.
 *
 * Read state lives in localStorage: it is one person's own "seen it", not
 * shared state, and losing it costs a blue dot rather than data.
 *
 * ONE ALERT IS NOT AN AGGREGATE: a paid order gets a row of its own, with a
 * STABLE signature, because "order 2026-000123-A arrived" is a fact that never
 * grows and must stay dismissed once it has been seen. See the block that
 * builds them for why that is the opposite rule from the counts above it.
 */
export interface OpsAlert {
  id: string;
  /** The section it comes from — the meta line's "Settings •" slot. */
  source: string;
  title: string;
  body: string;
  at: number;
  to: string;
  tone: 'info' | 'warn' | 'critical';
  signature: string;
}

const READ_KEY = 'plaspool.v2.alerts.read';

/**
 * The id prefix every per-order alert carries.
 *
 * `isOrderAlert` is exported because the shell has to tell one order apart
 * from the aggregates — an order is the only fact worth raising a browser
 * notification for, and "three more emails are stuck" arriving as a desktop
 * pop-up would be the bell shouting about a number that was already on
 * screen. The prefix stays in the file that mints it rather than becoming a
 * `startsWith('order-')` in the shell, which is a contract nobody can see
 * from either end.
 */
const ORDER_PREFIX = 'order-';

export function isOrderAlert(alert: OpsAlert): boolean {
  return alert.id.startsWith(ORDER_PREFIX);
}

function readMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    /* private mode or corrupt store — everything reads as unread */
  }
  return {};
}

function writeMap(map: Record<string, string>) {
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify(map));
  } catch {
    /* not remembering is survivable */
  }
}

export function isUnread(alert: OpsAlert): boolean {
  return readMap()[alert.id] !== alert.signature;
}

export function markRead(alert: OpsAlert) {
  const map = readMap();
  map[alert.id] = alert.signature;
  writeMap(map);
}

export function markAllRead(alerts: OpsAlert[]) {
  const map = readMap();
  for (const alert of alerts) map[alert.id] = alert.signature;
  writeMap(map);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export async function fetchAlerts(signal?: AbortSignal): Promise<OpsAlert[]> {
  /* Reviews ride along best-effort: a moderation outage must not blank the
     whole bell, because the stuck-email alert is the one that matters most.

     THE STATS 403 IS SWALLOWED ON PURPOSE, AND ONLY THE 403. Stats sit in the
     analytics domain, which the scoped roles (a content writer, most visibly)
     do not hold — for them the refusal is the system working, and their bell
     is quiet, not broken. Every stats-fed alert simply doesn't exist for
     them; the reviews alert can still ride if their role may moderate. Any
     OTHER failure still throws, so the shell keeps treating a real outage as
     "keep the last list" rather than as an empty bell. */
  const [stats, reviews] = await Promise.all([
    shopApi.stats({}, signal).catch((cause: unknown) => {
      if (cause instanceof ForbiddenError) return null;
      throw cause;
    }),
    listReviews({ status: 'pending', limit: 25 }).catch(() => null),
  ]);

  const alerts: OpsAlert[] = [];

  if (stats && stats.emails.stuck > 0) {
    const n = stats.emails.stuck;
    alerts.push({
      id: 'emails-stuck',
      source: 'Emails',
      tone: 'critical',
      title: `${n} ${plural(n, 'email', 'emails')} will never send`,
      body: 'Out of retry attempts — retry or dismiss them from the outbox.',
      at: stats.generatedAt,
      to: '/emails/outbox',
      signature: String(n),
    });
  }

  /* ═══ PAID ORDERS ARE NAMED ONE BY ONE, AND THE AGGREGATE IS THE OVERFLOW ══
     `stats.latestOrders` — the five newest orders, id, number, email, total and
     all — has ridden in this payload since the dashboard strip was built and
     was read by NOTHING. So a row per paid order costs no new endpoint and no
     new request, and it is the difference between a bell that says somebody
     ought to look at Orders and one that says WHICH order arrived and for how
     much, which is the only version worth a notification.

     COUNTING THE NAMED ONES OUT OF THE TOTAL IS WHAT STOPS ONE ORDER BEING
     REPORTED TWICE. Five named rows sitting above "9 paid orders" reads as
     fourteen orders to somebody scanning the panel, and the reader who counts
     is the one who then goes looking for the five that do not exist. The
     aggregate keeps its id and its count-shaped signature — it is still the
     "the pile grew" fact — but it now counts only what the rows above did not
     name. */
  const named = stats ? stats.latestOrders.filter((row) => row.status === 'paid') : [];
  for (const row of named) {
    alerts.push({
      id: `${ORDER_PREFIX}${row.id}`,
      source: 'Orders',
      tone: 'info',
      /* `money` is the SAFE formatter. One row whose total came back as
         something that is not an integer of minor units must render as a
         placeholder in this line, not throw `MoneyShapeError` on the way
         through and take the whole bell to the route's error boundary. */
      title: `Order ${row.orderNumber} — ${money(row.grandTotal, row.currency)}`,
      body: `${row.email} paid. Nothing sent out yet.`,
      at: row.placedAt,
      to: `/orders/${row.id}`,
      /* STABLE, UNLIKE EVERY AGGREGATE'S SIGNATURE, and that is the whole
         read mechanism here. An aggregate encodes a COUNT so that a growing
         pile rings again; one order is one fact that never grows, so once it
         has been dismissed it stays dismissed rather than coming back every
         time the poll runs. The status is what this alert is about — an order
         that came back as something other than paid would be a different fact
         — and it cannot change while the alert exists, because a row that is
         no longer paid is filtered out above. */
      signature: row.status,
    });
  }

  const paid = stats
    ? stats.ordersByStatus
        .filter((row) => row.status === 'paid')
        .reduce((n, row) => n + row.count, 0)
    : 0;
  const unnamed = paid - named.length;
  if (stats && unnamed > 0) {
    alerts.push({
      id: 'orders-paid',
      source: 'Orders',
      tone: 'info',
      title:
        named.length > 0
          ? `${unnamed} more paid ${plural(unnamed, 'order', 'orders')} to send out`
          : `${unnamed} paid ${plural(unnamed, 'order', 'orders')} to send out`,
      body: 'Money already taken, parcels not yet on their way.',
      at: stats.generatedAt,
      to: '/orders',
      signature: String(unnamed),
    });
  }

  if (reviews && reviews.items.length > 0) {
    const n = reviews.items.length;
    const more = Boolean(reviews.nextCursor);
    alerts.push({
      id: 'reviews-pending',
      source: 'Reviews',
      tone: 'info',
      title: `${n}${more ? '+' : ''} ${plural(n, 'review', 'reviews')} awaiting moderation`,
      body: 'Nothing shows on the storefront until it is approved.',
      at: reviews.items[0]?.createdAt ?? stats?.generatedAt ?? Date.now(),
      to: '/products/reviews',
      signature: `${n}${more ? '+' : ''}`,
    });
  }

  if (stats && stats.lowStock.length > 0) {
    const n = stats.lowStock.length;
    alerts.push({
      id: 'low-stock',
      source: 'Inventory',
      tone: 'warn',
      title: `${n}${stats.lowStockMore ? '+' : ''} ${plural(n, 'variant', 'variants')} low on stock`,
      body: `At or below the low-stock threshold of ${stats.lowStockThreshold}.`,
      at: stats.generatedAt,
      to: '/products/inventory',
      signature: `${n}${stats.lowStockMore ? '+' : ''}`,
    });
  }

  return alerts;
}
