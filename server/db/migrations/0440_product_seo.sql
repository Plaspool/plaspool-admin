-- SEO TITLE AND DESCRIPTION, PER PRODUCT (range 0440-0459; owner's queue,
-- 2026-08-25).
--
-- HAND-WRITTEN IN FULL — `drizzle.config.ts` declares only `server/db/schema.ts`,
-- so drizzle-kit has never seen `shop_products`. Declared in
-- `server/shop/catalog/schema.ts`; `schema-parity.test.ts` reconciles the two.
--
-- ON THE PRODUCT, NOT THE VARIANT: the storefront has one page per product and
-- a <title>/<meta name="description"> pair belongs to the page, not to a colour.
--
-- NULLABLE, AND NULL MEANS "USE THE DEFAULTS". The storefront falls back to the
-- product title and a trimmed description text when these are absent, so an
-- empty pair costs nothing — which is why there is no backfill: every existing
-- product genuinely has no hand-written SEO copy, and inventing some would put
-- words in the owner's mouth on every search result. `''` is normalised to NULL
-- at the write boundary (`products.ts`), the same decision `cover_image_id`
-- made about empty strings that provably mean nothing.
--
-- NO LENGTH CHECK IN THE SCHEMA, matching `title`. `shop_products` feeds no
-- generated tsvector (the 54000 cliff that forced byte ceilings on `posts` does
-- not exist here), so the bound lives where the caller can be told which field
-- to fix: the route's Zod caps these at 300/500 characters with a 400 naming
-- the field, and the UI shows the 70/160 guidance Google actually renders.
--
-- KNOWN AND ACCEPTED: `shop_product_revisions` does not capture these columns,
-- exactly as it does not capture `tags`, `category` or the images — the
-- revision table is the CAS's document history (title/description/status), not
-- a full row snapshot. An SEO edit still bumps `revision` through the ordinary
-- save path, so concurrent edits still conflict honestly.
ALTER TABLE shop_products
  ADD COLUMN seo_title text;--> statement-breakpoint
ALTER TABLE shop_products
  ADD COLUMN seo_description text;--> statement-breakpoint

-- NO INDEX. Read only on rows already fetched by id or slug; nothing searches
-- over SEO copy.
