/**
 * Cart, driven end to end against the **REAL** `CatalogPort`.
 *
 * Brief §8's last-but-one line: "Works end-to-end against the **fake**
 * `CatalogPort`, then against the real one." Every other suite in this
 * subsystem uses `test/fake-catalog.ts`, which is what keeps Cart runnable while
 * Catalog's tree is mid-edit. This one file closes the loop: real
 * `shop_products` / `shop_variants` / `shop_prices` / `shop_inventory` rows,
 * seeded through Catalog's own repository functions, quoted and reserved through
 * `server/shop/catalog/port.ts`, with the stock counters read back out of
 * Catalog's table rather than out of a JavaScript object.
 *
 * ═══ THE TWO CROSS-SUBSYSTEM IMPORTS IN CART, AND WHY THEY ARE HERE ═══
 * R2 forbids importing another subsystem's repo or route modules FROM CART'S
 * SOURCE. No module under `server/shop/cart/` that ships does so — the port
 * arrives by injection, which is the whole point of §5. This file and
 * `catalog-port-drift.test.ts` are tests, and a test that never wires the two
 * halves together is a test that cannot find the seam they meet at. Confined to
 * these two files so a broken Catalog tree costs Cart two red tests rather than
 * a red bar.
 *
 * ═══ WHAT THIS CATCHES THAT THE FAKE CANNOT ═══
 * The fake is faithful by construction because Cart wrote it. What it cannot be
 * is WRONG in the same places the real one is: a `quote` that joins prices
 * differently, a `reserve` whose predicate admits a case Cart's fake refuses,
 * a `release` that is not idempotent against a real row. Those are exactly the
 * failures that surface at integration, which is where every round of both prior
 * gauntlets already fails.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from './test/harness';
import { catalogPort } from '../catalog/port';
import { seedSellable } from '../catalog/test/catalog-harness';
import { addLine, createCart, getCart } from './cart/repo';
import {
  commitReservationsForCart,
  listReservations,
  releaseReservationsForCart,

  sweepExpiredReservations,
} from './reservations/repo';
import {
  completeCheckout,
  freezeCheckout,
  frozenTotals,
  putAddresses,
  setShipping,
  startCheckout,
} from './checkout/repo';
import { DEFAULT_SHIPPING_ZONES, DEFAULT_STORE_CURRENCY } from './checkout/shipping';
import type { TestCtx } from './test/harness';

let ctx: TestCtx;

const CURRENCY = DEFAULT_STORE_CURRENCY;
const CONFIG = { zones: DEFAULT_SHIPPING_ZONES, storeCurrency: CURRENCY };

const UK = {
  name: 'A Shopper',
  line1: '1 High Street',
  line2: null,
  city: 'London',
  region: null,
  postalCode: 'E1 6AN',
  countryCode: 'GB',
  phone: null,
};

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  // Catalog's tables too, so each test seeds its own product. CASCADE reaches
  // variants, prices, inventory and holds.
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_inventory_holds CASCADE`);
});

/** Real stock, straight out of Catalog's table — never out of a fake's map. */
async function stock(variantId: string): Promise<{ onHand: number; reserved: number }> {
  const res = await ctx.db.execute(sql`
    SELECT on_hand, reserved FROM shop_inventory WHERE variant_id = ${variantId}`);
  const row = res.rows[0];
  return { onHand: Number(row.on_hand), reserved: Number(row.reserved) };
}

/** A published product with one priced, stocked variant. */
async function sellable(o: { onHand?: number; amount?: number } = {}) {
  const { variant } = await seedSellable(ctx.db, ctx.users.owner, {
    title: 'Navy Tee',
    onHand: o.onHand ?? 10,
    amount: o.amount ?? 1999,
    currency: CURRENCY,
  });
  return variant;
}

describe('the port answers Cart the way Cart’s fake does', () => {
  it('quotes a published, priced, stocked variant', async () => {
    const variant = await sellable({ onHand: 10, amount: 1999 });
    const quote = await catalogPort.quote(ctx.db, variant.id);

    expect(quote).not.toBeNull();
    expect(quote?.price).toEqual({ amount: 1999, currency: CURRENCY });
    expect(quote?.available).toBe(10);
    // Derived, never stored — the two columns stay behind the port.
    expect(quote).not.toHaveProperty('onHand');
    expect(quote).not.toHaveProperty('reserved');
  });

  it('answers null for a variant whose product has been unpublished', async () => {
    /*
     * The case Cart renders as "no longer available" rather than dropping
     * (brief §3). Driven through Catalog's real lifecycle rather than through a
     * `sellable: false` flag, because "sellable" is Catalog's predicate and this
     * is the test that proves Cart is asking the right question.
     */
    const variant = await sellable();
    const { unpublishProduct } = await import('../catalog/products');
    await unpublishProduct(ctx.db, variant.productId, ctx.users.owner);

    expect(await catalogPort.quote(ctx.db, variant.id)).toBeNull();
  });
});

