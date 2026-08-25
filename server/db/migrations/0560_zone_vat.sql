-- NIGERIAN VAT AT 7.5% ON EVERY ZONE (range 0560-0579). DATA ONLY.
--
-- THE OWNER SETTLED THE OPEN QUESTION (2026-08-25): PlaSpool IS registered
-- for Nigerian VAT, so the deliberate 0%-and-no-tax-line placeholder ends
-- here. 750 basis points, labelled "VAT", added ON TOP of listed prices at
-- the freeze — `computeTotals` has always worked that way; what was missing
-- was a rate.
--
-- ONE UPDATE, NO SEED. Migration 0240 already materialised the three
-- Nigerian zones (`zone_abuja`, `zone_lagos`, `zone_rest_of_nigeria`) with
-- their options, so the table is never empty and `loadConfig` has served DB
-- rows — not `DEFAULT_SHIPPING_ZONES` — since that migration ran. An
-- earlier draft of this file carried a seed-if-empty for the fallback case;
-- it was dead by construction and is deliberately absent.
--
-- ONLY ROWS STILL AT THE UNDECIDED 0 move to 750: a zone whose rate an owner
-- has since set to something else deliberately keeps it. `shipping_taxable`
-- is not touched — VAT lands on the goods, not the delivery line, exactly as
-- the zones have declared since 0240; editable per zone in Settings if that
-- call ever changes.
--
-- THE TEST SUITES FEEL THIS ON PURPOSE. Route-level checkout tests freeze
-- against these same seeded rows, so their expected totals gain the same
-- 7.5% line a customer's do — the suite following the store's reality is the
-- point, not collateral damage.
UPDATE shop_shipping_zones
   SET tax_rate_bps = 750,
       tax_label = 'VAT',
       updated_at = (extract(epoch from now()) * 1000)::bigint
 WHERE tax_rate_bps = 0;--> statement-breakpoint
