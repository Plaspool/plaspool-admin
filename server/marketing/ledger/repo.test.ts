/**
 * The points ledger, the counter it explains, and the directory that reads
 * both — against a real migrated database.
 *
 * REPO-LEVEL AND NOT THROUGH HTTP, like `returns/repo.test.ts`. What this task
 * adds is the arithmetic: a `balance_after` chain a customer can read, a debit
 * that cannot overdraw, and a union search that finds somebody who has never
 * earned a point. Those are assertions about what a statement wrote and what it
 * refused. `routes.test.ts` mounts the same functions and pins the wire shapes.
 *
 * EVERY FIXTURE USES ABSURD LABELS ("Bottle Cap" / "canister"), and no noun from
 * the seeded preset appears anywhere in this file. A suite whose fixtures
 * happened to match the shipped wording could not tell a label READ FROM A ROW
 * apart from one written in source, which is the single property spec D11's
 * naming discipline is about — and `no-hardcoded-labels.test.ts` greps this
 * directory for exactly that literal.
 *
 * THE NUMBERS ARE FIXTURE NUMBERS, chosen so the arithmetic in the assertions is
 * legible and deliberately not the preset's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { InsufficientBalanceError } from '../errors';
import {
  adjust,
  credit,
  debit,
  getCustomerSummary,
  listCustomers,
  listLedger,
  readBalance,
} from './repo';
import type { Db } from '../../db/client';
import type { BalanceMoveInput } from './repo';

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
  /* The shop's table is read by the directory search and written by nothing in
   * this subsystem — cleared here so one test's stranger is not the next test's
   * surprise row. */
  await db.execute(sql`DELETE FROM shop_customers`);
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

/** A program inserted by SQL rather than through `programs/repo.ts`: this suite
 *  is about the ledger, and building its fixtures through another task's write
 *  path would make its failures ambiguous. */
async function makeProgram(): Promise<string> {
  keySeq += 1;
  const id = `prg_fixture_${keySeq}`;
  await db.execute(sql`
    INSERT INTO marketing_programs
      (id, key, kind, name, points_label_singular, points_label_plural,
       unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
       created_at, updated_at)
    VALUES (${id}, ${`bottle-caps-${keySeq}`}, 'unit_return', 'Cap Returns',
            'Bottle Cap', 'Bottle Caps', 'canister', 'canisters', 4, 10, ${T0}, ${T0})`);
  return id;
}

/** An account in the SHOP's table — the population the directory's second arm
 *  searches. Written by SQL because marketing never imports shop code (D9). */
