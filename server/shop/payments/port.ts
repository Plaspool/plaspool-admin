import { getIntent } from './intents';
import type { Db } from '../../db/client';
import type { PaymentPort, PaymentSnapshot } from '../../../shared/commerce/ports';

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
