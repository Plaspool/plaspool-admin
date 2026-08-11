/**
 * Properties of the migration *pipeline*, not of the schema.
 *
 * These assert against file contents rather than a live database because that
 * is where the failure modes are: a schema nothing ever applies, and a command
 * that would silently delete DDL. Neither is observable from inside a query.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from './schema';
import type { Db } from './client';
import {
  MigrationReplayError,
  assertJournalApplied,
  migrateWithReplayCheck,
  readJournal,
} from './replay';

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

  it('every journal `when` is strictly greater than the one before it', () => {
    /*
     * THE ONE ORDERING THAT IS INVISIBLE FROM A TEST DATABASE.
     *
     * `pg-core/dialect.js` reads ONE row — `order by created_at desc limit 1` —
     * before the loop, then applies a migration only when
     * `lastDbMigration.created_at < migration.folderMillis`. On an empty
     * database `lastDbMigration` is undefined, so every migration runs whatever
     * its `when` says, and the suite is green. On a database that already has
     * the earlier migrations, a `when` lower than the highest already applied is
     * SILENTLY SKIPPED — no error, no log, and the next `generate` will not
     * bring it back.
     *
     * This is not hypothetical. `0001_bound_search_input` was hand-authored with
     * `when: 1786780800000`, roughly four days ahead of the wall clock, so
     * `0002` — generated by drizzle-kit at `Date.now()` — landed BELOW it and
     * would never have been applied to a deployed database. `template` would be
     * missing and every write carrying it would fail `42703`. Caught only
     * because the column was checked for by name; the whole server suite passed.
     *
     * Hand-written entries must therefore be dated between their neighbours, not
     * at a convenient round number in the future.
     */
    const journal = JSON.parse(read(JOURNAL)) as {
      entries: Array<{ when: number; tag: string }>;
    };
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(
        journal.entries[i].when,
        `${journal.entries[i].tag} is dated at or before ${journal.entries[i - 1].tag}, so a database holding the earlier migration will never apply it`,
      ).toBeGreaterThan(journal.entries[i - 1].when);
    }
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

// ------------------------------------------------------- the database replay

/**
 * The check the file assertions above cannot be.
 *
 * "Every journal `when` is greater than the one before it" is a property of the
 * FILE. What decides whether a migration runs is the relationship between the
 * file and the ROW already sitting in `drizzle.__drizzle_migrations` on a
 * database that was migrated before the file was re-dated — and no assertion
 * about the file can see that. So this suite builds the stranded database and
 * migrates it, which is the only way to observe the skip.
 */
const MIGRATIONS = 'server/db/migrations';

/** What commit `4a356d2` shipped: 0001 hand-dated four days into the future. */
const AS_AT_4a356d2 = {
  version: '7',
  dialect: 'postgresql',
  entries: [
    { idx: 0, version: '7', when: 1786414002809, tag: '0000_nappy_betty_brant', breakpoints: true },
    { idx: 1, version: '7', when: 1786780800000, tag: '0001_bound_search_input', breakpoints: true },
  ],
};

