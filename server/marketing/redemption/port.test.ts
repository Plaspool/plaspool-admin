/**
 * The redemption seam, exercised directly — spec D9's port over real tables.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING CALLS THIS PORT YET, WHICH IS WHY THE SUITE IS THE SPECIFICATION. The
 * cart is shop-owned and hard-codes `adjustments: []`; when it takes the
 * dependency, what it will rely on is exactly what is asserted here — a quote
 * that reserves nothing, a debit that is idempotent per order, and a credit that
 * gives points back when an order is undone.
 *
 * THE THREE PROPERTIES WORTH BREAKING A BUILD OVER:
 *
 * 1. **A replay is never a refusal.** A webhook that fires twice, a shop that
 *    switched redemption off this morning, a wallet that has since been spent to
 *    zero, an order already cancelled and released — none of them may turn
 *    "redeem this order again" into anything but the entry that already exists.
 *    One test per way it could go wrong, and the last section stages the two
 *    that need a writer this database cannot run concurrently.
 * 2. **No overdraft, and no second implementation of balance arithmetic.** Every
 *    movement goes through A6's executors, so `balance_after` is what the counter
 *    holds and the refusal is the SQL guard rather than a check in TypeScript.
 * 3. **The cap is a cap.** `max_redeem_bps` is a share of an order, and every
 *    rounding decision around it goes the direction that cannot exceed it.
 *
 * THE FIXTURES USE ABSURD WORDS ("Bottle Cap"/"Bottle Caps") and the arithmetic
 * uses fixture numbers, deliberately not the seeded preset's. The absence
 * assertions are built from the SEED ROW read at start-up rather than from
 * literals in this file — the same arrangement `notify/mailer.test.ts` uses, and
 * for the same two reasons: a suite whose fixtures matched the shipped wording
 * could not tell a label READ FROM A ROW from one written in source, and the
 * assertion keeps testing the right thing if the seed is ever edited.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { credit, debit, readBalance } from '../ledger/repo';
import { REDEMPTION_ADJUSTMENT_CODE, redemptionPort } from './port';
import type { Db } from '../../db/client';
import type { PointsRedemptionPort } from '../../../shared/marketing/redemption';
import type { LedgerKind } from '../ledger/fragments';

let db: Db;
let close: () => Promise<void>;
let port: PointsRedemptionPort;

/** The `when` migration 0011 carries, reused as the fixtures' clock. */
const T0 = 1786600001000;
const NOW = T0 + 60_000;
const ACTOR = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'dara@example.test';
const ORDER = 'ord_fixture_1';

/**
 * WHAT THE CUSTOMER CALLS THE SAME ORDER. Held apart from `ORDER` on purpose and
 * sharing no substring with it: an assertion that passed for both would not be
 * able to tell the two apart, which is the entire bug this pair pins down.
 */
const ORDER_NUMBER = '2026-000009-D';

/** ISO-4217 is a code, not a customer-facing noun — it may be written down. */
const CURRENCY = 'NGN';

/** The shop's words for its points, in this deployment. */
const CAPS = { one: 'Bottle Cap', other: 'Bottle Caps' };

/**
 * The fixture economics: 100 points are worth 500 minor units, so one point is
 * five. Chosen so every expected number below is legible arithmetic rather than
 * something the reader has to trust.
 */
const RATE = { points: 100, minor: 500 };

/** Every word the SEEDED settings row lends a customer, read from the row before
 *  anything overwrites it. */
let presetWords: string[] = [];

beforeAll(async () => {
  ({ db, close } = await migratedDb());
  const res = await db.execute(sql`
    SELECT points_label_singular, points_label_plural
      FROM marketing_settings WHERE id = 'main'`);
  presetWords = Object.values(res.rows[0] ?? {}).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  // A seed that stopped seeding would make every absence assertion below vacuous.
  expect(presetWords.length).toBeGreaterThan(0);
  port = redemptionPort(db, () => NOW);
});

