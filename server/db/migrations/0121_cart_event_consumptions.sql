-- 0121 — Cart's outbox consumption ledger (contract §6 rule 2).
--
-- WHY CART NEEDS ITS OWN TABLE WHEN ORDERS ALREADY HAS ONE.
-- `shop_order_event_consumptions` has exactly the right shape and exactly the
-- right primary key — `(consumer, event_id)` — and is the shared mechanism
-- amendment A-005 asked for. It is also Orders' table, and contract §2 R3 makes
-- table ownership exclusive: "Only that subsystem's repo modules read or write
-- it." So Cart cannot use it, and two tables now do one job.
--
-- The columns below are DELIBERATELY IDENTICAL TO ORDERS', plus `attempts`, so
-- that merging the two into one `commerce_event_consumptions` is a rename and a
-- copy rather than a redesign. Raised as amendment A-012.
--
-- WHY NOT `commerce_events.processed_at`. §6 gives that column one value per
-- ROW while rule 2 keys idempotency on `(consumer, eventId)`. With two
-- consumers — Orders builds the order, Cart commits the stock — whichever
-- finishes first would hide the row from the other. Orders reached the same
-- conclusion independently and its candidate set is an anti-join too.
--
-- ⚠️  DATED IN THE FUTURE, AND FORCED TO BE. Journal `when` values must strictly
--     increase, and the three other commerce migrations sit at 1786600000160–
--     1786600000300 (2026-08-13T05:46:40Z, ~32h ahead of the wall clock when
--     this was written). Appending above them is the only way to keep the
--     ordering, so this inherits their date. Amendment A-004 has the analysis
--     and A-ORD-004 the measured blast radius: a fresh database is unaffected, an
--     already-migrated one is hard-blocked LOUDLY by `assertJournalApplied`
--     rather than silently corrupted, and it clears itself at that instant.

CREATE TABLE shop_cart_event_consumptions (
	-- Named, not implied. One day something other than 'cart' will read this
	-- table, and a primary key that assumed a single consumer would have to be
	-- rebuilt to admit it.
	"consumer" text NOT NULL,
	"event_id" text NOT NULL,
	"handled_at" bigint NOT NULL,
	-- 'parked'    — could not be read yet; STILL A CANDIDATE, retried next drain
	-- 'applied'   — Cart acted on it
	-- 'ignored'   — not Cart's, or nothing to do; never retried
	-- 'abandoned' — parked too many times; needs a human, not another attempt
	"outcome" text NOT NULL,
	-- PER CONSUMER, not `commerce_events.attempts`. Two consumers incrementing
	-- one counter makes it mean nothing to either of them.
	"attempts" integer DEFAULT 0 NOT NULL,
	-- A FIELD PATH or a short reason. NEVER a value: a payload flowing through
	-- here carries a customer's address, and an error column built from a raw
	-- parser message is a customer record in a table nobody audited.
	"detail" text,
	CONSTRAINT "shop_cart_event_consumptions_pk" PRIMARY KEY ("consumer","event_id"),
	CONSTRAINT "shop_cart_event_consumptions_outcome_ck"
		CHECK ("outcome" IN ('parked','applied','ignored','abandoned')),
	CONSTRAINT "shop_cart_event_consumptions_attempts_ck" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
-- The drain's candidate set is "events with no row here, or a parked row that
-- has attempts left", so the lookup is by consumer and outcome.
CREATE INDEX "shop_cart_event_consumptions_retry_idx"
	ON shop_cart_event_consumptions ("consumer","outcome");
