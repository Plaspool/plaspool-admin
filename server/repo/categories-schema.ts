import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * The `categories` table (HANDOFF §2 A3), declared in a file this subsystem owns
 * exclusively rather than in `server/db/schema.ts`.
 *
 * WHY NOT IN `server/db/schema.ts`, WHERE THE OTHER SEVEN BLOG TABLES ARE.
 * `drizzle.config.ts` declares `schema: './server/db/schema.ts'` and nothing
 * else, so that file is the ONE input to `db:generate` — adding a table to it
 * means a generated migration and a new snapshot. On the day this was written
 * that file was carrying another session's uncommitted work, and two writers in
 * one drizzle-kit input is how `server/db/commerce-schema.ts` lost Catalog's and
 * Payments' blocks in a single afternoon. Declared here instead, `categories` is
 * an object drizzle-kit cannot see at all, which is precisely what makes
 * `0007_managed_categories.sql` a LEGAL hand-written migration under the rule
 * `server/db/migrations.test.ts` states: a hand-written migration may only touch
 * objects drizzle-kit cannot model. `server/shop/cart/schema.ts` reached the same
 * arrangement from the same problem.
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL, AND IT MUST NOT BECOME
 *     ONE. The table exists because migration `0007_managed_categories.sql`
 *     created it. What this buys is `$inferSelect` types and one place to read
 *     the shape — and it is kept honest rather than decorative by
 *     `server/repo/categories-schema.test.ts`, which reads every column name back
 *     out of `information_schema` and fails if the two disagree.
 *
 *     Adding this path to `drizzle.config.ts` would make the next `db:generate`
 *     emit `CREATE TABLE categories` for a table that already exists. If it is
 *     ever done it has to be done together with a baseline snapshot — the same
 *     warning `server/db/commerce-schema.ts` carries.
 *
 * The two rules from `server/db/schema.ts` hold here and are not optional:
 * timestamps are `bigint` epoch-milliseconds and never `timestamptz`, and every
 * constrained column carries a `check()` because `.$type<>()` is compile-time
 * only and buys nothing at runtime.
 */
export const categories = pgTable(
  'categories',
  {
    /**
     * `uuid`, matching `users` and `invites` — the two other tables whose ids are
     * minted by the database rather than by a client. Posts and images carry
     * client-generated `p_…`/`img_…` because a client creates them offline;
     * nothing creates a category offline, so there is no reason to invent an id
     * format the database cannot default.
     */
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Written once, read by nothing: `CategorySummary` carries no timestamp. */
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /*
     * `''` is not a category, it is the ABSENCE of one — `posts.category = ''`
     * already means uncategorised throughout this codebase. `btrim` is the
     * weaker half of the route's `.trim()` on purpose (JS strips tabs and
     * newlines, `btrim` strips spaces), so it can never reject something the
     * route would have accepted.
     */
    check('categories_name_ck', sql`${t.name} <> '' AND ${t.name} = btrim(${t.name})`),
    /*
     * `MAX_CATEGORY_BYTES` from `shared/validate.ts`, restated in the database.
     * A name over that bound is a name `PATCH /api/categories/:id` could not
     * write into `posts.category`, because `category` feeds the `search`
     * tsvector and an oversized one is SQLSTATE 54000 mid-UPDATE.
     */
    check('categories_name_bytes_ck', sql`octet_length(${t.name}) <= 400`),
    /*
     * NOTE: `categories_name_lower_uq` — UNIQUE over `lower(name)` — is a
     * FUNCTIONAL index, which drizzle-kit cannot express any more than it can
     * express `shop_reservations_sweep_idx`'s partial predicate. It lives only in
     * migration 0007, and `categories-schema.test.ts` asserts both that it is
     * applied and that a second casing is actually refused. It is the constraint
     * the whole surface depends on: the union, the rename and the delete all
     * match on `lower(name)`.
     *
     * `posts_category_lower_idx` is in the same migration for the same reason and
     * is likewise invisible here — it is an index on somebody else's table.
     */
  ],
);

export type DbCategory = typeof categories.$inferSelect;
