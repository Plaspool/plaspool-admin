/**
 * Delivery — the sweeper, and the one route that calls it (contract #27).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS ABOUT IS FAILURE. The happy path is four lines; everything
 * else here is what happens when a provider is down, when two admins inspect at
 * the same moment, when an address is permanently undeliverable, and when the
 * deployment has no mail transport at all. Those are the states an outbox exists
 * for, and each one has a rule spec D6 froze: never un-award the points, never
 * double-send, never retry forever, never spend the retry budget on a missing
 * environment variable.
 *
 * THE FIXTURES ARE REAL INSPECTIONS. An intent inserted by hand would prove the
 * sweeper reads rows; awarding a real return proves it delivers the letter the
 * award wrote, addressed to the customer the return names — and lets the failure
 * tests assert the thing that actually matters, which is that the customer's
 * BALANCE is untouched by anything a mailer does.
 *
 * NO WORD OF THE SHIPPED PRESET IS WRITTEN HERE. The programme uses absurd
 * labels ("Bottle Cap" / "canister"); what is delivered is asserted against the
 * stored columns rather than against strings in this file.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import { MailNotConfiguredError } from '../../mail/port';
import { collect, createRequest, inspect, receive, schedule } from '../returns/repo';
import { INTENT_COLUMNS, rowToIntent, toMessage } from './mailer';
import {
  MARKETING_ATTEMPT_LIMIT,
  MARKETING_SWEEP_LIMIT,
  sweepMarketingEmailIntents,
} from './sweep';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { Db } from '../../db/client';
import type { Mailer } from '../../mail/port';
import type { AuthUser } from '../../../shared/types';
import type { MarketingEmailIntent, OutboundMessage } from './mailer';

let ctx: TestCtx;
let db: Db;

/** The `when` migration 0011 carries, reused as the fixtures' clock. */
const T0 = 1786600001000;
const NOW = T0 + 60_000;
const SENT_AT = NOW + 100;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const API = '/api/marketing';

// ------------------------------------------------------------------- mailers

/** Records instead of sending. `assertConfigured` is absent — this transport IS
 *  configured, which is what its absence means (`server/mail/port.ts`). */
class Recorder implements Mailer {
  readonly sent: OutboundMessage[] = [];
  send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** A transport that always fails, so the failure path is exercised for real
 *  rather than by a stub that resolves. */
class BrokenMailer implements Mailer {
  calls = 0;
  send(): Promise<void> {
    this.calls += 1;
    return Promise.reject(new Error('provider unreachable: connect ETIMEDOUT'));
  }
}

/**
 * A deployment with no `RESEND_API_KEY`.
 *
 * INJECTED RATHER THAN LEFT TO THE REAL DEFAULT. `createNotifyRoutes` falls back
 * to `resendMailer()`, whose `assertConfigured` reads the environment — so a
 * suite that exercised the fallback would either depend on a variable being
 * absent from the machine it runs on, or, if one were present, POST a real
 * message to a real provider from a test. `server/routes/email.test.ts` and
 * `password-reset.test.ts` inject the same shape for the same reason.
 */
class UnconfiguredMailer implements Mailer {
  calls = 0;
  assertConfigured(): void {
    throw new MailNotConfiguredError(['RESEND_API_KEY']);
  }
  send(): Promise<void> {
    this.calls += 1;
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------- clients

const recorder = new Recorder();
const unconfigured = new UnconfiguredMailer();

/** Owner, on an app whose transport records. */
let owner: HttpClient;
/** Writer, on the same kind of app — the route is `requireAuth`, deliberately. */
let writer: HttpClient;
/** Owner, on an app with no mail configured. */
let setupPending: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

async function login(user: AuthUser, deps: { mailer?: Mailer } = {}): Promise<HttpClient> {
  const client = httpClient(ctx.db, deps);
  const res = await client.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return client;
}

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
  owner = await login(ctx.users.owner, { mailer: recorder });
  writer = await login(ctx.users.writer, { mailer: recorder });
  setupPending = await login(ctx.users.owner, { mailer: unconfigured });
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                marketing_ledger, marketing_balances,
                                marketing_email_intents CASCADE`);
  await db.execute(sql`DELETE FROM marketing_programs WHERE seeded = false`);
  recorder.sent.length = 0;
  unconfigured.calls = 0;
});

// ------------------------------------------------------------------ fixtures

let seq = 0;

/**
 * One awarded return, and therefore one queued letter.
 *
 * The whole walk — requested → scheduled → collected → received → awarded — so
 * the intent under test is the one a real inspection wrote, with the words of
 * the programme it was awarded under.
 */
async function queuedAward(
  qtyAccepted = 5,
): Promise<{ requestId: string; programId: string; email: string }> {
  seq += 1;
  const programId = `prg_sweep_${seq}`;
  const email = `dara-${seq}@example.test`;
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       status, created_at, updated_at)
    VALUES (${programId}, ${`bottle-caps-${seq}`}, 'unit_return', 'Cap Returns',
            'Bottle Cap', 'Bottle Caps', 'canister', 'canisters', 4, 10,
            'active', ${T0}, ${T0})`);

