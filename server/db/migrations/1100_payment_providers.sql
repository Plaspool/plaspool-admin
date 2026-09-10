-- Two gateways, and an intent that remembers which one took it.
--
-- WHY A COLUMN AND NOT A DERIVED VALUE. provider_intent_id is nullable: it is
-- NULL for exactly the case that matters, where the row was claimed and then
-- the provider call timed out. Deriving the gateway from a reference format
-- would therefore answer "unknown" precisely when a customer is stuck and
-- somebody needs to finish the job. A column is answerable always.
--
-- THE DEFAULT IS ADDED HERE AND DROPPED IN A LATER TASK, once every INSERT
-- names the column. It exists to backfill the rows that already exist, all of
-- which are Paystack because Paystack was the only gateway. The default stays
-- until the code lands because dropping it before the code names the column
-- turns every INSERT into a 23502, which hides the intent rather than showing it.
--
-- STILL TRUE AFTER TASK 9, AND MEASURED RATHER THAN ASSUMED (2026-09-10):
-- createIntent and storeEvent (server/shop/payments/intents.ts, webhook.ts)
-- name this column explicitly as of task 9, but the CODE naming it was never
-- the whole condition -- six test files raw-INSERT into shop_payment_intents
-- or shop_payment_events without naming provider at all, predating a second
-- gateway and left untouched because task 9's own mode change forbids editing
-- any *.test.ts file: schema.test.ts, intents.test.ts, refunds.test.ts,
-- webhook.test.ts (all under server/shop/payments/), plus
-- server/shop/composition.test.ts and server/shop/cart/routes/routes.test.ts.
-- Dropping both defaults now was tried and reverted in the same sitting:
-- 57 tests across exactly those 6 files turn red with 23502, matching this
-- comment's own prediction almost exactly. Drop the defaults only once those
-- six files' fixtures are updated to name provider too.
ALTER TABLE shop_payment_intents ADD COLUMN provider text NOT NULL DEFAULT 'paystack';
--> statement-breakpoint
ALTER TABLE shop_payment_intents
  ADD CONSTRAINT shop_payment_intents_provider_ck
  CHECK (provider IN ('paystack', 'flutterwave'));
--> statement-breakpoint
-- The gateway's OWN identifier, where it differs from the reference we supply.
-- Paystack transacts under our reference and this stays NULL for it.
-- Flutterwave mints a numeric transaction id and REFUNDS REQUIRE IT
-- (POST /v3/transactions/{id}/refund), while its webhook and verification
-- both accept our tx_ref. So provider_intent_id keeps holding OUR reference
-- for both gateways -- which is what keeps a retry safe and keeps
-- getIntentByProviderRef working -- and this column holds theirs.
ALTER TABLE shop_payment_intents ADD COLUMN provider_charge_id text;
--> statement-breakpoint
-- Same default, same reason, same NOT-YET-SAFE-TO-DROP note as
-- shop_payment_intents.provider above -- storeEvent (webhook.ts) names this
-- column explicitly as of task 9, but several *.test.ts files' raw INSERTs
-- into this table do not, and cannot be edited from that task.
ALTER TABLE shop_payment_events ADD COLUMN provider text NOT NULL DEFAULT 'paystack';
--> statement-breakpoint
ALTER TABLE shop_payment_events
  ADD CONSTRAINT shop_payment_events_provider_ck
  CHECK (provider IN ('paystack', 'flutterwave'));
