/**
 * GUEST ORDERS FOLLOW THEIR BUYER INTO AN ACCOUNT (2026-09-08).
 *
 * WHAT THIS FILE IS FOR. A guest checkout leaves `customer_id NULL` and keeps
 * only the typed email; the identity bridge mints a customer row keyed by a
 * verified address. Nothing joined the two, and `listCustomerOrders` has always
 * been scoped by id alone — so everybody who bought first and registered later
 * had an empty order history. Found on a real shopper: one guest order, one
 * customer row, the same address on both, and no row between them.
 *
 * The four tests below are the four ways the obvious one-line fix goes wrong:
 * it adopts somebody else's order, it steals an order that already has an owner,
 * it misses the address because the buyer typed it in a different case, or it
 * breaks the guest receipt link that is already sitting in a mailbox. Each is a
 * separate test, because a single "adoption works" assertion passes on an
 * implementation that does all four.
 *
 * `server/shop/cart/identity/session.test.ts` proves the other half — that the
 * composition root actually HANDS this function to the exchange route. Neither
 * question implies the other; that is the whole lesson of `composition.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import {
  adoptGuestOrders,
  getOrderForGuest,
  listCustomerOrders,
  readOrderByCheckout,
} from './repo/orders';

let ctx: RawCtx;

const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: null };
const BUYER = 'Buyer@Example.test';
const OWNER = 'cus_the_account';

beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/**
 * A REAL ORDER THROUGH THE REAL CONSUMER, not an `INSERT` of my own.
 *
 * An invented row is a row whose `customer_id` I chose, and "a guest checkout
 * leaves it NULL" is precisely the premise under test — so a hand-written
 * fixture would prove the fix against my belief about the write path rather
 * than against the write path. `checkoutCompleted({ customerId: null })` is the
 * event a guest checkout actually emits.
 */
async function guestOrder(
  over: { checkoutId?: string; email?: string; customerId?: string | null } = {},
): Promise<void> {
  const checkoutId = over.checkoutId ?? CHECKOUT;
  await insertEvents(ctx.db, [
    {
      ...checkoutCompleted({
        checkoutId,
        customerId: over.customerId ?? null,
        email: over.email ?? BUYER,
      }),
      id: `evt_checkout_${checkoutId}`,
      subjectId: checkoutId,
    },
  ]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW, 50);
}

async function customerIdOf(checkoutId: string): Promise<string | null> {
  const read = await readOrderByCheckout(ctx.db, checkoutId);
  return read?.order.customerId ?? null;
}

describe('adopting the orders placed before the account existed', () => {
  it('links a guest order to the customer whose verified address matches', async () => {
    await guestOrder();
    expect(await customerIdOf(CHECKOUT)).toBeNull();

    expect(await adoptGuestOrders(ctx.db, OWNER, BUYER)).toBe(1);
    expect(await customerIdOf(CHECKOUT)).toBe(OWNER);

    // The point of the exercise: the history query that was empty is not.
    const page = await listCustomerOrders(ctx.db, OWNER, {});
    expect(page.items.map((i) => i.order.checkoutId)).toEqual([CHECKOUT]);
  });

  it('matches the address case-insensitively, because a buyer types it by hand', async () => {
    /*
     * `shop_customers.email` is normalised to lower case on write and
     * `shop_orders.email` is NOT — it is the address exactly as it was typed
     * into checkout, because that is what the confirmation was sent to. So the
     * two sides genuinely differ in case in production, and an `=` comparison
     * here would adopt nothing for a buyer who capitalised their own name.
     */
    await guestOrder({ email: 'BUYER@example.TEST' });
    expect(await adoptGuestOrders(ctx.db, OWNER, 'buyer@example.test')).toBe(1);
    expect(await customerIdOf(CHECKOUT)).toBe(OWNER);
  });

  it('leaves another address alone, and is idempotent on a second run', async () => {
    await guestOrder();
    await guestOrder({ checkoutId: 'chk_someone_else', email: 'other@example.test' });

    expect(await adoptGuestOrders(ctx.db, OWNER, BUYER)).toBe(1);
    expect(await customerIdOf('chk_someone_else')).toBeNull();

    // Every later sign-in runs this again. It must find nothing left to do.
    expect(await adoptGuestOrders(ctx.db, OWNER, BUYER)).toBe(0);
    expect(await customerIdOf(CHECKOUT)).toBe(OWNER);
  });

  it('CANNOT take an order away from the customer who already owns it', async () => {
    /*
     * The predicate that stops this is `customer_id IS NULL`, and it is the
     * load-bearing half of the statement. Without it, anyone who could get an
     * assertion for an address could re-point every order ever placed against
     * that address at themselves — including orders that belong to a signed-in
     * customer with a different id.
     */
    await guestOrder({ customerId: 'cus_the_real_buyer' });
    expect(await adoptGuestOrders(ctx.db, OWNER, BUYER)).toBe(0);
    expect(await customerIdOf(CHECKOUT)).toBe('cus_the_real_buyer');
  });

  it('does not break the guest receipt link already sitting in a mailbox', async () => {
    /*
     * `getOrderForGuest` authenticates on `lower(email)`, and the token in that
     * email is signed and long-lived. Adoption must therefore NOT rewrite the
     * order's own `email` — a customer who signs up should not find that the
     * link they were sent last week has stopped working.
     */
    await guestOrder();
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    const orderNumber = read!.order.orderNumber;

    await adoptGuestOrders(ctx.db, OWNER, BUYER);

    const viaLink = await getOrderForGuest(ctx.db, orderNumber, BUYER);
    expect(viaLink?.order.checkoutId).toBe(CHECKOUT);
  });

  it('refuses an empty identity rather than matching every guest order', async () => {
    await guestOrder();
    await expect(adoptGuestOrders(ctx.db, '', BUYER)).rejects.toThrow();
    await expect(adoptGuestOrders(ctx.db, OWNER, '   ')).rejects.toThrow();
    expect(await customerIdOf(CHECKOUT)).toBeNull();
  });
});
