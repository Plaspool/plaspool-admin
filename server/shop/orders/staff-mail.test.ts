import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, resetOrderTables } from './test/harness';
import type { TestCtx } from './test/harness';
import { CHECKOUT, checkoutCompleted, insertEvents, paymentCaptured } from './test/fixtures';
import { sweepCommerceEvents } from './repo/consumer';
import { readOrderByCheckout } from './repo/orders';
import { listIntents } from './repo/emails';
import { queueStaffOrderEmail } from './staff-mail';
import type { Db } from '../../db/client';

/**
 * The paid-order alert the shop sends to ITSELF (migration 0980).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DRIVEN THROUGH THE REAL CONSUMER wherever it can be, because the call site is
 * half the feature: this fires from `payment.captured` inside `runSweep`, and a
 * suite that only called `queueStaffOrderEmail` directly would pass just as
 * happily if nothing in `consumer.ts` ever called it. That is the exact shape
 * of failure CLAUDE.md §2 keeps recording.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The four claims worth pinning are the ones that are invisible when they break:
 * that the master switch really stops the write; that somebody who is BOTH a
 * team account and a typed-in address gets one email rather than two; that a
 * redelivered capture writes no second row; and that a failure in here is
 * swallowed, because a throw would park an event whose state change already
 * stands and stop the sweep at its first problem for ever.
 */

let ctx: TestCtx;
const NOW = 1_788_900_000_000;
const ORIGIN = 'https://shop.test';

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`
    UPDATE shop_notification_settings
       SET order_recipients = '{}', notify_team = true, notify_on_order = true, revision = 1
     WHERE id = 'main'`);
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
});

/** Run the pipeline the way production does: two events, one sweep. */
async function paidOrder() {
  await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
  await sweepCommerceEvents(ctx.db, { origin: ORIGIN }, NOW);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

const staffMail = async (orderId: string) =>
  (await listIntents(ctx.db, orderId)).filter((intent) => intent.kind === 'staff_new_order');

const addressesOf = async (orderId: string) =>
  (await staffMail(orderId)).map((intent) => intent.to.toLowerCase()).sort();

describe('who gets told', () => {
  /*
   * THE DEFAULT IS THE ROSTER. `notify_team` is seeded true with an empty typed
   * list, so a shop that has never opened the settings screen still tells the
   * people who handle orders — which is the whole reason the migration seeds it
   * on. Owner, developer, supply chain and support hold `orders`; the writer and
   * marketing do not, and are not mailed a customer's name and order value.
   */
  it('mails every account holding `orders`, and nobody else', async () => {
    const read = await paidOrder();
    expect(await addressesOf(read.order.id)).toEqual([
      'developer@test.local',
      'owner@test.local',
      'supply@test.local',
      'support@test.local',
    ]);
  });

  it('adds the hand-typed addresses on top of the roster', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings
         SET order_recipients = ARRAY['packing@plaspool.com']::text[] WHERE id = 'main'`);
    const read = await paidOrder();
    expect(await addressesOf(read.order.id)).toContain('packing@plaspool.com');
    expect(await staffMail(read.order.id)).toHaveLength(5);
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ONE EMAIL, NOT TWO. A manager typed into the settings screen usually also
   * has an admin account, so the two lists overlap in the ordinary case rather
   * than the exceptional one — and two rows would be two identical messages
   * about one order, which is how a shop teaches its own staff to filter it.
   * The comparison folds case, because `Owner@` and `owner@` are one inbox.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('sends ONE email to an address that is both a team account and typed in', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings
         SET order_recipients = ARRAY['Owner@Test.Local']::text[] WHERE id = 'main'`);
    const read = await paidOrder();

    const mine = (await staffMail(read.order.id)).filter(
      (intent) => intent.to.toLowerCase() === 'owner@test.local',
    );
    expect(mine).toHaveLength(1);
    /* The FIRST spelling seen wins, and the hand-typed list goes first because
       it is the one a person chose. */
    expect(mine[0]!.to).toBe('Owner@Test.Local');
    expect(await staffMail(read.order.id)).toHaveLength(4);
  });

  /* Disabling an account is how somebody is removed from this shop. Continuing
     to mail them a customer's name and order value would make that cosmetic. */
  it('does not mail a disabled account', async () => {
    await ctx.db.execute(sql`
      UPDATE users SET disabled_at = ${NOW} WHERE email = 'support@test.local'`);
    const read = await paidOrder();
    expect(await addressesOf(read.order.id)).not.toContain('support@test.local');
  });

  it('mails only the typed list when the team switch is off', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings
         SET notify_team = false, order_recipients = ARRAY['packing@plaspool.com']::text[]
       WHERE id = 'main'`);
    const read = await paidOrder();
    expect(await addressesOf(read.order.id)).toEqual(['packing@plaspool.com']);
  });

  it('writes nothing when the team switch is off and nobody is typed in', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings SET notify_team = false WHERE id = 'main'`);
    const read = await paidOrder();
    expect(await staffMail(read.order.id)).toHaveLength(0);
  });
});

