import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from '../orders/test/fixtures';
import { sweepCommerceEvents } from '../orders/repo/consumer';
import type { ConsumerDeps } from '../orders/repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout } from '../orders/repo/orders';
import type { OrderRead } from '../orders/repo/orders';
import { createFulfillment, readFulfillment, shipFulfillment } from '../orders/repo/fulfillments';
import type { Fulfillment } from '../orders/repo/fulfillments';
import { recordCourierBooking } from '../orders/repo/courier';
import { listIntents } from '../orders/repo/emails';
import { resetOrdersDeps } from '../orders/ports';
import { resetLogisticsEnv } from './config';
import { resetLogisticsDeps } from './deps';
import { listRecentWebhooks } from './repo';
import type { WebhookRow } from './repo';

/**
 * THE COURIERS' INBOUND DOOR, THROUGH THE APP PRODUCTION ACTUALLY BUILDS.
 *
 * This file exists for the reason `server/shop/composition.test.ts` exists, and
 * it is the same reason twice over.
 *
 * **The mount is not the route.** `webhooks.ts` can be perfect and answer 403 to
 * every real delivery, because a courier's POST carries no `Origin` — which is
 * exactly what `originGuard` refuses on an unsafe method, and exactly what
 * happened to the Paystack webhook (AMENDMENTS A-PAY-001: a 403 with zero rows
 * stored). A suite that builds `createLogisticsWebhookRoutes()` on its own Hono
 * would prove the handler and nothing about the two lines in `server/index.ts`
 * that decide whether a courier can reach it at all. So every request below goes
 * through the REAL `createApp()`, at the REAL path, WITH NO ORIGIN AND NO COOKIE.
 *
 * **The sweep's courier step is a registration, not a function.**
 * `syncCourierStatuses` is proved in `sync.test.ts` against a fake courier;
 * whether `GET /admin/sweep` ever calls it depends on `registerOrdersDefaults`
 * in `server/index.ts`, which no Orders suite can see — they register their own
 * fakes on purpose. `resetOrdersDeps()` below leaves the registry as empty as a
 * cold process, so the composition root is the only thing that fills it.
 *
 * NOTHING IS REGISTERED WITH `registerLogisticsDeps`. The adapters under test
 * are the ones `resolveLogisticsDeps()` builds from `process.env`, because the
 * signature check is the whole of this endpoint's authority and a fake provider
 * would verify a signature production would refuse. They reach no network: the
 * only adapter method any request here calls is `parseWebhook`, which is pure.
 */

let ctx: TestCtx;
let client: HttpClient;

const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };

/**
 * Fez signs `orderNumber + status + timestamp` with HMAC-SHA256 under the
 * ORGANISATION'S SECRET KEY, which `FEZ_SECRET_KEY` supplies. `FEZ_USER_ID` and
 * `FEZ_PASSWORD` are what make `logisticsEnv()` build a Fez adapter at all —
 * without them the courier is "not configured" and every delivery is a 401.
 */
const FEZ_SECRET = 'fez-webhook-secret-0001';
/** Terminal signs the RAW BODY with HMAC-SHA512 under its API secret. */
const TERMINAL_SECRET = 'sk_test_terminal_composition_0001';
const CRON_SECRET = 'a-test-cron-secret-at-least-16-chars-long';

const FEZ_PATH = '/api/shop/logistics/fez/webhook';
const TERMINAL_PATH = '/api/shop/logistics/terminal/webhook';

/**
 * Deliver a body the way a courier does: **no `Origin`, no `Cookie`**, straight
 * at `app.request` rather than through `httpClient`'s helpers, which add both.
 *
 * The fourth argument is the `ExecutionContext` Hono needs when a handler
 * touches `c.executionCtx`. Nothing in this router defers work — the write is
 * one parcel and a replayed webhook is a no-op, which is what makes doing it
 * inline honest — but supplying one costs nothing and keeps this helper usable
 * if that ever changes.
 */
async function deliver(
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return client.app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
    {},
    { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} },
  );
}

