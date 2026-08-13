/**
 * The return lifecycle, against a real migrated database.
 *
 * REPO-LEVEL AND NOT THROUGH HTTP, unlike `programs/routes.test.ts`. What this
 * task adds is the STATE MACHINE and the single statements that move it, so the
 * assertions that matter are about what a statement wrote and what it refused —
 * five timeline rows, one ledger row with the right `balance_after`, a balance,
 * an outbox entry, and nothing at all when a guard says no. A5 mounts these
 * behind routes and pins the wire shapes there.
 *
 * EVERY FIXTURE USES ABSURD LABELS ("Bottle Cap" / "canister"), and every
 * rendered string is asserted to contain them and to contain no word from the
 * shipped preset. A suite whose fixtures happened to match the seeded wording
 * could not tell a label READ FROM A ROW apart from one written in source, which
 * is the single property spec D11's naming discipline is about.
 *
 * THE NUMBERS ARE FIXTURE NUMBERS. Four units minimum, ten a unit — chosen so
 * the arithmetic in the assertions is legible, and deliberately not the seeded
 * preset's, which this file never reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import {
  AlreadyAwardedError,
  BelowMinimumError,
  InvalidTransitionError,
  ProgramPausedError,
  ProgramTypeMismatchError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from '../errors';
import { balanceUpsertFragment } from '../ledger/fragments';
import { dedupeKeyFor } from './events';
import {
  addNote,
  allowedActionsFor,
  cancel,
  collect,
  createRequest,
  inspect,
  listEvents,
  readReturn,
  receive,
  reject,
  schedule,
} from './repo';
import type { Db } from '../../db/client';
import type { ReturnRow } from './repo';

let db: Db;
let close: () => Promise<void>;

/** The `when` migration 0011 carries, reused as the fixtures' clock. */
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
  /*
   * The settings pointer is restored rather than left as the previous test found
   * it: `default_return_program_id` is `ON DELETE SET NULL`, so deleting a test's
   * own program above silently clears it, and the next test's intake would refuse
   * with `program_paused` for a reason that had nothing to do with it.
   */
  await db.execute(sql`
    UPDATE marketing_settings
       SET default_return_program_id = (SELECT id FROM marketing_programs WHERE seeded = true)
     WHERE id = 'main'`);
});

// ------------------------------------------------------------------- fixtures

/** The rejection itself, typed — `.catch(e => e)` widens to `T | error`. A copy
 *  of the helper in `server/shop/orders/test/mutate.ts`, which spec D9 puts out
 *  of reach: marketing never imports `server/shop/**`. */
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

let keySeq = 0;

interface ProgramFixture {
  kind?: 'unit_return' | 'adhoc';
  status?: 'active' | 'paused';
  min?: number;
  perUnit?: number;
}

/** A program inserted by SQL rather than through `programs/repo.ts`: this suite
 *  is about returns, and building its fixtures through another task's write path
 *  would make its failures ambiguous. */
