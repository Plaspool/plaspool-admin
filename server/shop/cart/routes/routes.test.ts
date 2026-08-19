/**
 * The storefront, driven through the whole stack.
 *
 * Through `httpClient` and a real `createApp()` rather than by calling repo
 * functions, because the seam between the repository and HTTP is what these
 * routes ADD and therefore where their defects are — router, origin guard,
 * session middleware, error handler, cookie jar. `server/test/http.ts` says the
 * same thing about the blog's route suites.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables, SEED_PASSWORD } from '../test/harness';
import { standaloneShop } from '../test/standalone';
import { httpClient, json } from '../../../test/http';
import { CART_COOKIE } from '../identity/cookies';
import { signAssertion } from '../identity/bridge';
import { shopCartRoutes } from './index';
import { mapsShopErrors } from './errors';
import { CART_CREATE_LIMIT } from '../limits';
import { SHOP_CURRENCY } from '../../currency';
import { seedSellable } from '../../catalog/test/catalog-harness';
import { unpublishProduct } from '../../catalog/products';
import type { HttpClient } from '../../../test/http';
import type { TestCtx } from '../test/harness';
import type { Assertion } from '../identity/bridge';

let ctx: TestCtx;
let client: HttpClient;
/** Real, published, priced variants — `server/shop/app.ts` injects the real port. */
let tee: { id: string; productId: string };
let scarce: { id: string; productId: string };

const CURRENCY = SHOP_CURRENCY;

