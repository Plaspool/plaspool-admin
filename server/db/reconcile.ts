/**
 * Re-point a drifted `drizzle.__drizzle_migrations` ledger at the current
 * migration files, so `assertJournalApplied` (`server/db/replay.ts`) stops
 * throwing and `db:migrate` can run again.
 *
 * WHY THE LEDGER DRIFTED. `assertJournalApplied` and `healMigrationLedger`
 * both match a ledger row to a journal entry BY HASH — sha256 of the `.sql`
 * file's current bytes. That is correct as a GUARD: a hash that no longer
 * matches anything is exactly "this file changed since it ran", which is a
 * real thing to catch. But this project hand-writes its migrations and edits
 * them after they have been applied — explanatory comments added to
 * `0011_marketing.sql` being one example — so on this project's own database,
 * most rows' hashes no longer match any file, and the guard reports nearly
 * every migration as unreconciled. The guard is doing its job; the ledger
 * just needs to be told what actually happened.
 *
 * WHAT THIS FILE DOES NOT DO. It does not loosen `assertJournalApplied` or
 * `healMigrationLedger`. Hash matching stays exactly as strict as it is today
 * — see that file's header for why (a hand-dated `when` once made a real
 * migration skip silently while `db:migrate` printed success). This file only
 * decides, separately and far more cautiously, what the ledger SHOULD say,
 * and writes that — nothing here changes what counts as "reconciled".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MATCHING KEY, AND WHY THE OTHER TWO CANDIDATES LOSE.
 *
 * Three signals exist. Two are broken by construction on this project:
 *
 * - **Hash** is exactly the thing that no longer matches — that is the
 *   drift being repaired, not a way to find it.
 * - **`created_at`** looks like the fallback, but it cannot be trusted either.
 *   `healMigrationLedger` only ever re-dates a row it can already identify BY
 *   HASH, so a row whose hash has drifted has a `created_at` frozen at
 *   whatever `when` the journal claimed the moment that migration was
 *   originally applied — and this project's own history includes a `when`
 *   hand-dated four days into the future (`replay.ts`'s header). Even a row
 *   that WAS healed at some point is only correct until the next hand-edit of
 *   the journal's `when` values, which this project's §4 workflow does not
 *   forbid. `created_at` is therefore a symptom worth printing, never a key
 *   worth matching on.
 *
 * That leaves **position**: the ledger's `id` column is a bare serial —
 * migrations are inserted in the order the migrator applies them — and the
 * journal's `idx` is the order entries were appended and (per this project's
 * own workflow) run shortly after. Row `id` ascending lined up against journal
 * `idx` ascending is therefore the one signal that is not already known to be
 * broken here. It is still an INFERENCE, not a proof — nothing server-side can
 * rule out the journal having been reordered after some entries were applied
 * and before others were — which is exactly why this tool never trusts it
 * silently:
 *
 *   - it refuses outright the moment the row count and the journal count
 *     differ (§ below), rather than guess which rows correspond to which
 *     unapplied tail;
 *   - wherever a row's CURRENT hash still matches a journal entry's current
 *     hash — a file nobody has touched since it ran — that is direct,
 *     unambiguous evidence, not inference, and this tool cross-checks it
 *     against the positional guess: if a file that has never been touched
 *     lands somewhere position disagrees with, that is a contradiction and
 *     the whole run aborts rather than picking a side;
 *   - it never writes without `--write`, and always prints the full mapping
 *     first, so a human who knows something the ledger's column order does
 *     not gets a chance to say so before anything changes.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE CASES THIS REFUSES OUTRIGHT (no output is "probably fine" — every one of
 * these aborts before touching the database):
 *
 *   1. Row count != journal entry count. Could mean a migration genuinely was
 *      never applied (in which case position-matching the tail would mark it
 *      applied and it would be skipped forever — the exact failure
 *      `replay.ts` exists to prevent) or a row exists with no current file at
 *      all. Either way this tool cannot tell which, so it does not try.
 *   2. Two journal entries share a hash, or two ledger rows share a hash.
 *      Either makes "the hash that matches" ambiguous by definition.
 *   3. A row's current hash matches a journal entry OTHER than the one its
 *      position predicts. Position and direct evidence disagree; there is no
 *      basis here for choosing one over the other.
 *   4. The journal's `idx` values are not a clean `0..n-1` run in file order.
 *      Position-matching assumes the journal file order IS the idx order;
 *      if that is not even true of the file, nothing downstream can be
 *      trusted.
 *
 * AFTER WRITING, this re-runs `assertJournalApplied` in the same process
 * (never trusting the UPDATEs to have done what they say) and reports the
 * write as failed — loudly, with the ledger left mid-repair rather than
 * silently — if it still throws.
 */
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import type { Db } from './client';
import { assertJournalApplied, readJournal, readLedger } from './replay';
import { getEnv } from '../env';