describe('a whole guest checkout, against real stock', () => {
  it('cart → start → addresses → shipping → freeze → complete', async () => {
    const variant = await sellable({ onHand: 10, amount: 1999 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 2 });

    const started = await startCheckout(ctx.db, catalogPort, { cartId: cart.id });
    expect(started.ok).toBe(true);
    // Held in CATALOG'S table, by Cart's reservation id.
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 2 });

    await putAddresses(ctx.db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
    await setShipping(ctx.db, CONFIG, { cartId: cart.id, optionId: 'standard' });

    const frozen = await freezeCheckout(ctx.db, catalogPort, CONFIG, { cartId: cart.id });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    // 2 × £19.99 + £3.99 delivery + 20% VAT on both.
    expect(frozen.totals.grandTotal).toEqual({ amount: 3998 + 399 + 880, currency: CURRENCY });

    await completeCheckout(ctx.db, { cartId: cart.id });
    expect((await getCart(ctx.db, cart.id))?.status).toBe('converted');

    // The stock is still HELD, not sold: nothing has captured a payment yet.
    // This is A-007's gap made visible — the commit below has no caller in the
    // contract, and without one these two units expire back into stock fifteen
    // minutes after the customer paid.
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 2 });

    const committed = await commitReservationsForCart(ctx.db, catalogPort, cart.id);
    expect(committed).toBe(1);
    expect(await stock(variant.id)).toEqual({ onHand: 8, reserved: 0 });
  });

  it('the frozen total survives a real price change', async () => {
    /*
     * The subsystem's defining property, now against a real `shop_prices` row
     * rather than a fake's field: `setPrice` writes a new effective-dated row and
     * closes the old one, and the frozen total does not move.
     */
    const variant = await sellable({ onHand: 10, amount: 1999 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 1 });
    await putAddresses(ctx.db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
    await setShipping(ctx.db, CONFIG, { cartId: cart.id, optionId: 'standard' });
    const frozen = await freezeCheckout(ctx.db, catalogPort, CONFIG, { cartId: cart.id });
    if (!frozen.ok) throw new Error('expected totals');

    const { setPrice } = await import('../catalog/prices');
    const { money } = await import('../../../shared/commerce/money');
    await setPrice(ctx.db, variant.id, money(9999, CURRENCY));
    // The live quote HAS moved — so this is a real change, not a no-op.
    expect((await catalogPort.quote(ctx.db, variant.id))?.price.amount).toBe(9999);

    expect(await frozenTotals(ctx.db, cart.id)).toEqual(frozen.totals);
  });
});

