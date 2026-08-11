import { frozenTotals } from './checkout/repo';
import type { Db } from '../../db/client';
import type { CheckoutPort, FrozenTotals } from '../../../shared/commerce/ports';

/**
 * `CheckoutPort`, implemented (contract §5). Consumed by Payments.
 *
 * ═══ WHAT IT DOES: ONE READ ═══
 * `totals()` reads `shop_carts.frozen_totals` and returns it. It does not
 * recompute, cannot recompute, and is not given the inputs that would let it —
 * `computeTotals` needs a `CatalogPort`, a shipping zone and a tax rate, and
 * none of them is in scope here. That is the enforcement, not the comment:
 * brief §5 says "a totals function that gets re-run at capture time is a system
 * that can charge a number the customer never saw", and the way to guarantee it
 * is not to have the ingredients.
 *
 * ═══ WHY IT IS A FILE OF ITS OWN ═══
 * Contract §5: implemented in `server/shop/<owner>/port.ts`, consumed by
 * INJECTION, never by direct import of the implementation. Payments takes a
 * `CheckoutPort` as a dependency and Cart hands it this object; nothing in
 * `server/shop/payments/` imports `server/shop/cart/`, which is R2.
 *
 * The `Db` type parameter is bound here rather than in `shared/commerce/ports.ts`
 * for the reason that file gives: naming the concrete handle there would make it
 * server-only, and `shared/` is compiled into the browser bundle too.
 */
export function checkoutPort(): CheckoutPort<Db> {
  return {
    /**
     * Throws `NotFoundError` (404 `gone`) for a checkout that does not exist, has
     * not been frozen, or whose stored totals no longer parse.
     *
     * All three are the same answer on purpose. None of them is something a
     * retry could fix, and spec §8's retry policy stops on 404 — whereas a 500
     * would be re-sent five times over ~30 seconds for a payment that can never
     * be started. The corrupt case in particular must not be a charge: every
     * amount goes back through `money()` on the way out, so a row damaged by a
     * hand-run UPDATE or a bad import is refused rather than billed.
     */
    totals: (db: Db, checkoutId: string): Promise<FrozenTotals> =>
      frozenTotals(db, checkoutId),
  };
}
