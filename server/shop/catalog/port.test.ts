import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import type { Db } from '../../db/client';
import { catalogPort } from './port';
import { fakeCatalogPort } from './test/fake-catalog-port';
import type { FakeVariant } from './test/fake-catalog-port';
import { getInventory } from './inventory';
import { unpublishProduct } from './products';
import { seedSellable } from './test/catalog-harness';
import type { CatalogPort } from '../../../shared/commerce/catalog-port';
import { SHOP_CURRENCY } from '../currency';

/**
 * `CatalogPort`, both implementations, against the same assertions.
 *
 * WHY THE FAKE IS TESTED HERE AND NOT ONLY IN ITS OWN SUITE. Three subsystems
 * build against the fake before the real one exists, so if the two disagree the
 * mistake surfaces at integration — which is where every round of both prior
 * gauntlets already fails. Running the SAME table against both is the nearest
 * thing to a contract test available before they are wired together, and a
 * divergence is a failing assertion here rather than a support ticket later.
 *
 * The properties below are the ones a consumer can actually depend on. What is
 * deliberately NOT asserted against the fake is anything that is a database
 * property — the CAS, the trigger, statement-level atomicity — because the fake
 * does not model them and pretending it does would be worse than the gap.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

const EXPIRES = 4_102_444_800_000;
let n = 0;
const resId = () => `res_port_${(n += 1)}`;

/**
 * One "world" per implementation, presenting the same interface to the table
 * below: seed a sellable variant, then read the two stored numbers back.
 */
interface World {
  name: string;
  port: CatalogPort<Db>;
  db: Db;
  seed(o: { onHand: number; backorderable?: boolean }): Promise<string>;
  stock(variantId: string): Promise<{ onHand: number; reserved: number }>;
}

async function realWorld(): Promise<World> {
  return {
    name: 'real',
    port: catalogPort,
    db: ctx.db,
    seed: async (o) => {
      const { variant } = await seedSellable(ctx.db, actor(), {
        onHand: o.onHand,
        backorderable: o.backorderable,
        amount: 1999,
      });
      return variant.id;
    },
    stock: async (variantId) => {
      const level = await getInventory(ctx.db, variantId);
      return { onHand: level!.onHand, reserved: level!.reserved };
    },
  };
}

function fakeWorld(): World {
  const fake = fakeCatalogPort();
  let i = 0;
  return {
    name: 'fake',
    port: fake,
    db: null as unknown as Db,
    seed: (o) => {
      i += 1;
      const variant: FakeVariant = {
        variantId: `var_fake_${i}`,
        productId: `prd_fake_${i}`,
        sku: `FAKE-${i}`,
        title: 'Fake',
        optionValues: {},
        price: { amount: 1999, currency: SHOP_CURRENCY },
        weightGrams: null,
        backorderable: o.backorderable ?? false,
        onHand: o.onHand,
        reserved: 0,
      };
      fake.seed(variant);
      return Promise.resolve(variant.variantId);
    },
    stock: (variantId) => Promise.resolve(fake.stockOf(variantId)!),
  };
}

