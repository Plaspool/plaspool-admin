import { createHmac } from 'node:crypto';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { toResponse } from '../../middleware/errors';
import { originGuard } from '../../middleware/origin';
import { FakeProvider } from './provider/fake';
import { fakeCheckoutPort } from './checkout';
import { resetPayments } from './test/db';
import { createIntent, getIntent } from './intents';
import { createPaymentRoutes, createWebhookRoutes } from './routes';
import { drainPaymentEvents, processEvent } from './webhook';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import type { CheckoutCompletion } from '../../../shared/commerce/ports';

/**
 * The webhook endpoint, over HTTP, end to end.
 *
 * `03-payments.md` §4 lists five rules and the agent prompt says "Test all
 * five": verify the signature on the raw bytes before parsing; dedupe on
 * `providerEventId` with a unique constraint; tolerate out-of-order arrival;
 * return 200 as soon as the event is durably stored; log and ignore unknown
 * event types. Each has a `describe` below.
 *
 * The sixth is the origin guard, which has no rule of its own because it is
 * supposed to be obvious — and it is exactly the kind of seam every round of
 * both gauntlets found. It gets its own block too, including the failing case
 * that AMENDMENTS A-001 exists for.
 */

const SECRET = 'fake-secret-key';
const CHECKOUT = 'crt_webhook';
const now = 1_700_000_000_000;

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let provider: FakeProvider;

const checkout = fakeCheckoutPort({
  [CHECKOUT]: { checkoutId: CHECKOUT, total: 40_333, currency: 'NGN' },
});

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
  provider = new FakeProvider({ secretKey: SECRET });
});

beforeEach(async () => {
  await resetPayments(db);
  provider = new FakeProvider({ secretKey: SECRET });
});

afterAll(async () => {
  await ctx.close();
});

/**
 * The app as `server/index.ts` builds it, minus what this suite does not need.
 *
 * `withOrigin` decides whether the webhook router sits BEFORE or AFTER
 * `originGuard`, because that placement is the whole of A-001 and both sides of
 * it need to be executable.
 */
function app(options: { withOrigin: boolean }): Hono<AppEnv> {
  const root = new Hono<AppEnv>();
  root.use('*', async (c, next) => {
    c.set('requestId', 'test-request');
    c.set('dbFactory', () => db);
    c.set('user', null);
    await next();
  });
  root.onError((err, c) => toResponse(err, c.get('requestId') ?? ''));

  // Payments' webhook, mounted BEFORE the origin guard — the exemption.
  root.route('/api', createWebhookRoutes({ provider, checkout }));

  if (options.withOrigin) root.use('/api/*', originGuard(['https://shop.test']));
  root.route('/api', createPaymentRoutes({ provider, checkout }));
  return root;
}

/** Sign exactly as Paystack does, computed independently of the module. */
function signed(body: string): { body: string; headers: Record<string, string> } {
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': createHmac('sha512', SECRET)
        .update(Buffer.from(body))
        .digest('hex'),
    },
  };
}

function chargeSuccess(reference: string, id = 4099260516): string {
  return JSON.stringify({
    event: 'charge.success',
    data: { id, status: 'success', reference, amount: 40_333, currency: 'NGN' },
  });
}

async function post(
  a: Hono<AppEnv>,
  path: string,
  init: { body: string; headers: Record<string, string> },
): Promise<Response> {
  return a.request(path, { method: 'POST', body: init.body, headers: init.headers });
}

async function seedIntent() {
  const { intent } = await createIntent(
    db,
    provider,
    checkout,
    { checkoutId: CHECKOUT, email: 'buyer@example.com', idempotencyKey: 'idem-webhook' },
    now,
  );
  return intent;
}

async function storedEvents() {
  const res = await db.execute(
    sql`SELECT id, provider_event_id, type, processed_at, anomaly, last_error, intent_id
        FROM shop_payment_events ORDER BY received_at, id`,
  );
  return res.rows;
}

async function outboxRows() {
  const res = await db.execute(sql`SELECT id, type FROM commerce_events`);
  return res.rows;
}

