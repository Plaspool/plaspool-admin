-- COMPARE-AT PRICE, PER VARIANT (range 0400-0419; owner's queue, 2026-08-25).
--
-- HAND-WRITTEN IN FULL, for the reason every migration in this range is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen `shop_variants` and can neither generate nor undo this DDL. The
-- declaration lives in `server/shop/catalog/schema.ts` and
-- `schema-parity.test.ts` reconciles the two against a migrated database.
--
-- A COLUMN ON THE VARIANT, NOT A ROW IN `shop_prices` — and the difference is
-- the entire design. `shop_prices` is effective-dated because a price CHARGES
-- someone: an order line snapshots it, reconciliation asks "what did this cost
-- on Tuesday", and two current rows would charge two customers differently.
-- A compare-at price charges nobody. It is the number the storefront draws a
-- line through — pure merchandising display, never an input to a quote, a
-- freeze, or an order total — so giving it effective-dating would add a second
-- history mechanism to defend an invariant that does not exist. It is a plain
-- last-writer-wins field, exactly as `weight_grams` is. This is also where
-- Shopify keeps it (`compare_at_price` on the variant), which is the comparison
-- the owner chose these fields from.
--
-- NO CURRENCY COLUMN, deliberately. The struck-through figure is only ever
-- rendered beside the variant's CURRENT price and in that price's currency;
-- a compare-at in a currency the price row does not carry is not a state the
-- storefront could draw. The current price row's `currency` governs both.
--
-- MINOR UNITS, `integer`, never numeric and never a float (contract §10) — the
-- same rule `shop_prices.amount` documents at length.
--
-- NULLABLE, AND NULL MEANS "NOT ON SALE". Every variant written before this
-- migration has none, and that is the true state rather than a backfill. Note
-- the storefront's sale rendering is `compare_at_minor > current price`, which
-- it decides at render time — a compare-at at or below the price is stored
-- honestly and simply never draws a badge, the same way a `reserved` above
-- `on_hand` is legal and rendered as backorder.
--
-- ZERO IS PERMITTED (>= 0, not > 0) for the same reason a price of zero is: the
-- check exists to stop a sign error from a backfill or hand-run UPDATE, not to
-- encode display policy in the schema.
ALTER TABLE shop_variants
  ADD COLUMN compare_at_minor integer;--> statement-breakpoint
ALTER TABLE shop_variants
  ADD CONSTRAINT shop_variants_compare_at_ck CHECK (
    compare_at_minor IS NULL OR compare_at_minor >= 0
  );--> statement-breakpoint

-- NO INDEX. Nothing filters or sorts BY compare-at; the column is read only as
-- part of a variant row already being fetched by product. An index here would
-- be written on every variant edit and read never.
