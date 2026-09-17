-- Naira is the only real price. Other currencies are PUBLISHED MULTIPLIERS the
-- storefront applies for display, and a non-naira amount becomes real money
-- only when a payment link is created (owner, 2026-09-11).
--
-- A FOLLOW-UP TO 1120, NOT AN EDIT OF IT. 1120 is applied to the dev database,
-- so it stays exactly as it was and this reshapes what it built.
--
-- 0860's price_usd_minor goes first. Nothing reads it (only a drizzle
-- declaration named it). The guard REFUSES rather than dropping prices: a
-- database where somebody typed a dollar price stops this migration loudly
-- instead of losing the number.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'shop_variants' AND column_name = 'price_usd_minor') THEN
    IF EXISTS (SELECT 1 FROM shop_variants WHERE price_usd_minor IS NOT NULL) THEN
      RAISE EXCEPTION 'shop_variants.price_usd_minor holds prices; move them before dropping the column';
    END IF;
    ALTER TABLE shop_variants DROP COLUMN price_usd_minor;
  END IF;
END $$;
--> statement-breakpoint
-- THE MULTIPLIER IS THE STORED TRUTH: target-currency units per ONE naira,
-- times 10^12, an integer. 1120 stored the inverse (naira per unit, ppm),
-- whose reciprocal cannot be published exactly. Existing rows are converted,
-- not dropped: multiplier_e12 = 10^18 / rate_ppm, rounded.
ALTER TABLE shop_fx_rates
  ADD COLUMN multiplier_e12 bigint,
  ADD COLUMN updated_at bigint;
--> statement-breakpoint
UPDATE shop_fx_rates
   SET multiplier_e12 = round(1000000000000000000::numeric / rate_ppm)::bigint,
       updated_at = fetched_at,
       source = CASE WHEN source = 'manual' THEN 'manual' ELSE 'feed' END;
--> statement-breakpoint
ALTER TABLE shop_fx_rates
  ALTER COLUMN multiplier_e12 SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS shop_fx_rates_rate_ck,
  DROP COLUMN rate_ppm,
  DROP COLUMN fetched_at,
  -- 'manual' never goes stale and a feed run never overwrites it.
  ADD CONSTRAINT shop_fx_rates_multiplier_ck CHECK (multiplier_e12 > 0),
  ADD CONSTRAINT shop_fx_rates_source_ck CHECK (source IN ('feed', 'manual'));
--> statement-breakpoint
-- A per-variant override is a MULTIPLIER too, replacing the currency's for
-- that variant's lines. 1120's hand-set amounts go: an amount cannot follow
-- the naira price when the owner edits it, and a multiplier can.
DROP TABLE shop_variant_prices;
--> statement-breakpoint
CREATE TABLE shop_variant_multipliers (
  variant_id text NOT NULL REFERENCES shop_variants(id) ON DELETE CASCADE,
  currency text NOT NULL,
  multiplier_e12 bigint NOT NULL,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (variant_id, currency),
  CONSTRAINT shop_variant_multipliers_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT shop_variant_multipliers_multiplier_ck CHECK (multiplier_e12 > 0)
);
--> statement-breakpoint
-- NO HIDDEN BUFFER. A margin, if the owner wants one, is baked into the
-- multiplier when it is stored, so the published number is the charged one.
ALTER TABLE shop_currency_settings
  DROP CONSTRAINT IF EXISTS shop_currency_settings_buffer_ck,
  DROP COLUMN buffer_bps,
  ADD COLUMN country_currency jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN fallback_currency text NOT NULL DEFAULT 'NGN',
  ADD CONSTRAINT shop_currency_settings_countries_ck CHECK (jsonb_typeof(country_currency) = 'object'),
  ADD CONSTRAINT shop_currency_settings_fallback_ck CHECK (fallback_currency ~ '^[A-Z]{3}$');
