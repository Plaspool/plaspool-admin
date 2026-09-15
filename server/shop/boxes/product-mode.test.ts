/**
 * A product becomes a mystery box (migration 1220), through the real app.
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

async function patch(id: string, body: Record<string, unknown>) {
  const current = (await getProduct(ctx.db, id))!;
  return client.patch(`/api/shop/admin/products/${id}`, { baseRevision: current.revision, patch: body });
}

describe('a product becomes a mystery box', () => {
  it('reads as an ordinary product by default — the value every existing row holds', async () => {
    const plain = await ordinary(ctx.db, ctx.users.owner, { title: 'Plain spool', onHand: 5 });
    expect((await getProduct(ctx.db, plain.productId))?.boxMode).toBeNull();
  });

  it('switches on as pack, and turns bulk discounts off in the same save unless told otherwise', async () => {
    const p = await ordinary(ctx.db, ctx.users.owner, { title: 'Box A', onHand: 5 });
    expect((await getProduct(ctx.db, p.productId))?.bulkDiscountEnabled).toBe(true);
    const res = await patch(p.productId, { boxMode: 'pack' });
    expect(res.status).toBe(200);
    const saved = await getProduct(ctx.db, p.productId);
    expect(saved?.boxMode).toBe('pack');
    expect(saved?.bulkDiscountEnabled).toBe(false);
  });

  it('keeps an explicit bulk discount choice sent with the switch', async () => {
    const p = await ordinary(ctx.db, ctx.users.owner, { title: 'Box B', onHand: 5 });
    await patch(p.productId, { boxMode: 'pack', bulkDiscountEnabled: true });
    expect((await getProduct(ctx.db, p.productId))?.bulkDiscountEnabled).toBe(true);
  });

  it('leaves bulk discounts alone on a save that does not touch the box', async () => {
    const p = await ordinary(ctx.db, ctx.users.owner, { title: 'Box B2', onHand: 5 });
    await patch(p.productId, { boxMode: 'pack', bulkDiscountEnabled: true });
    await patch(p.productId, { title: 'Box B2 renamed' });
    expect((await getProduct(ctx.db, p.productId))?.bulkDiscountEnabled).toBe(true);
  });

  it('refuses the modes later phases own', async () => {
    const p = await ordinary(ctx.db, ctx.users.owner, { title: 'Box C', onHand: 5 });
    for (const mode of ['built', 'auto']) {
      expect((await patch(p.productId, { boxMode: mode })).status).toBe(400);
    }
  });

  it('switches back off when no order is waiting on a box', async () => {
    const p = await ordinary(ctx.db, ctx.users.owner, { title: 'Box D', onHand: 5 });
    await patch(p.productId, { boxMode: 'pack' });
    const res = await patch(p.productId, { boxMode: null });
    expect(res.status).toBe(200);
    expect((await getProduct(ctx.db, p.productId))?.boxMode).toBeNull();
  });

  it('refuses to switch off while a paid order still has an unfilled box', async () => {
    await ordinary(ctx.db, ctx.users.owner, { title: 'PLA in the pool', onHand: 9, tags: ['mystery-pla'] });
    const b = await box(ctx.db, ctx.users.owner, { title: 'Box E', tag: 'mystery-pla', itemCount: 3 });
    await paidOrder(ctx.db, [{ item: b, qty: 1 }]);
    const res = await patch(b.productId, { boxMode: null });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'box_has_open_orders' });
    expect((await getProduct(ctx.db, b.productId))?.boxMode).toBe('pack');
  });
});