/** A Fez delivery, signed the way Fez signs one. */
function fezDelivery(
  orderNumber: string,
  status: string,
  opts: { at?: number; extra?: Record<string, unknown> } = {},
): { body: string; headers: Record<string, string> } {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const body = JSON.stringify({ orderNumber, status, ...opts.extra });
  return {
    body,
    headers: {
      'x-timestamp': ts,
      'x-signature': createHmac('sha256', FEZ_SECRET).update(orderNumber + status + ts).digest('hex'),
    },
  };
}

/** A Terminal delivery, signed over the raw bytes. */
function terminalDelivery(payload: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      'x-terminal-signature': createHmac('sha512', TERMINAL_SECRET).update(body).digest('hex'),
    },
  };
}

async function paidOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** A parcel with a live booking on it, through the real repository. */
async function bookedParcel(
  order: OrderRead,
  provider: 'fez' | 'terminal',
  providerRef: string,
): Promise<Fulfillment> {
  const parcel = await createFulfillment(
    ctx.db,
    order.order.id,
    { lines: [{ orderLineId: order.lines[0].id, qty: 1 }], carrier: null, trackingNumber: null },
    ctx.users.owner.id,
    NOW,
  );
  return recordCourierBooking(ctx.db, parcel.id, {
    provider,
    providerRef,
    carrier: provider === 'fez' ? 'Fez Delivery' : 'DHL',
    trackingNumber: providerRef,
    trackingUrl: `https://track.test/${providerRef}`,
    labelUrl: null,
    costMinor: 645_000,
    rawStatus: provider === 'fez' ? 'Pending Pick-Up' : 'confirmed',
    state: 'booked',
    now: NOW,
    actorId: ctx.users.owner.id,
    message: `Booked · ${providerRef}`,
  });
}

const reread = async (id: string): Promise<Fulfillment> =>
  (await readFulfillment(ctx.db, id))!.fulfillment;

async function timeline(orderId: string): Promise<string[]> {
  const res = await ctx.db.execute(sql`
    SELECT type FROM shop_order_events WHERE order_id = ${orderId}
     ORDER BY occurred_at ASC, id ASC`);
  return res.rows.map((r) => String(r.type));
}

const webhookLog = (): Promise<WebhookRow[]> => listRecentWebhooks(ctx.db, 20);

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  for (const key of ['FEZ_USER_ID', 'FEZ_PASSWORD', 'FEZ_SECRET_KEY', 'TERMINAL_SECRET_KEY']) {
    delete process.env[key];
  }
  resetLogisticsEnv();
  resetLogisticsDeps();
  await ctx?.close();
});

