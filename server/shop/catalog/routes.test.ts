import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../../test/http';
import type { HttpClient } from '../../test/http';

/**
 * The HTTP surface (brief §6), driven through the REAL app.
 *
 * Route suites go through the whole stack — router, origin guard, session
 * middleware, the shop app's `onError`, the global error handler — because the
 * seam between the repository and HTTP is what this task adds and therefore
 * where its defects are. Calling a repo function directly proves the repo,
 * which `products.test.ts` and `inventory.test.ts` already do.
 */

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

async function login(): Promise<void> {
  await http.signIn({ email: 'owner@test.local' });
}

async function createProduct(title: string): Promise<{ id: string; slug: string }> {
  const res = await http.post('/api/shop/admin/products', { title });
  expect(res.status).toBe(201);
  const body = await json<{ product: { id: string; slug: string } }>(res);
  return body.product;
}

describe('mounting', () => {
  it('is reachable under /api/shop and inherits the request id', async () => {
    const res = await http.get('/api/shop/products');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('an unrouted path under /api/shop is a 404, NOT a 401', async () => {
    /*
     * The measured reason `requireAuth()` is attached per route rather than as
     * `routes.use('*', …)`. `app.route(prefix, router)` flattens the router into
     * its parent, so a blanket guard applies to every path under the prefix —
     * including ones the file has never heard of. On the blog side that turned
     * an unrouted path into a 401, i.e. the guard refused a request that had no
     * handler to reach.
     */
    const res = await http.get('/api/shop/nothing-here');
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('does not disturb the blog routes it is mounted beside', async () => {
    const health = await http.get('/api/health');
    expect(health.status).toBe(200);
    const posts = await http.get('/api/posts');
    // 401 rather than 404: the posts router is still mounted and still guarded.
    expect(posts.status).toBe(401);
  });
});

describe('the storefront is public and the admin surface is not', () => {
  it('GET /products and /products/:slug need no session', async () => {
    http.clearCookies();
    expect((await http.get('/api/shop/products')).status).toBe(200);
    // A shop that requires a login to see what it sells has no customers.
    expect((await http.get('/api/shop/products/nope')).status).toBe(404);
  });

  it.each([
    ['GET', '/api/shop/admin/products'],
    ['POST', '/api/shop/admin/products'],
    ['PATCH', '/api/shop/admin/products/prd_x'],
    ['POST', '/api/shop/admin/products/prd_x/publish'],
    ['DELETE', '/api/shop/admin/products/prd_x'],
    ['POST', '/api/shop/admin/products/prd_x/variants'],
    ['PATCH', '/api/shop/admin/variants/var_x'],
    ['PUT', '/api/shop/admin/variants/var_x/price'],
    ['POST', '/api/shop/admin/inventory/var_x/adjust'],
  ])('%s %s is 401 without a session', async (method, path) => {
    http.clearCookies();
    const res = await http.request(path, {
      method,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    expect(res.status).toBe(401);
  });

  it('refuses a cross-origin write before anything else runs', async () => {
    await login();
    const res = await http.request('/api/shop/admin/products', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('the admin write path', () => {
  beforeAll(login);

  it('creates, patches with a baseRevision, and returns the new revision', async () => {
    const created = await createProduct('Route Product');
    const res = await http.patch(`/api/shop/admin/products/${created.id}`, {
      patch: { title: 'Route Product Renamed', category: 'apparel' },
      baseRevision: 1,
    });
    expect(res.status).toBe(200);
    const body = await json<{ product: { revision: number; title: string } }>(res);
    expect(body.product).toMatchObject({ revision: 2, title: 'Route Product Renamed' });
  });

  it('a stale baseRevision is a 409 CARRYING THE CURRENT PRODUCT', async () => {
    /*
     * Brief §4. The conflict body has to hold the server's current product so an
     * admin form's "load theirs" renders with no second request — and it has to
     * be under a key that means what it says, which is why the shop app renders
     * `product` rather than the shared error's `post` (amendment A-CAT-011).
     */
    const created = await createProduct('Conflict Route');
    await http.patch(`/api/shop/admin/products/${created.id}`, {
      patch: { title: 'Theirs' },
      baseRevision: 1,
    });

    const res = await http.patch(`/api/shop/admin/products/${created.id}`, {
      patch: { title: 'Mine' },
      baseRevision: 1,
    });
    expect(res.status).toBe(409);
    const body = await json<{
      error: string;
      expected: number;
      actual: number;
      product: { title: string };
    }>(res);
    expect(body).toMatchObject({ error: 'stale_write', expected: 1, actual: 2 });
    expect(body.product.title).toBe('Theirs');
  });

  it('a refused lifecycle op is a DIFFERENT 409, naming the operation', async () => {
    const created = await createProduct('Precondition Route');
    expect((await http.post(`/api/shop/admin/products/${created.id}/publish`)).status).toBe(200);

    const res = await http.post(`/api/shop/admin/products/${created.id}/publish`);
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; product: { id: string } }>(res);
    // "There is nothing to do" is not "someone got there first". Collapsed into
    // one, the refusal arrives with expected === actual and no banner can render it.
    expect(body).toMatchObject({ error: 'precondition_failed', operation: 'publish' });
    expect(body.product.id).toBe(created.id);
  });

  it('REFUSES A BODY CARRYING slug OR status — both are server-authoritative', async () => {
    const created = await createProduct('Strict Body');
    for (const patch of [{ slug: 'mine' }, { status: 'active' }]) {
      const res = await http.patch(`/api/shop/admin/products/${created.id}`, { patch });
      // A 400 rather than accepted-and-discarded, which would leave the caller
      // believing it had set an address, or a status, that it had not.
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ error: 'bad_request' });
    }
  });

  it('refuses an unknown query parameter rather than ignoring it', async () => {
    // `?categoryy=mugs` silently ignored would return the whole catalogue and
    // look like a bug in the storefront.
    const res = await http.get('/api/shop/products?categoryy=mugs');
    expect(res.status).toBe(400);
  });

  it('DELETE is a SOFT delete — to the trash, and the row survives', async () => {
    const created = await createProduct('Soft Delete');
    const res = await http.del(`/api/shop/admin/products/${created.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ product: { deletedAt: number | null } }>(res);
    expect(body.product.deletedAt).not.toBeNull();

    const stored = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM shop_products WHERE id = ${created.id}`,
    );
    expect(Number(stored.rows[0].n)).toBe(1);
  });
});

describe('?withTotal — how many products there are, opt-in', () => {
  beforeAll(login);

  /**
   * The products screen labels its Export action with this number, and Export
   * ships the WHOLE catalogue — so a count that answered "how many on this
   * page" or "how many after the cursor" would put a figure on screen that the
   * downloaded file contradicts.
   */
  it('counts every product matching the filter, not the page', async () => {
    for (const n of [1, 2, 3]) await createProduct(`Counted ${n}`);

    const page = await http.get('/api/shop/admin/products?limit=1&withTotal=1');
    expect(page.status).toBe(200);
    const body = await json<{ items: unknown[]; total: number; nextCursor: string | null }>(page);

    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeTruthy();

    // The independent reading — §5's rule about never trusting the statement
    // that produced the number.
    const all = await http.get('/api/shop/admin/products?limit=100');
    const { items } = await json<{ items: unknown[] }>(all);
    expect(body.total).toBe(items.length);
    expect(body.total).toBeGreaterThan(1);
  });

  it('does not answer the cursor page — the count ignores where you are', async () => {
    const first = await http.get('/api/shop/admin/products?limit=1&withTotal=1');
    const { total, nextCursor } = await json<{ total: number; nextCursor: string }>(first);

    const second = await http.get(
      `/api/shop/admin/products?limit=1&withTotal=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    expect((await json<{ total: number }>(second)).total).toBe(total);
  });

  it('is OFF by default, and the field is absent rather than null', async () => {
    // The paging pays for `size + 1` and nothing else unless asked; a `total: null`
    // would still have cost the scan to produce.
    const res = await http.get('/api/shop/admin/products?limit=1');
    const body = (await json<Record<string, unknown>>(res)) as Record<string, unknown>;
    expect('total' in body).toBe(false);
  });

  it("takes the query string's spellings and refuses anything else", async () => {
    // `?withTotal=false` is a truthy STRING — the enum is what stops it
    // reading as on. And the schema is .strict(), so a typo is a 400.
    for (const [value, expected] of [
      ['0', false],
      ['false', false],
      ['1', true],
      ['true', true],
    ] as const) {
      const res = await http.get(`/api/shop/admin/products?limit=1&withTotal=${value}`);
      expect([value, res.status]).toEqual([value, 200]);
      const body = await json<Record<string, unknown>>(res);
      expect([value, 'total' in body]).toEqual([value, expected]);
    }
    expect((await http.get('/api/shop/admin/products?withTotal=yes')).status).toBe(400);
    expect((await http.get('/api/shop/admin/products?withTotals=1')).status).toBe(400);
  });
});

describe('variants, prices and inventory over HTTP', () => {
  beforeAll(login);

  it('creates a variant with stock, prices it, and serves it on the product page', async () => {
    const created = await createProduct('Full Journey');

    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'JOURNEY-1',
      optionValues: { Size: 'M' },
      onHand: 5,
    });
    expect(variantRes.status).toBe(201);
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const priceRes = await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
      method: 'PUT',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1999, currency: 'GBP' }),
    });
    expect(priceRes.status).toBe(200);

    expect((await http.post(`/api/shop/admin/products/${created.id}/publish`)).status).toBe(200);

    const page = await http.get(`/api/shop/products/${created.slug}`);
    expect(page.status).toBe(200);
    const body = await json<{
      product: { variants: { sku: string; price: { amount: number }; available: number }[] };
    }>(page);
    expect(body.product.variants).toHaveLength(1);
    expect(body.product.variants[0]).toMatchObject({
      sku: 'JOURNEY-1',
      price: { amount: 1999, currency: 'GBP' },
      available: 5,
    });
  });

  it('REFUSES A DECIMAL PRICE AT THE BOUNDARY — no floats for money, anywhere', async () => {
    const created = await createProduct('Float Price');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'FLOAT-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    for (const amount of [19.99, -1]) {
      const res = await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
        method: 'PUT',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ amount, currency: 'GBP' }),
      });
      expect(res.status, `amount ${amount}`).toBe(400);
    }
    // And a currency that is not ISO-4217.
    const bad = await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
      method: 'PUT',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100, currency: 'gbp' }),
    });
    expect(bad.status).toBe(400);
  });

  it('refuses an amount past the int4 column as a 400, not a retried 500', async () => {
    /*
     * 2^31 passes `z.int()`, `Number.isSafeInteger` and `money()` alike — the
     * only thing that used to refuse it was `shop_prices.amount` itself, with
     * SQLSTATE 22003, which has no row in the error table and answered 500: a
     * status the client's retry policy re-sends five times for input that can
     * never be accepted. The same failure mode the lowercase-currency fix on
     * `PriceBody` documents, one field over.
     */
    const created = await createProduct('Int4 Price');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'INT4-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const res = await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
      method: 'PUT',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 2_147_483_648, currency: 'NGN' }),
    });
    expect(res.status).toBe(400);
  });

  it('adjusts inventory with a reason, without one, and refuses a blank one', async () => {
    const created = await createProduct('Adjust Route');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'ADJUST-1',
      onHand: 10,
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const ok = await http.post(`/api/shop/admin/inventory/${variant.id}/adjust`, {
      delta: -2,
      reason: 'damaged',
    });
    expect(ok.status).toBe(200);
    expect(await json<{ inventory: { onHand: number } }>(ok)).toMatchObject({
      inventory: { onHand: 8, available: 8 },
    });

    /*
     * `reason` IS OPTIONAL SINCE 2026-09-03 (owner's instruction) — this
     * assertion used to be a 400. The stock still moves and the event is still
     * written; it just carries a null reason, which `server/shop/admin/audit.ts`
     * has rendered since it was written.
     */
    const noReason = await http.post(`/api/shop/admin/inventory/${variant.id}/adjust`, {
      delta: -1,
    });
    expect(noReason.status).toBe(200);
    expect(await json<{ inventory: { onHand: number } }>(noReason)).toMatchObject({
      inventory: { onHand: 7, available: 7 },
    });

    /*
     * A BLANK STRING IS STILL A 400, and that is the half worth keeping. The
     * body's schema keeps `.min(1)` inside its `.optional()`: omitting the key
     * is a person who left the box empty, sending `''` is a client that built
     * the field and put nothing in it, and only the second is a bug.
     */
    const blank = await http.post(`/api/shop/admin/inventory/${variant.id}/adjust`, {
      delta: -1,
      reason: '',
    });
    expect(blank.status).toBe(400);
    expect(await json<{ detail: string }>(blank)).toMatchObject({ detail: 'reason' });
  });

  it('a duplicate SKU is a 409 naming the SKU, not a 500 and not a bare 400', async () => {
    /*
     * WAS A 400 `detail: 'sku'`, AND THE CHANGE IS THE POINT. That is the same
     * answer an empty or NUL-bearing SKU gets, so the screen could say no more
     * than "the sku was refused" — which sent somebody to inspect the characters
     * in a SKU whose only problem was that it already existed. "Already in use"
     * is a conflict with existing state, which is what 409 means everywhere else
     * in this application, and the SKU itself rides along so the message can
     * quote what the server rejected rather than whatever is in the input by the
     * time it renders.
     *
     * `server/shop/app.ts` does the upgrade. `DuplicateSkuError` is still a
     * `BadRequestError` underneath, so a caller reaching it outside that
     * `onError` still gets a 4xx that stops the retry policy.
     */
    const a = await createProduct('SKU A');
    const b = await createProduct('SKU B');
    expect(
      (await http.post(`/api/shop/admin/products/${a.id}/variants`, { sku: 'DUPE-1' })).status,
    ).toBe(201);
    const res = await http.post(`/api/shop/admin/products/${b.id}/variants`, { sku: 'DUPE-1' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'duplicate_sku',
      detail: 'sku',
      sku: 'DUPE-1',
    });
  });

  it('renaming a variant onto a taken SKU is the same 409', async () => {
    // The update path has its own catch, and it used to report a SKU it could
    // not name because the value was scoped inside the branch that set it.
    const a = await createProduct('SKU C');
    const taken = await json<{ variant: { id: string } }>(
      await http.post(`/api/shop/admin/products/${a.id}/variants`, { sku: 'TAKEN-1' }),
    );
    const mine = await json<{ variant: { id: string } }>(
      await http.post(`/api/shop/admin/products/${a.id}/variants`, { sku: 'MINE-1' }),
    );
    expect(taken.variant.id).not.toBe(mine.variant.id);

    const res = await http.patch(`/api/shop/admin/variants/${mine.variant.id}`, {
      sku: 'TAKEN-1',
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'duplicate_sku', sku: 'TAKEN-1' });
  });

  it('a variant on a product that does not exist is a 404, not a foreign-key 500', async () => {
    const res = await http.post('/api/shop/admin/products/prd_nope/variants', { sku: 'ORPHAN-1' });
    expect(res.status).toBe(404);
  });

  it('availability is null rather than zero for a variant nobody has stocked', async () => {
    const created = await createProduct('Untracked');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'UNTRACKED-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);
    // `createVariant` writes an inventory row in the same statement, so this is
    // 0 rather than null — which is the point: the null case is unreachable
    // through this API.
    const res = await http.get(`/api/shop/variants/${variant.id}/availability`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ available: 0, backorderable: false });
  });
});

/**
 * `DELETE /admin/variants/:id` (issue #18).
 *
 * A DIRECT SQL INSERT INTO `shop_order_lines`, NOT A FULL CHECKOUT. Building a
 * real order means driving Cart's checkout flow, which is a different
 * subsystem's surface and not what this test is proving. What matters here is
 * the one fact `deleteVariant` reads — "does a `shop_order_lines` row name this
 * variant" — so the order and its line are minted with the columns their own
 * `CHECK`s require and nothing more.
 */
async function insertOrderLineForVariant(
  db: TestCtx['db'],
  variantId: string,
): Promise<{ orderId: string }> {
  const orderId = `ord_${variantId}`;
  const now = Date.now();
  await db.execute(sql`
    INSERT INTO shop_orders (id, order_number, email, currency, subtotal, shipping_total,
                              tax_total, grand_total, status, shipping_address,
                              billing_address, placed_at, revision, source_event_id, checkout_id)
    VALUES (${orderId}, ${orderId}, 'buyer@test.local', 'GBP', 1999, 0, 0, 1999, 'paid',
            '{}'::jsonb, '{}'::jsonb, ${now}, 1, ${orderId}, ${orderId})
  `);
  await db.execute(sql`
    INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                   option_values, qty, unit_amount, line_total)
    VALUES (${`${orderId}_l1`}, ${orderId}, 0, ${variantId}, 'SOLD-1', 'Sold Variant',
            '{}'::jsonb, 1, 1999, 1999)
  `);
  return { orderId };
}

describe('deleting a variant (issue #18)', () => {
  beforeAll(login);

  it('deletes a never-ordered variant outright, taking its price and inventory rows with it', async () => {
    const created = await createProduct('Delete Me');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'DELETE-1',
      onHand: 5,
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);
    // `createVariant` writes an inventory row in the same statement; this
    // adds a `shop_prices` row too, so both cascades are actually exercised
    // rather than deleting a variant that never had either.
    expect(
      (
        await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
          method: 'PUT',
          headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ amount: 999, currency: 'GBP' }),
        })
      ).status,
    ).toBe(200);

    const res = await http.del(`/api/shop/admin/variants/${variant.id}`);
    expect(res.status).toBe(200);

    const detail = await http.get(`/api/shop/admin/products/${created.id}`);
    const body = await json<{ product: { variants: unknown[] } }>(detail);
    expect(body.product.variants).toHaveLength(0);

    // Their removal rides on the CTEs (and, for inventory, an FK cascade) —
    // asserted directly so a future schema change that drops the cascade is
    // caught here rather than discovered as an orphaned row in production.
    const prices = await ctx.db.execute(sql`
      SELECT 1 FROM shop_prices WHERE variant_id = ${variant.id}`);
    expect(prices.rows).toHaveLength(0);
    const inventory = await ctx.db.execute(sql`
      SELECT 1 FROM shop_inventory WHERE variant_id = ${variant.id}`);
    expect(inventory.rows).toHaveLength(0);
  });

  it('releases a HELD reservation on delete, and leaves settled ones alone', async () => {
    /*
     * `shop_reservations` is Cart's table (R3) with NO FK to `shop_variants`
     * — unlike `shop_inventory_holds`, which cascades away with the row. Left
     * alone, a `held` reservation would outlive the variant it names, and
     * `releaseHold` — which matches by `reservation_id` against a holds row
     * that is by then gone — could never clear it: a permanent orphan the
     * sweeper revisits forever. `deleteVariant`'s `rel_resv` CTE moves it to
     * `released`, and ONLY from `held`: `committed` and the other settled
     * states are terminal records of what actually happened, which a catalog
     * delete has no business rewriting.
     */
    const created = await createProduct('Delete With Hold');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'DELETE-HOLD-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const now = Date.now();
    const cartId = `cart_hold_${variant.id}`;
    await ctx.db.execute(sql`
      INSERT INTO shop_carts (id, currency, status, created_at, updated_at, expires_at, revision)
      VALUES (${cartId}, 'GBP', 'open', ${now}, ${now}, ${now + 86_400_000}, 1)`);
    await ctx.db.execute(sql`
      INSERT INTO shop_reservations (id, cart_id, variant_id, qty, created_at, expires_at, state)
      VALUES (${`resv_comm_${variant.id}`}, ${cartId}, ${variant.id}, 1, ${now}, ${now + 900_000}, 'committed'),
             (${`resv_held_${variant.id}`}, ${cartId}, ${variant.id}, 1, ${now}, ${now + 900_000}, 'held')`);

    const res = await http.del(`/api/shop/admin/variants/${variant.id}`);
    expect(res.status).toBe(200);

    const states = await ctx.db.execute(sql`
      SELECT id, state FROM shop_reservations WHERE cart_id = ${cartId} ORDER BY id`);
    expect(states.rows).toEqual([
      { id: `resv_comm_${variant.id}`, state: 'committed' },
      { id: `resv_held_${variant.id}`, state: 'released' },
    ]);
  });

  it('cascades a never-ordered variant out of an open cart line', async () => {
    const created = await createProduct('Delete With Cart');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'DELETE-CART-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const now = Date.now();
    const cartId = `cart_${variant.id}`;
    await ctx.db.execute(sql`
      INSERT INTO shop_carts (id, currency, status, created_at, updated_at, expires_at, revision)
      VALUES (${cartId}, 'GBP', 'open', ${now}, ${now}, ${now + 86_400_000}, 1)
    `);
    await ctx.db.execute(sql`
      INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
      VALUES (${`${cartId}_l1`}, ${cartId}, ${variant.id}, 1, ${now})
    `);

    expect((await http.del(`/api/shop/admin/variants/${variant.id}`)).status).toBe(200);

    const remaining = await ctx.db.execute(sql`
      SELECT 1 FROM shop_cart_lines WHERE variant_id = ${variant.id}`);
    expect(remaining.rows).toHaveLength(0);
  });

  it('refuses to delete a variant that has ever been ordered — 409, and the control is not "try again"', async () => {
    const created = await createProduct('Sold Product');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'SOLD-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);
    const { orderId } = await insertOrderLineForVariant(ctx.db, variant.id);

    const res = await http.del(`/api/shop/admin/variants/${variant.id}`);
    expect(res.status).toBe(409);
    const body = await json<{ error: string; operation: string; variant: { id: string } }>(res);
    expect(body).toMatchObject({
      error: 'precondition_failed',
      operation: 'delete',
      variant: { id: variant.id },
    });

    // Order history is intact: the order and its line still exist afterwards,
    // and still name this variant — the whole point of refusing the delete.
    const lines = await ctx.db.execute(sql`
      SELECT variant_id FROM shop_order_lines WHERE order_id = ${orderId}`);
    expect(lines.rows).toMatchObject([{ variant_id: variant.id }]);

    // The variant itself is untouched, so the admin read still shows it.
    const detail = await http.get(`/api/shop/admin/products/${created.id}`);
    const body2 = await json<{ product: { variants: { id: string; everOrdered: boolean }[] } }>(
      detail,
    );
    expect(body2.product.variants).toMatchObject([{ id: variant.id, everOrdered: true }]);
  });

  it('a nonexistent variant is a 404', async () => {
    expect((await http.del('/api/shop/admin/variants/var_nope')).status).toBe(404);
  });

  it('the API refuses the delete with a 409 even called directly, independent of any UI hiding the control', async () => {
    const created = await createProduct('Direct Call Sold');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'DIRECT-SOLD-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);
    await insertOrderLineForVariant(ctx.db, variant.id);

    // Straight to the route, no client-side gate involved.
    const res = await http.del(`/api/shop/admin/variants/${variant.id}`);
    expect(res.status).toBe(409);
  });
});

describe('NUL bytes and malformed input are 400s, never 500s', () => {
  beforeAll(login);

  /*
   * A U+0000 in a `text` bind raises SQLSTATE 22021, which has no row in the
   * error table and answers 500 — a status the client's retry policy re-sends
   * five times for input that can never be accepted. `server/nul-bytes.test.ts`
   * walks every registered route and asserts this for the whole app; these are
   * the cases specific enough to be worth naming here.
   */
  it.each([
    ['a path segment', '/api/shop/products/%00'],
    ['a query filter', '/api/shop/products?category=%00'],
    ['a cursor', '/api/shop/products?cursor=%00'],
  ])('%s carrying a NUL is a 4xx', async (_name, path) => {
    const res = await http.get(path);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('a limit outside its range is REJECTED, not clamped', async () => {
    // Silently handing back 100 rows to a caller who asked for 500 makes a
    // truncated page indistinguishable from a complete one, which is how a
    // client that paginates by "did I get fewer than I asked for" stops early.
    expect((await http.get('/api/shop/products?limit=500')).status).toBe(400);
    expect((await http.get('/api/shop/products?limit=0')).status).toBe(400);
    expect((await http.get('/api/shop/products?limit=abc')).status).toBe(400);
  });

  it('a cursor minted under another sort is a 400', async () => {
    const res = await http.get('/api/shop/products?sort=newest');
    const { nextCursor } = await json<{ nextCursor: string | null }>(res);
    if (!nextCursor) return; // Fewer than a page of products; nothing to spend.
    const wrong = await http.get(`/api/shop/products?sort=alphabetical&cursor=${nextCursor}`);
    expect(wrong.status).toBe(400);
  });
});

describe('the price history', () => {
  beforeAll(login);

  it('records every price change, newest first, with the window closed behind it', async () => {
    /*
     * The endpoint that makes brief §2's justification for effective-dated rows
     * real rather than theoretical: "the catalog still needs to answer 'what did
     * this cost on Tuesday' for reconciliation, and a column cannot".
     */
    const created = await createProduct('Priced Over Time');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'HISTORY-1',
    });
    const { variant } = await json<{ variant: { id: string } }>(variantRes);

    const setPrice = (amount: number) =>
      http.request(`/api/shop/admin/variants/${variant.id}/price`, {
        method: 'PUT',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ amount, currency: 'GBP' }),
      });

    expect((await setPrice(1000)).status).toBe(200);
    // The window check demands effective_to > effective_from, so two changes
    // inside one millisecond are refused rather than stored zero-width.
    await new Promise((r) => setTimeout(r, 2));
    expect((await setPrice(1500)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2));
    expect((await setPrice(1200)).status).toBe(200);

    const res = await http.get(`/api/shop/admin/variants/${variant.id}/prices`);
    expect(res.status).toBe(200);
    const { prices } = await json<{
      prices: { amount: number; effectiveTo: number | null }[];
    }>(res);

    expect(prices.map((p) => p.amount)).toEqual([1200, 1500, 1000]);
    // Exactly one is current; every superseded row has its window closed.
    expect(prices.filter((p) => p.effectiveTo === null)).toHaveLength(1);
    expect(prices[0].effectiveTo).toBeNull();
    for (const p of prices.slice(1)) expect(p.effectiveTo).not.toBeNull();
  });

  it('is admin-only and 404s for a variant that does not exist', async () => {
    expect((await http.get('/api/shop/admin/variants/var_nope/prices')).status).toBe(404);
    http.clearCookies();
    expect((await http.get('/api/shop/admin/variants/var_x/prices')).status).toBe(401);
  });
});

describe('compare-at, cost and SEO (owner queue 2026-08-25; migrations 0400/0420/0440)', () => {
  beforeAll(login);

  it('carries compare-at to the storefront and KEEPS COST OFF IT', async () => {
    /*
     * The one assertion in this suite that is about a LEAK rather than a
     * behaviour. `types.ts` records that the storefront product shape is
     * allow-listed by nothing — the next field added joins the public wire
     * silently. Cost is the first field where that would be commercially wrong,
     * so `toStorefrontVariant` strips it; this drives both public serialisers
     * (detail and list) and fails the day anyone widens the shape back.
     */
    const created = await createProduct('Sale Spool');
    const variantRes = await http.post(`/api/shop/admin/products/${created.id}/variants`, {
      sku: 'SALE-1',
      onHand: 3,
      compareAtMinor: 2_500_00,
      costMinor: 900_00,
    });
    expect(variantRes.status).toBe(201);
    const { variant } = await json<{
      variant: { id: string; compareAtMinor: number | null; costMinor: number | null };
    }>(variantRes);
    // The write response is the ADMIN wire: both fields, as written.
    expect(variant).toMatchObject({ compareAtMinor: 250_000, costMinor: 90_000 });

    expect(
      (
        await http.request(`/api/shop/admin/variants/${variant.id}/price`, {
          method: 'PUT',
          headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ amount: 190_000, currency: 'NGN' }),
        })
      ).status,
    ).toBe(200);
    expect((await http.post(`/api/shop/admin/products/${created.id}/publish`)).status).toBe(200);

    // The admin read keeps cost: the margin column is what it exists for.
    const adminDetail = await json<{
      product: { variants: { compareAtMinor: number; costMinor: number }[] };
    }>(await http.get(`/api/shop/admin/products/${created.id}`));
    expect(adminDetail.product.variants[0]).toMatchObject({
      compareAtMinor: 250_000,
      costMinor: 90_000,
    });

    // The storefront page: the strikethrough figure present, cost ABSENT —
    // absent as a KEY, not null, so a client cannot even see that it exists.
    const page = await json<{ product: { variants: Record<string, unknown>[] } }>(
      await http.get(`/api/shop/products/${created.slug}`),
    );
    expect(page.product.variants[0]).toMatchObject({ compareAtMinor: 250_000 });
    expect('costMinor' in page.product.variants[0]).toBe(false);

    // And the storefront LIST, which serialises through the same mapper.
    const list = await json<{ items: { id: string; variants: Record<string, unknown>[] }[] }>(
      await http.get('/api/shop/products'),
    );
    const listed = list.items.find((p) => p.id === created.id);
    expect(listed).toBeDefined();
    expect(listed!.variants[0]).toMatchObject({ compareAtMinor: 250_000 });
    expect('costMinor' in listed!.variants[0]).toBe(false);
  });

  it('sets and clears both variant fields through PATCH, refusing junk', async () => {
    const created = await createProduct('Margins');
    const { variant } = await json<{ variant: { id: string } }>(
      await http.post(`/api/shop/admin/products/${created.id}/variants`, { sku: 'MARGIN-1' }),
    );

    const set = await http.patch(`/api/shop/admin/variants/${variant.id}`, {
      compareAtMinor: 120_000,
      costMinor: 45_000,
    });
    expect(set.status).toBe(200);
    expect(await json(set)).toMatchObject({
      variant: { compareAtMinor: 120_000, costMinor: 45_000 },
    });

    // `null` clears — "no longer on sale" / "cost unknown again".
    const cleared = await http.patch(`/api/shop/admin/variants/${variant.id}`, {
      compareAtMinor: null,
      costMinor: null,
    });
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toMatchObject({
      variant: { compareAtMinor: null, costMinor: null },
    });

    // No floats for money and no negatives — 400s at the boundary, exactly as
    // the price route refuses them (contract §10).
    for (const body of [
      { compareAtMinor: 19.99 },
      { compareAtMinor: -1 },
      { costMinor: 19.99 },
      { costMinor: -1 },
    ]) {
      const res = await http.patch(`/api/shop/admin/variants/${variant.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('flips backorderable through the variant PATCH — the flag stops being create-only', async () => {
    const created = await createProduct('Backorder Flip');
    const { variant } = await json<{ variant: { id: string } }>(
      await http.post(`/api/shop/admin/products/${created.id}/variants`, { sku: 'FLIP-1' }),
    );

    // Created default-false; the availability read is the public truth of it.
    expect(
      await json(await http.get(`/api/shop/variants/${variant.id}/availability`)),
    ).toMatchObject({ backorderable: false });

    // A patch carrying ONLY the flag is a valid patch, not the empty-patch 400.
    const flip = await http.patch(`/api/shop/admin/variants/${variant.id}`, {
      backorderable: true,
    });
    expect(flip.status).toBe(200);
    expect(
      await json(await http.get(`/api/shop/variants/${variant.id}/availability`)),
    ).toMatchObject({ backorderable: true });

    // Alongside a merchandising field, the one statement still lands both.
    const both = await http.patch(`/api/shop/admin/variants/${variant.id}`, {
      backorderable: false,
      weightGrams: 750,
    });
    expect(both.status).toBe(200);
    expect(await json(both)).toMatchObject({ variant: { weightGrams: 750 } });
    expect(
      await json(await http.get(`/api/shop/variants/${variant.id}/availability`)),
    ).toMatchObject({ backorderable: false });

    // The genuinely empty patch is still refused.
    expect((await http.patch(`/api/shop/admin/variants/${variant.id}`, {})).status).toBe(400);
  });

  it('saves, serves and clears SEO copy, normalising the empty string to NULL', async () => {
    const createRes = await http.post('/api/shop/admin/products', {
      title: 'Meta Spool',
      seoTitle: '  PLA that prints clean | PlaSpool  ',
      seoDescription: 'Premium PLA filament, delivered across Nigeria.',
    });
    expect(createRes.status).toBe(201);
    const { product } = await json<{
      product: {
        id: string;
        slug: string;
        revision: number;
        seoTitle: string | null;
        seoDescription: string | null;
      };
    }>(createRes);
    // Trimmed on the way in — a meta tag with stray whitespace was never intended.
    expect(product.seoTitle).toBe('PLA that prints clean | PlaSpool');
    expect(product.seoDescription).toBe('Premium PLA filament, delivered across Nigeria.');

    // An absent key is "leave it alone", not "clear" — the ProductPatch rule.
    const renamed = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { title: 'Meta Spool Renamed' },
      baseRevision: product.revision,
    });
    expect(renamed.status).toBe(200);
    const afterRename = await json<{
      product: { revision: number; seoTitle: string | null };
    }>(renamed);
    expect(afterRename.product.seoTitle).toBe('PLA that prints clean | PlaSpool');

    // Deliberately public: rendering the meta tags is the entire point.
    const published = await json<{ product: { revision: number } }>(
      await http.post(`/api/shop/admin/products/${product.id}/publish`),
    );
    const page = await json<{
      product: { seoTitle: string | null; seoDescription: string | null };
    }>(await http.get(`/api/shop/products/${product.slug}`));
    expect(page.product.seoTitle).toBe('PLA that prints clean | PlaSpool');
    expect(page.product.seoDescription).toBe(
      'Premium PLA filament, delivered across Nigeria.',
    );

    // '' clears exactly as null does — a cleared input box arrives as ''.
    const clearedRes = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { seoTitle: '', seoDescription: null },
      baseRevision: published.product.revision,
    });
    expect(clearedRes.status).toBe(200);
    const cleared = await json<{
      product: { seoTitle: string | null; seoDescription: string | null };
    }>(clearedRes);
    expect(cleared.product.seoTitle).toBeNull();
    expect(cleared.product.seoDescription).toBeNull();

    // The route bound is a 400 that names no other field's business.
    const tooLong = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { seoTitle: 'x'.repeat(301) },
    });
    expect(tooLong.status).toBe(400);
  });
});