async function makeAccount(
  id: string,
  email: string | null,
  displayName: string | null = null,
  createdAt = T0,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO shop_customers (id, email, display_name, created_at)
    VALUES (${id}, ${email}, ${displayName}, ${createdAt})`);
}

/** One movement, with everything the executors demand already filled in. Typed
 *  as the real input so an override that does not belong on it is a compile
 *  error rather than a silently ignored key. */
function manual(overrides: Partial<BalanceMoveInput> = {}): BalanceMoveInput {
  return {
    email: EMAIL,
    amount: 100,
    reason: 'Walk-in return',
    kind: 'manual',
    actorType: 'admin',
    actorId: ACTOR,
    now: NOW,
    ...overrides,
  };
}

async function ledgerRows(email = EMAIL) {
  const res = await db.execute(sql`
    SELECT id, kind, delta, balance_after, reason, created_at
      FROM marketing_ledger WHERE customer_email = ${email}
     ORDER BY created_at ASC, id ASC`);
  return res.rows;
}

async function wallet(email = EMAIL) {
  const res = await db.execute(sql`
    SELECT balance, lifetime_earned, customer_id
      FROM marketing_balances WHERE customer_email = ${email}`);
  return res.rows[0] ?? null;
}

// ------------------------------------------------------------- the executors

/**
 * ANY SERVED AREA. Migration 0012 refuses an AWARDED return with no service
 * area, and every fixture in this file is about the ledger rather than about
 * geography — so they ask the seed for a board rather than naming one, which
 * would put a real place name in a test file.
 *
 * MODULE SCOPE, because two describes need it and a `const` inside one of them
 * is not in scope in the other.
 */
const anyServedArea = sql`(SELECT id FROM marketing_service_areas
                            WHERE active ORDER BY id LIMIT 1)`;

describe('credit and debit — the counter is maintained, the ledger explains it', () => {
  it('writes a balance_after chain the customer can read: 100 → 40 → 90', async () => {
    await credit(db, manual({ amount: 100, reason: 'Goodwill', now: NOW }));
    await debit(db, manual({ amount: 60, reason: 'Correction', now: NOW + 1 }));
    await credit(db, manual({ amount: 50, reason: 'Goodwill again', now: NOW + 2 }));

    const rows = await ledgerRows();
    expect(rows.map((r) => [Number(r.delta), Number(r.balance_after)])).toEqual([
      [100, 100],
      [-60, 40],
      [50, 90],
    ]);
    /*
     * `balance_after` IS READ OFF THE COUNTER, not computed here — that is the
     * whole reason the ledger INSERT selects FROM the balance CTE. The
     * assertion is that the two agree, because the screen renders "40 → 90" out
     * of the ledger row and the tile out of the counter.
     */
    expect(Number((await wallet())?.balance)).toBe(90);
  });

  it('creates the wallet on a first credit and refuses to create one on a debit', async () => {
    expect(await wallet('nobody@example.test')).toBeNull();

    const refused = await rejection<InsufficientBalanceError>(
      debit(db, manual({ email: 'nobody@example.test', amount: 1 })),
    );
    expect(refused).toBeInstanceOf(InsufficientBalanceError);
    expect(refused.balance).toBe(0);
    /* NOT a wallet at zero that then failed a CHECK: nothing was written at all.
     * "No wallet" and "not enough in the wallet" are one answer to the customer,
     * and one statement to the database. */
    expect(await wallet('nobody@example.test')).toBeNull();
    expect(await ledgerRows('nobody@example.test')).toHaveLength(0);

    await credit(db, manual({ email: 'nobody@example.test', amount: 5 }));
    expect(Number((await wallet('nobody@example.test'))?.balance)).toBe(5);
  });

  it('refuses the second of two debits decided against the same balance — the race', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE CONCURRENT-DEBIT RACE, IN A SINGLE-CONNECTION DATABASE.
     *
     * PGlite runs one connection, so two truly simultaneous statements cannot be
     * issued. What can be reproduced is the thing that actually goes wrong: two
     * callers that BOTH read a balance of 100 and both decide 60 is affordable.
     * A design that checked affordability in TypeScript would let both through —
     * both checks pass against the snapshot each caller read — and the second
     * would drive the balance to −20 or, with the CHECK in place, to a 500.
     *
     * Here the decision is not in TypeScript. `WHERE balance >= amount` is
     * evaluated by the statement that does the subtraction, so the second debit
     * matches zero rows, its ledger INSERT selects from an empty CTE, and
     * nothing is written. That is the property, and it does not depend on how
     * the two calls were interleaved.
     * ═══════════════════════════════════════════════════════════════════════
     */
    await credit(db, manual({ amount: 100, reason: 'Goodwill' }));

    const seenByBoth = await readBalance(db, EMAIL);
    expect(seenByBoth).toBe(100);
    expect(seenByBoth).toBeGreaterThanOrEqual(60);

    const first = await debit(db, manual({ amount: 60, reason: 'Spend', now: NOW + 1 }));
    expect(first.balance).toBe(40);

    const second = await rejection<InsufficientBalanceError>(
      debit(db, manual({ amount: 60, reason: 'Spend', now: NOW + 2 })),
    );
    expect(second).toBeInstanceOf(InsufficientBalanceError);
    /* The LIVE balance, not the 100 both callers were holding. The client's copy
     * quotes it ("this customer has 40"). */
    expect(second.balance).toBe(40);

    const debits = (await ledgerRows()).filter((r) => Number(r.delta) < 0);
    expect(debits).toHaveLength(1);
    expect(Number((await wallet())?.balance)).toBe(40);
  });

  it('keeps SUM(delta) equal to the balance across a generated sequence', async () => {
    /*
     * The invariant spec D3 states outright. It is checked over a SEQUENCE
     * rather than over one pair because the failure it guards against is
     * cumulative: a path that maintains the counter and forgets a ledger row (or
     * the reverse) is correct on the first write and wrong forever after.
     */
    const moves = [+40, +15, -25, +100, -60, -10, +7, -12];
    let expected = 0;
    let clock = NOW;

    for (const delta of moves) {
      clock += 1;
      const input = manual({ amount: Math.abs(delta), reason: `move ${delta}`, now: clock });
      const result = delta > 0 ? await credit(db, input) : await debit(db, input);
      expected += delta;
      // Every row's own claim about the balance is checked as it is written, so
      // a drift is attributed to the move that caused it rather than to the end.
      expect(result.balance).toBe(expected);
    }

    const sum = await db.execute(sql`
      SELECT coalesce(sum(delta), 0)::int AS total FROM marketing_ledger
       WHERE customer_email = ${EMAIL}`);
    expect(Number(sum.rows[0].total)).toBe(expected);
    expect(Number((await wallet())?.balance)).toBe(expected);
  });

  it('counts credits into lifetime_earned and leaves it where it is on a debit', async () => {
    /* "Earned 700 and spent 700" must read as loyal, not as a stranger — which
     * is why the counter is not derivable from the balance. */
    await credit(db, manual({ amount: 500, reason: 'Goodwill' }));

    /*
     * THE SECOND CREDIT IS THE ONE THAT MATTERS, and a suite that credited once
     * proved nothing about it: the upsert's INSERT arm sets `lifetime_earned`
     * from the amount, and its ON CONFLICT arm ADDS to what is already there.
     * Only the first credit a customer ever receives takes the first arm; every
     * credit afterwards takes the second. Measured — with the ON CONFLICT arm's
     * `+ EXCLUDED.lifetime_earned` deleted, a single-credit fixture still passed.
     */
    await credit(db, manual({ amount: 200, reason: 'Goodwill again', now: NOW + 1 }));
    expect(Number((await wallet())?.lifetime_earned)).toBe(700);

    await debit(db, manual({ amount: 700, reason: 'Spend', now: NOW + 2 }));

    const row = await wallet();
    expect(Number(row?.balance)).toBe(0);
    expect(Number(row?.lifetime_earned)).toBe(700);
  });

  it('stamps the shop id on a first credit and never overwrites it afterwards', async () => {
    await credit(db, manual({ amount: 10, customerId: 'cus_first' }));
    expect((await wallet())?.customer_id).toBe('cus_first');

    /* FIRST WRITER WINS. The id arriving with a later credit is whoever happened
     * to be signed in; the one on the row is the account the wallet belongs to. */
    await credit(db, manual({ amount: 10, customerId: 'cus_second', now: NOW + 1 }));
    expect((await wallet())?.customer_id).toBe('cus_first');
  });

  it('serves the redemption kinds the checkout seam will hand it, order id and all', async () => {
    /* A8 wraps these same executors for `redeem()` and `release()`. The couplings
     * `marketing_ledger_order_link_ck` and the two sign CHECKs are what this
     * proves is satisfiable through them — a debit that could not carry an order
     * id would not be usable there at all. */
    await credit(db, manual({ amount: 100, reason: 'Goodwill' }));
    const spent = await debit(
      db,
      manual({ amount: 30, kind: 'redemption', reason: 'Paid for order', orderId: 'ord_1', now: NOW + 1 }),
    );
    expect(spent.balance).toBe(70);

    const back = await credit(
      db,
      manual({
        amount: 30,
        kind: 'redemption_release',
        reason: 'Order cancelled',
        orderId: 'ord_1',
        now: NOW + 2,
      }),
    );
    expect(back.balance).toBe(100);

    const kinds = (await ledgerRows()).map((r) => String(r.kind));
    expect(kinds).toEqual(['manual', 'redemption', 'redemption_release']);
  });
});

// ------------------------------------------------------------- adjustments

describe('adjust — contract #18', () => {
  it('refuses a zero delta and an empty reason by field name, writing nothing', async () => {
    const zero = await rejection<BadRequestError>(
      adjust(db, { email: EMAIL, delta: 0, reason: 'Goodwill', actorId: ACTOR, now: NOW }),
    );
    expect(zero).toBeInstanceOf(BadRequestError);
    /* `delta`, which is what the body calls it — the inline error has to land on
     * the amount input. Reaching `marketing_ledger_delta_ck` instead would be a
     * 500 the client retries five times. */
    expect(zero.detail).toBe('delta');

    const blank = await rejection<BadRequestError>(
      adjust(db, { email: EMAIL, delta: 10, reason: '   ', actorId: ACTOR, now: NOW }),
    );
    expect(blank.detail).toBe('reason');

    expect(await ledgerRows()).toHaveLength(0);
    expect(await wallet()).toBeNull();
  });

  it('refuses an unknown programId as a field error, not a foreign-key 500', async () => {
    const err = await rejection<BadRequestError>(
      adjust(db, {
        email: EMAIL,
        delta: 10,
        reason: 'Goodwill',
        programId: 'prg_not_here',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('programId');
  });

  it('names the blank reason before it goes looking for the programId', async () => {
    /*
     * THE ORDER IS THE ASSERTION, and it is the only thing that earns the blank
     * check in `adjust` its place: `move` refuses an empty reason too, so a
     * fixture with one bad field cannot tell the two checks apart. With BOTH
     * fields wrong the inline error has to land on the box the admin actually
     * left empty rather than on a `programId` the form filled in from a Select —
     * delete the check and this reads `programId`, which points at a control
     * that is not the problem.
     */
    const err = await rejection<BadRequestError>(
      adjust(db, {
        email: EMAIL,
        delta: 10,
        reason: '   ',
        programId: 'prg_not_here',
        actorId: ACTOR,
        now: NOW,
      }),
    );
    expect(err.detail).toBe('reason');
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('credits or debits by the sign, and answers with the entry and the balance', async () => {
    const programId = await makeProgram();

    const up = await adjust(db, {
      email: 'DARA@Example.Test',
      delta: 60,
      reason: 'Walk-in return — 6 canisters',
      programId,
      customerId: 'cus_dara',
      actorId: ACTOR,
      now: NOW,
    });
    expect(up.balance).toBe(60);
    expect(up.entry).toMatchObject({
      kind: 'manual',
      delta: 60,
      balanceAfter: 60,
      reason: 'Walk-in return — 6 canisters',
      programId,
      /* The program's CURRENT name, joined at read time — a live pointer beside
       * the frozen `reason`, not a second copy of it. */
      programName: 'Cap Returns',
      returnRequestId: null,
      orderId: null,
      actorType: 'admin',
      actorId: ACTOR,
      createdAt: NOW,
    });
    expect(up.entry.id.startsWith('pts_')).toBe(true);

    /* The address was folded on the way in — `DARA@Example.Test` is the wallet
     * `dara@example.test`, or a customer has two balances and neither is right. */
    expect(Number((await wallet())?.balance)).toBe(60);

    const down = await adjust(db, {
      email: EMAIL,
      delta: -40,
      reason: 'Correction',
      actorId: ACTOR,
      now: NOW + 1,
    });
    expect(down.balance).toBe(20);
    expect(down.entry).toMatchObject({ delta: -40, balanceAfter: 20, programName: null });
  });

  it('carries the live balance on insufficient_balance and writes nothing', async () => {
    await adjust(db, { email: EMAIL, delta: 40, reason: 'Goodwill', actorId: ACTOR, now: NOW });

    const err = await rejection<InsufficientBalanceError>(
      adjust(db, { email: EMAIL, delta: -60, reason: 'Correction', actorId: ACTOR, now: NOW + 1 }),
    );
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err.balance).toBe(40);
    expect(await ledgerRows()).toHaveLength(1);
    expect(Number((await wallet())?.balance)).toBe(40);
  });
});

// ------------------------------------------------------------- the history

describe('listLedger — contract #17', () => {
  async function history(): Promise<void> {
    const programId = await makeProgram();
    await credit(db, manual({ amount: 50, reason: 'Goodwill', now: NOW }));
    await credit(
      db,
      manual({
        amount: 70,
        kind: 'return_award',
        programId,
        returnRequestId: await makeAward(programId),
        reason: 'Cap Returns: 7 canisters accepted',
        now: NOW + 1,
      }),
    );
    await debit(
      db,
      manual({ amount: 30, kind: 'redemption', orderId: 'ord_9', reason: 'Spent', now: NOW + 2 }),
    );
    await credit(
      db,
      manual({
        amount: 30,
        kind: 'redemption_release',
        orderId: 'ord_9',
        reason: 'Refunded',
        now: NOW + 3,
      }),
    );
  }

  /**
   * A return row for the award to hang off — `marketing_ledger_award_link_ck`
   * demands one and the FK demands it exist.
   *
   * The quantities are filled in because `marketing_return_requests_award_ck`
   * pins the money on any row claiming `awarded`: seven accepted at ten a unit
   * is seventy, and the database will not take the row otherwise.
   */
  async function makeAward(programId: string): Promise<string> {
    const id = `ret_fixture_${(keySeq += 1)}`;
    await db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, qty_accepted, qty_rejected,
         points_per_unit_snapshot, points_awarded, source, status, service_area_id,
         created_at, updated_at)
      VALUES (${id}, ${programId}, ${EMAIL}, 7, 7, 0, 10, 70, 'admin', 'awarded',
              ${anyServedArea}, ${T0}, ${T0})`);
    return id;
  }

  it('filters by kind, and "redemptions" means both sides of one', async () => {
    await history();

    expect((await listLedger(db, EMAIL, { kind: 'all' })).items).toHaveLength(4);
    expect((await listLedger(db, EMAIL, { kind: 'manual' })).items.map((e) => e.kind)).toEqual([
      'manual',
    ]);
    expect((await listLedger(db, EMAIL, { kind: 'awards' })).items.map((e) => e.kind)).toEqual([
      'return_award',
    ]);
    /*
     * BOTH SIDES. A cancelled order that was paid for with points has the debit
     * and the credit that undid it; showing one without the other makes a spend
     * look permanent when it was refunded. Newest first, so the release leads.
     */
    expect(
      (await listLedger(db, EMAIL, { kind: 'redemptions' })).items.map((e) => e.kind),
    ).toEqual(['redemption_release', 'redemption']);
  });

  it('carries the program name on an award and null on an adjustment', async () => {
    await history();
    const items = (await listLedger(db, EMAIL)).items;
    const award = items.find((e) => e.kind === 'return_award');
    const adjustment = items.find((e) => e.kind === 'manual');
    expect(award?.programName).toBe('Cap Returns');
    expect(award?.reason).toContain('canisters');
    expect(adjustment?.programName).toBeNull();
  });

  it('pages by keyset newest-first without skipping or repeating a row', async () => {
    /* Thirty rows, one per millisecond, so the ordering is total by `created_at`
     * alone and a boundary defect is visible rather than masked by the id
     * tiebreak. */
    for (let i = 0; i < 30; i += 1) {
      await credit(db, manual({ amount: 1, reason: `move ${i}`, now: NOW + i }));
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await listLedger(db, EMAIL, { limit: 12, cursor: cursor ?? undefined });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);

    const walked = (await listLedger(db, EMAIL, { limit: 100 })).items.map((e) => e.id);
    expect(seen).toEqual(walked);
    // Newest first: the last credit written is the first row read.
    expect((await listLedger(db, EMAIL, { limit: 1 })).items[0].reason).toBe('move 29');
  });

  it('refuses a cursor minted under another ordering', async () => {
    await credit(db, manual({ amount: 1 }));
    const foreign = Buffer.from(JSON.stringify(['queue', [NOW], 'pts_x']), 'utf8').toString(
      'base64url',
    );
    const err = await rejection<BadRequestError>(listLedger(db, EMAIL, { cursor: foreign }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('cursor');
  });
});