describe.each([
  ['real', realWorld],
  ['fake', () => Promise.resolve(fakeWorld())],
] as [string, () => Promise<World>][])('CatalogPort — %s', (_name, make) => {
  it('quote derives `available` and never exposes the two stored numbers', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    await w.port.reserve(w.db, { reservationId: resId(), variantId, qty: 3, expiresAt: EXPIRES });

    const quote = await w.port.quote(w.db, variantId);
    expect(quote?.available).toBe(7);
    expect(quote).not.toHaveProperty('onHand');
    expect(quote).not.toHaveProperty('reserved');
    expect(quote?.price).toEqual({ amount: 1999, currency: SHOP_CURRENCY });
  });

  it('quote is null for a variant that does not exist', async () => {
    const w = await make();
    expect(await w.port.quote(w.db, 'var_definitely_not_here')).toBeNull();
  });

  it('reserve holds stock and reports availability after the hold', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    const result = await w.port.reserve(w.db, {
      reservationId: resId(),
      variantId,
      qty: 4,
      expiresAt: EXPIRES,
    });
    expect(result).toMatchObject({ ok: true, qty: 4, available: 6, replayed: false });
    expect(await w.stock(variantId)).toEqual({ onHand: 10, reserved: 4 });
  });

  it('INSUFFICIENT STOCK IS A RETURN VALUE carrying the number', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 2 });
    expect(
      await w.port.reserve(w.db, { reservationId: resId(), variantId, qty: 5, expiresAt: EXPIRES }),
    ).toEqual({ ok: false, reason: 'insufficient', available: 2 });
    expect(await w.stock(variantId)).toEqual({ onHand: 2, reserved: 0 });
  });

  it('an unknown variant and a bad quantity are return values too', async () => {
    const w = await make();
    expect(
      await w.port.reserve(w.db, {
        reservationId: resId(),
        variantId: 'var_nope',
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toEqual({ ok: false, reason: 'unknown_variant', available: 0 });

    const variantId = await w.seed({ onHand: 5 });
    for (const qty of [0, -1, 1.5]) {
      expect(
        await w.port.reserve(w.db, { reservationId: resId(), variantId, qty, expiresAt: EXPIRES }),
      ).toEqual({ ok: false, reason: 'invalid_qty', available: 0 });
    }
  });

  it('reserve is IDEMPOTENT BY reservationId and reports the replay', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    const id = resId();
    const req = { reservationId: id, variantId, qty: 3, expiresAt: EXPIRES };

    expect(await w.port.reserve(w.db, req)).toMatchObject({ ok: true, replayed: false });
    expect(await w.port.reserve(w.db, req)).toMatchObject({ ok: true, replayed: true, qty: 3 });
    expect(await w.stock(variantId)).toEqual({ onHand: 10, reserved: 3 });
  });

  it('release returns the units and is idempotent', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    const id = resId();
    await w.port.reserve(w.db, { reservationId: id, variantId, qty: 4, expiresAt: EXPIRES });
    await w.port.release(w.db, id);
    await w.port.release(w.db, id);
    expect(await w.stock(variantId)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('commitReservation is a permanent decrement and is idempotent', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    const id = resId();
    await w.port.reserve(w.db, { reservationId: id, variantId, qty: 4, expiresAt: EXPIRES });
    await w.port.commitReservation(w.db, id);
    await w.port.commitReservation(w.db, id);
    expect(await w.stock(variantId)).toEqual({ onHand: 6, reserved: 0 });
  });

  it('IS SAFE IN BOTH INTERLEAVINGS of the sweeper/capture race', async () => {
    const w = await make();

    const a = await w.seed({ onHand: 10 });
    const idA = resId();
    await w.port.reserve(w.db, { reservationId: idA, variantId: a, qty: 4, expiresAt: EXPIRES });
    await w.port.release(w.db, idA);
    await w.port.commitReservation(w.db, idA);
    // Released first: the stock went back, nothing was sold.
    expect(await w.stock(a)).toEqual({ onHand: 10, reserved: 0 });

    const b = await w.seed({ onHand: 10 });
    const idB = resId();
    await w.port.reserve(w.db, { reservationId: idB, variantId: b, qty: 4, expiresAt: EXPIRES });
    await w.port.commitReservation(w.db, idB);
    await w.port.release(w.db, idB);
    // Committed first: the sale stands, and the late release does not hand back
    // stock that is on its way to a customer.
    expect(await w.stock(b)).toEqual({ onHand: 6, reserved: 0 });
  });

  it('records expiresAt and acts on it NEVER — the clock is Cart’s', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 10 });
    const id = resId();
    await w.port.reserve(w.db, { reservationId: id, variantId, qty: 3, expiresAt: 1 });
    // Long past, and the hold still holds. A port that expired holds by itself
    // would let a Cart suite pass without ever having written its sweeper.
    expect(await w.stock(variantId)).toEqual({ onHand: 10, reserved: 3 });
    await w.port.commitReservation(w.db, id);
    expect(await w.stock(variantId)).toEqual({ onHand: 7, reserved: 0 });
  });

  it('sells past zero when the variant is backorderable', async () => {
    const w = await make();
    const variantId = await w.seed({ onHand: 0, backorderable: true });
    expect(
      await w.port.reserve(w.db, { reservationId: resId(), variantId, qty: 5, expiresAt: EXPIRES }),
    ).toMatchObject({ ok: true, available: -5 });
  });
});

