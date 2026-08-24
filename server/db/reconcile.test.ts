/**
 * `server/db/reconcile.ts` against the drift it exists to repair.
 *
 * The fixture reproduces the real incident directly: migrate a database for
 * real, then edit a migration file ON DISK afterwards — exactly what this
 * project's workflow does and what `assertJournalApplied`'s hash match cannot
 * survive — and assert the reconciler restores a ledger that passes it again.
 * The refusal paths (mismatched counts, an ambiguous mapping) are asserted
 * separately: they must abort loudly rather than write anything.
 *
 * PGlite is configured with the same int8-as-string parser
 * `server/test/harness.ts` uses, so `created_at` round-trips as a Neon-shaped
 * string here too (spec §9) rather than the friendlier number stock PGlite
 * would hand back.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from './schema';
import type { Db } from './client';
import { assertJournalApplied } from './replay';
import {
  MIGRATIONS_FOLDER,
  ReconcileAbortError,
  applyReconciliation,
  formatPlan,
  planReconciliation,
} from './reconcile';

const MIGRATIONS = 'server/db/migrations';
const read = (path: string) => readFileSync(path, 'utf8');

// ------------------------------------------------------- fixtures

const NEON_LIKE_PARSERS = { [types.INT8]: (value: string) => value };

const open: PGlite[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

function pglite(): Db {
  const client = new PGlite({ parsers: NEON_LIKE_PARSERS });
  open.push(client);
  return drizzle(client, { schema }) as unknown as Db;
}

interface FixtureEntry {
  idx: number;
  tag: string;
  when: number;
  /** Defaults to the real file at `server/db/migrations/${tag}.sql`. */
  sqlText?: string;
}

/** A migrations folder holding exactly the entries given, in that order. */
function buildFolder(entries: FixtureEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  for (const entry of entries) {
    const text = entry.sqlText ?? read(`${MIGRATIONS}/${entry.tag}.sql`);
    writeFileSync(join(dir, `${entry.tag}.sql`), text);
  }
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: entries.map(({ idx, tag, when }) => ({ idx, version: '7', when, tag, breakpoints: true })),
  };
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

/**
 * Replace `db.execute` with a counting passthrough, and return the count.
 *
 * Mutates the instance rather than using `vi.spyOn`: `execute` arrives from
 * drizzle's prototype chain, and the point here is only "how many round trips
 * did this function make", which the simplest possible wrapper answers.
 */
function countingExecute(db: Db): () => number {
  let calls = 0;
  const target = db as unknown as { execute: (query: unknown) => unknown };
  const original = target.execute.bind(target);
  target.execute = (query: unknown) => {
    calls += 1;
    return original(query);
  };
  return () => calls;
}

