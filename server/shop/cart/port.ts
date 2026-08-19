import { completeCheckout, frozenTotals, setCheckoutContact } from './checkout/repo';
import { CartPreconditionError } from './errors';
import { NotFoundError } from '../../repo/errors';
import type { Db } from '../../db/client';
import type { CheckoutCompletion, CheckoutPort, FrozenTotals } from '../../../shared/commerce/ports';

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

    /**
     * THE ANSWER TO `completeCheckout`'s "WHO CALLS THIS" (admin#27).
     *
     * Everything this adds over `completeCheckout` is the mapping below, and the
     * mapping is the point: Cart owns `CartPreconditionError` and `NotFoundError`,
     * so Cart is where "already converted" is recognised as ordinary rather than
     * exceptional. Payments gets a value it cannot mishandle.
     *
     * `CartPreconditionError` HERE MEANS ONE OF EXACTLY TWO THINGS, both benign:
     * the cart is already `converted` (a redelivered `charge.success`, which
     * Paystack does, or a webhook retry), or it was never frozen. Neither is
     * something a retry fixes and neither should 500 a webhook — Paystack would
     * redeliver a 5xx every 3 minutes and then hourly for 72 hours.
     *
     * `completeCheckout` REMAINS ONE STATEMENT and this does not wrap it in a
     * transaction: the Neon HTTP driver rejects `db.transaction()` unconditionally
     * while PGlite accepts it, so a transaction here would pass every test in this
     * repo and 500 in production (spec §4.3a). The `already-completed` branch is
     * safe without one precisely because that statement's event INSERT selects
     * `FROM upd` — a transition that matches nothing writes no event, so a
     * duplicate capture cannot produce a second `checkout.completed`.
     */
    /**
     * `CheckoutPort.recordContact` — the payment step handing back the one field
     * no cart route ever collects. See the port's doc comment for why the email
     * is null on every cart without it, and what that costs.
     */
    recordContact: (db: Db, checkoutId: string, email: string): Promise<void> =>
      setCheckoutContact(db, { cartId: checkoutId, email }),

    async complete(db: Db, checkoutId: string): Promise<CheckoutCompletion> {
      try {
        await completeCheckout(db, { cartId: checkoutId });
        return 'completed';
      } catch (err: unknown) {
        if (err instanceof CartPreconditionError) return 'already-completed';
        if (err instanceof NotFoundError) return 'unavailable';
        // `CartStaleWriteError` and anything else: genuinely transient or
        // genuinely unknown. Let it out; the caller swallows it and the next
        // drain retries.
        throw err;
      }
    },
  };
}
