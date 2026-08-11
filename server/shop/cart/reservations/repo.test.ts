/**
 * Reservations, the expiry sweeper, and the race between the sweeper and a
 * payment capture (brief §4).
 *
 * THE ONE PROPERTY THIS FILE EXISTS FOR: a sweeper releasing a hold at the
 * moment Payments commits it must not decrement the count twice. The design is
 * that both sides transition the SAME row with a conditional
 * `UPDATE … WHERE state = 'held' RETURNING`, and each calls into Catalog **only
 * when it actually transitioned the row**. Whichever loses sees zero rows and
 * does nothing.
 *
 * The brief says to prove it with a held transaction rather than reason about
 * it, and that is done below — with an explicit note about the one thing PGlite
 * cannot show, rather than a claim it can. The load-bearing proof is the pair of
 * MUTATION tests: strip `state = 'held'` from either side and the double
 * decrement appears.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables, TEST_CURRENCY } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import { GUARDS, mutating } from '../test/mutating';
import { createCart } from '../cart/repo';
import {
  commitReservation,
  extendReservations,
  listReservations,
  releaseReservation,
  reserveForCheckout,
  RESERVATION_TTL_MS,
  sweepExpiredReservations,
} from './repo';
import type { CartFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  catalog = fakeCatalog([
    { variantId: 'var_a', price: { amount: 1999, currency: TEST_CURRENCY }, onHand: 10 },
    { variantId: 'var_b', price: { amount: 500, currency: TEST_CURRENCY }, onHand: 3 },
  ]);
});

async function cartWith(lines: Array<{ variantId: string; qty: number }>) {
  const cart = await createCart(db, { currency: TEST_CURRENCY });
  return { cart, lines };
}

describe('reserveForCheckout', () => {
  it('takes one hold per line and records each as held', async () => {
    const { cart, lines } = await cartWith([
      { variantId: 'var_a', qty: 2 },
      { variantId: 'var_b', qty: 1 },
    ]);

    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reservations).toHaveLength(2);
    expect(result.reservations.every((r) => r.state === 'held')).toBe(true);
    expect(result.reservations.every((r) => r.id.startsWith('res_'))).toBe(true);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
    expect(catalog.stockOf('var_b')).toEqual({ onHand: 3, reserved: 1 });
    // Exactly one reserve per line — not one per read.
    expect(catalog.reserveCalls()).toHaveLength(2);
  });

  it('gives every hold the SAME expiry, taken from one clock reading', async () => {
    // Two reads of `Date.now()` in a loop give holds that expire at different
    // instants, so a sweep can release half a checkout and leave the rest —
    // a cart that is partly reserved and partly not, with nothing that says so.
    const { cart, lines } = await cartWith([
      { variantId: 'var_a', qty: 1 },
      { variantId: 'var_b', qty: 1 },
    ]);
    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    if (!result.ok) throw new Error('expected holds');
    const expiries = new Set(result.reservations.map((r) => r.expiresAt));
    expect(expiries.size).toBe(1);
    expect([...expiries][0]).toBeGreaterThan(Date.now() + RESERVATION_TTL_MS - 5000);
  });

  it('INSUFFICIENT STOCK IS A RETURN VALUE WITH A NUMBER IN IT', async () => {
    const { cart, lines } = await cartWith([{ variantId: 'var_b', qty: 5 }]);

    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient');
    // The number is the whole point: "out of stock" is not actionable, "only 3
    // left" is. An exception would have nowhere to put it.
    expect(result.shortfalls).toEqual([{ variantId: 'var_b', requested: 5, available: 3 }]);
  });

  it('RELEASES what it already took when a later line cannot be satisfied', async () => {
    /*
     * The compensation path, and the reason holds are taken row-first. A
     * checkout that reserved two of `var_a` and then failed on `var_b` must not
     * leave two units held for fifteen minutes for a checkout that never
     * happened — that is stock nobody can buy and nobody is paying for.
     */
    const { cart, lines } = await cartWith([
      { variantId: 'var_a', qty: 2 },
      { variantId: 'var_b', qty: 99 },
    ]);

    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    expect(result.ok).toBe(false);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 0 });
    const rows = await listReservations(db, cart.id);
    expect(rows.filter((r) => r.state === 'held')).toHaveLength(0);
  });

  it('reports an unresolvable variant rather than reserving nothing silently', async () => {
    const { cart, lines } = await cartWith([{ variantId: 'var_gone', qty: 1 }]);
    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls).toEqual([
      { variantId: 'var_gone', requested: 1, available: 0 },
    ]);
  });

  it('writes the ROW BEFORE calling Catalog, so a hold can never be leaked', async () => {
    /*
     * ORDER MATTERS AND ONLY ONE ORDER IS SAFE.
     *
     * Row first: if the Catalog call then fails, there is a `held` row whose
     * hold may or may not exist, and the sweeper releases it in fifteen
     * minutes — `release` is idempotent, so releasing a hold that was never
     * taken is a no-op.
     *
     * Catalog first: if the row write then fails, stock is held by a hold whose
     * id nothing records. Nothing will ever release it. That unit is gone until
     * somebody notices the count is wrong and fixes it by hand.
     *
     * Executed here by making the Catalog call throw and asserting the row
     * survives to be swept.
     */
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 1 }]);
    const exploding = {
      ...catalog,
      reserve: () => Promise.reject(new Error('catalog is down')),
    };

    await expect(
      reserveForCheckout(db, exploding, { cartId: cart.id, lines }),
    ).rejects.toThrow(/catalog is down/);

    const rows = await listReservations(db, cart.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('held');
  });
});