afterAll(() => close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE marketing_ledger, marketing_balances CASCADE`);
  await configure();
});

// ------------------------------------------------------------------- fixtures

interface Economics {
  enabled: boolean;
  ratePoints: number;
  rateMinor: number;
  currency: string;
  minRedeem: number;
  maxBps: number;
}

/**
 * The singleton, rewritten to this suite's words and economics.
 *
 * AN UPDATE AND NOT AN INSERT: `marketing_settings_id_ck` pins the row to
 * `id = 'main'` and migration 0011 seeds it, so there is exactly one to rewrite —
 * which is also what makes the preset words above worth capturing first.
 */
async function configure(over: Partial<Economics> = {}): Promise<void> {
  const e: Economics = {
    enabled: true,
    ratePoints: RATE.points,
    rateMinor: RATE.minor,
    currency: CURRENCY,
    minRedeem: 0,
    maxBps: 10_000,
    ...over,
  };
  await db.execute(sql`
    UPDATE marketing_settings
       SET points_label_singular = ${CAPS.one},
           points_label_plural = ${CAPS.other},
           redemption_enabled = ${e.enabled},
           redemption_rate_points = ${e.ratePoints},
           redemption_rate_minor = ${e.rateMinor},
           redemption_currency = ${e.currency},
           min_redeem_points = ${e.minRedeem},
           max_redeem_bps = ${e.maxBps},
           updated_at = ${NOW}
     WHERE id = 'main'`);
}

/** Points into a wallet, through the same executor everything else uses — a
 *  balance assembled by hand-written SQL would not prove the port can read one
 *  the subsystem actually writes. */
async function fund(points: number, email = EMAIL): Promise<void> {
  await credit(db, {
    email,
    amount: points,
    reason: 'Opening balance',
    kind: 'manual',
    actorType: 'admin',
    actorId: ACTOR,
    now: T0,
  });
}

async function rowsOfKind(kind: string, email = EMAIL) {
  const res = await db.execute(sql`
    SELECT id, kind, delta, balance_after, reason, order_id, actor_type
      FROM marketing_ledger
     WHERE customer_email = ${email} AND kind = ${kind}
     ORDER BY created_at ASC, id ASC`);
  return res.rows;
}

async function ledgerCount(): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM marketing_ledger`);
  return Number(res.rows[0]?.n);
}

async function lifetimeEarned(email = EMAIL): Promise<number> {
  const res = await db.execute(sql`
    SELECT lifetime_earned FROM marketing_balances WHERE customer_email = ${email}`);
  return Number(res.rows[0]?.lifetime_earned ?? 0);
}

/** The rejection itself, typed — `.catch(e => e)` widens to `T | error`. A local
 *  copy of the sibling suites' helper: spec D9 puts `server/shop/**` out of
 *  reach, so marketing carries its own. */
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

const cart = (cartTotalMinor: number, over: Partial<{ pointsRequested: number }> = {}) => ({
  email: EMAIL,
  currency: CURRENCY,
  cartTotalMinor,
  ...over,
});

/**
 * A handle whose FIRST look at the ledger cannot see one kind of row.
 *
 * THE RACE, IN A DATABASE WITH ONE CONNECTION. `port.ts` has two `catch` blocks
 * that only a concurrent writer reaches, and nothing above gets near them: every
 * replay staged there is answered by the up-front read long before a write is
 * attempted, so the recovery those blocks perform was asserted by no test at
 * all. PGlite cannot issue two statements at once — but the interleaving is not
 * the property. The property is what happens FROM the state it leaves: a first
 * read that missed a row which is already committed, and every statement after
 * it seeing the truth. That is what this reproduces, and it is the same argument
 * `ledger/repo.test.ts` makes for the debit's guard.
 *
 * The `Proxy` shape is `returns/mutate.test.ts`'s `countingMutant`, minus the
 * rewrite — nothing about the statement's own SQL is under test here, only what
 * the port does with an answer that is one row short. The count is asserted, so
 * a refactor that stopped reading the ledger first would fail rather than
 * silently make these tests about nothing.
 */
