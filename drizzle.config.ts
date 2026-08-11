import { defineConfig } from 'drizzle-kit';

/**
 * ⚠️  NEVER RUN `drizzle-kit push` AGAINST THIS SCHEMA. USE `npm run db:generate`
 *     FOLLOWED BY `npm run db:migrate`.
 *
 * `push` diffs the live database against `meta/0000_snapshot.json` and issues
 * whatever DDL closes the gap — including `DROP`s. Four objects exist only as
 * hand-appended SQL at the bottom of `server/db/migrations/0000_*.sql` and are
 * therefore absent from that snapshot:
 *
 *   - the `tags_text(text[])` IMMUTABLE wrapper
 *   - the generated `posts.search` tsvector column
 *   - `posts_search_idx` (GIN on `search`)
 *   - `posts_tags_idx` (GIN on `tags`)
 *
 * They are absent because drizzle-kit cannot express them: a
 * `GENERATED ALWAYS AS (...) STORED` expression must be immutable, and
 * `array_to_string` is marked STABLE in `pg_proc`, so the column needs a
 * wrapper function declared first. To `push`, all four look like drift to be
 * removed — it would drop the search column and both indexes, taking full-text
 * search with them, and the next `generate` would not bring them back.
 *
 * `generate` is safe by comparison: it only ever appends a new numbered file,
 * and the hand-written statements in the existing one are never revisited.
 *
 * ⚠️  AND THE SNAPSHOT CHAIN SKIPS 0001. `0001_bound_search_input` was written
 *     by hand, so drizzle-kit never produced `meta/0001_snapshot.json` and
 *     `meta/0002_snapshot.json` has `prevId` pointing straight back at 0000's
 *     id. `generate` diffs the schema file against the LATEST snapshot, so
 *     every future migration is generated as if 0001 never happened.
 *
 *     Today the two agree by luck: 0001 only drops and re-adds the generated
 *     `search` column, which is absent from both snapshots anyway (see above).
 *     The rule that keeps it that way — **a hand-written migration may only
 *     touch objects drizzle-kit cannot model**. Anything else, and the next
 *     `generate` will emit DDL to undo it.
 *
 *     If a hand-written migration ever has to touch a modelled object, generate
 *     an empty migration first (`db:generate` with no schema change) so the
 *     chain gets a snapshot to hang the hand-written statements off, and write
 *     them into that file.
 *
 *     Both facts are asserted in `server/db/migrations.test.ts` so they cannot
 *     rot into a comment nobody checks.
 *
 * ⚠️  APPLY MIGRATIONS WITH `npm run db:migrate` AND NOTHING ELSE. It runs the
 *     ledger reconciliation in `server/db/replay.ts`; a bare
 *     `drizzle-orm` migrator call will silently skip a migration whose `when`
 *     is below the highest `created_at` a database has already recorded, and
 *     exit 0 while doing it.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost/unused' },
});