/** Append a line to a migration file already written into `dir` — a "hand-edit after apply". */
function editFile(dir: string, tag: string): void {
  const path = join(dir, `${tag}.sql`);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n-- edited after this migration was applied\n`);
}

const THREE = [
  { idx: 0, tag: '0000_nappy_betty_brant', when: 1_000 },
  { idx: 1, tag: '0001_bound_search_input', when: 2_000 },
  { idx: 2, tag: '0002_lyrical_kate_bishop', when: 3_000 },
];

// ------------------------------------------------------- the drift, reproduced and repaired

describe('reconciling a ledger drifted by a hand-edited migration file', () => {
  it('assertJournalApplied throws once a file is edited after being applied', async () => {
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    await assertJournalApplied(db, dir); // clean before the edit

    editFile(dir, '0001_bound_search_input');

    await expect(assertJournalApplied(db, dir)).rejects.toThrow(
      /matches no file in|0001_bound_search_input is in the journal but not in/,
    );
  });

  it('plans a fix that touches only the edited row, using position corroborated by the two untouched files', async () => {
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    editFile(dir, '0001_bound_search_input');

    const plan = await planReconciliation(db, dir);

    expect(plan.entries).toHaveLength(3);
    expect(plan.anchorCount).toBe(2); // 0000 and 0002 are untouched

    const [e0, e1, e2] = plan.entries;
    expect(e0.tag).toBe('0000_nappy_betty_brant');
    expect(e0.wasAnchor).toBe(true);
    expect(e0.hashChanged).toBe(false);
    expect(e0.createdAtChanged).toBe(false);

    expect(e1.tag).toBe('0001_bound_search_input');
    expect(e1.wasAnchor).toBe(false);
    expect(e1.hashChanged).toBe(true);
    expect(e1.fromHash).not.toBe(e1.toHash);
    // The apply was clean (no historical hand-dated `when`), so created_at was
    // never wrong — only the hash drifted. Matches the diagnosis: the matching
    // KEY is broken, not the ledger's dates.
    expect(e1.createdAtChanged).toBe(false);

    expect(e2.tag).toBe('0002_lyrical_kate_bishop');
    expect(e2.wasAnchor).toBe(true);
    expect(e2.hashChanged).toBe(false);
  });

  it('writing the plan makes assertJournalApplied pass again, verified against the live table', async () => {
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    editFile(dir, '0001_bound_search_input');

    const plan = await planReconciliation(db, dir);
    const written = await applyReconciliation(db, plan);
    expect(written).toBe(1); // only the edited row

    // Verify against the table itself, not the plan object — the plan is what
    // we asked for, not proof of what landed.
    const edited = plan.entries.find((e) => e.tag === '0001_bound_search_input')!;
    const row = await db.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations WHERE id = ${edited.id}`,
    );
    expect(String(row.rows[0].hash)).toBe(edited.toHash);
    expect(Number(row.rows[0].created_at)).toBe(edited.toCreatedAt);

    await expect(assertJournalApplied(db, dir)).resolves.toBeUndefined();
  });

  it('writes every changed row in ONE statement, so a failure cannot half-repair the ledger', async () => {
    /*
     * ATOMICITY, ASSERTED BY STATEMENT COUNT, because that is the only
     * observable form it takes here. `db.transaction` is banned outright
     * (CLAUDE.md §3 — the Neon HTTP driver throws on it unconditionally while
     * PGlite supports it, so a transaction passes every test here and 500s in
     * production). One statement is therefore the ONLY way this write is
     * all-or-nothing, and a per-row loop would leave rows 0..k-1 committed and
     * the rest not when the connection drops at row k — the "NEW, uninspected
     * state" this file's own post-write error warns about, arrived at without
     * that warning ever printing.
     *
     * Two files are edited so there are genuinely two rows to write: with one,
     * a loop and a single statement are indistinguishable.
     */
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    editFile(dir, '0000_nappy_betty_brant');
    editFile(dir, '0002_lyrical_kate_bishop');

    const plan = await planReconciliation(db, dir);
    expect(plan.entries.filter((e) => e.hashChanged).length).toBe(2);

    const statements = countingExecute(db);
    const written = await applyReconciliation(db, plan);

    expect(written).toBe(2);
    expect(statements()).toBe(1);

    // And the count is not the whole claim — both rows really landed.
    await expect(assertJournalApplied(db, dir)).resolves.toBeUndefined();
  });

  it('is idempotent: a second plan against the repaired ledger has nothing left to change', async () => {
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    editFile(dir, '0001_bound_search_input');
    await applyReconciliation(db, await planReconciliation(db, dir));

    const second = await planReconciliation(db, dir);
    expect(second.anchorCount).toBe(3);
    for (const e of second.entries) {
      expect(e.hashChanged).toBe(false);
      expect(e.createdAtChanged).toBe(false);
    }
    expect(await applyReconciliation(db, second)).toBe(0);
  });

  it('formatPlan prints every row, marks the anchors, and flags the change', async () => {
    const db = pglite();
    const dir = buildFolder(THREE);
    await migrate(db as never, { migrationsFolder: dir });
    editFile(dir, '0001_bound_search_input');

    const text = formatPlan(await planReconciliation(db, dir), dir);
    expect(text).toContain('0000_nappy_betty_brant');
    expect(text).toContain('0001_bound_search_input');
    expect(text).toContain('0002_lyrical_kate_bishop');
    expect(text).toContain('CHANGED');
    expect(text).toContain('[anchor]');
    expect(text).toContain('counts match');
    expect(text).toContain('1 of 3 row'); // "1 of 3 rows would change"
  });
});

// ------------------------------------------------------- refusals

