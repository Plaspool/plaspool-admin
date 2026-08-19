-- SHIPPING ZONES, EDITABLE WITHOUT A DEPLOY (range 0240-0259, admin#19).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen these tables and can neither generate nor undo this DDL.
--
-- WHAT THIS REPLACES. `server/shop/cart/checkout/shipping.ts` used to hardcode
-- `DEFAULT_SHIPPING_ZONES` — United Kingdom / Europe / Rest of world, in pence.
-- That constant now exists ONLY as the empty-database fallback; the real config
-- lives here so an operator can correct a rate without a deploy.
--
-- `bigint` epoch-ms timestamps, never `timestamptz` — the rule every table in
-- this database follows (see 0200/0220).
--
-- REGIONS ARE A `text[]` COLUMN, empty meaning "no region restriction" (the
-- zone matches any region within its countries). Application code binding an
-- array must use `sql.param(xs)::text[]` — a bare array bind is `22P02`.
--
-- EXACTLY ONE FALLBACK ZONE, enforced the same way `shop_prices_current_uq`
-- enforces "exactly one current price row": a partial unique index over
-- `is_fallback` where it is true, rather than a boolean column an application
-- has to police.

CREATE TABLE "shop_shipping_zones" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  /* ISO-3166-1 alpha-2, uppercase. */
  "countries" text[] NOT NULL DEFAULT '{}',
  /*
   * Region names (state/province, free text as the address form captures it)
   * that further restrict this zone within a matched country. Empty means "no
   * region restriction". Compared case- and whitespace-insensitively in
   * application code (`zoneFor`, `shipping.ts`).
   */
  "regions" text[] NOT NULL DEFAULT '{}',
  /** Basis points. `2000` is 20%. `0` and absent-tax-line is a real choice, not
   *  a placeholder — see the migration's header note and admin#19's brief. */
  "tax_rate_bps" integer NOT NULL DEFAULT 0,
  "tax_label" text NOT NULL DEFAULT '',
  "shipping_taxable" boolean NOT NULL DEFAULT false,
  /* Exactly one zone may carry this — enforced below by a partial unique
   * index, not by application discipline. It matches every country/region no
   * other zone claims, and `zoneFor` throws if none exists. */
  "is_fallback" boolean NOT NULL DEFAULT false,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "shop_shipping_zones_label_ck" CHECK ("label" <> '' AND "label" = btrim("label")),
  CONSTRAINT "shop_shipping_zones_tax_rate_bps_ck"
    CHECK ("tax_rate_bps" >= 0 AND "tax_rate_bps" <= 10000),
  CONSTRAINT "shop_shipping_zones_position_ck" CHECK ("position" >= 0)
);
--> statement-breakpoint
/* Exactly one fallback zone, database-enforced. A second `is_fallback = true`
 * row is a unique violation the repo maps to a 409, not a state the schema
 * quietly allows. */
CREATE UNIQUE INDEX "shop_shipping_zones_fallback_uq"
  ON "shop_shipping_zones" ("is_fallback") WHERE "is_fallback";
--> statement-breakpoint
CREATE INDEX "shop_shipping_zones_position_idx"
  ON "shop_shipping_zones" ("position", lower("label"));
--> statement-breakpoint

CREATE TABLE "shop_shipping_options" (
  "id" text PRIMARY KEY NOT NULL,
  "zone_id" text NOT NULL REFERENCES "shop_shipping_zones" ("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  /* Minor units, in the store currency. Integer, never negative. */
  "amount_minor" bigint NOT NULL,
  /* Free-text delivery estimate shown to the customer, e.g. "2-4 working
   * days". Not parsed by anything, purely presentational. */
  "estimate" text NOT NULL DEFAULT '',
  "position" integer NOT NULL DEFAULT 0,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "shop_shipping_options_label_ck"
    CHECK ("label" <> '' AND "label" = btrim("label")),
  CONSTRAINT "shop_shipping_options_amount_minor_ck" CHECK ("amount_minor" >= 0),
  CONSTRAINT "shop_shipping_options_position_ck" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE INDEX "shop_shipping_options_zone_idx"
  ON "shop_shipping_options" ("zone_id", "position", lower("label"));
--> statement-breakpoint

/*
 * ------------------------------------------------------------------ seed
 *
 * The owner's answers (admin#19): Abuja ₦3,000, Lagos ₦10,000, everywhere
 * else in Nigeria (the fallback) ₦10,000. 100 minor units per naira, confirmed
 * empirically against a live variant price of `2300000` for a ~₦23,000 spool.
 * Tax is 0bps with an absent tax line, deliberately — this shop's Nigerian VAT
 * registration status is not known, and a visibly absent tax line is the safe
 * wrong (see the brief). No free-over-threshold column: that promise is being
 * retired, not implemented.
 */
INSERT INTO "shop_shipping_zones"
  ("id", "label", "countries", "regions", "tax_rate_bps", "tax_label",
   "shipping_taxable", "is_fallback", "position", "created_at", "updated_at")
VALUES
  ('zone_abuja', 'Abuja', ARRAY['NG'], ARRAY['Abuja', 'FCT', 'Federal Capital Territory'],
   0, 'No tax charged', false, false, 0,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  ('zone_lagos', 'Lagos', ARRAY['NG'], ARRAY['Lagos'],
   0, 'No tax charged', false, false, 1,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  -- Empty `countries`: this is the FALLBACK zone, and `zoneFor` (shipping.ts)
  -- consults it for any country/region no other zone claims, matching the
  -- original UK config's `international` zone (`countries: []` meant the
  -- same thing there).
  ('zone_rest_of_nigeria', 'Rest of Nigeria', ARRAY[]::text[], ARRAY[]::text[],
   0, 'No tax charged', false, true, 2,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "shop_shipping_options"
  ("id", "zone_id", "label", "amount_minor", "estimate", "position", "created_at", "updated_at")
VALUES
  ('ship_abuja_standard', 'zone_abuja', 'Standard delivery', 300000, '', 0,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  ('ship_lagos_standard', 'zone_lagos', 'Standard delivery', 1000000, '', 0,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint),
  ('ship_rest_of_nigeria_standard', 'zone_rest_of_nigeria', 'Standard delivery', 1000000, '', 0,
   (extract(epoch from now()) * 1000)::bigint, (extract(epoch from now()) * 1000)::bigint)
ON CONFLICT DO NOTHING;
