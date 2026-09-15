-- MYSTERY BOXES, PHASE 1 (range 1220-1239; spec 2026-09-15-mystery-boxes-design).
--
-- HAND-WRITTEN IN FULL. drizzle.config.ts declares only server/db/schema.ts, so
-- drizzle-kit has never seen these tables; they are declared in
-- server/shop/boxes/schema.ts and server/shop/catalog/schema.ts and reconciled by
-- schema-parity.test.ts.
--
-- A BOX IS A PRODUCT WITH box_mode SET. NULL means an ordinary product, and every
-- existing row is NULL on the day this lands, so nothing changes behaviour.
-- 'built' and 'auto' are admitted now so phases 2 and 3 need no constraint
-- change; the phase 1 route accepts 'pack' only.
ALTER TABLE shop_products
  ADD COLUMN box_mode text;--> statement-breakpoint
ALTER TABLE shop_products
  ADD CONSTRAINT shop_products_box_mode_ck CHECK (
    box_mode IS NULL OR box_mode IN ('pack', 'built', 'auto')
  );--> statement-breakpoint

-- EACH VARIANT NAMES ITS OWN POOL (a tag) AND HOW MANY ITEMS A BOX HOLDS.
-- Both or neither: a count with no pool, or a pool with no count, describes
-- nothing a person could pack.
ALTER TABLE shop_variants
  ADD COLUMN box_pool_tag text,
  ADD COLUMN box_item_count integer;--> statement-breakpoint
ALTER TABLE shop_variants
  ADD CONSTRAINT shop_variants_box_item_count_ck CHECK (
    box_item_count IS NULL OR box_item_count > 0
  );--> statement-breakpoint
ALTER TABLE shop_variants
  ADD CONSTRAINT shop_variants_box_pair_ck CHECK (
    (box_pool_tag IS NULL) = (box_item_count IS NULL)
  );--> statement-breakpoint

-- ONE ROW PER BOX UNIT ON AN ORDER LINE. qty 2 of a box is box_no 1 and 2.
-- fulfillment_id is set when the box goes into a parcel, which is how the
-- customer reveal knows which parcel's delivery shows which box.
CREATE TABLE shop_box_fills (
  id text PRIMARY KEY,
  order_line_id text NOT NULL REFERENCES shop_order_lines (id) ON DELETE RESTRICT,
  box_no integer NOT NULL,
  source text NOT NULL,
  fulfillment_id text REFERENCES shop_fulfillments (id) ON DELETE RESTRICT,
  filled_by uuid,
  filled_at bigint NOT NULL,
  CONSTRAINT shop_box_fills_box_no_ck CHECK (box_no > 0),
  CONSTRAINT shop_box_fills_source_ck CHECK (source IN ('hand', 'built', 'auto', 'backup')),
  CONSTRAINT shop_box_fills_line_box_uq UNIQUE (order_line_id, box_no)
);--> statement-breakpoint
CREATE INDEX shop_box_fills_fulfillment_idx ON shop_box_fills (fulfillment_id);--> statement-breakpoint

-- WHAT WENT IN. Snapshots of title, product code, options and photograph, for
-- the same reason shop_order_lines keeps them: the product can change after.
-- variant_id is NOT a foreign key, per contract section 2 R3, exactly as
-- shop_order_lines.variant_id is not.
--
-- returned_to_stock_at is set when a cancelled order's box item goes back on
-- the shelf. There is no per-item "why it stayed out": migration 1200 already
-- keeps one reason per cancelled order, on shop_orders.kept_out_reason.
CREATE TABLE shop_box_fill_items (
  id text PRIMARY KEY,
  fill_id text NOT NULL REFERENCES shop_box_fills (id) ON DELETE RESTRICT,
  position integer NOT NULL,
  variant_id text NOT NULL,
  sku text NOT NULL,
  title text NOT NULL,
  option_values jsonb NOT NULL,
  image_id text,
  returned_to_stock_at bigint,
  CONSTRAINT shop_box_fill_items_position_ck CHECK (position >= 0)
);--> statement-breakpoint
CREATE INDEX shop_box_fill_items_fill_idx ON shop_box_fill_items (fill_id);--> statement-breakpoint

-- THE WHOLE-STATEMENT ABORT. A fill takes several variants out of stock in one
-- statement; if any of them is short, every write in that statement must be
-- undone, and plain SQL has no RAISE. Calling this from the final SELECT aborts
-- the statement, which rolls back every data-modifying CTE in it. These are this
-- module's SQLSTATEs, as ORD01-ORD05 are the orders triggers' (0160).
--
-- THE REASON TRAVELS IN THE SQLSTATE, NOT THE MESSAGE, because the application's
-- driver guard scrubs every database message before it reaches a caller (so a
-- bound value can never leak into a log or a response). The code survives:
--   BOX01  box_short    an item ran out before the fill could take it
--   BOX02  box_changed  someone else filled or changed this box first
CREATE OR REPLACE FUNCTION shop_box_abort(reason text) RETURNS boolean
  LANGUAGE plpgsql AS $$
BEGIN
  IF reason = 'box_changed' THEN
    RAISE EXCEPTION '%', reason USING ERRCODE = 'BOX02';
  END IF;
  RAISE EXCEPTION '%', reason USING ERRCODE = 'BOX01';
END
$$;