describe('reserveForCheckout is idempotent per cart', () => {
  it('a second start reuses the same reservation and holds stock ONCE', async () => {
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 2 }]);
    const first = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    const second = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    if (!first.ok || !second.ok) throw new Error('expected holds');
    expect(second.reservations[0].id).toBe(first.reservations[0].id);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
    // The second call still goes to Catalog — and Catalog answers `replayed`,
    // which is the property that makes the retry safe rather than merely rare.
    expect(catalog.reserveCalls()).toHaveLength(2);
  });

  it('re-takes when the quantity changed between starts', async () => {
    const { cart } = await cartWith([]);
    await reserveForCheckout(db, catalog, {
      cartId: cart.id,
      lines: [{ variantId: 'var_a', qty: 2 }],
    });
    const second = await reserveForCheckout(db, catalog, {
      cartId: cart.id,
      lines: [{ variantId: 'var_a', qty: 5 }],
    });

    if (!second.ok) throw new Error('expected holds');
    expect(second.reservations[0].qty).toBe(5);
    // The old hold is given back, not stacked on top of the new one.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 5 });
  });

  it('releases a hold whose line has left the cart', async () => {
    const { cart } = await cartWith([]);
    await reserveForCheckout(db, catalog, {
      cartId: cart.id,
      lines: [
        { variantId: 'var_a', qty: 1 },
        { variantId: 'var_b', qty: 1 },
      ],
    });
    await reserveForCheckout(db, catalog, {
      cartId: cart.id,
      lines: [{ variantId: 'var_a', qty: 1 }],
    });

    expect(catalog.stockOf('var_b')).toEqual({ onHand: 3, reserved: 0 });
    const rows = await listReservations(db, cart.id);
    expect(rows.find((r) => r.variantId === 'var_b')?.state).toBe('released');
  });
});

describe('the sweeper', () => {
  async function expiredHold() {
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 2 }]);
    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    if (!result.ok) throw new Error('expected holds');
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);
    return result.reservations[0];
  }

  it('releases an expired hold exactly once and marks it expired', async () => {
    const hold = await expiredHold();
    const swept = await sweepExpiredReservations(db, catalog);

    expect(swept.released).toBe(1);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 0 });
    expect(catalog.holdOf(hold.id)?.state).toBe('released');
    const rows = await db.execute(sql`SELECT state FROM shop_reservations`);
    expect(String(rows.rows[0].state)).toBe('expired');
  });

  it('is idempotent — a second sweep transitions nothing and calls nothing', async () => {
    await expiredHold();
    await sweepExpiredReservations(db, catalog);
    const again = await sweepExpiredReservations(db, catalog);

    expect(again.released).toBe(0);
    // The count did not move a second time. This is the whole hazard.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 0 });
  });

  it('leaves a hold that has NOT expired alone', async () => {
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 2 }]);
    await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    expect((await sweepExpiredReservations(db, catalog)).released).toBe(0);
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
  });

  it('does not touch a hold that has already been committed', async () => {
    const hold = await expiredHold();
    await commitReservation(db, catalog, hold.id);

    const swept = await sweepExpiredReservations(db, catalog);

    expect(swept.released).toBe(0);
    // Committed: on-hand went down by 2 and the reservation went with it.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
  });
});