beforeEach(async () => {
  process.env.FEZ_USER_ID = 'composition@plaspool.test';
  process.env.FEZ_PASSWORD = 'not-a-real-password';
  process.env.FEZ_SECRET_KEY = FEZ_SECRET;
  process.env.TERMINAL_SECRET_KEY = TERMINAL_SECRET;
  /* Both memos: `logisticsEnv()` caches the parse for the process, and `deps.ts`
     caches the adapters it built from it. A suite that set the variables and not
     these would be testing whichever environment happened to be read first. */
  resetLogisticsEnv();
  resetLogisticsDeps();

  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`TRUNCATE shop_logistics_webhooks`);

  /* Empty, exactly as a cold process is — so `createApp()`'s own
     `registerOrdersDefaults` is the only thing that fills the sweep's seams. */
  resetOrdersDeps();
  client = httpClient(ctx.db);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

// ================================================================== Fez

describe('the Fez webhook', () => {
  it('is reachable with no Origin and no cookie, and refuses an unsigned body with 401', async () => {
    /*
     * THE TWO HALVES OF THE MOUNT IN ONE ASSERTION. A 403 here would mean the
     * router is below `originGuard` and no genuine delivery could ever land; a
     * 200 would mean the signature is not the credential it is supposed to be.
     */
    const res = await deliver(FEZ_PATH, JSON.stringify({ orderNumber: 'ASAC1', status: 'Delivered' }), {});

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'bad_signature' });

    /* LOGGED ANYWAY. The settings screen's question is "does this courier reach
       us at all", and a refused delivery is part of that answer. */
    const log = await webhookLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ provider: 'fez', verified: false, applied: 'rejected' });
  });

  it('a signed Dispatched flips a pending booked parcel to shipped and queues the shipping email', async () => {
    const order = await paidOrder();
    const parcel = await bookedParcel(order, 'fez', 'ASAC1');

    const { body, headers } = fezDelivery('ASAC1', 'Dispatched');
    const res = await deliver(FEZ_PATH, body, headers);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, changed: true, transitioned: 'shipped' });

    const after = await reread(parcel.id);
    expect(after).toMatchObject({ status: 'shipped', courierState: 'in_transit', providerStatus: 'Dispatched' });

    /* The email is written by the SAME statement as the status change — a
       courier's "on its way" therefore sends what the ship button sends. */
    const kinds = (await listIntents(ctx.db, order.order.id)).map((i) => i.kind);
    expect(kinds).toContain('shipment');

    /* The courier's own word first, then the parcel's lifecycle — in that order,
       because the snapshot lands before the transition it causes. */
    const events = await timeline(order.order.id);
    expect(events.indexOf('courier_update')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('shipped')).toBeGreaterThan(events.indexOf('courier_update'));

    const log = await webhookLog();
    expect(log[0]).toMatchObject({
      provider: 'fez',
      providerRef: 'ASAC1',
      rawStatus: 'Dispatched',
      verified: true,
      applied: 'applied',
    });
  });

  it('a replay of the same delivery is a 200 no-op', async () => {
    const order = await paidOrder();
    await bookedParcel(order, 'fez', 'ASAC1');

    const { body, headers } = fezDelivery('ASAC1', 'Dispatched');
    await deliver(FEZ_PATH, body, headers);
    const before = await timeline(order.order.id);

    /*
     * A COURIER REDELIVERS — after a 500, after a timeout, or simply twice. The
     * idempotency is what makes doing the work inline acceptable: a replay must
     * not add a second `courier_update` to a customer-visible history, and must
     * not answer anything a courier would treat as a failure.
     */
    const replay = await deliver(FEZ_PATH, body, headers);
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ ok: true, changed: false });

    expect(await timeline(order.order.id)).toEqual(before);
    expect((await webhookLog())[0]).toMatchObject({ applied: 'ignored', verified: true });
  });

  it('an unknown reference is logged as unmatched and still answers 200', async () => {
    /*
     * 200 AND NOT 404, deliberately. A reference we cannot place is a permanent
     * condition — a parcel booked on another deployment, or one whose order was
     * purged — and answering an error would make the courier retry it for days.
     */
    const { body, headers } = fezDelivery('NOSUCHREF', 'Delivered');
    const res = await deliver(FEZ_PATH, body, headers);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, unmatched: true });
    expect((await webhookLog())[0]).toMatchObject({
      providerRef: 'NOSUCHREF',
      verified: true,
      applied: 'unmatched',
    });
  });

  it('a stale timestamp is rejected, so a captured delivery cannot be replayed hours later', async () => {
    const order = await paidOrder();
    const parcel = await bookedParcel(order, 'fez', 'ASAC1');

    const { body, headers } = fezDelivery('ASAC1', 'Delivered', { at: Date.now() - 30 * 60_000 });
    const res = await deliver(FEZ_PATH, body, headers);

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'bad_signature' });
    /* The parcel is untouched: a refusal must refuse the WRITE, not merely the body. */
    expect(await reread(parcel.id)).toMatchObject({ status: 'pending', providerStatus: 'Pending Pick-Up' });
    expect((await webhookLog())[0]).toMatchObject({ verified: false, applied: 'rejected' });
  });

  it('refuses a body over 1 MB before it verifies anything', async () => {
    /*
     * The cap is on the bytes actually read, never on `content-length`, because
     * a header is a claim. This route is public and unauthenticated by session,
     * so without it anyone can make the process buffer and HMAC 100 MB before
     * the signature can possibly fail.
     */
    const res = await deliver(FEZ_PATH, JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 16) }), {});

    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: 'payload_too_large' });
    /* Nothing was parsed, nothing was verified, and nothing was written. */
    expect(await webhookLog()).toEqual([]);
  });
});

