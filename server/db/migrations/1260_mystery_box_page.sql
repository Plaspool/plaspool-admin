-- THE MYSTERY BOX'S PAGE (range 1260-1279; owner's decisions 2026-09-15).
--
-- HAND-WRITTEN IN FULL, like 1240. Declared in server/shop/boxes/schema.ts.
--
-- The owner edits, in Settings, the words and cues the shop shows on the box:
-- the "How it works" steps, and cues such as "Only {count} left", "Just dropped
-- {time}", "{count} bought in the last 24 hours" and the sold-out line, each with
-- its own switch and threshold. One jsonb object, read through readBoxPage in
-- shared/commerce/mystery-box.ts, which fills any missing key with its default;
-- so '{}' means "everything as shipped", and a key added later needs no
-- migration.
--
-- on_sale_since is when the box was last switched on, for "Just dropped". NULL
-- while it is off. A box that is on already counts from its last save.
ALTER TABLE shop_mystery_box_settings
  ADD COLUMN page jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN on_sale_since bigint;--> statement-breakpoint
ALTER TABLE shop_mystery_box_settings
  ADD CONSTRAINT shop_mystery_box_settings_page_ck CHECK (jsonb_typeof(page) = 'object');--> statement-breakpoint
UPDATE shop_mystery_box_settings
   SET on_sale_since = updated_at
 WHERE enabled AND updated_at > 0;
