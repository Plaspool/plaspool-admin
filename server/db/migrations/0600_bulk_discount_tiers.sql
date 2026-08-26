-- BULK QUANTITY DISCOUNTS (range 0600-0619; owner's queue, 2026-08-26).
--
-- HAND-WRITTEN IN FULL — see 0580 for why drizzle-kit cannot see these tables.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT AN `adjustments` ROW, WHICH IS THE OBVIOUS PLACE FOR IT.
--
-- `server/shop/cart/totals/compute.ts` applies `adjustments` AFTER tax, says so
-- at length, and says it is a v1 simplification rather than a tax position —
-- discounts were put out of scope precisely so a real engine would not be
-- invented under time pressure. A bulk discount hung there would compute the
-- zone's 7.5% VAT on the UNDISCOUNTED subtotal, so a customer buying ten spools
-- would pay tax on money they did not spend. On an invoice that is not a
-- rounding nit.
--
-- So the discount is applied as a PER-LINE UNIT REDUCTION, before the per-line
-- tax step, and it reduces the taxable base correctly.
--
-- That is safe SPECIFICALLY BECAUSE THIS DISCOUNT IS QUANTITY-BASED. The
-- allocation-remainder hazard `compute.ts` warns about belongs to CART-LEVEL
-- discounts, which must be spread across lines that may be taxed differently. A
-- per-product quantity tier is already per-line: there is nothing to allocate.
-- A future cart-wide coupon does NOT get to reuse this path.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ON BY DEFAULT, AND `NOT NULL DEFAULT true` RATHER THAN NULLABLE. The owner
-- asked for "if null it is true". A nullable boolean whose NULL means true is a
-- landmine: every read across ninety data-access modules has to remember
-- `COALESCE(bulk_discount_enabled, true)`, and the first one that forgets
-- silently sells at full price forever while every test passes. The default does
-- the same job in one place that cannot be forgotten.
ALTER TABLE shop_products
  ADD COLUMN bulk_discount_enabled boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- THE LADDER. One table holds both scopes and `product_id` discriminates:
-- NULL is the STORE-WIDE default every product inherits, non-NULL overrides one
-- product.
--
-- OVERRIDE IS FULL REPLACEMENT, NOT MERGE, and the resolver enforces it: if a
-- product owns any row, its ladder is exactly its own rows. Merging an override
-- into the default produces a combined table nobody can predict from reading
-- either input, and "delete the 10+ tier for this product" becomes unexpressible.
--
-- `percent_bps` IN BASIS POINTS, matching `tax.rateBps` and every other rate in
-- the commerce schema — 10 000 is 100%, so 1000 is 10%. Integer, because a rate
-- stored as a float is a rate that eventually renders as 9.999999%.
CREATE TABLE shop_bulk_tiers (
	"id" text PRIMARY KEY NOT NULL,
	-- NULL = the store-wide default ladder.
	"product_id" text,
	"min_qty" integer NOT NULL,
	"percent_bps" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	-- A tier at qty 1 is not a bulk discount, it is a price change, and it
	-- belongs in `shop_prices` where the price history lives.
	CONSTRAINT "shop_bulk_tiers_min_qty_ck" CHECK ("min_qty" >= 2),
	-- Upper bound is a guard against a mistyped 9000 selling at 10% of list, not
	-- a policy. 50% is far past anything this shop would offer.
	CONSTRAINT "shop_bulk_tiers_percent_ck"
		CHECK ("percent_bps" > 0 AND "percent_bps" <= 5000),
	CONSTRAINT "shop_bulk_tiers_product_id_fk" FOREIGN KEY ("product_id")
		REFERENCES shop_products("id") ON DELETE CASCADE
);--> statement-breakpoint

-- COALESCE, AND IT IS LOAD-BEARING. Postgres treats NULLs as DISTINCT in a
-- UNIQUE index, so a bare UNIQUE("product_id","min_qty") would permit twenty
-- store-wide ladders all claiming qty 5 — the one scope this index exists to
-- make singular. `''` is safe as the sentinel because `shop_products.id` is a
-- generated `prd_…` and can never be empty.
CREATE UNIQUE INDEX "shop_bulk_tiers_scope_qty_idx"
	ON shop_bulk_tiers (COALESCE("product_id", ''), "min_qty");--> statement-breakpoint

-- Resolution reads every tier for one product plus every global tier, so the
-- lookup is by scope and the unique index above already serves it. This index
-- serves the cascade delete and the per-product editor.
CREATE INDEX "shop_bulk_tiers_product_idx"
	ON shop_bulk_tiers ("product_id");--> statement-breakpoint

-- THE SEEDED DEFAULT LADDER — 5% at three, 10% at five, 15% at ten.
--
-- Chosen for a shop selling ~₦20 000-23 500 filament spools: a consumable people
-- genuinely buy in multiples, where three is a normal reorder and ten is a small
-- workshop's month. The ladder is legible to a customer without a calculator,
-- and 15% at ten units is ordinary for consumables.
--
-- IDS ARE STABLE LITERALS, not generated, so re-running this migration against a
-- database that already has them is a no-op rather than a second ladder. The
-- `ON CONFLICT DO NOTHING` says the same thing to the unique index above.
--
-- `1787788800000` is 2026-08-26T00:00:00Z. A literal and not `now()`: these rows
-- must be byte-identical everywhere this migration is applied, and every
-- timestamp in this schema is epoch-ms `bigint`, never `timestamptz`.
INSERT INTO shop_bulk_tiers
	("id", "product_id", "min_qty", "percent_bps", "created_at", "updated_at")
VALUES
	('blk_default_0003', NULL, 3, 500, 1787788800000, 1787788800000),
	('blk_default_0005', NULL, 5, 1000, 1787788800000, 1787788800000),
	('blk_default_0010', NULL, 10, 1500, 1787788800000, 1787788800000)
ON CONFLICT DO NOTHING;