--> statement-breakpoint
-- WHICH GATEWAY TAKES A PAYMENT, and which currencies each account has on.
--
-- SEEDED TO TODAY'S BEHAVIOUR EXACTLY: everything to Paystack, in naira. The
-- seed deliberately does NOT claim USD for Paystack. USD is not enabled on
-- that account -- it needs a USD request and a Zenith domiciliary account,
-- both still open -- and a seed that asserted it would be this migration
-- telling a lie the router would then act on.
CREATE TABLE shop_payment_settings (
  id text PRIMARY KEY,
  active_provider text NOT NULL,
  international_provider text,
  paystack_currencies text[] NOT NULL,
  flutterwave_currencies text[] NOT NULL,
  revision integer NOT NULL,
  updated_at bigint NOT NULL,
  updated_by uuid,
  CONSTRAINT shop_payment_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT shop_payment_settings_active_ck
    CHECK (active_provider IN ('paystack', 'flutterwave')),
  CONSTRAINT shop_payment_settings_intl_ck
    CHECK (international_provider IS NULL
           OR international_provider IN ('paystack', 'flutterwave')),
  CONSTRAINT shop_payment_settings_revision_ck CHECK (revision > 0),
  CONSTRAINT shop_payment_settings_paystack_ccy_ck
    CHECK (cardinality(paystack_currencies) > 0
           AND array_position(paystack_currencies, NULL) IS NULL
           AND array_to_string(paystack_currencies, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'),
  CONSTRAINT shop_payment_settings_flutterwave_ccy_ck
    CHECK (cardinality(flutterwave_currencies) > 0
           AND array_position(flutterwave_currencies, NULL) IS NULL
           AND array_to_string(flutterwave_currencies, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$')
);
--> statement-breakpoint
INSERT INTO shop_payment_settings
  (id, active_provider, international_provider,
   paystack_currencies, flutterwave_currencies, revision, updated_at, updated_by)
VALUES
  ('main', 'paystack', NULL, '{NGN}', '{NGN}', 1, 0, NULL)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- task-9 (plan defect repair, added mid-execution): the fields parseWebhook
-- already computes, persisted, so processEvent can dispatch on them instead
-- of re-deriving every decision from the raw stored payload using one
-- gateway's own field names. See webhook.ts's storeEvent and processEvent
-- for the account of what that hid: no Flutterwave payment would ever be
-- captured (its charge event name matches nothing this dispatched on), and a
-- forged refund body could have driven a payout, because reading an
-- unverified payload for a decision is only safe for a gateway that HMACs
-- its bytes -- Paystack does, Flutterwave's verif-hash does not.
--
-- All three NULLABLE. An event may legitimately carry none of them -- a
-- subscription.create names no charge and no refund -- and NULL is exactly
-- that, not a missing measurement.
ALTER TABLE shop_payment_events ADD COLUMN intent_status text;
--> statement-breakpoint
ALTER TABLE shop_payment_events
  ADD CONSTRAINT shop_payment_events_intent_status_ck
  CHECK (intent_status IS NULL
         OR intent_status IN ('requires_payment', 'authorized', 'captured', 'failed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE shop_payment_events ADD COLUMN refund_status text;
--> statement-breakpoint
ALTER TABLE shop_payment_events
  ADD CONSTRAINT shop_payment_events_refund_status_ck
  CHECK (refund_status IS NULL OR refund_status IN ('pending', 'succeeded', 'failed'));
--> statement-breakpoint
-- The provider's OWN refund id, for a refund event -- the same value
-- processEvent used to read out of the raw payload as refundIdOf(data).
ALTER TABLE shop_payment_events ADD COLUMN provider_refund_id text;
--> statement-breakpoint
-- BACKFILL (final-review finding, added after task 9): a PRE-EXISTING
-- refund event has refund_status and provider_refund_id NULL, because those
-- two columns are only populated for events storeEvent inserts from here on
-- -- and processEvent's refund arm now gates on `row.refundStatus !== null`
-- (webhook.ts). A NULL there sends a genuine unprocessed refund straight to
-- the `unhandled_type:` fallback: marked processed, applyRefundEvent never
-- called. Its shop_refunds row then stays 'pending' forever with its amount
-- still reserved against the intent, because drainPaymentEvents only ever
-- looks at processed_at IS NULL -- and this row would already read NOT
-- NULL there. The capture arm has a compensating fallback for the
-- equivalent gap (processEvent's own comment, the `type === 'charge.success'`
-- literal); the refund arm deliberately has none, so a backfill is the only
-- fix.
--
-- SAFE TO DERIVE FROM payload HERE, UNLIKE IN processEvent: every row this
-- WHERE can match is Paystack's -- the Flutterwave webhook route does not
-- exist before this same migration's code ships, and flutterwave.ts's own
-- parseWebhook never populates a refund.* type or a refundStatus at all, so
-- nothing else could ever have written one of these rows -- and Paystack
-- HMACs the raw bytes BEFORE JSON.parse ever runs (paystack.ts's
-- parseWebhook checks the signature first and rejects an invalid one before
-- touching the body), so a stored payload for a Paystack event is exactly
-- as trustworthy here as the columns storeEvent would have written from it
-- at verification time.
--
-- MIRRORS paystack.ts EXACTLY -- read both functions before changing this:
--   * mapRefundStatus: 'processed' -> 'succeeded', 'failed' -> 'failed',
--     anything else (including absent) -> 'pending'.
--   * refundIdOf: data.id when it is a JSON number or a non-empty JSON
--     string, else data.refund_reference when non-empty, else NULL. The one
--     thing not reproduced is the JS Number.isSafeInteger guard on a
--     numeric id -- not reachable here, since Paystack refund ids are small
--     sequential integers, always far inside that range.
UPDATE shop_payment_events
   SET refund_status = CASE payload -> 'data' ->> 'status'
         WHEN 'processed' THEN 'succeeded'
         WHEN 'failed' THEN 'failed'
         ELSE 'pending'
       END,
       provider_refund_id = COALESCE(
         CASE WHEN jsonb_typeof(payload -> 'data' -> 'id') IN ('number', 'string')
              THEN NULLIF(payload -> 'data' ->> 'id', '')
         END,
         NULLIF(payload -> 'data' ->> 'refund_reference', '')
       )
 WHERE processed_at IS NULL
   AND type LIKE 'refund.%'
   -- Always true at this point in the file -- the provider column added
   -- above defaults every pre-existing row to 'paystack' -- stated
   -- explicitly so this predicate still says the right thing if a later
   -- edit ever reorders these statements.
   AND provider = 'paystack';