async function makeProgram(fixture: ProgramFixture = {}): Promise<string> {
  keySeq += 1;
  const id = `prg_fixture_${keySeq}`;
  const kind = fixture.kind ?? 'unit_return';
  const units = kind === 'unit_return';
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       status, created_at, updated_at)
    VALUES (${id}, ${`bottle-caps-${keySeq}`}, ${kind}, 'Cap Returns',
            'Bottle Cap', 'Bottle Caps',
            ${units ? 'canister' : null}, ${units ? 'canisters' : null},
            ${units ? (fixture.min ?? 4) : null}, ${units ? (fixture.perUnit ?? 10) : null},
            ${fixture.status ?? 'active'}, ${T0}, ${T0})`);
  return id;
}

async function makeReturn(
  overrides: { programId?: string; qtyDeclared?: number; email?: string } = {},
): Promise<ReturnRow> {
  const programId = overrides.programId ?? (await makeProgram());
  return createRequest(db, {
    email: overrides.email ?? EMAIL,
    qtyDeclared: overrides.qtyDeclared ?? 6,
    programId,
    customerName: 'Dara',
    pickupAddress: '12 Yaba Road',
    source: 'admin',
    actorId: ACTOR,
    now: NOW,
  });
}

/** Walk the real transitions to a stage, so a fixture can never be in a state
 *  the state machine cannot produce. */
async function returnAt(
  status: 'requested' | 'scheduled' | 'collected' | 'received',
  overrides: { programId?: string; qtyDeclared?: number; email?: string } = {},
): Promise<ReturnRow> {
  let row = await makeReturn(overrides);
  if (status === 'requested') return row;
  row = await schedule(db, row.id, {
    expectedRevision: row.revision,
    pickupAt: NOW + 86_400_000,
    driverName: 'Tunde',
    actorId: ACTOR,
    now: NOW,
  });
  if (status === 'scheduled') return row;
  row = await collect(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  if (status === 'collected') return row;
  return receive(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
}

async function ledgerRows(email: string): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql`
    SELECT id, kind, delta, balance_after, reason, program_id, return_request_id, actor_type
      FROM marketing_ledger WHERE customer_email = ${email}
     ORDER BY created_at ASC, id ASC`);
  return res.rows;
}

async function balanceRow(email: string): Promise<Record<string, unknown> | null> {
  const res = await db.execute(sql`
    SELECT balance, lifetime_earned FROM marketing_balances WHERE customer_email = ${email}`);
  return res.rows[0] ?? null;
}

async function intentRows(requestId: string): Promise<Record<string, unknown>[]> {
  const res = await db.execute(sql`
    SELECT kind, dedupe_key, to_email, subject, "text", html, attempts, sent_at
      FROM marketing_email_intents WHERE return_request_id = ${requestId}
     ORDER BY id ASC`);
  return res.rows;
}

// ------------------------------------------------------------ the happy path

describe('the happy path', () => {
  it('walks requested to awarded, writing five events, one ledger row, the balance and one notification', async () => {
    const created = await makeReturn({ qtyDeclared: 6 });
    expect(created.status).toBe('requested');
    expect(created.revision).toBe(1);
    expect(created.pointsPerUnitSnapshot).toBe(10);

    const scheduled = await schedule(db, created.id, {
      expectedRevision: created.revision,
      pickupAt: NOW + 86_400_000,
      driverName: 'Tunde',
      driverPhone: '0800',
      actorId: ACTOR,
      now: NOW,
    });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.pickupScheduledAt).toBe(NOW + 86_400_000);
    expect(scheduled.driverName).toBe('Tunde');
    /* The address was never re-sent: contract #8 lets it live on the row. */
    expect(scheduled.pickupAddress).toBe('12 Yaba Road');

    const collected = await collect(db, created.id, {
      expectedRevision: scheduled.revision,
      actorId: ACTOR,
      now: NOW,
    });
    expect(collected.status).toBe('collected');
    expect(collected.collectedAt).toBe(NOW);

    const received = await receive(db, created.id, {
      expectedRevision: collected.revision,
      actorId: ACTOR,
      now: NOW,
    });
    expect(received.status).toBe('received');

    const outcome = await inspect(db, created.id, {
      expectedRevision: received.revision,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Damaged',
      actorId: ACTOR,
      now: NOW,
    });

    expect(outcome.award).toEqual({ points: 50, balance: 50 });
    expect(outcome.row.status).toBe('awarded');
    expect(outcome.row.qtyAccepted).toBe(5);
    expect(outcome.row.qtyRejected).toBe(1);
    expect(outcome.row.pointsAwarded).toBe(50);
    expect(outcome.row.closedAt).toBe(NOW);
    expect(outcome.row.revision).toBe(5);

    const events = await listEvents(db, created.id);
    expect(events.map((event) => event.type)).toEqual([
      'requested',
      'scheduled',
      'collected',
      'received',
      'inspected',
    ]);

    const entries = await ledgerRows(EMAIL);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('return_award');
    expect(Number(entries[0].delta)).toBe(50);
    expect(Number(entries[0].balance_after)).toBe(50);
    expect(entries[0].return_request_id).toBe(created.id);
    expect(String(entries[0].reason)).toBe('Cap Returns: 5 canisters accepted');

    expect(await balanceRow(EMAIL)).toMatchObject({ balance: 50, lifetime_earned: 50 });

    const intents = await intentRows(created.id);
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe('return_awarded');
    expect(intents[0].dedupe_key).toBe(dedupeKeyFor('return_awarded', created.id));
    expect(intents[0].to_email).toBe(EMAIL);
    expect(intents[0].sent_at).toBeNull();
    expect(String(intents[0].subject)).toBe('You earned 50 Bottle Caps');
    expect(String(intents[0].text)).toContain('5 accepted × 10 = 50 Bottle Caps to dara@example.test');
    expect(String(intents[0].text)).toContain('1 canister');
  });

  it('renders every stored word from the program row and none from the shipped preset', async () => {
    const row = await returnAt('received');
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    const [intent] = await intentRows(row.id);
    const [entry] = await ledgerRows(EMAIL);
    const [inspected] = (await listEvents(db, row.id)).slice(-1);
    const rendered = [
      String(intent.subject),
      String(intent.text),
      String(intent.html),
      String(entry.reason),
      JSON.stringify(inspected.data),
    ].join('\n');

    expect(rendered).toContain('Bottle Caps');
    expect(rendered).toContain('canisters');
    expect(rendered).not.toMatch(/spool/i);
  });

  it('records what actually arrived when it differs from what was declared', async () => {
    const row = await returnAt('received', { qtyDeclared: 6 });
    const outcome = await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 3,
      qtyRejected: 2,
      rejectedReason: 'Not ours',
      actorId: ACTOR,
      now: NOW,
    });

    /* Three plus two is five, and six were declared. Nothing here says otherwise:
     * the driver came back with what the driver came back with. */
    expect(outcome.row.qtyDeclared).toBe(6);
    expect(outcome.row.qtyAccepted).toBe(3);
    expect(outcome.row.qtyRejected).toBe(2);
    expect(outcome.award).toEqual({ points: 30, balance: 30 });
  });

  it('snapshots the inspected event with the four label values and the counts', async () => {
    const row = await returnAt('received');
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 1,
      rejectedReason: 'Damaged',
      actorId: ACTOR,
      now: NOW,
    });

    const [inspected] = (await listEvents(db, row.id)).slice(-1);
    expect(inspected.type).toBe('inspected');
    expect(inspected.data).toEqual({
      qtyAccepted: 5,
      qtyRejected: 1,
      pointsAwarded: 50,
      outcome: 'awarded',
      pointsPerUnit: 10,
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
    });
  });

  it('keeps the words a rename changes out of history', async () => {
    const row = await returnAt('received');
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    await db.execute(sql`
      UPDATE marketing_programs
         SET name = 'Reel Returns', points_label_singular = 'Loop Point',
             points_label_plural = 'Loop Points', unit_label_singular = 'reel',
             unit_label_plural = 'reels'
       WHERE id = ${row.programId}`);

    const [entry] = await ledgerRows(EMAIL);
    const [intent] = await intentRows(row.id);
    const [inspected] = (await listEvents(db, row.id)).slice(-1);

    expect(String(entry.reason)).toBe('Cap Returns: 5 canisters accepted');
    expect(String(intent.subject)).toBe('You earned 50 Bottle Caps');
    expect(inspected.data).toMatchObject({ pointsLabelPlural: 'Bottle Caps' });
  });
});

// ---------------------------------------------------------- allowed actions

describe('allowedActionsFor', () => {
  it('returns the exact ordered array for every status', () => {
    expect(allowedActionsFor('requested')).toEqual(['schedule', 'reject', 'cancel', 'note']);
    expect(allowedActionsFor('scheduled')).toEqual([
      'collect',
      'schedule',
      'reject',
      'cancel',
      'note',
    ]);
    expect(allowedActionsFor('collected')).toEqual(['receive', 'cancel', 'note']);
    expect(allowedActionsFor('received')).toEqual(['inspect', 'note']);
    expect(allowedActionsFor('awarded')).toEqual(['note']);
    expect(allowedActionsFor('rejected')).toEqual(['note']);
    expect(allowedActionsFor('cancelled')).toEqual(['note']);
  });

  it('puts the pipeline-advancing action first, which is the button the queue renders', () => {
    expect(allowedActionsFor('requested')[0]).toBe('schedule');
    expect(allowedActionsFor('scheduled')[0]).toBe('collect');
    expect(allowedActionsFor('collected')[0]).toBe('receive');
    expect(allowedActionsFor('received')[0]).toBe('inspect');
  });

  it('hands out a copy, so a caller cannot rewrite the table', () => {
    const actions = allowedActionsFor('requested');
    actions.length = 0;
    expect(allowedActionsFor('requested')).toHaveLength(4);
  });
});

// -------------------------------------------------------------- intake guards

describe('creating a return', () => {
  it('refuses fewer units than the program asks for, and says how many', async () => {
    const programId = await makeProgram({ min: 4 });
    const err = await rejection<BelowMinimumError>(
      createRequest(db, {
        email: EMAIL,
        qtyDeclared: 3,
        programId,
        source: 'admin',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(BelowMinimumError);
    expect(err.min).toBe(4);
    expect(err.detail).toBe('qtyDeclared');
  });

  it('refuses a second open return for one email and names the one already open', async () => {
    const first = await makeReturn();
    const err = await rejection<ReturnAlreadyOpenError>(
      makeReturn({ programId: first.programId }),
    );
    expect(err).toBeInstanceOf(ReturnAlreadyOpenError);
    expect(err.existingId).toBe(first.id);
    expect(err.status).toBe('requested');
  });

  it('lets the same customer return again once the first one closes', async () => {
    const first = await returnAt('requested');
    await cancel(db, first.id, {
      expectedRevision: first.revision,
      reason: 'Customer changed their mind',
      actorId: ACTOR,
      now: NOW,
    });
    const second = await makeReturn({ programId: first.programId });
    expect(second.id).not.toBe(first.id);
  });

  it('refuses a paused program, and a program that takes no returns', async () => {
    const paused = await makeProgram({ status: 'paused' });
    await expect(makeReturn({ programId: paused })).rejects.toBeInstanceOf(ProgramPausedError);

    const adhoc = await makeProgram({ kind: 'adhoc' });
    await expect(makeReturn({ programId: adhoc })).rejects.toBeInstanceOf(
      ProgramTypeMismatchError,
    );
  });

  it('treats an unknown programId as a field error, not a missing page', async () => {
    const err = await rejection<BadRequestError>(makeReturn({ programId: 'prg_nope' }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('programId');
  });

  it('falls back to the shop default when the intake names no program', async () => {
    const programId = await makeProgram();
    await db.execute(sql`
      UPDATE marketing_settings SET default_return_program_id = ${programId} WHERE id = 'main'`);

    const row = await createRequest(db, {
      email: EMAIL,
      qtyDeclared: 6,
      source: 'customer',
      now: NOW,
    });
    expect(row.programId).toBe(programId);
    expect(row.source).toBe('customer');
    /* The public intake's first entry belongs to the CUSTOMER, not to whoever
     * happens to be signed in. */
    const [first] = await listEvents(db, row.id);
    expect(first.actorType).toBe('customer');
    expect(first.actorId).toBeNull();
  });

  it('refuses when nothing is accepting returns at all', async () => {
    await db.execute(sql`
      UPDATE marketing_settings SET default_return_program_id = NULL WHERE id = 'main'`);
    await expect(
      createRequest(db, { email: EMAIL, qtyDeclared: 6, source: 'customer', now: NOW }),
    ).rejects.toBeInstanceOf(ProgramPausedError);
  });

  it('stores the address as an identity, lowercased', async () => {
    const programId = await makeProgram();
    const row = await createRequest(db, {
      email: '  Dara@Example.TEST ',
      qtyDeclared: 6,
      programId,
      source: 'admin',
      actorId: ACTOR,
      now: NOW,
    });
    expect(row.customerEmail).toBe(EMAIL);
  });
});

// ---------------------------------------------------------- transition guards

describe('the transition guards', () => {
  it('refuses an inspection before the goods have been received', async () => {
    const row = await returnAt('requested');
    const err = await rejection<InvalidTransitionError>(
      inspect(db, row.id, {
        expectedRevision: row.revision,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.status).toBe('requested');
    expect(err.action).toBe('inspect');
    expect(err.request).toMatchObject({
      id: row.id,
      status: 'requested',
      allowedActions: ['schedule', 'reject', 'cancel', 'note'],
    });

    /* Refused means NOTHING was written — not a status change that was reverted. */
    expect(await ledgerRows(EMAIL)).toHaveLength(0);
    expect(await balanceRow(EMAIL)).toBeNull();
    expect(await intentRows(row.id)).toHaveLength(0);
    expect((await listEvents(db, row.id)).map((event) => event.type)).toEqual(['requested']);
  });

  it('lets a collected return be cancelled and refuses a cancel once it is received', async () => {
    const collected = await returnAt('collected');
    const cancelled = await cancel(db, collected.id, {
      expectedRevision: collected.revision,
      reason: 'Lost in transit',
      actorId: ACTOR,
      now: NOW,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Lost in transit');

    const received = await returnAt('received', { email: 'kemi@example.test' });
    const err = await rejection<InvalidTransitionError>(
      cancel(db, received.id, {
        expectedRevision: received.revision,
        reason: 'Changed my mind',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.status).toBe('received');
  });

  it('refuses a rejection once the goods are in hand — that is an inspection', async () => {
    const received = await returnAt('received');
    const err = await rejection<InvalidTransitionError>(
      reject(db, received.id, {
        expectedRevision: received.revision,
        reason: 'Not ours',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err.action).toBe('reject');
  });

  it('rejects a request before receipt, closing it with the reason', async () => {
    const row = await returnAt('scheduled');
    const rejected = await reject(db, row.id, {
      expectedRevision: row.revision,
      reason: 'Not our brand',
      actorId: ACTOR,
      now: NOW,
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedReason).toBe('Not our brand');
    expect(rejected.closedAt).toBe(NOW);
    const [last] = (await listEvents(db, row.id)).slice(-1);
    expect(last.type).toBe('rejected');
    expect(last.note).toBe('Not our brand');
  });

  it('refuses every transition whose expectedRevision is behind, and carries the fresh row', async () => {
    const stale = 99;
    const cases: { name: string; run: (row: ReturnRow) => Promise<unknown>; at: Parameters<typeof returnAt>[0] }[] = [
      {
        name: 'schedule',
        at: 'requested',
        run: (row) =>
          schedule(db, row.id, {
            expectedRevision: stale,
            pickupAt: NOW,
            actorId: ACTOR,
            now: NOW,
          }),
      },
      {
        name: 'collect',
        at: 'scheduled',
        run: (row) =>
          collect(db, row.id, { expectedRevision: stale, actorId: ACTOR, now: NOW }),
      },
      {
        name: 'receive',
        at: 'collected',
        run: (row) =>
          receive(db, row.id, { expectedRevision: stale, actorId: ACTOR, now: NOW }),
      },
      {
        name: 'reject',
        at: 'requested',
        run: (row) =>
          reject(db, row.id, { expectedRevision: stale, reason: 'No', actorId: ACTOR, now: NOW }),
      },
      {
        name: 'cancel',
        at: 'collected',
        run: (row) =>
          cancel(db, row.id, { expectedRevision: stale, actorId: ACTOR, now: NOW }),
      },
      {
        name: 'inspect',
        at: 'received',
        run: (row) =>
          inspect(db, row.id, {
            expectedRevision: stale,
            qtyAccepted: 5,
            qtyRejected: 0,
            actorId: ACTOR,
            now: NOW,
          }),
      },
    ];

    for (const testCase of cases) {
      await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                    marketing_ledger, marketing_balances,
                                    marketing_email_intents CASCADE`);
      const row = await returnAt(testCase.at);
      const err = await rejection<StaleMarketingWriteError>(testCase.run(row));
      expect(err, testCase.name).toBeInstanceOf(StaleMarketingWriteError);
      expect(err.entity, testCase.name).toBe('request');
      expect(err.expected, testCase.name).toBe(stale);
      expect(err.actual, testCase.name).toBe(row.revision);
      expect(err.current, testCase.name).toMatchObject({
        id: row.id,
        status: row.status,
        revision: row.revision,
      });
    }
  });

  it('answers a transition on a return that does not exist with a 404', async () => {
    await expect(
      collect(db, 'ret_nope', { expectedRevision: 1, actorId: ACTOR, now: NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('emits a second scheduled event when a pickup is rescheduled', async () => {
    const row = await returnAt('scheduled');
    const again = await schedule(db, row.id, {
      expectedRevision: row.revision,
      pickupAt: NOW + 172_800_000,
      driverName: 'Bisi',
      actorId: ACTOR,
      now: NOW,
    });

    expect(again.status).toBe('scheduled');
    expect(again.pickupScheduledAt).toBe(NOW + 172_800_000);
    expect(again.driverName).toBe('Bisi');
    expect((await listEvents(db, row.id)).map((event) => event.type)).toEqual([
      'requested',
      'scheduled',
      'scheduled',
    ]);
  });

  it('refuses to schedule a pickup with no address anywhere', async () => {
    const programId = await makeProgram();
    const row = await createRequest(db, {
      email: EMAIL,
      qtyDeclared: 6,
      programId,
      source: 'admin',
      actorId: ACTOR,
      now: NOW,
    });
    const err = await rejection<BadRequestError>(
      schedule(db, row.id, {
        expectedRevision: row.revision,
        pickupAt: NOW,
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('pickupAddress');
  });
});

// -------------------------------------------------------------- the inspection

describe('inspecting', () => {
  it('lands an inspection that accepts nothing in rejected, writing no ledger row and no balance', async () => {
    const row = await returnAt('received');
    const outcome = await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 0,
      qtyRejected: 6,
      rejectedReason: 'Contaminated',
      actorId: ACTOR,
      now: NOW,
    });

    expect(outcome.award).toBeNull();
    expect(outcome.row.status).toBe('rejected');
    expect(outcome.row.qtyAccepted).toBe(0);
    expect(outcome.row.pointsAwarded).toBe(0);
    expect(outcome.row.rejectedReason).toBe('Contaminated');

    expect(await ledgerRows(EMAIL)).toHaveLength(0);
    expect(await balanceRow(EMAIL)).toBeNull();

    const intents = await intentRows(row.id);
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe('return_rejected');
    expect(intents[0].dedupe_key).toBe(dedupeKeyFor('return_rejected', row.id));
    expect(String(intents[0].text)).toContain('Bottle Caps');
    expect(String(intents[0].text)).toContain('Contaminated');
  });

  it('requires a rejection reason exactly when something was rejected', async () => {
    const row = await returnAt('received');

    const missing = await rejection<BadRequestError>(
      inspect(db, row.id, {
        expectedRevision: row.revision,
        qtyAccepted: 4,
        qtyRejected: 2,
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(missing).toBeInstanceOf(BadRequestError);
    expect(missing.detail).toBe('rejectedReason');

    const spurious = await rejection<BadRequestError>(
      inspect(db, row.id, {
        expectedRevision: row.revision,
        qtyAccepted: 6,
        qtyRejected: 0,
        rejectedReason: 'Damaged',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(spurious).toBeInstanceOf(BadRequestError);
    expect(spurious.detail).toBe('rejectedReason');

    /* Neither refusal wrote anything. */
    expect(await ledgerRows(EMAIL)).toHaveLength(0);
    expect((await listEvents(db, row.id))).toHaveLength(4);
  });

  it('refuses quantities that are not whole and not positive', async () => {
    const row = await returnAt('received');
    for (const bad of [
      { qtyAccepted: -1, qtyRejected: 0, field: 'qtyAccepted' },
      { qtyAccepted: 1.5, qtyRejected: 0, field: 'qtyAccepted' },
      { qtyAccepted: 1, qtyRejected: -2, field: 'qtyRejected' },
    ]) {
      const err = await rejection<BadRequestError>(
        inspect(db, row.id, {
          expectedRevision: row.revision,
          qtyAccepted: bad.qtyAccepted,
          qtyRejected: bad.qtyRejected,
          actorId: ACTOR,
          now: NOW,
        }),
      );
      expect(err, bad.field).toBeInstanceOf(BadRequestError);
      expect(err.detail).toBe(bad.field);
    }
  });

  it('answers a replayed inspection with already_awarded and leaves the balance alone', async () => {
    const row = await returnAt('received');
    const first = await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });
    expect(first.award).toEqual({ points: 50, balance: 50 });

    const err = await rejection<AlreadyAwardedError>(
      inspect(db, row.id, {
        expectedRevision: row.revision,
        qtyAccepted: 5,
        qtyRejected: 0,
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(AlreadyAwardedError);

    const entries = await ledgerRows(EMAIL);
    expect(entries).toHaveLength(1);
    expect(err.entryId).toBe(String(entries[0].id));
    expect(await balanceRow(EMAIL)).toMatchObject({ balance: 50, lifetime_earned: 50 });
    expect(await intentRows(row.id)).toHaveLength(1);
  });

  it('awards the rate the customer was promised after the program is repriced', async () => {
    const row = await returnAt('received');
    await db.execute(sql`
      UPDATE marketing_programs SET points_per_unit = 1 WHERE id = ${row.programId}`);

    const outcome = await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });
    expect(outcome.award).toEqual({ points: 50, balance: 50 });
    expect(outcome.row.pointsAwarded).toBe(50);
  });

  it('adds to a balance that is already there rather than replacing it', async () => {
    const first = await returnAt('received');
    await inspect(db, first.id, {
      expectedRevision: first.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    const second = await returnAt('received', { programId: first.programId });
    const outcome = await inspect(db, second.id, {
      expectedRevision: second.revision,
      qtyAccepted: 4,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    expect(outcome.award).toEqual({ points: 40, balance: 90 });
    const entries = await ledgerRows(EMAIL);
    expect(entries.map((entry) => Number(entry.balance_after))).toEqual([50, 90]);
    expect(await balanceRow(EMAIL)).toMatchObject({ balance: 90, lifetime_earned: 90 });
  });
});

// ------------------------------------------------------------------ the notes

describe('notes', () => {
  it('appends in any state and bumps nothing', async () => {
    const row = await returnAt('received');
    const awarded = await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    const event = await addNote(db, row.id, {
      note: 'Customer called about the missing canister',
      actorType: 'admin',
      actorId: ACTOR,
      now: NOW + 1,
    });
    expect(event.type).toBe('note');
    expect(event.note).toBe('Customer called about the missing canister');
    expect(event.occurredAt).toBe(NOW + 1);

    const after = await readReturn(db, row.id);
    expect(after?.request.revision).toBe(awarded.row.revision);
    expect(after?.request.updatedAt).toBe(awarded.row.updatedAt);
  });

  it('refuses an empty note and a note on a return that does not exist', async () => {
    const row = await returnAt('requested');
    await expect(
      addNote(db, row.id, { note: '   ', actorType: 'admin', now: NOW }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      addNote(db, 'ret_nope', { note: 'hello', actorType: 'admin', now: NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// -------------------------------------------------------- the balance fragment

describe('the balance fragments', () => {
  /**
   * The debit half of `ledger/fragments.ts` is exercised here because A4 SHIPS
   * it — A6 wraps the same builder into `debit()`, and a fragment that has never
   * run is a fragment whose first execution is in production. What matters is the
   * guard: the overdraft must update zero rows rather than be caught afterwards.
   */
  async function debit(email: string, amount: number): Promise<number | null> {
    const res = await db.execute(sql`
      WITH bal AS (${balanceUpsertFragment({
        direction: 'debit',
        from: sql`(SELECT ${email}::text AS email) src`,
        email: sql`src.email`,
        amount: sql`${amount}::integer`,
        now: NOW,
      })})
      SELECT balance FROM bal`);
    return res.rows[0] ? Number(res.rows[0].balance) : null;
  }

  it('takes points off a balance and refuses to take more than is there', async () => {
    const row = await returnAt('received');
    await inspect(db, row.id, {
      expectedRevision: row.revision,
      qtyAccepted: 5,
      qtyRejected: 0,
      actorId: ACTOR,
      now: NOW,
    });

    expect(await debit(EMAIL, 20)).toBe(30);
    expect(await debit(EMAIL, 60)).toBeNull();
    expect(await balanceRow(EMAIL)).toMatchObject({ balance: 30, lifetime_earned: 50 });
  });

  it('writes nothing when the customer has no balance at all', async () => {
    expect(await debit('nobody@example.test', 1)).toBeNull();
    expect(await balanceRow('nobody@example.test')).toBeNull();
  });
});
