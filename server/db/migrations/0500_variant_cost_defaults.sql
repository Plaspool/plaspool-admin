-- DEFAULT COST PER ITEM (range 0500-0519) — the owner's rule, stated
-- 2026-08-25: cost defaults to 15% below what the variant sells for. DATA
-- ONLY; no schema change.
--
-- 85% OF THE CURRENT PRICE, rounded to the whole naira (minor units are 100
-- per naira), matching the quick-fill the variant modal offers for new
-- variants. Only variants with a CURRENT price get a figure — a price row
-- with `effective_to IS NULL` is the one the shop is charging today, and the
-- partial unique index from 0100 guarantees at most one per variant. A
-- variant nobody has priced keeps a NULL cost: 85% of nothing is not a
-- number, and the margin hint already explains itself for that case.
--
-- ONLY WHERE cost IS NULL: a cost the owner typed by hand outranks a derived
-- default, always. `updated_at` and CAS revisions are left alone — this is a
-- backfill, not an edit, and nothing about the variant a customer can see has
-- changed (`toStorefrontVariant` strips cost from every public serialiser).
UPDATE shop_variants v
   SET cost_minor = (round(p.amount * 0.85 / 100.0) * 100)::integer
  FROM shop_prices p
 WHERE p.variant_id = v.id
   AND p.effective_to IS NULL
   AND v.cost_minor IS NULL;--> statement-breakpoint
