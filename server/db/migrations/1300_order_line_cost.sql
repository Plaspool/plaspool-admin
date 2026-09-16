-- WHAT EACH SOLD ITEM COST US, KEPT ON THE ORDER LINE (range 1300-1319).
--
-- Hand-written, like every commerce migration: drizzle-kit has never seen
-- shop_order_lines.
--
-- WHY A SNAPSHOT AND NOT A JOIN. Profit analytics could read
-- shop_variants.cost_minor at report time, but that column is edited freely and
-- keeps no history. The first time the owner corrects a cost, every past sale
-- would silently be re-costed, and last month's profit would change with no
-- record that it ever said anything else. This is the rule 0160 and 0340 state
-- for title, price and photograph: an order line is a snapshot.
--
-- NULLABLE, PERMANENTLY. Orders placed before this migration have no snapshot,
-- and a variant with no cost recorded has nothing to snapshot. The analytics
-- read falls back to the variant's cost TODAY for those lines and says so, rather
-- than backfilling a value that would look like history and is not one (and the
-- 0160 immutability trigger refuses an UPDATE here anyway).
--
-- NO INDEX: read only as part of rows already selected by order.
ALTER TABLE shop_order_lines
  ADD COLUMN unit_cost_minor integer;--> statement-breakpoint

ALTER TABLE shop_order_lines
  ADD CONSTRAINT shop_order_lines_unit_cost_ck
  CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0);
