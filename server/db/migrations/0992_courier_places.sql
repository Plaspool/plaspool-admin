-- COURIER PLACE LISTS (range 1000-1019; plan docs/superpowers/plans/2026-09-08-courier-places.md).
--
-- HAND-WRITTEN IN FULL, as every commerce migration is: drizzle-kit has never
-- seen this table and can neither generate nor undo this DDL.
--
-- A CACHE, AND ONLY A CACHE. Terminal validates state AND city against its own
-- per-country lists and refuses anything else with a 400 that kills the whole
-- quote -- measured 2026-09-07: 37 states for NG, 10 place names inside the
-- FCT, 46 in Lagos. Asking it on a request path would be 37 calls in a
-- checkout, so an admin presses a button, the answer lands here, and the
-- storefront reads this row. Losing the table loses nothing but the button
-- press: every column can be refetched from the courier.
--
-- KEYED BY COURIER AND COUNTRY TOGETHER. One row per pair, so both couriers'
-- lists can sit here at once and switching the courier reads a different row
-- rather than a list the live one has never heard of. A key on provider alone
-- would make a second country overwrite the first.
--
-- cities IS NULL, NOT AN EMPTY OBJECT, for a courier that enforces no city
-- list -- Fez takes a free-text address and validates no city at all. "We
-- enforce nothing" and "we enforce a list that happens to be empty" send a
-- storefront to opposite behaviours, and only the first is true of Fez.
--
-- No country is pinned by this table beyond the two-letter shape: the lists
-- are country-parameterised so nothing here is Nigeria-only by construction.

CREATE TABLE shop_logistics_places (
  provider text NOT NULL,
  country text NOT NULL,
  -- [{ name, code }] -- code is the courier's own state code, null where it has none
  regions jsonb NOT NULL,
  -- { <region code>: [{ name }] } -- null for a courier that enforces no city list
  cities jsonb,
  fetched_at bigint NOT NULL,
  CONSTRAINT shop_logistics_places_pk PRIMARY KEY (provider, country),
  CONSTRAINT shop_logistics_places_provider_ck CHECK (provider IN ('fez', 'terminal')),
  CONSTRAINT shop_logistics_places_country_ck CHECK (country ~ '^[A-Z]{2}$'),
  -- jsonb holds a scalar as happily as an array, and every reader indexes into
  -- these -- the argument shop_logistics_settings_packaging_ck already makes.
  CONSTRAINT shop_logistics_places_regions_ck CHECK (jsonb_typeof(regions) = 'array'),
  CONSTRAINT shop_logistics_places_cities_ck CHECK (cities IS NULL OR jsonb_typeof(cities) = 'object')
);
