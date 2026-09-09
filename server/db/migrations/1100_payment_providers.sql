-- Two gateways, and an intent that remembers which one took it.
--
-- WHY A COLUMN AND NOT A DERIVED VALUE. provider_intent_id is nullable: it is
-- NULL for exactly the case that matters, where the row was claimed and then
-- the provider call timed out. Deriving the gateway from a reference format
-- would therefore answer "unknown" precisely when a customer is stuck and
-- somebody needs to finish the job. A column is answerable always.
--
-- THE DEFAULT IS ADDED AND THEN DROPPED. It exists to backfill the rows that
-- already exist, all of which are Paystack because Paystack was the only
-- gateway. Leaving it would let a future INSERT that forgot the column claim
-- Paystack silently, which is the same class of bug as a fixture that never
-- exercises the real default.
ALTER TABLE shop_payment_intents ADD COLUMN provider text NOT NULL DEFAULT 'paystack';
--> statement-breakpoint
ALTER TABLE shop_payment_intents ALTER COLUMN provider DROP DEFAULT;
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
ALTER TABLE shop_payment_events ADD COLUMN provider text NOT NULL DEFAULT 'paystack';
--> statement-breakpoint
ALTER TABLE shop_payment_events ALTER COLUMN provider DROP DEFAULT;
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
