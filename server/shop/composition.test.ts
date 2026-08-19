/**
 * THE COMPOSITION ROOT'S OWN WIRING, and the reason this file exists separately
 * from `server/shop/orders/routes.test.ts`.
 *
 * `OrdersDeps` has three seams — `mailer`, `customer`, `payments` — and for
 * months the deployment filled none of them while the suite was entirely green.
 * That is not an accident of coverage, it is a property of how orders are
 * tested: `server/shop/orders/test/app.ts` calls `registerOrdersDeps` with its
 * own fakes, deliberately, so those tests can be deterministic. Every one of
 * them therefore proves the ROUTE and nothing about the REGISTRATION, and the
 * two questions have opposite answers whenever `server/index.ts` forgets a seam.
 *
 * What that cost, before this file: `GET /api/shop/orders` answered 401 to every
 * caller in production, including one holding a valid `__Host-shop_session`, and
 * the admin payment panel was `null` on every order ever placed — which an
 * operator reads as "never paid" rather than as "never wired".
 *
 * So this suite registers NOTHING. It calls `resetOrdersDeps()` first, so the
 * registry is empty exactly as it is in a cold process, and then builds the real
 * `createApp()` through `httpClient` and lets its `registerOrdersDefaults` be the
 * only thing that fills it. If a future edit drops a seam from that call, these
 * tests fail and the orders suite stays green — which is the arrangement that
 * would have caught it the first time.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../test/http';
import type { HttpClient } from '../test/http';
import { SEED_PASSWORD } from '../test/harness';
import { createCustomer, createCustomerSession } from './cart/identity/customers';
import { SHOP_SESSION_COOKIE } from './cart/identity/cookies';
import { resetOrdersDeps, resolveDeps } from './orders/ports';
import { resetOrderTables } from './orders/test/harness';
import { checkoutCompleted, insertEvents, CHECKOUT } from './orders/test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './orders/repo/consumer';
import { markOrderPaid, readOrderByCheckout } from './orders/repo/orders';
import { paymentPort } from './payments/port';
import { storeEvent } from './payments/webhook';

let ctx: TestCtx;
let client: HttpClient;

const NOW = 1_700_000_010_000;
const DEPS: ConsumerDeps = { origin: TEST_ORIGIN };
const INTENT_ID = 'pi_composition_0001';

/**
 * The Paystack secret, which is ALSO the webhook signing key — Paystack has no
 * separate signing secret, `x-paystack-signature` is an HMAC-SHA512 under this
 * same value. Set on `process.env` because `paymentsEnv()` reads it lazily, at
 * the moment a payment is attempted, and `createApp()` must not require it.
 *
 * THE SHAPE MATTERS: `config.ts` refuses anything that is not `sk_test_`/`sk_live_`
 * and at least 20 characters, because pasting the PUBLIC key there is the mistake
 * that produces a signature which never verifies, at 3am, with Paystack blamed.
 */
const PAYSTACK_KEY = 'sk_test_composition_root_0000000000';

beforeAll(async () => {
  process.env.PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`
    TRUNCATE shop_customer_sessions, shop_customers, shop_payment_intents,
             shop_payment_events, shop_carts, shop_addresses CASCADE`);
  /*
   * BEFORE `httpClient`, and that order is the whole point. `createApp()` calls
   * `registerOrdersDefaults`, which fills only what is absent — so resetting
   * afterwards would empty the registry it had just populated and every
   * assertion below would test `NO_CUSTOMER` again.
   */
  resetOrdersDeps();
  client = httpClient(ctx.db);
});

/** A real customer row plus a live session cookie for it. */
async function signedInCustomer(email: string): Promise<{ id: string; cookie: string }> {
  const customer = await createCustomer(ctx.db, { email, displayName: 'Buyer' });
  const session = await createCustomerSession(ctx.db, customer.id);
  return { id: customer.id, cookie: `${SHOP_SESSION_COOKIE}=${session.token}` };
}

/** One paid order belonging to `customerId`, optionally carrying a payment intent. */
async function paidOrder(customerId: string, intentId: string | null = null): Promise<string> {
  await insertEvents(ctx.db, [
    { ...checkoutCompleted({ customerId }), id: `evt_chk_${customerId}` },
  ]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null, intentId);
  return read.order.id;
}

