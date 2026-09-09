-- WHERE THE COURIER WILL CARRY TO, OUTSIDE NIGERIA (range 1080-1099, 2026-09-09).
--
-- Migration 1060 made the served-country list an owner's setting instead of a
-- hardcoded constant, which is what made international selling possible at all.
-- This is the other half of the same question: the owner says where the shop
-- WANTS to sell, and the courier says where it CAN actually carry. The shop's
-- list gates it and the courier's can only narrow it, so a country nobody can
-- ship to never reaches a checkout — Egypt is on the shop's list today and is
-- not on Fez's, so a shopper in Cairo could pay for a parcel nobody could send.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A CACHE AND NOT A LIVE CALL, which is the same argument
-- 0992_courier_places.sql makes and for the same reason: this list is read by
-- GET /api/public/shop/delivery-config, which every storefront page load hits,
-- and which is served with Cache-Control: public. A courier call in there
-- would put a third party's uptime in front of the shop's own checkout form.
-- An admin presses refresh; every reader after that is one SELECT.
--
-- ONE ROW PER PROVIDER, not per provider and country. A courier publishes its
-- whole export catalogue in a single call (Fez: GET /orders/export-locations),
-- and splitting that into a row per destination would invent a shape the
-- source does not have, and a partial refresh that could leave two halves
-- disagreeing about the same fetch.
--
-- DESTINATIONS AND WEIGHTS ARE SEPARATE COLUMNS BECAUSE THEY ARE SEPARATE
-- LISTS in the courier's own answer, and they are read at different moments:
-- destinations decide which countries a checkout may offer, weights decide
-- whether a basket that has already reached the delivery step can be carried.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SHAPES, so a reader need not go to the adapter:
--   destinations  [{ id, name, place, countryCodes: string[], minKg, maxKg }]
--   weights       [{ id, name, minKg, maxKg }]
--
-- countryCodes is an ARRAY and not a column because a courier may publish a
-- REGION rather than a country -- Fez sells one row named "Europe" -- and a
-- region is not one ISO code. An empty array is the honest answer for a name
-- nothing recognises, and such a row is offered to nobody rather than guessed.
--
-- bigint epoch-ms, never timestamptz, as everywhere else here.
CREATE TABLE shop_logistics_exports (
  provider text NOT NULL,
  destinations jsonb NOT NULL,
  weights jsonb NOT NULL,
  fetched_at bigint NOT NULL,
  CONSTRAINT shop_logistics_exports_pk PRIMARY KEY (provider),
  CONSTRAINT shop_logistics_exports_provider_ck CHECK (provider IN ('fez', 'terminal')),
  CONSTRAINT shop_logistics_exports_destinations_ck CHECK (jsonb_typeof(destinations) = 'array'),
  CONSTRAINT shop_logistics_exports_weights_ck CHECK (jsonb_typeof(weights) = 'array'),
  CONSTRAINT shop_logistics_exports_fetched_at_ck CHECK (fetched_at > 0)
);
