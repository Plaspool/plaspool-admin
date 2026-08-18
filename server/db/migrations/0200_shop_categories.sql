-- MANAGED SHOP CATEGORIES (storefront live-data bundle, range 0200-0219).
--
-- HAND-WRITTEN IN FULL, for the two reasons every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen `server/shop/catalog/categories-schema.ts` and can neither generate
-- these statements nor emit DDL to undo them; and the 0200-0219 range is
-- allocated, while `generate` numbers sequentially from the journal.
-- `0200_snapshot` deliberately does not exist. The DDL is asserted to be APPLIED
-- -- not merely present in this file -- by
-- `server/shop/catalog/categories-schema.test.ts`, which reads it back out of the
-- catalog on a migrated database.
--
-- WHAT THIS TABLE IS NOT. It is not where a product's category is stored.
-- `shop_products.category` stays exactly as it is -- denormalised `text`, `''`
-- meaning uncategorised -- and there is deliberately NO FOREIGN KEY to here.
-- `0007_managed_categories.sql` sets out the argument in full for the blog and
-- every word of it holds here: this is a MANAGED LIST THAT NAMES VALUES, not the
-- authority for which values may exist. An FK would make every free-text category
-- typed before this migration unstorable, and would turn a delete refusal the
-- route can explain into a raw 23503 it cannot.
--
-- WHY IT EXISTS AT ALL, WHEN THE BLOG'S EQUIVALENT DID NOT NEED SLUGS. The
-- storefront routes on `/store/<slug>` and renders a blurb and an accent colour
-- per category. Those three values have nowhere to live in a derived list, so
-- deriving categories from `shop_products.category` alone left them hardcoded in
-- the storefront -- which is the thing Plaspool/plaspool-storefront#2 exists to
-- end.

