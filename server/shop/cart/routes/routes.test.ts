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
import { freshDb, resetShopTables } from '../test/harness';
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

/*
 * A NIGERIAN ADDRESS, for the checkout-flow test below. That test runs
 * through the REAL app (`createApp()`), which now reads shipping zones from
 * the database (admin#19) rather than from `deps.zones` — so a `GB` address
 * falls to the same-country-only-fallback zone rather than exercising a
 * distinct "domestic" zone the way it used to under the UK scaffolding.
 * Lagos is used because it names a region, exercising the region match added
 * alongside the zone rewrite.
 */
const LAGOS = {
  name: 'A Shopper',
  line1: '1 Broad Street',
  city: 'Lagos',
  region: 'Lagos',
  countryCode: 'NG',
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

describe('a cart that has become an order stops being this browser’s basket', () => {
  /*
   * ═══ THE BUG THIS SUITE MISSED, FOUND IN A BROWSER ═══
   *
   * `converted` is terminal — `cart/repo.ts` gives it no outgoing edge — but
   * nothing retired the cookie naming it. So after a successful checkout the
   * storefront went on drawing the paid-for basket forever: `GET /cart`
   * answered the dead cart with its lines and a live price preview, every line
   * write was correctly refused with `409 precondition_failed` so "Remove" did
   * nothing, and checkout could not start again. `clearCartCookie` had existed
   * for exactly this and had never been called from anywhere in the server.
   *
   * Reported from production with the 409 body in hand:
   *   {"error":"precondition_failed","operation":"remove_line",
   *    "cart":{"status":"converted", ...}}
   *
   * These tests drive the cookie jar, not the repo, because the cookie IS the
   * defect — a repo-level assertion would have passed throughout.
   */
  async function convert(): Promise<string> {
    const view = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    const id = view.cart!.id;
    /* Straight to the terminal state. The route's contract is "a cart in this
       status is not a basket", and how it got there — capture, or the sweep
       marking it abandoned — is not this seam's business. */
    await ctx.db.execute(sql`UPDATE shop_carts SET status = 'converted' WHERE id = ${id}`);
    return id;
  }

  it('answers an EMPTY basket and retires the cookie', async () => {
    await convert();

    const res = await client.get('/api/shop/cart');
    expect(res.status).toBe(200);
    const view = await json<CartView>(res);
    expect(view.cart).toBeNull();
    expect(view.lines).toEqual([]);
    // The cookie is gone, so the next request does not re-find it.
    expect(client.cookies().get(CART_COOKIE)).toBeFalsy();
  });

  it('does not leave the shopper holding a basket they cannot empty', async () => {
    /*
     * The symptom that was reported. The line write must not answer 409
     * `precondition_failed` — by the time it is reached there is no cart to
     * refuse a write on, because the read above already cleared the cookie.
     */
    await convert();
    await client.get('/api/shop/cart');

    const res = await client.del('/api/shop/cart/lines/line_whatever');
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).not.toBe('precondition_failed');
  });

  it('gives the next add a genuinely new cart rather than reviving the order', async () => {
    const dead = await convert();

    const res = await client.post('/api/shop/cart', undefined, ip('10.0.0.2'));
    expect(res.status).toBe(201);
    const fresh = await json<CartView>(res);
    expect(fresh.cart?.id).not.toBe(dead);
    expect(fresh.cart?.status).toBe('open');
    expect(fresh.lines).toEqual([]);
    // And the cookie now names the NEW cart — the clear must not outlive it.
    expect(client.cookies().get(CART_COOKIE)).toBe(fresh.cart?.id);
  });

  it('leaves a cart mid-payment alone', async () => {
    /*
     * `converting` is a cart whose shopper is on the payment page. A failed
     * payment sends it back to `open` and they still have their basket, so
     * retiring the cookie here would throw away a live checkout.
     */
    const view = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await ctx.db.execute(
      sql`UPDATE shop_carts SET status = 'converting' WHERE id = ${view.cart!.id}`,
    );

    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.id).toBe(view.cart?.id);
    expect(after.lines).toHaveLength(1);
    expect(client.cookies().get(CART_COOKIE)).toBe(view.cart?.id);
  });

  it('treats an abandoned cart the same way', async () => {
    const view = await newCart();
    await ctx.db.execute(
      sql`UPDATE shop_carts SET status = 'abandoned' WHERE id = ${view.cart!.id}`,
    );

    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart).toBeNull();
    expect(client.cookies().get(CART_COOKIE)).toBeFalsy();
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
      body: JSON.stringify({ shipping: LAGOS }),
    });
    expect(addressed.status).toBe(200);
    const zoneBody = await json<{ zone: string; options: Array<{ id: string }> }>(addressed);
    expect(zoneBody.zone).toBe('zone_lagos');
    expect(zoneBody.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['ship_lagos_standard']),
    );

    const shipped = await client.request('/api/shop/checkout/shipping', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'ship_lagos_standard' }),
    });
    expect(shipped.status).toBe(200);

    const frozen = await client.post('/api/shop/checkout/freeze');
    expect(frozen.status).toBe(200);
    const totals = (await json<{ totals: { grandTotal: { amount: number } } }>(frozen)).totals;
    // 2 x ₦19.99-in-old-units item price (1999) + ₦10,000 Lagos delivery
    // (1_000_000 minor units) + 7.5% VAT on the goods (migration 0560 — the
    // owner's registered-for-VAT decision; delivery stays untaxed, per the
    // zones' own shipping_taxable). 0.075 × 3998 = 299.85, half-up 300.
    expect(totals.grandTotal.amount).toBe(3998 + 1_000_000 + 300);

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

  it('409s an empty cart with a READABLE reason, not just the operation name', async () => {
    /*
     * ═══ THE FIELD THAT WAS DOING TWO JOBS ═══
     * `operation` names the OPERATION everywhere in this server — `update_cart`,
     * `remove_line`, `capture`, `parseWebhook` — except in the freeze route,
     * which passes its REASON through the same key. The storefront was written
     * against that second sense, so it read `operation: 'empty_cart'` and had
     * no idea what `operation: 'checkout_start'` meant. An empty cart at step 1
     * of 4 therefore rendered as "That didn't go through. Try again — if it
     * keeps happening, come back later."
     *
     * `reason` is additive and unambiguous: `operation` keeps naming the
     * operation, for every consumer already reading it, and the refusal now
     * also says WHY in a field that only ever means why.
     */
    await newCart();

    const res = await client.post('/api/shop/checkout/start');

    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; reason: string }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.reason).toBe('empty_cart');
    // Unchanged, deliberately: this is an addition, not a rename.
    expect(body.operation).toBe('checkout_start');
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

  /*
   * THE ROUTING CITY IS ACCEPTED AND IS NEVER REQUIRED (migration 1020).
   *
   * `Address` is `.strict()`, so this route is the feature flag for the wire
   * shape — the storefront may only send a key the server already knows. And
   * the public config that advertises it is cached 60s with 300s
   * stale-while-revalidate, so for up to SIX MINUTES a storefront can be
   * rendering a form that has never heard of the field. A required
   * `routingCity` would 400 every one of those submissions. Same discipline
   * `district` has followed since 0460.
   */
  it('takes a routing city, and takes an address without one', async () => {
    await newCart();
    const put = (shipping: unknown) =>
      client.request('/api/shop/checkout/addresses', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shipping }),
      });

    expect((await put({ ...LAGOS, routingCity: 'Ikeja' })).status).toBe(200);
    const stored = await ctx.db.execute(
      sql`SELECT routing_city FROM shop_addresses WHERE kind = 'shipping'`,
    );
    expect(String(stored.rows[0].routing_city)).toBe('Ikeja');

    // Absent is legal, and it CLEARS — the storefront that stops sending the
    // field must not leave the abandoned zone attached to the new address.
    expect((await put(LAGOS)).status).toBe(200);
    const cleared = await ctx.db.execute(
      sql`SELECT routing_city FROM shop_addresses WHERE kind = 'shipping'`,
    );
    expect(cleared.rows[0].routing_city).toBeNull();

    // Explicit null is legal too — one shape for "no zone named".
    expect((await put({ ...LAGOS, routingCity: null })).status).toBe(200);
  });

  it('404s the whole flow for a browser with no cart', async () => {
    expect((await client.post('/api/shop/checkout/start')).status).toBe(404);
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(404);
  });
});

