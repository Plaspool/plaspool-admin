-- Paying in your own currency: a price per currency, a rate per currency, and
-- which currencies are switched on.
--
-- Hand-set prices. One per variant per currency, and the primary key says so
-- rather than a route remembering to check.
--
-- NOT IN shop_prices, AND THAT IS WHY THIS TABLE EXISTS. shop_prices_current_uq
-- is unique on variant_id ALONE and fifteen files read it; a second current row
-- for another currency would not fail, it would silently double every catalogue
-- row. This is joined only when a non-store currency is asked for, so the
-- default path does not change at all.
CREATE TABLE shop_variant_prices (
  variant_id text NOT NULL REFERENCES shop_variants(id) ON DELETE CASCADE,
  currency text NOT NULL,
  amount_minor integer NOT NULL,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (variant_id, currency),
  CONSTRAINT shop_variant_prices_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT shop_variant_prices_amount_ck CHECK (amount_minor >= 0)
);
--> statement-breakpoint
-- One row per currency: naira per ONE unit of it, in parts per million. An
-- integer, never a float, for the same reason money is never a float.
-- 1 GHS = NGN 117.70 stores as 117700000.
CREATE TABLE shop_fx_rates (
  currency text PRIMARY KEY,
  rate_ppm bigint NOT NULL,
  fetched_at bigint NOT NULL,
  source text NOT NULL,
  CONSTRAINT shop_fx_rates_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT shop_fx_rates_rate_ck CHECK (rate_ppm > 0)
);
--> statement-breakpoint
-- RESHAPED, NOT EXTENDED. 0880 built this around a single USD rate and a
-- usd_enabled flag -- the one-alternate-currency assumption this migration
-- abandons. Nothing in the codebase reads those columns, so they go rather than
-- sitting beside a general mechanism that contradicts them.
ALTER TABLE shop_currency_settings DROP CONSTRAINT IF EXISTS shop_currency_settings_enabled_needs_rate_ck;
--> statement-breakpoint
ALTER TABLE shop_currency_settings DROP CONSTRAINT IF EXISTS shop_currency_settings_rate_ck;
--> statement-breakpoint
ALTER TABLE shop_currency_settings DROP CONSTRAINT IF EXISTS shop_currency_settings_rounding_ck;
--> statement-breakpoint
ALTER TABLE shop_currency_settings DROP COLUMN IF EXISTS usd_enabled;
--> statement-breakpoint
ALTER TABLE shop_currency_settings DROP COLUMN IF EXISTS ngn_per_usd_minor;
--> statement-breakpoint
ALTER TABLE shop_currency_settings DROP COLUMN IF EXISTS usd_rounding_minor;
--> statement-breakpoint
ALTER TABLE shop_currency_settings
  ADD COLUMN store_currency text NOT NULL DEFAULT 'NGN',
  ADD COLUMN enabled text[] NOT NULL DEFAULT '{NGN}',
  ADD COLUMN buffer_bps integer NOT NULL DEFAULT 500,
  ADD COLUMN staleness_hours integer NOT NULL DEFAULT 168;
--> statement-breakpoint
ALTER TABLE shop_currency_settings
  ADD CONSTRAINT shop_currency_settings_store_ck CHECK (store_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT shop_currency_settings_enabled_ck
    CHECK (cardinality(enabled) > 0
           AND array_position(enabled, NULL) IS NULL
           AND array_to_string(enabled, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'),
  ADD CONSTRAINT shop_currency_settings_buffer_ck CHECK (buffer_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT shop_currency_settings_stale_ck CHECK (staleness_hours > 0),
  -- The store currency is always switched on, or the shop could not quote its
  -- own prices. Held by the database, where a route cannot forget it.
  ADD CONSTRAINT shop_currency_settings_store_enabled_ck
    CHECK (array_position(enabled, store_currency) IS NOT NULL);
--> statement-breakpoint
INSERT INTO shop_currency_settings (id, revision, updated_at)
VALUES ('main', 1, 0)
ON CONFLICT (id) DO NOTHING;
