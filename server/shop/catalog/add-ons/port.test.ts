import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { seedProduct } from '../test/catalog-harness';
import { createAddOn } from './repo';
import { addOnPort } from './port';
import type { AddOnCartInput } from '../../../../shared/commerce/add-ons';

let ctx: TestCtx;
let pla: string;
let abs: string;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
  await ctx.db.execute(sql`DELETE FROM shop_products`);
  pla = (await seedProduct(ctx.db, ctx.users.owner, { title: 'PLA', category: 'Filament', tags: ['pla'] })).id;
  abs = (await seedProduct(ctx.db, ctx.users.owner, { title: 'ABS', category: 'Filament', tags: ['abs'] })).id;
});

const input = (over: Partial<AddOnCartInput> = {}): AddOnCartInput => ({
  currency: 'NGN',
  lines: [
    { productId: pla, variantId: 'var_1', sku: 'PLA-1', qty: 2, weightGrams: 1000, lineTotalMinor: 3_000_000 },
    { productId: abs, variantId: 'var_2', sku: 'ABS-1', qty: 1, weightGrams: null, lineTotalMinor: 1_200_000 },
  ],
  subtotalMinor: 4_200_000,
  address: null,
  shippingOptionId: null,
  signedIn: false,
  hasDiscountCode: false,
  choices: null,
  ...over,
});

describe('addOnPort.offers', () => {
  it('offers only ACTIVE add-ons, in position order, with the picture as a public URL', async () => {
    await createAddOn(ctx.db, { title: 'Draft one', priceMinor: 1, currency: 'NGN', rules: [{ when: [], then: 'ask' }] }, 1);
    const late = await createAddOn(ctx.db, { title: 'Note', priceMinor: 50_000, currency: 'NGN', status: 'active', position: 2, rules: [{ when: [], then: 'ask' }] }, 2);
    const box = await createAddOn(ctx.db, { title: 'Gift box', imageId: 'img_box', priceMinor: 150_000, currency: 'NGN', status: 'active', position: 1, rules: [{ when: [], then: 'include' }] }, 3);
    const offers = await addOnPort.offers(ctx.db, input());
    expect(offers.map((o) => o.id)).toEqual([box.id, late.id]);
    expect(offers[0]).toMatchObject({ mode: 'include', imageUrl: '/api/public/images/img_box', amount: { amount: 150_000, currency: 'NGN' } });
    expect(offers[1]?.imageUrl).toBeNull();
  });

  it('sees the cart products category and tags', async () => {
    await createAddOn(ctx.db, { title: 'Spool clip', priceMinor: 20_000, currency: 'NGN', status: 'active', rules: [{ when: [{ attribute: 'tag', op: 'any_in', values: ['abs'] }], then: 'ask' }] }, 1);
    expect((await addOnPort.offers(ctx.db, input())).length).toBe(1);
    expect((await addOnPort.offers(ctx.db, input({ lines: [input().lines[0]!] }))).length).toBe(0);
  });

  it('answers [] with no active add-ons and never throws for a product it cannot find', async () => {
    expect(await addOnPort.offers(ctx.db, input())).toEqual([]);
    await createAddOn(ctx.db, { title: 'Box', priceMinor: 1, currency: 'NGN', status: 'active', rules: [{ when: [{ attribute: 'category', op: 'none_in', values: ['Filament'] }], then: 'ask' }] }, 1);
    const offers = await addOnPort.offers(ctx.db, input({ lines: [{ productId: 'prd_gone', variantId: 'v', sku: 's', qty: 1, weightGrams: null, lineTotalMinor: 1 }] }));
    expect(offers.length).toBe(1);
  });

  it('carries the shopper choice through', async () => {
    const box = await createAddOn(ctx.db, { title: 'Box', priceMinor: 1, currency: 'NGN', status: 'active', rules: [{ when: [], then: 'ask' }] }, 1);
    const [offer] = await addOnPort.offers(ctx.db, input({ choices: { [box.id]: 'declined' } }));
    expect(offer?.choice).toBe('declined');
  });
});
