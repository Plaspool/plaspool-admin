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
import { createCustomer, createCustomerSession } from './cart/identity/customers';
import { SHOP_SESSION_COOKIE } from './cart/identity/cookies';
import { resetOrdersDeps, resolveDeps } from './orders/ports';
import { resetOrderTables } from './orders/test/harness';
import { checkoutCompleted, insertEvents, CHECKOUT } from './orders/test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './orders/repo/consumer';
import { collect, createRequest, inspect, receive, schedule } from '../marketing/returns/repo';
import { markOrderPaid, readOrderByCheckout } from './orders/repo/orders';
import { listIntents } from './orders/repo/emails';
import { paymentPort } from './payments/port';
import { storeEvent } from './payments/webhook';
import { applyRefundEvent } from './payments/refunds';
import { FakeProvider } from './payments/provider/fake';
import { createAddOn } from './catalog/add-ons/repo';
import { SHOP_CURRENCY } from './currency';

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
    await client.signIn({ email: 'owner@test.local' });
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
  async function intent(status = 'captured', amount = 2500, provider = 'paystack'): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, provider, amount, currency, status, idempotency_key,
         request_fingerprint, refunded_total, created_at, updated_at, revision)
      VALUES (${INTENT_ID}, ${CHECKOUT}, ${provider}, ${amount}, 'USD', ${status},
              ${'idem_' + INTENT_ID}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  async function ownerClient(): Promise<HttpClient> {
    await client.signIn({ email: 'owner@test.local' });
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

  it('names the gateway that took the payment, so the page can say where a refund goes', async () => {
    const { id } = await signedInCustomer('flutterwave@test.local');
    const orderId = await paidOrder(id, INTENT_ID);
    await intent('captured', 2500, 'flutterwave');
    const owner = await ownerClient();

    const body = await json<{ payment: { provider?: string } | null }>(
      await owner.get(`/api/shop/admin/orders/${orderId}`),
    );
    expect(body.payment?.provider).toBe('flutterwave');
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

  /**
   * SPOOLPOINTS (admin#2) — THE FIFTH SEAM, AND IT FAILS THE SAME SILENT WAY.
   *
   * `OrdersDeps.redemption` absent does not throw and does not 500. Every order
   * is still created, still paid and still confirmed; the customer is simply
   * charged a discounted total whose points are never debited, forever, with no
   * error anywhere. That is a shop giving away money while its suite is green —
   * precisely the shape of failure this file was created for.
   *
   * A FACTORY IS ASSERTED, NOT AN OBJECT. Unlike `payments`, this seam cannot be
   * compared by identity: the frozen port takes no database handle, so the
   * composition root registers a closure over one and a fresh port comes back
   * per request. Asserting it is callable and yields the three frozen methods is
   * what distinguishes "wired" from "absent" here.
   */
  it('registers a SpoolPoints redemption factory', () => {
    const factory = resolveDeps().redemption;
    expect(factory).toBeTypeOf('function');
    const port = factory!(ctx.db);
    expect(port.quote).toBeTypeOf('function');
    expect(port.redeem).toBeTypeOf('function');
    expect(port.release).toBeTypeOf('function');
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

  /**
   * THE OTHER HALF, AND THE WORSE ONE: the webhook never arrived AT ALL.
   *
   * The case above reproduces a delivery that was stored and not processed. This
   * one stores NOTHING — no `shop_payment_events` row, nothing to drain — which
   * is what a lost delivery actually looks like: a deploy mid-flight, a cold
   * start, a URL nobody registered, a signing secret somebody rotated. The
   * payment drain cannot help, because there is nothing for it to find; it runs
   * clean and answers `count: 0` while a shopper who paid has no order.
   *
   * SO THIS DRIVES THE `syncIntents` SEAM THROUGH THE REAL COMPOSITION ROOT, for
   * the reason this whole file exists: `sync.test.ts` proves the FUNCTION and
   * would stay green if `server/index.ts` never registered it. Only a test that
   * builds the real `createApp()` and calls the real scheduled path can tell the
   * difference, and that difference is a silently uncollected sale.
   *
   * ONLY THE NETWORK IS STUBBED. The real Paystack adapter runs — its URL, its
   * bearer header, its envelope parsing, its status mapping — so this also pins
   * that `fetchIntent` asks `/transaction/verify/:ref` and reads `data.status`.
   * Stubbing the provider instead would have proved the seam and nothing about
   * the adapter behind it.
   */
  it('finds a capture NOTHING ever told us about, through GET /admin/sweep alone', async () => {
    const CART = 'crt_never_told_0001';
    const REF = 'psref_never_told_0001';
    await frozenCart(CART, REF, SWEEP_AMOUNT);
    /*
     * DATED TO NOW, and it has to be: this suite registers no `now` seam on
     * purpose — the point is the real composition root — so the sweep runs on the
     * wall clock while `frozenCart` stamps the fixed `NOW` these tests share,
     * which is years in the past. `listIntentsToSync` only asks about payments
     * inside a three-day window, so the fixture's own date put this one out of
     * range and the sweep correctly asked about nothing. A payment made moments
     * ago is also the realistic shape for this failure.
     */
    await ctx.db.execute(sql`
      UPDATE shop_payment_intents SET created_at = ${Date.now()} WHERE checkout_id = ${CART}`);

    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    /* Paystack's own verify envelope, and nothing else answered — an adapter that
       asked for anything but the verify path fails here rather than passing on a
       plausible shape. */
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      asked.push(href);
      if (!href.includes(`/transaction/verify/${REF}`)) {
        throw new Error(`unexpected Paystack call: ${href}`);
      }
      expect((init?.headers as Record<string, string>)?.authorization).toBe(
        `Bearer ${PAYSTACK_KEY}`,
      );
      return new Response(
        JSON.stringify({
          status: true,
          data: { status: 'success', reference: REF, amount: SWEEP_AMOUNT, currency: 'USD' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      /* Reproduced, not assumed: NOTHING is stored about any payment — the table
         is truncated per test, so an empty count is the whole "no delivery ever
         arrived" precondition rather than a filter that matched nothing. */
      const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_payment_events`);
      expect(before.rows[0]?.n).toBe(0);
      expect(await readOrderByCheckout(ctx.db, CART)).toBeNull();

      const res = await client.app.request('/api/shop/admin/sweep', {
        method: 'GET',
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      expect(res.status).toBe(200);
      const body = await json<{
        intents: { checked: number; captured: number } | null;
        events: { applied: number };
      }>(res);

      /* The seam is wired, it asked, and it found the money. */
      expect(asked).toHaveLength(1);
      expect(body.intents).toMatchObject({ checked: 1, captured: 1 });

      /* And the order exists — the whole point. `events.applied` covers both the
         `checkout.completed` the capture wrote and the `payment.captured` that
         parks on it, in one sweep, because the ask runs before the drain. */
      const read = await readOrderByCheckout(ctx.db, CART);
      expect(read).not.toBeNull();
      expect(read?.order.status).toBe('paid');
      expect(read?.order.grandTotal).toBe(SWEEP_AMOUNT);

      /* The evidence says we ASKED rather than were told, and the dedupe key
         carries the FETCHED status — keyed on a status a payload merely claimed,
         one reference could mint unlimited distinct keys. A dispute months from
         now has to be able to tell a state change we were told about from one we
         went looking for. */
      const evidence = await ctx.db.execute(
        sql`SELECT provider_event_id, type FROM shop_payment_events`,
      );
      expect(evidence.rows).toEqual([
        { provider_event_id: `verify:${REF}:captured`, type: 'verify.captured' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ============================================================================
// admin#2 — A CUSTOMER READING THEIR OWN SPOOLPOINTS
// ============================================================================

/**
 * THE TWO WAYS THIS FEATURE FAILS SILENTLY, AND BOTH ARE INVISIBLE ELSEWHERE.
 *
 * `/me/points` lives in `marketingApp()`, but the session it reads and the CORS
 * header it needs both belong to Cart — spec D9 forbids marketing importing
 * either, so both arrive by injection from `server/index.ts` and from nowhere
 * else. Marketing's own suites build marketing's own app and can pass their own
 * fakes, exactly as Orders' suites do, so every one of them proves the ROUTE and
 * nothing about the REGISTRATION.
 *
 * Which is precisely how `GET /api/shop/orders` came to 401 every caller in
 * production while its suite was green.
 *
 * So these drive the real `createApp()` and let its own composition be the only
 * thing that fills the seams:
 *
 *  1. A DROPPED `customer` — every shopper gets 401 forever. The feature does
 *     not error, it simply never works for anyone.
 *  2. A DROPPED `cors` — the response is a perfectly good 200 that the browser
 *     then refuses to hand to the storefront's JavaScript. This has happened
 *     three times in this codebase (reviews, payments, orders) and the suite
 *     passed every time, because a server-side request never enforces CORS.
 *     **That is why the assertions below are on HEADERS, not on behaviour.**
 */
describe('admin#2 — the customer points seam', () => {
  const WALLET = 'points.reader@example.test';

  /** Give the wallet something to report, through marketing's own writer. */
  async function grant(email: string, points: number): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES (${email}, ${points}, ${points}, ${NOW})
      ON CONFLICT (customer_email) DO UPDATE
        SET balance = EXCLUDED.balance, lifetime_earned = EXCLUDED.lifetime_earned`);
  }

  it('resolves the balance from the session, not from a path email', async () => {
    const customer = await signedInCustomer(WALLET);
    await grant(WALLET, 250);

    const res = await client.app.request('/api/marketing/me/points', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);

    const body = await json<{ points: number; lifetimeEarned: number }>(res);
    expect(body.points).toBe(250);
    expect(body.lifetimeEarned).toBe(250);
  });

  it('401s a caller with no session — it does NOT fall back to the writer', async () => {
    // The alternative would show a shop owner browsing their own store somebody
    // else's balance, under a URL the storefront calls.
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it('reports ZEROS for a customer who has never earned a point, never a 404', async () => {
    // The most ordinary case there is. A 404 would make the storefront render an
    // error state for every new customer.
    const customer = await signedInCustomer('brand.new@example.test');
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect((await json<{ points: number }>(res)).points).toBe(0);
  });

  it('carries the programme words, so the storefront never spells them itself', async () => {
    const customer = await signedInCustomer(WALLET);
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });

    const body = await json<{ pointsLabelSingular: string | null }>(res);
    // Seeded by migration 0011; the value is configuration, so this asserts that
    // SOMETHING came from the database rather than asserting a noun in source —
    // which is the one thing spec D2 makes impossible everywhere else.
    expect(body.pointsLabelSingular).toBeTruthy();
  });

  it('returns one customer their own history and nobody else in it', async () => {
    const customer = await signedInCustomer(WALLET);
    await grant(WALLET, 100);
    await ctx.db.execute(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('mlg_own_0001', ${WALLET}, 'manual', 100, 100, 'Seeded', 'system', ${NOW}),
             ('mlg_other_001', 'someone.else@example.test', 'manual', 500, 500, 'Theirs',
              'system', ${NOW})`);

    const res = await client.app.request('/api/marketing/me/points/ledger', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);

    const body = await json<{ items: Array<{ id: string }> }>(res);
    expect(body.items.map((entry) => entry.id)).toEqual(['mlg_own_0001']);
  });

  /**
   * THE CORS ASSERTIONS. On headers, deliberately — the three previous outages
   * all had working behaviour and a missing header.
   */
  it('SETS access-control-allow-credentials on the balance response', async () => {
    const customer = await signedInCustomer(WALLET);
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });

    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('SETS them on the ledger response too', async () => {
    const customer = await signedInCustomer(WALLET);
    const res = await client.app.request('/api/marketing/me/points/ledger', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });

    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('SETS them on the 401 as well, or the browser hides the reason', async () => {
    /*
     * A 401 without the credentials header is not "unauthorised" to the calling
     * JavaScript — it is a network error with no status at all, so the storefront
     * cannot tell "sign in" from "the server is down".
     */
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { origin: TEST_ORIGIN },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does NOT hand a credentialed cross-origin surface to the operator routes', async () => {
    /*
     * The widening this mount deliberately refused. `shopCors()` is scoped to
     * `/me/points/*` by the receiving router; applying it at `marketingApp()`'s
     * root would have been the smaller diff and would have quietly opened every
     * `auth`-gated marketing route to credentialed cross-origin reads.
     */
    const res = await client.app.request('/api/marketing/customers', {
      headers: { origin: TEST_ORIGIN },
    });

    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('awards a return through the real inspect path, and /me/points reads back the same balance', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE TEST THIS FILE DID NOT HAVE — every case above proves the SEAM with
     * a balance `grant()` seeds by raw SQL, never one `inspect()` actually
     * wrote. A reported defect ("the customer got the 50-point award email,
     * the admin shows the return awarded, but `/account/rewards` reads 0")
     * can only be pinned by going through BOTH real writers at once: the
     * marketing repo's own award path AND the real `createApp()` this file
     * exists to exercise — exactly the discipline that caught the missing
     * `customer` resolver and the missing CORS header on this same route.
     *
     * THE TWO EMAILS ARE DELIBERATELY DIFFERENTLY CASED. The session is
     * signed in under one spelling and the return is logged under another,
     * to pin the promise `ledger/repo.ts`'s `foldEmail` and
     * `returns/repo.ts`'s own copy of it both make: `marketing_balances`,
     * `marketing_ledger` and the open-return index all key on the SAME
     * lower-cased address regardless of how either caller happened to spell
     * it. If a fold were ever missing on either side, this is the test that
     * would show the ledger and the wallet disagreeing about who earned it.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const customer = await signedInCustomer('Fifty.Points@Example.Test');
    const FOLDED = 'fifty.points@example.test';

    const area = await ctx.db.execute(sql`
      INSERT INTO marketing_service_areas (id, key, region, name, active, created_at, updated_at)
      VALUES ('area_composition_0001', 'composition-test', 'Farflung Province',
              'Composition Test District', true, ${NOW}, ${NOW})
      ON CONFLICT (id) DO UPDATE SET active = true
      RETURNING id`);
    const areaId = String(area.rows[0]!.id);

    const program = await ctx.db.execute(sql`
      INSERT INTO marketing_programs
        (id, key, kind, name, points_label_singular, points_label_plural,
         unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
         status, created_at, updated_at)
      VALUES ('prg_composition_0001', 'composition-test-caps', 'unit_return', 'Composition Caps',
              'Composition Point', 'Composition Points', 'canister', 'canisters',
              4, 10, 'active', ${NOW}, ${NOW})
      ON CONFLICT (id) DO UPDATE SET status = 'active'
      RETURNING id`);
    const programId = String(program.rows[0]!.id);

    // Created under UPPER CASE — the fold this repo owns, not the caller's job.
    const created = await createRequest(ctx.db, {
      email: 'FIFTY.POINTS@EXAMPLE.TEST',
      qtyDeclared: 5,
      programId,
      serviceAreaId: areaId,
      customerId: customer.id,
      pickupAddress: '1 Composition Test Road',
      source: 'customer',
      now: NOW,
    });
    const scheduled = await schedule(ctx.db, created.id, {
      expectedRevision: created.revision,
      pickupAt: NOW + 86_400_000,
      now: NOW,
    });
    const collected = await collect(ctx.db, created.id, {
      expectedRevision: scheduled.revision,
      now: NOW,
    });
    const received = await receive(ctx.db, created.id, {
      expectedRevision: collected.revision,
      now: NOW,
    });

    // THE AWARD ITSELF — 5 accepted × 10 a unit, the "50 points" the report named.
    const outcome = await inspect(ctx.db, created.id, {
      expectedRevision: received.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      now: NOW,
    });
    expect(outcome.award).toEqual({ points: 50, balance: 50 });

    // The write, confirmed directly against the folded key — a customer who
    // earned 50 has a balance ROW that says so.
    const written = await ctx.db.execute(sql`
      SELECT balance FROM marketing_balances WHERE customer_email = ${FOLDED}`);
    expect(written.rows[0]).toMatchObject({ balance: 50 });

    // The read — the SAME path `/account/rewards` calls, over a session signed
    // in under a DIFFERENT casing of the same address.
    const res = await client.app.request('/api/marketing/me/points', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect((await json<{ points: number; lifetimeEarned: number }>(res)).points).toBe(50);
  });
});

// ============================================================================
// A CUSTOMER FILING THEIR OWN RETURN — /me/returns
// ============================================================================

describe('a customer asking for their own return', () => {
  /** A served district. Areas ship INACTIVE (0012), so one is switched on here. */
  let servedAreaId: string;

  beforeAll(async () => {
    const res = await ctx.db.execute(sql`
      UPDATE marketing_service_areas SET active = true
       WHERE id = (SELECT id FROM marketing_service_areas ORDER BY id LIMIT 1)
       RETURNING id`);
    servedAreaId = String(res.rows[0]!.id);
  });

  /* `5`, NOT `4`, AND THE NUMBER IS LOAD-BEARING. The seeded default programme
     (`spool-return`, migration 0011) sets `min_units_per_return = 5`, so a 4
     here is a `below_minimum` 400 and every 201 assertion below fails for a
     reason that has nothing to do with what is under test. */
  const body = (over: Record<string, unknown> = {}) => ({
    qtyDeclared: 5,
    phone: '08030000000',
    pickupAddress: '1 Test Road',
    serviceAreaId: servedAreaId,
    ...over,
  });

  it('401s a caller with no session', async () => {
    const res = await client.post('/api/marketing/me/returns', body());
    expect(res.status).toBe(401);
  });

  it('gives the body no way to name an address', async () => {
    /* THE SECURITY PROPERTY. `.strict()` means an unknown key is a 400, so a
       request that tries to file against somebody else is REFUSED rather than
       silently ignored — the mistake cannot be made quietly. */
    const customer = await signedInCustomer('dara@example.test');
    const res = await client.post(
      '/api/marketing/me/returns',
      body({ email: 'victim@example.test' }),
      { headers: { cookie: customer.cookie } },
    );
    expect(res.status).toBe(400);
  });

  it('refuses a qtyDeclared past what the column can hold, 400 not 500', async () => {
    /* `2_147_483_648` is one past `INT4_MAX`. `qty_declared` is `integer`
       (migration 0011), so an uncapped body schema lets a shopper 500 the
       route with an ordinary-looking number — Postgres answers SQLSTATE 22003,
       which is not on the §8 table and falls through to a bare 500. */
    const customer = await signedInCustomer('overflow@example.test');
    const res = await client.post(
      '/api/marketing/me/returns',
      body({ qtyDeclared: 2_147_483_648 }),
      { headers: { cookie: customer.cookie } },
    );
    expect(res.status).toBe(400);
  });

  it('REQUIRES a serviceAreaId, as a field error on the field', async () => {
    /*
     * MOVED FROM `server/marketing/areas/routes.test.ts` when
     * `POST /returns/request` — the public form this used to drive — was
     * retired. The asymmetry with the admin path is still the decision: a
     * customer picks their district from a Select of served places, so a
     * submission without one is a bypassed form rather than an unusual
     * address, and a return the storefront accepted that could never be
     * awarded is a promise the shop cannot keep. A shop session is now the
     * only way to reach this requirement at all, which is why the test lives
     * here rather than in the marketing suite (spec D9 — that suite may not
     * import `server/shop/**`).
     */
    const customer = await signedInCustomer('no-area@example.test');
    const res = await client.post(
      '/api/marketing/me/returns',
      body({ serviceAreaId: undefined }),
      { headers: { cookie: customer.cookie } },
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'serviceAreaId' });
  });

  it('files the return against the session, folded, and answers the programme words', async () => {
    const customer = await signedInCustomer('Dara.Two@Example.Test');
    const res = await client.post('/api/marketing/me/returns', body(), {
      headers: { cookie: customer.cookie },
    });
    expect(res.status).toBe(201);

    const answered = await json<{
      requestId: string;
      qtyDeclared: number;
      program: Record<string, unknown>;
    }>(res);
    /*
     * KEY-SET EQUALITY, NOT VALUE EQUALITY. A key added here is a key the
     * storefront may start depending on, and one dropped is a sentence it
     * cannot finish — the pin the retired public intake carried, restored here
     * for its replacement rather than a value assertion that only proves one
     * field is truthy.
     */
    expect(Object.keys(answered).sort()).toEqual(['program', 'qtyDeclared', 'requestId']);
    expect(Object.keys(answered.program).sort()).toEqual([
      'minUnitsPerReturn',
      'name',
      'pointsLabelPlural',
      'pointsLabelSingular',
      'pointsPerUnit',
      'unitLabelPlural',
      'unitLabelSingular',
    ]);

    const row = await ctx.db.execute(sql`
      SELECT customer_email, customer_id, source FROM marketing_return_requests
       WHERE id = ${answered.requestId}`);
    expect(row.rows[0]!.customer_email).toBe('dara.two@example.test');
    expect(row.rows[0]!.customer_id).toBe(customer.id);
    expect(row.rows[0]!.source).toBe('customer');
  });

  it('normalises a blank optional name to absent, not a stored empty string', async () => {
    /*
     * MINOR: the retired public intake used `optionalText()` precisely so a
     * plain HTML form's untouched optional input — `{"name": ""}` — would not
     * 400. A bare `.optional()` here would refuse it instead, with no field for
     * the storefront to land the error beside.
     */
    const customer = await signedInCustomer('blank.name@example.test');
    const res = await client.post('/api/marketing/me/returns', body({ name: '' }), {
      headers: { cookie: customer.cookie },
    });
    expect(res.status).toBe(201);

    const answered = await json<{ requestId: string }>(res);
    const row = await ctx.db.execute(sql`
      SELECT customer_name FROM marketing_return_requests
       WHERE id = ${answered.requestId}`);
    expect(row.rows[0]!.customer_name).toBeNull();
  });

  it('lists one shopper their own returns and nobody else in them', async () => {
    const customer = await signedInCustomer('lister@example.test');
    await client.post('/api/marketing/me/returns', body(), {
      headers: { cookie: customer.cookie },
    });

    const res = await client.get('/api/marketing/me/returns', {
      headers: { cookie: customer.cookie },
    });
    expect(res.status).toBe(200);

    const page = await json<{ items: Record<string, unknown>[] }>(res);
    expect(page.items).toHaveLength(1);
    /*
     * KEY-SET EQUALITY ON THE ITEM. Not `driverName` alone asserted truthy —
     * the full projection, so a widened or narrowed row fails here instead of
     * shipping quietly. The four contact fields (`customerName`,
     * `customerPhone`, `pickupAddress`, `serviceAreaId`) are the shopper's OWN
     * data, returned to the shopper who supplied it, over a route that already
     * derives their identity from their session — a different question from the
     * two fields still withheld below.
     */
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      'createdAt',
      'customerName',
      'customerPhone',
      'driverName',
      'id',
      'pickupAddress',
      'pickupScheduledAt',
      'pointsAwarded',
      'qtyAccepted',
      'qtyDeclared',
      'serviceAreaId',
      'status',
    ]);

    /* NOT `driverPhone`: a shopper is told who is coming, not how to ring them
       directly. NOT `revision`: that is a concurrency token for a screen that
       can write, and this one cannot. The exclusion is now a deliberate line
       rather than an accident of a short SELECT, so it gets its own pin here,
       independent of the key-set equality above. */
    expect(page.items[0]).not.toHaveProperty('driverPhone');
    expect(page.items[0]).not.toHaveProperty('revision');

    /* The other half: somebody else's return is not in it. Filed by a second
       signed-in customer rather than inserted raw, so this exercises the same
       path it is asserting about. */
    const other = await signedInCustomer('other@example.test');
    await client.post('/api/marketing/me/returns', body(), {
      headers: { cookie: other.cookie },
    });
    const again = await json<{ items: { id: string }[] }>(
      await client.get('/api/marketing/me/returns', { headers: { cookie: customer.cookie } }),
    );
    expect(again.items).toHaveLength(1);
  });

  /**
   * THE CORS ASSERTIONS, mirroring `/me/points`' own above — on headers,
   * deliberately. CLAUDE.md §2 records this exact gap shipping three times
   * (reviews, payments, orders), a green suite every time, because a
   * server-side request never enforces CORS.
   */
  it('answers the PREFLIGHT, not a 404 — both the response and the preflight are asserted', async () => {
    /*
     * CRITICAL, whole-branch review round: `OPTIONS /api/marketing/me/returns`
     * 404'd — no `.options()` handler existed under `/me/returns` at all, so a
     * cross-origin `POST` with `content-type: application/json` and
     * `credentials: 'include'` never left the browser. The 404 status, and the
     * absent `allow-methods`/`allow-headers` it carried, each independently
     * fail a preflight; either alone would have been enough to break this.
     */
    const res = await client.request('/api/marketing/me/returns', {
      method: 'OPTIONS',
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('SETS access-control-allow-credentials on the list response', async () => {
    const customer = await signedInCustomer('cors.list@example.test');
    const res = await client.get('/api/marketing/me/returns', {
      headers: { cookie: customer.cookie, origin: TEST_ORIGIN },
    });

    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('SETS them on the 201 too, not only on reads', async () => {
    const customer = await signedInCustomer('cors.post@example.test');
    const res = await client.post('/api/marketing/me/returns', body(), {
      headers: { cookie: customer.cookie },
    });
    expect(res.status).toBe(201);

    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('SETS access-control-allow-credentials on the 401 as well, or the browser hides the reason', async () => {
    const res = await client.get('/api/marketing/me/returns', {
      headers: { origin: TEST_ORIGIN },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

// ============================================================================
// task-d3 — CANCEL REFUNDS A PAID ORDER FIRST, THEN CANCELS IT
// ============================================================================

/**
 * `POST /admin/orders/:id/cancel`'s `refund` seam, PROVEN THROUGH THE REAL
 * `createApp()` — the same reason admin#27's test above lives in THIS file
 * rather than in `orders/routes.test.ts`. That suite's own `ordersClient`
 * registers its OWN fakes before building the app (`orders/test/app.ts`), so
 * it proves the ROUTE and nothing about the WIRING `server/index.ts` does —
 * and the wiring is exactly what broke silently before, on this file's own
 * telling. `refund` is a new seam of the identical shape, added to `AppDeps`
 * and `registerOrdersDefaults` for this.
 *
 * A `FakeProvider`, injected through `AppDeps.provider` (added for this task),
 * stands in for the NETWORK boundary only. `createRefund`, its sum-check
 * guard and its idempotency key are all the REAL functions from
 * `payments/refunds.ts`, reached through the REAL `registerOrdersDefaults`
 * call — nothing about the orchestration under test is faked.
 */
describe('task-d3: cancelling a paid order refunds it first, through the real refund seam', () => {
  let provider: FakeProvider;
  let money: HttpClient;

  beforeEach(() => {
    provider = new FakeProvider();
    /*
     * A SECOND `resetOrdersDeps()`, AFTER THE FILE-LEVEL ONE ABOVE. That outer
     * hook already built `client = httpClient(ctx.db)` — with no `provider` —
     * which means its OWN `createApp()` call already won the fill-only-absent
     * race on the `refund` seam, registering a closure that resolves the REAL
     * `paystackProvider()`. `registerOrdersDefaults` fills only what is
     * absent, so `httpClient(ctx.db, { provider })` below would otherwise never
     * get a chance to register ITS OWN, `FakeProvider`-backed closure — every
     * request through `money` would reach the real Paystack adapter and 401.
     * Resetting again, immediately before building `money`, is what makes this
     * describe block's own registration the one that wins.
     */
    resetOrdersDeps();
    money = httpClient(ctx.db, { provider });
  });

  async function ownerOf(client: HttpClient): Promise<HttpClient> {
    await client.signIn({ email: 'owner@test.local' });
    return client;
  }

  /**
   * A CAPTURED intent, ready to refund — inserted directly, like `intent()`
   * above, but WITH a `provider_intent_id`: `createRefund` throws
   * `provider_intent_id` without one, and the read-only `intent()` helper
   * above never needed one because nothing there calls a refund.
   */
  async function capturedIntent(id: string, amount: number): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, provider_intent_id, amount, currency, status,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${id}, ${CHECKOUT}, ${'prov_' + id}, ${amount}, 'USD', 'captured',
              ${'idem_' + id}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  async function refundRows(intentId: string): Promise<{ amount: number; status: string }[]> {
    const res = await ctx.db.execute(
      sql`SELECT amount, status FROM shop_refunds WHERE intent_id = ${intentId} ORDER BY created_at`,
    );
    return res.rows.map((r) => ({ amount: Number(r.amount), status: String(r.status) }));
  }

  async function intentRefundedTotal(intentId: string): Promise<number> {
    const res = await ctx.db.execute(
      sql`SELECT refunded_total FROM shop_payment_intents WHERE id = ${intentId}`,
    );
    return Number(res.rows[0]?.refunded_total ?? -1);
  }

  it('refunds 100% of the order total, then cancels it', async () => {
    const intentId = 'pi_task_d3_100';
    const orderId = await paidOrder('cust_task_d3_100', intentId);
    await capturedIntent(intentId, 5400); // matches paidOrder's fixture grandTotal

    const owner = await ownerOf(money);
    const res = await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, {
      refund: { kind: 'percent', percent: 100 },
    });

    expect(res.status).toBe(200);
    const body = await json<{ order: { status: string; refundedTotal: number } }>(res);
    expect(body.order.status).toBe('cancelled');
    // The customer-facing mirror of the refund (`withRefundedAmount`), not
    // only the intent-side ledger.
    expect(body.order.refundedTotal).toBe(5400);

    expect(await refundRows(intentId)).toEqual([{ amount: 5400, status: 'pending' }]);
    expect(await intentRefundedTotal(intentId)).toBe(5400);
    // Reached the ACTUAL provider boundary exactly once — proof this ran
    // through the real `createRefund`, not a stand-in for the whole seam.
    expect(provider.countOf('refund')).toBe(1);
  });

  it('refunds 75% of an odd total, rounded to the nearest minor unit, then cancels', async () => {
    const customerId = 'cust_task_d3_75';
    const intentId = 'pi_task_d3_75';
    // 1001 minor units is deliberately not divisible by 4: 1001 * 0.75 =
    // 750.75, which only proves the rounding rule if the total is odd enough
    // to produce a fraction. `Math.round` → 751 (round half up); see
    // `refundPercentOf` in `server/shop/orders/routes.ts`.
    await insertEvents(ctx.db, [
      { ...checkoutCompleted({ customerId, subtotal: 1001, shippingTotal: 0, taxTotal: 0, grandTotal: 1001 }), id: `evt_chk_${customerId}` },
    ]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    await markOrderPaid(ctx.db, read.order.id, NOW, null, null, intentId);
    await capturedIntent(intentId, 1001);

    const owner = await ownerOf(money);
    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`, {
      refund: { kind: 'percent', percent: 75 },
    });

    expect(res.status).toBe(200);
    const body = await json<{ order: { status: string; refundedTotal: number } }>(res);
    expect(body.order.status).toBe('cancelled');
    expect(body.order.refundedTotal).toBe(751);
    expect(await refundRows(intentId)).toEqual([{ amount: 751, status: 'pending' }]);
    expect(await intentRefundedTotal(intentId)).toBe(751);
  });

  it('cancels an unpaid order without attempting any refund, and refuses one if offered', async () => {
    const customerId = 'cust_task_d3_pending';
    await insertEvents(ctx.db, [
      { ...checkoutCompleted({ customerId }), id: `evt_chk_${customerId}` },
    ]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    expect(read.order.status).toBe('pending'); // never marked paid

    // Programmed to fail LOUDLY if this route ever reaches it — belt and
    // braces alongside the direct call-count assertion below.
    provider.program('refund', { kind: 'fail', code: 'invalid_request' });
    const owner = await ownerOf(money);

    // "An unpaid order must never reach a refund path" (task-d3, verbatim):
    // offering one is refused outright, before anything is cancelled.
    const offered = await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`, {
      refund: { kind: 'none' },
    });
    expect(offered.status).toBe(400);

    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`);
    expect(res.status).toBe(200);
    const body = await json<{ order: { status: string } }>(res);
    expect(body.order.status).toBe('cancelled');
    expect(provider.countOf('refund')).toBe(0);
  });

  /**
   * A REAL DOUBLE-CLICK: the SAME preset, sent twice. 75% is what a real
   * operator's second click actually resends (the button's own request body
   * carries no memory of the first click), and 75%+75% exceeds the intent's
   * amount — so the SECOND call's `createRefund` is refused by the sum-check
   * guard itself before it can ever reach the provider a second time. See
   * `server/shop/orders/routes.ts`'s block comment on this route for the case
   * where a SMALLER repeated amount instead reads through
   * `createRefund`'s idempotency key; either way nothing here double-refunds.
   */
  it('a double-submit refunds once, cancels once, and refuses the second attempt', async () => {
    const intentId = 'pi_task_d3_double';
    const orderId = await paidOrder('cust_task_d3_double', intentId);
    await capturedIntent(intentId, 5400);

    const owner = await ownerOf(money);
    const body = { refund: { kind: 'percent' as const, percent: 75 as const } };

    const first = await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, body);
    expect(first.status).toBe(200);
    expect((await json<{ order: { status: string } }>(first)).order.status).toBe('cancelled');

    const second = await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, body);
    // Refused — either the sum-check guard (this case) or `cancelOrder`'s own
    // CAS on an already-cancelled order, but never a 200.
    expect(second.status).not.toBe(200);

    // THE PROPERTY THAT MATTERS: exactly one refund moved, exactly once.
    expect(await refundRows(intentId)).toEqual([{ amount: 4050, status: 'pending' }]);
    expect(await intentRefundedTotal(intentId)).toBe(4050);
    expect(provider.countOf('refund')).toBe(1);
  });
});

// ============================================================================
// task-d4 — A REFUND THE PROVIDER ACCEPTED LATER FAILS AT THE PROVIDER, AFTER
// THE ORDER IS ALREADY CANCELLED (the gap task-d3 named and left open, §4 of
// its own report).
// ============================================================================

/**
 * `task-d3` refunds a paid order FIRST, then cancels it, and treats the
 * provider's ordinary `pending` the same as a synchronous `succeeded` — the
 * money is "committed to move". If it later fails to actually settle, the
 * order is already gone. This is that sequence, driven end to end:
 *
 *  1. `POST /admin/orders/:id/cancel` — THE REAL ROUTE, THE REAL `RefundIssuer`
 *     seam, a `FakeProvider` standing in only for the network boundary
 *     (exactly `task-d3`'s own arrangement). The refund lands `pending`; the
 *     order becomes `cancelled`.
 *  2. `applyRefundEvent` — THE REAL FUNCTION `server/shop/payments/refunds.ts`
 *     exports, called directly rather than through a signed webhook POST.
 *     That boundary (HMAC verification) is orthogonal to what this task
 *     changed and is exercised elsewhere; what this task changed lives
 *     entirely inside this function's own SQL and is proven by calling it for
 *     real, not by re-proving Paystack's signature scheme.
 *  3. `sweepCommerceEvents` — THE REAL CONSUMER, reached exactly as `task-d3`
 *     reaches it for its own async half.
 *  4. `GET /admin/orders/:id` — THE REAL ROUTE AN OPERATOR ACTUALLY OPENS,
 *     read back through `client`/`money` rather than a raw `SELECT`, so this
 *     test also proves the response an operator's screen receives, not only
 *     what the database holds.
 */
describe('task-d4: a refund accepted by the provider later fails, after the order is already cancelled', () => {
  let provider: FakeProvider;
  let money: HttpClient;

  beforeEach(() => {
    provider = new FakeProvider();
    // See `task-d3`'s own identical call for why this is needed a second
    // time: the file-level `beforeEach` already built `client` with no
    // `provider`, which would otherwise win the fill-only-absent race on the
    // `refund` seam before this block's `FakeProvider`-backed `money` gets a
    // turn.
    resetOrdersDeps();
    money = httpClient(ctx.db, { provider });
  });

  async function ownerOf(client: HttpClient): Promise<HttpClient> {
    await client.signIn({ email: 'owner@test.local' });
    return client;
  }

  async function capturedIntent(id: string, amount: number): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, provider_intent_id, amount, currency, status,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${id}, ${CHECKOUT}, ${'prov_' + id}, ${amount}, 'USD', 'captured',
              ${'idem_' + id}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  async function pendingRefund(intentId: string): Promise<{ refundId: string; providerRefundId: string }> {
    const res = await ctx.db.execute(
      sql`SELECT id, provider_refund_id FROM shop_refunds WHERE intent_id = ${intentId}`,
    );
    const row = res.rows[0];
    return { refundId: String(row.id), providerRefundId: String(row.provider_refund_id) };
  }

  async function refundStatus(refundId: string): Promise<string> {
    const res = await ctx.db.execute(
      sql`SELECT status FROM shop_refunds WHERE id = ${refundId}`,
    );
    return String(res.rows[0].status);
  }

  async function intentRefundedTotal(intentId: string): Promise<number> {
    const res = await ctx.db.execute(
      sql`SELECT refunded_total FROM shop_payment_intents WHERE id = ${intentId}`,
    );
    return Number(res.rows[0]?.refunded_total ?? -1);
  }

  interface OrderDetail {
    order: { status: string };
    timeline: { type: string; message: string }[];
  }

  it('does not un-cancel the order, and an operator sees why on the order page', async () => {
    const intentId = 'pi_task_d4_visible';
    const orderId = await paidOrder('cust_task_d4_visible', intentId);
    await capturedIntent(intentId, 5400);

    const owner = await ownerOf(money);
    const cancelRes = await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, {
      refund: { kind: 'percent', percent: 100 },
    });
    expect(cancelRes.status).toBe(200);
    expect((await json<{ order: { status: string } }>(cancelRes)).order.status).toBe('cancelled');

    const { refundId, providerRefundId } = await pendingRefund(intentId);

    // The provider's webhook, arriving well after the order is gone. Stored
    // first, exactly as `storeEvent` (`payments/webhook.ts`) would store the
    // real thing, because `applyRefundEvent` reads the row by id rather than
    // taking the payload directly.
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_task_d4_visible', ${'refund.processed:' + providerRefundId}, 'refund.processed',
              '{}'::jsonb, ${NOW + 1})`);
    const applied = await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_visible', providerRefundId, status: 'failed' },
      NOW + 1,
    );
    expect(applied.settled).toBe(true);
    expect(applied.emittedEventId).not.toBeNull();

    await sweepCommerceEvents(ctx.db, DEPS, NOW + 2);

    // NOT RESURRECTED — still cancelled.
    const detail = await json<OrderDetail>(await owner.get(`/api/shop/admin/orders/${orderId}`));
    expect(detail.order.status).toBe('cancelled');

    // VISIBLE — an operator opening this order sees why.
    const entry = detail.timeline.find((e) => e.type === 'refund_failed');
    expect(entry).toBeDefined();
    expect(entry?.message.toLowerCase()).toContain('needs attention');

    // The intent-level ledger still tells the truth for reconciliation, as
    // it always did — this task did not touch `refunds.ts`'s own unwind.
    expect(await refundStatus(refundId)).toBe('failed');
    expect(await intentRefundedTotal(intentId)).toBe(0);
  });

  it('a redelivered failure webhook does not write a second timeline entry', async () => {
    const intentId = 'pi_task_d4_redelivered';
    const orderId = await paidOrder('cust_task_d4_redelivered', intentId);
    await capturedIntent(intentId, 5400);

    const owner = await ownerOf(money);
    await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, {
      refund: { kind: 'percent', percent: 100 },
    });
    const { providerRefundId } = await pendingRefund(intentId);

    /*
     * ONE STORED ROW, ASKED TWICE — matching what a REAL redelivery actually
     * does, not an approximation of it. `shop_payment_events
     * .provider_event_id` is UNIQUE, and `storeEvent` (`payments/webhook.ts`)
     * resolves a conflict on it by returning the EXISTING row's id rather
     * than inserting a second row (`ON CONFLICT (provider_event_id) DO
     * NOTHING`, then a read-through). So Paystack redelivering the same
     * webhook reaches `applyRefundEvent` with the SAME `eventRowId` both
     * times, exactly as `refunds.test.ts`'s own "delivered three times" test
     * already models it — this is that property, one level up the stack.
     */
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_task_d4_redelivered', ${'refund.processed:' + providerRefundId}, 'refund.processed',
              '{}'::jsonb, ${NOW + 1})`);

    // FIRST delivery settles it.
    await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_redelivered', providerRefundId, status: 'failed' },
      NOW + 1,
    );
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 2);

    // THE REDELIVERY. `applyRefundEvent`'s own `claimed` CTE already refuses
    // a second pass over the SAME row (`processed_at IS NULL`), and even if
    // it did not, `settled`'s `r.status = 'pending'` gate would: the refund
    // is already `failed`. No second `commerce_events` row either way.
    const redelivered = await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_redelivered', providerRefundId, status: 'failed' },
      NOW + 3,
    );
    expect(redelivered.settled).toBe(false);
    expect(redelivered.emittedEventId).toBeNull();
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 4);

    const detail = await json<OrderDetail>(await owner.get(`/api/shop/admin/orders/${orderId}`));
    expect(detail.timeline.filter((e) => e.type === 'refund_failed')).toHaveLength(1);

    const outbox = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM commerce_events WHERE type = 'payment.refund_failed'`,
    );
    expect(Number(outbox.rows[0].n)).toBe(1);
  });

  /*
   * THE CUSTOMER'S HALF, which task-d4 scoped out and named as a follow-up
   * (§5 of its own report). The two tests above prove an OPERATOR finds out;
   * these prove the person who is owed the money does.
   *
   * The sequence matters: by this point the customer has already received the
   * "Order cancelled" notice, which carries no refund figure but does imply
   * money is coming back. Nothing corrected that implication until this email.
   */
  it('tells the customer the refund did not go through', async () => {
    const intentId = 'pi_task_d4_mailed';
    const orderId = await paidOrder('cust_task_d4_mailed', intentId);
    await capturedIntent(intentId, 5400);

    const owner = await ownerOf(money);
    await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, {
      refund: { kind: 'percent', percent: 100 },
    });
    const { providerRefundId } = await pendingRefund(intentId);

    await ctx.db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_task_d4_mailed', ${'refund.processed:' + providerRefundId}, 'refund.processed',
              '{}'::jsonb, ${NOW + 1})`);
    await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_mailed', providerRefundId, status: 'failed' },
      NOW + 1,
    );
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 2);

    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    const failures = (await listIntents(ctx.db, orderId)).filter(
      (i) => i.kind === 'refund_failed',
    );
    expect(failures).toHaveLength(1);

    // Addressed from the ORDER'S OWN snapshot — the address they bought with,
    // never anything a webhook payload supplied.
    expect(failures[0].to).toBe(read.order.email);
    expect(failures[0].subject).toContain(read.order.orderNumber);

    // The amount that failed to move, named — the decision recorded in
    // `ORDER_REFUND_FAILED`'s own comment in `server/mail/defaults.ts`.
    expect(failures[0].body).toContain('54.00 USD');

    // Both parts are authored and stored, as migration 0320 requires of every
    // message written by this build. A null `html` here would be a row the
    // sweeper delivers through the pre-0320 `textToHtml` fallback.
    expect(failures[0].html).not.toBeNull();
    expect(failures[0].html).toContain('54.00 USD');
  });

  it('and a redelivered failure webhook does not send a second email', async () => {
    /*
     * The email intent is written in the SAME STATEMENT as the timeline entry
     * and the consumption claim, gated `FROM claim` like everything else in
     * `recordRefundFailure` — so this is the redelivery test above, asked
     * about the customer's inbox instead of the operator's screen. A second
     * "we could not complete your refund" for one failure is worse than the
     * first: it reads as a second failure.
     */
    const intentId = 'pi_task_d4_mailed_twice';
    const orderId = await paidOrder('cust_task_d4_mailed_twice', intentId);
    await capturedIntent(intentId, 5400);

    const owner = await ownerOf(money);
    await owner.post(`/api/shop/admin/orders/${orderId}/cancel`, {
      refund: { kind: 'percent', percent: 100 },
    });
    const { providerRefundId } = await pendingRefund(intentId);

    await ctx.db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_task_d4_mailed_twice', ${'refund.processed:' + providerRefundId},
              'refund.processed', '{}'::jsonb, ${NOW + 1})`);
    await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_mailed_twice', providerRefundId, status: 'failed' },
      NOW + 1,
    );
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 2);

    await applyRefundEvent(
      ctx.db,
      { eventRowId: 'pev_task_d4_mailed_twice', providerRefundId, status: 'failed' },
      NOW + 3,
    );
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 4);

    const kinds = (await listIntents(ctx.db, orderId)).map((i) => i.kind);
    expect(kinds.filter((k) => k === 'refund_failed')).toHaveLength(1);
    /*
     * The rest of the order's mail is untouched by the redelivery, too —
     * asserted as a MULTISET rather than in order. `listIntents` sorts by
     * `created_at`, and the cancellation is written by the real route under the
     * real clock while every event here is driven at the fixture's `NOW`
     * (2023). Their relative order is an artefact of that gap, not behaviour,
     * and pinning it would fail the day the fixture constant moves.
     */
    expect([...kinds].sort()).toEqual(
      ['placed', 'confirmation', 'cancellation', 'refund_failed'].sort(),
    );
  });
});

// ============================================================================
// A GATEWAY THAT TURNS A REFUND DOWN (production, 2026-09-15)
// ============================================================================

/**
 * Flutterwave refused a ₦500 refund in production and the owner was shown
 * `internal`: `ProviderError` had no row in the error table, so a plain "no"
 * from the gateway reached the screen as a crash. Driven through the real
 * `createApp()` with ONE FAKE PER GATEWAY, injected through `AppDeps.factories`,
 * so these tests also prove the refund goes to the gateway the payment was
 * taken through — Paystack's fake must never be asked.
 */
describe('a gateway that turns a refund down, through the real composition root', () => {
  let paystack: FakeProvider;
  let flutterwave: FakeProvider;
  let money: HttpClient;

  beforeEach(async () => {
    paystack = new FakeProvider({ name: 'paystack' });
    flutterwave = new FakeProvider({ name: 'flutterwave' });
    // Task-d3's reason: the file-level client already filled the refund seam.
    resetOrdersDeps();
    money = httpClient(ctx.db, {
      factories: { paystack: () => paystack, flutterwave: () => flutterwave },
    });
    await money.signIn({ email: 'owner@test.local' });
  });

  /** A captured payment taken through Flutterwave, ready to refund. */
  async function flutterwaveIntent(id: string, amount: number): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, provider, provider_intent_id, amount, currency, status,
         idempotency_key, request_fingerprint, refunded_total,
         created_at, updated_at, revision)
      VALUES (${id}, ${CHECKOUT}, 'flutterwave', ${'prov_' + id}, ${amount}, 'USD', 'captured',
              ${'idem_' + id}, 'fp', 0, ${NOW}, ${NOW}, 1)`);
  }

  it('answers 422 naming Flutterwave instead of a 500, and never asks Paystack', async () => {
    const intentId = 'pi_refused_route';
    await paidOrder('cust_refused_route', intentId);
    await flutterwaveIntent(intentId, 5400);
    flutterwave.program('refund', { kind: 'fail', code: 'invalid_request' });

    const res = await money.post(`/api/shop/admin/payments/intents/${intentId}/refunds`, {
      amount: 5400,
      idempotencyKey: 'refund-attempt-route-1',
    });

    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: 'refund_failed',
      provider: 'flutterwave',
      outcome: 'refused',
      code: 'invalid_request',
    });
    expect(flutterwave.countOf('refund')).toBe(1);
    expect(paystack.countOf('refund')).toBe(0);
  });

  it('never answers a same-key retry of an unconfirmed refund with a refund', async () => {
    const intentId = 'pi_unconfirmed_route';
    await paidOrder('cust_unconfirmed_route', intentId);
    await flutterwaveIntent(intentId, 5400);
    flutterwave.program('refund', { kind: 'fail', code: 'provider_unavailable' });
    const body = { amount: 5400, idempotencyKey: 'refund-attempt-route-2' };

    const first = await money.post(`/api/shop/admin/payments/intents/${intentId}/refunds`, body);
    const again = await money.post(`/api/shop/admin/payments/intents/${intentId}/refunds`, body);

    expect(first.status).toBe(422);
    // This one used to be a 200 carrying the failed refund — "Refunded" on screen.
    expect(again.status).toBe(422);
    expect(await json(again)).toMatchObject({ error: 'refund_failed', outcome: 'unconfirmed' });
    expect(flutterwave.countOf('refund')).toBe(1);
  });

  it('keeps a paid order paid when its refund is refused, and a retried cancel really refunds', async () => {
    const intentId = 'pi_refused_cancel';
    const orderId = await paidOrder('cust_refused_cancel', intentId);
    await flutterwaveIntent(intentId, 5400);
    flutterwave.program('refund', { kind: 'fail', code: 'invalid_request' });
    const cancel = { refund: { kind: 'percent' as const, percent: 100 as const } };

    const refused = await money.post(`/api/shop/admin/orders/${orderId}/cancel`, cancel);
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({ error: 'refund_failed', provider: 'flutterwave' });
    const page = await json<{ order: { status: string } }>(
      await money.get(`/api/shop/admin/orders/${orderId}`),
    );
    expect(page.order.status).toBe('paid');

    // The same click once the gateway accepts. The route's key is fixed
    // (`cancel:<order>:<amount>`), so a replayed refusal here would either
    // refuse forever or — before this fix — cancel with nothing refunded.
    const retried = await money.post(`/api/shop/admin/orders/${orderId}/cancel`, cancel);
    expect(retried.status).toBe(200);
    expect((await json<{ order: { status: string } }>(retried)).order.status).toBe('cancelled');
    expect(flutterwave.countOf('refund')).toBe(2);
    expect(paystack.countOf('refund')).toBe(0);
  });

  /*
   * THE OWNER'S RULE (2026-09-15): a refund whose result is unknown stays
   * pending with its amount held, and the order page settles it by hand. The
   * resolve route is driven here through the real app so its `sweepEvents`
   * wiring is proven too — "It went through" is only true on the order page if
   * Orders hears `payment.refunded` in the same request.
   */
  describe('a refund nobody could confirm, held until the owner settles it', () => {
    const refundsOf = (intentId: string) => `/api/shop/admin/payments/intents/${intentId}/refunds`;
    const resolve = (refundId: string) => `/api/shop/admin/payments/refunds/${refundId}/resolve`;

    /** A refund the gateway did not confirm, made through the real route. */
    async function heldRefund(intentId: string, key: string): Promise<string> {
      flutterwave.program('refund', { kind: 'fail', code: 'provider_unavailable' });
      const res = await money.post(refundsOf(intentId), { amount: 5400, idempotencyKey: key });
      expect(res.status).toBe(422);
      const rows = await ctx.db.execute(sql`SELECT id FROM shop_refunds WHERE intent_id = ${intentId}`);
      return String(rows.rows[0]?.id);
    }

    /** The minute in which a gateway call could still be running has passed. */
    async function aMinuteLater(refundId: string): Promise<void> {
      await ctx.db.execute(
        sql`UPDATE shop_refunds SET created_at = created_at - 120000 WHERE id = ${refundId}`,
      );
    }

    it('shows the held refund on the order, and a new refund window cannot take that money', async () => {
      const intentId = 'pi_held_page';
      const orderId = await paidOrder('cust_held_page', intentId);
      await flutterwaveIntent(intentId, 5400);
      const id = await heldRefund(intentId, 'refund-attempt-held-1');

      const page = await json<{ payment: { unconfirmedRefunds: { id: string; amount: number }[] } }>(
        await money.get(`/api/shop/admin/orders/${orderId}`),
      );
      expect(page.payment.unconfirmedRefunds).toEqual([expect.objectContaining({ id, amount: 5400 })]);

      const again = await money.post(refundsOf(intentId), {
        amount: 5400,
        idempotencyKey: 'refund-attempt-held-2',
      });
      expect(again.status).toBe(400);
      expect(flutterwave.countOf('refund')).toBe(1);
    });

    it('marks it sent, and the order shows the refund straight away', async () => {
      const intentId = 'pi_held_sent';
      const orderId = await paidOrder('cust_held_sent', intentId);
      await flutterwaveIntent(intentId, 5400);
      const id = await heldRefund(intentId, 'refund-attempt-held-3');
      await aMinuteLater(id);

      const res = await money.post(resolve(id), { outcome: 'sent' });

      expect(res.status).toBe(200);
      expect((await json<{ refund: { status: string } }>(res)).refund.status).toBe('succeeded');
      const page = await json<{
        order: { status: string; refundedTotal: number };
        payment: { unconfirmedRefunds: unknown[] };
      }>(await money.get(`/api/shop/admin/orders/${orderId}`));
      expect(page.order).toMatchObject({ status: 'refunded', refundedTotal: 5400 });
      expect(page.payment.unconfirmedRefunds).toEqual([]);
    });

    it('marks it not sent, and the same money can be refunded again', async () => {
      const intentId = 'pi_held_not_sent';
      await paidOrder('cust_held_not_sent', intentId);
      await flutterwaveIntent(intentId, 5400);
      const id = await heldRefund(intentId, 'refund-attempt-held-4');
      await aMinuteLater(id);

      const res = await money.post(resolve(id), { outcome: 'not_sent' });
      expect(res.status).toBe(200);
      expect((await json<{ refund: { status: string } }>(res)).refund.status).toBe('failed');

      const retry = await money.post(refundsOf(intentId), {
        amount: 5400,
        idempotencyKey: 'refund-attempt-held-5',
      });
      expect(retry.status).toBe(201);
      expect(flutterwave.countOf('refund')).toBe(2);
    });

    it('refuses to settle a refund sent less than a minute ago', async () => {
      const intentId = 'pi_held_too_new';
      await paidOrder('cust_held_too_new', intentId);
      await flutterwaveIntent(intentId, 5400);
      const id = await heldRefund(intentId, 'refund-attempt-held-6');

      const res = await money.post(resolve(id), { outcome: 'not_sent' });

      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ error: 'refund_still_sending' });
    });
  });
});

describe('the add-on port, as the deployment registers it', () => {
  /*
   * `server/shop/app.ts` hands Catalog's REAL `addOnPort` to Cart, and it is
   * the only place that does. Cart's own suites inject a fake through
   * `standaloneShop` — see `routes/add-ons.test.ts` — so every one of them
   * would stay green with the wiring in `app.ts` deleted. This is the test
   * that would not: it drives the real `createApp()` end to end, exactly as
   * CLAUDE.md §2 requires for anything money-adjacent.
   */
  it('offers an active add-on through the real app, so an unwired port cannot hide', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
    await createAddOn(
      ctx.db,
      { title: 'Gift box', priceMinor: 150_000, currency: SHOP_CURRENCY, status: 'active', rules: [{ when: [], then: 'ask' }] },
      Date.now(),
    );
    const created = await client.post('/api/shop/cart', {});
    expect(created.status).toBe(201);
    const view = await json<{ addOns?: Array<{ id: string; mode: string }> }>(created);
    expect(view.addOns?.map((o) => o.mode)).toEqual(['ask']);
  });
});
