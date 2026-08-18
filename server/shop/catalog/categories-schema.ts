/**
 * Managed shop categories — the schema (migration range 0200–0219).
 *
 * Following the commerce conventions to the letter: timestamps are `bigint`
 * epoch-milliseconds, never `timestamptz`; every constrained column carries a
 * `check()`, because `.$type<>()` is compile-time only and buys nothing at
 * runtime; and the DDL lives in a hand-written migration
 * (`0200_shop_categories.sql`) because this file is invisible to drizzle-kit —
 * see the warning in `drizzle.config.ts`.
 * `server/shop/catalog/categories-schema.test.ts` asserts the shape against a
 * MIGRATED DATABASE, not against this file.
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL, AND IT MUST NOT BECOME
 *     ONE. The table exists because `0200_shop_categories.sql` created it. What
 *     this buys is `$inferSelect` types and one place to read the shape. Adding
 *     this path to `drizzle.config.ts` would make the next `db:generate` emit
 *     `CREATE TABLE shop_categories` for a table that already exists — the same
 *     warning `server/db/commerce-schema.ts` and `server/repo/categories-schema.ts`
 *     both carry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A MANAGED LIST THAT NAMES VALUES, NOT THE AUTHORITY FOR WHICH VALUES
 * MAY EXIST.
 *
 * `shop_products.category` stays denormalised `text` with `''` meaning
 * uncategorised, and there is deliberately NO FOREIGN KEY to here.
 * `0007_managed_categories.sql` makes the argument in full for the blog's
 * equivalent table and every word of it holds: an FK would make every free-text
 * category typed before migration 0200 unstorable, and would turn a delete
 * refusal the route can explain into a raw 23503 it cannot.
 *
 * The consequence is the one the blog already lives with, and it is a feature:
 * a category can be IN USE WITHOUT BEING MANAGED. `listShopCategories` returns
 * those with `id: null`, and they can be adopted by creating the managed row.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS TABLE EXISTS WHEN THE BLOG'S DERIVED LIST DID NOT NEED ONE. The
 * storefront routes on `/store/<slug>` and renders a blurb and an accent colour
 * per category (`packages/shop/src/data/types.ts`, `Category`). Those three
 * values have nowhere to live in a list derived from `shop_products.category`,
 * so deriving categories alone would have left them hardcoded in the storefront
 * — which is what Plaspool/plaspool-storefront#2 exists to end.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const shopCategories = pgTable(
  'shop_categories',
  {
    /**
     * `cat_` + the catalogue's id shape. `text` rather than the `uuid` the blog's
     * `categories` uses, because every other table in this subsystem
     * (`shop_products`, `shop_variants`, `shop_prices`) carries a prefixed text
     * id and one subsystem with two id conventions is a bug generator.
     */
    id: text('id').primaryKey(),
    /**
     * THE URL, AND THEREFORE SERVER-AUTHORITATIVE AND NOT DERIVED ON READ.
     *
     * `ProductPatch` has no `slug` key and states the rule: "a published URL is a
     * promise, not a value that follows the heading around". A slug recomputed
     * from `name` on read would mean renaming "ABS" to "ABS & ASA" silently moved
     * `/store/abs` and 404'd every shared link. Set once at creation; changing it
     * is a deliberate, separate act.
     */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /**
     * The line under the heading on `/store/<slug>`, and that page's meta
     * description. NOT NULL with a `''` default rather than nullable: the
     * storefront renders it unconditionally, and "no blurb" and "empty blurb"
     * are not different things to a reader.
     */
    blurb: text('blurb').default('').notNull(),
    /**
     * The category tile's spool tint, or NULL for "none chosen" — a real state,
     * which is why there is no default colour: a wrong colour on every new
     * category is worse than an absent one, because it looks deliberate.
     *
     * Lowercase six-digit hex, spelled and checked exactly as
     * `shop_variants.color_hex` is (migrations 0009/0010).
     */
    accentHex: text('accent_hex'),
    /**
     * Display order for the storefront's tiles, ascending, ties broken by folded
     * name. Editorial rather than alphabetical: the fixture order this replaces
     * ran PLA, PLA+, PETG, ABS, TPU, Support — roughly easiest material first —
     * which no sort over the names produces.
     */
    position: integer('position').default(0).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('shop_categories_position_idx').on(t.position),
    /*
     * `''` is not a category, it is the ABSENCE of one — `shop_products.category
     * = ''` already means uncategorised throughout this codebase, and
     * `listProducts` treats an empty `?category=` as "no filter" rather than as a
     * value to match. `btrim` is the weaker half of the route's `.trim()` on
     * purpose (JS strips tabs and newlines, `btrim` strips spaces), so it can
     * never reject something the route would have accepted.
     */
    check('shop_categories_name_ck', sql`${t.name} <> '' AND ${t.name} = btrim(${t.name})`),
    /* `MAX_CATEGORY_BYTES` from `shared/validate.ts`, restated in the database.
     * Bytes and not characters: `length()` undercounts by up to 4x. */
    check('shop_categories_name_bytes_ck', sql`octet_length(${t.name}) <= 400`),
    /* The alphabet `slugify` (`shared/doc.ts`) emits, so a value this column
     * accepts round-trips through it unchanged. No leading, trailing or doubled
     * hyphen. */
    check('shop_categories_slug_ck', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('shop_categories_slug_bytes_ck', sql`octet_length(${t.slug}) <= 96`),
    check('shop_categories_blurb_bytes_ck', sql`octet_length(${t.blurb}) <= 600`),
    check(
      'shop_categories_accent_hex_ck',
      sql`${t.accentHex} IS NULL OR ${t.accentHex} ~ '^#[0-9a-f]{6}$'`,
    ),
    check('shop_categories_position_ck', sql`${t.position} >= 0`),
    /*
     * NOTE: two objects live ONLY in migration 0200 because drizzle-kit cannot
     * express either.
     *
     * `shop_categories_name_lower_uq` — UNIQUE over `lower(name)` — is a
     * FUNCTIONAL index, the same class as `categories_name_lower_uq` and
     * `shop_reservations_sweep_idx`'s partial predicate. It is the constraint the
     * whole surface depends on: the union joins on `lower(name)`, the rename
     * moves products on it, and the delete counts on it. `categories-schema.test.ts`
     * asserts both that it is applied AND that a second casing is actually
     * refused — an index that exists but is not unique would pass a name check
     * and fail nothing else.
     *
     * `shop_categories_position_idx` is declared above on `position` alone; the
     * migration creates it over `(position, lower(name))`, whose second term is
     * again functional. The test reads the real definition out of `pg_indexes`.
     */
  ],
);

export type DbShopCategory = typeof shopCategories.$inferSelect;
