/**
 * The HTTP surface (brief §6, §8).
 *
 * **THE CENTRAL PROPERTY OF THIS FILE IS THAT CUSTOMER A CANNOT READ CUSTOMER B'S ORDER —
 * by number, by token, or by cursor.** Brief §6: "An order lookup that leaks another
 * customer's order is the worst bug you can ship."
 *
 * Every test goes through the REAL application (`server/test/http.ts` + `createApp`), so the
 * origin guard, the session middleware and spec §8's error table are all in the path. A
 * suite over a hand-rolled Hono would prove the handlers and nothing about the mounting,
 * and the mounting is where `requireAuth()`-as-blanket-middleware turned an unrouted 404
 * into a 401 on the blog side.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { TEST_ORIGIN } from '../../test/http';
import { CUSTOMER_HEADER, ordersClient, resetOrdersDeps, type OrdersClient } from './test/app';
import { resetOrderTables } from './test/harness';
import {
  CHECKOUT,
  CUSTOMER_A,
  CUSTOMER_B,
  T0,
  checkoutCompleted,
  insertEvents,
  paymentCaptured,
} from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout, type OrderRead } from './repo/orders';
import { mintGuestToken } from './tokens';
import { formatOrderNumber } from './order-number';
import type { AuthUser } from '../../../shared/types';
import type { PaymentSnapshot } from '../../../shared/commerce/ports';
import type { Mailer, RenderedEmail } from './mailer';

let ctx: TestCtx;
const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: TEST_ORIGIN };

/** One page of `GET /api/shop/orders`, as the storefront sees it. */
interface CustomerOrderPage {
  items: { order: { orderNumber: string; customerId: string } }[];
  nextCursor: string | null;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  /*
   * `auth_attempts` AND `sessions`, for the reason `server/nul-bytes.test.ts` clears them
   * too: login is rate limited per (ip, email) in POSTGRES rather than in module memory
   * (spec §6 — a serverless instance shares no memory with the next), so a suite that logs
   * in more than the window allows starts answering 429 and every later test fails with a
   * status that has nothing to do with what it was testing. Measured: adding four
   * `login()` calls turned three unrelated tests red at 429.
   */
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

function client(deps = {}): OrdersClient {
  return ordersClient(ctx.db, { now: () => NOW, ...deps });
}

async function login(user: AuthUser, deps = {}): Promise<OrdersClient> {
  const c = client(deps);
  const res = await c.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return c;
}

/** One paid order belonging to `CUSTOMER_A`. */
async function paidOrder(customerId: string | null = CUSTOMER_A): Promise<OrderRead> {
  await insertEvents(ctx.db, [
    { ...checkoutCompleted({ customerId }), id: `evt_chk_${customerId ?? 'guest'}` },
  ]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** A second order, for a second customer, so cross-tenant reads have a target. */
async function secondOrder(customerId: string): Promise<OrderRead> {
  await insertEvents(ctx.db, [
    {
      ...checkoutCompleted({ customerId, checkoutId: 'chk_0002', email: 'other@example.test' }),
      id: 'evt_chk_second',
      subjectId: 'chk_0002',
    },
  ]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW + 1);
  return (await readOrderByCheckout(ctx.db, 'chk_0002'))!;
}

// ================================================================ authorization

describe('customer A cannot read customer B’s order', () => {
  it('by order number, with A’s own session', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const theirs = await secondOrder(CUSTOMER_B);

    const c = client();
    c.asCustomer({ id: CUSTOMER_A });

    // Own order: fine.
    expect((await c.get(`/api/shop/orders/${mine.order.orderNumber}`)).status).toBe(200);

    /*
     * Somebody else's: 404, NOT 403. Any distinction between "does not exist" and "not
     * yours" tells an unauthenticated caller whether an order exists — and the order number
     * is a sequence, so that is an enumeration oracle. Spec §8 answers absent and destroyed
     * identically for the same reason.
     */
    const res = await c.get(`/api/shop/orders/${theirs.order.orderNumber}`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('by the events route either', async () => {
    await paidOrder(CUSTOMER_A);
    const theirs = await secondOrder(CUSTOMER_B);
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    expect((await c.get(`/api/shop/orders/${theirs.order.orderNumber}/events`)).status).toBe(404);
  });

  it('by the cursor: A’s list never contains B’s orders, page by page', async () => {
    /*
     * The cursor case brief §6 names explicitly. `listCustomerOrders` binds the customer id
     * into the `WHERE` clause and the keyset predicate is ANDed with it, so no page of A's
     * list can contain B's row — but a scope applied only to the FIRST page is exactly the
     * kind of bug a single-page test misses, so this walks every page at size 1.
     */
    const mine: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await insertEvents(ctx.db, [
        {
          ...checkoutCompleted({ customerId: CUSTOMER_A, checkoutId: `chk_a_${i}` }),
          id: `evt_a_${i}`,
          subjectId: `chk_a_${i}`,
          occurredAt: T0 + i,
        },
      ]);
    }
    for (let i = 0; i < 3; i += 1) {
      await insertEvents(ctx.db, [
        {
          ...checkoutCompleted({ customerId: CUSTOMER_B, checkoutId: `chk_b_${i}` }),
          id: `evt_b_${i}`,
          subjectId: `chk_b_${i}`,
          occurredAt: T0 + 100 + i,
        },
      ]);
    }
    await sweepCommerceEvents(ctx.db, DEPS, NOW);

    const bNumbers = new Set<string>();
    const rows = await ctx.db.execute(
      sql`SELECT order_number FROM shop_orders WHERE customer_id = ${CUSTOMER_B}`,
    );
    for (const row of rows.rows) bNumbers.add(String(row.order_number));
    expect(bNumbers.size).toBe(3);

    const c = client();
    c.asCustomer({ id: CUSTOMER_A });

    let cursor: string | null = null;
    let pages = 0;
    do {
      /*
       * `page` IS ANNOTATED WITH A NAMED TYPE, not an inline generic, and that is not a
       * style preference: inside a loop TypeScript resolves `cursor`'s NARROWED type from
       * the assignments in the body, so `url → cursor → page → url` is a genuine inference
       * cycle and `tsc` reports TS7022 on both. Naming the type breaks it.
       */
      const at: string | null = cursor;
      const url = `/api/shop/orders?limit=1${at ? `&cursor=${encodeURIComponent(at)}` : ''}`;
      const body: CustomerOrderPage = await json(await c.get(url));
      for (const item of body.items) {
        expect(bNumbers.has(item.order.orderNumber)).toBe(false);
        expect(item.order.customerId).toBe(CUSTOMER_A);
        mine.push(item.order.orderNumber);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    // Every one of A's four, exactly once, and none of B's.
    expect(new Set(mine).size).toBe(4);
  });

  it('a token for one order does not open another', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const theirs = await secondOrder(CUSTOMER_B);
    const c = client();

    // A valid token — for MY order — spent against THEIRS.
    const token = mintGuestToken(
      { orderNumber: mine.order.orderNumber, email: mine.order.email },
      NOW,
    );
    const res = await c.get(
      `/api/shop/orders/${theirs.order.orderNumber}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(404);

    // And the same token opens the order it was minted for.
    expect(
      (await c.get(`/api/shop/orders/${mine.order.orderNumber}?token=${encodeURIComponent(token)}`))
        .status,
    ).toBe(200);
  });

  it('a token forged for another order, signed for mine, is refused', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const theirs = await secondOrder(CUSTOMER_B);
    const c = client();

    // A token whose payload names THEIR order but whose signature was made for MINE.
    const legitimate = mintGuestToken(
      { orderNumber: mine.order.orderNumber, email: mine.order.email },
      NOW,
    );
    const [body, signature] = legitimate.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      orderNumber: string;
    };
    claims.orderNumber = theirs.order.orderNumber;
    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    expect(
      (await c.get(`/api/shop/orders/${theirs.order.orderNumber}?token=${encodeURIComponent(forged)}`))
        .status,
    ).toBe(404);
  });

  it('a token whose EMAIL does not match the order is refused', async () => {
    /*
     * The second half of the SQL scoping. `lower(email)` is bound from the token, so a
     * signature minted for a different recipient — a stale link after an email change —
     * matches no row.
     */
    const mine = await paidOrder(CUSTOMER_A);
    const c = client();
    const token = mintGuestToken(
      { orderNumber: mine.order.orderNumber, email: 'someone-else@example.test' },
      NOW,
    );
    expect(
      (await c.get(`/api/shop/orders/${mine.order.orderNumber}?token=${encodeURIComponent(token)}`))
        .status,
    ).toBe(404);
  });

  it('an expired token is refused', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const token = mintGuestToken(
      { orderNumber: mine.order.orderNumber, email: mine.order.email },
      NOW,
      1000,
    );
    const late = ordersClient(ctx.db, { now: () => NOW + 5000 });
    expect(
      (await late.get(
        `/api/shop/orders/${mine.order.orderNumber}?token=${encodeURIComponent(token)}`,
      )).status,
    ).toBe(404);
  });

  it('the order number ALONE opens nothing — it is guessable by construction', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const anonymous = client();
    // No customer session, no token: the number is an identifier, not an authorization.
    expect((await anonymous.get(`/api/shop/orders/${mine.order.orderNumber}`)).status).toBe(404);
  });

  it('a guest order is reachable by token and by nothing else', async () => {
    // Guest checkout is the default path (contract §7): `customer_id IS NULL`.
    const guest = await paidOrder(null);
    expect(guest.order.customerId).toBeNull();

    const c = client();
    expect((await c.get(`/api/shop/orders/${guest.order.orderNumber}`)).status).toBe(404);

    /*
     * AND A CUSTOMER SESSION DOES NOT OPEN IT EITHER. `customer_id = $2` against a NULL
     * column is NULL rather than true, so it matches nothing — but `getOrderForCustomer`
     * refuses an empty id explicitly rather than relying on that, because an authorization
     * decision resting on SQL three-valued logic is one refactor from being wrong.
     */
    c.asCustomer({ id: CUSTOMER_A });
    expect((await c.get(`/api/shop/orders/${guest.order.orderNumber}`)).status).toBe(404);

    const token = mintGuestToken(
      { orderNumber: guest.order.orderNumber, email: guest.order.email },
      NOW,
    );
    expect(
      (await c.get(`/api/shop/orders/${guest.order.orderNumber}?token=${encodeURIComponent(token)}`))
        .status,
    ).toBe(200);
  });

  it('the writer session grants NOTHING on the storefront routes', async () => {
    /*
     * Contract §7: `users` is invite-only staff and a customer is none of those things. A
     * request may legitimately carry both cookies — the shop owner browsing their own store
     * — and the two identities must stay independent. An owner session that opened any
     * customer's order under a storefront URL would be that separation collapsing.
     */
    const mine = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    expect((await owner.get(`/api/shop/orders/${mine.order.orderNumber}`)).status).toBe(404);
    // The admin route is where an owner reads it.
    expect((await owner.get(`/api/shop/admin/orders/${mine.order.id}`)).status).toBe(200);
  });

  it('both cookies at once: neither clobbers the other', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);

    // One request carrying the studio session AND the customer identity.
    const res = await owner.get(`/api/shop/orders/${mine.order.orderNumber}`, {
      headers: { [CUSTOMER_HEADER]: CUSTOMER_A },
    });
    expect(res.status).toBe(200);
    // And the studio session still works on the very next request.
    expect((await owner.get('/api/auth/me')).status).toBe(200);
  });

  it('GET /shop/orders is 401 with no customer, not an empty list', async () => {
    await paidOrder(CUSTOMER_A);
    const res = await client().get('/api/shop/orders');
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: 'unauthenticated' });
  });
});

// ================================================================ malformed input

describe('malformed lookups are 4xx, never 5xx', () => {
  it('a mistyped order number is a 400 before any query runs', async () => {
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const good = formatOrderNumber(2026, 42);
    const bad = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const res = await c.get(`/api/shop/orders/${bad}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'orderNumber' });
  });

  it.each([
    ['a NUL in the path', `/api/shop/orders/${encodeURIComponent('2026-000042-K ')}`],
    ['a NUL in the token', `/api/shop/orders/2026-000042-K?token=${encodeURIComponent(' ')}`],
    ['a NUL in the cursor', `/api/shop/orders?cursor=${encodeURIComponent(' ')}`],
    ['an unknown query key', '/api/shop/orders?statuss=paid'],
    ['a non-numeric limit', '/api/shop/orders?limit=abc'],
    ['a limit out of range', '/api/shop/orders?limit=5000'],
    ['a cursor that does not decode', '/api/shop/orders?cursor=not-base64-json'],
  ])('%s is a 4xx', async (_name, path) => {
    /*
     * U+0000 cannot be stored in a Postgres `text` (22021) or a jsonb string (22P05), and
     * reaching the driver it becomes a 500 — which spec §8's client retries five times over
     * ~30 seconds for input that can never be accepted. Everything here has to be 4xx.
     */
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const res = await c.get(path);
    expect(res.status, `${path} → ${res.status}`).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('a cursor minted for another sort is a 400, not a wrong page', async () => {
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const foreign = Buffer.from(JSON.stringify(['updated', [1], 'ord_x']), 'utf8').toString(
      'base64url',
    );
    const res = await c.get(`/api/shop/orders?cursor=${encodeURIComponent(foreign)}`);
    expect(res.status).toBe(400);
  });
});

// ==================================================================== admin

describe('the admin surface', () => {
  it('lists orders keyset-paginated and filtered by status', async () => {
    const paid = await paidOrder(CUSTOMER_A);
    await secondOrder(CUSTOMER_B); // pending
    const owner = await login(ctx.users.owner);

    const all = await json<{ items: unknown[] }>(await owner.get('/api/shop/admin/orders'));
    expect(all.items).toHaveLength(2);

    const onlyPaid = await json<{ items: { order: { id: string } }[] }>(
      await owner.get('/api/shop/admin/orders?status=paid'),
    );
    expect(onlyPaid.items).toHaveLength(1);
    expect(onlyPaid.items[0].order.id).toBe(paid.order.id);

    // One page at a time, no row twice.
    const first = await json<{ items: { order: { id: string } }[]; nextCursor: string | null }>(
      await owner.get('/api/shop/admin/orders?limit=1'),
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await json<{ items: { order: { id: string } }[] }>(
      await owner.get(`/api/shop/admin/orders?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );
    expect(second.items[0].order.id).not.toBe(first.items[0].order.id);
  });

  it('requires a session', async () => {
    await paidOrder(CUSTOMER_A);
    const res = await client().get('/api/shop/admin/orders');
    expect(res.status).toBe(401);
  });

  it('a writer may read and fulfil; only an owner may cancel', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const writer = await login(ctx.users.writer);

    expect((await writer.get(`/api/shop/admin/orders/${read.order.id}`)).status).toBe(200);
    const created = await writer.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
      lines: [{ orderLineId: read.lines[0].id, qty: 1 }],
      carrier: 'DHL',
      trackingNumber: 'T1',
    });
    expect(created.status).toBe(201);

    /*
     * Contract §HTTP puts anything money-adjacent behind `requireOwner()`, and cancelling a
     * paid order is the most money-adjacent thing here: it tells every consumer of
     * `order.cancelled` to release the stock and stops the order ever shipping.
     */
    const refused = await writer.post(`/api/shop/admin/orders/${read.order.id}/cancel`);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ error: 'forbidden' });
  });

  it('the order detail carries lines, fulfilments, timeline and the email record', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
      lines: [{ orderLineId: read.lines[0].id, qty: 2 }],
      carrier: 'DHL',
      trackingNumber: 'T1',
    });

    const body = await json<{
      order: { id: string };
      lines: unknown[];
      fulfillments: unknown[];
      timeline: { type: string }[];
      emails: { kind: string; sentAt: number | null }[];
      payment: unknown;
    }>(await owner.get(`/api/shop/admin/orders/${read.order.id}`));

    expect(body.order.id).toBe(read.order.id);
    expect(body.lines).toHaveLength(2);
    expect(body.fulfillments).toHaveLength(1);
    expect(body.timeline.map((entry) => entry.type)).toEqual([
      'placed',
      'paid',
      'fulfillment_created',
    ]);
    /*
     * Brief §5: an email you cannot prove you sent is a support ticket you cannot answer.
     * The confirmation is here with `sentAt: null` — WRITTEN BUT NOT DELIVERED — which is
     * exactly the state an operator needs to be able to see, and exactly what a design that
     * sent inline could never show.
     */
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0]).toMatchObject({ kind: 'confirmation', sentAt: null });
    // No `PaymentPort` injected, so no panel — rather than a fabricated status.
    expect(body.payment).toBeNull();
  });

  it('renders the payment panel from an injected PaymentPort and nothing else', async () => {
    /*
     * Contract §5: consumed BY INJECTION, so it can be tested against a fake and this
     * subsystem is never blocked on Payments landing. The port is read-only — nothing here
     * writes through it, and a capture still arrives as an event.
     */
    await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    expect(read.order.paymentIntentId).toBe('pi_0001');

    const snapshot: PaymentSnapshot = {
      intentId: 'pi_0001',
      checkoutId: CHECKOUT,
      status: 'captured',
      amount: 5400,
      currency: 'USD',
      refundedTotal: 0,
      createdAt: T0,
      updatedAt: T0,
    };
    const seen: string[] = [];
    const owner = await login(ctx.users.owner, {
      payments: {
        status: (_db: unknown, intentId: string) => {
          seen.push(intentId);
          return Promise.resolve(snapshot);
        },
      },
    });

    const body = await json<{ payment: PaymentSnapshot | null }>(
      await owner.get(`/api/shop/admin/orders/${read.order.id}`),
    );
    expect(body.payment).toMatchObject({ status: 'captured', amount: 5400 });
    expect(seen).toEqual(['pi_0001']);
  });

  it('cancel emits order.cancelled and records the acting owner', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`);
    expect(res.status).toBe(200);

    const body = await json<{ order: { status: string } }>(res);
    expect(body.order.status).toBe('cancelled');

    const events = await ctx.db.execute(
      sql`SELECT payload FROM commerce_events WHERE type = 'order.cancelled'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      reason: 'admin',
      actorId: ctx.users.owner.id,
    });
  });

  it('cancelling a cancelled order is a 409 precondition_failed, not a 500', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`);

    const again = await owner.post(`/api/shop/admin/orders/${read.order.id}/cancel`);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: 'precondition_failed', operation: 'cancel' });
  });

  it('over-fulfilling is a 409, not a 500 the client retries five times', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
      lines: [{ orderLineId: read.lines[0].id, qty: 3 }],
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'precondition_failed', operation: 'fulfill' });
  });

  it('shipping the last parcel settles the order and returns both', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const created = await json<{ fulfillment: { id: string } }>(
      await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
        lines: read.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
        carrier: 'DHL',
        trackingNumber: 'T1',
      }),
    );

    const shipped = await json<{
      fulfillment: { status: string };
      order: { status: string } | null;
    }>(
      await owner.patch(`/api/shop/admin/fulfillments/${created.fulfillment.id}`, {
        status: 'shipped',
      }),
    );
    expect(shipped.fulfillment.status).toBe('shipped');
    expect(shipped.order?.status).toBe('fulfilled');
  });

  it('shipping one of two parcels leaves the order paid, with no error', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const created = await json<{ fulfillment: { id: string } }>(
      await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
        lines: [{ orderLineId: read.lines[0].id, qty: 1 }],
      }),
    );
    const shipped = await json<{ order: unknown }>(
      await owner.patch(`/api/shop/admin/fulfillments/${created.fulfillment.id}`, {
        status: 'shipped',
      }),
    );
    expect(shipped.order).toBeNull();
    expect((await readOrder(ctx.db, read.order.id))!.order.status).toBe('paid');
  });

  it.each([
    ['a line from another order', { lines: [{ orderLineId: 'oln_nope', qty: 1 }] }],
    ['a zero quantity', { lines: [{ orderLineId: 'REPLACE', qty: 0 }] }],
    ['an unknown body key', { lines: [{ orderLineId: 'REPLACE', qty: 1 }], hurry: true }],
    ['no lines', { lines: [] }],
  ])('a fulfilment request with %s is a 400', async (_name, body) => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const patched = JSON.parse(JSON.stringify(body).replace('REPLACE', read.lines[0].id)) as object;
    const res = await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, patched);
    expect(res.status).toBe(400);
  });

  it('PATCH will not accept `pending` — an un-ship is not on offer', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const created = await json<{ fulfillment: { id: string } }>(
      await owner.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
        lines: [{ orderLineId: read.lines[0].id, qty: 1 }],
      }),
    );
    const res = await owner.patch(`/api/shop/admin/fulfillments/${created.fulfillment.id}`, {
      status: 'pending',
    });
    expect(res.status).toBe(400);
  });

  it('an unknown order is 404 on every admin route', async () => {
    const owner = await login(ctx.users.owner);
    expect((await owner.get('/api/shop/admin/orders/ord_nope')).status).toBe(404);
    expect(
      (await owner.post('/api/shop/admin/orders/ord_nope/fulfillments', {
        lines: [{ orderLineId: 'oln_x', qty: 1 }],
      })).status,
    ).toBe(404);
    expect((await owner.post('/api/shop/admin/orders/ord_nope/cancel')).status).toBe(404);
    expect(
      (await owner.patch('/api/shop/admin/fulfillments/ful_nope', { status: 'shipped' })).status,
    ).toBe(404);
  });
});

