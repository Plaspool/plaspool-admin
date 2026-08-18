/**
 * `GET /api/shop/products` carries variants, and the batched query that makes
 * that one statement rather than N.
 *
 * WHY THIS EXISTS AT ALL: A SUBREQUEST BUDGET IN ANOTHER REPOSITORY. The list
 * used to omit variants, so the storefront had to read it and then fetch one
 * detail response per product to learn any price — `price` lives on a variant.
 * That storefront is Next.js on Cloudflare Workers, where a request has a
 * 50-subrequest cap on the free plan and a CPU budget plaspool-storefront#9
 * (Error 1102) was only just brought inside, so a fifty-product catalogue would
 * have failed at the platform level rather than merely rendered slowly.
 *
 * The properties worth pinning are therefore: the data is THERE (so one request
 * suffices), it is GROUPED CORRECTLY (so no product shows another's prices —
 * the failure a `= ANY` query with a bad group-by produces), and it AGREES with
 * the detail route (so a card and its page cannot quote different money).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestCtx } from '../../test/harness';
import { httpClient, json, type HttpClient } from '../../test/http';
import { listVariantsForProducts } from './variants';
import { seedProduct, seedSellable, seedVariant } from './test/catalog-harness';
import type { VariantWithPrice } from './types';

let ctx: TestCtx;
let http: HttpClient;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

interface ListItem {
  id: string;
  slug: string | null;
  variants: VariantWithPrice[];
}

const list = async (): Promise<ListItem[]> =>
  (await json<{ items: ListItem[] }>(await http.get('/api/shop/products'))).items;

describe('the list carries variants', () => {
  it('gives every item a variants array, so one request is enough to price a card', async () => {
    const { product, variant } = await seedSellable(ctx.db, actor(), { title: 'Listed Spool' });

    const item = (await list()).find((i) => i.id === product.id);
    expect(item).toBeDefined();
    expect(item?.variants.map((v) => v.id)).toContain(variant.id);
  });

  /*
   * A product with none is an empty array rather than an absent key: a JSON
   * response cannot carry a `Map#get` miss, and every consumer would otherwise
   * need to branch on undefined before it could iterate.
   */
  it('gives a product with no variants an empty array, not a missing key', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Bare Product' });
    const { publishProduct } = await import('./products');
    await publishProduct(ctx.db, product.id, actor());

    const item = (await list()).find((i) => i.id === product.id);
    expect(item).toBeDefined();
    expect(item?.variants).toEqual([]);
  });

  /*
   * THE FAILURE A BATCHED QUERY ACTUALLY PRODUCES. `= ANY(...)` returns every
   * matching row in one result set; if the grouping is wrong, one product gets
   * another's variants — and since variants carry prices, that is a card quoting
   * the wrong money. Two products with variants at once is the only arrangement
   * that can catch it.
   */
  it('does not leak one product’s variants onto another', async () => {
    const a = await seedSellable(ctx.db, actor(), { title: 'Grouping A' });
    const b = await seedSellable(ctx.db, actor(), { title: 'Grouping B' });

    const items = await list();
    const itemA = items.find((i) => i.id === a.product.id);
    const itemB = items.find((i) => i.id === b.product.id);

    expect(itemA?.variants.map((v) => v.id)).toEqual([a.variant.id]);
    expect(itemB?.variants.map((v) => v.id)).toEqual([b.variant.id]);
    for (const variant of itemA?.variants ?? []) {
      expect(variant.productId).toBe(a.product.id);
    }
  });

  /* A card and its own page must not be able to quote different money. */
  it('agrees with the detail route about the same product', async () => {
    const { product } = await seedSellable(ctx.db, actor(), { title: 'Agreeing Spool' });
    const slug = product.slug as string;

    const item = (await list()).find((i) => i.id === product.id);
    const detail = await json<{ product: { variants: VariantWithPrice[] } }>(
      await http.get(`/api/shop/products/${slug}`),
    );

    expect(item?.variants).toEqual(detail.product.variants);
  });
});

describe('listVariantsForProducts', () => {
  /* `createVariant` assigns `position` in creation order, so this pins the
   * ORDER BY rather than the assignment — the same order the detail route
   * returns, which is what stops a colour picker from reshuffling per page. */
  it('groups by product and orders by position', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Ordered Variants' });
    const first = await seedVariant(ctx.db, product.id, actor(), { sku: 'ORD-1' });
    const second = await seedVariant(ctx.db, product.id, actor(), { sku: 'ORD-2' });

    const grouped = await listVariantsForProducts(ctx.db, [product.id]);
    const ids = grouped.get(product.id)?.map((v) => v.id);
    expect(ids).toEqual([first.id, second.id]);
    const positions = grouped.get(product.id)?.map((v) => v.position) ?? [];
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  /* No ids means no statement — `= ANY('{}')` is valid but a pointless round
   * trip, and callers pass an empty list whenever a page came back empty. */
  it('answers an empty map for no ids without touching the database', async () => {
    expect((await listVariantsForProducts(ctx.db, [])).size).toBe(0);
  });

  it('omits a product that has no variants rather than mapping it to an empty array', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'No Variants At All' });
    const grouped = await listVariantsForProducts(ctx.db, [product.id]);
    expect(grouped.has(product.id)).toBe(false);
  });
});
