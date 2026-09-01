import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import type { BulkTier } from '../../../shared/commerce/catalog-port';

/**
 * Bulk quantity ladders (migration 0600), driven through the REAL app.
 *
 * THROUGH HTTP AND NOT AGAINST THE REPO, per CLAUDE.md §2: this feature decides
 * what a customer is charged, and the seam between the repository and the wire
 * is where its defects would be — the strict Zod bounds, the inherit/override
 * split, and whether the storefront's resolved ladder agrees with the admin's
 * stored one. A repo-level suite would pass with the routes unmounted.
 *
 * The SQL under test is the part worth driving against a real database rather
 * than a fake: `replaceTiers` is an upsert-plus-prune inside one statement, and
 * `resolveTiers` leans on `IS NOT DISTINCT FROM` and a NOT EXISTS correlation
 * that no in-memory double would reproduce.
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

async function createProduct(title: string): Promise<string> {
  const res = await http.post('/api/shop/admin/products', { title, category: 'Filament' });
  expect(res.status).toBe(201);
  return (await json<{ product: { id: string } }>(res)).product.id;
}

interface TierResponse {
  tiers: BulkTier[];
  inherited?: boolean;
  effective?: BulkTier[];
}

const getTiers = async (path: string): Promise<TierResponse> =>
  json<TierResponse>(await http.get(path));

const putTiers = async (path: string, tiers: BulkTier[]) =>
  http.put(path, { tiers });

// ------------------------------------------------------------------ defaults

describe('the seeded store-wide ladder', () => {
  it('is 5% at three, 10% at five, 15% at ten, straight out of migration 0600', async () => {
    await login();
    expect((await getTiers('/api/shop/admin/bulk-tiers')).tiers).toEqual([
      { minQty: 3, percentBps: 500 },
      { minQty: 5, percentBps: 1000 },
      { minQty: 10, percentBps: 1500 },
    ]);
  });

  it('applies to a brand-new product with no ladder of its own', async () => {
    await login();
    const id = await createProduct('Inherits');
    const body = await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`);
    expect(body.tiers).toEqual([]);
    expect(body.inherited).toBe(true);
    expect(body.effective).toHaveLength(3);
  });
});

// ----------------------------------------------------------------- overrides

describe('a per-product override', () => {
  it('REPLACES the default wholesale rather than merging with it', async () => {
    // Merging would produce a ladder nobody can predict from either input, and
    // would make "drop the 10+ rung for this product" unexpressible.
    await login();
    const id = await createProduct('Overridden');
    expect((await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [
      { minQty: 4, percentBps: 2000 },
    ])).status).toBe(200);

    const body = await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`);
    expect(body.tiers).toEqual([{ minQty: 4, percentBps: 2000 }]);
    expect(body.inherited).toBe(false);
    // The 3/5/10 rungs are GONE for this product, not merged in beside it.
    expect(body.effective).toEqual([{ minQty: 4, percentBps: 2000 }]);
  });

  it('leaves every other product on the default', async () => {
    await login();
    const mine = await createProduct('Special');
    const theirs = await createProduct('Ordinary');
    await putTiers(`/api/shop/admin/products/${mine}/bulk-tiers`, [
      { minQty: 2, percentBps: 100 },
    ]);
    expect((await getTiers(`/api/shop/admin/products/${theirs}/bulk-tiers`)).effective).toHaveLength(
      3,
    );
  });

  it('an EMPTY ladder is the reset — it returns the product to inheriting', async () => {
    await login();
    const id = await createProduct('Resettable');
    await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [{ minQty: 6, percentBps: 900 }]);
    expect((await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`)).inherited).toBe(false);

    expect((await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [])).status).toBe(200);
    const body = await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`);
    expect(body.tiers).toEqual([]);
    expect(body.inherited).toBe(true);
    expect(body.effective).toHaveLength(3);
  });

  it('re-PUTting the SAME rungs is not a unique-index violation', async () => {
    /*
     * The regression this pins. `replaceTiers` used to DELETE the scope and
     * re-INSERT it inside one statement, and a data-modifying CTE's effects are
     * not visible to the rest of the statement — so re-inserting a rung the CTE
     * had just deleted raced `shop_bulk_tiers_scope_qty_idx` for a 23505 on the
     * most ordinary edit there is: opening the editor and pressing Save.
     */
    await login();
    const id = await createProduct('Idempotent');
    const ladder = [
      { minQty: 3, percentBps: 500 },
      { minQty: 5, percentBps: 1000 },
    ];
    for (let i = 0; i < 3; i += 1) {
      expect((await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, ladder)).status).toBe(200);
    }
    expect((await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`)).tiers).toEqual(ladder);
  });

  it('prunes rungs the caller dropped', async () => {
    await login();
    const id = await createProduct('Pruned');
    await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [
      { minQty: 3, percentBps: 500 },
      { minQty: 5, percentBps: 1000 },
      { minQty: 10, percentBps: 1500 },
    ]);
    await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [{ minQty: 5, percentBps: 2000 }]);
    expect((await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`)).tiers).toEqual([
      { minQty: 5, percentBps: 2000 },
    ]);
  });

  it('404s for a product that does not exist, rather than a foreign-key 500', async () => {
    await login();
    expect((await putTiers('/api/shop/admin/products/prd_nope/bulk-tiers', [])).status).toBe(404);
  });
});