const UK = {
  name: 'A Shopper',
  line1: '1 High Street',
  city: 'London',
  countryCode: 'GB',
};

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  await ctx.db.execute(sql`TRUNCATE auth_attempts`);
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_inventory_holds CASCADE`);

  /*
   * REAL CATALOG ROWS, and no `mountShopCart`. `server/shop/app.ts` mounts the
   * cart router with the real `CatalogPort`, and `createApp()` mounts that — so
   * `httpClient(db)` already serves `/api/shop/...`. Mounting a second router
   * here would not override it: Hono resolves two routers claiming one path by
   * registration order, so the app's own mount wins and a test would believe it
   * had injected a fake while exercising the real one. That is not hypothetical;
   * it is what these six tests did until they went red.
   */
  tee = (
    await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Navy Tee',
      onHand: 10,
      amount: 1999,
      currency: CURRENCY,
    })
  ).variant;
  scarce = (
    await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Nearly gone',
      onHand: 1,
      amount: 500,
      currency: CURRENCY,
    })
  ).variant;
  client = httpClient(ctx.db);
});

/** Catalog's counter, read straight out of its table. */
async function reservedOf(variantId: string): Promise<number> {
  const res = await ctx.db.execute(sql`
    SELECT reserved FROM shop_inventory WHERE variant_id = ${variantId}`);
  return Number(res.rows[0].reserved);
}

/** Every request carries an IP, so the per-IP buckets are per test, not shared. */
const ip = (value: string) => ({ headers: { 'x-real-ip': value } });

interface CartView {
  cart: { id: string; revision: number; status: string; currency: string } | null;
  lines: Array<{
    id: string;
    variantId: string;
    qty: number;
    available: boolean;
    title: string | null;
  }>;
  preview: { grandTotal: { amount: number } } | null;
  changes: unknown[];
}

async function newCart(): Promise<CartView> {
  const res = await client.post('/api/shop/cart', undefined, ip('10.0.0.1'));
  expect(res.status).toBe(201);
  return json<CartView>(res);
}

describe('POST /api/shop/cart', () => {
  it('creates a cart, sets the cookie, and needs no identity at all', async () => {
    const view = await newCart();
    expect(view.cart?.status).toBe('open');
    expect(view.cart?.currency).toBe(CURRENCY);
    expect(client.cookies().get(CART_COOKIE)).toBe(view.cart?.id);
  });

  it('ADOPTS the cookie rather than stranding the basket', async () => {
    /*
     * A double-submitted "start shopping" must not leave the first basket
     * behind. The shopper would watch their items vanish with no explanation,
     * which is the worst version of every failure in this brief.
     */
    const first = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });

    const res = await client.post('/api/shop/cart', undefined, ip('10.0.0.1'));
    expect(res.status).toBe(200);
    const second = await json<CartView>(res);
    expect(second.cart?.id).toBe(first.cart?.id);
    expect(second.lines).toHaveLength(1);
  });

  it('is rate limited per IP', async () => {
    for (let i = 0; i < CART_CREATE_LIMIT; i += 1) {
      client.clearCookies();
      expect((await client.post('/api/shop/cart', undefined, ip('10.9.9.9'))).status).toBe(201);
    }
    client.clearCookies();
    const res = await client.post('/api/shop/cart', undefined, ip('10.9.9.9'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('GET /api/shop/cart', () => {
  it('answers `cart: null` for a browser that has never had one — and WRITES NOTHING', async () => {
    // A GET that created a row would make every crawler and every prefetch a
    // cart, and would put the rate limiter on the page a shopper loads most.
    const res = await client.get('/api/shop/cart');
    expect(res.status).toBe(200);
    expect((await json<CartView>(res)).cart).toBeNull();
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_carts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('resolves lines through CatalogPort and previews a total', async () => {
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 2 });

    const view = await json<CartView>(await client.get('/api/shop/cart'));
    expect(view.lines[0]).toMatchObject({
      variantId: tee.id,
      qty: 2,
      available: true,
      title: 'Navy Tee',
    });
    // The preview is not the price — no address yet, so the named zero rate.
    expect(view.preview?.grandTotal.amount).toBe(3998);
  });

  it('RENDERS an unresolvable line rather than dropping it, and shows no total', async () => {
    /*
     * Brief §3: "render an unresolvable line as 'no longer available' rather
     * than dropping it. A line that vanishes with no explanation is the worst
     * version of this." And there is no honest total for a basket holding
     * something that cannot be priced, so the preview is null rather than a
     * number that will change.
     */
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    // Through Catalog's real lifecycle: "sellable" is Catalog's predicate, and
    // this is the test that proves Cart asks the right question.
    await unpublishProduct(ctx.db, tee.productId, ctx.users.owner);

    const view = await json<CartView>(await client.get('/api/shop/cart'));
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].available).toBe(false);
    expect(view.lines[0].title).toBeNull();
    expect(view.preview).toBeNull();
  });
});

describe('line mutations', () => {
  it('adds, changes and removes', async () => {
    await newCart();
    const added = await json<CartView>(
      await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 }),
    );
    const lineId = added.lines[0].id;

    const patched = await json<CartView>(
      await client.patch(`/api/shop/cart/lines/${lineId}`, { qty: 4 }),
    );
    expect(patched.lines[0].qty).toBe(4);

    const removed = await json<CartView>(
      await client.del(`/api/shop/cart/lines/${lineId}`),
    );
    expect(removed.lines).toHaveLength(0);
  });

  it('answers 409 `stale_write` carrying the current cart when the revision has moved', async () => {
    const view = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });

    const res = await client.post('/api/shop/cart/lines', {
      variantId: scarce.id,
      qty: 1,
      baseRevision: view.cart?.revision,
    });

    expect(res.status).toBe(409);
    const body = await json<{ error: string; expected: number; actual: number; cart: { revision: number } }>(res);
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(1);
    expect(body.actual).toBe(2);
    // The current cart rides along so the client re-renders with no second
    // request — the same property the post path's 409 has.
    expect(body.cart.revision).toBe(2);
  });

  it('404s a line id belonging to somebody else’s cart', async () => {
    await newCart();
    const mine = await json<CartView>(
      await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 }),
    );

    client.clearCookies();
    await client.post('/api/shop/cart', undefined, ip('10.0.0.2'));
    const res = await client.del(`/api/shop/cart/lines/${mine.lines[0].id}`);

    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('gone');
  });

  it('400s an unknown body key rather than ignoring it', async () => {
    await newCart();
    const res = await client.post('/api/shop/cart/lines', {
      variantId: tee.id,
      qty: 1,
      price: 1,
    });
    expect(res.status).toBe(400);
    expect((await json<{ detail: string }>(res)).detail).toBe('price');
  });

  it('400s a NUL byte in a path segment rather than 500ing on 22021', async () => {
    // Postgres `text` cannot hold U+0000 and spec §8 has no row for 22021, so
    // untranslated it is a 500 the client retries five times for input that can
    // never be accepted.
    await newCart();
    const res = await client.del('/api/shop/cart/lines/%00');
    expect(res.status).toBe(400);
  });

  it('400s it WITH NO CART COOKIE too, not 404', async () => {
    /*
     * The regression `server/nul-bytes.test.ts` found the moment these routes
     * were mounted into the real app. The handler used to resolve the cart
     * before reading `:id`, so a caller with no cart cookie got 404 — the wrong
     * answer to the wrong question, and one Cart's own suite could never see
     * because it always had a cart in hand.
     *
     * Both statuses stop the client's retry policy, so this was never a 500
     * hazard; it was a route answering "you have no cart" to a request that was
     * malformed on its face.
     */
    client.clearCookies();
    expect((await client.del('/api/shop/cart/lines/%00')).status).toBe(400);
    expect((await client.patch('/api/shop/cart/lines/%00', { qty: 1 })).status).toBe(400);
  });
});

describe('the checkout flow, end to end', () => {
  it('start → addresses → shipping → freeze', async () => {
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 2 });

    const started = await client.post('/api/shop/checkout/start');
    expect(started.status).toBe(200);
    expect((await json<{ reservations: unknown[] }>(started)).reservations).toHaveLength(1);
    expect(await reservedOf(tee.id)).toBe(2);

    const addressed = await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: UK }),
    });
    expect(addressed.status).toBe(200);
    const zoneBody = await json<{ zone: string; options: Array<{ id: string }> }>(addressed);
    expect(zoneBody.zone).toBe('domestic');
    expect(zoneBody.options.map((o) => o.id)).toEqual(['standard', 'express']);

    const shipped = await client.request('/api/shop/checkout/shipping', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'standard' }),
    });
    expect(shipped.status).toBe(200);

    const frozen = await client.post('/api/shop/checkout/freeze');
    expect(frozen.status).toBe(200);
    const totals = (await json<{ totals: { grandTotal: { amount: number } } }>(frozen)).totals;
    expect(totals.grandTotal.amount).toBe(3998 + 399 + 880);

    // And the frozen number is what a re-render sees.
    const reread = await client.get('/api/shop/checkout/totals');
    expect((await json<{ totals: typeof totals }>(reread)).totals).toEqual(totals);
  });

  it('409s a shortfall WITH THE NUMBER', async () => {
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: scarce.id, qty: 5 });

    const res = await client.post('/api/shop/checkout/start');

    expect(res.status).toBe(409);
    const body = await json<{ error: string; shortfalls: unknown[] }>(res);
    expect(body.error).toBe('insufficient_stock');
    expect(body.shortfalls).toEqual([
      { variantId: scarce.id, requested: 5, available: 1 },
    ]);
  });

  it('409s a freeze whose line has become unavailable, naming the variant', async () => {
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: UK }),
    });
    // Through Catalog's real lifecycle: "sellable" is Catalog's predicate, and
    // this is the test that proves Cart asks the right question.
    await unpublishProduct(ctx.db, tee.productId, ctx.users.owner);

    const res = await client.post('/api/shop/checkout/freeze');
    expect(res.status).toBe(409);
    const body = await json<{ error: string; variantIds: string[] }>(res);
    expect(body.error).toBe('unavailable_lines');
    expect(body.variantIds).toEqual([tee.id]);
  });

  it('400s a lowercase country code before it can pick the wrong tax zone', async () => {
    await newCart();
    const res = await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: { ...UK, countryCode: 'gb' } }),
    });
    expect(res.status).toBe(400);
  });

  it('404s the whole flow for a browser with no cart', async () => {
    expect((await client.post('/api/shop/checkout/start')).status).toBe(404);
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(404);
  });
});

describe('the maintenance cron route', () => {
  it('is refused to an anonymous caller', async () => {
    // Sweeping reaches `CatalogPort` once per expired hold, so an anonymous
    // caller could turn it into an amplifier. Contract §10 puts admin routes
    // under `/api/shop/admin/*` behind `requireAuth()`.
    const res = await client.post('/api/shop/admin/cart/maintenance');
    expect(res.status).toBe(401);
  });

  it('runs for a signed-in writer and reports what it could NOT release', async () => {
    await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });

    const res = await client.post('/api/shop/admin/cart/maintenance');
    expect(res.status).toBe(200);
    // `failed` is reported rather than swallowed: a non-zero value means stock
    // is held for checkouts that are over, and this is the only signal saying so.
    /*
     * `ignored: 2` is the two `catalog.variant.published` events `seedSellable`
     * emitted — a free demonstration of contract §6 rule 4 on real data from
     * another subsystem: Cart reads them, recognises they are not its business,
     * and records that rather than throwing or parking them.
     */
    expect(await json<{ drain: { scanned: number }; sweep: { released: number } }>(res))
      .toEqual({
        drain: { scanned: 2, applied: 0, ignored: 2, parked: 0, abandoned: 0 },
        sweep: { released: 0, failed: 0 },
        passes: 2,
        exhausted: false,
      });
  });
});