function blindOnce(kind: LedgerKind): { db: Db; blinded: () => number } {
  let blinded = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (
        ...args: unknown[]
      ) => Promise<{ rows: Record<string, unknown>[] }>;
      return async (...args: unknown[]) => {
        const res = await execute.apply(target, args);
        if (blinded > 0) return res;
        blinded += 1;
        return { ...res, rows: res.rows.filter((row) => row.kind !== kind) };
      };
    },
  });
  return { db: proxy, blinded: () => blinded };
}

// ---------------------------------------------------------------------- quote

describe('quote — what a balance is worth against a cart', () => {
  it('converts points to money through the settings rational, and the discount is negative', async () => {
    await fund(300);

    const quote = await port.quote(cart(100_000));

    // 300 points × 500 minor per 100 points.
    expect(quote).toEqual({
      adjustment: {
        code: REDEMPTION_ADJUSTMENT_CODE,
        label: `300 ${CAPS.other} redeemed`,
        amount: { amount: -1500, currency: CURRENCY },
      },
      points: 300,
      balanceAfter: 0,
    });
  });

  it('spends only what was asked for when a number is named', async () => {
    await fund(300);

    const quote = await port.quote(cart(100_000, { pointsRequested: 100 }));

    expect(quote?.points).toBe(100);
    expect(quote?.adjustment.amount.amount).toBe(-500);
    expect(quote?.balanceAfter).toBe(200);
  });

  it('clamps a request to the balance rather than refusing it', async () => {
    await fund(120);

    // "Omitted means as much as the rules allow" — so a number that is too large
    // is a customer asking for more than they have, not a malformed request.
    const quote = await port.quote(cart(100_000, { pointsRequested: 900 }));

    expect(quote?.points).toBe(120);
    expect(quote?.balanceAfter).toBe(0);
  });

  it('clamps to the share of the cart max_redeem_bps allows', async () => {
    await configure({ maxBps: 2500 });
    await fund(300);

    // 25% of 4000 minor is 1000 minor, which 200 points buy.
    const quote = await port.quote(cart(4000));

    expect(quote?.points).toBe(200);
    expect(quote?.adjustment.amount.amount).toBe(-1000);
    expect(quote?.balanceAfter).toBe(100);
  });

  it('rounds the cap down, so a share of a cart is never exceeded', async () => {
    await configure({ maxBps: 345 });
    await fund(300);

    /*
     * 3.45% of 1000 minor is 34.5, which is 34 as an integer share. Six points
     * are worth 30 of it; seven would be worth 35 — over the share, and exactly
     * what a cap rounded the other way would hand out. The numbers straddle a
     * multiple of the rate on purpose: at 33.33% of 100 both directions agree,
     * and the assertion would prove nothing.
     */
    const quote = await port.quote(cart(1000));

    expect(quote?.points).toBe(6);
    expect(quote?.adjustment.amount.amount).toBe(-30);
  });

  it('rounds a part-unit conversion half-up', async () => {
    // Three points to one minor unit, so two points are two thirds of one.
    await configure({ ratePoints: 3, rateMinor: 1 });
    await fund(2);

    const quote = await port.quote(cart(100_000));

    expect(quote?.points).toBe(2);
    expect(quote?.adjustment.amount.amount).toBe(-1);
  });

  it('is null when the points buy nothing', async () => {
    await configure({ ratePoints: 3, rateMinor: 1 });
    await fund(1);

    // One third of a minor unit rounds to nothing, and a widget offering a
    // discount of zero is worse than no widget.
    expect(await port.quote(cart(100_000))).toBeNull();
  });

  it('is null below min_redeem_points', async () => {
    await configure({ minRedeem: 500 });
    await fund(300);

    expect(await port.quote(cart(100_000))).toBeNull();
  });

  it('is null while redemption is switched off', async () => {
    await configure({ enabled: false });
    await fund(300);

    expect(await port.quote(cart(100_000))).toBeNull();
  });

  it('is null for a cart priced in another currency', async () => {
    await fund(300);

    // There is no conversion step in this system, so points priced in one
    // currency cannot discount a cart denominated in another.
    expect(await port.quote({ ...cart(100_000), currency: 'USD' })).toBeNull();
  });

  it('is null for a wallet with no points', async () => {
    expect(await port.quote(cart(100_000))).toBeNull();
  });

  it('writes nothing — it is a read, and it does not reserve', async () => {
    await fund(300);

    await port.quote(cart(100_000));
    await port.quote(cart(100_000, { pointsRequested: 50 }));

    // The opening balance and its one ledger row, untouched.
    expect(await readBalance(db, EMAIL)).toBe(300);
    expect(await ledgerCount()).toBe(1);
  });

  it('refuses a cart total that is not a whole number of minor units', async () => {
    await fund(300);

    /*
     * NOT `null`. Every other refusal here is "render no widget", but a float
     * total is a CALLER'S bug, and hiding it behind the same silent answer would
     * make the one number the cap is computed from something nobody ever
     * notices being wrong.
     */
    const err = await rejection<BadRequestError>(port.quote(cart(100.5)));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('cartTotalMinor');
  });

  it('refuses a negative request rather than quietly treating it as none', async () => {
    await fund(300);

    // Left unchecked this clamps to a negative `spend`, falls out of the
    // `points <= 0` gate and renders as "no widget" — a wrong argument wearing
    // an ordinary answer.
    const err = await rejection<BadRequestError>(
      port.quote(cart(100_000, { pointsRequested: -5 })),
    );
    expect(err.detail).toBe('pointsRequested');
  });

  it('carries the machine code the shop matches on, spelled out', async () => {
    await fund(300);

    /*
     * THE LITERAL, not the constant this file imports. Asserting the import
     * against itself is true by construction, and `code` is precisely the field
     * that must survive the rename that moves the label beside it — it is what
     * the shop's totals, its invoices and any later reconciliation match on.
     */
    expect((await port.quote(cart(100_000)))?.adjustment.code).toBe('points_redemption');
    expect(REDEMPTION_ADJUSTMENT_CODE).toBe('points_redemption');
  });

  it('names the points in the settings words, never the shipped preset’s', async () => {
    await fund(300);

    const label = (await port.quote(cart(100_000)))?.adjustment.label ?? '';

    expect(label).toContain(CAPS.other);
    for (const word of presetWords) {
      expect(label, `preset word "${word}" reached a customer`).not.toContain(word);
    }
  });
});

