import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { NotFoundError } from '../../../repo/errors';
import { addLine, getCart, listLines, setCartStatus, setLineQty } from './repo';
import type { Cart, CartLine } from './repo';
import type { CatalogPort } from '../catalog-port';

/**
 * Guest → account (brief §2).
 *
 * ═══ THE MERGE RULE, WRITTEN DOWN ═══
 *
 * Exported as data below so the rule exists somewhere a bug report can be
 * checked against, and so the customer-facing copy quotes it rather than
 * paraphrasing it:
 *
 * 1. **Union the lines.** Both baskets survive; nothing is thrown away.
 * 2. **Sum quantities for the same variant.** Two of a thing in each basket is
 *    four of it, not two — the shopper put both there on purpose.
 * 3. **Cap at available stock, AND SAY SO.** A quantity that cannot be honoured
 *    is reduced to what is available and REPORTED, with the number. Silently
 *    clamping is how somebody finds out at the confirmation email that they are
 *    getting three of the four they thought they had bought.
 * 4. **The customer's cart survives.** It is the one with their history and,
 *    potentially, their addresses. The guest cart is ABANDONED rather than
 *    deleted: its reservations and its rows are evidence, and a hard delete
 *    takes them with it.
 *
 * ═══ WHAT IT REFUSES ═══
 *
 * A currency disagreement is not merged. Contract §10 has no conversion step and
 * §13 has no multi-currency storefront, so there is no right answer — both carts
 * are left intact and the one the shopper is looking at stays in use.
 *
 * A customer cart that is not `open` is left alone entirely. Merging into a cart
 * whose totals have been frozen would change what the customer is about to be
 * charged for AFTER they have seen the number.
 */

export const MERGE_RULE = {
  /** Both baskets survive. */
  union: true,
  /** Two in each basket is four. */
  sameVariant: 'sum',
  /** Reduce to what is available and report it. Never silently. */
  overAvailable: 'cap-and-report',
  /** The customer's own cart is the one that lives on. */
  survivor: 'customer-cart',
} as const;

/** One thing the shopper needs to be told about their merged basket. */
export interface MergeChange {
  variantId: string;
  kind: 'capped' | 'unavailable' | 'currency_mismatch';
  /** What the two carts asked for between them. */
  requested: number;
  /** What the basket ended up with. */
  applied: number;
  /** What stock said at the moment of merging. */
  available: number;
}

export interface AdoptOutcome {
  /** The cart the shopper should be using from here on. */
  cartId: string;
  /** True when two carts were combined; false when one was simply adopted. */
  merged: boolean;
  /** Everything the shopper needs to be told. Empty is the ordinary case. */
  changes: MergeChange[];
}

/**
 * Attach a customer to the cart they are holding, merging with any open cart
 * they already had.
 *
 * Called after a magic-link redemption and after any other event that turns an
 * anonymous browser into a known customer. Deliberately NOT called from the
 * redeem route itself: that route would then have to know about carts, which is
 * the coupling brief §2 warns about. The cart routes call it on the next cart
 * read, where a cart is already in hand.
 */
