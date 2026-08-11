-- Bound the input to the generated `search` tsvector.
--
-- THE DEFECT. `to_tsvector` cannot produce a value whose lexeme+position area
-- exceeds MAXSTRPOS = 1 048 575 bytes; past that it raises SQLSTATE 54000
-- (`program_limit_exceeded`). Migration 0000 fed the whole of `content_text`
-- into it with no bound, so a document `shared/validate.ts` calls VALID — well
-- under the 2 MB serialised ceiling of spec §4.6 — could be physically
-- unwritable. Measured on PGlite 18.3: 80 000 distinct terms / 789 KB of text
-- is rejected outright.
--
-- Two things made that worse than a size limit. It is a CLIFF, not a gradient:
-- ordinary English prose survives well past 2 MB because lexemes dedupe (2 MB
-- of an eight-word vocabulary is a 1 572-byte tsvector), so the failure only
-- appears on high lexical diversity — a glossary, an index, an SKU table, a
-- changelog of hashes, a CSV paste, long non-English text. And it is
-- RETROACTIVE: an existing row that grows past the line can no longer be saved
-- at all. The UPDATE is rejected, the row stays readable and becomes
-- permanently unwritable, and spec §8 has no mapping for 54000 — so it would
-- surface as a 500 rather than the 422 §4.6 promises, and a durable `pending`
-- queue would retry it forever.
--
-- THE BOUND, and why it is expressed in BYTES and not characters. `left(text,
-- int)` counts CHARACTERS. `left(content_text, 600000)` therefore bounds
-- nothing for multibyte text: 600 000 CJK characters are 1.4 MB and still
-- raise 54000 (measured). The `CASE` below keys off `octet_length`, so the
-- guarantee holds for every encoding:
--
--   * at or under SEARCH_INPUT_MAX_BYTES the text is indexed whole, so nothing
--     a valid document contains is silently dropped from the index;
--   * above it — reachable only by a row that bypassed the validator (an
--     import, a backfill, manual SQL) — the input is truncated to
--     SEARCH_INPUT_MAX_BYTES/4 characters, which is at most
--     SEARCH_INPUT_MAX_BYTES bytes in UTF-8 whatever the script.
--
-- 500 000 is `MAX_CONTENT_TEXT_BYTES` in `shared/validate.ts`, and the two must
-- stay equal: the validator rejects at exactly the point the database starts
-- truncating, so the API path never reaches the ELSE branch and never reaches
-- 54000. The number has margin — the worst of twelve adversarial shapes
-- measured at 500 000 bytes (2/3/4/5/6/8-character ASCII tokens and 1/2/3
-- character tokens over 2-byte and 3-byte alphabets) produced a 808 580-byte
-- lexeme area, 22.9% under MAXSTRPOS.
--
-- Both `octet_length(text)` and `left(text, int)` are `provolatile = 'i'`
-- (verified against pg_proc), so the column stays `STORED`-eligible.
--
-- `search` is a GENERATED column: every byte of it is derived from other
-- columns in the same row, so dropping and re-adding it recomputes it in full
-- and loses nothing. The GIN index goes with the column and is recreated below.
DROP INDEX IF EXISTS posts_search_idx;
--> statement-breakpoint
ALTER TABLE posts DROP COLUMN search;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(subtitle,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(excerpt,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(category,'')), 'C') ||
    setweight(to_tsvector('english', tags_text(coalesce(tags,'{}'::text[]))), 'C') ||
    setweight(to_tsvector('english',
      CASE WHEN octet_length(coalesce(content_text,'')) <= 500000
           THEN coalesce(content_text,'')
           ELSE left(coalesce(content_text,''), 125000)
      END), 'D')
  ) STORED;
--> statement-breakpoint
CREATE INDEX posts_search_idx ON posts USING GIN (search);
