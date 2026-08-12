-- VARIANT IMAGES, AND A "WHY" ON A PRICE CHANGE.
--
-- HAND-WRITTEN, and in-rule for the same reason `0007_managed_categories.sql`
-- gives at length: `drizzle.config.ts` points drizzle-kit at
-- `server/db/schema.ts` and nothing else, and both tables below are declared in
-- `server/shop/catalog/schema.ts`, which drizzle-kit has never seen. Every 01xx
-- commerce migration is this shape.
--
-- Both statements are ADD COLUMN with no default and no NOT NULL, so neither
-- rewrites a table and neither can fail on existing rows.

-- ---------------------------------------------------------------- variant images
--
-- A COLUMN ON THE VARIANT, not a second `image_ids` array.
--
-- The options on a variant in this store are colours, and a colour is exactly
-- the thing a photograph disambiguates: `shop_products.cover_image_id` can show
-- ONE spool, so a customer choosing between eight PLA colours was choosing from
-- a list of words. One image per variant is the whole feature; an array here
-- would be a gallery per colour, which nothing asks for and which would make the
-- reference walk below quadratic in a way it does not need to be.
--
-- NULLABLE, and it stays nullable: a variant is created from a SKU alone (see
-- `createVariant`) and priced and stocked afterwards, so there is a legitimate
-- window — and for the 28 variants already in production, a permanent state
-- until somebody uploads one.
--
-- NO FOREIGN KEY TO `images`, deliberately, and this is the same call
-- `shop_products.cover_image_id` already made. `images` is the BLOG's table
-- (`server/db/schema.ts`); commerce contract §2 R3 keeps the two halves from
-- constraining each other, and an FK here would let the orphan collector's
-- delete pass fail on a product row rather than simply leaving the bytes alone.
-- Existence is checked at write time by `checkImageRefs`, which is advisory by
-- construction and says so.
--
-- ⚠️  THE REFERENCE WALK MUST LEARN ABOUT THIS COLUMN IN THE SAME CHANGE.
--     `server/repo/images.ts#REFERENCE_SET` decides which images may be DELETED,
--     and an image referenced only from here would be unreferenced by definition
--     and collected after its 24h quarantine — which is precisely the trap
--     HANDOFF §1.10 recorded for product images and that migration-free fix
--     closed. `server/repo/images-product-refs.test.ts` covers both columns.
ALTER TABLE shop_variants ADD COLUMN image_id text;--> statement-breakpoint

-- The delete pass and the public-serving check both scan this column now, and
-- both do it for every image on every run. Partial, because a variant with no
-- image is the majority case today and contributes nothing to either question.
CREATE INDEX shop_variants_image_idx ON shop_variants (image_id)
  WHERE image_id IS NOT NULL;--> statement-breakpoint

-- ------------------------------------------------------------- why a price moved
--
-- `shop_prices` is append-only with `effective_from`/`effective_to`, so the
-- WHAT and the WHEN of every price this store has ever charged are already
-- recorded and always were. The WHY was not, and it is the half a human needs:
-- a row saying 18,500 became 22,000 on a Tuesday is an audit trail nobody can
-- act on, while "distributor raised the reel price" is one somebody can.
--
-- NULLABLE rather than NOT NULL DEFAULT '', because every price already written
-- has no reason and inventing one for them would be a lie in the audit log —
-- and the audit view can then say "no reason recorded" for exactly those rows
-- instead of showing an empty string that looks like a bug.
--
-- Deliberately NOT mirrored onto `shop_inventory`: a stock adjustment has
-- carried a mandatory reason since it was written, and it is already durable —
-- `adjustInventory` writes `{ delta, onHand, reason, actorId }` into
-- `commerce_events` as `catalog.inventory.adjusted`, and nothing in this
-- codebase ever deletes a commerce event. The audit surface reads the two
-- sources side by side rather than copying one into the other.
ALTER TABLE shop_prices ADD COLUMN reason text;
