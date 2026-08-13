/**
 * The guards, proved by NEUTRALISING them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS. GAUNTLET II Part 2b measured that replacing
 * `deleted_at IS NULL` or `status <> 'published'` with `true` broke NONE of 254
 * server tests, because every precondition was decided by a JavaScript check on
 * an already-read row — the one check that cannot be trusted under concurrency.
 * A suite that only asserts "the illegal thing was refused" cannot tell a
 * predicate that refused it from a lucky ordering that did. A test that asserts
 * A MUTANT MISBEHAVES is the only kind that proves which line is load-bearing.
 *
 * Here the consequence of a dead guard is money: an inspection accepted from
 * `requested` awards points for goods nobody has seen, and a second inspection
 * that gets past the CAS pays for one pile of returns twice.
 *
 * EACH BLOCK BELOW DOES THE SAME THREE THINGS. It shows the operation refused on
 * the real handle; it re-runs it with exactly one predicate rewritten and shows
 * it going through; and it asserts the rewrite ACTUALLY HAPPENED, because a
 * regex that has stopped matching turns a mutation test into a second copy of
 * the ordinary one, green and worthless.
 *
 * THE FIXTURES ARE BUILT ON THE CLEAN HANDLE and only the operation under test
 * runs through the mutant — otherwise the walk to `received` would itself be
 * running without guards and the test would prove nothing about the step it
 * names.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import {
  AlreadyAwardedError,
  InvalidTransitionError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from '../errors';
import {
  cancel,
  collect,
  createRequest,
  inspect,
  receive,
  reject,
  schedule,
} from './repo';
import type { Db } from '../../db/client';
import type { ReturnRow } from './repo';

let db: Db;
let close: () => Promise<void>;

const T0 = 1786600001000;
const NOW = T0 + 60_000;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'dara@example.test';

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                marketing_ledger, marketing_balances,
                                marketing_email_intents CASCADE`);
  await db.execute(sql`DELETE FROM marketing_programs WHERE seeded = false`);
});

// ------------------------------------------------------------ the mutant tool

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

/**
 * A handle that rewrites one predicate, and COUNTS how many statements it
 * rewrote.
 *
 * A COPY of `server/shop/orders/test/mutate.ts`, which is itself a copy of the
 * private `mutating()` in `server/repo/lifecycle.test.ts`. Not an import: spec
 * D9 says marketing never imports `server/shop/**`, and that rule is what keeps
 * the two subsystems separable — a test helper is not the place to breach it.
 * The counter is the important half and is asserted in every block below.
 *
 * IT REBUILDS RATHER THAN STRING-PATCHES. The statement is rendered with `$n`
 * placeholders, the substitution is applied to that text, and the placeholders
 * are turned back into bound parameters — so nothing is inlined into SQL and the
 * mutant differs from the original in exactly one predicate.
 */
