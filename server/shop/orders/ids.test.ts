/**
 * Ids (contract §10), and the mutation operator this subsystem's tests depend on.
 *
 * BOTH ARE COPIES OF SOMETHING ELSEWHERE IN THE REPOSITORY, and both are copies because the
 * original is module-private in a file contract §2 R1 puts out of reach — `newId` in
 * `server/repo/posts.ts`, `mutating` in `server/repo/lifecycle.test.ts`. A copy is a place
 * two implementations can drift, so each one is pinned here against the property that made
 * it worth copying.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from './test/harness';
import type { RawCtx } from './test/harness';
import { countingMutant, mutating } from './test/mutate';
import { ID, newId } from './ids';

describe('newId', () => {
  it('is a prefix, a base-36 timestamp and 16 hex characters', () => {
    // The same shape `server/repo/posts.ts` and `server/repo/images.ts` mint, so an id is
    // indistinguishable by origin — which is what lets `createPost` accept a client-supplied
    // one on import without a second format to validate.
    for (const prefix of Object.values(ID)) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}[0-9a-z]{8,9}[0-9a-f]{16}$`));
    }
  });

  it('is monotonic enough to sort, which is what §6 asks of an event id', () => {
    // The time prefix is base-36 of `Date.now()`, so ids minted in order sort in order for as
    // long as the prefix width is stable (until 2059). It is NOT the uniqueness mechanism —
    // the 64 bits after it are.
    const early = `${ID.event}${(1_700_000_000_000).toString(36)}0000000000000000`;
    const late = `${ID.event}${(1_800_000_000_000).toString(36)}0000000000000000`;
    expect(early < late).toBe(true);
  });

  it('does not repeat across a burst', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId(ID.order)));
    expect(ids.size).toBe(5000);
  });

  it('uses the prefixes contract §10 fixes', () => {
    expect(ID.order).toBe('ord_');
    expect(ID.fulfillment).toBe('ful_');
    expect(ID.event).toBe('evt_');
  });
});

describe('the mutation operator', () => {
  let ctx: RawCtx;

  beforeAll(async () => {
    ctx = await migratedDb();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rewrites a matching predicate and leaves the parameters bound', async () => {
    /*
     * The property that makes it a MUTATION rather than a string hack: `sqlToQuery` renders
     * `$n` placeholders, the substitution is applied to the text, and the placeholders are
     * turned back into bound parameters. Nothing is inlined into SQL, so a mutant cannot
     * accidentally become an injection and a test cannot pass because a value was quoted
     * differently.
     */
    await ctx.db.execute(sql`
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
      VALUES ('evt_a', 'checkout.completed', 'chk_a', '{}'::jsonb, 1)`);

    const original = await ctx.db.execute(
      sql`SELECT id FROM commerce_events WHERE subject_id = ${'chk_nope'}`,
    );
    expect(original.rows).toHaveLength(0);

    // `subject_id = $1` → `true`, with `$1` still bound (and now unused).
    const mutant = mutating(ctx.db, /subject_id = \$\d+/, 'true');
    const mutated = await mutant.execute(
      sql`SELECT id FROM commerce_events WHERE subject_id = ${'chk_nope'}`,
    );
    expect(mutated.rows).toHaveLength(1);
  });

  it('passes a non-matching statement through untouched', async () => {
    const mutant = countingMutant(ctx.db, /this_column_does_not_exist = \$\d+/, 'true');
    const res = await mutant.db.execute(sql`SELECT count(*)::int AS n FROM commerce_events`);
    expect(Number(res.rows[0].n)).toBe(1);
    expect(mutant.rewritten()).toBe(0);
  });

  it('counts rewrites, which is what stops a stale regex passing for the wrong reason', async () => {
    /*
     * THE GUARD ON EVERY MUTATION TEST IN THIS SUBSYSTEM. If a predicate is reworded or a
     * column renamed, the regex stops matching, the "mutant" IS the original, and a test
     * asserting the original's behaviour goes green while proving nothing at all. Every
     * mutation test asserts `rewritten() > 0`; this is the assertion that the counter works.
     */
    const mutant = countingMutant(ctx.db, /subject_id = \$\d+/, 'true');
    await mutant.db.execute(sql`SELECT id FROM commerce_events WHERE subject_id = ${'x'}`);
    await mutant.db.execute(sql`SELECT id FROM commerce_events WHERE subject_id = ${'y'}`);
    await mutant.db.execute(sql`SELECT 1`);
    expect(mutant.rewritten()).toBe(2);
  });

  it('rewrites exactly one occurrence, so a mutant differs in one predicate', async () => {
    // `String.replace` with a non-global regex, deliberately: a mutant that neutralised two
    // predicates at once would not tell you which one carried the property.
    const mutant = countingMutant(ctx.db, /occurred_at = \$\d+/, 'true');
    const res = await mutant.db.execute(sql`
      SELECT id FROM commerce_events
       WHERE occurred_at = ${999} AND occurred_at = ${998}`);
    // The first was neutralised, the second still refuses.
    expect(res.rows).toHaveLength(0);
    expect(mutant.rewritten()).toBe(1);
  });
});
