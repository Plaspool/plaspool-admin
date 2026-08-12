-- MANAGED BLOG CATEGORIES (HANDOFF §2 A3).
--
-- HAND-WRITTEN IN FULL, AND THAT IS IN-RULE RATHER THAN LAZY. `drizzle.config.ts`
-- declares `schema: './server/db/schema.ts'` and nothing else, and this table is
-- declared in `server/repo/categories-schema.ts` instead — so drizzle-kit has
-- never seen it and never will. That is exactly the condition
-- `server/db/migrations.test.ts` states for a hand-written migration: it may only
-- touch objects drizzle-kit cannot model, and a table outside the configured
-- schema file is one. `0160_orders_fulfillment.sql` is the same shape for the
-- same reason, and `meta/0007_snapshot.json` deliberately does not exist.
--
-- WHY THE TABLE IS NOT IN `server/db/schema.ts` WITH THE OTHER SEVEN BLOG TABLES.
-- Either half of this would be enough on its own. That file was carrying another
-- session's uncommitted work on the day this was written, and it is the ONE file
-- `db:generate` reads — so putting `categories` in it would have meant a
-- generated migration plus a snapshot, i.e. a second writer inside a file already
-- held by somebody else. The price of sitting outside the model is that nothing
-- typechecks the SQL below, which is why `server/repo/categories-schema.test.ts`
-- reads every column, constraint and index back out of the catalog on a migrated
-- database rather than trusting that this file ran.
--
-- WHAT THIS TABLE IS NOT. It is not where a post's category is stored.
-- `posts.category` stays exactly as it was — denormalised `text`, `''` meaning
-- uncategorised — because it is one of the six columns feeding the `search`
-- tsvector generated column (migration 0001) and because `GET
-- /api/public/categories` groups on it. There is deliberately NO FOREIGN KEY from
-- `posts` to here and no `NOT NULL REFERENCES` anywhere: this is a MANAGED LIST
-- that names values, not the authority for which values may exist. An FK would
-- make every free-text category typed before this migration unstorable, and it
-- would turn `DELETE /api/categories/:id` from a refusal the route can explain
-- into a raw 23503 the route cannot.

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  /* epoch-ms, never `timestamptz` — the rule `server/db/schema.ts` states. It is
   * written and never read: `CategorySummary` carries no timestamp, so this is
   * the audit column that answers "when did this list acquire that name", and a
   * `timestamptz` here would read back as a Date from PGlite and a string from
   * Neon for a value nothing needs to compare. */
  created_at bigint NOT NULL,
  /*
   * `''` IS NOT A CATEGORY, IT IS THE ABSENCE OF ONE. `posts.category = ''`
   * already means uncategorised everywhere in this codebase — `publicCategories`
   * excludes it explicitly — so a managed row named `''` would be a second
   * spelling of "no category" that the union in `GET /api/categories` would show
   * as a real, selectable, renameable entry.
   *
   * `name = btrim(name)` is the weaker half of the route's own `.trim()`
   * deliberately: JS `String.prototype.trim` strips tabs and newlines as well as
   * spaces, `btrim` strips spaces only. So this cannot reject anything the route
   * would have accepted, and it still stops ' Design' and 'Design' becoming two
   * rows that look identical in every picker — which the case-insensitive unique
   * index below cannot see.
   */
  CONSTRAINT categories_name_ck CHECK (name <> '' AND name = btrim(name)),
  /*
   * `MAX_CATEGORY_BYTES` from `shared/validate.ts`, in the database.
   *
   * That ceiling exists because `category` is one of six columns concatenated
   * into the `search` tsvector, and a tsvector over ~1 MB raises SQLSTATE 54000 —
   * a 500 the client retries five times for input that can never be accepted.
   * A managed name longer than the bound would be a name that `PATCH
   * /api/categories/:id` could not write into `posts.category`: the rename would
   * fail 54000 in the middle of a bulk UPDATE rather than at the route boundary.
   * OCTET_LENGTH and not LENGTH, because the ceiling is bytes; `length()` counts
   * characters and undercounts by up to 4x.
   */
  CONSTRAINT categories_name_bytes_ck CHECK (octet_length(name) <= 400)
);--> statement-breakpoint
/*
 * UNIQUE, CASE-INSENSITIVELY, AND AS A FUNCTIONAL INDEX BECAUSE THERE IS NO
 * OTHER WAY TO SAY IT.
 *
 * A plain `UNIQUE (name)` would let 'Design' and 'design' both exist, which is
 * the free-text era's defect with a table around it: two entries in every
 * picker, two counts, and a rename that fixes one of them. Postgres has no
 * case-insensitive text type in core (`citext` is an extension Neon would have
 * to have enabled), so the constraint is an index over `lower(name)`.
 *
 * It is therefore an object drizzle-kit cannot express, exactly like
 * `shop_reservations_sweep_idx`'s partial predicate, and it lives ONLY in this
 * file. `categories-schema.test.ts` asserts it is applied AND that a second
 * casing is actually refused — an index that exists but is not unique would pass
 * a name check and fail nothing else.
 *
 * The whole feature is built on `lower(name)`: the union in `GET /api/categories`
 * joins on it, the rename moves posts on it, and the delete counts on it. One
 * rule in all four places is what makes `count` and `movedPosts` the same number.
 */
CREATE UNIQUE INDEX categories_name_lower_uq ON categories (lower(name));--> statement-breakpoint
/*
 * The other side of that rule, on the table the posts are actually in.
 *
 * `posts_category_idx` (migration 0000) is on `category` verbatim, so it cannot
 * serve `lower(p.category) = lower(...)` — which is the predicate behind the
 * in-use count, the rename's bulk UPDATE and the delete's refusal check. Without
 * this the three cheapest reads on the categories surface are sequential scans of
 * every post in the blog, including the trash.
 *
 * ON `posts`, WHICH DRIZZLE-KIT DOES MODEL — but this index is not, and cannot
 * be, in `server/db/schema.ts`. It is the same standing hazard as
 * `posts_search_idx`: absent from every snapshot, so `generate` will never
 * recreate it and `push` (already forbidden at the top of `drizzle.config.ts`)
 * would drop it.
 */
CREATE INDEX posts_category_lower_idx ON posts (lower(category));