  let row = await createRequest(db, {
    email,
    qtyDeclared: 6,
    programId,
    customerName: 'Dara',
    pickupAddress: '12 Yaba Road',
    source: 'admin',
    actorId: ACTOR,
    now: NOW,
  });
  row = await schedule(db, row.id, {
    expectedRevision: row.revision,
    pickupAt: NOW + 86_400_000,
    driverName: 'Tunde',
    actorId: ACTOR,
    now: NOW,
  });
  row = await collect(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  row = await receive(db, row.id, { expectedRevision: row.revision, actorId: ACTOR, now: NOW });
  await inspect(db, row.id, {
    expectedRevision: row.revision,
    qtyAccepted,
    qtyRejected: 6 - qtyAccepted,
    rejectedReason: qtyAccepted === 6 ? undefined : 'Crushed in transit',
    actorId: ACTOR,
    now: NOW,
  });
  return { requestId: row.id, programId, email };
}

/** Every queued or delivered letter, oldest first. */
async function intents(): Promise<MarketingEmailIntent[]> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM marketing_email_intents
     ORDER BY created_at ASC, id ASC`);
  return res.rows.map(rowToIntent);
}

async function balanceOf(email: string): Promise<number | null> {
  const res = await db.execute(sql`
    SELECT balance FROM marketing_balances WHERE customer_email = ${email}`);
  return res.rows.length === 0 ? null : Number(res.rows[0].balance);
}

async function ledgerCount(): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM marketing_ledger`);
  return Number(res.rows[0].n);
}

// ------------------------------------------------------------ the mutant tool

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

/**
 * A handle that rewrites one predicate, and COUNTS how many statements it
 * rewrote.
 *
 * A COPY of the helper in `../returns/mutate.test.ts`, which is itself a copy of
 * `server/shop/orders/test/mutate.ts`. Copied rather than imported because the
 * only marketing-side implementation lives inside a `.test.ts`, and importing
 * one test file from another runs its suites — its PGlite boot, its fixtures and
 * its assertions — inside this one. (Extracting it to a shared module would be a
 * better home; it belongs to no task in this plan, so it is named in the report
 * rather than done here in passing.)
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

/** The CAS that turns "this row is unsent" into "this sweep owns it", as it
 *  renders. Not the `SET attempts = attempts + 1` half, and not the SELECT's
 *  `attempts < $n` cap. */
const CLAIM_PREDICATE = /AND attempts = \$\d+/;

// ------------------------------------------------------------------ the bounds

describe('the two bounds are contract numbers, not tuning', () => {
  it('drains fifty letters a sweep and gives up on one after eight attempts', () => {
    /*
     * PINNED BY VALUE, WHICH NOTHING ELSE IN THIS FILE DOES. Every other
     * assertion reads these constants from the module, so both would follow an
     * edit anywhere it took them — the attempt loop below would simply run three
     * times instead of eight and stay green. Spec D6 froze the pair, and each is
     * a promise to somebody: fifty is how fast the queue drains behind a
     * fire-and-forget that nothing schedules, and eight is how long a customer's
     * letter survives a provider having a bad afternoon.
     */
    expect(MARKETING_SWEEP_LIMIT).toBe(50);
    expect(MARKETING_ATTEMPT_LIMIT).toBe(8);
  });
});