describe('1. the signature is verified on the raw bytes, before parsing', () => {
  it('accepts a correctly signed delivery', async () => {
    const intent = await seedIntent();
    const res = await post(
      app({ withOrigin: true }),
      '/api/shop/payments/webhook',
      signed(chargeSuccess(intent.providerIntentId as string)),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true, duplicate: false });
  });

  it('refuses an unsigned, wrongly signed, or tampered body with 401 — never 500', async () => {
    /*
     * 401 AND NOT 500 IS THE POINT. Paystack redelivers a non-200 every three
     * minutes for four attempts and then hourly for 72 hours, so a 500 would
     * turn one forged request into three days of them. And never 200, which
     * would tell a forger their body was accepted.
     */
    const intent = await seedIntent();
    const body = chargeSuccess(intent.providerIntentId as string);
    const valid = signed(body);

    const cases: [string, { body: string; headers: Record<string, string> }][] = [
      ['no signature header', { body, headers: { 'content-type': 'application/json' } }],
      [
        'wrong signature',
        { body, headers: { ...valid.headers, 'x-paystack-signature': 'a'.repeat(128) } },
      ],
      [
        'signed by a different key',
        {
          body,
          headers: {
            ...valid.headers,
            'x-paystack-signature': createHmac('sha512', 'sk_test_other')
              .update(Buffer.from(body))
              .digest('hex'),
          },
        },
      ],
      [
        'body mutated after signing',
        { body: body.replace('40333', '1'), headers: valid.headers },
      ],
    ];

    for (const [label, init] of cases) {
      const res = await post(app({ withOrigin: true }), '/api/shop/payments/webhook', init);
      expect(res.status, label).toBe(401);
      await expect(res.json(), label).resolves.toEqual({ error: 'invalid_signature' });
    }

    // NOTHING was stored, and nothing moved. An unverified body is not evidence.
    expect(await storedEvents()).toHaveLength(0);
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
  });

  it('does not let a forged body mark an order paid — the attack this stops', async () => {
    const intent = await seedIntent();
    const forged = chargeSuccess(intent.providerIntentId as string);
    await post(app({ withOrigin: true }), '/api/shop/payments/webhook', {
      body: forged,
      headers: { 'content-type': 'application/json' },
    });
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses a body larger than the cap without hashing it', async () => {
    const res = await post(app({ withOrigin: true }), '/api/shop/payments/webhook', {
      body: 'x'.repeat(1024 * 1024 + 1),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(413);
  });
});

describe('2. duplicate delivery dedupes on providerEventId', () => {
  it('stores one row and applies one state change for three deliveries', async () => {
    /*
     * §9: "Duplicate webhook delivery (same providerEventId ×3, concurrently)
     * produces exactly one state change and one outbox event."
     */
    const intent = await seedIntent();
    const delivery = signed(chargeSuccess(intent.providerIntentId as string));
    const a = app({ withOrigin: true });

    const responses = await Promise.all([
      post(a, '/api/shop/payments/webhook', delivery),
      post(a, '/api/shop/payments/webhook', delivery),
      post(a, '/api/shop/payments/webhook', delivery),
    ]);

    // ALL THREE ARE 200. A repeat is the provider keeping its promise, not an
    // error, and answering anything else restarts the retry schedule.
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ duplicate: boolean }>));
    expect(bodies.filter((b) => !b.duplicate), 'exactly one first delivery').toHaveLength(1);

    await drainPaymentEvents(db, 10, now);

    expect(await storedEvents()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });

  it('treats two DIFFERENT events as different, even on one transaction', async () => {
    const intent = await seedIntent();
    const reference = intent.providerIntentId as string;
    const a = app({ withOrigin: true });
    await post(a, '/api/shop/payments/webhook', signed(chargeSuccess(reference, 1)));
    await post(a, '/api/shop/payments/webhook', signed(chargeSuccess(reference, 2)));
    // Keyed on the reference for charges, so these two ARE one event. That is
    // correct: two `charge.success` for one reference cannot legitimately differ.
    expect(await storedEvents()).toHaveLength(1);
  });
});

