/**
 * READ-ONLY: what would happen if you applied migrations to this database.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN THIS AGAINST BOTH DATABASES BEFORE APPLYING ANYTHING.
 *
 * Drizzle applies a journal entry only when its `when` is STRICTLY ABOVE the
 * ledger's high-water mark. Anything at or below is passed over **with no
 * error and no output saying so**.
 *
 * On production that is harmless — its ledger only moves when somebody applies
 * a migration deliberately. On DEV it is a trap: dev's ledger runs AHEAD,
 * because other branches' migrations reach it first. A new migration numbered
 * below dev's high-water is silently skipped there, `db:migrate` looks like it
 * worked, and the first symptom is a dev-only 500 naming a column nobody ever
 * added. Measured 2026-09-08 while applying 0980 (CLAUDE.md §4).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY A SCRIPT RATHER THAN TRUSTING `db:migrate`'s EXIT CODE: this project's
 * production ledger is MIXED — some rows hashed LF, some CRLF — so
 * `assertJournalApplied` throws on EVERY run, long after the DDL has landed.
 * The exit status therefore says nothing about whether anything applied, which
 * is why the habit has to be "read the catalog", and why a read-only probe is
 * worth having as a first-class thing rather than a one-off.
 *
 *   npx tsx --env-file=.prod.env scripts/probe-ledger.ts
 *   npx tsx --env-file=.dev.env  scripts/probe-ledger.ts
 *
 * TOUCHES NOTHING. Every statement here is a SELECT, and it deliberately does
 * not import the app's env schema — `.dev.env` carries only DATABASE_URL, and
 * a probe that demanded a SESSION_SECRET to read two integers would be a probe
 * nobody runs.
 */
import { neon } from '@neondatabase/serverless';
import { readJournal } from '../server/db/replay';
import { wouldBeSkipped } from '../server/db/skipped';

const MIGRATIONS = 'server/db/migrations';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Pass --env-file=.prod.env or --env-file=.dev.env');
  process.exit(1);
}

const sql = neon(url);

const [summary] = (await sql`
  SELECT count(*)::int AS rows, max(created_at)::text AS high
    FROM drizzle.__drizzle_migrations`) as { rows: number; high: string | null }[];

const rows = summary?.rows ?? 0;
const highWater = summary?.high == null ? null : Number(summary.high);

console.log(`ledger rows : ${rows}`);
console.log(`high-water  : ${highWater ?? '(empty ledger)'}`);

const journal = readJournal(MIGRATIONS);
console.log(`journal     : ${journal.length} entries, newest ${journal.at(-1)?.tag ?? '(none)'}`);

/* An entry already IN the ledger is applied, not skipped. Matched on
 * `created_at` rather than `hash` — see `wouldBeSkipped` for why the hash is
 * unusable on this project's mixed LF/CRLF production ledger. */
const applied = new Set(
  (
    (await sql`SELECT created_at FROM drizzle.__drizzle_migrations`) as {
      created_at: string | number;
    }[]
  ).map((r) => Number(r.created_at)),
);

const skipped = wouldBeSkipped(journal, highWater, applied);

if (skipped.length === 0) {
  console.log('\nOK — every entry this checkout carries is either applied or above the mark.');
} else {
  console.log(`\n⚠️  ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} WOULD BE SKIPPED SILENTLY:`);
  for (const entry of skipped) {
    console.log(`  - ${entry.tag} (when ${entry.when} <= ${highWater})`);
  }
  console.log(
    '\nApply these by hand: split the .sql on "--> statement-breakpoint" and run each\n' +
      'statement, so what lands is what the file says rather than a re-typed copy.\n' +
      'Then verify against information_schema / pg_constraint — never the exit code.',
  );
}