/** Same table `replay.ts` reads and writes. Not imported from there because
 *  it is not exported — a two-word `sql` literal is not worth widening that
 *  file's surface for. */
const LEDGER = sql`drizzle.__drizzle_migrations`;

/** The one folder `db:migrate` and `db:reconcile` both operate on. */
export const MIGRATIONS_FOLDER = 'server/db/migrations';

export class ReconcileAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileAbortError';
  }
}

/** One ledger row, matched to one journal entry, before and after. */
export interface PlanEntry {
  id: number;
  idx: number;
  tag: string;
  fromHash: string;
  toHash: string;
  fromCreatedAt: number;
  toCreatedAt: number;
  hashChanged: boolean;
  createdAtChanged: boolean;
  /**
   * This row's CURRENT hash already matched this journal entry's CURRENT
   * hash — the file has not been edited since it was applied. Direct
   * evidence the positional mapping is right here, not an inference.
   */
  wasAnchor: boolean;
}

export interface ReconcilePlan {
  entries: PlanEntry[];
  /** How many entries in `entries` are corroborated by an unedited file. */
  anchorCount: number;
}

/**
 * Work out what the ledger SHOULD say, without writing anything.
 *
 * Throws `ReconcileAbortError` — never returns a best-effort guess — for
 * every case listed in this file's header. Safe to call repeatedly; it is
 * read-only.
 */
export async function planReconciliation(db: Db, folder: string): Promise<ReconcilePlan> {
  /*
   * READ IN FILE ORDER AND CHECKED IN FILE ORDER — deliberately NOT sorted by
   * `idx` first, and re-sorting it here would silently reopen the hole this
   * check exists to close.
   *
   * `readJournal` returns entries in `_journal.json` order, which is the order
   * drizzle's migrator applies them and therefore the order the ledger's `id`
   * column ascends in. Position-matching is only meaningful when file order IS
   * idx order. Sorting before this loop makes `entry.idx !== i` test something
   * weaker — merely that the idx values form the set 0..n-1 — which a journal
   * listing idx 0, 2, 1 satisfies perfectly while its file order disagrees with
   * its idx order, exactly the case abort 4 is for.
   *
   * Once this passes, file order and idx order provably agree, so everything
   * below can index `journal` positionally without sorting it.
   */
  const journal = readJournal(folder);
  journal.forEach((entry, i) => {
    if (entry.idx !== i) {
      throw new ReconcileAbortError(
        `${folder}/meta/_journal.json: entry "${entry.tag}" is at file position ${i} but carries ` +
          `idx ${entry.idx} — the journal is not a clean 0..n-1 run in file order, so row position ` +
          `cannot be trusted to mean the same thing as journal position. Fix the journal by hand ` +
          `before reconciling.`,
      );
    }
  });

  const ledgerRows = await readLedger(db);
  if (ledgerRows === null) {
    throw new ReconcileAbortError(
      `drizzle.__drizzle_migrations does not exist on this database — there is no ledger to ` +
        `reconcile. Run "npm run db:migrate" directly; on a database with no ledger it creates the ` +
        `table and applies every migration from a clean slate.`,
    );
  }
  const ledger = [...ledgerRows].sort((a, b) => a.id - b.id);

  if (ledger.length !== journal.length) {
    throw new ReconcileAbortError(
      `${journal.length} journal ${plural(journal.length, 'entry', 'entries')} but ${ledger.length} ` +
        `row${ledger.length === 1 ? '' : 's'} in drizzle.__drizzle_migrations — counts must match ` +
        `before position can mean anything. If the journal has more entries, some may genuinely never ` +
        `have been applied; treating them as applied would skip them forever, which is the exact ` +
        `failure assertJournalApplied exists to catch. If the ledger has more rows, one of them has no ` +
        `current file at all. Either way this tool will not guess which — resolve it by hand, then ` +
        `re-run.`,
    );
  }

  duplicateCheck('journal entries', journal, (e) => e.hash, (e) => e.tag);
  duplicateCheck('drizzle.__drizzle_migrations rows', ledger, (r) => r.hash, (r) => `id ${r.id}`);

  const journalByHash = new Map(journal.map((entry) => [entry.hash, entry]));

  let anchorCount = 0;
  const entries: PlanEntry[] = ledger.map((row, i) => {
    const entry = journal[i];
    const wasAnchor = row.hash === entry.hash;

    if (!wasAnchor) {
      const other = journalByHash.get(row.hash);
      if (other) {
        throw new ReconcileAbortError(
          `drizzle.__drizzle_migrations row ${row.id} (position ${i}, which the journal says is ` +
            `"${entry.tag}") carries the hash of an UNEDITED file belonging to "${other.tag}" ` +
            `(journal position ${other.idx}) instead. Position and direct hash evidence disagree about ` +
            `where this row belongs — that is not something to guess through. Resolve it by hand, then ` +
            `re-run.`,
        );
      }
    } else {
      anchorCount += 1;
    }

    return {
      id: row.id,
      idx: entry.idx,
      tag: entry.tag,
      fromHash: row.hash,
      toHash: entry.hash,
      fromCreatedAt: row.createdAt,
      toCreatedAt: entry.when,
      hashChanged: row.hash !== entry.hash,
      createdAtChanged: row.createdAt !== entry.when,
      wasAnchor,
    };
  });

  return { entries, anchorCount };
}

