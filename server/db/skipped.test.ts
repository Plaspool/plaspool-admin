import { describe, expect, it } from 'vitest';
import { wouldBeSkipped } from './skipped';
import type { JournalEntry } from './replay';

/**
 * THE SILENT SKIP, PINNED.
 *
 * Drizzle applies a journal entry only when its `when` is ABOVE the ledger's
 * high-water mark. Everything at or below it is treated as already done and
 * passed over — with **no error and no output saying so**.
 *
 * That is survivable on production, whose ledger only ever moves when a
 * migration is applied deliberately. It is a trap on dev, whose ledger runs
 * AHEAD because other branches' migrations reach it first: a new migration
 * numbered below dev's high-water is skipped there, the deploy succeeds, and
 * the first symptom is a dev-only 500 naming a column that was never added.
 * Measured 2026-09-08 while applying 0980 (CLAUDE.md §4).
 *
 * A PURE FUNCTION SO THE RULE IS TESTABLE WITHOUT A DATABASE — the comparison
 * is the whole thing worth being sure about, and a test that needed two live
 * Postgres instances to assert `>` would never be written.
 */

const entry = (idx: number, tag: string, when: number): JournalEntry => ({
  idx,
  tag,
  when,
  hash: `hash-${idx}`,
});

const JOURNAL: JournalEntry[] = [
  entry(0, '1000_broadcast_audience', 1_786_600_005_300),
  entry(1, '1040_push_subscriptions', 1_786_600_005_500),
  entry(2, '1060_served_countries', 1_786_600_005_600),
];

describe('wouldBeSkipped', () => {
  it('names an unapplied entry at or below the high-water mark', () => {
    /* The ledger has passed 1040 but never applied 1000, so 1000 is not
       "already done" — it will never be applied at all. */
    const applied = new Set([1_786_600_005_500]);
    expect(wouldBeSkipped(JOURNAL, 1_786_600_005_500, applied).map((e) => e.tag)).toEqual([
      '1000_broadcast_audience',
    ]);
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * APPLIED IS MATCHED ON `created_at`, NEVER ON THE HASH.
   *
   * This project's production ledger is MIXED — some rows were hashed from LF
   * bytes and some from CRLF — so a hash comparison reports sixteen applied
   * migrations as pending, which is a probe that cries wolf on every run and
   * therefore a probe nobody reads. `created_at` IS the journal's `when` and
   * no line ending can change it.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('counts an entry as applied even when its hash could never match', () => {
    const applied = new Set([1_786_600_005_300, 1_786_600_005_500]);
    expect(wouldBeSkipped(JOURNAL, 1_786_600_005_600, applied).map((e) => e.tag)).toEqual([
      '1060_served_countries',
    ]);
  });

  /* STRICTLY ABOVE, and the boundary is the whole point: an entry EQUAL to the
     high-water is skipped, which is the off-by-one that would make this script
     say "all clear" on exactly the migration it exists to catch. */
  it('treats an entry equal to the high-water as skipped, not as applied', () => {
    expect(wouldBeSkipped([entry(0, 'exactly_at', 500)], 500, new Set()).map((e) => e.tag)).toEqual([
      'exactly_at',
    ]);
  });

  it('says nothing is skipped when every entry is above the mark', () => {
    expect(wouldBeSkipped(JOURNAL, 1_786_600_005_200, new Set())).toEqual([]);
  });

  /* An empty ledger — a fresh database — has no high-water at all, and every
     migration is genuinely pending rather than skipped. */
  it('skips nothing against an empty ledger', () => {
    expect(wouldBeSkipped(JOURNAL, null, new Set())).toEqual([]);
  });
});