describe('3. out-of-order arrival resolves to the high-water state', () => {
  it('keeps captured when a verify-style earlier state lands afterwards', async () => {
    const intent = await seedIntent();
    const reference = intent.providerIntentId as string;
    const a = app({ withOrigin: true });

    await post(a, '/api/shop/payments/webhook', signed(chargeSuccess(reference)));
    await drainPaymentEvents(db, 10, now);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');

    /*
     * A second, later-arriving event that would move the intent backwards. It
     * is acknowledged and annotated rather than refused — refusing would return
     * a non-200 for an event that is not wrong, only late.
     */
    provider.settle(reference, 'requires_payment');
    const res = await a.request(`/api/shop/payments/intents/${intent.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://shop.test' },
    });
    expect(res.status).toBe(200);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });
});

describe('4. 200 comes back as soon as the event is durably stored', () => {
  it('has committed the row by the time the response is read', async () => {
    /*
     * The ordering that makes acknowledging early honest: the row is committed
     * BEFORE the response, and processing happens afterwards. So immediately
     * after the response the event exists and is not yet processed — which is
     * exactly the state `drainPaymentEvents` is the safety net for.
     */
    const intent = await seedIntent();
    const res = await post(
      app({ withOrigin: true }),
      '/api/shop/payments/webhook',
      signed(chargeSuccess(intent.providerIntentId as string)),
    );
    expect(res.status).toBe(200);

    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].intent_id, 'resolved to its intent at store time').toBe(intent.id);
  });

  it('a drain picks up anything the post-response work did not finish', async () => {
    const intent = await seedIntent();
    await db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, intent_id, type, payload, received_at)
      VALUES ('pev_stranded', 'charge.success:stranded', ${intent.id}, 'charge.success',
              ${JSON.stringify({ data: { reference: intent.providerIntentId } })}::jsonb, ${now})`);

    const results = await drainPaymentEvents(db, 10, now);
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
    expect(await outboxRows()).toHaveLength(1);
  });

  it('a second drain over the same rows changes nothing', async () => {
    const intent = await seedIntent();
    const a = app({ withOrigin: true });
    await post(a, '/api/shop/payments/webhook', signed(chargeSuccess(intent.providerIntentId as string)));
    await drainPaymentEvents(db, 10, now);
    await drainPaymentEvents(db, 10, now);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe('5. unknown event types are stored, logged and ignored — never an error', () => {
  it('answers 200 and records why it did nothing', async () => {
    /*
     * Contract §6 rule 4. Paystack publishes two dozen event types and adds
     * more; a `subscription.create` or a `transfer.success` reaching here is
     * harmless and expected. A 500 would show up as a provider-side delivery
     * alarm at 3am for something that needs no action.
     */
    const body = JSON.stringify({
      event: 'subscription.create',
      data: { id: 77, subscription_code: 'SUB_x' },
    });
    const res = await post(app({ withOrigin: true }), '/api/shop/payments/webhook', signed(body));
    expect(res.status).toBe(200);

    await drainPaymentEvents(db, 10, now);
    const rows = await storedEvents();
    // STORED — the raw log is append-only and complete, because it is the only
    // artefact that can answer "what did the provider tell us" in a dispute.
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('subscription.create');
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].anomaly).toBe('unhandled_type:subscription.create');
    expect(await outboxRows()).toHaveLength(0);
  });

  it('answers 200 for a dispute event it has no handler for yet', async () => {
    const body = JSON.stringify({
      event: 'charge.dispute.create',
      data: { id: 12, status: 'awaiting-merchant-feedback' },
    });
    const res = await post(app({ withOrigin: true }), '/api/shop/payments/webhook', signed(body));
    expect(res.status).toBe(200);
  });
});

describe('the origin guard exemption (AMENDMENTS A-001)', () => {
  it('a server-to-server POST with no Origin reaches the webhook when mounted before the guard', async () => {
    const intent = await seedIntent();
    const res = await post(
      app({ withOrigin: true }),
      '/api/shop/payments/webhook',
      signed(chargeSuccess(intent.providerIntentId as string)),
    );
    // No `Origin` header anywhere above — Paystack is a server, not a browser.
    expect(res.status).toBe(200);
  });

  it('the SAME request is refused 403 behind the guard — which is why A-001 exists', async () => {
    /*
     * THE EVIDENCE, executed rather than argued (contract §9). `originGuard`
     * refuses any unsafe method with no `Origin`, and it is right to. Mounted
     * behind it, this endpoint answers 403 to every genuine Paystack event and
     * Paystack retries each one for 72 hours.
     *
     * The exemption is safe HERE and nowhere else: CSRF borrows a victim's
     * ambient authority, and this route reads no cookie and resolves no
     * session. Its authority is an HMAC over the body, which a cross-origin
     * form post cannot produce.
     */
    const intent = await seedIntent();
    const behindGuard = new Hono<AppEnv>();
    behindGuard.use('*', async (c, next) => {
      c.set('requestId', 'test-request');
      c.set('dbFactory', () => db);
      c.set('user', null);
      await next();
    });
    behindGuard.onError((err, c) => toResponse(err, c.get('requestId') ?? ''));
    behindGuard.use('/api/*', originGuard(['https://shop.test']));
    behindGuard.route('/api', createWebhookRoutes({ provider, checkout }));

    const res = await post(
      behindGuard,
      '/api/shop/payments/webhook',
      signed(chargeSuccess(intent.providerIntentId as string)),
    );
    expect(res.status, 'a genuine, correctly signed event is refused').toBe(403);
    expect(await storedEvents()).toHaveLength(0);
  });

  it('the ordinary payment routes stay BEHIND the guard', async () => {
    /*
     * The exemption is one route wide. Every round of both gauntlets found a
     * guard applied to one surface and not its twin, so the twin is asserted
     * here rather than assumed.
     */
    const res = await post(app({ withOrigin: true }), '/api/shop/payments/intents', {
      body: JSON.stringify({
        checkoutId: CHECKOUT,
        email: 'buyer@example.com',
        idempotencyKey: 'idem-no-origin',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status, 'no Origin on a state-changing storefront POST').toBe(403);
  });
});

describe('the confirm route never trusts the client', () => {
  it('asks the provider and applies the answer through the same ladder', async () => {
    /*
     * §8: "Never mark an order paid from anything but a verified webhook or a
     * verified synchronous provider response. A client-side 'payment
     * succeeded' callback is a UI hint, not evidence." Nothing in this request
     * says the payment succeeded — the provider does.
     */
    const intent = await seedIntent();
    provider.settle(intent.providerIntentId as string, 'captured');

    const res = await app({ withOrigin: true }).request(
      `/api/shop/payments/intents/${intent.id}/confirm`,
      { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://shop.test' } },
    );

    expect(res.status).toBe(200);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
    expect(await outboxRows()).toHaveLength(1);
    // Recorded in the raw log with its own type, so a dispute can tell "we
    // asked" apart from "they told us".
    expect((await storedEvents())[0].type).toBe('verify.captured');
  });

  it('leaves an unpaid intent alone, however often it is called', async () => {
    const intent = await seedIntent();
    const a = app({ withOrigin: true });
    for (let i = 0; i < 3; i += 1) {
      await a.request(`/api/shop/payments/intents/${intent.id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'https://shop.test' },
      });
    }
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('the public projection', () => {
  it('never ships the idempotency key or the last provider error', async () => {
    const intent = await seedIntent();
    const res = await app({ withOrigin: true }).request(
      `/api/shop/payments/intents/${intent.id}`,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'amount',
      'authorizationUrl',
      'charged', // what the gateway will ask for (1140) — public by design
      'checkoutId',
      'currency',
      'id',
      'refundedTotal',
      'status',
    ]);
  });
});

/**
 * A LOST WRITE RACE INSIDE `completeCheckout` MUST NOT COST THE ORDER.
 *
 * `completeCheckout` reads the cart and then UPDATEs on that revision, so a
 * concurrent write landing between the two raises `CartStaleWriteError`. Nothing
 * was written and the same call would succeed a moment later — the design always
 * assumed that case was recoverable, and it was not:
 *
 *   `completeCheckoutForIntent` swallows what the port raises (it must — recording
 *   the payment outranks completing the checkout), `applyIntentStatus` then marks
 *   the provider event row processed, and `drainPaymentEvents` selects on
 *   `processed_at IS NULL`. So there was no next drain. The capture was recorded,
 *   `checkout.completed` was never emitted, and `payment.captured` would park
 *   twenty times and be abandoned. A customer charged, and no order.
 *
 * The port now reports that one case as `retry-later` and the row is left
 * unprocessed, so the next drain finishes the job. Both halves are asserted here:
 * the money is recorded on the FIRST pass regardless, and the checkout is
 * completed on the second.
 */
describe('a lost write race leaves the capture re-drivable', () => {
  /** A port that loses the race `attempts` times and then wins. */
  function racyPort(attempts: number): {
    port: typeof checkout;
    completes: string[];
  } {
    const completes: string[] = [];
    let remaining = attempts;
    return {
      completes,
      port: {
        ...checkout,
        complete(_db: Db, checkoutId: string): Promise<CheckoutCompletion> {
          void _db;
          completes.push(checkoutId);
          if (remaining > 0) {
            remaining -= 1;
            return Promise.resolve('retry-later');
          }
          return Promise.resolve('completed');
        },
      },
    };
  }

  async function storedEvent() {
    const rows = await storedEvents();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * The stored row, inserted directly rather than delivered over HTTP.
   *
   * The webhook route processes in `afterResponse`, which without an
   * `ExecutionContext` is a detached promise — so a suite that POSTed and then
   * called `processEvent` itself would be racing its own fixture. `4.` above
   * already proves the route stores and drains; this block is about what
   * `processEvent` does with a row, so it starts from one.
   */
  async function stranded(intentId: string, reference: string): Promise<string> {
    await db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, intent_id, type, payload, received_at)
      VALUES ('pev_racy', 'charge.success:racy', ${intentId}, 'charge.success',
              ${JSON.stringify({ data: { reference } })}::jsonb, ${now})`);
    return 'pev_racy';
  }

  it('records the payment, leaves the row unprocessed, and completes on the next drain', async () => {
    const intent = await seedIntent();
    const rowId = await stranded(intent.id, intent.providerIntentId as string);

    const racy = racyPort(1);
    const first = await processEvent(db, rowId, now, { checkout: racy.port });

    // MONEY SAFETY IS UNTOUCHED. The capture is recorded on this pass whatever
    // the completion did — that is the ordering rule, and it is the half that
    // must never regress in the name of retrying.
    expect(first.outcome).toBe('applied');
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
    expect(await outboxRows()).toHaveLength(1);

    // AND THE ROW IS STILL OPEN, which is the fix: `processed_at` back to NULL
    // and `last_error` naming why, so the next drain re-drives it.
    const row = await storedEvent();
    expect(row.processed_at).toBeNull();
    expect(row.last_error).toBe('checkout_completion_lost_race');
    expect(racy.completes).toEqual([CHECKOUT]);

    // The next drain wins the race and completes the checkout.
    await drainPaymentEvents(db, 10, now + 1, { checkout: racy.port });

    expect(racy.completes).toEqual([CHECKOUT, CHECKOUT]);
    const settled = await storedEvent();
    expect(settled.processed_at).not.toBeNull();

    // NO SECOND `payment.captured`. The re-drive goes through
    // `applyIntentStatus` again and the rank guard sees the intent already at
    // `captured`, so it moves nothing and emits nothing.
    expect(await outboxRows()).toHaveLength(1);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });

  it('a terminal answer settles the row rather than re-driving it for ever', async () => {
    /*
     * THE OTHER HALF, AND IT IS WHAT KEEPS THE FIX FROM BECOMING A LOOP. Only a
     * lost race re-opens the row. A cart that is missing or already converted is
     * final — the same call would answer the same way at every drain — so the row
     * is marked processed and the operator's signal is the parked
     * `payment.captured`, not a provider event this drain picks up for ever.
     */
    const intent = await seedIntent();
    const rowId = await stranded(intent.id, intent.providerIntentId as string);

    const terminal = {
      ...checkout,
      complete: (): Promise<CheckoutCompletion> => Promise.resolve('unavailable'),
    };
    await processEvent(db, rowId, now, { checkout: terminal });

    const row = await storedEvent();
    expect(row.processed_at).not.toBeNull();
    expect(row.last_error).toBeNull();
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });
});
