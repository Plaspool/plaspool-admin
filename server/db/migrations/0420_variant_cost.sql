-- COST PER ITEM, PER VARIANT (range 0420-0439; owner's queue, 2026-08-25).
--
-- HAND-WRITTEN IN FULL — `drizzle.config.ts` declares only `server/db/schema.ts`,
-- so drizzle-kit has never seen `shop_variants`. Declared in
-- `server/shop/catalog/schema.ts`; `schema-parity.test.ts` reconciles the two.
--
-- WHAT THIS IS: what the shop PAYS for one unit, so the admin can see margin
-- beside price. What it is NOT: an input to anything a customer is charged —
-- it never touches a quote, a freeze, or an order total.
--
-- ⚠️  ADMIN-ONLY ON THE WIRE, AND THE MAPPER IS WHAT ENFORCES IT. The storefront
--     routes serve `StorefrontVariant`, and `types.ts` records in capitals that
--     the public product shape is allow-listed by nothing — the next field added
--     joins the public wire silently. Cost is the first field where that would
--     be commercially wrong rather than merely untidy, so `toStorefrontVariant`
--     now STRIPS it and the type is `Omit<VariantWithPrice, 'costMinor'>` —
--     a compile error the day someone widens it back.
--     `routes.test.ts` asserts the absence on the storefront response.
--
-- A COLUMN ON THE VARIANT, NOT AN EFFECTIVE-DATED ROW, for the reason `0400`
-- gives about compare-at: no customer-visible invariant depends on its history.
-- The day the owner wants COGS-over-time for accounting, that is a reporting
-- feature with its own table — not a reason to store today's margin view as
-- history nobody asked for.
--
-- MINOR UNITS, `integer` (contract §10). Currency implied by the price row's,
-- as `0400` explains. NULLABLE — "never told the system what this costs" is a
-- true state for every variant that exists today, and the margin column in the
-- admin renders it as unknown rather than as a lie of 100%.
ALTER TABLE shop_variants
  ADD COLUMN cost_minor integer;--> statement-breakpoint
ALTER TABLE shop_variants
  ADD CONSTRAINT shop_variants_cost_ck CHECK (
    cost_minor IS NULL OR cost_minor >= 0
  );--> statement-breakpoint

-- NO INDEX, as 0400: read only as part of a row already fetched by product.