function countingMutant(
  handle: Db,
  find: RegExp,
  replacement: string,
): { db: Db; rewritten: () => number } {
  let rewritten = 0;
  const proxy = new Proxy(handle, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => {
        const built = (target as unknown as Dialecty).dialect.sqlToQuery(args[0]);
        if (!find.test(built.sql)) return execute.apply(target, args);
        rewritten += 1;
        const parts = built.sql.replace(find, replacement).split(/\$(\d+)/);
        const chunks = parts.map((part, i) =>
          i % 2 === 0 ? sql.raw(part) : sql`${built.params[Number(part) - 1]}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
  return { db: proxy, rewritten: () => rewritten };
}

/** The two predicates every statement in `returns/repo.ts` is guarded by, as
 *  they render. */
const PREDICATE = {
  /** `AND status IN ($n, …)` — the legal-source-status set. */
  statusGuard: /status IN \(\$\d+(?:, \$\d+)*\)/,
  /** `AND revision = $n` — the CAS token. The SET clause renders
   *  `revision = revision + 1` and does not match. */
  revisionCas: /revision = \$\d+/,
} as const;

async function rejection<T>(promise: Promise<unknown>): Promise<T> {
  let caught: unknown;
  let resolved = false;
  await promise.then(
    () => {
      resolved = true;
    },
    (err: unknown) => {
      caught = err;
    },
  );
  if (resolved) throw new Error('expected the call to reject, but it resolved');
  return caught as T;
}

/** Everything a return leaves behind. Cleared before an index goes back on. */
const RESET = sql`TRUNCATE marketing_return_requests, marketing_return_events,
                           marketing_ledger, marketing_balances,
                           marketing_email_intents CASCADE`;

/**
 * Drop an index, run something, and put back EXACTLY what was there.
 *
 * THE DEFINITION IS READ OUT OF `pg_indexes` rather than written down here, so
 * the restore cannot drift from migration 0011 — and the read doubles as an
 * assertion that the index exists at all.
 *
 * THE TABLES ARE EMPTIED BEFORE THE INDEX GOES BACK, which is not tidiness: the
 * whole point of each block below is that the missing index let a row exist that
 * it forbids, so `CREATE UNIQUE INDEX` over the wreckage raises the very 23505
 * the test just proved was absent — a restore that fails for the same reason the
 * test succeeded. Assertions therefore belong INSIDE `run`, where the illegal
 * state still exists.
 */
async function withoutIndex(name: string, run: () => Promise<void>): Promise<void> {
  const res = await db.execute(sql`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`);
  expect(res.rows[0], name).toBeDefined();
  const definition = String(res.rows[0].indexdef);
  await db.execute(sql.raw(`DROP INDEX ${name}`));
  try {
    await run();
  } finally {
    await db.execute(RESET);
    await db.execute(sql.raw(definition));
  }
}

// ------------------------------------------------------------------- fixtures

let keySeq = 0;

async function makeProgram(): Promise<string> {
  keySeq += 1;
  const id = `prg_mutant_${keySeq}`;
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       status, created_at, updated_at)
    VALUES (${id}, ${`bottle-caps-${keySeq}`}, 'unit_return', 'Cap Returns',
            'Bottle Cap', 'Bottle Caps', 'canister', 'canisters', 4, 10,
            'active', ${T0}, ${T0})`);
  return id;
}

/** Walked on the CLEAN handle: only the step under test may run unguarded. */
async function returnAt(
  status: 'requested' | 'scheduled' | 'collected' | 'received' | 'awarded',
  email = EMAIL,
): Promise<ReturnRow> {
  const programId = await makeProgram();
  let row = await createRequest(db, {
    email,
    qtyDeclared: 6,
    programId,
    pickupAddress: '12 Yaba Road',
    source: 'admin',
    actorId: ACTOR,
    now: NOW,
  });
  if (status === 'requested') return row;
  row = await schedule(db, row.id, {
    expectedRevision: row.revision,
    pickupAt: NOW + 86_400_000,
    actorId: ACTOR,
    now: NOW,
  });
  if (status === 'scheduled') return row;
  row = await collect(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  if (status === 'collected') return row;
  row = await receive(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  if (status === 'received') return row;
  const outcome = await inspect(db, row.id, {
    expectedRevision: row.revision,
    qtyAccepted: 5,
    qtyRejected: 0,
    actorId: ACTOR,
    now: NOW,
  });
  return outcome.row;
}

async function statusOf(id: string): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM marketing_return_requests WHERE id = ${id}`);
  return String(res.rows[0].status);
}

async function balanceOf(email: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT balance FROM marketing_balances WHERE customer_email = ${email}`);
  return res.rows[0] ? Number(res.rows[0].balance) : 0;
}

async function awardCount(requestId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*) AS n FROM marketing_ledger
     WHERE return_request_id = ${requestId} AND kind = 'return_award'`);
  return Number(res.rows[0].n);
}

/** The status guard, neutralised. */
const unguarded = () => countingMutant(db, PREDICATE.statusGuard, 'true');

// ------------------------------------------------------------- status guards

describe('the status predicate on each transition', () => {
  it('is what stops an inspection before the goods have been received', async () => {
    const row = await returnAt('requested');
    await expect(
      inspect(db, row.id, {
        expectedRevision: row.revision,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await balanceOf(EMAIL)).toBe(0);

    const mutant = unguarded();
    const outcome = await inspect(mutant.db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    /* Without it, a return nobody has picked up is awarded and paid — the
     * brief's "cannot award before inspection", reproduced on demand. */
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(outcome.award).toEqual({ points: 50, balance: 50 });
    expect(await balanceOf(EMAIL)).toBe(50);
  });

  it('is what stops a pickup being marked collected before it was scheduled', async () => {
    const row = await returnAt('requested');
    await expect(
      collect(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const mutant = unguarded();
    await collect(mutant.db, row.id, {
      expectedRevision: row.revision,
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(await statusOf(row.id)).toBe('collected');
  });

  it('is what stops goods being received before a driver has them', async () => {
    const row = await returnAt('requested');
    await expect(
      receive(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const mutant = unguarded();
    await receive(mutant.db, row.id, {
      expectedRevision: row.revision,
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(await statusOf(row.id)).toBe('received');
  });

  it('is what stops a closed return being scheduled for a pickup', async () => {
    const row = await returnAt('awarded');
    await expect(
      schedule(db, row.id, {
        expectedRevision: row.revision,
        pickupAt: NOW,
        actorId: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const mutant = unguarded();
    await schedule(mutant.db, row.id, {
      expectedRevision: row.revision,
      pickupAt: NOW,
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    /* An awarded return, re-opened for collection — with the ledger row for it
     * still standing. */
    expect(await statusOf(row.id)).toBe('scheduled');
  });

  it('is what stops a rejection after receipt, which would lose the count', async () => {
    const row = await returnAt('received');
    await expect(
      reject(db, row.id, {
        expectedRevision: row.revision,
        reason: 'Not ours',
        actorId: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const mutant = unguarded();
    await reject(mutant.db, row.id, {
      expectedRevision: row.revision,
      reason: 'Not ours',
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    const res = await db.execute(sql`
      SELECT status, qty_accepted FROM marketing_return_requests WHERE id = ${row.id}`);
    expect(res.rows[0].status).toBe('rejected');
    /* Closed over a pile of goods nobody counted — exactly what contract #12
     * routes through the inspection instead. */
    expect(res.rows[0].qty_accepted).toBeNull();
  });

  it('is what stops a cancel once the goods are in hand', async () => {
    const row = await returnAt('received');
    await expect(
      cancel(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const mutant = unguarded();
    await cancel(mutant.db, row.id, {
      expectedRevision: row.revision,
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(await statusOf(row.id)).toBe('cancelled');
  });
});

// ----------------------------------------------------------- revision guards

describe('the revision predicate', () => {
  it('is what refuses a transition written against a stale revision', async () => {
    const row = await returnAt('scheduled');
    const stale = row.revision - 1;

    await expect(
      collect(db, row.id, { expectedRevision: stale, actorId: ACTOR, now: NOW }),
    ).rejects.toBeInstanceOf(StaleMarketingWriteError);
    expect(await statusOf(row.id)).toBe('scheduled');

    const mutant = countingMutant(db, PREDICATE.revisionCas, 'true');
    await collect(mutant.db, row.id, { expectedRevision: stale, actorId: ACTOR, now: NOW });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(await statusOf(row.id)).toBe('collected');
  });

  it('is what refuses an inspection written against a stale revision', async () => {
    const row = await returnAt('received');
    const stale = row.revision - 1;

    await expect(
      inspect(db, row.id, {
        expectedRevision: stale,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(StaleMarketingWriteError);
    expect(await balanceOf(EMAIL)).toBe(0);

    const mutant = countingMutant(db, PREDICATE.revisionCas, 'true');
    const outcome = await inspect(mutant.db, row.id, {
      expectedRevision: stale,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });
    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(outcome.award).toEqual({ points: 50, balance: 50 });
  });
});

// ------------------------------------------------------- the partial uniques

describe('the partial unique indexes', () => {
  /** Both application guards gone at once — the state spec D3 says the indexes
   *  must survive: "awarding a return twice is a 23505 even if every guard above
   *  were deleted". */
  function unguardedEntirely(): { db: Db; rewritten: () => number } {
    const status = countingMutant(db, PREDICATE.statusGuard, 'true');
    const both = countingMutant(status.db, PREDICATE.revisionCas, 'true');
    return { db: both.db, rewritten: () => Math.min(status.rewritten(), both.rewritten()) };
  }

  it('is what refuses a second award when both application guards are gone', async () => {
    const row = await returnAt('awarded');
    expect(await balanceOf(EMAIL)).toBe(50);

    const mutant = unguardedEntirely();
    const err = await rejection<AlreadyAwardedError>(
      inspect(mutant.db, row.id, {
        expectedRevision: row.revision - 4,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      }),
    );

    expect(mutant.rewritten()).toBeGreaterThan(0);
    expect(err).toBeInstanceOf(AlreadyAwardedError);
    /* The statement is one statement, so the refused credit took the whole
     * second inspection with it: the row did not even move. */
    expect(await awardCount(row.id)).toBe(1);
    expect(await balanceOf(EMAIL)).toBe(50);
    expect(await statusOf(row.id)).toBe('awarded');
  });

  it('pays twice for one return once it is dropped, which is what makes it load-bearing', async () => {
    const row = await returnAt('awarded');

    await withoutIndex('marketing_ledger_award_uq', async () => {
      const mutant = unguardedEntirely();
      const outcome = await inspect(mutant.db, row.id, {
        expectedRevision: row.revision - 4,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      });
      expect(mutant.rewritten()).toBeGreaterThan(0);
      /* One pile of returns, paid for twice. */
      expect(outcome.award).toEqual({ points: 50, balance: 100 });
      expect(await awardCount(row.id)).toBe(2);
      expect(await balanceOf(EMAIL)).toBe(100);
    });
  });

  it('is the only thing keeping one customer to one open return', async () => {
    const programId = await makeProgram();
    const open = {
      email: EMAIL,
      qtyDeclared: 6,
      programId,
      pickupAddress: '12 Yaba Road',
      source: 'admin' as const,
      actorId: ACTOR,
      now: NOW,
    };
    const first = await createRequest(db, open);
    await expect(createRequest(db, open)).rejects.toBeInstanceOf(ReturnAlreadyOpenError);

    await withoutIndex('marketing_return_requests_open_uq', async () => {
      const second = await createRequest(db, open);

      /* Two drivers, one doorstep. Nothing in `createRequest` reads the existing
       * row to decide — the index is the whole rule, which is also why dropping
       * it is the whole change if the shop ever wants concurrent returns. */
      expect(second.id).not.toBe(first.id);
      const res = await db.execute(sql`
        SELECT count(*) AS n FROM marketing_return_requests
         WHERE customer_email = ${EMAIL} AND status = 'requested'`);
      expect(Number(res.rows[0].n)).toBe(2);
    });
  });
});
