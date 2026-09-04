-- STOP PRICING LONDON AS REST OF NIGERIA (range 0900-0919; owner's queue,
-- 2026-09-04).
--
-- THE BUG THIS FIXES IS LIVE RIGHT NOW, and it is not that foreign orders are
-- refused. They are accepted. shop_addresses.country_code only has to match
-- ^[A-Z]{2}$ — there is no allowlist and never has been — and the zone that
-- catches everything nobody else claims is "Rest of Nigeria", whose countries
-- array is empty. Per 0240's own comment an empty country list means "every
-- country no other zone claims". So a London address is quoted 4,000 naira
-- domestic delivery and charged 7.5% Nigerian VAT, and lands in the queue
-- looking exactly like an order to Kano. Nothing anywhere says otherwise.
--
-- It has never fired: all 9 orders are NGN and all 13 addresses are NG. This
-- migration closes it before it does.
--
-- WHAT CHANGES. Rest of Nigeria stops being the catch-all and becomes what its
-- name says — countries {NG}, no region restriction — and a new International
-- zone becomes the fallback. zoneFor() then reads:
--
--   Abuja / Lagos      matched by region, unchanged
--   anywhere else NG   Rest of Nigeria, now by COUNTRY rather than by fallback
--   anywhere else      International
--
-- Nigerian pricing is bit-for-bit what it is today. Only addresses that are
-- currently being mispriced move, and every one of them moves off a rate that
-- was never meant for them.
--
-- TAX STAYS AT 7.5% ON THE INTERNATIONAL ZONE — the owner's explicit decision,
-- taken with the alternative in front of them. It is one integer in one row and
-- the admin's shipping screen edits it, so if an accountant says exports are
-- zero-rated this is an UPDATE and not a migration. Recording it here so the
-- next reader knows it was chosen rather than copied.
--
-- THE ORDER OF THE TWO STATEMENTS BELOW MATTERS, and there is a gap between
-- them that cannot be closed. shop_shipping_zones_fallback_uq permits exactly
-- one fallback, and the Neon HTTP driver refuses transaction() unconditionally
-- (contract: one guarded statement, never db.transaction), so the flag must be
-- cleared before it can be set and no statement can do both atomically.
--
-- BETWEEN THEM THERE IS NO FALLBACK ZONE, and zoneFor throws when it needs one
-- and finds none. That window is safe HERE for a reason specific to this
-- migration, not in general: the first statement gives Rest of Nigeria
-- countries {NG}, so every Nigerian address resolves by country throughout the
-- gap and never reaches the fallback branch at all. Only a non-Nigerian address
-- could fail, and there has never been one. Do not copy this ordering into a
-- shop that already takes foreign orders.
UPDATE shop_shipping_zones
   SET countries = ARRAY['NG']::text[],
       is_fallback = false,
       updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
 WHERE id = 'zone_rest_of_nigeria';--> statement-breakpoint

-- position 3 puts it last in the admin's list, which is where a catch-all
-- belongs: the specific zones are what an owner scans for.
INSERT INTO shop_shipping_zones
  (id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
   is_fallback, position, created_at, updated_at)
VALUES
  ('zone_international', 'International', ARRAY[]::text[], ARRAY[]::text[],
   750, 'VAT', false, true, 3,
   (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
   (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- A DELIVERY PRICE THE OWNER MUST REPLACE, and deliberately a blunt one.
-- International shipping from Lagos is not a number this migration can know,
-- and 0 would silently give away worldwide delivery the first time somebody
-- checked out. 50,000 naira is high enough to be obviously provisional and to
-- fail safe if it is forgotten. CLAUDE.md §1 already carries the standing note
-- that delivery rates here are provisional and owner-set.
INSERT INTO shop_shipping_options
  (id, zone_id, label, amount_minor, estimate, position, created_at, updated_at)
VALUES
  ('ship_international_standard', 'zone_international', 'International delivery',
   5000000, '7-21 working days', 0,
   (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
   (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- THE DOLLAR OVERRIDE FOR DELIVERY, mirroring 0860 for variants exactly.
-- amount_minor stays the naira price and stays the base; this is the number to
-- set when the converted one is wrong. NULL means derive it from the rate in
-- shop_currency_settings, so a shop that never touches this column still quotes
-- sane dollars, and one rate change moves every zone at once.
--
-- WHY EVERY ZONE AND NOT JUST THE INTERNATIONAL ONE. Because the currency is
-- chosen by the SHOPPER, not by their address: a Nigerian who switches the
-- storefront to dollars still checks out against zone_abuja, and that zone
-- needs a dollar delivery price too. Putting the column on the international
-- zone alone would work until the first person did that.
ALTER TABLE shop_shipping_options
  ADD COLUMN amount_usd_minor bigint;--> statement-breakpoint

ALTER TABLE shop_shipping_options
  ADD CONSTRAINT shop_shipping_options_amount_usd_minor_ck
  CHECK (amount_usd_minor IS NULL OR amount_usd_minor >= 0);