describe('the master switch', () => {
  /*
   * OFF MEANS NOTHING IS QUEUED AT ALL — not "queued and dropped later". The
   * intent row is the record of what was sent, so a row written while the shop
   * has switched the alert off would be a message the outbox screen shows and
   * the sweeper eventually delivers.
   */
  it('writes nothing at all when it is off', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings SET notify_on_order = false WHERE id = 'main'`);
    const read = await paidOrder();
    expect(await staffMail(read.order.id)).toHaveLength(0);
    /* And the customer's own confirmation is untouched: this switch is about
       who WE tell, and turning it off must not stop the buyer being told. */
    expect(
      (await listIntents(ctx.db, read.order.id)).some((i) => i.kind === 'confirmation'),
    ).toBe(true);
  });
});

describe('redelivery', () => {
  /*
   * Paystack redelivers and the sweep retries, so reaching this function twice
   * for one order is ordinary. The UNIQUE on `dedupe_key` is what makes the
   * second pass write nothing — not a condition somebody could forget.
   */
  it('writes no second row for the same order and address', async () => {
    const read = await paidOrder();
    const before = await staffMail(read.order.id);
    expect(before.length).toBeGreaterThan(0);

    const written = await queueStaffOrderEmail(ctx.db, read.order.id, NOW + 5_000);
    expect(written).toBe(0);
    expect(await staffMail(read.order.id)).toHaveLength(before.length);
  });

  /* Somebody added to the list AFTER the first pass should still be told — which
     is why the address is in the dedupe key and not just the order id. */
  it('still writes for an address added after the first pass', async () => {
    const read = await paidOrder();
    const before = (await staffMail(read.order.id)).length;

    await ctx.db.execute(sql`
      UPDATE shop_notification_settings
         SET order_recipients = ARRAY['latecomer@plaspool.com']::text[] WHERE id = 'main'`);
    expect(await queueStaffOrderEmail(ctx.db, read.order.id, NOW + 5_000)).toBe(1);
    expect(await addressesOf(read.order.id)).toContain('latecomer@plaspool.com');
    expect(await staffMail(read.order.id)).toHaveLength(before + 1);
  });
});

describe('what the message says', () => {
  it('names the order, the total, the item count, the buyer and the admin link', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_notification_settings
         SET notify_team = false, order_recipients = ARRAY['packing@plaspool.com']::text[]
       WHERE id = 'main'`);
    const read = await paidOrder();
    const [alert] = await staffMail(read.order.id);

    expect(alert!.subject).toContain(read.order.orderNumber);
    /* The name off the shipping address, not the local part of the buyer's
       email — `jane.o` reads as a name to a colleague and is not one. */
    expect(alert!.body).toContain('A Buyer');
    expect(alert!.body).toContain(String(read.lines.reduce((n, l) => n + l.qty, 0)));
    /* The ADMIN's origin, not the storefront's, and carrying no token of its
       own: this message can be forwarded around a warehouse. */
    expect(alert!.body).toContain('/#/orders/');
    expect(alert!.body).not.toContain(ORIGIN);
    expect(alert!.html).not.toBeNull();
  });
});

describe('failure', () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * IT MUST NEVER THROW. The caller runs inside the commerce-event consumer,
   * AFTER `markOrderPaid` has applied a state change — an exception there parks
   * an event whose effect stands, and because the sweep drains to a fixed point
   * one unhappy notification would stop every later event behind it for ever.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('swallows a database failure and answers zero', async () => {
    const broken = {
      execute: () => Promise.reject(new Error('connection lost')),
    } as unknown as Db;

    await expect(queueStaffOrderEmail(broken, 'ord_whatever', NOW)).resolves.toBe(0);
    expect(errors).toHaveBeenCalled();
  });

  /* An order that has gone is not a failure either — nothing to announce. */
  it('answers zero for an order that does not exist', async () => {
    expect(await queueStaffOrderEmail(ctx.db, 'ord_missing', NOW)).toBe(0);
  });
});
