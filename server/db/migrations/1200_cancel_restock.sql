-- CANCELLING A PAID ORDER PUTS BACK WHAT STAFF CHOOSE, LINE BY LINE
-- (range 1200-1219; owner's decision 2026-09-15).
--
-- HAND-WRITTEN IN FULL. drizzle.config.ts declares only server/db/schema.ts, so
-- drizzle-kit has never seen these tables; they are declared in
-- server/db/commerce-schema.ts and read back by server/shop/orders/schema.test.ts.
--
-- WHAT THIS FIXES: the Cancel dialog said "Cancelling puts the stock back", and
-- nothing did. A paid order's units leave on_hand at capture (commitHold), and
-- the order.cancelled event that could have returned them is ignored by the only
-- consumer that sees it. Measured on master before this: on_hand 8 before a paid
-- cancel, 8 after.
--
-- THE OWNER CHOSE A PER-LINE CHOICE OVER AN AUTOMATIC RESTOCK: a cancelled
-- order's goods are sometimes opened or damaged, and only the person holding
-- them knows. The dialog offers every unit that has not shipped; staff lower
-- the number for anything that cannot be sold again.
--
-- returned_qty IS THE GUARD, NOT A LOG. It is how many of this line have been
-- put back, and the restock statement only succeeds while returned_qty + n stays
-- within the units that never shipped — so a retried or repeated request cannot
-- put the same spool back twice. The stock history itself is the
-- catalog.inventory.adjusted event written in the same statement.
--
-- DEFAULT 0, AND NO BACKFILL: every order on the day this lands has put nothing
-- back, which is exactly what happened to them.
ALTER TABLE shop_order_lines
  ADD COLUMN returned_qty integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE shop_order_lines
  ADD CONSTRAINT shop_order_lines_returned_ck CHECK (
    returned_qty >= 0 AND returned_qty <= qty
  );--> statement-breakpoint

-- WHY THE REST STAYED OUT. Optional (memory: every reason field is optional),
-- blank stored as NULL. STAFF ONLY: shop_orders is spread into the customer's
-- order view, so this column is deliberately NOT mapped onto the Order type and
-- is read by an admin-only query instead.
ALTER TABLE shop_orders
  ADD COLUMN kept_out_reason text;--> statement-breakpoint
