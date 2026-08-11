import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import {
  adjustInventory,
  commitHold,
  getHold,
  getInventory,
  releaseHold,
  reserve,
} from './inventory';
import { publishProduct, trashProduct, unpublishProduct } from './products';
import {
  countEvents,
  eventsFor,
  mutating,
  seedProduct,
  seedSellable,
  seedVariant,
} from './test/catalog-harness';

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

let resCounter = 0;
const resId = () => `res_${(resCounter += 1)}_${Date.now().toString(36)}`;
const EXPIRES = 4_102_444_800_000; // 2100-01-01, far past anything in a suite.

describe('reserve', () => {
  it('holds stock and reports availability AFTER the hold', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const result = await reserve(ctx.db, {
      reservationId: resId(),
      variantId: variant.id,
      qty: 4,
      expiresAt: EXPIRES,
    });

    expect(result).toMatchObject({ ok: true, qty: 4, available: 6, replayed: false });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({
      onHand: 10,
      reserved: 4,
      available: 6,
    });
  });

  it('INSUFFICIENT STOCK IS A RETURN VALUE, and it carries the number', async () => {
    /*
     * Brief §5. A shopper taking the last two of an item is the most ordinary
     * event a shop has; thrown, it would be indistinguishable at every layer
     * above from a database being down, and the one thing the customer needs to
     * be told — how many are actually left — would have nowhere to live.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 2 });
    const result = await reserve(ctx.db, {
      reservationId: resId(),
      variantId: variant.id,
      qty: 5,
      expiresAt: EXPIRES,
    });

    expect(result).toEqual({ ok: false, reason: 'insufficient', available: 2 });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 0 });
  });

  it('names the other three refusals rather than throwing any of them', async () => {
    const { product, variant } = await seedSellable(ctx.db, actor(), { onHand: 5 });

    expect(
      await reserve(ctx.db, {
        reservationId: resId(),
        variantId: 'var_nope',
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toEqual({ ok: false, reason: 'unknown_variant', available: 0 });

    for (const qty of [0, -1, 1.5]) {
      expect(
        await reserve(ctx.db, {
          reservationId: resId(),
          variantId: variant.id,
          qty,
          expiresAt: EXPIRES,
        }),
      ).toEqual({ ok: false, reason: 'invalid_qty', available: 0 });
    }

    // Unpublished between the quote and the reservation.
    await unpublishProduct(ctx.db, product.id, actor());
    expect(
      await reserve(ctx.db, {
        reservationId: resId(),
        variantId: variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toEqual({ ok: false, reason: 'not_sellable', available: 5 });
  });

  it('refuses stock for a TRASHED product and for a DISCONTINUED variant', async () => {
    const trashed = await seedSellable(ctx.db, actor(), { onHand: 5 });
    await trashProduct(ctx.db, trashed.product.id, actor());
    expect(
      await reserve(ctx.db, {
        reservationId: resId(),
        variantId: trashed.variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toMatchObject({ ok: false, reason: 'not_sellable' });

    const discontinued = await seedSellable(ctx.db, actor(), { onHand: 5 });
    await ctx.db.execute(
      sql`UPDATE shop_variants SET status = 'discontinued' WHERE id = ${discontinued.variant.id}`,
    );
    expect(
      await reserve(ctx.db, {
        reservationId: resId(),
        variantId: discontinued.variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toMatchObject({ ok: false, reason: 'not_sellable' });
  });

  it('IS IDEMPOTENT BY reservationId: twice holds stock ONCE', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const id = resId();
    const req = { reservationId: id, variantId: variant.id, qty: 3, expiresAt: EXPIRES };

    const first = await reserve(ctx.db, req);
    const second = await reserve(ctx.db, req);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true, qty: 3 });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 3 });
  });

  it('a replay with a DIFFERENT qty answers with the quantity actually held', async () => {
    // A caller doing this has a bug. Answering with what it asked for rather
    // than what is held would confirm the bug and leave the cart holding a
    // number the warehouse does not.
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const id = resId();
    await reserve(ctx.db, { reservationId: id, variantId: variant.id, qty: 3, expiresAt: EXPIRES });
    const second = await reserve(ctx.db, {
      reservationId: id,
      variantId: variant.id,
      qty: 9,
      expiresAt: EXPIRES,
    });
    expect(second).toMatchObject({ ok: true, replayed: true, qty: 3 });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 3 });
  });

  it('THE IDEMPOTENCY IS THE UNIQUE ROW, NOT A JS CHECK — and a rolled-back retry holds once', async () => {
    /*
     * The property that makes the primary key the mechanism: when the INSERT
     * raises 23505, the ENTIRE statement rolls back — including the `reserved`
     * bump in the UPDATE that preceded it. So a replay cannot leave stock held
     * twice even for an instant, and nothing in TypeScript had to notice.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const id = resId();
    const req = { reservationId: id, variantId: variant.id, qty: 2, expiresAt: EXPIRES };
    await reserve(ctx.db, req);

    const replays = await Promise.all([reserve(ctx.db, req), reserve(ctx.db, req), reserve(ctx.db, req)]);
    for (const r of replays) expect(r).toMatchObject({ ok: true, replayed: true });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 2 });

    const holds = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM shop_inventory_holds WHERE reservation_id = ${id}`);
    expect(Number(holds.rows[0].n)).toBe(1);
  });

  it('sells past zero when the variant is backorderable, and `reserved` may exceed `on_hand`', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 0, backorderable: true });
    const result = await reserve(ctx.db, {
      reservationId: resId(),
      variantId: variant.id,
      qty: 5,
      expiresAt: EXPIRES,
    });
    expect(result).toMatchObject({ ok: true, available: -5 });
    // A CHECK demanding `reserved <= on_hand` would look like prudence and
    // would refuse the feature.
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 0, reserved: 5 });
  });

  it('THE STOCK GUARD IS LOAD-BEARING: neutralised, availability goes negative', async () => {
    /*
     * THE MUTATION TEST for the one predicate a shop cannot afford to have
     * quietly stop working. `(backorderable OR on_hand - reserved >= $qty)`
     * replaced by `true`, nothing else changed — so the only thing standing
     * between a customer and overselling is gone.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 2 });
    const mutant = mutating(
      ctx.db,
      /\(i\.backorderable OR i\.on_hand - i\.reserved >= \$\d+\)/i,
      'true',
    );

    const result = await reserve(mutant, {
      reservationId: resId(),
      variantId: variant.id,
      qty: 5,
      expiresAt: EXPIRES,
    });

    expect(result, 'the mutant oversold').toMatchObject({ ok: true });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({
      onHand: 2,
      reserved: 5,
      available: -3,
    });
  });

  it('THE SELLABILITY GUARD IS LOAD-BEARING: neutralised, an unpublished product sells', async () => {
    const { product, variant } = await seedSellable(ctx.db, actor(), { onHand: 5 });
    await unpublishProduct(ctx.db, product.id, actor());

    // The real predicate refuses it.
    expect(
      await reserve(ctx.db, {
        reservationId: resId(),
        variantId: variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
    ).toMatchObject({ ok: false, reason: 'not_sellable' });

    const mutant = mutating(ctx.db, /AND p\.status = 'active'/i, '');
    expect(
      await reserve(mutant, {
        reservationId: resId(),
        variantId: variant.id,
        qty: 1,
        expiresAt: EXPIRES,
      }),
      'the mutant held stock for a product that is not on sale',
    ).toMatchObject({ ok: true });
  });
});

describe('release and commit', () => {
  async function held(qty: number, onHand = 10) {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand });
    const id = resId();
    await reserve(ctx.db, { reservationId: id, variantId: variant.id, qty, expiresAt: EXPIRES });
    return { variantId: variant.id, reservationId: id };
  }

  it('release returns the units and is idempotent', async () => {
    const { variantId, reservationId } = await held(4);
    expect(await releaseHold(ctx.db, reservationId)).toBe(true);
    expect(await releaseHold(ctx.db, reservationId), 'a repeat did work').toBe(false);
    expect(await getInventory(ctx.db, variantId)).toMatchObject({ onHand: 10, reserved: 0 });
    expect((await getHold(ctx.db, reservationId))?.state).toBe('released');
  });

  it('commit moves the hold to a permanent decrement, and is idempotent', async () => {
    const { variantId, reservationId } = await held(4);
    expect(await commitHold(ctx.db, reservationId)).toBe(true);
    expect(await commitHold(ctx.db, reservationId), 'a repeat did work').toBe(false);
    expect(await getInventory(ctx.db, variantId)).toMatchObject({ onHand: 6, reserved: 0 });
    expect((await getHold(ctx.db, reservationId))?.state).toBe('committed');
  });

  it('IS SAFE IN BOTH INTERLEAVINGS of the sweeper/capture race (brief §5)', async () => {
    /*
     * Cart's expiry sweeper calls `release`; Payments' capture calls `commit`.
     * They will race, and whichever loses must not corrupt the count. Both
     * demand `state = 'held'`, so exactly one matches and the loser does
     * nothing at all.
     */
    const a = await held(4);
    expect(await releaseHold(ctx.db, a.reservationId)).toBe(true);
    expect(await commitHold(ctx.db, a.reservationId), 'commit acted on a released hold').toBe(false);
    // The stock went back. Nothing was sold and nothing double-counted.
    expect(await getInventory(ctx.db, a.variantId)).toMatchObject({ onHand: 10, reserved: 0 });

    const b = await held(4);
    expect(await commitHold(ctx.db, b.reservationId)).toBe(true);
    expect(await releaseHold(ctx.db, b.reservationId), 'release handed back sold stock').toBe(false);
    // The sale stands.
    expect(await getInventory(ctx.db, b.variantId)).toMatchObject({ onHand: 6, reserved: 0 });
  });

  it('IS SAFE AFTER EXPIRY — Catalog owns the count, Cart owns the clock', async () => {
    /*
     * `expiresAt` is recorded and acted on by NOTHING here (brief §5). A hold
     * long past its expiry still holds, and both terminal operations still work
     * on it — because the moment Catalog started expiring holds by itself, a
     * capture racing a sweeper would find the units already gone and no record
     * of who took them.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const id = resId();
    await reserve(ctx.db, {
      reservationId: id,
      variantId: variant.id,
      qty: 3,
      expiresAt: 1, // 1970.
    });
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 3 });
    expect((await getHold(ctx.db, id))?.state).toBe('held');

    expect(await commitHold(ctx.db, id)).toBe(true);
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 7, reserved: 0 });
  });

  it('does nothing at all for an unknown reservation', async () => {
    expect(await releaseHold(ctx.db, 'res_never')).toBe(false);
    expect(await commitHold(ctx.db, 'res_never')).toBe(false);
  });

  it('THE HELD GUARD IS LOAD-BEARING: neutralised, a RELEASED hold is still committed', async () => {
    /*
     * The mutation test for the predicate that decides the sweeper/capture race.
     * `state = 'held'` replaced by `true` in `commitHold`, nothing else changed.
     *
     * TWO HOLDS, ONE RELEASED. A single released hold would drive `reserved` to
     * −4 and the database's own CHECK would abort the statement — which would
     * make this test pass for the wrong reason, since the CHECK is a backstop
     * against a backfill and not the mechanism under test. With a second live
     * hold keeping `reserved` positive, the mutant's damage is exactly what it
     * would be in production: stock sold against a reservation somebody had
     * already handed back.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const releasedId = resId();
    const liveId = resId();
    for (const id of [releasedId, liveId]) {
      await reserve(ctx.db, {
        reservationId: id,
        variantId: variant.id,
        qty: 4,
        expiresAt: EXPIRES,
      });
    }
    await releaseHold(ctx.db, releasedId);
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 10, reserved: 4 });

    // The real guard refuses it.
    expect(await commitHold(ctx.db, releasedId)).toBe(false);
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 10, reserved: 4 });

    // Neutralised, the same call sells stock that was handed back.
    const mutant = mutating(ctx.db, /AND state = 'held'/i, '');
    expect(await commitHold(mutant, releasedId)).toBe(true);
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 6, reserved: 0 });
  });
});

describe('concurrency — brief §8', () => {
  it('50 simultaneous reserves against 10 units: exactly 10 succeed, reserved = 10, never negative', async () => {
    /*
     * The definition-of-done requirement, verbatim. Fifty callers each ask for
     * one unit of a variant that has ten.
     *
     * WHAT THIS PROVES. PGlite is single-threaded WASM Postgres with one
     * connection and a FIFO statement queue, so these execute deterministically
     * as fifty conditional UPDATEs in sequence — which genuinely proves the
     * DECISION LOGIC of the predicate (ten match, forty do not) and can never be
     * flaky. It does NOT exercise row-lock blocking or READ COMMITTED
     * EvalPlanQual recheck, which is what real Postgres does under true
     * parallelism; there the backstop is `shop_inventory_reserved_ck` and
     * `shop_inventory_on_hand_ck`, enforced at any degree of parallelism.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        reserve(ctx.db, {
          reservationId: resId(),
          variantId: variant.id,
          qty: 1,
          expiresAt: EXPIRES,
        }),
      ),
    );

    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(40);
    for (const r of refused) expect(r).toMatchObject({ reason: 'insufficient' });

    const level = await getInventory(ctx.db, variant.id);
    expect(level).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    expect(level!.available).toBeGreaterThanOrEqual(0);

    // Exactly ten holds exist, and every one of them is `held`.
    const holds = await ctx.db.execute(sql`
      SELECT state, count(*)::int AS n FROM shop_inventory_holds
       WHERE variant_id = ${variant.id} GROUP BY state`);
    expect(holds.rows).toEqual([{ state: 'held', n: 10 }]);
  });

  it('50 simultaneous reserves of 3 against 10 units: exactly 3 succeed, one unit left', async () => {
    // The non-unit case, which is where an off-by-one in the predicate hides:
    // `>= qty` and `> qty` agree when qty is 1 and disagree at the boundary.
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        reserve(ctx.db, {
          reservationId: resId(),
          variantId: variant.id,
          qty: 3,
          expiresAt: EXPIRES,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ reserved: 9, available: 1 });
  });
});

describe('adjustInventory', () => {
  it('moves on-hand and emits catalog.inventory.adjusted in the SAME statement', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const level = await adjustInventory(ctx.db, variant.id, -3, 'damaged in transit', actor());

    expect(level).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
    const events = await eventsFor(ctx.db, variant.id);
    const adjusted = events.filter((e) => e.type === 'catalog.inventory.adjusted');
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].payload).toMatchObject({
      variantId: variant.id,
      delta: -3,
      // The value AFTER the adjustment, so a consumer never has to re-read and
      // so the log line still means something a month later.
      onHand: 7,
      reason: 'damaged in transit',
      actorId: actor().id,
    });
  });

  it('refuses a zero delta, an empty reason and a write-off larger than the stock', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5 });
    await expect(adjustInventory(ctx.db, variant.id, 0, 'why', actor())).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(adjustInventory(ctx.db, variant.id, 1, '   ', actor())).rejects.toBeInstanceOf(
      BadRequestError,
    );
    // `on_hand >= 0` as a 400 that names the field, not a 500 the client retries
    // five times for a request that can never succeed.
    await expect(adjustInventory(ctx.db, variant.id, -50, 'oops', actor())).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({ onHand: 5 });
  });

  it('404s for a variant with no inventory row', async () => {
    await expect(
      adjustInventory(ctx.db, 'var_nope', 1, 'restock', actor()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('A REFUSED ADJUSTMENT EMITS NOTHING — contract §6 rule 1', async () => {
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 5 });
    const before = await countEvents(ctx.db);
    await expect(adjustInventory(ctx.db, variant.id, -50, 'oops', actor())).rejects.toThrow();
    expect(await countEvents(ctx.db)).toBe(before);
  });

  it('reserve, release and commit emit NOTHING — the ordinary traffic of selling', async () => {
    /*
     * Deliberate (brief §7 lists three catalog events and none of them is a
     * reservation). One outbox row per add-to-cart is a table nobody can read at
     * 2am to find the event that matters.
     */
    const { variant } = await seedSellable(ctx.db, actor(), { onHand: 10 });
    const before = await countEvents(ctx.db);
    const id = resId();
    await reserve(ctx.db, { reservationId: id, variantId: variant.id, qty: 2, expiresAt: EXPIRES });
    await releaseHold(ctx.db, id);
    const id2 = resId();
    await reserve(ctx.db, { reservationId: id2, variantId: variant.id, qty: 2, expiresAt: EXPIRES });
    await commitHold(ctx.db, id2);
    expect(await countEvents(ctx.db)).toBe(before);
  });
});

describe('inventory rows exist for every variant a route can create', () => {
  it('createVariant writes the stock row in the same statement', async () => {
    /*
     * A variant with no inventory row is one `reserve` answers `unknown_variant`
     * for — indistinguishable at the port from one that was deleted. Creating
     * both together makes that state unreachable through this API rather than
     * merely unlikely.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Stocked On Create' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { onHand: 7 });
    await publishProduct(ctx.db, product.id, actor());
    expect(await getInventory(ctx.db, variant.id)).toMatchObject({
      onHand: 7,
      reserved: 0,
      available: 7,
    });
  });
});
