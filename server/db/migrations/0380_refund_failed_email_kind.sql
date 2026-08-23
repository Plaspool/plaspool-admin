-- Let the order email outbox hold the message that tells a CUSTOMER a refund
-- did not go through — the follow-up task-d4 named in §5 of its own report and
-- deliberately left out of `0360_refund_failed_timeline`.
--
-- `0360` widened `shop_order_events_type_ck` so an OPERATOR could see the
-- failure on the order's own history. That is the whole of what task-d4 did,
-- and it left the person who is actually owed the money hearing nothing: the
-- customer has already received the "Order cancelled" notice (`b9051ab` refunds
-- a paid order before cancelling it), which carries no refund figure but does
-- imply money is coming back, and nothing corrected that implication when the
-- refund later failed to settle.
--
-- `recordRefundFailure` (server/shop/orders/repo/orders.ts) now writes a
-- `refund_failed` intent into `shop_order_email_intents` in the SAME statement
-- as the timeline entry and the consumption claim, gated `FROM claim` like
-- everything else in that function — so a redelivered webhook cannot send the
-- message twice. `server/mail/defaults.ts`'s `order.refund_failed` is the
-- wording; this migration is only what lets the row exist.
--
-- A SECOND MIGRATION AND NOT AN AMENDMENT TO `0360`, because `0360` is already
-- on this branch and a migration that has been journalled is history: editing
-- one in place is invisible to `drizzle_migrations` on any database that has
-- already run it, so the widened CHECK would silently never reach production.
--
-- DROP-THEN-ADD, NOT `ALTER CONSTRAINT`: Postgres has no way to widen a CHECK
-- in place. `0320_system_email_templates` made exactly this move on exactly
-- this constraint when it added `placed` and `delivered`; this is the third
-- value list that column has carried. The new predicate is strictly WIDER than
-- `0320`'s, so no existing row can fail it and the ADD cannot be the statement
-- that breaks the deploy.
ALTER TABLE shop_order_email_intents
  DROP CONSTRAINT shop_order_email_intents_kind_ck;--> statement-breakpoint
ALTER TABLE shop_order_email_intents
  ADD CONSTRAINT shop_order_email_intents_kind_ck CHECK (
    kind IN ('placed', 'confirmation', 'shipment', 'delivered',
             'cancellation', 'refund', 'refund_failed')
  );--> statement-breakpoint
