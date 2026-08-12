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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

let ctx: TestCtx;
let client: HttpClient;

const NOW = 1_700_000_010_000;
const DEPS: ConsumerDeps = { origin: TEST_ORIGIN };
const INTENT_ID = 'pi_composition_0001';

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`
    TRUNCATE shop_customer_sessions, shop_customers, shop_payment_intents CASCADE`);
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