describe('refusing rather than guessing', () => {
  it('aborts when the journal has more entries than the ledger has rows', async () => {
    const db = pglite();
    // Only the first two are ever actually applied.
    await migrate(db as never, { migrationsFolder: buildFolder(THREE.slice(0, 2)) });

    // Reconciling against the full three-entry journal: 3 journal entries,
    // 2 ledger rows.
    const fullDir = buildFolder(THREE);
    await expect(planReconciliation(db, fullDir)).rejects.toThrow(ReconcileAbortError);
    await expect(planReconciliation(db, fullDir)).rejects.toThrow(/3 journal entries but 2 rows/);

    // Refusing must not have written anything.
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(Number(count.rows[0].n)).toBe(2);
  });

  it('aborts when two journal entries carry the same hash — a row could match either', async () => {
    const db = pglite();
    await migrate(db as never, { migrationsFolder: buildFolder([THREE[0]]) });
    // A second row so the count lines up with the two-entry journal below.
    // Its own hash is irrelevant to this test — the ambiguity is purely
    // between the two JOURNAL entries.
    await db.execute(
      sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('irrelevant-second-row', 2000)`,
    );

    const zeroContent = read(`${MIGRATIONS}/0000_nappy_betty_brant.sql`);
    const dupDir = buildFolder([
      { idx: 0, tag: '0000_nappy_betty_brant', when: 1_000, sqlText: zeroContent },
      // Byte-identical to the file above under a different tag.
      { idx: 1, tag: '0001_byte_identical_to_0000', when: 2_000, sqlText: zeroContent },
    ]);

    await expect(planReconciliation(db, dupDir)).rejects.toThrow(ReconcileAbortError);
    await expect(planReconciliation(db, dupDir)).rejects.toThrow(/duplicate hash|ambiguous/i);
  });

  it('aborts when position and an unedited file\'s hash disagree about where a row belongs', async () => {
    const db = pglite();
    const applyDir = buildFolder(THREE.slice(0, 2)); // real 0000, real 0001
    await migrate(db as never, { migrationsFolder: applyDir });

    // Same tags, same `when`s, but the FILE CONTENTS are swapped — as if two
    // migrations' bytes got mixed up rather than merely edited. Neither file
    // is "unedited" relative to what actually ran, but each is byte-identical
    // to the OTHER entry's original file, so hash evidence points at the wrong
    // position outright rather than just failing to match anything.
    const swappedDir = buildFolder([
      { idx: 0, tag: '0000_nappy_betty_brant', when: 1_000, sqlText: read(`${MIGRATIONS}/0001_bound_search_input.sql`) },
      { idx: 1, tag: '0001_bound_search_input', when: 2_000, sqlText: read(`${MIGRATIONS}/0000_nappy_betty_brant.sql`) },
    ]);

    await expect(planReconciliation(db, swappedDir)).rejects.toThrow(ReconcileAbortError);
    await expect(planReconciliation(db, swappedDir)).rejects.toThrow(/disagree/);
  });

  it('aborts when the journal idx values are not a clean 0..n-1 run', async () => {
    const db = pglite();
    await migrate(db as never, { migrationsFolder: buildFolder(THREE) });

    const gappedDir = buildFolder([
      { idx: 0, tag: '0000_nappy_betty_brant', when: 1_000 },
      { idx: 5, tag: '0001_bound_search_input', when: 2_000 }, // gap
      { idx: 2, tag: '0002_lyrical_kate_bishop', when: 3_000 },
    ]);

    await expect(planReconciliation(db, gappedDir)).rejects.toThrow(ReconcileAbortError);
    // Read in FILE order, the run is 0, 5, 2 — the gap surfaces at position 1,
    // which carries idx 5 rather than the expected 1.
    await expect(planReconciliation(db, gappedDir)).rejects.toThrow(
      /is not a clean 0\.\.n-1 run in file order/,
    );
  });

  it('aborts when the journal file order and idx order disagree', async () => {
    /*
     * THE CASE THE idx CHECK IS ACTUALLY FOR, and the one it missed while it
     * sorted by idx before looking.
     *
     * `readJournal` returns entries in `_journal.json` file order, which is the
     * order drizzle's migrator applies them and therefore the order the
     * ledger's `id` ascends in. So position-matching is only meaningful when
     * file order IS idx order. Here it is not: the file lists idx 0, 2, 1.
     * Sorting first hid that completely — after a sort the idx values are the
     * clean set 0,1,2 and every `idx === i` holds.
     *
     * `when` still ascends in FILE order (1000, 2000, 3000) so the migrator
     * applies all three; a journal whose `when` fell backwards would be
     * stopped earlier by the high-water mark and never reach this check.
     *
     * Both permuted files are then edited, so neither can act as an anchor —
     * without that, the position/hash contradiction check above already
     * catches this and the gap never shows.
     */
    const db = pglite();
    const permutedDir = buildFolder([
      { idx: 0, tag: '0000_nappy_betty_brant', when: 1_000 },
      { idx: 2, tag: '0001_bound_search_input', when: 2_000 },
      { idx: 1, tag: '0002_lyrical_kate_bishop', when: 3_000 },
    ]);
    await migrate(db as never, { migrationsFolder: permutedDir });
    editFile(permutedDir, '0001_bound_search_input');
    editFile(permutedDir, '0002_lyrical_kate_bishop');

    await expect(planReconciliation(db, permutedDir)).rejects.toThrow(ReconcileAbortError);
    await expect(planReconciliation(db, permutedDir)).rejects.toThrow(
      /is not a clean 0\.\.n-1 run in file order/,
    );
  });

  it('reports plainly when there is no ledger at all, rather than inventing one', async () => {
    const db = pglite();
    await expect(planReconciliation(db, buildFolder(THREE))).rejects.toThrow(
      /does not exist on this database/,
    );
  });
});

// ------------------------------------------------------- packaging

describe('the reconciler is wired up', () => {
  it('package.json exposes db:reconcile, running this file directly', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['db:reconcile']).toBe('tsx server/db/reconcile.ts');
  });

  it('MIGRATIONS_FOLDER is the same folder db:migrate uses', () => {
    expect(MIGRATIONS_FOLDER).toBe('server/db/migrations');
    expect(read('server/db/migrate.ts')).toContain(`'${MIGRATIONS_FOLDER}'`);
  });
});
