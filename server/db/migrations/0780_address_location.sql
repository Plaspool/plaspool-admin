-- WHERE THE DOOR ACTUALLY IS (range 0780-0799) — the optional pin a shopper
-- may share alongside the address, migration 0760's other half.
--
-- HAND-WRITTEN IN FULL, like every migration in these ranges: drizzle-kit has
-- never seen shop_addresses (drizzle.config.ts declares only
-- server/db/schema.ts). Declared in server/shop/cart/schema.ts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- IT IS FOR THE RIDER. IT DOES NOT PRICE ANYTHING, AND IT CANNOT.
--
-- There is no geographic data anywhere in this system. marketing_service_areas
-- holds a name, a key, a region and some aliases — no coordinates, no
-- boundaries — and shop_shipping_zones matches on a region STRING. So there is
-- nothing to measure a coordinate against, and pricing by distance would need
-- polygons or a per-zone origin, which is its own project.
--
-- The public config route says pricing: false on the wire for exactly this
-- reason: so the next person to touch this cannot wire it into a rate by
-- assuming it was meant to be one.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MICRO-DEGREES AS integer, THE WAY MONEY IS MINOR UNITS.
--
-- numeric reads back as a STRING from both drivers and double precision makes
-- 9.05785 a value that no longer compares equal to itself across a round trip.
-- An integer of degrees x 1e6 is exact, is the same type in Neon and PGlite,
-- and resolves to about 11cm — far finer than any consumer GPS fix. Latitude
-- fits in +/-90000000 and longitude in +/-180000000, both comfortably inside
-- int4. The WIRE stays decimal degrees; the conversion is one multiply in
-- server/shop/cart/checkout/repo.ts and is the only place that knows.
--
-- ALL FIVE NULLABLE, PERMANENTLY. Every address written before this migration
-- has no pin, most addresses written after it will not either — the prompt is
-- optional by design and a refusal must cost the shopper nothing — and the
-- feature ships switched off (0760 seeds location_offered = false).
ALTER TABLE shop_addresses
  ADD COLUMN location_lat_e6 integer,
  ADD COLUMN location_lng_e6 integer,
  ADD COLUMN location_accuracy_m integer,
  ADD COLUMN location_source text,
  ADD COLUMN location_captured_at bigint;--> statement-breakpoint
-- ALL OR NOTHING, so half a pin cannot exist. A coordinate with no capturedAt
-- is a fix of unknown age, which is worse than no fix: a rider sent to where
-- somebody stood last March would rather have had the street text.
--
-- accuracy_m IS EXEMPT FROM THAT and stays optional inside the present branch,
-- because source = 'pin' — a spot the shopper dropped on a map — genuinely has
-- no accuracy figure to report. Only a 'device' fix comes with one.
ALTER TABLE shop_addresses
  ADD CONSTRAINT shop_addresses_location_ck CHECK (
    (location_lat_e6 IS NULL AND location_lng_e6 IS NULL
     AND location_accuracy_m IS NULL AND location_source IS NULL
     AND location_captured_at IS NULL)
    OR (location_lat_e6 IS NOT NULL AND location_lng_e6 IS NOT NULL
        AND location_source IS NOT NULL AND location_captured_at IS NOT NULL)
  );--> statement-breakpoint
-- THE RANGES, because a swapped lat/lng is the classic mistake here and it is
-- silent: 7.49508, 9.05785 is a legal pair of numbers and a spot in the Gulf
-- of Guinea. Bounding latitude at 90 catches a longitude that arrived in the
-- latitude slot for every point outside the tropics, which is most of them.
ALTER TABLE shop_addresses
  ADD CONSTRAINT shop_addresses_location_lat_ck
    CHECK (location_lat_e6 IS NULL OR location_lat_e6 BETWEEN -90000000 AND 90000000),
  ADD CONSTRAINT shop_addresses_location_lng_ck
    CHECK (location_lng_e6 IS NULL OR location_lng_e6 BETWEEN -180000000 AND 180000000),
  ADD CONSTRAINT shop_addresses_location_accuracy_ck
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  -- 'device' is the browser's Geolocation API; 'pin' is a spot dropped on a
  -- map. An enum-ish column carries a check, per the schema rules.
  ADD CONSTRAINT shop_addresses_location_source_ck
    CHECK (location_source IS NULL OR location_source IN ('device', 'pin'));--> statement-breakpoint
