-- CASE-FOLDED VOCABULARY, AND A COLOUR CODE ON THE VARIANT.
--
-- HAND-WRITTEN, and in-rule for the reason `0009_variant_images_and_reasons.sql`
-- gives: every table below is declared in `server/shop/catalog/schema.ts`, which
-- drizzle-kit has never seen, so `generate` cannot produce this file.
--
-- WHAT THIS FIXES. `shop_products.category`, `tags` and `shop_variants.
-- option_values` are free text with no managed list behind them, and the
-- catalogue on 2026-08-12 proves what that produces: `PLA`, `pla`, `Pla` and
-- `pLA` as four tags, and `Colour Black` / `Colour black` as two variants of one
-- product. Reads now fold case (`lower(category) = lower($1)` in query.ts, folded
-- grouping in admin/categories.ts) and writes adopt the stored spelling — but the
-- rows written before today have to be MERGED, which only a migration can do.
--
-- EVERY STATEMENT HERE IS REPLAY-SAFE, AND THAT IS A PROPERTY, NOT A COURTESY.
-- The neon-http migrator runs each statement individually over HTTP with no
-- transaction and records the ledger row only after the whole batch — so a
-- mid-file failure leaves earlier statements committed with no ledger entry, and
-- the next `db:migrate` replays this file from statement one. A plain ADD COLUMN
-- dies on replay with 42701 and wedges the ledger (the healing machinery in
-- `migrate.ts` exists because that has already happened once). Hence
-- IF NOT EXISTS on the DDL, and data rewrites that are fixpoints: running any of
-- them a second time changes zero rows. `case-fold-migration.test.ts` executes
-- this file twice over a seeded mess and asserts both properties.

-- ------------------------------------------------------------- the colour code
--
-- A COLUMN ON THE VARIANT, NOT A KEY INSIDE `option_values`. The option tuple is
-- the variant's IDENTITY — it feeds SKU derivation (`sku.ts`) and the option
-- summary every screen renders — and a `#8b5a2b` inside it would leak into both.
-- A variant has at most one colour, so one nullable column is the honest shape,
-- and the storefront can read it later to draw swatches.
--
-- LOWERCASE-ONLY BY CHECK, and the repository lowercases before INSERT: two
-- spellings of one colour code would be the same defect this whole migration
-- exists to clean up, one column over.
--
-- Single statement so replay is a clean no-op: when the column already exists,
-- the constraint clause never runs again and cannot duplicate the check.
ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS color_hex text
  CONSTRAINT shop_variants_color_hex_ck
  CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9a-f]{6}$');--> statement-breakpoint

-- The folded category filter's index. `shop_products_category_idx` (0100) serves
-- the old exact match; `lower(category)` is what `listProducts` compares now.
CREATE INDEX IF NOT EXISTS shop_products_category_fold_idx
  ON shop_products (lower(category));--> statement-breakpoint

-- ------------------------------------------------------------------ categories
--
-- One canonical spelling per fold-group: the one on the most products, ties to
-- the spelling on the most recently updated product, then alphabetical — so the
-- pick is deterministic and re-running changes nothing.
WITH spellings AS (
  SELECT category AS value,
         lower(category) AS folded,
         count(*) AS cnt,
         max(updated_at) AS latest
    FROM shop_products
   WHERE category <> ''
   GROUP BY category
), canon AS (
  SELECT folded,
         (array_agg(value ORDER BY cnt DESC, latest DESC, value ASC))[1] AS value
    FROM spellings
   GROUP BY folded
)
UPDATE shop_products p
   SET category = canon.value
  FROM canon
 WHERE lower(p.category) = canon.folded
   AND p.category <> canon.value;--> statement-breakpoint

-- ------------------------------------------------------------------------ tags
--
-- Canonical spelling per folded tag across the WHOLE catalogue (most common,
-- ties alphabetical), then every array rewritten element-by-element: mapped to
-- canon, case-duplicates collapsed, FIRST-OCCURRENCE ORDER KEPT — a tag list is
-- author-ordered and a rewrite that alphabetised it would be a second surprise.
-- `updated_at` is left alone on every rewrite in this file: no human touched
-- these rows, and pretending one did would reorder every "recently updated" list.
WITH spellings AS (
  SELECT tag AS value, lower(tag) AS folded, count(*) AS cnt
    FROM shop_products, unnest(tags) AS tag
   GROUP BY tag
), canon AS (
  SELECT folded, (array_agg(value ORDER BY cnt DESC, value ASC))[1] AS value
    FROM spellings
   GROUP BY folded
), rewritten AS (
  SELECT p.id,
         (SELECT coalesce(array_agg(m.mapped ORDER BY m.first_ord), '{}'::text[])
            FROM (SELECT min(u.ord) AS first_ord, canon.value AS mapped
                    FROM unnest(p.tags) WITH ORDINALITY AS u(tag, ord)
                    JOIN canon ON canon.folded = lower(u.tag)
                   GROUP BY canon.value) m) AS tags
    FROM shop_products p
   WHERE array_length(p.tags, 1) IS NOT NULL
)
UPDATE shop_products p
   SET tags = r.tags
  FROM rewritten r
 WHERE p.id = r.id
   AND p.tags IS DISTINCT FROM r.tags;--> statement-breakpoint

