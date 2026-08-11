/**
 * Guest → account: two carts, one customer (brief §2).
 *
 * "Attaching a customer later MERGES: two carts, one customer, and the merge
 * rule must be written down and tested (recommended: union the lines, sum
 * quantities for the same variant, cap at available stock, and TELL THE CUSTOMER
 * WHAT CHANGED rather than silently clamping)."
 *
 * The last clause is the one with teeth. A merge that silently clamps is a
 * basket that quietly holds fewer of something than the shopper put in it, and
 * they find out at the confirmation email.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import { createCustomer } from '../identity/customers';
import { addLine, createCart, getCart, listLines, setCartStatus } from './repo';
import { adoptCartForCustomer, MERGE_RULE } from './merge';
import type { CartFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

const CURRENCY = 'GBP';

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  catalog = fakeCatalog([
    { variantId: 'var_a', price: { amount: 1000, currency: CURRENCY }, onHand: 10 },
    { variantId: 'var_b', price: { amount: 500, currency: CURRENCY }, onHand: 10 },
    { variantId: 'var_scarce', price: { amount: 100, currency: CURRENCY }, onHand: 3 },
  ]);
});

async function cartWith(lines: Array<[string, number]>, customerId?: string) {
  const cart = await createCart(db, { currency: CURRENCY, customerId });
  for (const [variantId, qty] of lines) {
    await addLine(db, { cartId: cart.id, variantId, qty });
  }
  return (await getCart(db, cart.id))!;
}

describe('the merge rule is written down', () => {
  it('states the four decisions in one place', () => {
    // A rule that exists only as behaviour is a rule nobody can check a bug
    // report against. This constant is what the customer-facing copy quotes.
    expect(MERGE_RULE.union).toBe(true);
    expect(MERGE_RULE.sameVariant).toBe('sum');
    expect(MERGE_RULE.overAvailable).toBe('cap-and-report');
    expect(MERGE_RULE.survivor).toBe('customer-cart');
  });
});

describe('when the customer has no cart yet', () => {
  it('ADOPTS the guest cart rather than copying it', async () => {
    // Copying would leave two carts and a decision about which is real. The
    // guest cart already holds the reservations and the addresses; attaching a
    // customer to it is one UPDATE and loses nothing.
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const guest = await cartWith([['var_a', 2]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect(result.cartId).toBe(guest.id);
    expect(result.merged).toBe(false);
    expect(result.changes).toEqual([]);
    expect((await getCart(db, guest.id))?.customerId).toBe(customer.id);
  });

  it('is a no-op when the guest cart is already theirs', async () => {
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const cart = await cartWith([['var_a', 1]], customer.id);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: cart.id,
      customerId: customer.id,
    });

    expect(result.cartId).toBe(cart.id);
    expect(result.merged).toBe(false);
  });
});

describe('when both carts exist', () => {
  it('UNIONS the lines into the customer’s cart and abandons the guest one', async () => {
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const mine = await cartWith([['var_a', 1]], customer.id);
    const guest = await cartWith([['var_b', 2]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect(result.cartId).toBe(mine.id);
    expect(result.merged).toBe(true);
    const lines = await listLines(db, mine.id);
    expect(lines.map((l) => [l.variantId, l.qty]).sort()).toEqual([
      ['var_a', 1],
      ['var_b', 2],
    ]);
    // The guest cart is ABANDONED, not deleted: its reservations and its
    // history are evidence, and a hard delete would take them with it.
    expect((await getCart(db, guest.id))?.status).toBe('abandoned');
  });

  it('SUMS quantities for a variant in both carts', async () => {
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const mine = await cartWith([['var_a', 2]], customer.id);
    const guest = await cartWith([['var_a', 3]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect((await listLines(db, mine.id))[0].qty).toBe(5);
    // Nothing was capped, so nothing is reported — a change list that always
    // has entries is one nobody reads.
    expect(result.changes).toEqual([]);
  });

  it('CAPS at available stock AND SAYS SO', async () => {
    /*
     * The clause the brief calls out. Three in stock, two carts wanting two each
     * — the basket ends up with three and the customer is TOLD, with the number.
     * Silently clamping is how somebody discovers at the confirmation email that
     * they are getting three of the four they thought they had bought.
     */
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const mine = await cartWith([['var_scarce', 2]], customer.id);
    const guest = await cartWith([['var_scarce', 2]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect((await listLines(db, mine.id))[0].qty).toBe(3);
    expect(result.changes).toEqual([
      {
        variantId: 'var_scarce',
        kind: 'capped',
        requested: 4,
        applied: 3,
        available: 3,
      },
    ]);
  });

  it('reports a line it could not add at all, and does not drop it silently', async () => {
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const mine = await cartWith([['var_a', 1]], customer.id);
    const guest = await cartWith([['var_gone', 1]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect(await listLines(db, mine.id)).toHaveLength(1);
    expect(result.changes).toEqual([
      {
        variantId: 'var_gone',
        kind: 'unavailable',
        requested: 1,
        applied: 0,
        available: 0,
      },
    ]);
  });

  it('REFUSES to merge across currencies rather than coercing', async () => {
    const customer = await createCustomer(db, { email: 'a@test.local' });
    await createCart(db, { currency: 'USD', customerId: customer.id });
    const guest = await cartWith([['var_a', 1]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    // Both carts survive and the guest cart is the one in use, because it is the
    // one the shopper is looking at. Nothing is silently converted — contract
    // §10 has no conversion step and §13 has no multi-currency storefront.
    expect(result.merged).toBe(false);
    expect(result.cartId).toBe(guest.id);
    expect(result.changes).toEqual([
      { variantId: '', kind: 'currency_mismatch', requested: 0, applied: 0, available: 0 },
    ]);
  });

  it('ignores a customer cart that is not open — a converting cart is mid-purchase', async () => {
    /*
     * Merging into a cart whose totals have been frozen would change what the
     * customer is about to be charged for after they have seen the number. The
     * frozen cart is left alone and the guest cart is adopted instead.
     */
    const customer = await createCustomer(db, { email: 'a@test.local' });
    const mine = await cartWith([['var_a', 1]], customer.id);
    await setCartStatus(db, { cartId: mine.id, to: 'converting', baseRevision: mine.revision });
    const guest = await cartWith([['var_b', 1]]);

    const result = await adoptCartForCustomer(db, catalog, {
      guestCartId: guest.id,
      customerId: customer.id,
    });

    expect(result.cartId).toBe(guest.id);
    expect(await listLines(db, mine.id)).toHaveLength(1);
  });
});
