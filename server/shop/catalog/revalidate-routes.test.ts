import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { setRevalidateTransport, settleRevalidations } from './revalidate';

/**
 * Every catalogue write pushes a purge to the storefront — asserted through the
 * REAL app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE HALF THAT MATTERS. `revalidate.test.ts` proves the transport is
 * correct; this proves it is CALLED, from the routes production actually serves,
 * built by the real `createApp()` in `server/test/http.ts`.
 *
 * CLAUDE.md §2 is the reason it is written this way round. Twice now this
 * repository has shipped a mechanism that worked perfectly and was wired to
 * nothing — `GET /api/shop/orders` with no registered resolver, the webhook with
 * an unwired `CheckoutPort` — and both times the suite passed because it drove a
 * test app that registered its own dependencies. A revalidation module with
 * green unit tests and no call site would be the third.
 * ═══════════════════════════════════════════════════════════════════════════
 */

let ctx: TestCtx;
let http: HttpClient;
let sent: unknown[];

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
  await http.signIn({ email: 'owner@test.local' });
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(() => {
  sent = [];
  // One `purged` line per purge is the point of the feature; it is not this
  // suite's output.
  vi.spyOn(console, 'info').mockImplementation(() => {});
  /*
   * INSTALLING A RECORDER IS ALSO WHAT UNLOCKS THE PATH. A test process purges
   * nothing unless a suite has replaced the transport (see `endpoint()` in
   * `revalidate.ts`), so this line is both the assertion seam and the reason no
   * request here can reach the real storefront.
   */
  setRevalidateTransport((async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true, revalidated: [] }), { status: 200 });
  }) as unknown as typeof fetch);
});

afterEach(async () => {
  await settleRevalidations();
  setRevalidateTransport(null);
  vi.restoreAllMocks();
});

/** Everything the write scheduled, once it has all settled. */
async function purges(): Promise<unknown[]> {
  await settleRevalidations();
  return sent;
}

interface Product {
  id: string;
  slug: string;
  revision: number;
}

let n = 0;

async function newProduct(): Promise<Product> {
  n += 1;
  const res = await http.post('/api/shop/admin/products', { title: `Purge Subject ${n}` });
  expect(res.status).toBe(201);
  const { product } = await json<{ product: Product }>(res);
  await settleRevalidations();
  sent = [];
  return product;
}

