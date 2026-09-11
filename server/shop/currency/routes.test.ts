/**
 * The admin half of the published multipliers (1140), through the real
 * `createApp()`. What matters most is the REVISION: every change that moves a
 * converted number must move it, or a storefront showing yesterday's numbers
 * would be charged today's without being told.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, TEST_ORIGIN } from '../../test/http';
import { seedProduct, seedVariant } from '../catalog/test/catalog-harness';
import { readFxState, writeFeedMultiplier } from './state';

let ctx: TestCtx;
const H = { headers: { Origin: TEST_ORIGIN } };

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_fx_rates`);
  await ctx.db.execute(sql`DELETE FROM shop_variant_multipliers`);
  await ctx.db.execute(sql`UPDATE shop_currency_settings SET enabled = '{NGN}', revision = 1 WHERE id = 'main'`);
  await ctx.db.execute(sql`
    UPDATE shop_payment_settings SET flutterwave_currencies = '{NGN,GHS}' WHERE id = 'main'`);
});

async function revision(): Promise<number> {
  return (await readFxState(ctx.db)).revision;
}

async function owner() {
  const client = httpClient(ctx.db);
  await client.signIn(ctx.users.owner);
  return client;
}

describe('the currency screen', () => {
  it('says why a switched-on currency is not offered', async () => {
    const client = await owner();
    let res = await client.patch('/api/shop/admin/payments/currency', { enabled: ['GHS'], revision: 1 }, H);
    expect(res.status).toBe(200);
    let view = (await res.json()) as { revision: number; currencies: Array<{ code: string; offered: boolean; reason: string | null }> };
    expect(view.revision).toBe(2);
    expect(view.currencies.find((c) => c.code === 'GHS')).toMatchObject({ offered: false, reason: 'no_rate' });

    res = await client.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier: '0.0085' }, H);
    view = (await res.json()) as typeof view;
    expect(view.revision).toBe(3);
    expect(view.currencies.find((c) => c.code === 'GHS')).toMatchObject({
      offered: true,
      reason: null,
      multiplier: '0.008500000000',
      source: 'manual',
    });
  });

  it('refuses a stale revision rather than undoing another tab', async () => {
    const client = await owner();
    const res = await client.patch('/api/shop/admin/payments/currency', { enabled: ['GHS'], revision: 99 }, H);
    expect(res.status).toBe(409);
    expect(await revision()).toBe(1);
  });

  it('refuses a multiplier it cannot represent exactly', async () => {
    const client = await owner();
    for (const multiplier of ['-1', '1e-3', '0.0000000000001', '0']) {
      const res = await client.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier }, H);
      expect(res.status, multiplier).toBe(400);
    }
    const res = await client.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier: 0.0085 }, H);
    expect(res.status).toBe(400); // a JSON number is refused: floats are how two sides disagree
  });

  it('is owner-only for writes', async () => {
    const writer = httpClient(ctx.db);
    await writer.signIn(ctx.users.writer);
    const res = await writer.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier: '0.0085' }, H);
    expect([401, 403]).toContain(res.status);
  });
});

describe('the rate feed', () => {
  it('never overwrites a hand-set multiplier', async () => {
    const client = await owner();
    await client.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier: '0.0085' }, H);
    const before = await revision();
    const r = await writeFeedMultiplier(ctx.db, 'GHS', 8496176720n);
    expect(r).toEqual({ written: false, bumped: false });
    expect((await readFxState(ctx.db)).rates.get('GHS')?.multiplierE12).toBe(8500000000n);
    expect(await revision()).toBe(before);
  });

  it('moves the revision only when the number moves, and always refreshes the age', async () => {
    expect(await writeFeedMultiplier(ctx.db, 'GHS', 8496176720n, 1000)).toEqual({ written: true, bumped: true });
    const rev = await revision();
    expect(await writeFeedMultiplier(ctx.db, 'GHS', 8496176720n, 2000)).toEqual({ written: true, bumped: false });
    expect(await revision()).toBe(rev);
    expect((await readFxState(ctx.db)).rates.get('GHS')?.updatedAt).toBe(2000);
    expect(await writeFeedMultiplier(ctx.db, 'GHS', 8500000000n, 3000)).toEqual({ written: true, bumped: true });
    expect(await revision()).toBe(rev + 1);
  });

  it('a cleared manual rate goes back to waiting for the feed', async () => {
    const client = await owner();
    await client.put('/api/shop/admin/payments/currency/GHS/multiplier', { multiplier: '0.0085' }, H);
    const rev = await revision();
    await client.del('/api/shop/admin/payments/currency/GHS/multiplier', H);
    expect(await revision()).toBe(rev + 1);
    expect(await writeFeedMultiplier(ctx.db, 'GHS', 8496176720n)).toMatchObject({ written: true });
  });
});

describe("a variant's own multiplier", () => {
  it('is set, listed and removed, and each change moves the revision', async () => {
    const product = await seedProduct(ctx.db, ctx.users.owner);
    const variant = await seedVariant(ctx.db, product.id, ctx.users.owner);
    const client = await owner();
    const rev = await revision();

    let res = await client.put(`/api/shop/admin/variants/${variant.id}/multipliers/ghs`, { multiplier: '0.009' }, H);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toMatchObject([
      { currency: 'GHS', multiplier: '0.009000000000' },
    ]);
    expect(await revision()).toBe(rev + 1);

    res = await client.del(`/api/shop/admin/variants/${variant.id}/multipliers/GHS`, H);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    expect(await revision()).toBe(rev + 2);
  });

  it('404s for a variant that does not exist', async () => {
    const client = await owner();
    const res = await client.put('/api/shop/admin/variants/var_nope/multipliers/GHS', { multiplier: '0.009' }, H);
    expect(res.status).toBe(404);
  });
});