// ------------------------------------------------------------- the happy path

describe('the sweeper delivers what the award already wrote', () => {
  it('hands the stored columns to the transport and marks the row sent', async () => {
    const { email } = await queuedAward();
    const [queued] = await intents();
    const mailer = new Recorder();

    expect(await sweepMarketingEmailIntents(db, mailer, SENT_AT)).toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
    });

    /*
     * EQUALITY AGAINST THE STORED ROW. Not "contains Bottle Caps" — the property
     * spec D6 is about is that delivery COPIES, so what is asserted is the copy.
     */
    expect(mailer.sent).toEqual([toMessage(queued)]);
    expect(mailer.sent[0].to).toBe(email);

    const [after] = await intents();
    expect(after).toMatchObject({ sentAt: SENT_AT, attempts: 1, lastError: null });

    // A second sweep has nothing to do, and says so rather than re-sending.
    expect(await sweepMarketingEmailIntents(db, mailer, SENT_AT + 100)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mailer.sent).toHaveLength(1);
  });

  it('posts the letter March wrote even though the programme was renamed in June', async () => {
    /*
     * SPEC D6's HEADLINE PROPERTY, THROUGH THE DELIVERY PATH RATHER THAN AROUND
     * IT. `mailer.test.ts` proves the stored ROW survives a rename; this proves
     * the transport is handed that row and not a re-rendering. The two are one
     * guarantee only because `toMessage` copies four columns — and until a
     * message that was actually SENT after a rename is inspected, that is an
     * argument about the code rather than a fact about the mail.
     */
    const { programId } = await queuedAward();
    const [queued] = await intents();

    await db.execute(sql`
      UPDATE marketing_programs
         SET name = 'Reel Returns',
             points_label_singular = 'Reel Credit', points_label_plural = 'Reel Credits',
             unit_label_singular = 'reel', unit_label_plural = 'reels',
             revision = revision + 1
       WHERE id = ${programId}`);

    /* NON-VACUITY, FIRST. A rename that matched no row would make every
     * `not.toContain` below pass for exactly the wrong reason — a fixture caught
     * by an unrelated bound before it ever reaches the guard under test. */
    const renamed = await db.execute(sql`
      SELECT name FROM marketing_programs WHERE id = ${programId}`);
    expect(renamed.rows[0].name).toBe('Reel Returns');

    const mailer = new Recorder();
    expect(await sweepMarketingEmailIntents(db, mailer, SENT_AT)).toMatchObject({ sent: 1 });
    expect(mailer.sent).toEqual([toMessage(queued)]);

    /* Spelled out as well as compared, because the equality above would also
     * hold if BOTH sides had been re-rendered through the new labels. */
    const delivered = [mailer.sent[0].subject, mailer.sent[0].text, mailer.sent[0].html].join('\n');
    expect(delivered).toContain('Bottle Caps');
    expect(delivered).toContain('canisters');
    expect(delivered).not.toContain('Reel Credits');
    expect(delivered).not.toContain('Reel Returns');
  });

  it('an empty queue is zeros, not an error — the fire-and-forget calls it either way', async () => {
    expect(await sweepMarketingEmailIntents(db, new Recorder(), SENT_AT)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('takes the oldest first and no more than the batch it was given', async () => {
    /*
     * The batch bounds the WORK, not the queue: what it does not reach this time
     * is still first in line next time. Asserted with an explicit small limit so
     * the property is provable without writing fifty-one returns.
     */
    const first = await queuedAward();
    const second = await queuedAward();
    const third = await queuedAward();
    await db.execute(sql`
      UPDATE marketing_email_intents SET created_at = created_at + CASE return_request_id
        WHEN ${first.requestId} THEN 0 WHEN ${second.requestId} THEN 1 ELSE 2 END`);

    const mailer = new Recorder();
    expect(await sweepMarketingEmailIntents(db, mailer, SENT_AT, 2)).toMatchObject({ sent: 2 });
    expect(mailer.sent.map((m) => m.to)).toEqual([first.email, second.email]);

    expect(await sweepMarketingEmailIntents(db, mailer, SENT_AT + 1, 2)).toMatchObject({ sent: 1 });
    expect(mailer.sent.map((m) => m.to)).toEqual([first.email, second.email, third.email]);
  });
});

// ---------------------------------------------------------------- the failures

describe('a transport failure costs the customer nothing', () => {
  it('A MAILER FAILURE NEVER UN-AWARDS THE POINTS', async () => {
    /*
     * The property spec D6 exists for, asserted directly. The award committed in
     * a different statement, and there is no code path from the sweeper back to
     * `marketing_ledger` or `marketing_balances` — a stronger guarantee than a
     * `catch` somebody could remove.
     */
    const { email } = await queuedAward();
    const broken = new BrokenMailer();

    expect(await sweepMarketingEmailIntents(db, broken, SENT_AT)).toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
    });

    expect(await balanceOf(email)).toBe(50);
    expect(await ledgerCount()).toBe(1);

    // And the letter is retryable, with the reason recorded for the detail screen.
    const [after] = await intents();
    expect(after).toMatchObject({ sentAt: null, attempts: 1 });
    expect(after.lastError).toContain('provider unreachable');
  });

  it('one bad address does not stop the rest of the queue', async () => {
    await queuedAward();
    await queuedAward();

    let call = 0;
    const flaky: Mailer = {
      send: () => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('nope')) : Promise.resolve();
      },
    };

    expect(await sweepMarketingEmailIntents(db, flaky, SENT_AT)).toEqual({
      sent: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('retries on the next sweep, then stops at the attempt limit', async () => {
    const broken = new BrokenMailer();
    await queuedAward();

    for (let i = 1; i <= MARKETING_ATTEMPT_LIMIT; i += 1) {
      expect((await sweepMarketingEmailIntents(db, broken, SENT_AT + i)).failed, `sweep ${i}`).toBe(1);
    }
    expect(broken.calls).toBe(MARKETING_ATTEMPT_LIMIT);

    /* Capped: a permanently undeliverable address must not starve every other
     * customer's mail. The row is NOT deleted — it stays visible with its reason,
     * and recovery is `SET attempts = 0`, deliberately a human decision. */
    expect(await sweepMarketingEmailIntents(db, broken, SENT_AT + 99)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(broken.calls).toBe(MARKETING_ATTEMPT_LIMIT);

    const [after] = await intents();
    expect(after).toMatchObject({ sentAt: null, attempts: MARKETING_ATTEMPT_LIMIT });
    expect(after.lastError).toContain('provider unreachable');
  });

  it('records the provider’s message capped, never the error object', async () => {
    await queuedAward();
    const shouty: Mailer = { send: () => Promise.reject(new Error('x'.repeat(900))) };

    await sweepMarketingEmailIntents(db, shouty, SENT_AT);
    const [after] = await intents();
    expect(after.lastError).toHaveLength(500);
  });
});

// ------------------------------------------------------------------ the claim

describe('the claim is a CAS on attempts, which is why there is no lease column', () => {
  it('two concurrent sweeps deliver once, and the loser skips without sending', async () => {
    /*
     * Both sweeps read `attempts = 0`; both try `SET attempts = 1 WHERE attempts
     * = 0`; one matches. It matters more here than in the shop: nothing schedules
     * this sweep, so its callers are admins inspecting two returns at once and
     * every inspection fires one.
     */
    await queuedAward();
    const mailer = new Recorder();

    const [first, second] = await Promise.all([
      sweepMarketingEmailIntents(db, mailer, SENT_AT),
      sweepMarketingEmailIntents(db, mailer, SENT_AT),
    ]);

    expect(mailer.sent).toHaveLength(1);
    expect(first.sent + second.sent).toBe(1);
    expect(first.skipped + second.skipped).toBe(1);
  });

  it('WITH THE CLAIM PREDICATE NEUTRALISED THE SAME TWO SWEEPS DOUBLE-SEND', async () => {
    /*
     * The mutation half, and the only thing that proves the line above is
     * load-bearing rather than lucky. GAUNTLET II measured that replacing a
     * predicate with `true` broke none of 254 tests; a suite that only asserts
     * "it did not double-send" cannot tell a CAS that prevented it from an
     * ordering that happened not to overlap.
     */
    await queuedAward();
    const mailer = new Recorder();
    const mutant = countingMutant(db, CLAIM_PREDICATE, 'AND true');

    await Promise.all([
      sweepMarketingEmailIntents(mutant.db, mailer, SENT_AT),
      sweepMarketingEmailIntents(mutant.db, mailer, SENT_AT),
    ]);

    expect(mailer.sent).toHaveLength(2);
    // A regex that stopped matching would make this a second copy of the test
    // above: green, and worthless.
    expect(mutant.rewritten()).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------ the route

describe('POST /api/marketing/sweep — contract #27', () => {
  it('drains the queue for any signed-in staff member, not only the owner', async () => {
    /*
     * THE DELIBERATE DEVIATION from the shop's owner-only sweep (spec D6): every
     * body being delivered was frozen by a guard-checked transition, and
     * sweeping is pure delivery. Owner-only would mean a writer's inspection
     * queues a letter only the owner can release — a customer waiting for
     * somebody to log in.
     */
    const { email } = await queuedAward();
    const [queued] = await intents();

    const res = await writer.post(`${API}/sweep`, {});
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: 1, failed: 0, skipped: 0 });

    expect(recorder.sent).toEqual([toMessage(queued)]);
    expect(recorder.sent[0].to).toBe(email);
    expect((await intents())[0].sentAt).not.toBeNull();
  });

  it('answers 401 without a session, and the letter stays queued', async () => {
    await queuedAward();
    const res = await anon.post(`${API}/sweep`, {});
    expect(res.status).toBe(401);
    expect(recorder.sent).toHaveLength(0);
    expect((await intents())[0]).toMatchObject({ sentAt: null, attempts: 0 });
  });

  it('answers 200 with zeros when there is nothing queued', async () => {
    const res = await owner.post(`${API}/sweep`, {});
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });

  it('a deployment with no transport answers EXACTLY 501 mail_not_configured', async () => {
    /*
     * PINS A2's `onError` MAPPING. The shared `MailNotConfiguredError` renders as
     * `{error:'not_implemented', feature:'mail-delivery'}` through the global
     * table — right for the password-reset route, wrong here: spec D6 makes this
     * a persistent ops banner counting the queue, and Stream B keys that banner
     * on `mail_not_configured`. `not_implemented` would render nothing at all.
     *
     * `toEqual` and not `toMatchObject`: a stray `feature` key is a second field
     * naming the same condition, and a second thing to keep in step.
     */
    await queuedAward();
    const res = await setupPending.post(`${API}/sweep`, {});
    expect(res.status).toBe(501);
    expect(await json(res)).toEqual({
      error: 'mail_not_configured',
      requestId: expect.any(String),
    });
  });

  it('the unconfigured answer costs the queue nothing — no attempt, no error recorded', async () => {
    /*
     * WHY `assertConfigured` IS ASKED BEFORE ANYTHING IS CLAIMED. Left to `send`
     * to discover, a missing environment variable would spend one of every
     * letter's eight attempts per sweep and stamp a provider error on a
     * customer's mail — so the queue would degrade permanently because of a
     * setup step nobody had done yet. The fire-and-forget after each inspection
     * makes that a fast burn: eight inspections and the letter is dead.
     */
    await queuedAward();
    await setupPending.post(`${API}/sweep`, {});
    await setupPending.post(`${API}/sweep`, {});

    expect(unconfigured.calls).toBe(0);
    expect((await intents())[0]).toMatchObject({
      sentAt: null,
      attempts: 0,
      lastError: null,
    });
  });
});
