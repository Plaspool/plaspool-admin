import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { ID, newId } from './ids';
import { readOrder } from './repo/orders';
import { renderStaffNewOrder } from './mailer';
import { adminOrigin } from '../../admin-url';
import { foldAddress, getNotificationSettings } from '../notifications/repo';
import { listUsers } from '../../repo/users';
import { hasDomain } from '../../../shared/roles';
import { BUILT_IN } from '../../email/system-templates';
import type { TemplateSet } from '../../email/system-templates';

/**
 * "An order came in" — queued for the shop's own staff when a payment captures
 * (migration 0980).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT MUST NEVER THROW, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
 *
 * Its caller is the commerce-event consumer, running inside the sweep, AFTER
 * `markOrderPaid` has already applied a state change. An exception there parks
 * an event whose effect stands, so the next sweep replays it — and because the
 * sweep drains to a fixed point, one unhappy notification would stop every
 * later event behind it, for ever, over an email nobody read yet.
 *
 * `spendPoints` and `countDiscountUse` in `repo/consumer.ts` are shaped the
 * same way for the same reason, and they have the stronger claim: money. This
 * one is only a message. So it catches EVERYTHING and returns a count, and the
 * worst outcome of any failure in here is that a paid order is not announced —
 * which the in-app bell and the orders board both still show.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SHAPED ON `review-mail.ts`: a direct INSERT into the order outbox, keyed by a
 * dedupe key, delivered later by the sweeper. The intent row is written here
 * and nothing is sent here — a paid order must not depend on an email provider
 * being up.
 */

/**
 * The prefix on every dedupe key this file writes.
 *
 * ONE ROW PER (ORDER, ADDRESS) FOREVER. Paystack redelivers and the sweep
 * retries, so `payment.captured` reaching this function twice is ordinary
 * rather than exceptional; the UNIQUE on `dedupe_key` is what makes the second
 * pass write nothing instead of mailing the warehouse about the same order
 * again. The ADDRESS is in the key and not just the order id, because the
 * recipient list can grow between two passes and somebody added afterwards
 * should still be told.
 */
const DEDUPE_PREFIX = 'staff_new_order';

/**
 * Every address to tell, folded and de-duplicated.
 *
 * THE UNION OF TWO LISTS THAT OVERLAP IN PRACTICE. A manager typed into the
 * settings screen usually also has an admin account, so `sales@plaspool.com`
 * arrives twice — once from the roster, once from the hand-typed list — and
 * two rows would be two identical emails about one order. Folded comparison
 * decides identity; the FIRST spelling seen is what gets stored and mailed,
 * and the hand-typed list goes first because it is the one a person chose.
 *
 * A DISABLED ACCOUNT IS NOT ON THE TEAM. Disabling is how somebody is removed
 * from this shop, and continuing to mail them a customer's name and order value
 * afterwards would make that removal cosmetic.
 */
async function resolveRecipients(
  db: Db,
  typed: readonly string[],
  includeTeam: boolean,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): void => {
    const value = raw.trim();
    if (value === '') return;
    const folded = foldAddress(value);
    if (seen.has(folded)) return;
    seen.add(folded);
    out.push(value);
  };

  for (const address of typed) add(address);

  if (includeTeam) {
    /*
     * THE ROSTER IS FILTERED BY DOMAIN, NOT BY ROLE NAME. `hasDomain(role,
     * 'orders')` is the same question the permissions middleware asks before it
     * lets somebody open an order, so the set of people mailed about orders and
     * the set who can act on one cannot drift apart — and a role added to
     * `ROLE_INFO` later is included or excluded by its own grants rather than by
     * a list in this file that nobody would remember to update.
     */
    for (const user of await listUsers(db)) {
      if (user.disabledAt !== null) continue;
      if (!hasDomain(user.role, 'orders')) continue;
      add(user.email);
    }
  }

  return out;
}

/** The name on the shipping address, or the buyer's own address. */
function customerLabel(shippingAddress: Record<string, unknown>, email: string): string {
  const name = shippingAddress.name;
  if (typeof name === 'string' && name.trim() !== '') return name.trim();
  return email;
}