// -------------------------------------------------------- editing the default

describe('editing the store-wide ladder', () => {
  it('moves every inheriting product at once', async () => {
    await login();
    const id = await createProduct('Follower');
    expect(
      (await putTiers('/api/shop/admin/bulk-tiers', [{ minQty: 2, percentBps: 250 }])).status,
    ).toBe(200);

    expect((await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`)).effective).toEqual([
      { minQty: 2, percentBps: 250 },
    ]);

    // Put it back, so ordering between tests cannot leak.
    await putTiers('/api/shop/admin/bulk-tiers', [
      { minQty: 3, percentBps: 500 },
      { minQty: 5, percentBps: 1000 },
      { minQty: 10, percentBps: 1500 },
    ]);
  });

  it('does not disturb a product that has overridden it', async () => {
    await login();
    const id = await createProduct('Independent');
    await putTiers(`/api/shop/admin/products/${id}/bulk-tiers`, [{ minQty: 7, percentBps: 700 }]);
    await putTiers('/api/shop/admin/bulk-tiers', [{ minQty: 2, percentBps: 100 }]);

    expect((await getTiers(`/api/shop/admin/products/${id}/bulk-tiers`)).effective).toEqual([
      { minQty: 7, percentBps: 700 },
    ]);

    await putTiers('/api/shop/admin/bulk-tiers', [
      { minQty: 3, percentBps: 500 },
      { minQty: 5, percentBps: 1000 },
      { minQty: 10, percentBps: 1500 },
    ]);
  });
});

// -------------------------------------------------------------------- bounds

describe('the route refuses what the CHECK constraints would', () => {
  /*
   * Restated in Zod rather than left to the database, because a 23514 surfaces
   * as a 500 naming a constraint the caller has never heard of. These need to
   * come back as a 400 that says which field.
   */
  it('refuses a rung at qty 1 — that is a price change, not a bulk discount', async () => {
    await login();
    expect(
      (await putTiers('/api/shop/admin/bulk-tiers', [{ minQty: 1, percentBps: 500 }])).status,
    ).toBe(400);
  });

  it('refuses 0% and anything over 50%', async () => {
    await login();
    expect(
      (await putTiers('/api/shop/admin/bulk-tiers', [{ minQty: 3, percentBps: 0 }])).status,
    ).toBe(400);
    expect(
      (await putTiers('/api/shop/admin/bulk-tiers', [{ minQty: 3, percentBps: 5001 }])).status,
    ).toBe(400);
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    await login();
    const res = await http.put('/api/shop/admin/bulk-tiers', {
      tiers: [{ minQty: 3, percentBps: 500, label: 'nope' }],
    });
    expect(res.status).toBe(400);
  });

  it('needs a session', async () => {
    await http.post('/api/auth/logout', {});
    expect((await http.get('/api/shop/admin/bulk-tiers')).status).toBe(401);
  });
});

// ---------------------------------------------------------- the public wire

describe('what the storefront receives', () => {
  it('carries the RESOLVED ladder, so the storefront needs no second rule', async () => {
    await login();
    const id = await createProduct('Public Spool');
    expect((await http.post(`/api/shop/admin/products/${id}/publish`, {})).status).toBe(200);

    const body = await json<{ items: Array<{ id: string; bulkTiers: BulkTier[] }> }>(
      await http.get('/api/shop/products?category=Filament'),
    );
    const found = body.items.find((p) => p.id === id);
    expect(found?.bulkTiers).toHaveLength(3);
  });

  it('is EMPTY when the product has bulk discounts switched off', async () => {
    // The switch wins over every row, so turning it off needs no row deleted —
    // and an empty array on the wire is a complete answer meaning "none".
    await login();
    const id = await createProduct('Switched Off');
    await http.post(`/api/shop/admin/products/${id}/publish`, {});
    expect(
      (
        await http.patch(`/api/shop/admin/products/${id}`, {
          patch: { bulkDiscountEnabled: false },
        })
      ).status,
    ).toBe(200);

    const body = await json<{ items: Array<{ id: string; bulkTiers: BulkTier[] }> }>(
      await http.get('/api/shop/products?category=Filament'),
    );
    expect(body.items.find((p) => p.id === id)?.bulkTiers).toEqual([]);
  });
});
