import type { Db } from '../../db/client';
import type { PaymentStatus } from '../../../shared/commerce/ports';

/**
 * What Cart must learn from Payments before it may UNFREEZE a checkout.
 *
 * ═══ WHY THIS PORT EXISTS AT ALL ═══
 *
 * Freezing is a one-way door by design (`checkout/repo.ts`), and everything a
 * cart can still be edited through is guarded on `status = 'open'`. The door
 * had no handle on the inside: `converting → open` is in the transition
 * allow-list and `setCartStatus` was never called with it from anywhere in the
 * application, so a shopper who reached the payment page and did not pay was
 * locked out of their own checkout permanently — every address edit answered
 * `409 precondition_failed / update_cart` for ever.
 *
 * Opening that door needs ONE fact Cart cannot see: whether money moved. The
 * cart's own status does not carry it. A capture normally drives
 * `converting → converted` inline, so `converting` USUALLY means unpaid — but
 * `completeCheckoutForIntent` documents three ways a capture is recorded while
 * the completion is not (an unwired port, an exception, a lost race), and each
 * of them leaves a PAID cart sitting at `converting`. Thawing one of those and
 * re-freezing it at a different total would build the order from the new
 * numbers while the old amount is what was charged.
 *
 * ═══ DECLARED BY THE CONSUMER, EXACTLY AS `CatalogPort` IS ═══
 *
 * Contract §5: a port is "consumed by injection, never by direct import of the
 * implementation". Cart declares the shape it needs and never imports
 * `server/shop/payments/`; `server/shop/app.ts` is the one file that knows both
 * halves. `shop_payment_intents` is Payments' table, and Cart reading it
 * directly would be the coupling the ports exist to prevent — the same reason
 * `shop_carts` carries no foreign key from Payments.
 *
 * ═══ READ-ONLY PLUS ONE WRITE, AND THE WRITE IS NARROW ═══
 *
 * `cancel` is here because a thaw that left a live intent behind would leave a
 * payment page the shopper can still pay against a total that has since moved.
 * It cancels LOCALLY and cannot do more: Paystack has no endpoint that cancels
 * an uncompleted transaction (`cancelIntent`'s own comment), so a determined
 * shopper can still pay an abandoned page — the rank ladder records that as an
 * anomaly rather than losing the money.
 */
export interface CheckoutPaymentsPort {
  /**
   * Every intent for this checkout, projected to the two facts a thaw needs.
   *
   * The full `PaymentIntentRow` carries `idempotencyKey`, `authorizationUrl`
   * and `lastError`; none of the three is Cart's business, and handing the row
   * across would export all of them the first time it gained a column — the
   * same projection discipline `paymentPort.status` follows.
   */
  intentsFor(db: Db, checkoutId: string): Promise<CheckoutIntent[]>;

  /**
   * Cancel one intent locally. Must be a NO-OP, not a throw, for an intent that
   * has already outranked `cancelled` — a thaw is refused before it gets here
   * if money moved, and a race that lands between the two must not turn a
   * recovery into a 500.
   */
  cancel(db: Db, intentId: string): Promise<void>;
}

/** An intent, as much of one as a thaw decision needs. */
export interface CheckoutIntent {
  id: string;
  status: PaymentStatus;
}
