-- SHIPPING WEIGHT, SEPARATE FROM THE WEIGHT THE SHOP DISPLAYS
-- (range 1180-1199; owner's queue, 2026-09-12).
--
-- HAND-WRITTEN IN FULL — `drizzle.config.ts` declares only `server/db/schema.ts`,
-- so drizzle-kit has never seen shop_variants. Declared in
-- `server/shop/catalog/schema.ts`; `schema-parity.test.ts` reconciles the two.
--
-- WHAT THIS FIXES: weight_grams was doing two jobs that had stopped agreeing.
-- It is the spool size a shopper reads on the storefront — 1250 g of filament —
-- AND it was the only number a courier was ever told. Printing an honest spool
-- size and quoting an honest parcel were therefore the same edit, and the owner
-- could not have both.
--
-- weight_grams KEEPS ITS MEANING and stays the displayed one, so the storefront
-- contract does not move and no existing row changes behaviour. This column is
-- the OVERRIDE: set it and delivery is priced on it, clear it and delivery
-- rejoins the displayed weight. The same "a derived default everywhere,
-- overridable anywhere" pairing 0860 made for the dollar price.
--
-- NULL MEANS DERIVE IT, never "weightless". The resolution is COALESCE, and it
-- happens in SQL at the two reads that feed a courier — `catalog/port.ts`'s
-- quote (checkout rates) and `catalog/logistics-port.ts`'s weightsFor (booking
-- a real parcel) — so nothing downstream of the catalog seam ever learns there
-- are two numbers to choose between. A parcel booked as weightless is a parcel
-- the courier reprices on the doorstep, which is why neither read substitutes
-- zero.
--
-- WHAT IT EXCLUDES: the outer box. `shop_delivery_settings.packaging_weight_kg`
-- is already added on top of the basket before a courier is asked, so this is
-- the item as it ships and counting the packaging again here would pay for it
-- twice.
--
-- NO BACKFILL, on purpose. Every variant resolves to its displayed weight on
-- the day this lands, which is exactly today's behaviour; a backfill would
-- write 796 rows that say nothing and then drift the moment a weight is edited.
ALTER TABLE shop_variants
  ADD COLUMN shipping_weight_grams integer;--> statement-breakpoint
ALTER TABLE shop_variants
  ADD CONSTRAINT shop_variants_shipping_weight_ck CHECK (
    shipping_weight_grams IS NULL OR shipping_weight_grams >= 0
  );--> statement-breakpoint

-- NO INDEX, as 0420: read only as part of a row already fetched by variant id.
