-- HOW CUSTOMERS GIVE THEIR ADDRESS (range 0760-0779; owner's queue, 2026-09-01).
--
-- ONE SWITCH, AND WHAT IT COSTS TO GET WRONG.
--
-- Since migration 0460 the storefront's checkout asks for a DISTRICT — an
-- area_key the shopper picks from marketing_service_areas — and the shop uses
-- it for exactly two things: shop_delivery_areas.delivers = false refuses the
-- address, and rate_minor replaces the zone's delivery amount. Everything else
-- about pricing already runs off country + region, because zoneFor() has never
-- looked at a district.
--
-- The owner asked for a simpler form. This row is the switch. address_mode =
-- 'simple' means the storefront stops asking for a district, and checkout
-- prices every order at its state's zone rate.
--
-- THE PRICING ENGINE NEEDS NO CHANGE FOR THAT, and that is the point of doing
-- it this way: districtRuling(db, config, null) already answers ZONE_RATE, and
-- has since 0300. What changes is the FORM, and one short-circuit so a district
-- captured before the switch flipped stops pricing the cart it is attached to.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- served_regions EXISTS BECAUSE 'simple' TURNS OFF EVERY REFUSAL.
--
-- A switched-off district is the only way this shop can currently say "we do
-- not go there". With no district on the address there is nothing to consult,
-- so simple mode implicitly agrees to deliver anywhere a zone covers — and the
-- catch-all zone covers all of Nigeria. That is a van promised, not a rate
-- mispriced, so it needs a way back.
--
-- served_regions IS THE WAY BACK: a list of address regions the shop will
-- accept, matched the way zoneFor matches, case- and whitespace-insensitively.
-- NULL means no restriction and is the seeded value — the behaviour before this
-- table existed. An EMPTY array is refused by the constraint below rather than
-- read as "serve nowhere", because a settings screen that can accidentally
-- close the whole shop with one cleared field is a settings screen that will.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A CHECK-PINNED SINGLETON, following marketing_settings (migration 0011): a
-- shop has one delivery configuration, and a table that could hold two would
-- leave two answers to "which form does checkout render" for whichever row
-- sorted first. There is no POST and no DELETE on the routes for the same
-- reason.
--
-- NAMED shop_delivery_settings AND NOT shop_settings, deliberately. This row
-- decides how an address is collected and how delivery is priced. A table
-- called shop_settings is a magnet for every unrelated flag anyone ever wants,
-- and the day one of those needs different read permissions the split is a
-- migration rather than a rename.
CREATE TABLE IF NOT EXISTS shop_delivery_settings (
  id text PRIMARY KEY,
  /* 'district' is today's behaviour and the seeded value. The failure mode of
   * a forgotten flag is then "the form we already ship", not a form nobody
   * reviewed. */
  address_mode text NOT NULL DEFAULT 'district',
  /* Offers the storefront's "Use my current location" button. Independent of
   * the mode because it is a separate question — a shop could want the pin
   * while keeping the district list, and the config route says so per field
   * rather than deriving one from the other. */
  location_offered boolean NOT NULL DEFAULT false,
  /* NULL = no restriction. See the header. */
  served_regions text[],
  revision integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT shop_delivery_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT shop_delivery_settings_mode_ck
    CHECK (address_mode IN ('district', 'simple')),
  CONSTRAINT shop_delivery_settings_revision_ck CHECK (revision > 0),
  /* The array's own shape, the marketing_service_areas.aliases idiom: a CHECK
   * may not contain a subquery and unnest in one is a subquery, so NULL and
   * empty elements are found with array_position rather than by unnesting.
   * cardinality > 0 is what makes "serve nowhere" unrepresentable. */
  CONSTRAINT shop_delivery_settings_regions_ck CHECK (
    served_regions IS NULL
    OR (cardinality(served_regions) > 0
        AND array_position(served_regions, NULL) IS NULL
        AND array_position(served_regions, '') IS NULL)
  )
);--> statement-breakpoint
-- THE SEED IS THE CURRENT BEHAVIOUR, EXACTLY. A deployment that never opens
-- the settings screen keeps the district picker, no location prompt and no
-- region restriction — which is what it has today.
--
-- ON CONFLICT DO NOTHING so a re-run cannot reset a shop that has since chosen
-- simple mode back to districts. The timestamp is this migration's own date;
-- the first real save overwrites it.
INSERT INTO shop_delivery_settings
  (id, address_mode, location_offered, served_regions, revision, updated_at)
VALUES ('main', 'district', false, NULL, 1, 1788220800000)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