// --------------------------------------------------------------------- redeem

describe('redeem — the debit at order commit', () => {
  const spend = (
    over: Partial<{
      orderId: string;
      orderNumber: string;
      points: number;
      currency: string;
    }> = {},
  ) => ({
    orderId: ORDER,
    orderNumber: ORDER_NUMBER,
    email: EMAIL,
    points: 100,
    currency: CURRENCY,
    ...over,
  });

  it('debits the balance and records the order that spent it', async () => {
    await fund(300);

    const result = await port.redeem(spend());

    expect(result).toEqual({ ok: true, entryId: expect.any(String), balance: 200 });
    expect(await readBalance(db, EMAIL)).toBe(200);

    const [row] = await rowsOfKind('redemption');
    expect(row).toMatchObject({
      delta: -100,
      balance_after: 200,
      order_id: ORDER,
      // Nobody typed this: a customer spent their own points at a checkout.
      actor_type: 'customer',
    });
    // Render-final, in the words of this instant.
    expect(row?.reason).toBe(`Order ${ORDER_NUMBER}: 100 ${CAPS.other} spent`);
    // The internal id is written STRUCTURALLY, to `order_id` above — never into
    // the sentence, which is the half a shopper reads.
    expect(String(row?.reason)).not.toContain(ORDER);
    for (const word of presetWords) {
      expect(String(row?.reason), `preset word "${word}" reached the ledger`).not.toContain(word);
    }
  });

  it('refuses more than the balance without writing anything', async () => {
    await fund(40);

    const result = await port.redeem(spend({ points: 100 }));

    expect(result).toEqual({ ok: false, code: 'insufficient_balance' });
    expect(await readBalance(db, EMAIL)).toBe(40);
    expect(await rowsOfKind('redemption')).toHaveLength(0);
  });

  it('replays to the same entry and moves the balance once', async () => {
    await fund(300);

    const first = await port.redeem(spend());
    const second = await port.redeem(spend());

    expect(second).toEqual(first);
    expect(await readBalance(db, EMAIL)).toBe(200);
    expect(await rowsOfKind('redemption')).toHaveLength(1);
  });

  it('answers the replay even after the rest of the balance has been spent', async () => {
    await fund(300);
    const first = await port.redeem(spend());

    // The wallet is emptied by something else entirely — a clawback, another
    // order — which is what a webhook re-firing a week later arrives into.
    await debit(db, {
      email: EMAIL,
      amount: 200,
      reason: 'Corrected an award',
      kind: 'manual',
      actorType: 'admin',
      actorId: ACTOR,
      now: NOW,
    });

    const replayed = await port.redeem(spend());

    // Not `insufficient_balance`: this order WAS paid for, and answering the
    // refusal would flag a perfectly good order for manual review.
    expect(replayed).toEqual({ ok: true, entryId: first.ok ? first.entryId : null, balance: 0 });
    expect(await rowsOfKind('redemption')).toHaveLength(1);
  });

  it('refuses while redemption is switched off', async () => {
    await configure({ enabled: false });
    await fund(300);

    expect(await port.redeem(spend())).toEqual({ ok: false, code: 'redemption_disabled' });
    expect(await readBalance(db, EMAIL)).toBe(300);
    expect(await rowsOfKind('redemption')).toHaveLength(0);
  });

  it('still answers a replay after redemption is switched off', async () => {
    await fund(300);
    const first = await port.redeem(spend());
    await configure({ enabled: false });

    // Idempotency outranks the switch: the order was redeemed while it was on.
    expect(await port.redeem(spend())).toEqual(first);
    expect(await rowsOfKind('redemption')).toHaveLength(1);
  });

  it('refuses a cart priced in another currency', async () => {
    await fund(300);

    expect(await port.redeem(spend({ currency: 'USD' }))).toEqual({
      ok: false,
      code: 'redemption_disabled',
    });
    expect(await rowsOfKind('redemption')).toHaveLength(0);
  });

  it('refuses a malformed amount rather than answering a business code', async () => {
    await fund(300);

    // The frozen union's two codes are outcomes a checkout renders; reporting a
    // caller's bug as one of them would hide it forever.
    const err = await rejection<BadRequestError>(port.redeem(spend({ points: 0 })));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('points');
    expect(await rowsOfKind('redemption')).toHaveLength(0);
  });

  it('refuses an order id of nothing', async () => {
    await fund(300);

    const err = await rejection<BadRequestError>(port.redeem(spend({ orderId: '  ' })));
    expect(err.detail).toBe('orderId');
  });

  it('refuses an order number of nothing rather than freezing a hole in a sentence', async () => {
    await fund(300);

    // `reason` is never re-rendered, so "Order : 100 points spent" would be
    // wrong in a shopper's history for as long as the row exists.
    const err = await rejection<BadRequestError>(port.redeem(spend({ orderNumber: '   ' })));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('orderNumber');
    expect(await rowsOfKind('redemption')).toHaveLength(0);
    expect(await readBalance(db, EMAIL)).toBe(300);
  });

  it('still answers a replay when the order number is missing', async () => {
    await fund(300);
    const first = await port.redeem(spend());

    /*
     * THE ORDERING THE PORT PROMISES. An order number is not the idempotency
     * key, so a webhook firing a second time without one must be answered from
     * the row that already exists — not thrown at. Were the check hoisted to the
     * top beside `orderId`'s, this would raise `orderNumber` and a paid order
     * would be flagged for review over a field its debit no longer needs.
     */
    expect(await port.redeem(spend({ orderNumber: '  ' }))).toEqual(first);
    expect(await rowsOfKind('redemption')).toHaveLength(1);
  });

  it('replays to the redemption even after the order has been released', async () => {
    await fund(300);
    const first = await port.redeem(spend());
    await port.release({
      orderId: ORDER,
      orderNumber: ORDER_NUMBER,
      reason: 'the order was cancelled',
    });

    /*
     * A paid webhook re-firing after a cancellation finds TWO rows carrying this
     * order id, and only one of them is an answer to "redeem it again". Nothing
     * else in this suite puts a release row in front of a replay, so without
     * this the ordering of `orderEntries`' two arms is what would be deciding —
     * and `UNION ALL` promises nothing about that.
     */
    expect(await port.redeem(spend())).toEqual({
      ok: true,
      entryId: first.ok ? first.entryId : null,
      balance: 300,
    });
    expect(await rowsOfKind('redemption')).toHaveLength(1);
    expect(await rowsOfKind('redemption_release')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------- release

describe('release — the compensating credit', () => {
  const undo = (reason = 'the order was cancelled') => ({
    orderId: ORDER,
    orderNumber: ORDER_NUMBER,
    reason,
  });

  async function redeemed(): Promise<string> {
    await fund(300);
    const result = await port.redeem({
      orderId: ORDER,
      orderNumber: ORDER_NUMBER,
      email: EMAIL,
      points: 100,
      currency: CURRENCY,
    });
    if (!result.ok) throw new Error('the fixture redemption was refused');
    return result.entryId;
  }

  it('credits the points back to the wallet that spent them', async () => {
    await redeemed();

    const result = await port.release(undo());

    expect(result).toEqual({ ok: true, entryId: expect.any(String), balance: 300 });
    expect(await readBalance(db, EMAIL)).toBe(300);

    const [row] = await rowsOfKind('redemption_release');
    expect(row).toMatchObject({ delta: 100, balance_after: 300, order_id: ORDER });
    // Issued by whatever cancelled the order, which is a process, not a person.
    expect(row?.actor_type).toBe('system');
    expect(row?.reason).toBe(
      `Order ${ORDER_NUMBER}: 100 ${CAPS.other} returned — the order was cancelled`,
    );
    expect(String(row?.reason)).not.toContain(ORDER);
  });

  it('is a success when the order never spent a point', async () => {
    await fund(300);

    // Most cancelled orders never redeemed anything, and the caller should not
    // have to check first — which is what makes it safe to call unconditionally.
    expect(await port.release(undo())).toEqual({ ok: true, entryId: null, balance: null });
    expect(await ledgerCount()).toBe(1);
  });

  it('credits once however many times it is called', async () => {
    await redeemed();

    const first = await port.release(undo());
    const second = await port.release(undo('refunded, again'));

    expect(second).toEqual(first);
    expect(await readBalance(db, EMAIL)).toBe(300);
    expect(await rowsOfKind('redemption_release')).toHaveLength(1);
  });

  it('counts the returned points as earned again — the shared counter’s rule', async () => {
    await redeemed();
    expect(await lifetimeEarned()).toBe(300);

    await port.release(undo());

    /*
     * 400, NOT 300. `lifetime_earned` counts credits and has no per-kind branch
     * (`ledger/fragments.ts` explains why there is deliberately no branch), so a
     * customer who spends and is refunded reads as having earned slightly more
     * than they did. Pinned here so that consequence is a visible test change if
     * anybody ever decides otherwise, rather than a surprise on a loyalty tier.
     */
    expect(await lifetimeEarned()).toBe(400);
    expect(await readBalance(db, EMAIL)).toBe(300);
  });

  it('refuses a reason of nothing', async () => {
    await redeemed();

    // The ledger's CHECK only refuses the empty string, so a field of spaces
    // would satisfy it and render as nothing in the one column that explains why
    // a balance moved.
    const err = await rejection<BadRequestError>(port.release(undo('   ')));
    expect(err.detail).toBe('reason');
    expect(await rowsOfKind('redemption_release')).toHaveLength(0);
  });

  it('refuses an order number of nothing', async () => {
    await redeemed();

    const err = await rejection<BadRequestError>(
      port.release({ orderId: ORDER, orderNumber: ' ', reason: 'the order was cancelled' }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('orderNumber');
    expect(await rowsOfKind('redemption_release')).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- the races

/**
 * What the two `catch` blocks are for — see `blindOnce` for why a
 * single-connection database can still assert it.
 *
 * EVERY REPLAY ABOVE IS ANSWERED BY THE UP-FRONT READ, so each of these paths
 * was reachable only in production until now: both partial uniques could be
 * named wrongly, and the recovery both refusals fall into could be deleted
 * outright, with the suite green. What a shop would see instead of an idempotent
 * answer is a 500 on a webhook it will keep retrying.
 */
describe('a first look that missed a row — the interleavings one connection cannot issue', () => {
  const spend = () => ({
    orderId: ORDER,
    orderNumber: ORDER_NUMBER,
    email: EMAIL,
    points: 100,
    currency: CURRENCY,
  });

  it('answers a redemption from the row its own index refused to duplicate', async () => {
    await fund(300);
    const first = await port.redeem(spend());

    const blind = blindOnce('redemption');
    const replayed = await redemptionPort(blind.db, () => NOW).redeem(spend());

    expect(blind.blinded()).toBe(1);
    expect(replayed).toEqual(first);
    expect(await rowsOfKind('redemption')).toHaveLength(1);
    /*
     * 200, NOT 100. The refused INSERT took its whole statement down with it,
     * the balance CTE included — which is the property one statement buys and a
     * `db.transaction` would only appear to.
     */
    expect(await readBalance(db, EMAIL)).toBe(200);
  });

  it('answers a replay the wallet can no longer afford, rather than refusing it', async () => {
    await fund(100);
    const first = await port.redeem(spend());
    expect(await readBalance(db, EMAIL)).toBe(0);

    const blind = blindOnce('redemption');
    const replayed = await redemptionPort(blind.db, () => NOW).redeem(spend());

    /*
     * Here the debit's guard refuses BEFORE the index is reached, so the two
     * refusals arrive as different exceptions and must end at the same answer.
     * `insufficient_balance` for an order that was in fact paid for with points
     * is the failure this branch exists to prevent — the shop's policy on that
     * code is to flag the order for a human.
     */
    expect(replayed).toEqual(first);
    expect(await rowsOfKind('redemption')).toHaveLength(1);
  });

  it('answers a release from its own refused row, and the refusal moves nothing', async () => {
    await fund(300);
    await port.redeem(spend());
    const first = await port.release({
      orderId: ORDER,
      orderNumber: ORDER_NUMBER,
      reason: 'the order was cancelled',
    });
    expect(await lifetimeEarned()).toBe(400);

    const blind = blindOnce('redemption_release');
    const second = await redemptionPort(blind.db, () => NOW).release({
      orderId: ORDER,
      orderNumber: ORDER_NUMBER,
      reason: 'cancelled again, by a second worker',
    });

    expect(blind.blinded()).toBe(1);
    expect(second).toEqual(first);
    expect(await rowsOfKind('redemption_release')).toHaveLength(1);
    expect(await readBalance(db, EMAIL)).toBe(300);
    // `lifetime_earned` moves in the same statement as the ledger row, so a
    // refused credit cannot leave the counter ahead of the history it explains.
    expect(await lifetimeEarned()).toBe(400);
  });
});