describe('insufficient stock, decided by Catalog’s predicate', () => {
  it('is a return value with the REAL number in it', async () => {
    const variant = await sellable({ onHand: 3 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 5 });

    const result = await startCheckout(ctx.db, catalogPort, { cartId: cart.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'insufficient') throw new Error(result.reason);
    expect(result.shortfalls).toEqual([
      { variantId: variant.id, requested: 5, available: 3 },
    ]);
    // Nothing held, and Catalog's counter is untouched.
    expect(await stock(variant.id)).toEqual({ onHand: 3, reserved: 0 });
  });

  it('50 concurrent checkouts against 10 units yield exactly 10 holds', async () => {
    /*
     * Brief §8's number, now against the REAL conditional decrement rather than
     * Cart's SQL-backed stand-in. `reservation-concurrency.test.ts` proves the
     * predicate is load-bearing by removing it; this proves Catalog's own
     * predicate produces the same answer through Cart's code path.
     *
     * Still serialised by PGlite's single connection — see that file for what
     * that does and does not establish.
     */
    const variant = await sellable({ onHand: 10 });
    const carts: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const cart = await createCart(ctx.db, { currency: CURRENCY });
      await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 1 });
      carts.push(cart.id);
    }

    const outcomes = await Promise.all(
      carts.map((cartId) => startCheckout(ctx.db, catalogPort, { cartId })),
    );

    expect(outcomes.filter((o) => o.ok)).toHaveLength(10);
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 10 });

    const held = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM shop_reservations WHERE state = 'held'`,
    );
    // Cart's ledger and Catalog's counter agree — the pair GAUNTLET keeps
    // finding in disagreement.
    expect(Number(held.rows[0].n)).toBe(10);
  });
});

describe('the sweeper and the capture, against Catalog’s real hold table', () => {
  async function expiredHold() {
    const variant = await sellable({ onHand: 10 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 2 });
    const started = await startCheckout(ctx.db, catalogPort, { cartId: cart.id });
    if (!started.ok) throw new Error('expected holds');
    await ctx.db.execute(sql`UPDATE shop_reservations SET expires_at = ${Date.now() - 1}`);
    return { variant, cart, reservationId: started.reservations[0].id };
  }

  it('the sweeper gives the stock back exactly once', async () => {
    const { variant } = await expiredHold();

    expect((await sweepExpiredReservations(ctx.db, catalogPort)).released).toBe(1);
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 0 });

    // Idempotent against a real row, not just against a fake's guard.
    expect((await sweepExpiredReservations(ctx.db, catalogPort)).released).toBe(0);
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('capture first, then the sweeper: no double decrement', async () => {
    const { variant, cart } = await expiredHold();

    expect(await commitReservationsForCart(ctx.db, catalogPort, cart.id)).toBe(1);
    expect((await sweepExpiredReservations(ctx.db, catalogPort)).released).toBe(0);

    // Sold once. A double decrement would show as onHand 6.
    expect(await stock(variant.id)).toEqual({ onHand: 8, reserved: 0 });
  });

  it('the sweeper first, then capture: the capture does nothing', async () => {
    const { variant, cart } = await expiredHold();

    expect((await sweepExpiredReservations(ctx.db, catalogPort)).released).toBe(1);
    expect(await commitReservationsForCart(ctx.db, catalogPort, cart.id)).toBe(0);

    // Released, not sold — and `on_hand` never moved.
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('Cart’s ledger and Catalog’s hold table end in agreeing states', async () => {
    /*
     * TWO RECORDS OF ONE FACT, and the whole design is that exactly one of them
     * arbitrates. Cart's `shop_reservations.state` decides who calls the port;
     * Catalog's `shop_inventory_holds.state` decides whether the count moves.
     * If they can end in disagreeing states, one of them is lying about a
     * physical object.
     */
    const { variant, cart, reservationId } = await expiredHold();
    await commitReservationsForCart(ctx.db, catalogPort, cart.id);
    await sweepExpiredReservations(ctx.db, catalogPort);
    await releaseReservationsForCart(ctx.db, catalogPort, cart.id);

    const mine = (await listReservations(ctx.db, cart.id))[0];
    const theirs = await ctx.db.execute(sql`
      SELECT state FROM shop_inventory_holds WHERE reservation_id = ${reservationId}`);

    expect(mine.state).toBe('committed');
    expect(String(theirs.rows[0].state)).toBe('committed');
    expect(await stock(variant.id)).toEqual({ onHand: 8, reserved: 0 });
  });
});

describe('idempotency across the real port', () => {
  it('re-starting a checkout holds the stock once', async () => {
    const variant = await sellable({ onHand: 10 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    await addLine(ctx.db, { cartId: cart.id, variantId: variant.id, qty: 3 });

    const first = await startCheckout(ctx.db, catalogPort, { cartId: cart.id });
    const second = await startCheckout(ctx.db, catalogPort, { cartId: cart.id });

    if (!first.ok || !second.ok) throw new Error('expected holds');
    expect(second.reservations[0].id).toBe(first.reservations[0].id);
    // Three units, not six. `reservationId` is the idempotency key on both sides.
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 3 });
  });

  it('reducing a quantity between starts frees the difference immediately', async () => {
    const variant = await sellable({ onHand: 10 });
    const cart = await createCart(ctx.db, { currency: CURRENCY });
    const { line } = await addLine(ctx.db, {
      cartId: cart.id,
      variantId: variant.id,
      qty: 6,
    });
    await startCheckout(ctx.db, catalogPort, { cartId: cart.id });
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 6 });

    const { setLineQty } = await import('./cart/repo');
    await setLineQty(ctx.db, { cartId: cart.id, lineId: line.id, qty: 2 });
    await startCheckout(ctx.db, catalogPort, { cartId: cart.id });

    // Four units back on the shelf for somebody else, not held until expiry.
    expect(await stock(variant.id)).toEqual({ onHand: 10, reserved: 2 });
  });
});
