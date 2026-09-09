import type { JournalEntry } from './replay';

/**
 * Which journal entries this database would pass over in silence.
 *
 * Drizzle applies an entry only when its `when` is STRICTLY ABOVE the ledger's
 * high-water mark; anything at or below is assumed already done and skipped
 * with no error and no output. See `skipped.test.ts` for why that is a trap on
 * the dev database specifically, and CLAUDE.md §4 for the measurement.
 *
 * `null` high-water means an empty ledger — a fresh database, where nothing is
 * skipped and everything is genuinely pending.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `appliedWhens` IS `created_at`, NOT THE HASH, AND THAT IS NOT A SHORTCUT.
 *
 * This project's production ledger is MIXED: some rows were hashed from LF
 * bytes and some from CRLF, which is why `assertJournalApplied` throws on
 * every single run. Deciding "already applied" by hash would inherit that and
 * report sixteen long-applied migrations as pending — a probe that cries wolf
 * every time is a probe nobody reads, which is worse than not having one.
 *
 * `created_at` IS the journal's `when`. It is what the migrator compares
 * against and what it records, and no line ending can change it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function wouldBeSkipped(
  journal: readonly JournalEntry[],
  highWater: number | null,
  appliedWhens: ReadonlySet<number>,
): JournalEntry[] {
  if (highWater === null) return [];
  return journal.filter((entry) => entry.when <= highWater && !appliedWhens.has(entry.when));
}