describe('every route maps this subsystem’s errors', () => {
  it('has no unwrapped handler — checked mechanically, not by convention', () => {
    /*
     * THE GUARD THAT STOPS THE NEXT ROUTE BEING THE ONE THAT 500s.
     *
     * `CartStaleWriteError` and `CartPreconditionError` have to become 409s, and
     * the mapping cannot be a middleware: Hono's `compose` calls the app's
     * `onError` at the frame that threw, so an error never reaches an enclosing
     * `await next()` — measured with a three-line Hono app, and the reason the
     * first version of this suite saw a 500 where it expected a 409.
     *
     * The mapping is therefore applied per handler by `mapErrors()`. A per-route
     * wrapper is exactly the kind of thing the NEXT route forgets, so this walks
     * the registered table instead of trusting anyone to remember.
     */
    const app = shopCartRoutes();
    expect(app.routes.length).toBeGreaterThan(10);
    const unwrapped = app.routes
      .filter((route) => !mapsShopErrors(route.handler))
      .map((route) => `${route.method} ${route.path}`);
    expect(unwrapped).toEqual([]);
  });

  it('turns a repo-level precondition into a 409 rather than a 500', async () => {
    // The end-to-end version of the same property, through the real stack.
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: UK }),
    });
    await client.post('/api/shop/checkout/freeze');

    // The cart is `converting` now, so a line write is refused, not raced.
    const res = await client.post('/api/shop/cart/lines', { variantId: scarce.id, qty: 1 });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; cart: { status: string } }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('add_line');
    expect(body.cart.status).toBe('converting');
  });

  // --- customer session exchange -------------------------------------------

  const BRIDGE_SECRET = 'c'.repeat(32);

  function assertionFor(email: string, over: Partial<Assertion> = {}): string {
    const now = Date.now();
    return signAssertion(BRIDGE_SECRET, {
      v: 1,
      sub: '11111111-2222-3333-4444-555555555555',
      email,
      iat: now,
      exp: now + 60_000,
      jti: `jti-${Math.random().toString(36).slice(2)}`,
      ...over,
    });
  }

  it('exchanges a good assertion for a session cookie, and never leaks the token', async () => {
    const wired = standaloneShop(ctx.db, { bridgeSecret: BRIDGE_SECRET });
    const res = await wired.request('/customer/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: assertionFor('buyer@example.com') }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toMatch(/__Host-shop_session=/);
    const token = setCookie?.match(/__Host-shop_session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();

    // The body says nothing about the session's own credential — the same
    // property the old magic-link route's "never leaks the token" test held.
    // The exchange answers `{ customer }`, and the failure this guards
    // against is someone adding `session`/`token` to that body for storefront
    // convenience: every other assertion here would still pass while a
    // cross-site page gained JS-readable access to a credential HttpOnly
    // exists to keep out of reach.
    const bodyText = await res.text();
    expect(bodyText).not.toContain(token);

    const body = JSON.parse(bodyText) as { customer: { email: string } };
    expect(body.customer.email).toBe('buyer@example.com');
  });

  it('is the same customer on a second, independent sign-in', async () => {
    const wired = standaloneShop(ctx.db, { bridgeSecret: BRIDGE_SECRET });
    const request = (assertion: string) =>
      wired.request('/customer/session/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assertion }),
      });

    const one = await json<{ customer: { id: string } }>(
      await request(assertionFor('repeat@example.com')),
    );
    const two = await json<{ customer: { id: string } }>(
      await request(assertionFor('repeat@example.com')),
    );
    expect(two.customer.id).toBe(one.customer.id);
  });

  it('refuses a replayed assertion, indistinguishably from a bad MAC', async () => {
    const wired = standaloneShop(ctx.db, { bridgeSecret: BRIDGE_SECRET });
    const request = (assertion: string) =>
      wired.request('/customer/session/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assertion }),
      });

    const raw = assertionFor('replay@example.com');
    expect((await request(raw)).status).toBe(200);

    const replayed = await request(raw);
    const forged = await request(
      signAssertion('d'.repeat(32), {
        v: 1,
        sub: 'x',
        email: 'a@b.c',
        iat: Date.now(),
        exp: Date.now() + 60_000,
        jti: 'jti-forged',
      }),
    );

    expect(replayed.status).toBe(400);
    expect(await json(replayed)).toEqual(await json(forged));
  });

  it('names an expired assertion distinctly, because the client can re-mint', async () => {
    const wired = standaloneShop(ctx.db, { bridgeSecret: BRIDGE_SECRET });
    const res = await wired.request('/customer/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: assertionFor('late@example.com', { exp: Date.now() - 1 }) }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ detail: string }>(res)).detail).toBe('assertion_expired');
  });

  it('501s when no bridge secret is configured', async () => {
    // `bridgeSecret: undefined` EXPLICITLY, rather than relying on the ambient
    // test environment having no `SHOP_AUTH_BRIDGE_SECRET` set. Relying on the
    // ambient value would make this pass today and fail for anyone who has
    // that variable in a local `.env`, for a reason unrelated to the route.
    const wired = standaloneShop(ctx.db, { bridgeSecret: undefined });
    const res = await wired.request('/customer/session/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: assertionFor('nobody@example.com') }),
    });
    expect(res.status).toBe(501);
    expect((await json<{ feature: string }>(res)).feature).toBe('identity-bridge');

    // And nothing was written on the way to refusing — pinned exactly as the
    // old magic-link 501 test pinned it, so a future reorder that resolved
    // the customer before the config check would fail here rather than
    // silently starting to write rows for an unconfigured deployment.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_customers`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('no longer serves the retired magic-link routes', async () => {
    expect((await client.post('/api/shop/customer/session', { email: 'a@b.c' })).status).toBe(404);
    expect((await client.post('/api/shop/customer/session/redeem', { token: 'x' })).status).toBe(404);
  });
});

describe('the storefront never demands an account', () => {
  it('completes a whole guest checkout with no customer session at all', async () => {
    // Contract §7: "Guest checkout is the default path. Do not require an
    // account to buy." Asserted by doing it.
    await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await client.post('/api/shop/checkout/start');
    await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: UK }),
    });
    await client.request('/api/shop/checkout/shipping', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'standard' }),
    });
    const frozen = await client.post('/api/shop/checkout/freeze');

    expect(frozen.status).toBe(200);
    const carts = await ctx.db.execute(sql`SELECT customer_id FROM shop_carts`);
    expect(carts.rows[0].customer_id).toBeNull();
  });
});
