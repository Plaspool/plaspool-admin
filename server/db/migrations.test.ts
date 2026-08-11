/**
 * Properties of the migration *pipeline*, not of the schema.
 *
 * These assert against file contents rather than a live database because that
 * is where the failure modes are: a schema nothing ever applies, and a command
 * that would silently delete DDL. Neither is observable from inside a query.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

const MIGRATION_SQL = 'server/db/migrations/0000_nappy_betty_brant.sql';
const BOUND_SEARCH_SQL = 'server/db/migrations/0001_bound_search_input.sql';
const SNAPSHOT = 'server/db/migrations/meta/0000_snapshot.json';
const JOURNAL = 'server/db/migrations/meta/_journal.json';

/** Everything appended by hand, and therefore invisible to drizzle-kit. */
const HAND_WRITTEN = ['tags_text', 'posts_search_idx', 'posts_tags_idx'];

describe('the migrations are applicable', () => {
  it('package.json exposes db:generate and db:migrate', () => {
    // Without these the schema exists only inside PGlite, rebuilt from the SQL
    // by every test run — a green suite against a schema no real database has
    // ever seen.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:generate']).toBe('drizzle-kit generate');
    expect(pkg.scripts['db:migrate']).toBe('tsx server/db/migrate.ts');
  });

  it('the migrate entrypoint uses the neon-http migrator on the checked-in folder', () => {
    const src = read('server/db/migrate.ts');
    // The generic pg-core migrator wraps its run in `session.transaction(...)`,
    // which the Neon HTTP driver rejects unconditionally. The neon-http
    // migrator issues each statement separately, which is why it is named
    // explicitly instead of taken from whichever import happened to be handy.
    expect(src).toContain("from 'drizzle-orm/neon-http/migrator'");
    expect(src).not.toContain("from 'drizzle-orm/pglite/migrator'");
    expect(src).toContain('server/db/migrations');
    // Same folder the test harness migrates PGlite from — one schema, two drivers.
    expect(read('server/test/harness.ts')).toContain('server/db/migrations');
  });
});

describe('drizzle-kit push would drop the hand-appended DDL', () => {
  it('the search DDL is in the migration SQL', () => {
    const sqlText = read(MIGRATION_SQL);
    for (const object of HAND_WRITTEN) expect(sqlText).toContain(object);
    expect(sqlText).toContain('GENERATED ALWAYS AS');
  });

  it('and is absent from the snapshot push diffs against', () => {
    // This is the whole hazard, stated as an assertion: `push` compares the
    // live database with this snapshot and issues DDL to close the gap. Four
    // objects it has never heard of look like drift to be dropped — the
    // generated `search` column and both GIN indexes would go, and the next
    // `generate` would not bring them back.
    const snapshot = read(SNAPSHOT);
    for (const object of HAND_WRITTEN) expect(snapshot).not.toContain(object);
    expect(snapshot).not.toContain('"search"');
  });

  it('0001 is in the journal, so the migrator actually applies it', () => {
    // The SQL file is only half of a migration. `drizzle-orm`'s migrator reads
    // `meta/_journal.json` and nothing else — a file on disk with no entry here
    // is never run, so the tsvector bound would exist in the repository and not
    // in any database. PGlite rebuilds from the same folder, so the suite would
    // be green against a schema production does not have.
    const journal = JSON.parse(read(JOURNAL)) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain('0001_bound_search_input');
    // Applied in order, after the table it alters exists.
    expect(tags.indexOf('0001_bound_search_input')).toBeGreaterThan(
      tags.indexOf('0000_nappy_betty_brant'),
    );
    journal.entries.forEach((entry, i) => expect(entry.idx).toBe(i));
  });

  it('0001 recreates the GIN index it drops with the column', () => {
    // `ALTER TABLE ... DROP COLUMN search` takes `posts_search_idx` with it,
    // silently. Recreating it is not optional — spec §3.4 requires it, and
    // without it full-text search degrades to a sequential scan with every test
    // still passing.
    const sqlText = read(BOUND_SEARCH_SQL);
    expect(sqlText).toContain('DROP COLUMN search');
    expect(sqlText).toContain('CREATE INDEX posts_search_idx ON posts USING GIN (search)');
    // Statements are separated, or the migrator sends the file as one string.
    expect(sqlText.split('--> statement-breakpoint')).toHaveLength(4);
  });

  it('drizzle.config.ts carries the warning where someone about to run push will see it', () => {
    const config = read('drizzle.config.ts');
    expect(config).toMatch(/NEVER RUN `drizzle-kit push`/);
    expect(config).toContain('db:generate');
    expect(config).toContain('db:migrate');
    for (const object of HAND_WRITTEN) expect(config).toContain(object);
  });
});
