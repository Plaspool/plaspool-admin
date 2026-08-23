-- Let the order timeline record a refund that the provider accepted and
-- later FAILED to settle (task-d4).
--
-- `applyRefundEvent` (server/shop/payments/refunds.ts) now emits
-- `payment.refund_failed` on a failed settlement, mirroring the shape of
-- its existing `payment.refunded` emission. `server/shop/orders/repo/
-- consumer.ts` consumes it via `recordRefundFailure`
-- (server/shop/orders/repo/orders.ts), which writes a `refund_failed`
-- timeline entry WITHOUT transitioning `shop_orders.status` — the order
-- may already be `cancelled` (b9051ab refunds a paid order before
-- cancelling it), and un-cancelling would be a second, messier failure.
--
-- DROP-THEN-ADD, NOT `ALTER CONSTRAINT`: Postgres has no way to widen a
-- CHECK in place (see 0320_system_email_templates for the same move on a
-- sibling table). The new predicate is strictly WIDER than the one 0160
-- created, so no existing row can fail it and the ADD cannot be the
-- statement that breaks the deploy.
ALTER TABLE shop_order_events
  DROP CONSTRAINT shop_order_events_type_ck;--> statement-breakpoint
ALTER TABLE shop_order_events
  ADD CONSTRAINT shop_order_events_type_ck CHECK (
    type IN ('placed', 'payment_authorized', 'payment_failed', 'paid',
             'fulfillment_created', 'shipped', 'delivered',
             'fulfillment_cancelled', 'cancelled', 'refunded', 'refund_failed')
  );--> statement-breakpoint
