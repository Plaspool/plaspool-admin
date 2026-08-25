-- FIX FOR 0520'S DOUBLED DESCRIPTIONS (range 0540-0559). DATA ONLY.
--
-- 0520 extracted paragraph text with LAX jsonpath: `$.**.text`. In lax mode,
-- member access AUTO-UNWRAPS arrays — so `.**` reaching a paragraph's
-- `content` ARRAY yielded every child's text once through the array, and then
-- once more per child object. Every backfilled description came out as the
-- first paragraph CONCATENATED WITH ITSELF ("PLA filament for 3D printingPLA
-- filament for 3D printing"), which the post-apply parity check caught on the
-- live API. STRICT mode does not unwrap; member access on an array or on an
-- object without the member is a structural error, and the `silent => true`
-- argument (4-arg jsonb_path_query) skips those instead of raising — leaving
-- exactly one hit per text node, in document order. Verified against PGlite
-- before this file was written: lax doubles, strict matches `textOf` exactly.
--
-- THE PREDICATE IS SELF-IDENTIFYING: a row is rewritten only when its stored
-- value still EQUALS what the buggy expression produces for that product —
-- recomputed here with the same lax path — so copy an owner has since written
-- by hand can never be clobbered, and re-running the file is a no-op. The
-- truncation CASE is 0520's, inlined twice (once per side) because SQL has no
-- local functions and a CREATE/DROP pair would outlive a mid-file failure.
--
-- 0520 itself is immutable — the ledger hashes its bytes — so the fix is this
-- file, not an edit. Its title clause was correct and is not touched.
WITH firstpara AS (
  SELECT DISTINCT ON (p.id)
         p.id AS product_id,
         btrim(bad.joined)  AS bad_para,
         btrim(good.joined) AS good_para
    FROM shop_products p
   CROSS JOIN LATERAL jsonb_array_elements(p.description -> 'content')
     WITH ORDINALITY AS e(node, ord)
   CROSS JOIN LATERAL (
     SELECT coalesce(string_agg(q.v #>> '{}', '' ORDER BY q.o), '') AS joined
       FROM jsonb_path_query(e.node, '$.**.text ? (@.type() == "string")')
         WITH ORDINALITY AS q(v, o)
   ) bad
   CROSS JOIN LATERAL (
     SELECT coalesce(string_agg(q.v #>> '{}', '' ORDER BY q.o), '') AS joined
       FROM jsonb_path_query(e.node, 'strict $.**.text ? (@.type() == "string")', '{}', true)
         WITH ORDINALITY AS q(v, o)
   ) good
   /* The node pick mirrors 0520: first paragraph/blockquote with non-empty
      text. Lax doubling preserves emptiness, so filtering on the GOOD text
      selects the same node 0520 selected on the bad one. */
   WHERE p.seo_description IS NOT NULL
     AND e.node ->> 'type' IN ('paragraph', 'blockquote')
     AND btrim(good.joined) <> ''
   ORDER BY p.id, e.ord
)
UPDATE shop_products p
   SET seo_description = CASE
         WHEN char_length(f.good_para) <= 160 THEN f.good_para
         ELSE rtrim(left(left(f.good_para, 160),
                CASE WHEN 160 - position(' ' IN reverse(left(f.good_para, 160))) > 80
                     THEN 160 - position(' ' IN reverse(left(f.good_para, 160)))
                     ELSE 160 END)) || '…'
       END
  FROM firstpara f
 WHERE p.id = f.product_id
   AND p.seo_description = CASE
         WHEN char_length(f.bad_para) <= 160 THEN f.bad_para
         ELSE rtrim(left(left(f.bad_para, 160),
                CASE WHEN 160 - position(' ' IN reverse(left(f.bad_para, 160))) > 80
                     THEN 160 - position(' ' IN reverse(left(f.bad_para, 160)))
                     ELSE 160 END)) || '…'
       END;--> statement-breakpoint
