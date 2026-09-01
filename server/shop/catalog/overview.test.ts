import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';

/**
 * The product overview (migration 0580), driven through the REAL app.
 *
 * The claim under test is that `overview` on the storefront wire is ALWAYS a
 * usable string — hand-written when there is one, derived from the first block
 * of the description when there is not — so the storefront can delete its own
 * first-line derivation and never see a null.
 *
 * THE LIST ROUTE IS TESTED SEPARATELY FROM THE DETAIL ROUTE, and that split is
 * the point rather than thoroughness for its own sake. `LIST_PRODUCT_COLUMNS`
 * excludes `description`, so the list has no document to derive from and must
 * read the stored `overview_fallback`. A suite that only checked the detail
 * route would pass with the fallback column never populated, and every card in
 * the shop would render an empty summary.
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

const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
});

interface AdminProduct {
  id: string;
  slug: string | null;
  overview: string | null;
  overviewFallback: string;
  bulkDiscountEnabled: boolean;
  revision: number;
}

async function createProduct(title: string): Promise<AdminProduct> {
  const res = await http.post('/api/shop/admin/products', { title, category: 'Filament' });
  expect(res.status).toBe(201);
  return (await json<{ product: AdminProduct }>(res)).product;
}

async function patch(id: string, body: Record<string, unknown>): Promise<AdminProduct> {
  const res = await http.patch(`/api/shop/admin/products/${id}`, { patch: body });
  expect(res.status).toBe(200);
  return (await json<{ product: AdminProduct }>(res)).product;
}

async function publish(id: string): Promise<void> {
  expect((await http.post(`/api/shop/admin/products/${id}/publish`, {})).status).toBe(200);
}

const detail = async (slug: string) =>
  (await json<{ product: { overview: string } }>(await http.get(`/api/shop/products/${slug}`)))
    .product;

const listed = async (id: string) =>
  (
    await json<{ items: Array<{ id: string; overview: string }> }>(
      await http.get('/api/shop/products?category=Filament'),
    )
  ).items.find((p) => p.id === id);

describe('the derived fallback', () => {
  it('is the FIRST BLOCK of the description, not the whole document', async () => {
    // The trap `firstBlockText` exists for: `docToText` collapses newlines, so a
    // naive first-line implementation returns every paragraph concatenated.
    await login();
    const p = await createProduct('Derived');
    const saved = await patch(p.id, {
      description: doc('Matte PLA that prints clean.', 'A second paragraph nobody asked for.'),
    });
    expect(saved.overviewFallback).toBe('Matte PLA that prints clean.');
    expect(saved.overview).toBeNull();

    await publish(p.id);
    expect((await detail(saved.slug!)).overview).toBe('Matte PLA that prints clean.');
  });

  it('reaches the LIST route, which has no description to derive from', async () => {
    await login();
    const p = await createProduct('Listed');
    await patch(p.id, { description: doc('The card line.', 'Not the card line.') });
    await publish(p.id);
    expect((await listed(p.id))?.overview).toBe('The card line.');
  });

  it('is recomputed on every save, so it cannot go stale', async () => {
    await login();
    const p = await createProduct('Edited');
    await patch(p.id, { description: doc('Original opening.') });
    const after = await patch(p.id, { description: doc('Rewritten opening.') });
    expect(after.overviewFallback).toBe('Rewritten opening.');
  });
});

describe('the hand-written overview', () => {
  it('wins over the derived one on both routes', async () => {
    await login();
    const p = await createProduct('Overridden');
    const saved = await patch(p.id, {
      description: doc('The description opening.'),
      overview: 'A better summary, written by hand.',
    });
    expect(saved.overview).toBe('A better summary, written by hand.');
    // The derived value is still maintained underneath, so clearing restores it.
    expect(saved.overviewFallback).toBe('The description opening.');

    await publish(p.id);
    expect((await detail(saved.slug!)).overview).toBe('A better summary, written by hand.');
    expect((await listed(p.id))?.overview).toBe('A better summary, written by hand.');
  });

  it("'' clears back to deriving it, rather than storing an empty summary", async () => {
    // Same normaliser as the SEO pair: '' and null are one instruction, so the
    // projection has ONE spelling of "unset" to test rather than two.
    await login();
    const p = await createProduct('Cleared');
    await patch(p.id, { description: doc('Fall back to me.'), overview: 'Temporary.' });
    const cleared = await patch(p.id, { overview: '' });
    expect(cleared.overview).toBeNull();

    await publish(p.id);
    expect((await detail(cleared.slug!)).overview).toBe('Fall back to me.');
  });

  it('null clears it too', async () => {
    await login();
    const p = await createProduct('Nulled');
    await patch(p.id, { description: doc('Derived again.'), overview: 'Temporary.' });
    expect((await patch(p.id, { overview: null })).overview).toBeNull();
  });

  it('refuses one over 500 characters with a 400 naming the field', async () => {
    await login();
    const p = await createProduct('TooLong');
    const res = await http.patch(`/api/shop/admin/products/${p.id}`, {
      patch: { overview: 'x'.repeat(501) },
    });
    expect(res.status).toBe(400);
    // The full path, not the bare key: `patch.overview` is what the caller has
    // to go and fix, and a form with two nested objects needs to be told which.
    expect(await json<{ detail: string }>(res)).toMatchObject({ detail: 'patch.overview' });
  });
});

describe('an empty description', () => {
  it('yields an empty overview rather than throwing', async () => {
    // A brand-new draft has `{ type: 'doc', content: [] }` and no summary is the
    // honest answer — not a crash, and not the title masquerading as one.
    await login();
    const p = await createProduct('Blank');
    expect(p.overviewFallback).toBe('');
    expect(p.overview).toBeNull();
  });
});

describe('bulkDiscountEnabled', () => {
  it('defaults to true on a new product, from the column default', async () => {
    await login();
    expect((await createProduct('Fresh')).bulkDiscountEnabled).toBe(true);
  });

  it('is patchable, and absence leaves it alone', async () => {
    await login();
    const p = await createProduct('Toggled');
    expect((await patch(p.id, { bulkDiscountEnabled: false })).bulkDiscountEnabled).toBe(false);
    // A patch that does not mention it must not turn it back on.
    expect((await patch(p.id, { title: 'Renamed' })).bulkDiscountEnabled).toBe(false);
    expect((await patch(p.id, { bulkDiscountEnabled: true })).bulkDiscountEnabled).toBe(true);
  });
});