/**
 * Queue the alert, one row per recipient.
 *
 * @returns how many intent rows were written. ZERO IS AN ORDINARY ANSWER, not a
 * failure: the switch is off, nobody is configured, the order has gone, or a
 * redelivered event landed on rows that already exist. The caller does not
 * distinguish them, and deliberately — see the header.
 */
export async function queueStaffOrderEmail(
  db: Db,
  orderId: string,
  now: number,
  templates: TemplateSet = BUILT_IN,
): Promise<number> {
  try {
    const settings = await getNotificationSettings(db);
    /*
     * NO ROW IS TREATED LIKE THE SWITCH BEING OFF, and not like a default.
     * Migration 0980 seeds the row, so `null` means a hand-run DELETE or a
     * database restored from before it — a broken deployment. Inventing
     * recipients there would mail a list nobody chose; sending nothing is the
     * failure this code is allowed to have.
     */
    if (settings === null || !settings.notifyOnOrder) return 0;

    const recipients = await resolveRecipients(
      db,
      settings.orderRecipients,
      settings.notifyTeam,
    );
    if (recipients.length === 0) return 0;

    const read = await readOrder(db, orderId);
    if (!read) return 0;

    const view = {
      orderNumber: read.order.orderNumber,
      email: read.order.email,
      currency: read.order.currency,
      grandTotal: read.order.grandTotal,
      /* What was charged (1140), read back off the row the paid transition
       * wrote it to — shown beside the total only when it is not naira. */
      charge: read.order.charge,
      placedAt: read.order.placedAt,
      customer: customerLabel(read.order.shippingAddress, read.order.email),
      // Σ qty, not `lines.length` — three of one thing is three things to pack.
      itemCount: read.lines.reduce((sum, line) => sum + line.qty, 0),
      lines: read.lines.map((line) => ({
        title: line.title,
        sku: line.sku,
        qty: line.qty,
        lineTotal: line.lineTotal,
        imageId: line.imageId,
      })),
      addOns: read.addOns.map((addOn) => ({
        title: addOn.title,
        amount: addOn.amount,
        mode: addOn.mode,
      })),
    };

    /* The admin's own origin, never the storefront's and never a request
     * header — `server/admin-url.ts` carries the account of the invitation link
     * that shipped with the wrong one. Hash routing, so the order page is
     * `/#/orders/:id`. */
    const adminUrl = `${adminOrigin()}/#/orders/${encodeURIComponent(read.order.id)}`;

    /*
     * ONE ROW PER ADDRESS, NEVER ONE ROW WITH A COMMA LIST. `resendMailer`
     * posts a single `to` per send, so a comma list would either be refused or
     * delivered to the first address only — and a bounce for one colleague
     * would take the message away from all of them.
     *
     * ONE STATEMENT ALL THE SAME, because the Neon HTTP driver has no
     * transaction (CLAUDE.md §3) and a loop of INSERTs can therefore stop
     * halfway, leaving some of the team told and the rest not, with nothing to
     * roll back. A multi-row INSERT either writes them all or writes none.
     */
    const values: SQL[] = recipients.map((to) => {
      const rendered = renderStaffNewOrder(view, to, adminUrl, templates);
      return sql`(${newId(ID.emailIntent)}, ${read.order.id}, 'staff_new_order', ${to},
                  ${rendered.subject}, ${rendered.body}, ${rendered.html ?? null}::text,
                  ${now}, ${`${DEDUPE_PREFIX}:${read.order.id}:${foldAddress(to)}`})`;
    });

    const res = await db.execute(sql`
      INSERT INTO shop_order_email_intents
        (id, order_id, kind, to_email, subject, body, html, created_at, dedupe_key)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING 1`);

    return res.rows.length;
  } catch (err: unknown) {
    /*
     * NAME AND MESSAGE ONLY. The values in scope here are a customer's address,
     * their order total and the shop's staff addresses, and a driver error can
     * carry the bound parameters that produced it — `guardDb` exists because
     * this repository has shipped that once already. A log line is not a place
     * to widen the blast radius of a failure that is, by construction, allowed
     * to happen.
     */
    // eslint-disable-next-line no-console -- the only record that this failed
    console.error(
      '[shop/orders/staff-mail] could not queue the new-order alert',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    return 0;
  }
}
