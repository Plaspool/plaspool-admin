-- 0122 — an index for "has this checkout been paid for?"
--
-- `sweepExpiredReservations` refuses to expire a hold whose cart has a
-- `payment.captured` in the outbox (see the comment on that predicate for the
-- measured bug it fixes). Without an index that is a sequential scan of
-- `commerce_events` per candidate row, on a statement that runs on a cart read.
--
-- PARTIAL AND EXPRESSION-BASED, so drizzle-kit could not model it even if
-- commerce were in its schema path — the same category as `posts.search` and the
-- lifecycle trigger, and the reason `drizzle.config.ts` documents hand-written
-- migrations at all.
--
-- ON A SHARED TABLE, WHICH IS WHY IT IS ONLY AN INDEX. `commerce_events` belongs
-- to no subsystem (contract §6). An index changes no row, no column and no
-- constraint, so it cannot break another consumer's reads or writes; adding a
-- COLUMN here would have needed an amendment first. Recorded in A-014 anyway.
CREATE INDEX IF NOT EXISTS "commerce_events_captured_checkout_idx"
	ON commerce_events ((payload ->> 'checkoutId'))
	WHERE "type" = 'payment.captured';