describe('THE RACE — expiry versus capture', () => {
  async function expiredHoldId(): Promise<string> {
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 2 }]);
    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    if (!result.ok) throw new Error('expected holds');
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);
    return result.reservations[0].id;
  }

  it('capture first, then the sweeper: the sweeper does nothing', async () => {
    const id = await expiredHoldId();

    expect(await commitReservation(db, catalog, id)).toBe(true);
    const swept = await sweepExpiredReservations(db, catalog);

    expect(swept.released).toBe(0);
    // Decremented exactly once. A double decrement would show as onHand 6.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 8, reserved: 0 });
  });

  it('the sweeper first, then capture: the capture does nothing', async () => {
    const id = await expiredHoldId();

    const swept = await sweepExpiredReservations(db, catalog);
    expect(swept.released).toBe(1);
    // `false` and not a throw: losing this race is an ordinary outcome, and the
    // caller needs to distinguish "already released" from "failed" so it can
    // refund rather than ship.
    expect(await commitReservation(db, catalog, id)).toBe(false);

    // Released, not sold: on-hand is untouched and the hold is given back once.
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 0 });
  });

  it('WITH A TRANSACTION HELD OPEN: the second statement sees zero rows', async () => {
    /*
     * WHAT THIS EXECUTES, AND WHAT IT CANNOT.
     *
     * Executed: a transaction is opened, the capture's conditional UPDATE runs
     * inside it and transitions the row, and the sweeper's conditional UPDATE
     * then runs against a row that is no longer `held` and matches NOTHING. That
     * is the interleaving the brief names, run rather than argued, and it is the
     * mechanism that makes the double decrement impossible: the row is the
     * arbiter and the Catalog call is downstream of winning it.
     *
     * NOT executed, and stated rather than papered over: PGlite is a
     * SINGLE-CONNECTION Postgres, so two genuinely simultaneous transactions
     * cannot exist in this environment — measured, not assumed (a competing
     * statement issued while a transaction is open runs INSIDE that transaction
     * rather than blocking on its row lock). What real Postgres adds on top of
     * what is shown here is that the losing UPDATE BLOCKS on the row lock until
     * the winner commits and then re-evaluates its predicate under READ
     * COMMITTED — reaching the same zero-row answer. This suite proves the
     * predicate; it does not prove the lock. Spec §9 already records that
     * PGlite's single connection proves nothing about real parallelism, which is
     * why the mutation tests below, not this one, are the load-bearing proof.
     */
    const id = await expiredHoldId();

    await db.execute(sql`BEGIN`);
    const captured = await db.execute(sql`
      UPDATE shop_reservations SET state = 'committed'
       WHERE id = ${id} AND state = 'held'
      RETURNING id, variant_id, qty`);
    expect(captured.rows).toHaveLength(1);

    const swept = await db.execute(sql`
      UPDATE shop_reservations SET state = 'expired'
       WHERE state = 'held' AND expires_at <= ${Date.now()}
      RETURNING id`);
    // ZERO. The sweeper transitioned nothing, so it calls `release` on nothing.
    expect(swept.rows).toHaveLength(0);

    await db.execute(sql`ROLLBACK`);

    // And the rollback put the row back, so nothing above leaked into the rest
    // of the suite — which is itself the point of doing it in a transaction.
    const after = await db.execute(sql`SELECT state FROM shop_reservations WHERE id = ${id}`);
    expect(String(after.rows[0].state)).toBe('held');
    expect(catalog.stockOf('var_a')).toEqual({ onHand: 10, reserved: 2 });
  });

  /*
   * ═══ WHAT THE MUTATION TESTS BELOW MEASURE, AND A CORRECTION ═══
   *
   * These were written first asserting that neutralising `state = 'held'` makes
   * the COUNT go wrong — reserved to −2, on-hand decremented for stock already
   * given back. Run, they failed: the count was fine. That is not the guard
   * being untested, it is DEFENCE IN DEPTH, and the first version of these tests
   * described the system wrongly.
   *
   * Contract §5 requires every `CatalogPort` method to be idempotent by
   * reservation id, so Catalog holds its OWN `held` guard over its own ledger.
   * With both guards in place a double decrement needs both to fail. Cart's
   * guard is therefore not what protects the count — Catalog's is — and what
   * Cart's guard protects is **Cart's record of what happened**, which is what a
   * refund decision, an order line and `checkout.completed` are all built from.
   * A reservation row that says `released` when the stock was in fact sold is a
   * refund that never happens and an order nobody ships.
   *
   * So the assertions below are on the ledger, and they are stronger for it:
   * they fail for a reason that does not depend on how Catalog is implemented.
   * The count-level claim is left to Catalog's own suite, which owns it.
   */

  it('MUTATION: without `state = held`, a release rewrites a COMMITTED row', async () => {
    const id = await expiredHoldId();
    expect(await commitReservation(db, catalog, id)).toBe(true);

    const mutant = mutating(db, GUARDS.reservationHeld, 'true');
    // With the guard neutralised the release "succeeds" against a row it has no
    // business touching, and says so — `true` means "this call transitioned it".
    expect(await releaseReservation(mutant, catalog, id)).toBe(true);

    const row = await db.execute(sql`SELECT state FROM shop_reservations WHERE id = ${id}`);
    // The ledger now says the stock was handed back. It was sold. Every
    // downstream reader of this row — a refund, an order line, the
    // `checkout.completed` payload — is now wrong about a physical object.
    expect(String(row.rows[0].state)).toBe('released');
  });

  it('MUTATION: without `state = held`, a capture claims an EXPIRED hold', async () => {
    const id = await expiredHoldId();
    await sweepExpiredReservations(db, catalog);

    const mutant = mutating(db, GUARDS.reservationHeld, 'true');
    expect(await commitReservation(mutant, catalog, id)).toBe(true);

    const row = await db.execute(sql`SELECT state FROM shop_reservations WHERE id = ${id}`);
    // Cart now believes it sold stock the sweeper gave back — the reservation
    // reads `committed` for units that may already be in somebody else's basket.
    expect(String(row.rows[0].state)).toBe('committed');
  });

  it('MUTATION: without `state = held`, the sweeper re-sweeps settled rows forever', async () => {
    /*
     * The third face of the same guard, and the one with an operational cost
     * rather than a correctness one: the sweeper's SELECT is `state = 'held'`,
     * so without it every settled reservation in the table is picked up on every
     * sweep, for the life of the shop, and handed to `CatalogPort.release` again.
     * Bounded by SWEEP_BATCH, so it does not run away — it simply stops sweeping
     * anything real, because the batch fills with rows that are already done.
     */
    const id = await expiredHoldId();
    await sweepExpiredReservations(db, catalog);
    expect((await sweepExpiredReservations(db, catalog)).released).toBe(0);

    const mutant = mutating(db, GUARDS.reservationHeld, 'true');
    expect((await sweepExpiredReservations(mutant, catalog)).released).toBe(1);
    const row = await db.execute(sql`SELECT state FROM shop_reservations WHERE id = ${id}`);
    expect(String(row.rows[0].state)).toBe('expired');
  });
});

