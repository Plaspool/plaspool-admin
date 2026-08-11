-- Payments (contract §4, `03-payments.md` §3). Migration range 0140–0159.
--
-- HAND-WRITTEN, NOT `drizzle-kit generate`d, and contract §8 asks that this be
-- said in the header when it happens. Two reasons, both structural rather than
-- stylistic:
--
--   1. drizzle-kit numbers sequentially from the journal's high-water mark, so
--      it would emit `0005`, not `0140`. The ranges in contract §8 exist so four
--      agents writing migrations at the same time cannot collide in the journal,
--      and a generator that does not know about them cannot honour them.
--   2. It diffs the WHOLE schema against `meta/*_snapshot.json`, so running it
--      while three other agents have uncommitted tables in
--      `commerce-schema.ts` would sweep their in-flight DDL into this file.
--
-- `shop_payment_status_rank` at the bottom is hand-written for the reason
-- `drizzle.config.ts` already documents about the search column: drizzle-kit
-- has no way to express a function, and the predicate that makes out-of-order
-- webhooks safe is written in terms of it.

-- The outbox (contract §6). SHARED, AND OWNED BY NOBODY — see AMENDMENTS A-002.
--
-- MEASURED, NOT PREDICTED: all four subsystems independently wrote
-- `CREATE TABLE IF NOT EXISTS commerce_events` into their own migration, because
-- the contract names the table, requires all four to write to it, and assigns it
-- to no one. `IF NOT EXISTS` keeps that from being four failed migrations, but it
-- has a consequence nobody chose: WHICHEVER MIGRATION RUNS FIRST DECIDES THE
-- TABLE'S SHAPE, and the four definitions are not identical. On the journal as it
-- stands, `0120_cart_checkout` runs first and its version carries no CHECK on
-- `type` — so `schema.test.ts` caught `payment.captureed` being accepted into the
-- outbox, which is contract §4's "every enum-ish column carries a check()" being
-- lost to migration ordering rather than to a decision.
--
-- So the table is created if absent, and any constraint is added SEPARATELY and
-- IDEMPOTENTLY below. That makes the resulting shape the same whichever of the
-- four lands first, which `IF NOT EXISTS` on its own cannot do.
--
-- `type` IS DELIBERATELY UNCONSTRAINED. This file previously added
-- `CHECK (type IN (…the eleven §6 types…))`, on the strength of contract §4's
-- "every enum-ish column carries a check()". Orders raised A-ORD-001 against it
-- and was right, so it was removed:
--
--   §6 rule 1 puts the outbox INSERT in the same transaction as the state change
--   that caused it. So a CHECK on `type` does not reject an event — it rolls back
--   the event's CAUSE. A producer emitting a type this constraint has not heard
--   of loses the capture, not the notification. And §6 rule 4 exists precisely so
--   a producer can ship ahead of its consumers, which the constraint converts
--   from "the consumer logs and ignores" into "the producer fails".
--
-- The asymmetry is what settles it in a payments subsystem: a typo'd event type
-- costs a missed downstream reaction; a rolled-back capture costs a customer who
-- has been charged and has no record of it. The typo-catching moves to where it
-- cannot roll anything back — `commerceEvent()` in `shared/commerce/events.ts`
-- pairs each `CommerceEventType` with its payload at compile time, and every
-- emit in this subsystem goes through a `CommerceEventType`-typed constant.
CREATE TABLE IF NOT EXISTS "commerce_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "subject_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "occurred_at" bigint NOT NULL,
  "processed_at" bigint,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text
);--> statement-breakpoint
-- Dropped as well as not created: a database migrated while the CHECK was in
-- this file still carries it, and A-ORD-001's failure mode is not something to
-- leave standing on an existing deployment.
DO $$ BEGIN
  ALTER TABLE commerce_events DROP CONSTRAINT commerce_events_type_ck;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;--> statement-breakpoint
