import { shopApi } from '../../data/api-shop';
import { listReviews } from '../../data/api-reviews';

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
     whole bell, because the stuck-email alert is the one that matters most. */
  const [stats, reviews] = await Promise.all([
    shopApi.stats({}, signal),
    listReviews({ status: 'pending', limit: 25 }).catch(() => null),
  ]);

  const alerts: OpsAlert[] = [];

  if (stats.emails.stuck > 0) {
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

  const paid = stats.ordersByStatus
    .filter((row) => row.status === 'paid')
    .reduce((n, row) => n + row.count, 0);
  if (paid > 0) {
    alerts.push({
      id: 'orders-paid',
      source: 'Orders',
      tone: 'info',
      title: `${paid} paid ${plural(paid, 'order', 'orders')} to fulfil`,
      body: 'Money already taken, parcels not yet on their way.',
      at: stats.generatedAt,
      to: '/orders',
      signature: String(paid),
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
      at: reviews.items[0]?.createdAt ?? stats.generatedAt,
      to: '/products/reviews',
      signature: `${n}${more ? '+' : ''}`,
    });
  }

  if (stats.lowStock.length > 0) {
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