CREATE TABLE "shop_categories" (
  "id" text PRIMARY KEY NOT NULL,
  /*
   * THE URL, AND THEREFORE SERVER-AUTHORITATIVE AND NOT DERIVED ON READ.
   *
   * `ProductPatch` has no `slug` key and states the rule this follows: "a
   * published URL is a promise, not a value that follows the heading around".
   * A slug recomputed from `name` on every read would mean renaming "ABS" to
   * "ABS & ASA" silently moved `/store/abs` to `/store/abs-asa` and 404'd every
   * link anyone had shared. It is set once at creation and only ever changed
   * deliberately.
   *
   * The shape check is the same alphabet `slugify` (`shared/doc.ts`) emits, so a
   * value this column accepts is a value that round-trips through it unchanged.
   * No leading, trailing or doubled hyphen.
   */
  "slug" text NOT NULL,
  "name" text NOT NULL,
  /*
   * The line under the heading on `/store/<slug>`, and the page's meta
   * description. `''` is the ordinary state for a category nobody has written
   * copy for yet -- NOT NULL with a default rather than nullable, because the
   * storefront renders it unconditionally and "no blurb" and "empty blurb" are
   * not different things to a reader.
   */
  "blurb" text DEFAULT '' NOT NULL,
  /*
   * The category tile's spool tint. NULL means "no tint chosen" and the
   * storefront falls back -- a real state, and the reason this is not NOT NULL
   * with a default colour: a wrong colour on every new category is worse than
   * an absent one, because it looks deliberate.
   *
   * Lowercase six-digit hex, exactly as `shop_variants.color_hex` (0009/0010) is
   * spelled and checked. Two colour columns in one schema that disagreed about
   * `#FFF` versus `#ffffff` would be a bug generator.
   */
  "accent_hex" text,
  /*
   * Display order for the storefront's category tiles, ascending, ties broken by
   * folded name. Editorial rather than alphabetical: the fixture order this
   * replaces ran PLA, PLA+, PETG, ABS, TPU, Support -- roughly easiest material
   * first -- which no sort over the names produces. Default 0 so every backfilled
   * row sorts alphabetically until somebody arranges them.
   */
  "position" integer DEFAULT 0 NOT NULL,
  /* epoch-ms, never `timestamptz` -- the rule `server/db/schema.ts` states. */
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  /*
   * `''` IS NOT A CATEGORY, IT IS THE ABSENCE OF ONE. `shop_products.category =
   * ''` already means uncategorised throughout this codebase -- `listProducts`
   * treats an empty `?category=` as "no filter" rather than as a value to match,
   * and `listShopCategories` excludes it explicitly. A managed row named `''`
   * would be an option that cannot be selected.
   *
   * `name = btrim(name)` is the weaker half of the route's `.trim()` on purpose:
   * JS strips tabs and newlines, `btrim` strips spaces, so this cannot reject
   * anything the route would have accepted, and it still stops ' PLA' and 'PLA'
   * becoming two rows the case-insensitive index below cannot tell apart.
   */
  CONSTRAINT "shop_categories_name_ck" CHECK ("name" <> '' AND "name" = btrim("name")),
  /*
   * `MAX_CATEGORY_BYTES` from `shared/validate.ts`, restated in the database.
   * OCTET_LENGTH and not LENGTH, because the ceiling is bytes; `length()` counts
   * characters and undercounts by up to 4x.
   */
  CONSTRAINT "shop_categories_name_bytes_ck" CHECK (octet_length("name") <= 400),
  CONSTRAINT "shop_categories_slug_ck" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "shop_categories_slug_bytes_ck" CHECK (octet_length("slug") <= 96),
  CONSTRAINT "shop_categories_blurb_bytes_ck" CHECK (octet_length("blurb") <= 600),
  CONSTRAINT "shop_categories_accent_hex_ck"
    CHECK ("accent_hex" IS NULL OR "accent_hex" ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT "shop_categories_position_ck" CHECK ("position" >= 0)
);
--> statement-breakpoint
/*
 * UNIQUE, CASE-INSENSITIVELY, AND AS A FUNCTIONAL INDEX BECAUSE THERE IS NO
 * OTHER WAY TO SAY IT -- the argument `0007_managed_categories.sql` makes for
 * `categories_name_lower_uq`, unchanged.
 *
 * A plain `UNIQUE (name)` would let 'PLA' and 'pla' both exist, which is the
 * free-text era's defect with a table around it: two entries in every picker,
 * two counts, and a rename that fixes one of them. Postgres has no
 * case-insensitive text type in core, so the constraint is an index over
 * `lower(name)`.
 *
 * It is therefore an object drizzle-kit cannot express and lives ONLY in this
 * file. The whole surface is built on `lower(name)`: the union joins on it, the
 * rename moves products on it, and the delete counts on it.
 */
CREATE UNIQUE INDEX "shop_categories_name_lower_uq" ON "shop_categories" (lower("name"));
--> statement-breakpoint
/* The slug is a URL, so its uniqueness is exact rather than folded -- the check
 * constraint above already confines it to lowercase, which makes the two the
 * same set without making the index depend on that being true. */
CREATE UNIQUE INDEX "shop_categories_slug_uq" ON "shop_categories" ("slug");
--> statement-breakpoint
/* The storefront's tile order, and the admin list's. */
CREATE INDEX "shop_categories_position_idx"
  ON "shop_categories" ("position", lower("name"));
--> statement-breakpoint
/*
 * ------------------------------------------------------------------ backfill
 *
 * Every category already in use becomes a managed row, so this migration does not
 * empty every picker on the day it ships. Without it the union in
 * `listShopCategories` would still report the in-use values (`id: null`), but the
 * storefront's `/store/<slug>` has no slug for them and would have nothing to
 * route on.
 *
 * ONE CANONICAL SPELLING PER FOLD-GROUP -- the one on the most products, ties to
 * the most recently updated product's, then alphabetical. That is the identical
 * pick `0010_catalogue_case_fold.sql`, `canonicalCategory` (`catalog/fold.ts`)
 * and `listShopCategories` all make, so a pre-migration straggler and a racing
 * write resolve to the same spelling this table now owns.
 *
 * THE SLUG IS DERIVED IN SQL AND MUST AGREE WITH `slugify` IN `shared/doc.ts`,
 * which is the function every slug written after this migration goes through.
 * The alphabet is the same (`[^a-z0-9]+` collapses to a single hyphen, ends
 * trimmed); the 72-character cap is applied here too. A name that slugifies to
 * nothing at all -- one made only of punctuation -- falls back to 'category',
 * exactly as `slugify` falls back to 'untitled'.
 *
 * COLLISIONS ARE NUMBERED RATHER THAN REFUSED. 'PLA+' and 'PLA' both reduce to
 * 'pla', and a unique index would fail the whole migration over it. The second
 * and later members of a colliding group take '-2', '-3' by folded name, which
 * is deterministic and is the same shape `uniqueSlug`'s ladder produces.
 *
 * `ON CONFLICT DO NOTHING` so a re-run is a no-op rather than a failure.
 */
INSERT INTO "shop_categories" ("id", "slug", "name", "blurb", "accent_hex", "position", "created_at", "updated_at")
WITH spellings AS (
  SELECT p.category          AS value,
         lower(p.category)   AS folded,
         count(*)            AS cnt,
         max(p.updated_at)   AS latest
    FROM shop_products p
   WHERE p.category <> ''
   GROUP BY p.category
), canonical AS (
  SELECT folded,
         (array_agg(value ORDER BY cnt DESC, latest DESC, value ASC))[1] AS name
    FROM spellings
   GROUP BY folded
), based AS (
  SELECT folded,
         name,
         COALESCE(
           NULLIF(
             btrim(
               regexp_replace(
                 left(lower(translate(name, '''’', '')), 200),
                 '[^a-z0-9]+', '-', 'g'
               ),
               '-'
             ),
             ''
           ),
           'category'
         ) AS base
    FROM canonical
), capped AS (
  SELECT folded, name, COALESCE(NULLIF(btrim(left(base, 72), '-'), ''), 'category') AS base
    FROM based
), numbered AS (
  SELECT folded, name, base,
         row_number() OVER (PARTITION BY base ORDER BY folded ASC) AS n
    FROM capped
)
SELECT 'cat_' || replace(gen_random_uuid()::text, '-', ''),
       CASE WHEN n = 1 THEN base ELSE base || '-' || n END,
       name,
       '',
       NULL,
       0,
       (extract(epoch from now()) * 1000)::bigint,
       (extract(epoch from now()) * 1000)::bigint
  FROM numbered
ON CONFLICT DO NOTHING;
