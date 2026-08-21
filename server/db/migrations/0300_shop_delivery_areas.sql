-- PER-DISTRICT DELIVERY: does the shop go there, and what does it charge
-- (range 0300-0319).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen these tables and can neither generate nor undo this DDL.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A SHOP TABLE AND NOT TWO COLUMNS ON `marketing_service_areas`.
--
-- The districts an owner picks from ARE the marketing service areas — that is
-- the whole point, and it is why this table stores no name and no region. But
-- the shop does not read marketing's tables. Every crossing that exists today
-- goes through a typed port in `shared/marketing/` (`PointsRedemptionPort`),
-- never through a table, and adding `delivery_rate_minor` to a marketing table
-- would make the shop's pricing depend on marketing's schema forever.
--
-- So the place is marketing's and the COMMERCE FACT about it is the shop's,
-- joined on `area_key` — the marketing area's stable handle, the one thing a
-- rename does not move (`0012_service_areas.sql`: "A rename moves `name` and
-- never this"). Rename Maitama and the rate follows it. There is deliberately
-- NO foreign key: a cross-module FK is the coupling this split exists to
-- avoid, and an orphan row is harmless — it is a rate for a district nobody
-- can select.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️  ABSENCE MEANS "CARRY ON AS TODAY", AND THAT IS THE SAFETY PROPERTY.
--
-- A district with NO ROW here delivers, at whatever `shop_shipping_zones`
-- already quotes for its state. That is exactly the live behaviour: the
-- fallback zone catches every address, so nowhere is currently undeliverable.
-- Rows are written lazily, the first time an owner says something about a
-- district.
--
-- This is the opposite of `marketing_service_areas.active`, which defaults to
-- FALSE so a forgotten flag loses a sale rather than promising a van. The
-- inverse is right here for one reason: this table is being added to a shop
-- that is ALREADY SELLING to every district. A `false` default plus a wired
-- refusal path would stop the shop dead the moment it was switched on — the
-- flag would not be "forgotten", it would be retroactively applied to places
-- that were selling fine yesterday.
--
-- `rate_minor` IS NULLABLE FOR THE SAME REASON. NULL is not "free" and not
-- "zero": it is "no district override — use the zone rate". Only a non-NULL
-- value overrides, so an owner who switches a district ON without naming a
-- price gets the state's rate rather than a silent ₦0.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠️  NOTHING AT CHECKOUT READS THIS YET, AND THAT IS NOT AN OVERSIGHT.
--     `zoneFor` (`server/shop/cart/checkout/shipping.ts`) matches on the
--     address's `region` — the STATE — and the live order capture
--     (`src/routes/__fixtures__/orders-live.json`) has `city: "Abuja"` on every
--     row, i.e. the state again. There is no district text in a checkout
--     address to match against. Until the storefront's address form captures a
--     district, this table is authored in the admin and inert at the till.
--     Wiring it is a separate change and it is money-adjacent: see CLAUDE.md §2
--     on driving the real thing before believing it works.
--
-- `bigint` epoch-ms timestamps, never `timestamptz` — the rule every table in
-- this database follows (see 0200/0220/0240).

CREATE TABLE "shop_delivery_areas" (
  "id" text PRIMARY KEY NOT NULL,
  /*
   * `marketing_service_areas.key` — the stable handle, NOT the display name and
   * NOT the row id. Unique: one commerce opinion per district.
   */
  "area_key" text NOT NULL,
  /*
   * Does the shop deliver here. A row exists only when an owner has had an
   * opinion, so `false` here is a deliberate "we do not go there" rather than a
   * default nobody chose — see the header note on absence.
   */
  "delivers" boolean NOT NULL DEFAULT true,
  /*
   * Minor units (100 per naira — ₦3,000 is 300000), in the store currency.
   * NULL means NO OVERRIDE: price this district from its state's zone. Zero is
   * a legitimate stored value meaning free delivery, which is exactly why the
   * "unset" case had to be NULL and not 0.
   */
  "rate_minor" bigint,
  /* Compare-and-swap, as `marketing_service_areas` does it: a PATCH carries the
   * revision it read and loses to a concurrent edit rather than clobbering it. */
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "shop_delivery_areas_area_key_ck"
    CHECK ("area_key" <> '' AND "area_key" = btrim("area_key")),
  /* A negative delivery charge is a refund the totals engine never asked for. */
  CONSTRAINT "shop_delivery_areas_rate_minor_ck"
    CHECK ("rate_minor" IS NULL OR "rate_minor" >= 0),
  CONSTRAINT "shop_delivery_areas_revision_ck" CHECK ("revision" >= 1)
);
--> statement-breakpoint
/* One commerce opinion per district, database-enforced. A second row for the
 * same area is a unique violation the repo maps to a conflict, not a state the
 * schema quietly allows and the screen then has to pick a winner from. */
CREATE UNIQUE INDEX "shop_delivery_areas_area_key_uq"
  ON "shop_delivery_areas" ("area_key");
