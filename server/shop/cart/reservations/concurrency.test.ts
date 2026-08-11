/**
 * Brief §8: "N≥50 concurrent checkouts against 10 units yield exactly 10 holds."
 *
 * ═══ WHY THIS RUNS AGAINST A SQL-BACKED FAKE AND NOT THE IN-MEMORY ONE ═══
 *
 * Against an in-memory `CatalogPort` this property is guaranteed by JavaScript
 * rather than by anything Cart or Catalog wrote: a synchronous `if` followed by
 * `reserved += qty` between two `await`s cannot interleave on a single-threaded
 * event loop, so fifty "concurrent" calls would produce exactly ten holds even
 * against a counter with NO guard at all. That is a test that proves the
 * runtime.
 *
 * `sqlFakeCatalog` decrements through a conditional
 * `UPDATE … WHERE on_hand - reserved >= qty RETURNING`, which is the predicate
 * Postgres actually evaluates — and the mutation test at the bottom removes it
 * and watches the shop oversell. That is the version of this test that means
 * something.
 *
 * ═══ WHAT IT STILL CANNOT SHOW, STATED RATHER THAN IMPLIED ═══
 *
 * PGlite is single-connection, so these fifty calls are SERIALISED by the
 * driver, not run in parallel. What is proved is that the predicate is correct
 * and load-bearing under interleaving; what is NOT proved is row-lock behaviour
 * under genuine parallelism. Spec §9 already records that PGlite's single
 * connection proves nothing about real parallelism, and the real `CatalogPort`
 * is Catalog's to prove against its own table — which its suite does.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables, TEST_CURRENCY } from '../test/harness';
import { sqlFakeCatalog } from '../test/fake-catalog';
import { mutating } from '../test/mutating';
import { createCart } from '../cart/repo';
import { reserveForCheckout } from './repo';
import type { SqlFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;
let catalog: SqlFakeCatalog;

const STOCK = 10;
const SHOPPERS = 50;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  catalog = sqlFakeCatalog(db);
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  await catalog.install();
  await catalog.seed({
    variantId: 'var_scarce',
    price: { amount: 1999, currency: TEST_CURRENCY },
    onHand: STOCK,
  });
});

/** `SHOPPERS` carts, each wanting one unit of the scarce variant. */
async function crowd(): Promise<string[]> {
  const carts: string[] = [];
  for (let i = 0; i < SHOPPERS; i += 1) {
    carts.push((await createCart(db, { currency: TEST_CURRENCY })).id);
  }
  return carts;
}

describe(`${SHOPPERS} checkouts against ${STOCK} units`, () => {
  it(`yields exactly ${STOCK} holds, and tells the other ${SHOPPERS - STOCK} the real number`, async () => {
    const carts = await crowd();

    const outcomes = await Promise.all(
      carts.map((cartId) =>
        reserveForCheckout(db, catalog, {
          cartId,
          lines: [{ variantId: 'var_scarce', qty: 1 }],
        }),
      ),
    );

    const won = outcomes.filter((o) => o.ok);
    const lost = outcomes.filter((o) => !o.ok);
    expect(won).toHaveLength(STOCK);
    expect(lost).toHaveLength(SHOPPERS - STOCK);

    // Not oversold, and not undersold either: every unit is spoken for.
    expect(await catalog.stockOf('var_scarce')).toEqual({ onHand: STOCK, reserved: STOCK });

    // Cart's own ledger agrees with Catalog's count — the two records of the
    // same fact, which is exactly the kind of pair GAUNTLET keeps finding
    // disagreeing.
    const held = await db.execute(
      sql`SELECT count(*)::int AS n FROM shop_reservations WHERE state = 'held'`,
    );
    expect(Number(held.rows[0].n)).toBe(STOCK);

    // Every loser was told a NUMBER, not just "no" (brief §8 and the agent
    // prompt: insufficient stock is a return value with a number in it).
    for (const outcome of lost) {
      if (outcome.ok) continue;
      expect(outcome.reason).toBe('insufficient');
      expect(outcome.shortfalls).toEqual([
        { variantId: 'var_scarce', requested: 1, available: 0 },
      ]);
    }
  });

  it('leaves no half-taken hold behind — every row is held or released', async () => {
    const carts = await crowd();
    await Promise.all(
      carts.map((cartId) =>
        reserveForCheckout(db, catalog, {
          cartId,
          lines: [{ variantId: 'var_scarce', qty: 1 }],
        }),
      ),
    );

    const states = await db.execute(sql`
      SELECT state, count(*)::int AS n FROM shop_reservations GROUP BY state ORDER BY state`);
    expect(states.rows.map((r) => [String(r.state), Number(r.n)])).toEqual([
      ['held', STOCK],
      ['released', SHOPPERS - STOCK],
    ]);
  });

  it('MUTATION: without the availability predicate, the shop oversells all 50', async () => {
    /*
     * The proof that the test above measures the SQL and not the event loop. The
     * predicate is rewritten to `true` on its way to the driver, and the same
     * fifty callers all win — ten units sold fifty times.
     */
    const carts = await crowd();
    const mutant = mutating(db, /on_hand - reserved >= \$\d+/, 'true');

    const outcomes = await Promise.all(
      carts.map((cartId) =>
        reserveForCheckout(mutant, catalog, {
          cartId,
          lines: [{ variantId: 'var_scarce', qty: 1 }],
        }),
      ),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(SHOPPERS);
    expect(await catalog.stockOf('var_scarce')).toEqual({
      onHand: STOCK,
      reserved: SHOPPERS,
    });
  });
});

describe('a crowd wanting more than one each', () => {
  it('admits whole baskets only — nobody is given a partial hold', async () => {
    /*
     * Three each against ten units: three shoppers get three, and the fourth is
     * refused rather than given the one that is left. A partial hold is worse
     * than a refusal — the customer pays for three and one is not there.
     */
    const carts = (await crowd()).slice(0, 5);
    const outcomes = await Promise.all(
      carts.map((cartId) =>
        reserveForCheckout(db, catalog, {
          cartId,
          lines: [{ variantId: 'var_scarce', qty: 3 }],
        }),
      ),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    expect(await catalog.stockOf('var_scarce')).toEqual({ onHand: STOCK, reserved: 9 });

    const refused = outcomes.find((o) => !o.ok);
    if (!refused || refused.ok) throw new Error('expected a refusal');
    // The one unit that IS left is reported, so the shopper can reduce to it.
    expect(refused.shortfalls).toEqual([
      { variantId: 'var_scarce', requested: 3, available: 1 },
    ]);
  });
});