describe('the customer resolver, as the deployment registers it', () => {
  it('lists a signed-in customer their own orders', async () => {
    /*
     * THE REGRESSION, STATED AS A BEHAVIOUR. Before the composition root
     * registered a resolver this was a 401 — not because the session was bad,
     * but because `resolveDeps` fell back to `NO_CUSTOMER` and the handler's
     * first act is to demand an identity nothing could produce.
     */
    const { id, cookie } = await signedInCustomer('buyer@test.local');
    await paidOrder(id);

    const res = await client.get('/api/shop/orders', { headers: { cookie } });

    expect(res.status).toBe(200);
    const page = await json<{ items: { order: { customerId: string } }[] }>(res);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].order.customerId).toBe(id);
  });

  it('still answers 401 with no session at all', async () => {
    // The honest half. Wiring a resolver must not turn a customer-scoped route
    // into an open one, and `NO_CUSTOMER` and "no cookie" have to agree.
    await paidOrder((await signedInCustomer('other@test.local')).id);
    expect((await client.get('/api/shop/orders')).status).toBe(401);
  });

  it('does not accept a WRITER session in place of a customer session', async () => {
    /*
     * The failure mode a careless wiring would introduce: falling back to
     * `c.get('user')` would make one caller able to read everybody's orders.
     * `resolveShopCustomer` reads `__Host-shop_session` and queries
     * `shop_customer_sessions`, so a studio cookie resolves to nothing.
     */
    await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
    expect(client.cookies().has('__Host-studio_session')).toBe(true);

    expect((await client.get('/api/shop/orders')).status).toBe(401);
  });

  it('resolves nothing for an expired session, rather than throwing', async () => {
    const { id, cookie } = await signedInCustomer('expired@test.local');
    await paidOrder(id);
    await ctx.db.execute(sql`UPDATE shop_customer_sessions SET expires_at = 1`);

    expect((await client.get('/api/shop/orders', { headers: { cookie } })).status).toBe(401);
  });
});

describe('the payment port, as the deployment registers it', () => {
  /** The intent the port will be asked for. Inserted directly: this suite is about
   *  the WIRING, and `createIntent` would drag a provider and a frozen checkout in. */
  async function intent(status = 'captured', amount = 2500): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, idempotency_key,
         request_fingerprint, refunded_total, created_at, updated_at, revision)
      VALUES (${INTENT_ID}, ${CHECKOUT}, ${amount}, 'USD', ${status},
              ${'idem_' + INTENT_ID}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  async function ownerClient(): Promise<HttpClient> {
    await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
    return client;
  }

  it('renders a payment panel on an order that has an intent', async () => {
    // Before this wiring `payments` was null, so `orderDetail` short-circuited
    // before it ever read `paymentIntentId` and this field was null on every
    // order in existence.
    const { id } = await signedInCustomer('paid@test.local');
    const orderId = await paidOrder(id, INTENT_ID);
    await intent();
    const owner = await ownerClient();

    const res = await owner.get(`/api/shop/admin/orders/${orderId}`);

    expect(res.status).toBe(200);
    const body = await json<{ payment: { intentId: string; status: string; amount: number } | null }>(res);
    expect(body.payment).not.toBeNull();
    expect(body.payment).toMatchObject({ intentId: INTENT_ID, status: 'captured', amount: 2500 });
  });

  it('leaves the panel null when the order names no intent', async () => {
    // Null still has to be reachable, and it now means what it says — "this
    // order has no payment intent" rather than "nobody wired the port".
    const { id } = await signedInCustomer('unpaid@test.local');
    const orderId = await paidOrder(id, null);
    const owner = await ownerClient();

    const body = await json<{ payment: unknown }>(
      await owner.get(`/api/shop/admin/orders/${orderId}`),
    );
    expect(body.payment).toBeNull();
  });

  it('registers the real port object, not a stand-in', () => {
    // Cheap, and it fails for a reason the HTTP tests cannot express: a future
    // edit that drops `payments` from the composition root's call leaves every
    // panel silently null again, which is a value the UI already renders.
    expect(resolveDeps().payments).toBe(paymentPort);
  });
});

// ============================================================================
// admin#27 + admin#29 — A PAID CHECKOUT BECOMES AN ORDER
// ============================================================================

