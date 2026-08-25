-- DEFAULT SEO COPY (range 0520-0539) — the owner's instruction, 2026-08-25:
-- fill the empty SEO columns with what the storefront already renders as its
-- fallback. DATA ONLY; no schema change.
--
-- THE VALUES DELIBERATELY REPRODUCE THE STOREFRONT'S FALLBACKS, byte for
-- byte, so publishing them changes nothing a crawler sees today:
--
--   * title: `${product.name} — PlaSpool` (product-page.tsx).
--   * description: `deriveSummary(...)` (packages/shop/src/data/api.ts) — the
--     first top-level `paragraph` OR `blockquote` node with non-empty text
--     (docToBlocks folds blockquotes into paragraph blocks), its text nodes
--     concatenated in document order with no separators (`textOf`), trimmed;
--     over 160 characters it is cut at the last space past index 80 — or hard
--     at 160 when the last space sits at 80 or earlier, WHICH IS ALSO WHERE A
--     SPACELESS CUT LANDS (JS `lastIndexOf` answers -1, `-1 > 80` is false) —
--     right-trimmed, then '…'.
--
-- The known divergence is character COUNTING: SQL counts characters where JS
-- counts UTF-16 code units, so a first paragraph carrying astral-plane
-- characters (emoji) inside its first 160 could truncate one unit differently.
-- Accepted: this is filament prose, and the parity check run after applying
-- compares the real rows.
--
-- ONLY WHERE the column is NULL, so copy the owner has since written by hand
-- outranks the default; NULL (not '') stays NULL when a product has no prose,
-- because 0440 normalises '' to NULL at the write boundary and this file must
-- not reintroduce the value that rule exists to keep out. Revisions and
-- `updated_at` are left alone — a backfill is not an edit — and the 0100
-- lifecycle trigger sees none of its three columns move, so generations hold.
UPDATE shop_products
   SET seo_title = title || ' — PlaSpool'
 WHERE seo_title IS NULL
   AND btrim(title) <> '';--> statement-breakpoint

WITH summary AS (
  SELECT DISTINCT ON (p.id)
         p.id AS product_id,
         btrim(t.joined) AS para
    FROM shop_products p
   CROSS JOIN LATERAL jsonb_array_elements(p.description -> 'content')
     WITH ORDINALITY AS e(node, ord)
   CROSS JOIN LATERAL (
     SELECT coalesce(string_agg(q.v #>> '{}', '' ORDER BY q.o), '') AS joined
       FROM jsonb_path_query(e.node, '$.**.text ? (@.type() == "string")')
         WITH ORDINALITY AS q(v, o)
   ) t
   WHERE p.seo_description IS NULL
     AND e.node ->> 'type' IN ('paragraph', 'blockquote')
     AND btrim(t.joined) <> ''
   ORDER BY p.id, e.ord
)
UPDATE shop_products p
   SET seo_description = CASE
         WHEN char_length(s.para) <= 160 THEN s.para
         ELSE rtrim(left(left(s.para, 160),
                CASE WHEN 160 - position(' ' IN reverse(left(s.para, 160))) > 80
                     THEN 160 - position(' ' IN reverse(left(s.para, 160)))
                     ELSE 160 END)) || '…'
       END
  FROM summary s
 WHERE p.id = s.product_id;--> statement-breakpoint