/** A committed image row, so a product patch may reference it. */
async function seedCommittedImage(id: string): Promise<string> {
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    VALUES (${id}, ${ctx.users.owner.id}::uuid, ${`images/${ctx.users.owner.id}/${id}`},
            'image/png', NULL, NULL, 1000, NULL, ${now}, ${now}, NULL)`);
  return id;
}

async function newVariant(productId: string): Promise<{ id: string }> {
  const res = await http.post(`/api/shop/admin/products/${productId}/variants`, {
    optionValues: { colour: `shade-${(n += 1)}` },
    onHand: 5,
  });
  expect(res.status).toBe(201);
  const { variant } = await json<{ variant: { id: string } }>(res);
  await settleRevalidations();
  sent = [];
  return variant;
}

describe('product writes purge the product page', () => {
  it('POST /admin/products', async () => {
    const res = await http.post('/api/shop/admin/products', { title: 'Brand New Spool' });
    expect(res.status).toBe(201);
    const { product } = await json<{ product: Product }>(res);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('PATCH /admin/products/:id', async () => {
    const product = await newProduct();
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { title: 'Renamed', tags: ['pla'] },
      baseRevision: product.revision,
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('PATCH /admin/products/:id — a category reassignment is still one product', async () => {
    const product = await newProduct();
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { category: 'Filament' },
      baseRevision: product.revision,
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('PATCH /admin/products/:id — changed images', async () => {
    const product = await newProduct();
    // A patch may only name a COMMITTED image, so the row is seeded the way
    // `product-images.test.ts` seeds one — the upload → commit path needs R2 and
    // is not what this suite is about.
    const image = await seedCommittedImage(`img_purge_${(n += 1)}`);
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { coverImageId: image, imageIds: [image] },
      baseRevision: product.revision,
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it.each(['publish', 'unpublish', 'archive', 'unarchive', 'restore'])(
    'POST /admin/products/:id/%s',
    async (transition) => {
      const product = await newProduct();
      // Each transition has its own preconditions; the ones that refuse still
      // prove the rule that matters — a refused write must NOT purge.
      const res = await http.post(`/api/shop/admin/products/${product.id}/${transition}`);
      const purged = await purges();

      if (res.status === 200) expect(purged).toEqual([{ slug: product.slug }]);
      else expect(purged).toEqual([]);
    },
  );

  it('POST /admin/products/:id/publish then /unpublish, in order', async () => {
    const product = await newProduct();
    expect((await http.post(`/api/shop/admin/products/${product.id}/publish`)).status).toBe(200);
    expect(await purges()).toEqual([{ slug: product.slug }]);

    sent = [];
    expect((await http.post(`/api/shop/admin/products/${product.id}/unpublish`)).status).toBe(
      200,
    );
    // The one a stale cache hurts most: a withdrawn product still on sale.
    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('DELETE /admin/products/:id', async () => {
    const product = await newProduct();
    const res = await http.del(`/api/shop/admin/products/${product.id}`);
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });
});

describe('variant, price and inventory writes purge their parent product', () => {
  it('POST /admin/products/:id/variants', async () => {
    const product = await newProduct();
    const res = await http.post(`/api/shop/admin/products/${product.id}/variants`, {
      optionValues: { colour: 'ember' },
      onHand: 10,
    });
    expect(res.status).toBe(201);

    // The route knows the product id, not the slug; the slug is read in the
    // background task rather than on the request path.
    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('PATCH /admin/variants/:id', async () => {
    const product = await newProduct();
    const variant = await newVariant(product.id);
    const res = await http.patch(`/api/shop/admin/variants/${variant.id}`, {
      colorHex: '#8b5a2b',
      weightGrams: 1000,
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('DELETE /admin/variants/:id — resolved by product id, since the row is gone', async () => {
    const product = await newProduct();
    const variant = await newVariant(product.id);
    const res = await http.del(`/api/shop/admin/variants/${variant.id}`);
    expect(res.status).toBe(200);

    /*
     * The regression this guards: resolving the slug by JOINing through
     * `shop_variants` would find nothing here — the delete is a hard one — and
     * fall back to `{}`, leaving the product's own page cached with a colour
     * that no longer exists.
     */
    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('PUT /admin/variants/:id/price', async () => {
    const product = await newProduct();
    const variant = await newVariant(product.id);
    const res = await http.put(`/api/shop/admin/variants/${variant.id}/price`, {
      amount: 2_200_000,
      currency: 'NGN',
      reason: 'distributor raised the reel price',
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });

  it('POST /admin/inventory/:variantId/adjust', async () => {
    const product = await newProduct();
    const variant = await newVariant(product.id);
    const res = await http.post(`/api/shop/admin/inventory/${variant.id}/adjust`, {
      delta: 12,
      reason: 'restock',
    });
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{ slug: product.slug }]);
  });
});

describe('writes that are not scoped to one product purge the lists only', () => {
  it('POST /admin/categories', async () => {
    const res = await http.post('/api/shop/admin/categories', { name: `Cat ${(n += 1)}` });
    expect(res.status).toBe(201);

    expect(await purges()).toEqual([{}]);
  });

  it('PATCH /admin/categories/:id', async () => {
    const created = await http.post('/api/shop/admin/categories', { name: `Cat ${(n += 1)}` });
    const { category } = await json<{ category: { id: string } }>(created);
    await settleRevalidations();
    sent = [];

    const res = await http.patch(`/api/shop/admin/categories/${category.id}`, {
      name: `Renamed ${(n += 1)}`,
    });
    expect(res.status).toBe(200);

    // A rename rewrites an unknown number of products, so this is one unscoped
    // purge and never one per row.
    expect(await purges()).toEqual([{}]);
  });

  it('DELETE /admin/categories/:id', async () => {
    const created = await http.post('/api/shop/admin/categories', { name: `Cat ${(n += 1)}` });
    const { category } = await json<{ category: { id: string } }>(created);
    await settleRevalidations();
    sent = [];

    const res = await http.del(`/api/shop/admin/categories/${category.id}`);
    expect(res.status).toBe(200);

    expect(await purges()).toEqual([{}]);
  });
});

describe('what does NOT purge', () => {
  it('a read', async () => {
    const product = await newProduct();
    expect((await http.get('/api/shop/admin/products')).status).toBe(200);
    expect((await http.get(`/api/shop/admin/products/${product.id}`)).status).toBe(200);
    expect((await http.get('/api/shop/products')).status).toBe(200);

    expect(await purges()).toEqual([]);
  });

  it('a write that was REFUSED — a stale baseRevision changed nothing', async () => {
    const product = await newProduct();
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { title: 'Conflicting' },
      baseRevision: product.revision + 99,
    });
    expect(res.status).toBe(409);

    // The whole reason the call sits after the awaited repository function: a
    // refused write must not cost the storefront a re-render of every page.
    expect(await purges()).toEqual([]);
  });

  it('a write rejected at the schema, before any handler ran', async () => {
    const product = await newProduct();
    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { slug: 'client-supplied' },
      baseRevision: product.revision,
    });
    expect(res.status).toBe(400);

    expect(await purges()).toEqual([]);
  });

  it('an unauthenticated attempt', async () => {
    const product = await newProduct();
    http.clearCookies();
    const res = await http.del(`/api/shop/admin/products/${product.id}`);
    expect(res.status).toBe(401);
    expect(await purges()).toEqual([]);

    // Put the session back for whatever runs next.
    await http.signIn({ email: 'owner@test.local' });
  });
});

describe('a save does not depend on the storefront', () => {
  it('succeeds while the storefront is refusing every purge', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const product = await newProduct();
    setRevalidateTransport((async () => new Response('', { status: 500 })) as typeof fetch);

    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { title: 'Saved Anyway' },
      baseRevision: product.revision,
    });

    expect(res.status).toBe(200);
    await settleRevalidations();
  });

  it('succeeds while the storefront is unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const product = await newProduct();
    setRevalidateTransport((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);

    const res = await http.del(`/api/shop/admin/products/${product.id}`);

    expect(res.status).toBe(200);
    await settleRevalidations();
  });

  it('reaches no network at all from a suite that installed no recorder', async () => {
    /*
     * EVERY OTHER SERVER SUITE IN THIS REPOSITORY RUNS IN EXACTLY THIS STATE, so
     * this is the assertion that wiring revalidation into twelve routes put a
     * real POST to the live storefront into none of them — `nul-bytes.test.ts`
     * walks every route, and `routes.test.ts`, `lifecycle.test.ts`,
     * `categories.test.ts` and `case-fold.test.ts` all drive catalogue writes.
     *
     * The real `fetch` is watched rather than replaced: if the guard regresses
     * this fails, and it fails for the right reason.
     */
    const product = await newProduct();
    const realFetch = vi.spyOn(globalThis, 'fetch');
    setRevalidateTransport(null);

    const res = await http.patch(`/api/shop/admin/products/${product.id}`, {
      patch: { title: 'No Recorder Installed' },
      baseRevision: product.revision,
    });

    expect(res.status).toBe(200);
    await settleRevalidations();
    expect(realFetch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