// ============================================================= Terminal

describe('the Terminal webhook', () => {
  it('a signed shipment.updated delivered on a shipped parcel marks it delivered', async () => {
    const order = await paidOrder();
    const parcel = await bookedParcel(order, 'terminal', 'SH-1');
    await shipFulfillment(ctx.db, parcel.id, NOW + 1, null, ctx.users.owner.id);

    const { body, headers } = terminalDelivery({
      event: 'shipment.updated',
      data: {
        shipment_id: 'SH-1',
        status: 'delivered',
        carrier: 'DHL',
        events: [{ description: 'Handed to recipient' }],
      },
    });
    const res = await deliver(TERMINAL_PATH, body, headers);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, transitioned: 'delivered' });
    expect(await reread(parcel.id)).toMatchObject({ status: 'delivered', courierState: 'delivered' });
    expect((await webhookLog())[0]).toMatchObject({
      provider: 'terminal',
      providerRef: 'SH-1',
      rawStatus: 'delivered',
      applied: 'applied',
    });
  });

  it('ignores a transaction.success with 200 — it is a real event about somebody else', async () => {
    /*
     * `parseWebhook` returns `null` rather than throwing for an event that is
     * genuinely Terminal's and genuinely not about a shipment. A 401 here would
     * make the courier retry a wallet top-up notice for three days; a 500 would
     * do worse.
     */
    const { body, headers } = terminalDelivery({
      event: 'transaction.success',
      data: { amount: 1000, currency: 'NGN' },
    });
    const res = await deliver(TERMINAL_PATH, body, headers);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, ignored: true });
    expect((await webhookLog())[0]).toMatchObject({
      provider: 'terminal',
      verified: true,
      applied: 'ignored',
      providerRef: null,
    });
  });

  it('refuses a body signed with the wrong key', async () => {
    const body = JSON.stringify({ event: 'shipment.updated', data: { shipment_id: 'SH-1', status: 'delivered' } });
    const res = await deliver(TERMINAL_PATH, body, {
      'x-terminal-signature': createHmac('sha512', 'not-the-key').update(body).digest('hex'),
    });

    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'bad_signature' });
    expect((await webhookLog())[0]).toMatchObject({ provider: 'terminal', verified: false, applied: 'rejected' });
  });
});

// ================================================================ sweep

describe('the scheduled sweep', () => {
  it('runs the courier step, on the parcels a webhook never reported', async () => {
    process.env.CRON_SECRET = CRON_SECRET;

    const order = await paidOrder();
    const parcel = await bookedParcel(order, 'fez', 'ASAC1');

    /*
     * THE COURIER IS SWITCHED OFF FOR THIS CASE, and that is what makes it safe
     * to run inside the composition root: `providerFor('fez')` answers `null`,
     * so the sweep reaches the parcel and records a failure on it WITHOUT a
     * network call. What is being proved here is the WIRING — that
     * `registerOrdersDefaults` in `server/index.ts` gave `runSweep` a
     * `syncCouriers` at all — and `sync.test.ts` proves what it does with an
     * answer once it gets one.
     */
    delete process.env.FEZ_USER_ID;
    delete process.env.FEZ_PASSWORD;
    resetLogisticsEnv();
    resetLogisticsDeps();

    const res = await client.app.request('/api/shop/admin/sweep', {
      method: 'GET',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });

    expect(res.status).toBe(200);
    const body = await json<{ couriers: { checked: number; failed: number } | null }>(res);
    expect(body.couriers).not.toBeNull();
    expect(body.couriers?.checked).toBe(1);
    expect(body.couriers?.failed).toBe(1);

    /* And it really went to THAT parcel, rather than reporting a number. */
    expect((await reread(parcel.id)).providerLastError).toContain('Fez Delivery');
  });
});
