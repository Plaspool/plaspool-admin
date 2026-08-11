import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { NotFoundError } from '../../repo/errors';
import { money } from '../../../shared/commerce/money';
import { currentPrice, priceHistory, setPrice } from './prices';
import { seedProduct, seedVariant } from './test/catalog-harness';

/**
 * Effective-dated prices, and the invariant the partial unique index exists for.
 *
 * "At most one current price per variant" is the property `quote()` depends on:
 * without it, two racing price changes leave two rows with `effective_to IS
 * NULL` and the price a customer is charged depends on which one the planner
 * returns. It is enforced by `shop_prices_current_uq`, not by this file, and
 * these tests are what prove that is true rather than intended.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

async function pricedVariant(amount: number | null = 1000): Promise<string> {
  const product = await seedProduct(ctx.db, actor(), { title: `Priced ${Date.now()}` });
  const variant = await seedVariant(ctx.db, product.id, actor(), { amount });
  return variant.id;
}

async function openRows(variantId: string): Promise<number> {
  const res = await ctx.db.execute(sql`
    SELECT count(*)::int AS n FROM shop_prices
     WHERE variant_id = ${variantId} AND effective_to IS NULL`);
  return Number(res.rows[0].n);
}

/** The clock has millisecond resolution and the window check is strict. */
const tick = () => new Promise((r) => setTimeout(r, 2));

describe('setPrice', () => {
  it('opens the first price with no window to close', async () => {
    const variantId = await pricedVariant(null);
    const row = await setPrice(ctx.db, variantId, money(1999, 'GBP'));
    expect(row).toMatchObject({ amount: 1999, currency: 'GBP', effectiveTo: null });
    expect(await currentPrice(ctx.db, variantId)).toEqual({ amount: 1999, currency: 'GBP' });
  });

  it('closes the old window and opens a new one, keeping exactly one current', async () => {
    /*
     * THE CASE NO TEST EXERCISED UNTIL ONE CHANGED A PRICE TWICE. The original
     * implementation did this in a single statement with data-modifying CTEs,
     * which every other mutation in Catalog does — and it is impossible here:
     * all CTEs share one snapshot, so the INSERT's uniqueness check still sees
     * the row the UPDATE is closing and `shop_prices_current_uq` refuses it.
     * Measured: the whole statement rolled back and every price change after the
     * first was a permanent 400.
     */
    const variantId = await pricedVariant(1000);
    await tick();
    await setPrice(ctx.db, variantId, money(1500, 'GBP'));
    await tick();
    await setPrice(ctx.db, variantId, money(1200, 'GBP'));

    expect(await openRows(variantId)).toBe(1);
    expect(await currentPrice(ctx.db, variantId)).toEqual({ amount: 1200, currency: 'GBP' });

    const history = await priceHistory(ctx.db, variantId);
    expect(history.map((p) => p.amount)).toEqual([1200, 1500, 1000]);
    // Every superseded row has a closed, non-degenerate window — which is what
    // makes "what did this cost on Tuesday" answerable at all.
    for (const row of history.slice(1)) {
      expect(row.effectiveTo).not.toBeNull();
      expect(row.effectiveTo!).toBeGreaterThan(row.effectiveFrom);
    }
  });

  it('ONE CURRENT PRICE SURVIVES CONCURRENT CHANGES — the index is the authority', async () => {
    /*
     * Ten simultaneous price changes. Some win, some lose with
     * `ConcurrentPriceChangeError`; what must hold whatever the interleaving is
     * that the variant never ends up with two current prices, because a shop
     * with two is one that charges different customers differently for reasons
     * nobody can reconstruct.
     */
    const variantId = await pricedVariant(1000);
    await tick();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => setPrice(ctx.db, variantId, money(2000 + i, 'GBP'))),
    );

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await openRows(variantId), 'the variant ended with two current prices').toBe(1);

    // A loser is a NAMED refusal the caller can retry, never a raw 23505 and
    // never a 500 — a 500 would be retried five times by the client's policy
    // with no reason to think the outcome changes.
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String(r.reason)).not.toContain('DbError');
        expect((r.reason as Error).name).toBe('ConcurrentPriceChangeError');
      }
    }
  });

  it('404s for a variant that does not exist, and closes nothing on the way', async () => {
    await expect(setPrice(ctx.db, 'var_nope', money(100, 'GBP'))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('currentPrice is null for a variant nobody has priced', async () => {
    const variantId = await pricedVariant(null);
    expect(await currentPrice(ctx.db, variantId)).toBeNull();
    expect(await priceHistory(ctx.db, variantId)).toEqual([]);
  });
});