-- -------------------------------------------------------------- variant options
--
-- Keys and values canonicalised PER PRODUCT ("Colour" is this product's axis
-- vocabulary, not the shop's), by the same most-common-then-alphabetical rule.
--
-- THIS MUST RUN BEFORE THE MERGE BELOW, and the ordering is load-bearing:
-- jsonb::text sorts keys by length then bytes, so `{"Ba":…}` and `{"ba":…}` can
-- serialise same-length keys in different orders and `lower(::text)` is only a
-- reliable fold-identity once key spellings are uniform. Measured on PGlite.
--
-- Known freak case, accepted: a tuple carrying BOTH `Colour` and `colour` keys
-- collapses to one axis (`jsonb_object_agg` keeps the last). Nothing the app
-- ever wrote can produce that row.
WITH pairs AS (
  SELECT v.id AS variant_id, v.product_id, kv.key, kv.value
    FROM shop_variants v, jsonb_each_text(v.option_values) AS kv
), key_canon AS (
  SELECT product_id, folded,
         (array_agg(key ORDER BY cnt DESC, key ASC))[1] AS key
    FROM (SELECT product_id, key, lower(key) AS folded, count(*) AS cnt
            FROM pairs GROUP BY product_id, key) s
   GROUP BY product_id, folded
), value_canon AS (
  SELECT product_id, folded_key, folded_value,
         (array_agg(value ORDER BY cnt DESC, value ASC))[1] AS value
    FROM (SELECT product_id, lower(key) AS folded_key, lower(value) AS folded_value,
                 value, count(*) AS cnt
            FROM pairs GROUP BY product_id, lower(key), lower(value), value) s
   GROUP BY product_id, folded_key, folded_value
), rebuilt AS (
  SELECT p.variant_id, jsonb_object_agg(kc.key, vc.value) AS option_values
    FROM pairs p
    JOIN key_canon kc ON kc.product_id = p.product_id AND kc.folded = lower(p.key)
    JOIN value_canon vc ON vc.product_id = p.product_id
                       AND vc.folded_key = lower(p.key)
                       AND vc.folded_value = lower(p.value)
   GROUP BY p.variant_id
)
UPDATE shop_variants v
   SET option_values = r.option_values
  FROM rebuilt r
 WHERE v.id = r.variant_id
   AND v.option_values IS DISTINCT FROM r.option_values;--> statement-breakpoint

-- ------------------------------------------------------ duplicate-variant merge
--
-- Within a product, variants that are the same combination up to case keep ONE
-- winner — a current price beats stock beats oldest beats smallest id — and the
-- losers are DELETED only when provably untouched. Every guard below names a
-- table that references variant ids (searched exhaustively; fulfilment lines
-- reference order lines, not variants, and payments reference nothing here):
--
--   - no price row EVER (not just no current one — a closed price is history);
--   - inventory zero on both counts (a row is created with every variant, so
--     "no row" is the theoretical arm);
--   - no holds, no cart lines, no reservations, no order lines;
--   - no `catalog.inventory.adjusted` events: a variant adjusted up and back to
--     zero carries a human audit trail, and deleting it would leave that trail
--     pointing at nothing. NOT all event types — publish events exist for every
--     variant of any product that was ever published and would block all merging;
--   - no photograph: `image_id` is unioned into the orphan collector's
--     REFERENCE_SET, and deleting the only referrer frees bytes somebody chose.
--
-- `'{}'::jsonb` IS EXEMPT: several option-less variants per product is a
-- supported shape (the suites create them), not a case-collision.
--
-- Losers that fail a guard STAY, on purpose. They really are two variants as far
-- as orders and history are concerned, and the create-time duplicate check stops
-- the mess growing. `shop_inventory` rows follow their variant by CASCADE.
WITH scored AS (
  SELECT v.id, v.product_id, v.created_at,
         lower(v.option_values::text) AS folded,
         EXISTS (SELECT 1 FROM shop_prices pr
                  WHERE pr.variant_id = v.id AND pr.effective_to IS NULL) AS priced,
         coalesce((SELECT i.on_hand + i.reserved FROM shop_inventory i
                    WHERE i.variant_id = v.id), 0) AS units
    FROM shop_variants v
   WHERE v.option_values <> '{}'::jsonb
), ranked AS (
  SELECT id, row_number() OVER (
           PARTITION BY product_id, folded
           ORDER BY priced DESC, (units > 0) DESC, created_at ASC, id ASC) AS rank
    FROM scored
)
DELETE FROM shop_variants v
 USING ranked r
 WHERE v.id = r.id
   AND r.rank > 1
   AND v.image_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM shop_prices pr WHERE pr.variant_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM shop_inventory i
                    WHERE i.variant_id = v.id AND (i.on_hand <> 0 OR i.reserved <> 0))
   AND NOT EXISTS (SELECT 1 FROM shop_inventory_holds h WHERE h.variant_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM shop_cart_lines cl WHERE cl.variant_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM shop_reservations rs WHERE rs.variant_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM shop_order_lines ol WHERE ol.variant_id = v.id)
   AND NOT EXISTS (SELECT 1 FROM commerce_events e
                    WHERE e.subject_id = v.id AND e.type = 'catalog.inventory.adjusted');
