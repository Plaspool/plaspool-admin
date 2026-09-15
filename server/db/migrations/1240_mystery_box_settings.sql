-- THE MYSTERY BOX MOVES INTO SETTINGS (range 1240-1259; owner's decisions
-- 2026-09-15, memory "mystery-box-lives-in-settings").
--
-- HAND-WRITTEN IN FULL. drizzle-kit has never seen these tables; they are
-- declared in server/shop/boxes/schema.ts and server/db/commerce-schema.ts.
--
-- WHAT CHANGED FROM 1220: the pool was a TAG named on each variant. The owner
-- wants ONE mystery box set up in Settings: a switch, the product it is sold as,
-- and an explicit tick list of which variants of which products can go inside,
-- plus a backup list. All three modes work now, not only "I pack it myself".
-- shop_variants.box_pool_tag is left in place and no longer read.

-- ONE ROW, id 'main'. The switch, the product it is sold as, how contents get
-- decided, and what happens when a paid box cannot be filled. updated_by is the
-- owner who saved it last; an automatic refund is recorded against them, because
-- they are the person who chose "cancel and refund".
CREATE TABLE shop_mystery_box_settings (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  product_id text,
  mode text NOT NULL DEFAULT 'pack',
  shortfall text NOT NULL DEFAULT 'hold',
  updated_by uuid,
  updated_at bigint NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  CONSTRAINT shop_mystery_box_settings_one_ck CHECK (id = 'main'),
  CONSTRAINT shop_mystery_box_settings_mode_ck CHECK (mode IN ('pack', 'built', 'auto')),
  CONSTRAINT shop_mystery_box_settings_shortfall_ck CHECK (shortfall IN ('hold', 'backup', 'cancel_refund')),
  CONSTRAINT shop_mystery_box_settings_revision_ck CHECK (revision > 0)
);--> statement-breakpoint
INSERT INTO shop_mystery_box_settings (id, updated_at) VALUES ('main', 0)
  ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- THE TICK LISTS. A variant is on the main list, the backup list, or neither.
-- variant_id is not a foreign key, per contract section 2 R3.
CREATE TABLE shop_mystery_box_items (
  variant_id text NOT NULL,
  list text NOT NULL,
  CONSTRAINT shop_mystery_box_items_pk PRIMARY KEY (variant_id, list),
  CONSTRAINT shop_mystery_box_items_list_ck CHECK (list IN ('main', 'backup'))
);--> statement-breakpoint

-- A size no longer needs a pool tag to have an item count.
ALTER TABLE shop_variants DROP CONSTRAINT shop_variants_box_pair_ck;--> statement-breakpoint

-- BUILT BOXES ARE FILLS THAT HAVE NO ORDER YET. "I build boxes ahead" packs a
-- box against a SIZE (box_variant_id) before anyone buys it; a sale then gives
-- the next ready box an order line and a box number. Reusing shop_box_fills keeps
-- the items, the parcel tie and the customer reveal exactly as they are.
ALTER TABLE shop_box_fills
  ALTER COLUMN order_line_id DROP NOT NULL,
  ALTER COLUMN box_no DROP NOT NULL,
  ADD COLUMN box_variant_id text,
  ADD COLUMN built_state text;--> statement-breakpoint
ALTER TABLE shop_box_fills
  ADD CONSTRAINT shop_box_fills_built_state_ck CHECK (
    built_state IS NULL OR built_state IN ('ready', 'assigned', 'broken_up')
  );--> statement-breakpoint
ALTER TABLE shop_box_fills
  ADD CONSTRAINT shop_box_fills_placed_ck CHECK (
    (order_line_id IS NULL) = (box_no IS NULL)
    AND (order_line_id IS NOT NULL OR built_state IN ('ready', 'broken_up'))
  );--> statement-breakpoint
CREATE INDEX shop_box_fills_ready_idx ON shop_box_fills (box_variant_id)
  WHERE built_state = 'ready';--> statement-breakpoint

-- WHEN THE SHOP COULD NOT FILL A PAID ORDER'S BOX BY ITSELF, and the box's
-- setting is to keep the order and tell staff. Staff only; the customer view
-- never carries it.
ALTER TABLE shop_orders
  ADD COLUMN box_short_at bigint;