-- `attempts >= 0` STAYS. It is not a type-evolution question: nothing a future
-- subsystem might legitimately want to write makes a negative attempt count
-- correct, so this one cannot roll back a state change that should have
-- succeeded.
DO $$ BEGIN
  ALTER TABLE commerce_events ADD CONSTRAINT commerce_events_attempts_ck CHECK (attempts >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- NO INDEXES ON `commerce_events` HERE, deliberately. `0120_cart_checkout`
-- creates `commerce_events_pending_idx` and `commerce_events_subject_idx`, and
-- `0160_orders_fulfillment` adds `commerce_events_occurred_idx`. Re-issuing those
-- NAMES with different definitions under `IF NOT EXISTS` would silently no-op and
-- leave this file describing an index shape the database does not have — the same
-- ordering trap as the table itself. Payments' own drain reads
-- `shop_payment_events`, which is indexed below and is entirely ours.

CREATE TABLE "shop_payment_intents" (
  "id" text PRIMARY KEY NOT NULL,
  "checkout_id" text NOT NULL,
  "provider_intent_id" text,
  -- MINOR UNITS, FROZEN. Never recomputed (`03-payments.md` §1).
  "amount" integer NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "authorization_url" text,
  "refunded_total" integer DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "last_error" text,
  "revision" integer NOT NULL,
  CONSTRAINT "shop_payment_intents_provider_intent_id_unique" UNIQUE("provider_intent_id"),
  CONSTRAINT "shop_payment_intents_idempotency_key_unique" UNIQUE("idempotency_key"),
  CONSTRAINT "shop_payment_intents_status_ck" CHECK ("status" IN (
    'requires_payment', 'authorized', 'captured', 'failed',
    'cancelled', 'refunded', 'partially_refunded'
  )),
  CONSTRAINT "shop_payment_intents_revision_ck" CHECK ("revision" > 0),
  CONSTRAINT "shop_payment_intents_amount_ck" CHECK ("amount" > 0),
  -- THE REFUND INVARIANT, held by the database rather than by the statement
  -- that usually maintains it. `refunds.ts` guards `refunded_total + $new <=
  -- amount` inside an UPDATE's WHERE, which is what makes concurrent partials
  -- safe; this makes the same thing true of an import, a backfill or SQL run by
  -- hand at 2am, none of which go through that statement.
  CONSTRAINT "shop_payment_intents_refunded_total_ck"
    CHECK ("refunded_total" >= 0 AND "refunded_total" <= "amount")
);--> statement-breakpoint
CREATE INDEX "shop_payment_intents_checkout_idx" ON "shop_payment_intents" ("checkout_id");--> statement-breakpoint
CREATE INDEX "shop_payment_intents_status_idx" ON "shop_payment_intents" ("status");--> statement-breakpoint

-- APPEND-ONLY. Nothing deletes from this table; it is the only artefact that can
-- answer "what did the provider actually tell us, and when" during a dispute.
CREATE TABLE "shop_payment_events" (
  "id" text PRIMARY KEY NOT NULL,
  -- THE DEDUPE KEY. A UNIQUE constraint and not a prior read: Paystack retries
  -- a non-200 every 3 minutes ×4 and then hourly for 72 hours, so the same
  -- event arrives repeatedly and sometimes concurrently, and a JS "have I seen
  -- this" check runs against a snapshot taken before the other two landed.
  "provider_event_id" text NOT NULL,
  -- No FK, deliberately: an event must be storable the instant its signature
  -- verifies, whether or not we can resolve it to an intent yet.
  "intent_id" text,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "received_at" bigint NOT NULL,
  "processed_at" bigint,
  "last_error" text,
  "anomaly" text,
  CONSTRAINT "shop_payment_events_provider_event_id_unique" UNIQUE("provider_event_id")
);--> statement-breakpoint
CREATE INDEX "shop_payment_events_intent_idx" ON "shop_payment_events" ("intent_id");--> statement-breakpoint
CREATE INDEX "shop_payment_events_pending_idx" ON "shop_payment_events" ("processed_at","received_at");--> statement-breakpoint

CREATE TABLE "shop_refunds" (
  "id" text PRIMARY KEY NOT NULL,
  "intent_id" text NOT NULL,
  "amount" integer NOT NULL,
  "currency" text NOT NULL,
  "reason" text,
  "provider_refund_id" text,
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "created_by" uuid NOT NULL,
  CONSTRAINT "shop_refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
  CONSTRAINT "shop_refunds_status_ck" CHECK ("status" IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT "shop_refunds_amount_ck" CHECK ("amount" > 0)
);--> statement-breakpoint
ALTER TABLE "shop_refunds" ADD CONSTRAINT "shop_refunds_intent_id_fk"
  FOREIGN KEY ("intent_id") REFERENCES "shop_payment_intents"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "shop_refunds" ADD CONSTRAINT "shop_refunds_created_by_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action;--> statement-breakpoint
CREATE INDEX "shop_refunds_intent_idx" ON "shop_refunds" ("intent_id");--> statement-breakpoint
-- PARTIAL UNIQUE, the same shape as `posts.slug` and for the same reason: a
-- plain UNIQUE cannot hold many rows that share "not assigned yet", but
-- Postgres permits many NULLs, and every refund is NULL here until the provider
-- has answered.
CREATE UNIQUE INDEX "shop_refunds_provider_refund_uq" ON "shop_refunds" ("provider_refund_id")
  WHERE "provider_refund_id" IS NOT NULL;--> statement-breakpoint

-- Hand-written: drizzle-kit cannot express a function.
--
-- THE ORDERING THAT MAKES OUT-OF-ORDER WEBHOOKS SAFE (`03-payments.md` §4).
-- `payment.captured` can land before `payment.authorized`; a provider retry can
-- redeliver an old event after a newer one has already been applied. A state
-- machine that requires the previous state to have been OBSERVED throws on both
-- of those, and throwing is the wrong answer twice over — it returns a non-200,
-- which makes the provider redeliver for 72 hours, and it denies a state the
-- money is already in.
--
-- So every intent transition is guarded by `rank(new) > rank(current)` and the
-- intent's status is the HIGH-WATER MARK of the events seen. Applying an event
-- below the water line is not an error: it is recorded in
-- `shop_payment_events.anomaly` and the intent is left alone.
--
-- IMMUTABLE, and it has to be: a STABLE function cannot be used in a CHECK and
-- is a planner barrier in the WHERE clauses this appears in. GAUNTLET II's plan
-- review found `array_to_string` rejected in a generated column for exactly
-- this reason, settled by executing the DDL rather than reasoning about it —
-- `migrations.test.ts` executes this one the same way.
--
-- `failed` and `cancelled` share rank 1 and sit BELOW `authorized`: both mean
-- we stopped expecting money, neither means money cannot still arrive. Paystack
-- lets a customer retry a failed attempt on the same reference, so
-- `failed → captured` is real, and a cancelled checkout the customer pays
-- anyway must end up `captured` with the anomaly recorded rather than refused.
--
-- An unknown status returns -1 rather than NULL. NULL would make every
-- comparison NULL, i.e. a predicate that silently never matches — a guard that
-- has quietly stopped guarding, which is the exact failure Part 2b's mutation
-- campaign found across six transitions. -1 loses every comparison loudly.
CREATE OR REPLACE FUNCTION shop_payment_status_rank(status text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE status
    WHEN 'requires_payment'   THEN 0
    WHEN 'cancelled'          THEN 1
    WHEN 'failed'             THEN 1
    WHEN 'authorized'         THEN 2
    WHEN 'captured'           THEN 3
    WHEN 'partially_refunded' THEN 4
    WHEN 'refunded'           THEN 5
    ELSE -1
  END;
$$;