const open: PGlite[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

function pglite(): Db {
  const client = new PGlite();
  open.push(client);
  return drizzle(client, { schema }) as unknown as Db;
}

/** A migrations folder holding only the tags named, dated as `journal` says. */
function folderAt(journal: typeof AS_AT_4a356d2): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  for (const entry of journal.entries) {
    copyFileSync(`${MIGRATIONS}/${entry.tag}.sql`, join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

async function hasTemplateColumn(db: Db): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'posts' AND column_name = 'template'`);
  return res.rows.length > 0;
}

describe('a database migrated before the journal was re-dated', () => {
  it('THE DEFECT: a bare migrate skips 0002 and still reports success', async () => {
    /*
     * Both calls resolve. Nothing is logged. `posts.template` does not exist and
     * every write carrying it fails 42703 — and because the recorded high-water
     * mark stays at 1786780800000, so does every future migration dated before
     * 2026-08-15.
     *
     * Kept as a test rather than deleted with the fix: it is the reason the fix
     * exists, and it is what would go quiet if someone replaced
     * `migrateWithReplayCheck` with a bare `migrate` again.
     */
    const db = pglite();
    await migrate(db as never, { migrationsFolder: folderAt(AS_AT_4a356d2) });
    await migrate(db as never, { migrationsFolder: MIGRATIONS });

    expect(await hasTemplateColumn(db)).toBe(false);
    await expect(db.execute(sql`SELECT template FROM posts`)).rejects.toThrow();

    const ledger = await db.execute(
      sql`SELECT max(created_at) AS high FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(ledger.rows[0].high)).toBe(1786780800000);
  });

  it('THE FIX: the corrective step re-dates the ledger and 0002 applies', async () => {
    const db = pglite();
    await migrate(db as never, { migrationsFolder: folderAt(AS_AT_4a356d2) });

    const healed = await migrateWithReplayCheck(db, MIGRATIONS, migrate);
    expect(healed).toEqual([
      { tag: '0001_bound_search_input', from: 1786780800000, to: 1786414002810 },
    ]);

    expect(await hasTemplateColumn(db)).toBe(true);
    // The column the skip left missing, and the constraint that came with it.
    await expect(db.execute(sql`SELECT template FROM posts`)).resolves.toBeDefined();
    const ck = await db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname = 'posts_template_ck'`,
    );
    expect(ck.rows).toHaveLength(1);
  });

  it('is idempotent — a second run heals nothing and still reconciles', async () => {
    const db = pglite();
    await migrate(db as never, { migrationsFolder: folderAt(AS_AT_4a356d2) });
    await migrateWithReplayCheck(db, MIGRATIONS, migrate);
    expect(await migrateWithReplayCheck(db, MIGRATIONS, migrate)).toEqual([]);
    expect(await hasTemplateColumn(db)).toBe(true);
  });

  it('heals nothing on a database that was never stranded', async () => {
    const db = pglite();
    expect(await migrateWithReplayCheck(db, MIGRATIONS, migrate)).toEqual([]);
    expect(await hasTemplateColumn(db)).toBe(true);
    await assertJournalApplied(db, MIGRATIONS);
  });
});

describe('the replay check fails loudly rather than silently', () => {
  it('names the migration the database never applied', async () => {
    // The stranded database again, but without the corrective step: this is what
    // `db:migrate` now does instead of exiting 0.
    const db = pglite();
    await migrate(db as never, { migrationsFolder: folderAt(AS_AT_4a356d2) });
    await migrate(db as never, { migrationsFolder: MIGRATIONS });

    await expect(assertJournalApplied(db, MIGRATIONS)).rejects.toThrow(MigrationReplayError);
    await expect(assertJournalApplied(db, MIGRATIONS)).rejects.toThrow(
      /0002_lyrical_kate_bishop is in the journal but not in/,
    );
  });

  it('catches a recorded date that no longer matches the journal', async () => {
    // The stranded state itself, whether or not a later migration exists yet:
    // the high-water mark is wrong, so the NEXT migration will be skipped.
    const db = pglite();
    await migrateWithReplayCheck(db, MIGRATIONS, migrate);
    await db.execute(sql`
      UPDATE drizzle.__drizzle_migrations SET created_at = 1786780800000
       WHERE created_at = 1786414002810`);

    await expect(assertJournalApplied(db, MIGRATIONS)).rejects.toThrow(
      /the high-water mark is wrong and a later migration will be skipped/,
    );
  });

  it('catches a migration file edited after it was applied', async () => {
    const db = pglite();
    await migrateWithReplayCheck(db, MIGRATIONS, migrate);
    await db.execute(
      sql`UPDATE drizzle.__drizzle_migrations SET hash = 'not-the-file-that-ran' WHERE id = 1`,
    );

    await expect(assertJournalApplied(db, MIGRATIONS)).rejects.toThrow(
      /matches no file in server\/db\/migrations/,
    );
  });

  it('reads the same journal the migrator does, hash included', () => {
    const entries = readJournal(MIGRATIONS);
    expect(entries.map((e) => e.tag)).toEqual([
      '0000_nappy_betty_brant',
      '0001_bound_search_input',
      '0002_lyrical_kate_bishop',
    ]);
    for (const entry of entries) expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the snapshot chain skips 0001', () => {
  it('has no 0001 snapshot, so 0002 chains straight back to 0000', () => {
    /*
     * DOCUMENTED HERE BECAUSE THIS IS WHERE THE NEXT PERSON LOOKS. 0001 was
     * hand-written, so drizzle-kit never produced `meta/0001_snapshot.json` and
     * `0002`'s `prevId` points at `0000`'s id — the chain skips 0001 entirely.
     * Neither snapshot models `posts.search`, `tags_text` or the two GIN
     * indexes, because none of them can be expressed in the schema file.
     *
     * The consequence is not confined to `push`: `drizzle-kit generate` diffs
     * against the LATEST snapshot, so any future migration is generated as if
     * 0001 never happened. 0001 only ever drops and re-adds a generated column
     * that is absent from the snapshot anyway, so today the two happen to
     * agree — but the moment a hand-written migration changes something
     * drizzle-kit DOES model, the next generated migration will try to undo it.
     *
     * The rule that follows, and the reason this is an assertion rather than a
     * comment: hand-written migrations may only touch objects drizzle-kit
     * cannot see. Anything else goes through `db:generate`.
     */
    expect(() => read('server/db/migrations/meta/0001_snapshot.json')).toThrow();

    const first = JSON.parse(read('server/db/migrations/meta/0000_snapshot.json')) as {
      id: string;
    };
    const third = JSON.parse(read('server/db/migrations/meta/0002_snapshot.json')) as {
      id: string;
      prevId: string;
    };
    expect(third.prevId).toBe(first.id);

    for (const snapshot of ['0000', '0002']) {
      const text = read(`server/db/migrations/meta/${snapshot}_snapshot.json`);
      for (const object of HAND_WRITTEN) expect(text, snapshot).not.toContain(object);
      expect(text, snapshot).not.toContain('"search"');
    }
  });
});
