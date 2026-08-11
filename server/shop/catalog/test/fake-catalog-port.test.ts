import { describe, expect, it } from 'vitest';
import { fakeCatalogPort } from './fake-catalog-port';
import type { FakeVariant } from './fake-catalog-port';
import { money } from '../../../../shared/commerce/money';
import type { Db } from '../../../db/client';

/**
 * The fake's own suite.
 *
 * A fake that three other subsystems build against is load-bearing: if it is
 * wrong, Cart's reservation logic is proved against the wrong contract and the
 * mistake surfaces only when the real port is swapped in — i.e. at integration,
 * which is where every round of both prior gauntlets already fails.
 *
 * The same behaviours are asserted against the REAL port in
 * `server/shop/catalog/port.test.ts`, deliberately in the same order and with
 * the same wording, so a divergence between the two is legible as a diff.
 */

/** The fake ignores it, and the type is what keeps the call sites honest. */
const db = null as unknown as Db;

const VARIANT: FakeVariant = {
  variantId: 'var_fake_1',
  productId: 'prd_fake_1',
  sku: 'TEE-NAVY-M',
  title: 'Navy Tee',
  optionValues: { Size: 'M', Colour: 'Navy' },
  price: money(1999, 'GBP'),
  weightGrams: 180,
  backorderable: false,
  onHand: 10,
  reserved: 0,
};

const req = (over: Partial<Parameters<ReturnType<typeof fakeCatalogPort>['reserve']>[1]> = {}) => ({
  reservationId: 'res_1',
  variantId: VARIANT.variantId,
  qty: 1,
  expiresAt: 1_700_000_000_000,
  ...over,
});

describe('quote', () => {
  it('derives `available` and never stores it', async () => {
    const port = fakeCatalogPort([{ ...VARIANT, onHand: 10, reserved: 3 }]);
    const quote = await port.quote(db, VARIANT.variantId);
    expect(quote?.available).toBe(7);
    // The two stored numbers, and only those two.
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 3 });
    expect(quote).not.toHaveProperty('onHand');
  });

  it('is null for an unknown or unsellable variant', async () => {
    const port = fakeCatalogPort([{ ...VARIANT, sellable: false }]);
    expect(await port.quote(db, VARIANT.variantId)).toBeNull();
    expect(await port.quote(db, 'var_nope')).toBeNull();
  });
});

describe('reserve', () => {
  it('holds stock and reports availability after the hold', async () => {
    const port = fakeCatalogPort([VARIANT]);
    const result = await port.reserve(db, req({ qty: 4 }));
    expect(result).toMatchObject({ ok: true, qty: 4, available: 6, replayed: false });
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 4 });
  });

  it('INSUFFICIENT STOCK IS A RETURN VALUE, and it carries the number', async () => {
    const port = fakeCatalogPort([{ ...VARIANT, onHand: 2 }]);
    const result = await port.reserve(db, req({ qty: 5 }));
    // Not a rejection. A shopper taking the last two of an item is the most
    // ordinary event a shop has, and `available` is what the cart shows them.
    expect(result).toEqual({ ok: false, reason: 'insufficient', available: 2 });
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 2, reserved: 0 });
  });

  it('names the other three refusals rather than throwing any of them', async () => {
    const port = fakeCatalogPort([{ ...VARIANT, sellable: false }]);
    expect(await port.reserve(db, req())).toMatchObject({ reason: 'not_sellable' });
    expect(await port.reserve(db, req({ variantId: 'var_nope' }))).toMatchObject({
      reason: 'unknown_variant',
    });
    port.seed({ ...VARIANT, sellable: true });
    expect(await port.reserve(db, req({ qty: 0 }))).toMatchObject({ reason: 'invalid_qty' });
    expect(await port.reserve(db, req({ qty: -1 }))).toMatchObject({ reason: 'invalid_qty' });
    expect(await port.reserve(db, req({ qty: 1.5 }))).toMatchObject({ reason: 'invalid_qty' });
  });

  it('is IDEMPOTENT BY reservationId: twice holds stock once', async () => {
    const port = fakeCatalogPort([VARIANT]);
    const first = await port.reserve(db, req({ qty: 3 }));
    const second = await port.reserve(db, req({ qty: 3 }));

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true, qty: 3 });
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 3 });
  });

  it('sells past zero when the variant is backorderable', async () => {
    const port = fakeCatalogPort([{ ...VARIANT, onHand: 0, backorderable: true }]);
    expect(await port.reserve(db, req({ qty: 5 }))).toMatchObject({ ok: true, available: -5 });
  });
});

describe('release and commitReservation', () => {
  it('release returns the hold and is idempotent', async () => {
    const port = fakeCatalogPort([VARIANT]);
    await port.reserve(db, req({ qty: 4 }));
    await port.release(db, 'res_1');
    await port.release(db, 'res_1');
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 0 });
    expect(port.holdOf('res_1')?.state).toBe('released');
  });

  it('commit moves the hold to a permanent decrement, and is idempotent', async () => {
    const port = fakeCatalogPort([VARIANT]);
    await port.reserve(db, req({ qty: 4 }));
    await port.commitReservation(db, 'res_1');
    await port.commitReservation(db, 'res_1');
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 6, reserved: 0 });
    expect(port.holdOf('res_1')?.state).toBe('committed');
  });

  it('is safe in BOTH interleavings of the sweeper/capture race (brief §5)', async () => {
    /*
     * Cart's expiry sweeper calls `release`; Payments' capture calls
     * `commitReservation`. They will race, and whichever loses must not corrupt
     * the count — so the loser is a no-op in both directions rather than a
     * second decrement.
     */
    const releaseFirst = fakeCatalogPort([VARIANT]);
    await releaseFirst.reserve(db, req({ qty: 4 }));
    await releaseFirst.release(db, 'res_1');
    await releaseFirst.commitReservation(db, 'res_1');
    // The stock went back. Nothing was sold, and nothing was double-counted.
    expect(releaseFirst.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 0 });

    const commitFirst = fakeCatalogPort([VARIANT]);
    await commitFirst.reserve(db, req({ qty: 4 }));
    await commitFirst.commitReservation(db, 'res_1');
    await commitFirst.release(db, 'res_1');
    // The sale stands. The late release does not hand back sold stock.
    expect(commitFirst.stockOf(VARIANT.variantId)).toEqual({ onHand: 6, reserved: 0 });
  });

  it('does not act on an unknown reservation', async () => {
    const port = fakeCatalogPort([VARIANT]);
    await port.release(db, 'res_never');
    await port.commitReservation(db, 'res_never');
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('records `expiresAt` and never acts on it — the clock is Cart’s', async () => {
    const port = fakeCatalogPort([VARIANT]);
    await port.reserve(db, req({ qty: 4, expiresAt: 1 }));
    // Long past, and the hold still holds. Catalog owns the count, Cart owns
    // the clock (brief §5) — a fake that expired holds by itself would let a
    // Cart suite pass without ever having written the sweeper.
    expect(port.holdOf('res_1')).toMatchObject({ state: 'held', expiresAt: 1 });
    expect(port.stockOf(VARIANT.variantId)).toEqual({ onHand: 10, reserved: 4 });
  });
});