// =========================================================== finding one order

/**
 * `?search=` and `/admin/orders/by-number/:orderNumber` (HANDOFF §2 A4).
 *
 * Until these existed the only admin filter was `?status=`, so an operator
 * holding a customer's email or the number off their receipt had to page the
 * whole list to reach the order. Both branches are exact matches against an
 * index — the reasoning, including why no substring search is on offer, is in
 * `server/shop/admin/orders.ts`.
 */
describe('the admin order search', () => {
  /** An order for a named address, at a chosen instant. */
  async function orderFor(email: string, key: string, at: number): Promise<OrderRead> {
    await insertEvents(ctx.db, [
      {
        ...checkoutCompleted({ customerId: null, checkoutId: key, email }),
        id: `evt_${key}`,
        subjectId: key,
        occurredAt: at,
      },
    ]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    return (await readOrderByCheckout(ctx.db, key))!;
  }

  it('finds one order by its exact number', async () => {
    const mine = await paidOrder(CUSTOMER_A);
    await secondOrder(CUSTOMER_B);
    const owner = await login(ctx.users.owner);

    const body = await json<{ items: { order: { id: string } }[]; nextCursor: string | null }>(
      await owner.get(`/api/shop/admin/orders?search=${encodeURIComponent(mine.order.orderNumber)}`),
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].order.id).toBe(mine.order.id);
    expect(body.nextCursor).toBeNull();
  });

  it('finds a buyer’s orders by address, case-insensitively, and nobody else’s', async () => {
    // The fixture's address is `Buyer@Example.test`; the operator types it in
    // lower case, because that is how it appears in the email they were forwarded.
    const mine = await paidOrder(CUSTOMER_A);
    const theirs = await secondOrder(CUSTOMER_B);

    const owner = await login(ctx.users.owner);
    const body = await json<{ items: { order: { id: string; email: string } }[] }>(
      await owner.get('/api/shop/admin/orders?search=buyer%40example.test'),
    );
    expect(body.items.map((item) => item.order.id)).toEqual([mine.order.id]);
    expect(body.items.map((item) => item.order.id)).not.toContain(theirs.order.id);
  });

  it('a mistyped order number is a clean empty page, not a 400 and not the whole table', async () => {
    /*
     * THE DIFFERENCE FROM `/shop/orders/:orderNumber`, which answers 400 for the
     * same string. There the number IS the request, so a failed check character
     * means the request is malformed. Here it is a search term, and a box that
     * turns red because somebody pasted a truncated number is worse than one that
     * says "no orders". The term falls through to the address branch, where it
     * matches nothing — an indexed comparison, not a scan.
     */
    await paidOrder(CUSTOMER_A);
    await secondOrder(CUSTOMER_B);
    const owner = await login(ctx.users.owner);

    const good = formatOrderNumber(2026, 42);
    const typo = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const res = await owner.get(`/api/shop/admin/orders?search=${encodeURIComponent(typo)}`);
    expect(res.status).toBe(200);
    expect((await json<{ items: unknown[] }>(res)).items).toEqual([]);
  });

  it('an empty search is no filter at all, not a search for the empty string', async () => {
    // The rule `listProducts` applies to `?category=`: an empty string means "no
    // filter". A cleared search box must behave like no search box rather than
    // emptying the list the operator was reading.
    await paidOrder(CUSTOMER_A);
    await secondOrder(CUSTOMER_B);
    const owner = await login(ctx.users.owner);
    const body = await json<{ items: unknown[] }>(await owner.get('/api/shop/admin/orders?search='));
    expect(body.items).toHaveLength(2);
  });

  it('composes with the status filter', async () => {
    const paid = await paidOrder(CUSTOMER_A); // Buyer@Example.test, paid
    await orderFor('Buyer@Example.test', 'chk_same_buyer', T0 + 5); // pending
    const owner = await login(ctx.users.owner);

    const all = await json<{ items: unknown[] }>(
      await owner.get('/api/shop/admin/orders?search=buyer%40example.test'),
    );
    expect(all.items).toHaveLength(2);

    const onlyPaid = await json<{ items: { order: { id: string } }[] }>(
      await owner.get('/api/shop/admin/orders?search=buyer%40example.test&status=paid'),
    );
    expect(onlyPaid.items.map((item) => item.order.id)).toEqual([paid.order.id]);
  });

  it('walks a buyer’s orders page by page, no row twice', async () => {
    await orderFor('repeat@example.test', 'chk_rep_1', T0 + 1);
    await orderFor('repeat@example.test', 'chk_rep_2', T0 + 2);
    await orderFor('repeat@example.test', 'chk_rep_3', T0 + 3);
    await secondOrder(CUSTOMER_B);
    const owner = await login(ctx.users.owner);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const at: string | null = cursor;
      const url = `/api/shop/admin/orders?search=repeat%40example.test&limit=1${
        at ? `&cursor=${encodeURIComponent(at)}` : ''
      }`;
      const body: { items: { order: { id: string } }[]; nextCursor: string | null } = await json(
        await owner.get(url),
      );
      seen.push(...body.items.map((item) => item.order.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('a cursor from the unfiltered list is spendable on the search', async () => {
    /*
     * THIS IS WHAT MAKES THE DUPLICATED SORT KEY SAFE. `listOrders` keeps its
     * `SORT_KEY` private, so `server/shop/admin/orders.ts` carries a second copy
     * of the string `'placed'`. `requireCursor` refuses a cursor minted under any
     * other ordering with a 400 — so the moment the two stop agreeing, this case
     * goes red. The search is the same list with one more predicate, and a cursor
     * has to cross between them.
     */
    await orderFor('cross@example.test', 'chk_cross_1', T0 + 1);
    await orderFor('cross@example.test', 'chk_cross_2', T0 + 2);
    const owner = await login(ctx.users.owner);

    const first = await json<{ nextCursor: string | null }>(
      await owner.get('/api/shop/admin/orders?limit=1'),
    );
    expect(first.nextCursor).not.toBeNull();

    const res = await owner.get(
      `/api/shop/admin/orders?search=cross%40example.test&limit=1&cursor=${encodeURIComponent(
        first.nextCursor!,
      )}`,
    );
    expect(res.status).toBe(200);
  });

  it('an oversized term is a 400 that names the field', async () => {
    const owner = await login(ctx.users.owner);
    const res = await owner.get(`/api/shop/admin/orders?search=${'a'.repeat(400)}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'search' });
  });

  it('requires a session', async () => {
    await paidOrder(CUSTOMER_A);
    expect((await client().get('/api/shop/admin/orders?search=buyer%40example.test')).status).toBe(
      401,
    );
  });
});

describe('GET /admin/orders/by-number/:orderNumber', () => {
  it('answers with the same detail body as the id route', async () => {
    /*
     * It is also the assertion that the four-segment path is not shadowed by the
     * three-segment `/admin/orders/:id` registered above it — if it were, this
     * would be a lookup for an order whose id is literally "by-number" and a 404.
     */
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);

    const byNumber = await json<{ order: { id: string }; emails: unknown[]; payment: unknown }>(
      await owner.get(`/api/shop/admin/orders/by-number/${read.order.orderNumber}`),
    );
    const byId = await json<{ order: { id: string } }>(
      await owner.get(`/api/shop/admin/orders/${read.order.id}`),
    );

    expect(byNumber.order.id).toBe(read.order.id);
    expect(byNumber).toEqual(byId);
    expect(byNumber.emails).toHaveLength(1);
    expect(byNumber.payment).toBeNull();
  });

  it('a mistyped number is a 400 before any query runs', async () => {
    const owner = await login(ctx.users.owner);
    const good = formatOrderNumber(2026, 42);
    const typo = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const res = await owner.get(`/api/shop/admin/orders/by-number/${typo}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'orderNumber' });
  });

  it('a well-formed number nobody has is a 404', async () => {
    const owner = await login(ctx.users.owner);
    const res = await owner.get(
      `/api/shop/admin/orders/by-number/${formatOrderNumber(2026, 999_999)}`,
    );
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('requires a session — the number is guessable by construction', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const res = await client().get(`/api/shop/admin/orders/by-number/${read.order.orderNumber}`);
    expect(res.status).toBe(401);
  });
});

// ================================================================ the sweepers

describe('POST /admin/sweep is the caller both sweepers otherwise lack', () => {
  it('drains the outbox and hands the resulting mail to the mailer, in that order', async () => {
    /*
     * "A mechanism wired to no caller" is one of the three failure shapes contract §2 says
     * both previous gauntlets found in every round. This route is the caller. The ORDER is
     * asserted too: draining the outbox is what WRITES the email intents, so sweeping mail
     * first would always leave this sweep's own new mail for the next one.
     */
    const sent: RenderedEmail[] = [];
    const mailer: Mailer = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const owner = await login(ctx.users.owner, { mailer });

    // Nothing consumed yet: a completed checkout and its capture, straight into the outbox.
    await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);

    const body = await json<{
      events: { applied: number; ignored: number; parked: number };
      emails: { sent: number; failed: number; skipped: number };
    }>(await owner.post('/api/shop/admin/sweep'));

    expect(body.events.applied).toBe(2);
    // The confirmation the capture wrote, delivered in the SAME sweep.
    expect(body.emails.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('confirmed');

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('paid');
  });

  it('is owner-only: a writer is refused', async () => {
    const writer = await login(ctx.users.writer);
    expect((await writer.post('/api/shop/admin/sweep')).status).toBe(403);
    expect((await client().post('/api/shop/admin/sweep')).status).toBe(401);
  });

  it('a broken mailer leaves the order paid and the sweep reporting the failure', async () => {
    const mailer: Mailer = { send: () => Promise.reject(new Error('provider down')) };
    const owner = await login(ctx.users.owner, { mailer });
    await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);

    const body = await json<{ emails: { sent: number; failed: number } }>(
      await owner.post('/api/shop/admin/sweep'),
    );
    expect(body.emails).toMatchObject({ sent: 0, failed: 1 });
    // The whole point of brief §5: the money is recorded whatever the mail provider does.
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.status).toBe('paid');
  });

  it('is idempotent: a second sweep finds nothing', async () => {
    const owner = await login(ctx.users.owner);
    await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
    await owner.post('/api/shop/admin/sweep');

    const second = await json<{
      events: { applied: number; parked: number };
      emails: { sent: number };
    }>(await owner.post('/api/shop/admin/sweep'));
    // `order.created` from the first sweep is declined, so `ignored` moves and nothing else.
    expect(second.events.applied).toBe(0);
    expect(second.events.parked).toBe(0);
    expect(second.emails.sent).toBe(0);
  });
});

// ================================================================ the mounting

describe('mounting these routes changes nothing else about the app', () => {
  it('an unrouted path is still 404, not 401', async () => {
    /*
     * The property `server/routes/posts.ts` records as MEASURED: `app.route('/api', …)`
     * flattens a router into its parent, so `requireAuth()` attached as `use('*')` inside
     * one becomes `use('/api/*')` and refuses paths it has never heard of. Attached per
     * route it cannot leak, and this is the assertion that says so.
     */
    const res = await client().get('/api/shop/nothing-here');
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('the blog routes still behave', async () => {
    const owner = await login(ctx.users.owner);
    expect((await owner.get('/api/posts')).status).toBe(200);
    expect((await client().get('/api/health')).status).toBe(200);
  });

  it('a cross-origin write is still refused before anything is read', async () => {
    const read = await paidOrder(CUSTOMER_A);
    const owner = await login(ctx.users.owner);
    const res = await owner.post(
      `/api/shop/admin/orders/${read.order.id}/cancel`,
      {},
      { headers: { origin: 'https://evil.test' } },
    );
    expect(res.status).toBe(403);
  });

  it('every response carries a request id', async () => {
    const res = await client().get('/api/shop/orders/2026-000042-K');
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
  });
});
