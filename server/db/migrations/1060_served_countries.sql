-- WHERE THE SHOP WILL SHIP (range 1060-1079; owner's queue, 2026-09-08).
--
-- THE COUNTRY FIELD WAS A HARDCODED CONSTANT, AND THAT WAS THE WHOLE BLOCKER.
--
-- server/shop/settings/config.ts pinned country to
-- { default: 'NG', allowed: ['NG'], locked: true } and served it from
-- GET /api/public/shop/delivery-config. The storefront gates its checkout on
-- that list — a shipping address in any other country disables Continue and
-- shows "We don't deliver to <country> yet". So international selling was
-- impossible no matter which zones existed, and no admin screen could change
-- it: the answer was in a deployed constant, in a different repository from
-- the form that obeyed it.
--
-- This column moves that decision into the row that already owns every other
-- "what does checkout ask, and where will we deliver" fact (migration 0760).
-- Opening a country becomes a setting an owner saves, and the storefront needs
-- no deploy to honour it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NOT NULL, AND THERE IS NO SPELLING OF "EVERYWHERE". THE ASYMMETRY WITH
-- served_regions IS DELIBERATE AND IT IS ABOUT MONEY.
--
-- served_regions is nullable and NULL means "no restriction", which is
-- harmless: every Nigerian region is inside a zone this shop has priced.
--
-- An unrestricted COUNTRY list is not harmless — it is the bug migration 0900
-- existed to fix. zoneFor() hands any country nobody claimed to the fallback
-- zone, so before 0900 a London order was quoted domestic Nigerian delivery
-- and charged 7.5% Nigerian VAT while looking like an order to Kano. A country
-- this shop has not deliberately named is a country it will not ship to, and
-- that has to be unrepresentable rather than merely discouraged.
--
-- Hence cardinality > 0 as well: "serve nowhere" would shut the shop, and
-- 0760's reasoning about one cleared field closing everything applies here
-- with more force, not less.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THIS COLUMN GOVERNS THE MANUAL SHIPPING METHOD ONLY (owner, 2026-09-08).
--
-- It is the owner saying where the shop will send a parcel it arranges itself.
-- A parcel routed through a logistics provider — Fez or Terminal, on
-- feat/logistics-providers and not on master when this shipped — is serviceable
-- exactly when THAT PROVIDER says so: the provider owns the country and city
-- lists and quotes the rate. A provider-routed checkout must therefore SKIP
-- this list rather than be added to it, or the shop would refuse deliveries a
-- courier would happily make. See serviceRefusal() in shop/settings/repo.ts.
--
-- ADDING A COUNTRY HERE PRICES NOTHING. shop_shipping_zones still decides the
-- rate, and a country with no zone of its own gets the catch-all — seeded at
-- 50,000 kobo (0900) precisely so a forgotten rate fails safe instead of
-- giving away worldwide shipping. Set the zone rate FIRST, then open the
-- country.
ALTER TABLE shop_delivery_settings
  ADD COLUMN IF NOT EXISTS served_countries text[] NOT NULL DEFAULT '{NG}';--> statement-breakpoint
-- ISO-3166-1 alpha-2, uppercase, matching shop_addresses_country_ck and the
-- countryCode regex on the checkout wire — a lowercase code would silently
-- pick the fallback zone and charge the wrong tax.
--
-- ONE REGEX OVER THE JOINED ARRAY rather than an unnest, because a CHECK may
-- not contain a subquery and unnest in one is a subquery (0760's note on the
-- same problem). Joining and matching validates every element at once AND
-- forbids the empty array for free: array_to_string of '{}' is '', which the
-- anchored pattern rejects. NULL elements are invisible to array_to_string,
-- so they are still caught the array_position way.
ALTER TABLE shop_delivery_settings
  ADD CONSTRAINT shop_delivery_settings_countries_ck CHECK (
    array_position(served_countries, NULL) IS NULL
    AND array_to_string(served_countries, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'
  );--> statement-breakpoint
-- THE SEED IS TODAY'S BEHAVIOUR, EXACTLY — Nigeria and nowhere else, which is
-- what the deleted constant said. The column DEFAULT already gives the
-- existing row this value; the UPDATE is here for a row that somehow predates
-- it, and is a no-op on every ordinary deployment.
--
-- Opening a country is therefore a deliberate act on the settings screen and
-- never a side effect of deploying this migration.
UPDATE shop_delivery_settings
  SET served_countries = '{NG}'
  WHERE served_countries IS NULL OR cardinality(served_countries) = 0;--> statement-breakpoint