// -------------------------------------------------------------- the summary

describe('getCustomerSummary — contract #16', () => {
  it('answers zeros for an address nobody has ever heard of, and not a miss', async () => {
    /*
     * The walk-in escape depends on this. The no-match empty state offers
     * "Credit <typed email> anyway →", which lands here — and a `gone` would
     * render a whole-screen "no longer exists" for the person the admin is
     * about to create a wallet for.
     */
    expect(await getCustomerSummary(db, 'stranger@example.test')).toEqual({
      email: 'stranger@example.test',
      customerId: null,
      displayName: null,
      balance: 0,
      lifetimeEarned: 0,
      openReturn: null,
    });
  });

  it('carries the balance, the account behind the address and the open return', async () => {
    const programId = await makeProgram();
    await makeAccount('cus_dara', 'Dara@Example.Test', 'Dara A.');
    await credit(db, manual({ amount: 90, reason: 'Goodwill' }));
    await debit(db, manual({ amount: 20, reason: 'Spend', now: NOW + 1 }));
    await db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, points_per_unit_snapshot,
         source, status, created_at, updated_at)
      VALUES ('ret_open_1', ${programId}, ${EMAIL}, 6, 10, 'customer', 'received',
              ${T0}, ${T0})`);

    expect(await getCustomerSummary(db, EMAIL)).toEqual({
      email: EMAIL,
      /* Resolved through the join: the wallet was created by a credit that
       * carried no id, and the address has an account. "Guest — no account" is
       * a claim about today, not about the day the points were earned. */
      customerId: 'cus_dara',
      displayName: 'Dara A.',
      balance: 70,
      lifetimeEarned: 90,
      openReturn: { id: 'ret_open_1', status: 'received' },
    });
  });

  it('does not report a closed return as the open one', async () => {
    const programId = await makeProgram();
    await db.execute(sql`
      INSERT INTO marketing_return_requests
        (id, program_id, customer_email, qty_declared, qty_accepted, qty_rejected,
         points_per_unit_snapshot, points_awarded, source, status, service_area_id,
         created_at, updated_at)
      VALUES ('ret_done_1', ${programId}, ${EMAIL}, 6, 6, 0, 10, 60, 'admin', 'awarded',
              ${anyServedArea}, ${T0}, ${T0})`);
    expect((await getCustomerSummary(db, EMAIL)).openReturn).toBeNull();
  });
});

// ------------------------------------------------------------ the directory

describe('listCustomers — contract #15', () => {
  it('lists balance-holders most-recently-moved first when nothing is typed', async () => {
    await credit(db, manual({ email: 'old@example.test', amount: 10, now: NOW }));
    await credit(db, manual({ email: 'mid@example.test', amount: 20, now: NOW + 100 }));
    await credit(db, manual({ email: 'new@example.test', amount: 30, now: NOW + 200 }));

    const page = await listCustomers(db);
    expect(page.items.map((r) => r.email)).toEqual([
      'new@example.test',
      'mid@example.test',
      'old@example.test',
    ]);
    expect(page.items[0]).toMatchObject({
      balance: 30,
      lifetimeEarned: 30,
      guest: true,
      customerId: null,
      lastEntryAt: NOW + 200,
      /* The reason VERBATIM — the summary line is what was written, never a
       * re-render through today's labels. */
      lastEntry: { kind: 'manual', delta: 30, reason: 'Walk-in return' },
    });
  });

  it('leaves the shop directory out entirely when nothing is typed', async () => {
    await makeAccount('cus_never', 'never@example.test');
    await credit(db, manual({ amount: 10 }));

    /* "Recently active" is the wallets. A customer who has never earned a point
     * is not recently active, and scanning the shop's whole customer table on
     * every idle page load would be a question this screen never asked. */
    expect((await listCustomers(db)).items.map((r) => r.email)).toEqual([EMAIL]);
  });

  it('finds a shop account with no points history and flags the guest correctly', async () => {
    await makeAccount('cus_walkin', 'Walkin@Example.Test', 'Walk In', T0 + 5);
    await credit(db, manual({ email: 'walker@example.test', amount: 12, now: NOW }));

    const page = await listCustomers(db, { query: 'walk' });
    const rows = new Map(page.items.map((r) => [r.email, r]));
    expect([...rows.keys()].sort()).toEqual(['walker@example.test', 'walkin@example.test']);

    /* The account with no wallet: zeros, its own display name, and NOT a guest —
     * it has an id. This row is the whole reason the second union arm exists. */
    expect(rows.get('walkin@example.test')).toEqual({
      email: 'walkin@example.test',
      customerId: 'cus_walkin',
      displayName: 'Walk In',
      guest: false,
      balance: 0,
      lifetimeEarned: 0,
      lastEntryAt: null,
      lastEntry: null,
    });
    /* The wallet with no account: a guest, which is the DEFAULT path (spec D10)
     * and not a degenerate case. */
    expect(rows.get('walker@example.test')).toMatchObject({ guest: true, balance: 12 });
  });

  it('finds a wallet by the id of the account behind it, not only the id it stored', async () => {
    /*
     * THE COMMON CASE, NOT A CORNER. Contract #5/#6 accept no `customerId`, so a
     * customer who earned every point they have by sending things back has a
     * wallet whose `customer_id` is NULL — and matching that column alone
     * answered "no customers" for an id this same directory renders the moment
     * the ADDRESS is typed instead. One screen, two answers about one person,
     * depending on which of their two handles the admin was given.
     */
    await makeAccount('cus_ghost', 'ghost@example.test', 'Ghost');
    await credit(db, manual({ email: 'ghost@example.test', amount: 10 }));
    expect((await wallet('ghost@example.test'))?.customer_id).toBeNull();

    const byId = await listCustomers(db, { query: 'cus_ghost' });
    expect(byId.items.map((r) => r.email)).toEqual(['ghost@example.test']);
    /* ONE line, carrying the REAL balance — answered by the wallet arm, not by
     * the directory arm's zero. */
    expect(byId.items[0]).toMatchObject({
      balance: 10,
      lifetimeEarned: 10,
      customerId: 'cus_ghost',
      guest: false,
    });
  });

  it('matches an email prefix and a customer-id prefix, and only a prefix', async () => {
    await credit(db, manual({ email: 'dara@example.test', amount: 10, customerId: 'cus_abc123' }));
    await credit(db, manual({ email: 'sam@example.test', amount: 10, now: NOW + 1 }));

    expect((await listCustomers(db, { query: 'dar' })).items.map((r) => r.email)).toEqual([
      'dara@example.test',
    ]);
    /* The id is matched as typed. It is an opaque handle minted with its own
     * case, unlike the address, which every column here stores folded. */
    expect((await listCustomers(db, { query: 'cus_abc' })).items.map((r) => r.email)).toEqual([
      'dara@example.test',
    ]);
    /* A PREFIX AND NOT A SUBSTRING: this box finds the customer you were given,
     * it does not let one be discovered by typing fragments. */
    expect((await listCustomers(db, { query: 'example.test' })).items).toEqual([]);
    /* And the term is folded before it is compared. */
    expect((await listCustomers(db, { query: 'DARA@' })).items.map((r) => r.email)).toEqual([
      'dara@example.test',
    ]);
  });

  it('skips shop accounts with no email at all', async () => {
    /* `shop_customers.email` is nullable — a session that has not identified
     * itself yet. This subsystem keys on the address, so a row without one has
     * no wallet to show and no way to be credited (spec D10). */
    await makeAccount('cus_anon', null, 'Nameless');
    expect((await listCustomers(db, { query: 'cus_anon' })).items).toEqual([]);
  });

  it('shows one line for an address the shop stored twice in different cases', async () => {
    /* `shop_customers_email_uq` is UNIQUE on the RAW column, so these are two
     * legal rows and ONE customer. A plain join would have emitted both, each
     * spending a slot of the page limit. */
    await makeAccount('cus_upper', 'Twice@Example.Test');
    await makeAccount('cus_lower', 'twice@example.test');

    const items = (await listCustomers(db, { query: 'twice' })).items;
    expect(items.map((r) => r.email)).toEqual(['twice@example.test']);
    expect(items[0].guest).toBe(false);
  });

  it('pages by keyset without skipping or repeating a wallet', async () => {
    for (let i = 0; i < 25; i += 1) {
      await credit(
        db,
        manual({ email: `holder${i}@example.test`, amount: 1, now: NOW + i }),
      );
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await listCustomers(db, { limit: 10, cursor: cursor ?? undefined });
      seen.push(...page.items.map((r) => r.email));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe('holder24@example.test');
  });
});
