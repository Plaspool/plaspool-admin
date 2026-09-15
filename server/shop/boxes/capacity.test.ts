/**
 * How many boxes a pool can fill, and the sold-out state it drives
 * (migration 1220; owner's decision 8).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from '../orders/test/app';
import { resetOrderTables } from '../orders/test/harness';
import { reserve } from '../catalog/inventory';
import { boxCapacitySql } from './capacity';
import { box, ordinary, paidOrder, setOnHand, type Sellable } from './test/box-harness';

let ctx: TestCtx;
let client: OrdersClient;
let petgBox: Sellable;
let black: Sellable;
let clear: Sellable;
let orange: Sellable;

async function capacity(variantId: string): Promise<number | null> {
  const res = await ctx.db.execute(sql`SELECT ${boxCapacitySql(sql`${variantId}::text`)} AS c`);
  return res.rows[0].c == null ? null : Number(res.rows[0].c);
}

beforeAll(async () => {
  ctx = await freshDb();
  const owner = ctx.users.owner;
  black = await ordinary(ctx.db, owner, { title: 'PETG Black', onHand: 4, tags: ['mystery-petg'] });
  clear = await ordinary(ctx.db, owner, { title: 'PETG Clear', onHand: 2, tags: ['mystery-petg'] });
  orange = await ordinary(ctx.db, owner, { title: 'PETG Orange', onHand: 1, tags: ['mystery-petg'] });
  /* A draft in the pool must not count, however much of it there is. */
  const draft = await ordinary(ctx.db, owner, { title: 'PETG Draft', onHand: 50, tags: ['mystery-petg'] });
  await ctx.db.execute(sql`UPDATE shop_products SET status = 'draft' WHERE id = ${draft.productId}`);
  petgBox = await box(ctx.db, owner, { title: 'PETG box', tag: 'mystery-petg', itemCount: 3 });
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
  await setOnHand(ctx.db, black.variantId, 4);
  await setOnHand(ctx.db, clear.variantId, 2);
  await setOnHand(ctx.db, orange.variantId, 1);
  await setOnHand(ctx.db, petgBox.variantId, 100);
  await ctx.db.execute(sql`
    UPDATE shop_variants SET box_pool_tag = 'mystery-petg', box_item_count = 3 WHERE id = ${petgBox.variantId}`);
  client = ordersClient(ctx.db);
  await client.signIn(ctx.users.owner);
});

const hold = (id: string, variantId: string, qty: number) =>
  reserve(ctx.db, { reservationId: id, variantId, qty, expiresAt: Date.now() + 60_000 });

describe('how many boxes a pool can fill', () => {
  it('counts only active, in-stock pool items: 7 units fill two boxes of 3', async () => {
    expect(await capacity(petgBox.variantId)).toBe(2);
  });

  it('is NULL for an ordinary variant, so ordinary stock rules apply unchanged', async () => {
    expect(await capacity(black.variantId)).toBeNull();
  });

  it('is 0 for a box variant with no pool', async () => {
    await ctx.db.execute(sql`
      UPDATE shop_variants SET box_pool_tag = NULL, box_item_count = NULL WHERE id = ${petgBox.variantId}`);
    expect(await capacity(petgBox.variantId)).toBe(0);
  });

  it('subtracts what a held cart already owes: one box in a cart leaves one', async () => {
    expect((await hold('res_cart', petgBox.variantId, 1)).ok).toBe(true);
    expect(await capacity(petgBox.variantId)).toBe(1);
  });

  it('subtracts what a paid, unfilled box already owes', async () => {
    await paidOrder(ctx.db, [{ item: petgBox, qty: 1 }]);
    expect(await capacity(petgBox.variantId)).toBe(1);
  });

  it('refuses a reservation the pool cannot cover, as insufficient', async () => {
    const res = await hold('res_many', petgBox.variantId, 3);
    expect(res).toMatchObject({ ok: false, reason: 'insufficient', available: 2 });
  });

  it('still sells an ordinary product exactly as before', async () => {
    expect((await hold('res_plain', black.variantId, 4)).ok).toBe(true);
  });

  it('reports a thin pool on the storefront availability route', async () => {
    await setOnHand(ctx.db, black.variantId, 1);
    const res = await client.get(`/api/shop/variants/${petgBox.variantId}/availability`);
    expect(await json(res)).toMatchObject({ variantId: petgBox.variantId, available: 1, canFill: 1 });
  });

  it('says sold out on the availability route once the pool cannot fill one', async () => {
    await setOnHand(ctx.db, black.variantId, 0);
    await setOnHand(ctx.db, clear.variantId, 0);
    const res = await client.get(`/api/shop/variants/${petgBox.variantId}/availability`);
    expect(await json(res)).toMatchObject({ available: 0, canFill: 0 });
  });

  it('answers canFill null for an ordinary variant', async () => {
    const res = await client.get(`/api/shop/variants/${black.variantId}/availability`);
    expect(await json(res)).toMatchObject({ available: 4, canFill: null });
  });

  it('previews a pool for the admin: its in-stock items and free units', async () => {
    const res = await client.get('/api/shop/admin/box-pools/mystery-petg');
    expect(res.status).toBe(200);
    const { pool } = await json<{ pool: { freeUnits: number; items: { productTitle: string; available: number }[] } }>(res);
    expect(pool.freeUnits).toBe(7);
    expect(pool.items.map((i) => [i.productTitle, i.available])).toEqual([
      ['PETG Black', 4],
      ['PETG Clear', 2],
      ['PETG Orange', 1],
    ]);
  });
});
