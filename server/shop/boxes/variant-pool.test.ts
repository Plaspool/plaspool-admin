/**
 * A box variant names its pool and how many items it holds (migration 1220).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from '../orders/test/app';
import { resetOrderTables } from '../orders/test/harness';
import { getProduct } from '../catalog/products';
import { box, ordinary, paidOrder } from './test/box-harness';

let ctx: TestCtx;
let client: OrdersClient;

beforeAll(async () => {
  ctx = await freshDb();
  /* Puts `mystery-petg` into the catalogue's tag vocabulary, in that spelling. */
  await ordinary(ctx.db, ctx.users.owner, { title: 'PETG Black', onHand: 20, tags: ['mystery-petg'] });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM shop_inventory_holds`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  client = ordersClient(ctx.db);
  await client.signIn(ctx.users.owner);
});

async function boxProduct(title: string): Promise<string> {
  const p = await ordinary(ctx.db, ctx.users.owner, { title, onHand: 5 });
  const current = (await getProduct(ctx.db, p.productId))!;
  const res = await client.patch(`/api/shop/admin/products/${p.productId}`, {
    baseRevision: current.revision,
    patch: { boxMode: 'pack' },
  });
  expect(res.status).toBe(200);
  return p.productId;
}

const createVariant = (productId: string, body: Record<string, unknown>) =>
  client.post(`/api/shop/admin/products/${productId}/variants`, body);

describe('a box variant names its pool', () => {
  it('stores the pool in the catalogue’s spelling of the tag, with its count', async () => {
    const productId = await boxProduct('PETG box');
    const res = await createVariant(productId, { sku: 'MB-PETG-3', boxPool: { tag: 'MYSTERY-PETG', itemCount: 3 } });
    expect(res.status).toBe(201);
    const { variant } = await json<{ variant: { boxPoolTag: string; boxItemCount: number } }>(res);
    expect(variant.boxPoolTag).toBe('mystery-petg');
    expect(variant.boxItemCount).toBe(3);
  });

  it('refuses a new variant of a box with no pool', async () => {
    const productId = await boxProduct('Poolless box');
    const res = await createVariant(productId, { sku: 'MB-NONE' });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'boxPool' });
  });

  it('refuses a pool on an ordinary product', async () => {
    const plain = await ordinary(ctx.db, ctx.users.owner, { title: 'Plain', onHand: 5 });
    const res = await createVariant(plain.productId, { sku: 'PLAIN-1', boxPool: { tag: 'mystery-petg', itemCount: 3 } });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'boxPool' });
  });

  it('refuses a count of zero before it reaches the database', async () => {
    const productId = await boxProduct('Zero box');
    const res = await createVariant(productId, { sku: 'MB-ZERO', boxPool: { tag: 'mystery-petg', itemCount: 0 } });
    expect(res.status).toBe(400);
  });

  it('changes the pool and count on update, and leaves them alone when the key is absent', async () => {
    const productId = await boxProduct('Changing box');
    const { variant } = await json<{ variant: { id: string } }>(
      await createVariant(productId, { sku: 'MB-CHG', boxPool: { tag: 'mystery-petg', itemCount: 3 } }),
    );
    expect((await client.patch(`/api/shop/admin/variants/${variant.id}`, { boxPool: { tag: 'mystery-petg', itemCount: 5 } })).status).toBe(200);
    const after = await json<{ variant: { boxItemCount: number; boxPoolTag: string } }>(
      await client.patch(`/api/shop/admin/variants/${variant.id}`, { position: 1 }),
    );
    expect(after.variant.boxItemCount).toBe(5);
    expect(after.variant.boxPoolTag).toBe('mystery-petg');
  });

  it('refuses to clear the pool while a paid order still waits on that box', async () => {
    const b = await box(ctx.db, ctx.users.owner, { title: 'Busy box', tag: 'mystery-petg', itemCount: 3 });
    await paidOrder(ctx.db, [{ item: b, qty: 1 }]);
    const res = await client.patch(`/api/shop/admin/variants/${b.variantId}`, { boxPool: null });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'box_has_open_orders' });
  });

  it('is an ordinary variant by default — the value every existing row holds', async () => {
    const plain = await ordinary(ctx.db, ctx.users.owner, { title: 'Ordinary', onHand: 5 });
    const { product } = await json<{ product: { variants: { boxPoolTag: unknown; boxItemCount: unknown }[] } }>(
      await client.get(`/api/shop/admin/products/${plain.productId}`),
    );
    expect(product.variants[0].boxPoolTag).toBeNull();
    expect(product.variants[0].boxItemCount).toBeNull();
  });
});