export async function adoptCartForCustomer(
  db: Db,
  catalog: CatalogPort,
  a: { guestCartId: string; customerId: string },
): Promise<AdoptOutcome> {
  const guest = await getCart(db, a.guestCartId);
  if (!guest) throw new NotFoundError(a.guestCartId);

  const existing = await openCartFor(db, a.customerId);

  // Nothing to merge with: attach and be done. One UPDATE, and the reservations
  // and addresses already on this cart come with it.
  if (!existing || existing.id === guest.id) {
    if (guest.customerId !== a.customerId) await attach(db, guest.id, a.customerId);
    return { cartId: guest.id, merged: false, changes: [] };
  }

  if (existing.currency !== guest.currency) {
    /*
     * No conversion step exists (contract §10), so there is no correct amount to
     * turn one basket into. Both are left intact and the shopper keeps the one
     * they are looking at — which is the guest cart, since that is the browser
     * they are in.
     */
    if (guest.customerId !== a.customerId) await attach(db, guest.id, a.customerId);
    return {
      cartId: guest.id,
      merged: false,
      changes: [
        { variantId: '', kind: 'currency_mismatch', requested: 0, applied: 0, available: 0 },
      ],
    };
  }

  const changes: MergeChange[] = [];
  const mineByVariant = new Map(
    (await listLines(db, existing.id)).map((line) => [line.variantId, line] as const),
  );

  for (const line of await listLines(db, guest.id)) {
    const mine = mineByVariant.get(line.variantId);
    const requested = (mine?.qty ?? 0) + line.qty;

    /*
     * `quote` and not `reserve`. Merging is not checkout: nothing is held here,
     * because holding at merge time would let one person with two browser tabs
     * hold stock for a week — the exact failure brief §4 gives for reserving at
     * add-to-cart. `available` is a number to SHOW, and `startCheckout` re-checks
     * it in a conditional statement when it matters.
     */
    const quote = await catalog.quote(db, line.variantId);
    if (!quote) {
      changes.push({
        variantId: line.variantId,
        kind: 'unavailable',
        requested,
        applied: mine?.qty ?? 0,
        available: 0,
      });
      continue;
    }

    const ceiling = quote.backorderable ? requested : Math.max(0, quote.available);
    const applied = Math.min(requested, ceiling);
    if (applied < requested) {
      changes.push({
        variantId: line.variantId,
        kind: 'capped',
        requested,
        applied,
        available: quote.available,
      });
    }
    if (applied === 0) continue;
    await writeMergedLine(db, existing.id, mine, line, applied);
  }

  // ABANDONED, not deleted. The rows are evidence — including any reservations,
  // which the sweeper will hand back on their own schedule.
  const abandoned = await getCart(db, guest.id);
  if (abandoned && abandoned.status === 'open') {
    await setCartStatus(db, {
      cartId: guest.id,
      to: 'abandoned',
      baseRevision: abandoned.revision,
    });
  }

  return { cartId: existing.id, merged: true, changes };
}

async function writeMergedLine(
  db: Db,
  cartId: string,
  mine: CartLine | undefined,
  incoming: CartLine,
  applied: number,
): Promise<void> {
  if (!mine) {
    await addLine(db, { cartId, variantId: incoming.variantId, qty: applied });
    return;
  }
  // `setLineQty` REPLACES, which is what the summed-then-capped figure needs.
  // `addLine` would sum a second time and undo the cap.
  if (applied !== mine.qty) {
    await setLineQty(db, { cartId, lineId: mine.id, qty: applied });
  }
}

/**
 * The customer's open cart, if they have one.
 *
 * `status = 'open'` is in the predicate, not checked afterwards: a `converting`
 * cart is mid-purchase and merging into it would change what somebody is about
 * to be charged for. Most recent first, because a customer with two open carts
 * is looking at the newer one.
 */
async function openCartFor(db: Db, customerId: string): Promise<Cart | null> {
  const res = await db.execute(sql`
    SELECT id FROM shop_carts
     WHERE customer_id = ${customerId} AND status = 'open'
     ORDER BY updated_at DESC, id DESC LIMIT 1`);
  return res.rows[0] ? getCart(db, String(res.rows[0].id)) : null;
}

/**
 * Attach an owner to an anonymous cart.
 *
 * `customer_id IS NULL` in the predicate: a cart that already belongs to
 * somebody must not be reassigned by a second person's sign-in, which would hand
 * one shopper another's basket — and their address with it, once checkout fills
 * one in.
 *
 * NOT through the CAS write path, on purpose: this is not a change the shopper
 * made, so it must not bump `revision` and invalidate an optimistic token their
 * other tab is holding.
 */
async function attach(db: Db, cartId: string, customerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE shop_carts SET customer_id = ${customerId}
     WHERE id = ${cartId} AND customer_id IS NULL`);
}
