/**
 * The cart write path: CAS on `shop_carts.revision`, and the state guard that
 * keeps a converting cart from gaining lines.
 *
 * EVERY GUARD IN THIS FILE HAS A MUTATION TEST. GAUNTLET II Part 2b is the
 * reason: replacing `deleted_at IS NULL` with `true` broke none of 254 server
 * tests, because every precondition case was satisfied by a JavaScript check on
 * a stale read. So each guard here is proved twice — once by asserting the
 * refusal, and once by rewriting the predicate en route to the driver and
 * watching the refusal stop happening.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables, TEST_CURRENCY } from '../test/harness';
import { GUARDS, mutating } from '../test/mutating';
import { CartPreconditionError, CartStaleWriteError } from '../errors';
import { NotFoundError } from '../../../repo/errors';
import {
  addLine,
  createCart,
  getCart,
  listLines,
  removeLine,
  setCartStatus,
  setLineQty,
} from './repo';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());
beforeEach(() => resetShopTables(db));

const VARIANT = 'var_tee_navy_m';

async function openCart() {
  return createCart(db, { currency: TEST_CURRENCY });
}

describe('createCart', () => {
  it('opens an anonymous cart at revision 1 with no customer', async () => {
    const cart = await openCart();
    expect(cart.id).toMatch(/^crt_/);
    expect(cart.customerId).toBeNull();
    expect(cart.status).toBe('open');
    expect(cart.revision).toBe(1);
    expect(cart.currency).toBe(TEST_CURRENCY);
  });

  it('gives it an expiry in the future, so an abandoned cart is sweepable', async () => {
    const cart = await openCart();
    expect(cart.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refuses a currency that is not ISO-4217, at the database', async () => {
    // The CHECK in migration 0120, not a TypeScript type: `.$type<>()` is
    // compile-time only (contract §4), and a currency arriving from an import
    // or a hand-run INSERT would otherwise reach the totals engine.
    await expect(
      db.execute(sql`
        INSERT INTO shop_carts (id, currency, status, created_at, updated_at, expires_at, revision)
        VALUES ('crt_bad', 'gbp', 'open', 1, 1, 2, 1)`),
    ).rejects.toThrow();
  });
});

describe('addLine', () => {
  it('adds a line and bumps the cart revision', async () => {
    const cart = await openCart();
    const { cart: after, line } = await addLine(db, {
      cartId: cart.id,
      variantId: VARIANT,
      qty: 2,
    });

    expect(line.variantId).toBe(VARIANT);
    expect(line.qty).toBe(2);
    expect(after.revision).toBe(2);
    expect(await listLines(db, cart.id)).toHaveLength(1);
  });

  it('SUMS quantities for a variant already in the cart, keeping ONE line', async () => {
    // `UNIQUE (cart_id, variant_id)` makes a second row impossible, so the only
    // question is whether the second add is lost or added. Summing is what a
    // shopper means by pressing "add to basket" twice.
    const cart = await openCart();
    await addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 2 });
    const { line } = await addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 3 });

    expect(line.qty).toBe(5);
    expect(await listLines(db, cart.id)).toHaveLength(1);
  });

  it('refuses a non-positive quantity before it reaches the database', async () => {
    const cart = await openCart();
    await expect(addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 0 })).rejects.toThrow(
      /qty/,
    );
    await expect(addLine(db, { cartId: cart.id, variantId: VARIANT, qty: -1 })).rejects.toThrow(
      /qty/,
    );
    // And the database refuses it too, so no other path can write one.
    await expect(
      db.execute(sql`
        INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
        VALUES ('crl_x', ${cart.id}, ${VARIANT}, 0, 1)`),
    ).rejects.toThrow();
  });

  it('404s on a cart that does not exist', async () => {
    await expect(
      addLine(db, { cartId: 'crt_nope', variantId: VARIANT, qty: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the cart CAS', () => {
  it('refuses a write based on a revision the cart has moved past', async () => {
    const cart = await openCart();
    await addLine(db, { cartId: cart.id, variantId: 'var_other', qty: 1 });

    const err = await addLine(db, {
      cartId: cart.id,
      variantId: VARIANT,
      qty: 1,
      baseRevision: cart.revision, // 1 — the cart is now at 2
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CartStaleWriteError);
    const stale = err as CartStaleWriteError;
    expect(stale.expected).toBe(1);
    expect(stale.actual).toBe(2);
    // The current cart rides along so a client re-renders with no second request
    // — the same property `StaleWriteError` gives the post path.
    expect(stale.cart?.id).toBe(cart.id);
    expect(stale.cart?.revision).toBe(2);
  });

  it('writes NOTHING when it loses — no line, no revision bump', async () => {
    /*
     * The property that makes a lost CAS safe rather than merely reported. The
     * line insert selects FROM the cart update, so a predicate that matches
     * nothing inserts nothing; there is no window in which the line lands and
     * the cart does not.
     */
    const cart = await openCart();
    await addLine(db, { cartId: cart.id, variantId: 'var_other', qty: 1 });

    await addLine(db, {
      cartId: cart.id,
      variantId: VARIANT,
      qty: 1,
      baseRevision: 1,
    }).catch(() => undefined);

    expect(await listLines(db, cart.id)).toHaveLength(1);
    expect((await getCart(db, cart.id))?.revision).toBe(2);
  });

  it('MUTATION: neutralising `revision = $n` lets the stale write through', async () => {
    const cart = await openCart();
    await addLine(db, { cartId: cart.id, variantId: 'var_other', qty: 1 });

    const mutant = mutating(db, GUARDS.cartCas, 'true');
    // With the CAS neutralised the same call SUCCEEDS. That is the proof the
    // predicate is what refuses it, and not a JS comparison on a stale read.
    await expect(
      addLine(mutant, { cartId: cart.id, variantId: VARIANT, qty: 1, baseRevision: 1 }),
    ).resolves.toBeDefined();
    expect(await listLines(db, cart.id)).toHaveLength(2);
  });
});

