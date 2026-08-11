/**
 * Cart is MOUNTED — reachable through the real application, not only through a
 * suite that mounts it for itself.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 * Every other route test in this subsystem calls `mountShopCart(client.app)`,
 * which proves the routes work when something mounts them and proves nothing
 * about whether anything does. "A mechanism that existed but was never wired to
 * a caller" is the single most frequent finding in GAUNTLET.md — `baseRevision`,
 * `Ctrl+K`, `disabled_at` — and an unmounted router is exactly that shape. So
 * this drives `createApp()` with no shop wiring of its own.
 *
 * It also asserts the thing `server/shop/app.ts` warns about in its own marker
 * comment: "what must not happen is two routers claiming one path, because Hono
 * resolves that by registration order rather than by refusing." Four subsystems
 * now register into one router at `/`, and nothing else checks that.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from './test/harness';
import { httpClient, json } from '../../test/http';
import { CART_COOKIE } from './identity/cookies';
import { seedSellable } from '../catalog/test/catalog-harness';
import { shopApp } from '../app';
import { cartShopRoutes } from './routes';
import { DEFAULT_STORE_CURRENCY } from './checkout/shipping';
import type { HttpClient } from '../../test/http';
import type { TestCtx } from './test/harness';

let ctx: TestCtx;
let client: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_inventory_holds CASCADE`);
  // NO `mountShopCart` HERE. That is the whole point of this file.
  client = httpClient(ctx.db);
});

describe('the shop app claims each path exactly once', () => {
  it('gives no other subsystem a handler at a path Cart claims', () => {
    /*
     * Hono resolves a collision by registration order rather than by refusing,
     * so two routers claiming `/cart` would silently give one of them every
     * request — and which one depends on the order of the `shop.route()` calls
     * in `server/shop/app.ts`, i.e. on the order four agents happened to append.
     *
     * COUNTED PER PATH AGAINST CART'S OWN ROUTER, not by looking for repeats in
     * the whole table. `app.routes` holds ONE ENTRY PER HANDLER, so a route with
     * a middleware in front of it legitimately appears twice — the first version
     * of this test flagged all fifty-odd routes in the shop, including Catalog's,
     * for exactly that reason. What is checkable, and what is Cart's to be
     * responsible for, is that mounting Cart adds no path some other subsystem
     * had already claimed: for every key Cart registers, the assembled app must
     * hold precisely the handlers Cart put there and not one more.
     *
     * Wildcards are excluded: `use('*')` entries are supposed to overlap.
     */
    const count = (routes: readonly { method: string; path: string }[]) => {
      const out = new Map<string, number>();
      for (const route of routes) {
        if (route.path.endsWith('*')) continue;
        const key = `${route.method} ${route.path}`;
        out.set(key, (out.get(key) ?? 0) + 1);
      }
      return out;
    };

    const mine = count(cartShopRoutes().routes);
    const whole = count(shopApp().routes);
    expect(mine.size).toBeGreaterThan(10);

    const contested = [...mine]
      .filter(([key, n]) => whole.get(key) !== n)
      .map(([key, n]) => `${key} (cart registers ${n}, shop app has ${whole.get(key)})`);
    expect(contested).toEqual([]);
  });

  it('registers Cart’s paths at the addresses brief §6 fixes', () => {
    const paths = new Set(shopApp().routes.map((r) => `${r.method} ${r.path}`));
    for (const route of [
      'POST /cart',
      'GET /cart',
      'POST /cart/lines',
      'PATCH /cart/lines/:id',
      'DELETE /cart/lines/:id',
      'POST /checkout/start',
      'PUT /checkout/addresses',
      'GET /checkout/shipping-options',
      'PUT /checkout/shipping',
      'POST /checkout/freeze',
      'POST /customer/session',
    ]) {
      expect(paths, route).toContain(route);
    }
  });
});

describe('the storefront works through the real application', () => {
  it('creates a cart, adds a REAL variant, and freezes a total', async () => {
    const { variant } = await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Navy Tee',
      onHand: 5,
      amount: 1999,
      currency: DEFAULT_STORE_CURRENCY,
    });

    const created = await client.post('/api/shop/cart');
    expect(created.status).toBe(201);
    expect(client.cookies().has(CART_COOKIE)).toBe(true);

    const added = await client.post('/api/shop/cart/lines', {
      variantId: variant.id,
      qty: 2,
    });
    expect(added.status).toBe(201);
    const view = await json<{
      lines: Array<{ available: boolean; title: string | null; unit: { amount: number } | null }>;
      preview: { grandTotal: { amount: number } } | null;
    }>(added);
    // Resolved through the REAL `CatalogPort` that `server/shop/app.ts` injected
    // — a title and a price no fake supplied.
    expect(view.lines[0].available).toBe(true);
    expect(view.lines[0].title).toBe('Navy Tee');
    expect(view.lines[0].unit).toEqual({ amount: 1999, currency: DEFAULT_STORE_CURRENCY });
    expect(view.preview?.grandTotal.amount).toBe(3998);

    expect((await client.post('/api/shop/checkout/start')).status).toBe(200);
    const held = await ctx.db.execute(
      sql`SELECT reserved FROM shop_inventory WHERE variant_id = ${variant.id}`,
    );
    expect(Number(held.rows[0].reserved)).toBe(2);

    const addressed = await client.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shipping: { name: 'A Shopper', line1: '1 High St', city: 'London', countryCode: 'GB' },
      }),
    });
    expect(addressed.status).toBe(200);

    await client.request('/api/shop/checkout/shipping', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'standard' }),
    });

    const frozen = await client.post('/api/shop/checkout/freeze');
    expect(frozen.status).toBe(200);
    expect(
      (await json<{ totals: { grandTotal: { amount: number } } }>(frozen)).totals.grandTotal
        .amount,
    ).toBe(3998 + 399 + 880);
  });

  it('still answers 404 rather than 500 for an unrouted shop path', async () => {
    // The mount must not have swallowed the app's `notFound`.
    const res = await client.get('/api/shop/nope');
    expect(res.status).toBe(404);
    expect((await json<{ error: string }>(res)).error).toBe('gone');
  });

  it('refuses a cross-origin write to a cart route', async () => {
    const res = await client.post('/api/shop/cart', undefined, {
      headers: { origin: 'https://evil.test' },
    });
    expect(res.status).toBe(403);
  });

  it('does not disturb Catalog’s own error shape', async () => {
    /*
     * `shopApp` installs an `onError` for Catalog's two conflict errors, and
     * Cart's error mapping wraps each of ITS handlers rather than installing a
     * competing handler. Asserted by checking a Catalog route still answers
     * normally with Cart mounted alongside it.
     */
    const res = await client.get('/api/shop/products');
    expect(res.status).toBeLessThan(500);
  });
});
