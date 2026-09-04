import { BadRequestError, NotFoundError } from '../../repo/errors';
import { cancelIntent, getIntent, intentsForCheckout } from './intents';
import type { Db } from '../../db/client';
import type { PaymentPort, PaymentSnapshot, PaymentStatus } from '../../../shared/commerce/ports';

/**
 * `PaymentPort`, implemented (contract §5).
 *
 * READ-ONLY, AND THAT IS THE WHOLE INTERFACE. Orders consumes this to render
 * "paid" on an order page and for nothing else. Note what contract §5
 * deliberately does not declare and this deliberately does not add: there is no
 * method here by which Orders could change a payment, and no port at all by
 * which Payments could change an order. A capture does not call `createOrder`
 * — it appends `payment.captured` to `commerce_events` and Orders reacts (§2
 * R4, §6). The event row is the evidence that makes that seam debuggable; a
 * function call would leave nothing behind.
 *
 * The implementation is a plain object rather than a class so a consumer can be
 * tested against `{ status: () => … }` with no construction ceremony.
 */
export const paymentPort: PaymentPort<Db> = {
  async status(db: Db, intentId: string): Promise<PaymentSnapshot | null> {
    const intent = await getIntent(db, intentId);
    if (!intent) return null;
    /*
     * PROJECTED FIELD BY FIELD, never spread. `PaymentIntentRow` carries
     * `idempotencyKey`, `authorizationUrl` and `lastError`; none of the three is
     * Orders' business, and a `{ ...intent }` here would hand every one of them
     * across a subsystem boundary the first time the row gained a column.
     */
    return {
      intentId: intent.id,
      checkoutId: intent.checkoutId,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      refundedTotal: intent.refundedTotal,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    };
  },
};

/**
 * The second outward surface: what CART needs in order to unfreeze a checkout
 * that was frozen and never paid.
 *
 * ═══ STRUCTURALLY TYPED ON PURPOSE — THERE IS NO `implements` HERE ═══
 *
 * The interface this satisfies is `CheckoutPaymentsPort`, declared in
 * `server/shop/cart/payments-port.ts` because Cart is the consumer and a port
 * belongs to the side that needs it (the same way Cart declares `CatalogPort`).
 * Naming that type here would make Payments import Cart, which is the coupling
 * the ports exist to prevent and which spec D9 forbids in both directions. So
 * this is a plain object with the right shape, and `server/shop/app.ts` — the
 * one file allowed to know both halves — is where the two are typed against
 * each other. A mismatch is a compile error AT THAT LINE, which is exactly
 * where somebody wiring the seam is looking.
 *
 * READ-ONLY PLUS ONE NARROW WRITE. `cancel` cannot capture, refund, or move an
 * intent forward; the only direction it goes is the one a shopper backing out
 * of checkout has already chosen.
 */
export const checkoutPaymentsPort = {
  async intentsFor(
    db: Db,
    checkoutId: string,
  ): Promise<Array<{ id: string; status: PaymentStatus }>> {
    return intentsForCheckout(db, checkoutId);
  },

  /**
   * Cancel locally, and SWALLOW the two refusals that are not failures.
   *
   * `cancelIntent` answers 400 for an intent already past `cancelled` on the
   * rank ladder and 404 for one that is gone. Both are races against a thaw
   * that has already checked, and neither is a reason to fail the shopper's
   * recovery: the thaw refuses outright when money moved, so anything arriving
   * here is either cancellable or has been settled by somebody else. Letting a
   * lost race become a 500 would turn "your basket is back" into an error page
   * for a cart that is, by then, in exactly the state the caller wanted.
   *
   * Anything else propagates — a database fault is not a race.
   */
  async cancel(db: Db, intentId: string): Promise<void> {
    try {
      await cancelIntent(db, intentId);
    } catch (err: unknown) {
      if (err instanceof BadRequestError || err instanceof NotFoundError) return;
      throw err;
    }
  },
};