/**
 * THE ONE TEST THAT WOULD HAVE CAUGHT admin#27, AND THE REASON IT IS IN THIS FILE.
 *
 * Payments' own suites build their own Hono app and inject their own
 * `fakeCheckoutPort` (`webhook.test.ts` does exactly that, deliberately). Every
 * one of them therefore proves the CAPTURE PATH and nothing about the WIRING —
 * and the wiring was the bug: `server/index.ts` mounted the pre-built
 * `webhookRoutes` export, which is `createWebhookRoutes()` with no dependencies
 * at all. A real Paystack test payment reached `captured`, `shop_orders` stayed
 * at 0, and the capture parked "awaiting predecessor: checkout.completed"
 * because `completeCheckout` had never been called by anything, ever.
 *
 * So this drives a SIGNED PAYSTACK WEBHOOK through `createApp()` — the real
 * composition root, the real `checkoutPort()`, the real `drainCommerceEvents` —
 * and asserts an order exists at the end. If a future edit drops either
 * injection, the Payments suite stays green and this fails.
 *
 * THE CART IS INSERTED DIRECTLY rather than driven through `freezeCheckout`.
 * Freezing needs a `CatalogPort`, products, variants and stock, and Cart's own
 * suites prove all of it; what this file is for is the seam, and a row in
 * `converting` carrying frozen totals is exactly the state a frozen cart is in.
 */
