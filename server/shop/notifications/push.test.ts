/**
 * Web Push (migration 1040) — the storage, the send, and the order that
 * triggers it, against a real migrated database.
 *
 * `web-push` ITSELF IS MOCKED, and only it. Everything else here is the real
 * thing: the real table, the real settings row, the real roster filter, the
 * real consumer path. Mocking the transport is not a shortcut — a test that
 * genuinely posted to a push service would need a live subscription from a real
 * browser and would be asserting Google's uptime. What is worth pinning is what
 * this repository decides: WHO gets a push, and what happens to a device the
 * service says is gone.
 *
 * `push-loader.test.ts` beside this file covers the one thing a mock cannot —
 * that the import form works under Node's own ESM loader, which is where the
 * CommonJS trap lives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { resetEnvCacheForTests } from '../../env';

/** The transport double. `statusCode` is what the real library puts on its
 *  errors, and it is the whole basis of the prune-or-keep decision. */
const sent: { endpoint: string; body: string }[] = [];
let failWith: Record<string, number> = {};

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, body: string) => {
      const status = failWith[sub.endpoint];
      if (status !== undefined) {
        const err = new Error(`push service said ${status}`) as Error & { statusCode: number };
        err.statusCode = status;
        throw err;
      }
      sent.push({ endpoint: sub.endpoint, body });
      return { statusCode: 201 };
    }),
  },
}));

const {
  countPushSubscriptions,
  deletePushSubscription,
  pushConfigured,
  savePushSubscription,
  sendPushToUsers,
} = await import('./push');
const { sendStaffOrderPush } = await import('./order-push');

let ctx: TestCtx;
const NOW = 1_780_000_000_000;

/* A keypair-shaped pair of strings. Nothing verifies them here — web-push is
   mocked — and using real ones would imply this test proves crypto it does not. */
const KEYS = { publicKey: 'BPublicKeyForTestsOnly', privateKey: 'PrivateKeyForTestsOnly' };

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

