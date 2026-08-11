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
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost/unused' },
});
