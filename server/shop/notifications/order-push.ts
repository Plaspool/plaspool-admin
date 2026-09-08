/**
 * "An order came in" — as a push to the phones that asked for it.
 *
 * THE THIRD CHANNEL, and the only one that reaches somebody with the admin
 * shut. Its two siblings are `queueStaffOrderEmail` (durable, retried, arrives
 * whenever the outbox is next drained) and the bell (instant, but only for a
 * person already looking at a screen). This is the one the owner asked for by
 * name: a buzz at eleven at night with the laptop closed.
 *
 * ═══════════════════ WHAT GATES IT, AND WHAT DOES NOT ═══════════════════
 * `notifyOnOrder` gates it — the master switch means no order announcements of
 * any kind, and a switch that silenced the email while phones kept buzzing
 * would be a switch nobody could trust.
 *
 * `notifyTeam` DOES NOT, and that is deliberate rather than an oversight. That
 * flag decides whether the shop MAILS the whole roster, which is an owner's
 * call about fan-out; a push subscription is a device somebody registered on
 * purpose, from that device, for themselves. Turning the roster email off to
 * route mail at a warehouse address must not silently unsubscribe the packer's
 * own phone — they never asked for that and nothing would tell them.
 *
 * `orderRecipients` cannot take part at all. A hand-typed address has no
 * browser and therefore no device; push reaches accounts, and only accounts.
 *
 * ═══════════════════ IT NEVER THROWS ═══════════════════
 * Same contract as `queueStaffOrderEmail` beside it, for the same reason: the
 * caller is the commerce-event consumer, where an exception parks an event
 * whose state change already stands.
 */
import { sql } from 'drizzle-orm';
import { hasDomain } from '../../../shared/roles';
import { getNotificationSettings } from './repo';
import { sendPushToUsers } from './push';
import { adminOrigin } from '../../admin-url';
import type { Db } from '../../db/client';
import type { Role } from '../../../shared/roles';

/** What the notification says, built from the order rather than from a template:
 *  a push payload is size-capped and has no HTML part to design. */
interface OrderLine {
  id: string;
  orderNumber: string;
  currency: string;
  grandTotal: number;
  email: string;
}

/**
 * Money, for a notification title.
 *
 * MINOR UNITS AT 100 PER NAIRA, and formatted here rather than reusing the
 * mail renderer's helper because that one belongs to a subsystem this file does
 * not import. Two decimal places and the ISO code, matching what every order
 * email already says — a phone that reads "32600.00 NGN" and an inbox that
 * reads the same thing are describing one order, which is the point.
 */
function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/**
 * Buzz every device belonging to somebody who handles orders.
 *
 * @returns how many devices got it. Zero is ordinary: push is not configured,
 * the switch is off, or nobody has registered a device.
 */
export async function sendStaffOrderPush(db: Db, orderId: string, now: number): Promise<number> {
  try {
    const settings = await getNotificationSettings(db);
    /* No row is treated as the switch being off rather than as a default, for
       `queueStaffOrderEmail`'s reason: migration 0980 seeds it, so null means a
       broken deployment, and inventing a policy there is worse than silence. */
    if (settings === null || !settings.notifyOnOrder) return 0;

    const orderRes = await db.execute(sql`
      SELECT id, order_number, currency, grand_total, email
        FROM shop_orders WHERE id = ${orderId}`);
    const row = orderRes.rows[0];
    if (!row) return 0;
    const order: OrderLine = {
      id: String(row.id),
      orderNumber: String(row.order_number),
      currency: String(row.currency),
      grandTotal: Number(row.grand_total),
      email: String(row.email),
    };

    /* The roster, filtered in TypeScript rather than in SQL: `hasDomain` is the
       one place that knows which of the six roles holds which of the ten
       domains (`shared/roles.ts`), and a role list rebuilt as a SQL IN clause
       is a second answer that goes stale the day a role is added. */
    const people = await db.execute(
      sql`SELECT id, role FROM users WHERE disabled_at IS NULL`,
    );
    const userIds = (people.rows as unknown as { id: string; role: string }[])
      .filter((u) => hasDomain(u.role as Role, 'orders'))
      .map((u) => u.id);
    if (userIds.length === 0) return 0;

    return await sendPushToUsers(
      db,
      userIds,
      {
        title: `New order ${order.orderNumber}`,
        body: `${money(order.grandTotal, order.currency)} — ${order.email} paid. Nothing sent out yet.`,
        /* Hash-routed, because `src/v2/main.tsx` uses `createHashRouter`, and
           the admin's OWN origin rather than the storefront's — the packer is
           being sent to the order screen, not to a shop page. */
        url: `${adminOrigin()}/#/orders/${encodeURIComponent(order.id)}`,
        /* One notification per order, replaced rather than stacked if this ever
           runs twice: a redelivered capture must not leave two identical rows
           on somebody's lock screen. */
        tag: `order-${order.id}`,
      },
      now,
    );
  } catch (cause) {
    console.error(
      '[push]',
      JSON.stringify({
        name: cause instanceof Error ? cause.name : 'unknown',
        message: cause instanceof Error ? cause.message : String(cause),
        route: 'sendStaffOrderPush',
      }),
    );
    return 0;
  }
}