describe('a paid checkout becomes an order, through the real composition root', () => {
  const PIPE_CART = 'crt_pipeline_0001';
  const PIPE_INTENT = 'pi_pipeline_0001';
  const PIPE_REF = 'psref_pipeline_0001';
  const AMOUNT = 5_400;

  /** A frozen (`converting`) cart, its address, and its unpaid intent. */
  async function frozenCartAwaitingCapture(cartId = PIPE_CART, ref = PIPE_REF): Promise<void> {
    const totals = {
      currency: 'USD',
      lines: [
        {
          variantId: 'var_mug_navy',
          qty: 2,
          unit: { amount: 1_500, currency: 'USD' },
          lineTotal: { amount: 3_000, currency: 'USD' },
          taxable: true,
          taxAmount: { amount: 0, currency: 'USD' },
        },
      ],
      shipping: null,
      tax: { zone: 'test', label: 'none', rateBps: 0 },
      adjustments: [],
      subtotal: { amount: 3_000, currency: 'USD' },
      adjustmentTotal: { amount: 0, currency: 'USD' },
      shippingTotal: { amount: 2_400, currency: 'USD' },
      taxTotal: { amount: 0, currency: 'USD' },
      grandTotal: { amount: AMOUNT, currency: 'USD' },
      rounding: 'half-up',
    };
    /*
     * NO `unitAmount` AND NO `lineTotal` ON THESE ROWS, AND THAT IS THE POINT.
     * `shop_carts.frozen_lines` is written by `freezeCheckout` in exactly this
     * shape; the two names Orders' parser requires are joined on from the frozen
     * totals when the event is built. A fixture that pre-supplied them would hide
     * the disagreement that would otherwise have parked every event.
     */
    const lines = [
      {
        variantId: 'var_mug_navy',
        productId: 'prd_mug',
        sku: 'MUG-NAVY',
        title: 'Enamel Mug',
        optionValues: { Colour: 'Navy' },
        qty: 2,
        unit: { amount: 1_500, currency: 'USD' },
        weightGrams: 400,
      },
    ];

    await ctx.db.execute(sql`
      INSERT INTO shop_carts
        (id, customer_id, currency, status, email, tax_zone,
         frozen_totals, frozen_lines, frozen_at,
         created_at, updated_at, expires_at, revision)
      VALUES (${cartId}, NULL, 'USD', 'converting', 'buyer@pipeline.test', 'test',
              ${JSON.stringify(totals)}::jsonb, ${JSON.stringify(lines)}::jsonb, ${NOW},
              ${NOW}, ${NOW}, ${NOW + 900_000}, 1)`);

    await ctx.db.execute(sql`
      INSERT INTO shop_addresses
        (id, cart_id, kind, name, line1, city, country_code)
      VALUES (${`adr_${cartId}`}, ${cartId}, 'shipping', 'A Buyer', '1 Test Street',
              'Abuja', 'NG')`);

    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, provider_intent_id,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${`pi_${cartId}`}, ${cartId}, ${AMOUNT}, 'USD', 'requires_payment', ${ref},
              ${`idem_${cartId}`}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  /**
   * Deliver a signed `charge.success`, and WAIT FOR THE WORK THE ROUTE DEFERS.
   *
   * The webhook acknowledges the moment the event is durably stored and does the
   * processing in `afterResponse` — `waitUntil` where the runtime has one. Vercel
   * has one; `app.request()` has one only if the caller supplies it, so this
   * supplies a recording `ExecutionContext` and awaits what the route handed it.
   * Polling for the order instead would assert the same thing with a race in it.
   */
  async function deliverCapture(ref = PIPE_REF, id = 4001): Promise<Response> {
    const body = JSON.stringify({
      event: 'charge.success',
      data: { id, reference: ref, amount: AMOUNT, currency: 'USD', status: 'success' },
    });
    const deferred: Promise<unknown>[] = [];
    const res = await client.app.request(
      '/api/shop/payments/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex'),
        },
        body,
      },
      {},
      {
        waitUntil: (p: Promise<unknown>) => void deferred.push(p),
        passThroughOnException: () => undefined,
        props: {},
      },
    );
    await Promise.all(deferred);
    return res;
  }

  async function eventsOfType(type: string, subject: string): Promise<number> {
    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM commerce_events
       WHERE type = ${type} AND subject_id = ${subject}`);
    return Number(rows.rows[0]?.n ?? 0);
  }

  it('creates the order inline, without waiting for the daily cron', async () => {
    await frozenCartAwaitingCapture();

    const res = await deliverCapture();
    expect(res.status).toBe(200);

    // The capture itself.
    const intent = await ctx.db.execute(sql`
      SELECT status FROM shop_payment_intents WHERE checkout_id = ${PIPE_CART}`);
    expect(intent.rows[0]?.status).toBe('captured');

    // `checkout.completed` was emitted at all — it never had been, for any cart.
    expect(await eventsOfType('checkout.completed', PIPE_CART)).toBe(1);

    // And the order EXISTS, paid, without this test sweeping anything itself.
    // That is admin#29's inline drain: a Hobby cron is daily with an hour of
    // jitter, so an order that appears only on the cron is not an order pipeline.
    const read = await readOrderByCheckout(ctx.db, PIPE_CART);
    expect(read).not.toBeNull();
    expect(read?.order.status).toBe('paid');
    expect(read?.order.grandTotal).toBe(AMOUNT);
    /*
     * The line proves the PAYLOAD SEAM, which was the third fault behind this
     * issue: Orders' parser requires `unitAmount` and `lineTotal` on every line
     * and `shop_carts.frozen_lines` carries neither. Before they were joined on
     * from the frozen totals, emitting the event at all would only have replaced
     * "no order" with "parked at lines.0.unitAmount, twenty times, abandoned".
     */
    expect(read?.lines).toHaveLength(1);
    expect(read?.lines[0]).toMatchObject({ sku: 'MUG-NAVY', qty: 2, unitAmount: 1_500 });

    // The cart is `converted`, which is what makes a second capture a no-op.
    const cart = await ctx.db.execute(sql`
      SELECT status FROM shop_carts WHERE id = ${PIPE_CART}`);
    expect(cart.rows[0]?.status).toBe('converted');
  });

  it('a redelivered charge.success is a 200, one order, one checkout.completed', async () => {
    /*
     * PAYSTACK REDELIVERS. It retries a non-200 every 3 minutes and then hourly
     * for 72 hours, and it can deliver a successful event more than once anyway.
     * Neither failure here is theoretical: a second capture that threw would 500
     * and start a redelivery storm, and one that completed the checkout again
     * would emit a second `checkout.completed` and build a second order for one
     * payment.
     */
    await frozenCartAwaitingCapture();

    const first = await deliverCapture();
    // A DIFFERENT provider event id for the same reference is impossible for
    // `charge.*` — `providerEventIdOf` keys those on the reference — so this is
    // the exact shape a Paystack redelivery has.
    const second = await deliverCapture();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await json<{ duplicate: boolean }>(second)).toMatchObject({ duplicate: true });

    expect(await eventsOfType('checkout.completed', PIPE_CART)).toBe(1);
    expect(await eventsOfType('payment.captured', `pi_${PIPE_CART}`)).toBe(1);

    const orders = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM shop_orders WHERE checkout_id = ${PIPE_CART}`);
    expect(Number(orders.rows[0]?.n)).toBe(1);
  });

  it('records the payment even when the checkout cannot be completed', async () => {
    /*
     * THE ORDERING RULE, STATED AS A BEHAVIOUR. A payment recorded with no order
     * is recoverable by a sweep or by a human; a payment NOT recorded because
     * completing the checkout threw is money received and forgotten, because
     * nothing wrote it down. Here the cart is already `converted` — the state a
     * duplicate leaves behind — and the capture must still land.
     */
    await frozenCartAwaitingCapture();
    await ctx.db.execute(sql`
      UPDATE shop_carts SET status = 'converted' WHERE id = ${PIPE_CART}`);

    const res = await deliverCapture();

    expect(res.status).toBe(200);
    const intent = await ctx.db.execute(sql`
      SELECT status FROM shop_payment_intents WHERE checkout_id = ${PIPE_CART}`);
    expect(intent.rows[0]?.status).toBe('captured');
    // No `checkout.completed`: the transition matched nothing, so its event
    // INSERT — which selects FROM the UPDATE — wrote nothing either.
    expect(await eventsOfType('checkout.completed', PIPE_CART)).toBe(0);
    // The capture is still in the outbox, parked, waiting for a predecessor an
    // operator can still supply. Nothing was lost.
    expect(await eventsOfType('payment.captured', `pi_${PIPE_CART}`)).toBe(1);
  });

  it('records the payment when the cart does not exist at all', async () => {
    // The same rule with nothing to complete: an intent whose cart was purged.
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, provider_intent_id,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${PIPE_INTENT}, 'crt_vanished', ${AMOUNT}, 'USD', 'requires_payment',
              ${PIPE_REF}, ${'idem_' + PIPE_INTENT}, 'fp', 0, ${NOW}, ${NOW}, 1)`);

    const res = await deliverCapture();

    expect(res.status).toBe(200);
    const intent = await ctx.db.execute(sql`
      SELECT status FROM shop_payment_intents WHERE id = ${PIPE_INTENT}`);
    expect(intent.rows[0]?.status).toBe('captured');
  });
});

/**
 * THE GAP THIS BRANCH EXISTS TO CLOSE, DRIVEN THROUGH THE REAL SCHEDULED PATH.
 *
 * A real Paystack payment was made in production. The webhook arrived, was
 * verified, and `storeEvent` wrote it — durably — to `shop_payment_events` with
 * `processed_at = NULL`. Then nothing else happened: Vercel froze the function
 * the instant the acknowledgement was sent, before `afterResponse`'s
 * `processEvent` call ever ran. No error, no anomaly — the row just sat there.
 *
 * The test above this one (`a paid checkout becomes an order…`) drives
 * `POST /shop/payments/webhook` end to end and would NOT have caught this: it
 * exercises the post-response path directly, which is exactly the path that
 * froze in production. This block instead reproduces the frozen state BY HAND —
 * `storeEvent` and nothing else — and then drives only the SCHEDULED recovery
 * path, `GET /admin/sweep`, the one thing an external cron actually calls. If
 * `runSweep` ever again forgets to drain payments first, this is what fails.
 */
describe('the scheduled sweep recovers a payment the webhook stored but never processed', () => {
  const CRON_SECRET = 'a-test-cron-secret-at-least-16-chars-long';
  const SWEEP_CART = 'crt_frozen_0001';
  const SWEEP_REF = 'psref_frozen_0001';
  const SWEEP_AMOUNT = 2_600;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  /** The same frozen-cart-plus-unpaid-intent shape the pipeline block above uses. */
  async function frozenCart(cartId: string, ref: string, amount: number): Promise<void> {
    const totals = {
      currency: 'USD',
      lines: [
        {
          variantId: 'var_mug_navy',
          qty: 1,
          unit: { amount, currency: 'USD' },
          lineTotal: { amount, currency: 'USD' },
          taxable: true,
          taxAmount: { amount: 0, currency: 'USD' },
        },
      ],
      shipping: null,
      tax: { zone: 'test', label: 'none', rateBps: 0 },
      adjustments: [],
      subtotal: { amount, currency: 'USD' },
      adjustmentTotal: { amount: 0, currency: 'USD' },
      shippingTotal: { amount: 0, currency: 'USD' },
      taxTotal: { amount: 0, currency: 'USD' },
      grandTotal: { amount, currency: 'USD' },
      rounding: 'half-up',
    };
    const lines = [
      {
        variantId: 'var_mug_navy',
        productId: 'prd_mug',
        sku: 'MUG-NAVY',
        title: 'Enamel Mug',
        optionValues: { Colour: 'Navy' },
        qty: 1,
        unit: { amount, currency: 'USD' },
        weightGrams: 400,
      },
    ];

    await ctx.db.execute(sql`
      INSERT INTO shop_carts
        (id, customer_id, currency, status, email, tax_zone,
         frozen_totals, frozen_lines, frozen_at,
         created_at, updated_at, expires_at, revision)
      VALUES (${cartId}, NULL, 'USD', 'converting', 'buyer@frozen.test', 'test',
              ${JSON.stringify(totals)}::jsonb, ${JSON.stringify(lines)}::jsonb, ${NOW},
              ${NOW}, ${NOW}, ${NOW + 900_000}, 1)`);

    await ctx.db.execute(sql`
      INSERT INTO shop_addresses
        (id, cart_id, kind, name, line1, city, country_code)
      VALUES (${`adr_${cartId}`}, ${cartId}, 'shipping', 'A Buyer', '1 Test Street',
              'Abuja', 'NG')`);

    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, provider_intent_id,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${`pi_${cartId}`}, ${cartId}, ${amount}, 'USD', 'requires_payment', ${ref},
              ${`idem_${cartId}`}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  /**
   * STORE ONLY — the exact half of the webhook route that actually completed in
   * production. `processEvent`/`afterResponse` is never called, which is what
   * makes this row indistinguishable from the one Vercel froze: durably stored,
   * `processed_at = NULL`, no `last_error`, no `anomaly`.
   */
  async function storeUnprocessedCapture(ref: string, providerEventId: string): Promise<void> {
    await storeEvent(ctx.db, {
      providerEventId,
      type: 'charge.success',
      providerIntentId: ref,
      providerRefundId: null,
      intentStatus: 'captured',
      refundStatus: null,
      failureReason: null,
      amount: SWEEP_AMOUNT,
      currency: 'USD',
      payload: { data: { reference: ref, amount: SWEEP_AMOUNT, currency: 'USD' } },
    });
  }

  it('turns a stored-but-unprocessed webhook into a paid order through GET /admin/sweep alone', async () => {
    await frozenCart(SWEEP_CART, SWEEP_REF, SWEEP_AMOUNT);
    await storeUnprocessedCapture(SWEEP_REF, 'evt_frozen_0001');

    // Reproduced, not assumed: the row really is stuck the way production's was.
    const before = await ctx.db.execute(sql`
      SELECT processed_at, last_error, anomaly FROM shop_payment_events
       WHERE provider_event_id = 'evt_frozen_0001'`);
    expect(before.rows[0]).toMatchObject({ processed_at: null, last_error: null, anomaly: null });
    expect(await readOrderByCheckout(ctx.db, SWEEP_CART)).toBeNull();

    // ONE call to the SCHEDULED path — the one a cron actually reaches, not the
    // owner-gated manual drain and not the inline post-webhook path.
    const res = await client.app.request('/api/shop/admin/sweep', {
      method: 'GET',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await json<{
      payments: { count: number };
      events: { applied: number; passes: number };
    }>(res);
    expect(body.payments.count).toBeGreaterThanOrEqual(1);
    expect(body.events.applied).toBeGreaterThanOrEqual(2); // checkout.completed + payment.captured

    const after = await ctx.db.execute(sql`
      SELECT processed_at FROM shop_payment_events WHERE provider_event_id = 'evt_frozen_0001'`);
    expect(after.rows[0]?.processed_at).not.toBeNull();

    const read = await readOrderByCheckout(ctx.db, SWEEP_CART);
    expect(read).not.toBeNull();
    expect(read?.order.status).toBe('paid');
    expect(read?.order.grandTotal).toBe(SWEEP_AMOUNT);
  });
});
