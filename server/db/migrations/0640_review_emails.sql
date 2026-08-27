-- Let the order email outbox hold the two messages a REVIEW is downstream of:
-- the invitation sent once an order is delivered, and the note that tells a
-- reviewer their review is live.
--
-- WHY THESE RIDE THE ORDER OUTBOX AT ALL. `shop_order_email_intents.order_id`
-- is NOT NULL, which reads at first like a reason these do not belong here.
-- They do:
--
--   * `review_invite` is straightforwardly an order message — it is sent when
--     an order is delivered and it names what was in it.
--   * `review_approved` is about a review, but every review that can trigger
--     one carries a proving order (the purchase gate records `order_id` on the
--     row), and that order is exactly what the message is downstream of.
--
-- The alternative was a second outbox table with its own sweeper, its own retry
-- ceiling and its own failure modes, in order to send one email. Reusing the
-- one that already drains, already dedupes and already stops at
-- `EMAIL_ATTEMPT_LIMIT` is the cheaper and the safer half of that trade.
--
-- THE CONSEQUENCE IS NAMED RATHER THAN HIDDEN: a review with no `order_id` —
-- every row written before the gate shipped — sends nothing when it is
-- approved. Those authors never expected a message, so silence is right, but it
-- is a real hole and a later reader should not have to rediscover it.
--
-- DROP-THEN-ADD, NOT `ALTER CONSTRAINT`: Postgres cannot widen a CHECK in
-- place. `0320_system_email_templates` and `0380_refund_failed_email_kind` both
-- made this exact move on this exact constraint; this is the fourth value list
-- the column has carried. The new predicate is strictly WIDER than `0380`'s, so
-- no existing row can fail it and the ADD cannot be the statement that breaks
-- the deploy.
--
-- NOTHING IS BACKFILLED, DELIBERATELY. Sending an invitation for every order
-- ever delivered would mean a burst of mail about parcels that arrived months
-- ago, to people who have long since stopped thinking about them. The feature
-- starts with the next delivery.
ALTER TABLE shop_order_email_intents
  DROP CONSTRAINT shop_order_email_intents_kind_ck;--> statement-breakpoint
ALTER TABLE shop_order_email_intents
  ADD CONSTRAINT shop_order_email_intents_kind_ck CHECK (
    kind IN ('placed', 'confirmation', 'shipment', 'delivered',
             'cancellation', 'refund', 'refund_failed',
             'review_invite', 'review_approved')
  );--> statement-breakpoint