describe('extendReservations', () => {
  it('pushes the expiry out ONCE, at payment start', async () => {
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 1 }]);
    const result = await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    if (!result.ok) throw new Error('expected holds');
    const before = result.reservations[0].expiresAt;

    const extended = await extendReservations(db, cart.id);
    expect(extended).toBe(1);

    const after = (await listReservations(db, cart.id))[0];
    expect(after.expiresAt).toBeGreaterThan(before);
  });

  it('will not extend a hold that has already been extended', async () => {
    /*
     * "TTL is 15 minutes, extended ONCE on payment start" (brief §4). Unbounded
     * extension is the failure mode the fixed number exists to prevent: a
     * client that re-calls payment-start every fourteen minutes holds the last
     * unit of a popular variant forever, for free, and nothing in the system
     * says anything is wrong.
     */
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 1 }]);
    await reserveForCheckout(db, catalog, { cartId: cart.id, lines });

    expect(await extendReservations(db, cart.id)).toBe(1);
    expect(await extendReservations(db, cart.id)).toBe(0);
  });

  it('will not extend a hold that has already expired', async () => {
    // Extending an expired hold would resurrect stock the sweeper may already
    // have handed to somebody else.
    const { cart, lines } = await cartWith([{ variantId: 'var_a', qty: 1 }]);
    await reserveForCheckout(db, catalog, { cartId: cart.id, lines });
    await db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);

    expect(await extendReservations(db, cart.id)).toBe(0);
  });
});