describe('the `status = open` guard', () => {
  it('refuses to add a line to a cart that is converting', async () => {
    const cart = await openCart();
    const converting = await setCartStatus(db, {
      cartId: cart.id,
      to: 'converting',
      baseRevision: cart.revision,
    });

    const err = await addLine(db, {
      cartId: cart.id,
      variantId: VARIANT,
      qty: 1,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CartPreconditionError);
    expect((err as CartPreconditionError).operation).toBe('add_line');
    expect((err as CartPreconditionError).cart.status).toBe('converting');
    // A refusal, not a race: the cart did not move.
    expect((await getCart(db, cart.id))?.revision).toBe(converting.revision);
    expect(await listLines(db, cart.id)).toHaveLength(0);
  });

  it('refuses to change or remove a line on a converting cart', async () => {
    const cart = await openCart();
    const { line } = await addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 1 });
    await setCartStatus(db, { cartId: cart.id, to: 'converting', baseRevision: 2 });

    await expect(
      setLineQty(db, { cartId: cart.id, lineId: line.id, qty: 5 }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
    await expect(
      removeLine(db, { cartId: cart.id, lineId: line.id }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
    // The line is untouched by either refusal.
    expect((await listLines(db, cart.id))[0].qty).toBe(1);
  });

  it('MUTATION: neutralising `status = open` lets a converting cart be edited', async () => {
    const cart = await openCart();
    await setCartStatus(db, { cartId: cart.id, to: 'converting', baseRevision: 1 });

    const mutant = mutating(db, GUARDS.cartOpen, 'true');
    await expect(
      addLine(mutant, { cartId: cart.id, variantId: VARIANT, qty: 1 }),
    ).resolves.toBeDefined();
    expect(await listLines(db, cart.id)).toHaveLength(1);
  });
});

describe('setLineQty and removeLine', () => {
  it('replaces the quantity rather than adding to it', async () => {
    const cart = await openCart();
    const { line } = await addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 4 });
    const { line: updated } = await setLineQty(db, {
      cartId: cart.id,
      lineId: line.id,
      qty: 2,
    });
    expect(updated.qty).toBe(2);
  });

  it('removes a line and bumps the revision', async () => {
    const cart = await openCart();
    const { line } = await addLine(db, { cartId: cart.id, variantId: VARIANT, qty: 1 });
    const after = await removeLine(db, { cartId: cart.id, lineId: line.id });
    expect(after.revision).toBe(3);
    expect(await listLines(db, cart.id)).toHaveLength(0);
  });

  it('404s on a line that is not in this cart, without bumping the revision', async () => {
    /*
     * SCOPED TO THE CART, not just to the line id. Without `cart_id = $n` in the
     * predicate, knowing a line id would let anybody edit a stranger's basket —
     * the storefront is anonymous, so a line id is the only thing standing
     * between two carts.
     */
    const mine = await openCart();
    const theirs = await openCart();
    const { line } = await addLine(db, { cartId: theirs.id, variantId: VARIANT, qty: 1 });

    await expect(
      removeLine(db, { cartId: mine.id, lineId: line.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await getCart(db, mine.id))?.revision).toBe(1);
    expect(await listLines(db, theirs.id)).toHaveLength(1);
  });
});

describe('setCartStatus — the checkout state machine', () => {
  it('walks open → converting → converted', async () => {
    const cart = await openCart();
    const converting = await setCartStatus(db, {
      cartId: cart.id,
      to: 'converting',
      baseRevision: 1,
    });
    expect(converting.status).toBe('converting');
    const converted = await setCartStatus(db, {
      cartId: cart.id,
      to: 'converted',
      baseRevision: converting.revision,
    });
    expect(converted.status).toBe('converted');
  });

  it('refuses a transition the machine does not have', async () => {
    const cart = await openCart();
    await setCartStatus(db, { cartId: cart.id, to: 'converting', baseRevision: 1 });
    await setCartStatus(db, { cartId: cart.id, to: 'converted', baseRevision: 2 });

    // `converted` is terminal: a converted cart has become an order.
    await expect(
      setCartStatus(db, { cartId: cart.id, to: 'open', baseRevision: 3 }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
  });

  it('NEVER RETRIES, so an A→B→A interleaving cannot re-apply a lost intent', async () => {
    /*
     * THE DEFECT THIS SUBSYSTEM IS DESIGNED NOT TO HAVE.
     *
     * GAUNTLET II Part 2b: all six post lifecycle transitions re-applied a lost
     * intent after an A→B→A interleaving, because a bounded internal retry
     * re-evaluated a precondition that only asks about CURRENT state — and a
     * concurrent inverse operation returns the row to a state the precondition
     * accepts. The fix there was `posts.lifecycle_generation`, a trigger-
     * maintained counter pinned across the retry.
     *
     * Cart needs no such column because Cart HAS NO RETRY. Every write takes a
     * base revision and gets exactly one attempt; a lost CAS is a 409 and the
     * caller decides. `revision` moves on every write of any kind, so
     * open → converting → open is visible as a revision change even though the
     * status came back to where it started — which is precisely what a state
     * precondition alone could not express.
     *
     * Executed here rather than argued: the cart goes converting and back to
     * open, and the write based on the original revision is still refused.
     */
    const cart = await openCart();
    const converting = await setCartStatus(db, {
      cartId: cart.id,
      to: 'converting',
      baseRevision: 1,
    });
    const reopened = await setCartStatus(db, {
      cartId: cart.id,
      to: 'open',
      baseRevision: converting.revision,
    });
    expect(reopened.status).toBe('open'); // A → B → A: back where it started

    const err = await setCartStatus(db, {
      cartId: cart.id,
      to: 'converting',
      baseRevision: 1, // the revision the caller read before any of that
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CartStaleWriteError);
    expect((err as CartStaleWriteError).actual).toBe(3);
  });

  it('MUTATION: neutralising the CAS lets the A→B→A write land', async () => {
    const cart = await openCart();
    await setCartStatus(db, { cartId: cart.id, to: 'converting', baseRevision: 1 });
    await setCartStatus(db, { cartId: cart.id, to: 'open', baseRevision: 2 });

    const mutant = mutating(db, GUARDS.cartCas, 'true');
    await expect(
      setCartStatus(mutant, { cartId: cart.id, to: 'converting', baseRevision: 1 }),
    ).resolves.toBeDefined();
    expect((await getCart(db, cart.id))?.status).toBe('converting');
  });
});
