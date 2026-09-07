import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { seedSellable } from './test/catalog-harness';
import { logisticsCatalogPort } from './logistics-port';

/**
 * Catalog's side of the weights seam, against a real Postgres.
 *
 * TWO THINGS HERE ARE ONLY TRUE IF POSTGRES SAYS SO, which is why this is not a
 * unit test over a fake: the id list is an ARRAY BIND (a bare JS array is a
 * `22P02`, so a query that looks right can be a 500 on every call), and the
 * coverage is a `count(*) FILTER (…)` over a join. Neither is exercised by the
 * logistics route suites, which inject a fake catalog by design.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  /* Variants cascade from products; prices and inventory cascade from variants. */
  await ctx.db.execute(sql`DELETE FROM shop_products`);
});

const setWeight = async (variantId: string, grams: number | null): Promise<void> => {
  await ctx.db.execute(sql`
    UPDATE shop_variants SET weight_grams = ${grams}::integer WHERE id = ${variantId}`);
};

describe('weightsFor', () => {
  it('answers grams per id, null where the catalogue does not know', async () => {
    const heavy = await seedSellable(ctx.db, actor(), { title: 'Heavy' });
    const unknown = await seedSellable(ctx.db, actor(), { title: 'Unknown' });
    await setWeight(heavy.variant.id, 1_250);

    const weights = await logisticsCatalogPort.weightsFor(ctx.db, [
      heavy.variant.id,
      unknown.variant.id,
    ]);
    expect(weights.get(heavy.variant.id)).toBe(1_250);
    expect(weights.get(unknown.variant.id)).toBeNull();
  });

  it('omits an id it has never seen rather than reporting it as weightless', async () => {
    const { variant } = await seedSellable(ctx.db, actor());
    await setWeight(variant.id, 900);

    const weights = await logisticsCatalogPort.weightsFor(ctx.db, [variant.id, 'var_not_a_thing']);
    expect(weights.size).toBe(1);
    /* `has` and not `get`: absent and null are different answers, and a caller
     * that cannot tell them apart books a parcel for a variant that is gone. */
    expect(weights.has('var_not_a_thing')).toBe(false);
  });

  it('asks nothing at all for an empty list', async () => {
    expect(await logisticsCatalogPort.weightsFor(ctx.db, [])).toEqual(new Map());
  });

  it('still answers for a variant that has since been discontinued', async () => {
    /* The ids come off an order that was already placed. A variant retired
     * between the sale and the parcel still has to be weighed and shipped. */
    const { variant } = await seedSellable(ctx.db, actor());
    await setWeight(variant.id, 400);
    await ctx.db.execute(sql`
      UPDATE shop_variants SET status = 'discontinued' WHERE id = ${variant.id}`);

    const weights = await logisticsCatalogPort.weightsFor(ctx.db, [variant.id]);
    expect(weights.get(variant.id)).toBe(400);
  });
});

describe('weightCoverage', () => {
  it('is zero of zero on an empty catalogue', async () => {
    expect(await logisticsCatalogPort.weightCoverage(ctx.db)).toEqual({ missing: 0, total: 0 });
  });

  it('counts only live variants of live products', async () => {
    const weighed = await seedSellable(ctx.db, actor(), { title: 'Weighed' });
    await setWeight(weighed.variant.id, 1_000);
    await seedSellable(ctx.db, actor(), { title: 'Unweighed' });

    /* A discontinued variant with no weight is nobody's problem to fix… */
    const retired = await seedSellable(ctx.db, actor(), { title: 'Retired' });
    await ctx.db.execute(sql`
      UPDATE shop_variants SET status = 'discontinued' WHERE id = ${retired.variant.id}`);
    /* …and neither is one on a product in the trash. */
    const trashed = await seedSellable(ctx.db, actor(), { title: 'Trashed' });
    await ctx.db.execute(sql`
      UPDATE shop_products SET deleted_at = 1 WHERE id = ${trashed.product.id}`);

    expect(await logisticsCatalogPort.weightCoverage(ctx.db)).toEqual({ missing: 1, total: 2 });
  });
});
