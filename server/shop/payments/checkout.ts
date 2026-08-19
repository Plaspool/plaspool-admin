import { money, zero } from '../../../shared/commerce/money';
import type { CheckoutCompletion, CheckoutPort, FrozenTotals } from '../../../shared/commerce/ports';
import type { Db } from '../../db/client';

/**
 * The Cart-owned port this subsystem consumes. NOW THE REAL ONE.
 *
 * This file used to declare `FrozenTotalsSubset` and `CheckoutPortSubset` — the
 * three fields Payments actually reads — because Cart had not landed and
 * contract §5 names `FrozenTotals` without ever defining it (AMENDMENTS
 * A-PAY-002). Cart has since exported both, and the drift guard in
 * `checkout.test.ts` is what said so: it reads `shared/commerce/ports.ts` and
 * fails the moment a real `CheckoutPort` appears there. The shim is gone.
 *
 * Worth recording, because it is the point of contract §11's "code against a
 * fake and swap in the real one": THE REAL PORT DIFFERS FROM THE GUESS IN TWO
 * WAYS, and both would have been silent bugs had the swap been skipped.
 *
 * 1. **The total is `grandTotal: Money`, not `total: number`.** The shim's
 *    single number would have compiled against `grandTotal.amount` only by
 *    accident. `Money` carries its own currency, and taking the amount without
 *    it is exactly the "no `number` amounts without an accompanying currency"
 *    that contract §10 forbids.
 * 2. **`totals()` THROWS `NotFoundError` rather than returning `null`.** The
 *    shim returned `null` and `createIntent` turned that into a 404 itself.
 *    Against the real port that branch is unreachable and the 404 comes from
 *    Cart — same status, same permanent stop under §8's retry policy, but the
 *    dead `if` had to go rather than sit there implying a case that cannot
 *    happen.
 */
export type PaymentsCheckoutPort = CheckoutPort<Db>;

/**
 * A `CheckoutPort` backed by a map. For tests, and for nothing else.
 *
 * Deliberately NOT under `provider/`: it fakes a sibling SUBSYSTEM, not the
 * payment provider, and confusing the two is how a test ends up proving that
 * two fakes agree with each other.
 *
 * IT BUILDS A COMPLETE `FrozenTotals` from a total and a currency. A test that
 * had to spell out `lines`, `shipping`, `tax`, `adjustments` and five Money
 * sums to assert something about idempotency would be a test nobody writes —
 * and every field Payments actually reads is real, so nothing is being faked
 * away that matters here. The fake is deliberately consistent (`subtotal ==
 * grandTotal`, zero tax and shipping) rather than arbitrary, so a Payments bug
 * that read the wrong field would surface as a wrong number rather than as a
 * plausible one.
 */
export function fakeCheckoutPort(
  entries: Record<string, { total: number; currency: string; checkoutId?: string }>,
): PaymentsCheckoutPort {
  /*
   * WHICH CHECKOUTS THIS FAKE HAS ALREADY COMPLETED, so `complete()` answers
   * `already-completed` on a second call exactly as the real port does against a
   * cart that has reached `converted`. A fake that answered `completed` twice
   * would let a duplicate-capture bug pass its test and fail in production —
   * which is the failure this whole change exists to close.
   */
  const completed = new Set<string>();
  return {
    totals(_db: Db, checkoutId: string): Promise<FrozenTotals> {
      void _db;
      const entry = entries[checkoutId];
      if (!entry) {
        /*
         * The real port throws `NotFoundError`, and so does this. Returning
         * `null` here would let a Payments bug that mishandles the absent case
         * pass its tests and fail against Cart.
         */
        return Promise.reject(new CheckoutNotFound(checkoutId));
      }
      const total = money(entry.total, entry.currency);
      const nothing = zero(entry.currency);
      return Promise.resolve({
        currency: entry.currency,
        lines: [],
        shipping: null,
        tax: { zone: 'test', label: 'none', rateBps: 0 },
        adjustments: [],
        subtotal: total,
        adjustmentTotal: nothing,
        shippingTotal: nothing,
        taxTotal: nothing,
        grandTotal: total,
        rounding: 'half-up',
      });
    },

    /** The fake stores nothing: no Payments behaviour reads it back. */
    recordContact(_db: Db, _checkoutId: string, _email: string): Promise<void> {
      void _db;
      void _checkoutId;
      void _email;
      return Promise.resolve();
    },

    complete(_db: Db, checkoutId: string): Promise<CheckoutCompletion> {
      void _db;
      if (!entries[checkoutId]) return Promise.resolve('unavailable');
      if (completed.has(checkoutId)) return Promise.resolve('already-completed');
      completed.add(checkoutId);
      return Promise.resolve('completed');
    },
  };
}

/**
 * What the fake throws for an unknown checkout.
 *
 * NOT `server/repo/errors.ts`'s `NotFoundError`, which takes a post id and
 * builds a post-shaped message. Structurally it is the same 404; naming it
 * separately keeps a test fixture from quietly becoming the thing that decides
 * an HTTP status.
 */
export class CheckoutNotFound extends Error {
  constructor(readonly checkoutId: string) {
    super(`No frozen totals for checkout ${checkoutId}`);
    this.name = 'NotFoundError';
  }
}
