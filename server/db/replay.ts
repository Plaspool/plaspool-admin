/**
 * Making `db:migrate` tell the truth on a database that has already been
 * migrated once.
 *
 * THE DEFECT. Drizzle's migrators — both the neon-http one this project runs
 * and the pg-core one PGlite uses — read ONE row before the loop
 * (`order by created_at desc limit 1`) and then apply a migration only when
 * `lastDbMigration.created_at < migration.folderMillis`. `created_at` is the
 * journal's `when` AS IT WAS AT THE TIME THAT MIGRATION WAS APPLIED, copied
 * into `drizzle.__drizzle_migrations`.
 *
 * Commit `4a356d2` shipped `0001_bound_search_input` hand-dated
 * `when: 1786780800000` — four days ahead of the wall clock. Any database
 * migrated at that commit recorded that number. Re-dating 0001 in the journal
 * afterwards changed the FILE; it did not change the ROW. So on such a database
 * the high-water mark is still 1786780800000, `0002`'s `folderMillis` of
 * 1786440456271 is below it, and 0002 is silently skipped: `db:migrate` prints
 * success and exits 0, `posts.template` does not exist, and every write
 * carrying it fails `42703`. The database then stays stuck for every future
 * migration dated before 2026-08-15.
 *
 * `migrations.test.ts` asserted that the journal's `when` values strictly
 * increase, which is a property of the FILE — true, and green, and blind to the
 * file-versus-database relationship that actually decides what runs.
 *
 * TWO HALVES, AND BOTH ARE NEEDED.
 *
 * 1. `healMigrationLedger` is the corrective step: it rewrites each recorded
 *    `created_at` to the `when` its migration currently carries in the journal,
 *    matched BY HASH so it can only ever touch a row it can identify. That
 *    lowers the stranded high-water mark back to 1786414002810 and 0002 applies
 *    on the next run. It is a no-op on a database that was never stranded, and
 *    a no-op on a fresh one (there is no ledger table yet).
 * 2. `assertJournalApplied` is the durable check: after migrating, read the
 *    applied set back out of the database and reconcile it against the journal.
 *    A tag with no row, a row with no tag, or a row whose `created_at` no longer
 *    matches its journal entry all fail loudly, because each of them means the
 *    next migration may be skipped exactly the way 0002 was.
 *
 * A corrective MIGRATION was the obvious alternative and is worse: to run on the
 * stranded database it would have to be dated after 1786780800000, i.e. into the
 * future, which is precisely the mistake that caused this — every migration
 * generated between now and that date would then be skipped on every database.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/** Drizzle's defaults. Neither migrator is configured away from them here. */
const LEDGER = sql`drizzle.__drizzle_migrations`;

export interface JournalEntry {
  idx: number;
  tag: string;
  /** `folderMillis` — what the migrator compares against, and what it records. */
  when: number;
  /** sha256 of the raw `.sql` file, computed exactly as `readMigrationFiles` does. */
  hash: string;
}

interface LedgerRow {
  id: number;
  hash: string;
  createdAt: number;
}

export class MigrationReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationReplayError';
  }
}

/**
 * The journal as the migrator reads it, plus the hash it would record.
 *
 * Deliberately re-derived here rather than imported from `drizzle-orm/migrator`:
 * `readMigrationFiles` is what we are checking, so reading the same two inputs
 * independently is the point.
 */
export function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  return journal.entries.map((entry) => ({
    idx: entry.idx,
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256')
      .update(readFileSync(`${folder}/${entry.tag}.sql`).toString())
      .digest('hex'),
  }));
}

/** `null` when the migrator has never run against this database. */
async function readLedger(db: Db): Promise<LedgerRow[] | null> {
  const exists = await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if (exists.rows[0]?.t == null) return null;
  const res = await db.execute(sql`SELECT id, hash, created_at FROM ${LEDGER} ORDER BY id`);
  return res.rows.map((row) => ({
    id: Number(row.id),
    hash: String(row.hash),
    // int8: a JS number on stock PGlite, a string on Neon and on the test
    // harness, which configures PGlite to behave like Neon (spec §9).
    createdAt: Number(row.created_at),
  }));
}

export interface Healed {
  tag: string;
  from: number;
  to: number;
}

/**
 * Re-date the ledger to match the journal. Call BEFORE migrating.
 *
 * Matched by hash, so a row can only be re-dated to the `when` of the migration
 * whose bytes it recorded. A row whose hash matches nothing in the journal is
 * left alone here and reported by `assertJournalApplied`, which is the half that
 * is allowed to fail.
 */
export async function healMigrationLedger(db: Db, folder: string): Promise<Healed[]> {
  const ledger = await readLedger(db);
  if (ledger === null) return [];

  const byHash = new Map(readJournal(folder).map((entry) => [entry.hash, entry]));
  const healed: Healed[] = [];
  for (const row of ledger) {
    const entry = byHash.get(row.hash);
    if (!entry || entry.when === row.createdAt) continue;
    await db.execute(sql`UPDATE ${LEDGER} SET created_at = ${entry.when} WHERE id = ${row.id}`);
    healed.push({ tag: entry.tag, from: row.createdAt, to: entry.when });
  }
  return healed;
}

/**
 * Reconcile what the database says it has applied against what the folder says
 * exists. Call AFTER migrating.
 *
 * This is the check the journal-file assertion could never be: it reads the
 * ledger, so it sees the thing that actually decides whether the next migration
 * runs. A skipped migration stops being a silent success and becomes a failed
 * command.
 */
export async function assertJournalApplied(db: Db, folder: string): Promise<void> {
  const journal = readJournal(folder);
  const ledger = (await readLedger(db)) ?? [];
  const byHash = new Map(ledger.map((row) => [row.hash, row]));
  const problems: string[] = [];

  for (const entry of journal) {
    const row = byHash.get(entry.hash);
    if (!row) {
      problems.push(
        `${entry.tag} is in the journal but not in ${'drizzle.__drizzle_migrations'} — ` +
          `it was never applied, or its .sql file changed after it was`,
      );
      continue;
    }
    if (row.createdAt !== entry.when) {
      problems.push(
        `${entry.tag} is recorded as ${row.createdAt} but the journal says ${entry.when} — ` +
          `the high-water mark is wrong and a later migration will be skipped`,
      );
    }
  }

  const known = new Set(journal.map((entry) => entry.hash));
  for (const row of ledger) {
    if (!known.has(row.hash)) {
      problems.push(
        `${'drizzle.__drizzle_migrations'} row ${row.id} (created_at ${row.createdAt}) matches no ` +
          `file in ${folder} — a migration was edited or removed after being applied`,
      );
    }
  }

  if (problems.length) {
    throw new MigrationReplayError(
      `the applied migrations do not reconcile with ${folder}:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

/**
 * The one sequence, for both drivers: heal, migrate, then prove it.
 *
 * `migrate` is a parameter because the neon-http and pglite migrators are
 * different functions — the production entry point must run the same one
 * production runs (it applies each statement separately, because the Neon HTTP
 * driver rejects `transaction()` unconditionally), and the test harness must run
 * PGlite's. What must NOT differ between them is this sequence, which is why it
 * lives here and not at either call site.
 */
export async function migrateWithReplayCheck(
  db: Db,
  folder: string,
  migrate: (db: never, config: { migrationsFolder: string }) => Promise<void>,
): Promise<Healed[]> {
  const healed = await healMigrationLedger(db, folder);
  await migrate(db as never, { migrationsFolder: folder });
  await assertJournalApplied(db, folder);
  return healed;
}