/**
 * BACKING OUT OF PAYMENT — through the real `createApp()`, which is the only
 * place the Payments→Cart port is actually wired.
 *
 * CLAUDE.md §2's rule, applied: Cart's own suites inject their own fake port
 * and would stay green if `server/shop/app.ts` never passed the real one. These
 * do not. Deleting the `payments: checkoutPaymentsPort` line turns every test
 * below into a 501, which is the failure mode admin#27 cost an order to learn.
 */
describe('a shopper who reaches the payment page and does not pay', () => {
  /** A cart taken to `converting`, exactly as the storefront takes it. */
  async function frozen(): Promise<{ id: string; revision: number }> {
    const view = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: LAGOS }),
    });
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(200);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('converting');
    return { id: view.cart!.id, revision: after.cart!.revision };
  }

  /** A payment intent in whatever state, written straight into Payments' table. */
  async function intent(checkoutId: string, status: string): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
         refunded_total, created_at, updated_at, revision)
      VALUES (${`pi_${status}_${checkoutId}`}, ${checkoutId}, 1000, ${CURRENCY}, ${status},
              ${`key_${status}_${checkoutId}`}, 'fp', 0, 1, 1, 1)`);
  }

  it('gets their basket back — POST /checkout/cancel reopens the cart', async () => {
    const cart = await frozen();

    const res = await client.post('/api/shop/checkout/cancel');

    expect(res.status).toBe(200);
    const body = await json<{ cart: { status: string; revision: number } }>(res);
    expect(body.cart.status).toBe('open');
    expect(body.cart.revision).toBeGreaterThan(cart.revision);

    // And the basket really is usable again — the line write that was refused
    // while it was converting now succeeds.
    expect((await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 })).status)
      .toBe(201);
  });

  it('CANCELS the pending intent on the way out', async () => {
    const cart = await frozen();
    await intent(cart.id, 'requires_payment');

    expect((await client.post('/api/shop/checkout/cancel')).status).toBe(200);

    const after = await ctx.db.execute(sql`
      SELECT status FROM shop_payment_intents WHERE checkout_id = ${cart.id}`);
    expect(after.rows[0]?.status).toBe('cancelled');
  });

  it('REFUSES to reopen a checkout that was actually paid', async () => {
    /*
     * The cart is `converting` and an intent is `captured` — the shape a
     * capture leaves behind when the inline completion did not run
     * (`completeCheckoutForIntent` names three ways). It needs the sweep, which
     * will turn it into an order, NOT a thaw that would let the shopper edit
     * the address the order is about to be built from.
     */
    const cart = await frozen();
    await intent(cart.id, 'captured');

    const res = await client.post('/api/shop/checkout/cancel');

    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('checkout_paid');
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('converting');
  });

  it('EDITING THE ADDRESS is enough — the 409 the shopper actually hit is gone', async () => {
    /*
     * ═══ THE ORIGINAL BUG, END TO END ═══
     *
     * `PUT /checkout/addresses` on a frozen cart answered
     * `409 precondition_failed / operation: update_cart` on every attempt, for
     * ever, and nothing in the application could clear it. A shopper correcting
     * a mistyped street was locked out of their own basket permanently.
     */
    const cart = await frozen();
    await intent(cart.id, 'requires_payment');

    const res = await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: { ...LAGOS, line1: '2 Broad Street' } }),
    });

    expect(res.status).toBe(200);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('open');
    // The new address is stored, and the old payment is no longer live.
    const stored = await ctx.db.execute(sql`
      SELECT line1 FROM shop_addresses WHERE cart_id = ${cart.id} AND kind = 'shipping'`);
    expect(stored.rows[0]?.line1).toBe('2 Broad Street');
    // Re-freezing from here is what the shopper does next, and it works.
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(200);
  });

  it('is idempotent — a second cancel is a 200, not a conflict', async () => {
    // The storefront fires this from a back button, a link and a `beforeunload`
    // without tracking which of them already ran.
    await frozen();
    expect((await client.post('/api/shop/checkout/cancel')).status).toBe(200);
    const second = await client.post('/api/shop/checkout/cancel');
    expect(second.status).toBe(200);
    expect((await json<{ cart: { status: string } }>(second)).cart.status).toBe('open');
  });

  it('404s a browser with no cart at all, rather than inventing one', async () => {
    const res = await client.post('/api/shop/checkout/cancel');
    expect(res.status).toBe(404);
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SAME DEAD END, REACHED FROM THE BASKET INSTEAD OF THE CHECKOUT PAGE.
   *
   * Every test above recovers a shopper who is still ON the checkout page. The
   * one who is not — handed off to Paystack, did not pay, came back to the shop
   * and opened the cart drawer — had no recovery anywhere:
   *
   *   - the three line writes are guarded on `status = 'open'` and answered
   *     `409 precondition_failed` for ever, naming only the operation refused;
   *   - `LIVE_STATUSES` keeps handing the frozen basket back to the cookie, so
   *     it does not clear itself the way a `converted` cart does;
   *   - `POST /cart` returns the cart that already exists rather than a fresh
   *     one, so "start again" returns the same dead basket.
   *
   * The storefront's two thaw triggers both miss this journey by design:
   * `pagehide` deliberately skips the Paystack hand-off (thawing there would
   * unfreeze the cart in the same breath as sending the shopper to pay), and
   * `pageshow` only fires on a bfcache Back. Reported from production on
   * 2026-09-07 by a shopper whose basket had been unusable since the previous
   * day.
   *
   * EDITING THE BASKET IS BACKING OUT OF PAYMENT, said in the only vocabulary a
   * cart drawer has — the same sentence `putAddresses` already makes about an
   * address, and the reason `makeEditable` was written to be shared rather than
   * inlined into the checkout routes.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('takes an item OUT of a frozen basket, thawing it on the way', async () => {
    await frozen();
    const lineId = (await json<CartView>(await client.get('/api/shop/cart'))).lines[0]!.id;

    const res = await client.del(`/api/shop/cart/lines/${lineId}`);

    expect(res.status).toBe(200);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('open');
    expect(after.lines).toHaveLength(0);
  });

  it('puts an item INTO a frozen basket, thawing it on the way', async () => {
    await frozen();

    const res = await client.post('/api/shop/cart/lines', { variantId: scarce.id, qty: 1 });

    expect(res.status).toBe(201);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('open');
    expect(after.lines).toHaveLength(2);
  });

  it('chains off the revision the THAW produced, not the one the shopper held', async () => {
    /*
     * ═══ THE TEST THE OTHERS WERE HIDING ═══
     *
     * The storefront sends `baseRevision: cart.revision` on every line write
     * (`packages/shop/src/data/cart-api.ts`), read before any of this happens.
     * The thaw is ITSELF a write, so it bumps the revision and spends that
     * token — passing the shopper's original value on to `addLine` would answer
     * a successful recovery with `409 stale_write`, the same dead end one step
     * further along.
     *
     * Every other test in this block omits `baseRevision`, so `makeEditable`
     * returns `undefined` and the repo falls back to the cart's current
     * revision — which papers over the chaining entirely. This one sends what
     * production actually sends. CLAUDE.md §2: put the value the application
     * really writes into a fixture, or the default stays untested.
     */
    const before = await frozen();

    const res = await client.post('/api/shop/cart/lines', {
      variantId: scarce.id,
      qty: 1,
      baseRevision: before.revision,
    });

    expect(res.status).toBe(201);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('open');
    expect(after.lines).toHaveLength(2);
  });

  it('changes a quantity on a frozen basket, thawing it on the way', async () => {
    await frozen();
    const lineId = (await json<CartView>(await client.get('/api/shop/cart'))).lines[0]!.id;

    const res = await client.patch(`/api/shop/cart/lines/${lineId}`, { qty: 3 });

    expect(res.status).toBe(200);
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('open');
    expect(after.lines[0]!.qty).toBe(3);
  });

  it('REFUSES a line write on a checkout that was actually paid', async () => {
    /*
     * The money guard is the whole reason this goes through `makeEditable`
     * rather than flipping the status: a captured intent on a `converting` cart
     * is a PAID order waiting for the sweep, and emptying its basket would
     * build the order from lines the customer was never charged for.
     *
     * `checkout_paid` rather than `remove_line`, because the two need different
     * sentences on the screen — one says "your payment went through, here is
     * your order", the other says nothing a shopper can act on.
     */
    const cart = await frozen();
    const lineId = (await json<CartView>(await client.get('/api/shop/cart'))).lines[0]!.id;
    await intent(cart.id, 'captured');

    const res = await client.del(`/api/shop/cart/lines/${lineId}`);

    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('checkout_paid');
    const after = await json<CartView>(await client.get('/api/shop/cart'));
    expect(after.cart?.status).toBe('converting');
    expect(after.lines).toHaveLength(1);
  });

  it('CANCELS the pending intent when the basket is what thaws the cart', async () => {
    // Same obligation as `POST /checkout/cancel`: a live payment page must not
    // be left pointed at a cart whose total is about to move.
    const cart = await frozen();
    const lineId = (await json<CartView>(await client.get('/api/shop/cart'))).lines[0]!.id;
    await intent(cart.id, 'requires_payment');

    expect((await client.patch(`/api/shop/cart/lines/${lineId}`, { qty: 2 })).status).toBe(200);

    const after = await ctx.db.execute(sql`
      SELECT status FROM shop_payment_intents WHERE checkout_id = ${cart.id}`);
    expect(after.rows[0]?.status).toBe('cancelled');
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
    await client.signIn({ email: 'owner@test.local' });

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
        /*
         * ORDERS' HALF OF THE SAME OUTBOX (admin#29), folded into this route
         * because `vercel.json` is at the Hobby ceiling of two crons. The two
         * consumers keep SEPARATE consumption ledgers over one table, which is
         * why Orders `ignored` the same two `catalog.variant.published` rows
         * that Cart just ignored — neither can hide a row from the other.
         *
         * `passes: 2` for the same reason Cart's drain took two: the first pass
         * made progress, the second found nothing left and stopped.
         */
        events: { applied: 0, ignored: 2, parked: 0, passes: 2 },
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
    /*
     * The end-to-end version of the same property, through the real stack.
     *
     * ═══ THE FIXTURE CHANGED, THE PROPERTY DID NOT ═══
     * This used to freeze the cart and assert that the next line write answered
     * `409 / add_line`. A frozen cart is no longer a refusal — `routes/cart.ts`
     * thaws it and the write succeeds, which is the bug that motivated the
     * change and is asserted four times over in the block above. So the fixture
     * moved to the one precondition a line write can still legitimately raise:
     * a cart whose payment was CAPTURED, which must never be reopened.
     *
     * It is the same class from the same layer through the same route, so it
     * still measures what this test is for — `CartPreconditionError` leaving a
     * repo function and reaching the client as a 409 rather than a 500, by way
     * of `mapErrors()` and not a middleware.
     */
    const view = await newCart();
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });
    await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipping: UK }),
    });
    await client.post('/api/shop/checkout/freeze');
    await ctx.db.execute(sql`
      INSERT INTO shop_payment_intents
        (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
         refunded_total, created_at, updated_at, revision)
      VALUES ('pi_mapping', ${view.cart!.id}, 1000, ${CURRENCY}, 'captured',
              'key_mapping', 'fp', 0, 1, 1, 1)`);

    const res = await client.post('/api/shop/cart/lines', { variantId: scarce.id, qty: 1 });
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; cart: { status: string } }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('checkout_paid');
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