async function seedUser(role: string, disabled = false): Promise<string> {
  /* `password_hash` is NOT NULL and there is no default. A placeholder rather
     than a real hash: nothing here authenticates, and a string that LOOKED like
     a credential would invite somebody to copy it somewhere that does. */
  const res = await ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at, disabled_at)
    VALUES (${`${role}-${Math.random().toString(36).slice(2)}@test.local`}, 'not-a-hash',
            ${`A ${role}`}, ${role}, ${NOW}, ${disabled ? NOW : null})
    RETURNING id`);
  return String((res.rows[0] as { id: string }).id);
}

async function device(userId: string, endpoint: string): Promise<void> {
  await savePushSubscription(
    ctx.db,
    userId,
    { endpoint, keys: { p256dh: 'p256dh-value-long-enough', auth: 'auth-val' } },
    NOW,
  );
}

beforeEach(async () => {
  sent.length = 0;
  failWith = {};
  process.env.VAPID_PUBLIC_KEY = KEYS.publicKey;
  process.env.VAPID_PRIVATE_KEY = KEYS.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:test@plaspool.com';
  resetEnvCacheForTests();
  await ctx.db.execute(sql`DELETE FROM shop_push_subscriptions`);
  await ctx.db.execute(sql`DELETE FROM users`);
  await ctx.db.execute(
    sql`UPDATE shop_notification_settings SET notify_on_order = true, notify_team = true`,
  );
});

describe('registering a device', () => {
  it('is idempotent on the endpoint — a browser re-subscribing is still one device', async () => {
    /* Browsers re-subscribe on their own schedule and rotate the keys when they
       do. Keyed on the person this would either duplicate the device — two
       pushes for one order — or throw away their other one. */
    const user = await seedUser('owner');
    await device(user, 'https://push.test/aaa');
    await savePushSubscription(
      ctx.db,
      user,
      { endpoint: 'https://push.test/aaa', keys: { p256dh: 'rotated-key-value-x', auth: 'newauth1' } },
      NOW + 1000,
    );

    expect(await countPushSubscriptions(ctx.db, user)).toBe(1);
    const res = await ctx.db.execute(
      sql`SELECT p256dh FROM shop_push_subscriptions WHERE endpoint = 'https://push.test/aaa'`,
    );
    // The refresh won: a stale key would encrypt to nothing the device can open.
    expect((res.rows[0] as { p256dh: string }).p256dh).toBe('rotated-key-value-x');
  });

  it('keeps one person’s phone and laptop apart', async () => {
    const user = await seedUser('owner');
    await device(user, 'https://push.test/phone');
    await device(user, 'https://push.test/laptop');
    expect(await countPushSubscriptions(ctx.db, user)).toBe(2);
  });

  it('follows whoever signed in last on a shared machine', async () => {
    /* One browser, two colleagues. The endpoint is the same, so the row has to
       move to the person actually signed in — otherwise their orders buzz on a
       device belonging to somebody who has gone home. */
    const first = await seedUser('owner');
    const second = await seedUser('developer');
    await device(first, 'https://push.test/shared');
    await device(second, 'https://push.test/shared');

    expect(await countPushSubscriptions(ctx.db, first)).toBe(0);
    expect(await countPushSubscriptions(ctx.db, second)).toBe(1);
  });

  it('forgets a device on request, and says nothing changed the second time', async () => {
    const user = await seedUser('owner');
    await device(user, 'https://push.test/gone');
    expect(await deletePushSubscription(ctx.db, 'https://push.test/gone')).toBe(1);
    expect(await deletePushSubscription(ctx.db, 'https://push.test/gone')).toBe(0);
  });
});

describe('sending', () => {
  it('does nothing at all when the deployment has no keys', async () => {
    process.env.VAPID_PRIVATE_KEY = '';
    resetEnvCacheForTests();
    expect(pushConfigured()).toBe(false);

    const user = await seedUser('owner');
    await device(user, 'https://push.test/aaa');
    expect(await sendPushToUsers(ctx.db, [user], payload(), NOW)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('reaches every device of every named person', async () => {
    const a = await seedUser('owner');
    const b = await seedUser('developer');
    await device(a, 'https://push.test/a1');
    await device(a, 'https://push.test/a2');
    await device(b, 'https://push.test/b1');

    expect(await sendPushToUsers(ctx.db, [a, b], payload(), NOW)).toBe(3);
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.test/a1',
      'https://push.test/a2',
      'https://push.test/b1',
    ]);
  });

  it('DELETES a subscription the service says is gone, and keeps one that merely failed', async () => {
    /*
     * 404 and 410 are permanent by definition — the browser was uninstalled,
     * the permission revoked, the profile wiped — and leaving those rows makes
     * every future order pay for a round trip that cannot succeed, growing
     * without bound as devices come and go. A 503 is the service having a
     * moment, and deleting over it would silently unsubscribe a live device
     * whose owner would never know why their phone went quiet.
     */
    const user = await seedUser('owner');
    await device(user, 'https://push.test/dead');
    await device(user, 'https://push.test/wobbly');
    await device(user, 'https://push.test/fine');
    failWith = { 'https://push.test/dead': 410, 'https://push.test/wobbly': 503 };

    expect(await sendPushToUsers(ctx.db, [user], payload(), NOW)).toBe(1);

    const left = await ctx.db.execute(
      sql`SELECT endpoint FROM shop_push_subscriptions ORDER BY endpoint`,
    );
    expect((left.rows as { endpoint: string }[]).map((r) => r.endpoint)).toEqual([
      'https://push.test/fine',
      'https://push.test/wobbly',
    ]);
  });

  it('never throws, whatever the transport does', async () => {
    /* Its caller is the commerce-event consumer, where an exception parks an
       event whose state change already stands. */
    const user = await seedUser('owner');
    await device(user, 'https://push.test/boom');
    failWith = { 'https://push.test/boom': 500 };
    await expect(sendPushToUsers(ctx.db, [user], payload(), NOW)).resolves.toBe(0);
  });
});

describe('an order buzzing the people who pack it', () => {
  it('reaches order-handling staff and nobody else', async () => {
    const owner = await seedUser('owner');
    const writer = await seedUser('writer'); // no `orders` domain
    const left = await seedUser('developer', true); // disabled
    await device(owner, 'https://push.test/owner');
    await device(writer, 'https://push.test/writer');
    await device(left, 'https://push.test/left');

    const orderId = await seedOrder();
    expect(await sendStaffOrderPush(ctx.db, orderId, NOW)).toBe(1);
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.test/owner']);
  });

  it('names the order and its total, and links into the admin', async () => {
    const owner = await seedUser('owner');
    await device(owner, 'https://push.test/owner');
    const orderId = await seedOrder();

    await sendStaffOrderPush(ctx.db, orderId, NOW);
    const body = JSON.parse(sent[0].body) as Record<string, string>;
    expect(body.title).toContain('New order');
    // Minor units at 100 per naira, the way every order email already says it.
    expect(body.body).toContain('32600.00 NGN');
    expect(body.url).toContain('/#/orders/');
    // No guest token: this link is forwarded around a warehouse.
    expect(body.url).not.toContain('token');
    expect(body.tag).toBe(`order-${orderId}`);
  });

  it('the master switch silences it', async () => {
    await ctx.db.execute(sql`UPDATE shop_notification_settings SET notify_on_order = false`);
    const owner = await seedUser('owner');
    await device(owner, 'https://push.test/owner');
    expect(await sendStaffOrderPush(ctx.db, await seedOrder(), NOW)).toBe(0);
  });

  it('but turning the ROSTER EMAIL off does not unsubscribe anybody’s phone', async () => {
    /*
     * THE ONE ASYMMETRY WORTH PINNING. `notifyTeam` decides whether the shop
     * MAILS the whole roster — an owner's call about fan-out. A push
     * subscription is a device somebody registered on purpose, from that
     * device, for themselves. Routing mail at a warehouse address must not
     * silently stop the packer's own phone, which they never asked for and
     * nothing would tell them.
     */
    await ctx.db.execute(sql`UPDATE shop_notification_settings SET notify_team = false`);
    const owner = await seedUser('owner');
    await device(owner, 'https://push.test/owner');
    expect(await sendStaffOrderPush(ctx.db, await seedOrder(), NOW)).toBe(1);
  });
});

const payload = () => ({ title: 't', body: 'b', url: '/#/orders/x', tag: 'x' });

async function seedOrder(): Promise<string> {
  const id = `ord_test_${Math.random().toString(36).slice(2, 10)}`;
  await ctx.db.execute(sql`
    INSERT INTO shop_orders (id, order_number, email, currency, subtotal, shipping_total,
                             tax_total, grand_total, status, shipping_address, billing_address,
                             placed_at, revision, source_event_id, checkout_id)
    VALUES (${id}, ${`2026-${Math.floor(Math.random() * 100000)}-X`}, 'buyer@example.test', 'NGN',
            3000000, 300000, 0, 3260000, 'paid', '{}'::jsonb, '{}'::jsonb,
            ${NOW}, 1, ${`evt_${id}`}, ${`chk_${id}`})`);
  return id;
}