describe('what only the REAL port can be asked', () => {
  it('quote refuses a variant with no CURRENT PRICE, though the admin surface still shows it', async () => {
    /*
     * The join to `shop_prices` is INNER here and LEFT in
     * `listVariantsWithPrices`, deliberately. A variant with no price is a real
     * state the admin has to see and fix; it is not a thing a cart may hold,
     * because there is no amount to charge.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await ctx.db.execute(sql`DELETE FROM shop_prices WHERE variant_id = ${variant.id}`);
    expect(await catalogPort.quote(ctx.db, variant.id)).toBeNull();
  });

  it('quote refuses a variant whose product is no longer on sale', async () => {
    const { product, variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    expect(await catalogPort.quote(ctx.db, variant.id)).not.toBeNull();
    await unpublishProduct(ctx.db, product.id, actor());
    // "Sellable" is decided here and once. A consumer assembling that predicate
    // itself would be a second implementation of Catalog's publication rules.
    expect(await catalogPort.quote(ctx.db, variant.id)).toBeNull();
  });

  it('reserve answers `not_sellable`, which the fake reaches only via its own flag', async () => {
    const { product, variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await unpublishProduct(ctx.db, product.id, actor());
    expect(
      await catalogPort.reserve(ctx.db, {
        reservationId: resId(),
        variantId: variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toMatchObject({ ok: false, reason: 'not_sellable' });
  });
});

/**
 * THE TWO WEIGHTS (migration 1180), through the REAL port only.
 *
 * `weight_grams` is what the shop SHOWS — the spool size on the storefront —
 * and `shipping_weight_grams` is what DELIVERY is priced on. Before 1180 they
 * were one column doing both jobs, so printing an honest spool size and
 * quoting an honest parcel were the same edit.
 *
 * REAL-ONLY BECAUSE THE RESOLUTION IS A COALESCE IN SQL. The fake spells the
 * same rule in TypeScript, and a fake asserting against itself would agree no
 * matter what the query said — which is how a `weightsFor` reading one column
 * would have shipped green. `quote` is the read that prices a shopper's
 * delivery at checkout, so this is the money-adjacent half of the seam.
 */
describe('quote — the displayed weight and the shipping weight', () => {
  const setWeights = async (
    variantId: string,
    o: { display?: number | null; shipping?: number | null },
  ): Promise<void> => {
    await ctx.db.execute(sql`
      UPDATE shop_variants
         SET weight_grams = ${o.display ?? null}::integer,
             shipping_weight_grams = ${o.shipping ?? null}::integer
       WHERE id = ${variantId}`);
  };

  it('carries both, and they differ when the variant has an override', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await setWeights(variant.id, { display: 1_250, shipping: 1_400 });

    const quote = await catalogPort.quote(ctx.db, variant.id);
    /* The order line records the spool the customer was shown… */
    expect(quote?.weightGrams).toBe(1_250);
    /* …and the courier is quoted on the parcel. */
    expect(quote?.shippingWeightGrams).toBe(1_400);
  });

  it('resolves the shipping weight to the displayed one when there is no override', async () => {
    /* Every variant in production is in this state the day 1180 lands, so this
       is the assertion that says delivery prices did not move. */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await setWeights(variant.id, { display: 1_250 });

    const quote = await catalogPort.quote(ctx.db, variant.id);
    expect(quote?.weightGrams).toBe(1_250);
    expect(quote?.shippingWeightGrams).toBe(1_250);
  });

  it('leaves the displayed weight null while the override prices delivery', async () => {
    /* What the courier dialog's "set weights" step writes: the parcel becomes
       quotable and the storefront still publishes no spool size. */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await setWeights(variant.id, { shipping: 800 });

    const quote = await catalogPort.quote(ctx.db, variant.id);
    expect(quote?.weightGrams).toBeNull();
    expect(quote?.shippingWeightGrams).toBe(800);
  });

  it('is null on both only when the variant has never been weighed', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });

    const quote = await catalogPort.quote(ctx.db, variant.id);
    expect(quote?.weightGrams).toBeNull();
    /* NOT zero. The checkout rate path substitutes `DEFAULT_ITEM_GRAMS` for
       this; a port that answered 0 would book a weightless parcel, which the
       courier reprices on the doorstep. */
    expect(quote?.shippingWeightGrams).toBeNull();
  });

  it('takes a zero override literally rather than falling back', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5, amount: 1000 });
    await setWeights(variant.id, { display: 1_250, shipping: 0 });

    const quote = await catalogPort.quote(ctx.db, variant.id);
    expect(quote?.shippingWeightGrams).toBe(0);
  });
});