--> statement-breakpoint
-- The owner's country map. Any country not listed pays in fallback_currency.
UPDATE shop_currency_settings
   SET country_currency = '{
         "NG": "NGN", "GH": "GHS", "KE": "KES", "UG": "UGX", "TZ": "TZS", "RW": "RWF",
         "ZA": "ZAR", "ZM": "ZMW", "EG": "EGP", "GB": "GBP", "US": "USD",
         "AT": "EUR", "BE": "EUR", "CY": "EUR", "DE": "EUR", "EE": "EUR", "ES": "EUR",
         "FI": "EUR", "FR": "EUR", "GR": "EUR", "HR": "EUR", "IE": "EUR", "IT": "EUR",
         "LT": "EUR", "LU": "EUR", "LV": "EUR", "MT": "EUR", "NL": "EUR", "PT": "EUR",
         "SI": "EUR", "SK": "EUR",
         "BJ": "XOF", "BF": "XOF", "CI": "XOF", "GW": "XOF", "ML": "XOF", "NE": "XOF",
         "SN": "XOF", "TG": "XOF",
         "CM": "XAF", "CF": "XAF", "TD": "XAF", "CG": "XAF", "GQ": "XAF", "GA": "XAF"
       }'::jsonb,
       revision = revision + 1
 WHERE id = 'main';
--> statement-breakpoint
-- WHAT THE GATEWAY WAS ASKED FOR. amount and currency stay the naira grand
-- total, the order's authoritative figure; these say what was actually
-- charged, at which published revision, for which country, and how each
-- component converted. NULL on every intent created before this column.
ALTER TABLE shop_payment_intents
  ADD COLUMN charge_currency text,
  ADD COLUMN charge_amount_minor integer,
  ADD COLUMN charge_refunded_minor integer NOT NULL DEFAULT 0,
  ADD COLUMN rates_revision integer,
  ADD COLUMN country text,
  ADD COLUMN charge_breakdown jsonb,
  ADD CONSTRAINT shop_payment_intents_charge_ccy_ck
    CHECK (charge_currency IS NULL OR charge_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT shop_payment_intents_charge_pair_ck
    CHECK ((charge_currency IS NULL) = (charge_amount_minor IS NULL)),
  ADD CONSTRAINT shop_payment_intents_charge_amount_ck
    CHECK (charge_amount_minor IS NULL OR charge_amount_minor > 0),
  -- The refund invariant again, in the charged currency.
  ADD CONSTRAINT shop_payment_intents_charge_refunded_ck
    CHECK (charge_refunded_minor >= 0
           AND (charge_amount_minor IS NULL OR charge_refunded_minor <= charge_amount_minor)),
  ADD CONSTRAINT shop_payment_intents_country_ck
    CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
--> statement-breakpoint
-- A refund is paid in the charged currency; amount stays its naira figure.
ALTER TABLE shop_refunds
  ADD COLUMN charge_currency text,
  ADD COLUMN charge_amount_minor integer,
  ADD CONSTRAINT shop_refunds_charge_ccy_ck
    CHECK (charge_currency IS NULL OR charge_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT shop_refunds_charge_pair_ck
    CHECK ((charge_currency IS NULL) = (charge_amount_minor IS NULL)),
  ADD CONSTRAINT shop_refunds_charge_amount_ck
    CHECK (charge_amount_minor IS NULL OR charge_amount_minor >= 0);
--> statement-breakpoint
-- What the gateway VERIFIED, kept beside the event, so a capture is only
-- counted when the money received matches what was charged.
ALTER TABLE shop_payment_events
  ADD COLUMN reported_amount bigint,
  ADD COLUMN reported_currency text;
--> statement-breakpoint
-- And carried to the order. The naira totals stay authoritative.
ALTER TABLE shop_orders
  ADD COLUMN charge_currency text,
  ADD COLUMN charge_amount_minor integer,
  ADD COLUMN charge jsonb,
  ADD CONSTRAINT shop_orders_charge_ccy_ck
    CHECK (charge_currency IS NULL OR charge_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT shop_orders_charge_pair_ck
    CHECK ((charge_currency IS NULL) = (charge_amount_minor IS NULL));