function duplicateCheck<T>(
  label: string,
  items: T[],
  keyOf: (item: T) => string,
  nameOf: (item: T) => string,
): void {
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = byKey.get(key);
    if (group) group.push(item);
    else byKey.set(key, [item]);
  }
  for (const [hash, group] of byKey) {
    if (group.length > 1) {
      throw new ReconcileAbortError(
        `${label} ${group.map(nameOf).join(', ')} all carry hash ${hash.slice(0, 12)}… — a duplicate ` +
          `hash makes "the row/entry that matches this hash" ambiguous by definition. Resolve it by ` +
          `hand, then re-run.`,
      );
    }
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Write the plan, as ONE statement — all of it lands or none of it does.
 *
 * NEVER `db.transaction`, which the Neon HTTP driver this runs against in
 * production rejects unconditionally (spec §4.3a / CLAUDE.md §3). That ban is
 * precisely why this is a single `UPDATE ... FROM (VALUES ...)` rather than the
 * obvious loop of one `UPDATE ... WHERE id = ...` per row: with no transaction
 * available, statement count IS the atomicity. A loop of N autocommitting
 * statements that loses its connection at row k leaves rows 0..k-1 rewritten
 * and the rest untouched — a ledger half-way between two states, which is the
 * "NEW, uninspected state" `main()` warns about below, reached by a path where
 * that warning never prints because it guards only the verification step.
 * CLAUDE.md §3 prescribes the same shape for the same reason: "Write one
 * guarded statement with CTEs instead."
 *
 * Rows already correct are left out of the VALUES list entirely rather than
 * rewritten to themselves.
 *
 * Every column is cast explicitly. A bound parameter inside `VALUES` has no
 * column to infer its type from, so `created_at` in particular would arrive as
 * `text` against a `bigint` column and the whole statement would be refused
 * (CLAUDE.md §5's cast rule, the same trap in a different shape).
 *
 * Returns how many rows the database says it changed — `RETURNING`, not a
 * counter incremented by the caller's own intentions.
 */
export async function applyReconciliation(db: Db, plan: ReconcilePlan): Promise<number> {
  const changed = plan.entries.filter((e) => e.hashChanged || e.createdAtChanged);
  if (changed.length === 0) return 0;

  const values = changed.map(
    (e) => sql`(${e.id}::integer, ${e.toHash}::text, ${e.toCreatedAt}::bigint)`,
  );

  const res = await db.execute(sql`
    UPDATE ${LEDGER} AS l
       SET hash = v.hash, created_at = v.created_at
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, hash, created_at)
     WHERE l.id = v.id
    RETURNING l.id`);

  return res.rows.length;
}

// ------------------------------------------------------- reporting

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * The complete before/after, for a human to read before ever passing
 * `--write`. Every row, every journal entry it is proposed to represent, and
 * exactly what would change — this is the "present the mapping for
 * confirmation" step, not a summary of it.
 */
export function formatPlan(plan: ReconcilePlan, folder: string): string {
  const lines: string[] = [];
  const n = plan.entries.length;
  const changed = plan.entries.filter((e) => e.hashChanged || e.createdAtChanged);

  lines.push('=== migration ledger reconciliation ===');
  lines.push(`folder: ${folder}`);
  lines.push(`journal entries: ${n}    drizzle.__drizzle_migrations rows: ${n}    counts match`);
  lines.push('');
  lines.push(
    'MATCHING BASIS: row `id` order paired with journal `idx` order (position) — ' +
      'not hash, and not created_at. See server/db/reconcile.ts header for why both of those are ' +
      'unsound on this project. Position is corroborated below by entries marked [anchor]: rows whose ' +
      'file has not been edited since it was applied, so hash and position agree independently.',
  );
  lines.push(
    plan.anchorCount > 0
      ? `${plan.anchorCount} of ${n} ${plural(plan.anchorCount, 'row', 'rows')} ${plan.anchorCount === 1 ? 'is an' : 'are'} anchor${plan.anchorCount === 1 ? '' : 's'} — direct evidence, not inference.`
      : `0 of ${n} rows are anchors in this run — every file has been edited since it was applied, so ` +
        `this mapping rests on position alone. Read it carefully before passing --write.`,
  );
  lines.push('');

  const idxW = 4;
  const tagW = Math.max(3, ...plan.entries.map((e) => e.tag.length));
  const idW = Math.max(6, ...plan.entries.map((e) => String(e.id).length));

  lines.push(
    `${pad('idx', idxW)}  ${pad('row id', idW)}  ${pad('tag', tagW)}  hash (before -> after)                    created_at (before -> after)`,
  );
  lines.push('-'.repeat(idxW + idW + tagW + 90));

  for (const e of plan.entries) {
    const hashText = e.hashChanged
      ? `${shortHash(e.fromHash)} -> ${shortHash(e.toHash)}  CHANGED`
      : `${shortHash(e.fromHash)}  unchanged`;
    const createdText = e.createdAtChanged
      ? `${e.fromCreatedAt} -> ${e.toCreatedAt}  CHANGED`
      : `${e.fromCreatedAt}  unchanged`;
    const anchorTag = e.wasAnchor ? '  [anchor]' : '';
    lines.push(
      `${pad(String(e.idx), idxW)}  ${pad(String(e.id), idW)}  ${pad(e.tag, tagW)}  ${pad(hashText, 42)}  ${createdText}${anchorTag}`,
    );
  }

  lines.push('');
  lines.push(
    `${changed.length} of ${n} row${n === 1 ? '' : 's'} would change. ${n - changed.length} already ` +
      `correct.`,
  );

  return lines.join('\n');
}

// ------------------------------------------------------- CLI entrypoint

async function main(): Promise<void> {
  const write = process.argv.includes('--write');

  const db = drizzle(neon(getEnv().DATABASE_URL), { schema }) as unknown as Db;

  const plan = await planReconciliation(db, MIGRATIONS_FOLDER);
  process.stdout.write(`${formatPlan(plan, MIGRATIONS_FOLDER)}\n`);

  if (!write) {
    process.stdout.write(
      '\nDRY RUN — no changes made. Review the mapping above, then re-run with --write to apply it.\n',
    );
    return;
  }

  process.stdout.write('\n--write given: applying the plan above...\n');
  const written = await applyReconciliation(db, plan);
  process.stdout.write(`wrote ${written} row(s) to drizzle.__drizzle_migrations.\n`);

  process.stdout.write('verifying by re-running assertJournalApplied against the live database...\n');
  try {
    await assertJournalApplied(db, MIGRATIONS_FOLDER);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `wrote ${written} row(s), but assertJournalApplied STILL throws afterwards. The ledger has ` +
        `been changed and is now in a NEW, uninspected state — do not run db:migrate until this is ` +
        `understood; investigate drizzle.__drizzle_migrations by hand.\n\n${detail}`,
    );
  }
  process.stdout.write('assertJournalApplied passes. db:migrate can run again.\n');
}

// `pathToFileURL`, not a string compare: `import.meta.url` percent-encodes,
// and this repo's own path contains a space. Guarded so importing this module
// from a test never opens a database connection.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    // Never print the raw error object — see server/db/client.ts's
    // scrubDriverError for why a driver failure can carry a connection string
    // or bind parameters. Everything thrown by this file's own code is a
    // plain Error with a message that is already safe to print in full.
    console.error(`\n✗ ${err instanceof Error ? err.message : 'failed'}\n`);
    process.exit(1);
  });
}
