import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { PAYMENT_STATUSES, paymentStatusRank } from '../../../shared/commerce/ports';
import { COMMERCE_EVENT_TYPES } from '../../../shared/commerce/events';
import type { Db } from '../../db/client';

/**
 * Migration 0140, EXECUTED.
 *
 * Contract §8: "Hand-appended DDL (triggers, generated columns, partial
 * indexes) is expected… add a test that the DDL is actually applied, not merely
 * present in the file." That distinction is not pedantry here — GAUNTLET II
 * Part 2a Round 1 #3 found migration 0002 silently skipped on an
 * already-migrated database while `db:migrate` printed success and exited 0,
 * and the test that was supposed to catch it asserted a property of the JOURNAL
 * FILE rather than of the database.
 *
 * So every assertion below reads the database. And the contract's evidence rule
 * (§9) is the reason the rank function is not merely checked for existence:
 * "a claim about database behaviour is settled by running it against PGlite
 * built from the real migrations, not by reasoning."
 */

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
});

afterAll(async () => {
  await ctx.close();
});

/** Run a statement and return the SQLSTATE it raised, or null if it succeeded. */
async function sqlstate(statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await db.execute(statement);
    return null;
  } catch (err) {
    // `guardDb` has already scrubbed this into a `DbError` carrying SQLSTATE
    // and relation names and nothing else — which is exactly what we assert on.
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const now = 1_700_000_000_000;

async function seedIntent(id: string, amount = 1000, status = 'captured'): Promise<void> {
  await db.execute(sql`
    INSERT INTO shop_payment_intents
      (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
       refunded_total, created_at, updated_at, revision)
    VALUES (${id}, ${'co_' + id}, ${amount}, 'NGN', ${status}, ${'key_' + id}, 'fp',
            0, ${now}, ${now}, 1)`);
}

describe('shop_payment_status_rank — the ordering out-of-order webhooks depend on', () => {
  it('exists in the database, not just in the migration file', async () => {
    const res = await db.execute(sql`
      SELECT provolatile, proparallel FROM pg_proc WHERE proname = 'shop_payment_status_rank'`);
    expect(res.rows).toHaveLength(1);
    /*
     * IMMUTABLE, verified by execution rather than by reading the DDL. GAUNTLET
     * II's plan review recorded two blind reviewers contradicting each other on
     * exactly this question for `array_to_string`; the one who ran it was right.
     * A STABLE function here could not be used in a CHECK and would be a planner
     * barrier in the predicates that guard every transition.
     */
    expect(res.rows[0].provolatile).toBe('i');
  });

  it('agrees with the TypeScript ladder for every status', async () => {
    /*
     * THE DRIFT GUARD. The rank exists twice — `paymentStatusRank()` in
     * `shared/commerce/ports.ts` and `shop_payment_status_rank()` in SQL — and
     * they decide the same question in two languages. If they disagree, a
     * transition the application believes it refused is one the database
     * allowed. Every status is checked, driven from the exported list, so a
     * status added to the union without a SQL arm fails here.
     */
    for (const status of PAYMENT_STATUSES) {
      const res = await db.execute(sql`SELECT shop_payment_status_rank(${status}) AS r`);
      expect(Number(res.rows[0].r), `rank of ${status}`).toBe(paymentStatusRank(status));
    }
  });

  it('gives an unknown status -1, so a comparison against it LOSES rather than vanishing', async () => {
    /*
     * NOT NULL, and this is the whole reason the ELSE arm exists. A NULL would
     * make every comparison NULL — a predicate that silently never matches,
     * i.e. a guard that has quietly stopped guarding. That is precisely what
     * Part 2b's mutation campaign found across six lifecycle transitions.
     */
    const res = await db.execute(sql`
      SELECT shop_payment_status_rank('nonsense') AS r,
             (shop_payment_status_rank('nonsense') < shop_payment_status_rank('captured')) AS lt`);
    expect(Number(res.rows[0].r)).toBe(-1);
    expect(res.rows[0].lt).toBe(true);
  });

  it('orders captured above failed and cancelled, so money that arrives late still lands', async () => {
    const res = await db.execute(sql`
      SELECT shop_payment_status_rank('cancelled') < shop_payment_status_rank('captured') AS a,
             shop_payment_status_rank('failed')    < shop_payment_status_rank('captured') AS b,
             shop_payment_status_rank('captured')  < shop_payment_status_rank('refunded') AS c`);
    expect(res.rows[0]).toMatchObject({ a: true, b: true, c: true });
  });
});

describe('shop_payment_intents constraints', () => {
  it('refuses a status outside the enumerated list', async () => {
    /*
     * `.$type<>()` is compile-time only (contract §4). Without this check, a bug
     * anywhere — an import, a backfill, a mis-typed literal in SQL — could
     * persist `status = 'paid'`, which every reader in the system would then
     * rank at -1 and treat as movable in any direction.
     */
    expect(
      await sqlstate(sql`
        INSERT INTO shop_payment_intents
          (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
           refunded_total, created_at, updated_at, revision)
        VALUES ('pi_bad', 'co_1', 100, 'NGN', 'paid', 'k_bad', 'fp', 0, ${now}, ${now}, 1)`),
    ).toBe('23514');
  });

  it('refuses a non-positive amount — a charge of nothing is not a charge', async () => {
    expect(
      await sqlstate(sql`
        INSERT INTO shop_payment_intents
          (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
           refunded_total, created_at, updated_at, revision)
        VALUES ('pi_zero', 'co_1', 0, 'NGN', 'requires_payment', 'k_zero', 'fp', 0,
                ${now}, ${now}, 1)`),
    ).toBe('23514');
  });

  it('refuses a duplicate idempotency key — the whole basis of idempotency', async () => {
    await seedIntent('pi_dup');
    expect(
      await sqlstate(sql`
        INSERT INTO shop_payment_intents
          (id, checkout_id, amount, currency, status, idempotency_key, request_fingerprint,
           refunded_total, created_at, updated_at, revision)
        VALUES ('pi_dup2', 'co_2', 100, 'NGN', 'requires_payment', 'key_pi_dup', 'fp', 0,
                ${now}, ${now}, 1)`),
    ).toBe('23505');
  });

  it('refuses refunded_total above the captured amount, even from raw SQL', async () => {
    /*
     * THE INVARIANT, HELD BY THE DATABASE. `refunds.ts` guards this inside an
     * UPDATE's WHERE, which is what makes concurrent partials safe. This test
     * is about the OTHER half: the same thing must be true of an import, a
     * backfill or a hand-run UPDATE at 2am, none of which go through that
     * statement.
     */
    await seedIntent('pi_over', 1000);
    expect(
      await sqlstate(
        sql`UPDATE shop_payment_intents SET refunded_total = 1001 WHERE id = 'pi_over'`,
      ),
    ).toBe('23514');
    expect(
      await sqlstate(
        sql`UPDATE shop_payment_intents SET refunded_total = -1 WHERE id = 'pi_over'`,
      ),
    ).toBe('23514');
    // …and the boundary itself is allowed: a full refund is not an overdraft.
    expect(
      await sqlstate(
        sql`UPDATE shop_payment_intents SET refunded_total = 1000 WHERE id = 'pi_over'`,
      ),
    ).toBeNull();
  });
});

describe('shop_payment_events — the append-only provider log', () => {
  it('refuses a duplicate provider_event_id, which is how webhook dedupe works', async () => {
    const insert = (id: string) => sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES (${id}, 'charge.success:ref-1', 'charge.success', '{}'::jsonb, ${now})`;
    expect(await sqlstate(insert('pev_1'))).toBeNull();
    expect(await sqlstate(insert('pev_2'))).toBe('23505');
  });

  it('stores an event whose intent cannot be resolved — no FK stands in the way', async () => {
    /*
     * DELIBERATE. A verified event must be storable the instant its signature
     * checks out, whether or not we can place it. An FK here would make the one
     * case where the evidence matters most the case where we discard it and
     * answer the provider with a 500 it retries for 72 hours.
     */
    expect(
      await sqlstate(sql`
        INSERT INTO shop_payment_events (id, provider_event_id, intent_id, type, payload, received_at)
        VALUES ('pev_orphan', 'charge.success:nobody', 'pi_does_not_exist',
                'charge.success', '{}'::jsonb, ${now})`),
    ).toBeNull();
  });
});

describe('shop_refunds constraints', () => {
  it('allows many refunds with no provider id yet, but only one of each real id', async () => {
    /*
     * The partial unique index. A plain UNIQUE cannot hold many rows sharing
     * "not assigned yet"; Postgres permits many NULLs, which is the same shape
     * `posts.slug` uses and for the same reason.
     */
    await seedIntent('pi_ref', 10_000);
    const insert = (id: string, providerRefundId: string | null) => sql`
      INSERT INTO shop_refunds
        (id, intent_id, amount, currency, idempotency_key, provider_refund_id, status,
         created_at, updated_at, created_by)
      VALUES (${id}, 'pi_ref', 100, 'NGN', ${'rk_' + id}, ${providerRefundId}, 'pending',
              ${now}, ${now}, ${ctx.users.owner.id})`;

    expect(await sqlstate(insert('rfd_a', null))).toBeNull();
    expect(await sqlstate(insert('rfd_b', null))).toBeNull();
    expect(await sqlstate(insert('rfd_c', 'prf_1'))).toBeNull();
    expect(await sqlstate(insert('rfd_d', 'prf_1'))).toBe('23505');
  });

  it('refuses a refund whose intent does not exist', async () => {
    expect(
      await sqlstate(sql`
        INSERT INTO shop_refunds
          (id, intent_id, amount, currency, idempotency_key, status,
           created_at, updated_at, created_by)
        VALUES ('rfd_orphan', 'pi_nope', 100, 'NGN', 'rk_orphan', 'pending',
                ${now}, ${now}, ${ctx.users.owner.id})`),
    ).toBe('23503');
  });

  it('refuses a status outside pending/succeeded/failed', async () => {
    await seedIntent('pi_rs', 5000);
    expect(
      await sqlstate(sql`
        INSERT INTO shop_refunds
          (id, intent_id, amount, currency, idempotency_key, status,
           created_at, updated_at, created_by)
        VALUES ('rfd_bad', 'pi_rs', 100, 'NGN', 'rk_bad', 'processed',
                ${now}, ${now}, ${ctx.users.owner.id})`),
    ).toBe('23514');
  });
});

describe('commerce_events — the shared outbox', () => {
  it('accepts every type contract §6 fixes', async () => {
    for (const [i, type] of COMMERCE_EVENT_TYPES.entries()) {
      expect(
        await sqlstate(sql`
          INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
          VALUES (${`evt_ok_${i}`}, ${type}, 'sub', '{}'::jsonb, ${now})`),
        `type ${type}`,
      ).toBeNull();
    }
  });

  it('accepts a type this build has never heard of — §6 rule 4 needs that', async () => {
    /*
     * THE COLUMN IS DELIBERATELY UNCONSTRAINED, and this test is the reason
     * stated as an assertion rather than a comment.
     *
     * Migration 0140 used to add `CHECK (type IN (…the eleven…))`, on the
     * strength of contract §4's "every enum-ish column carries a check()".
     * Orders raised A-ORD-001 against it and was right. §6 rule 1 puts the
     * outbox INSERT in the same transaction as the state change that caused it,
     * so a CHECK on `type` does not reject an event — it rolls back the event's
     * CAUSE. A producer emitting a twelfth type loses its capture, not its
     * notification, and §6 rule 4 exists precisely so a producer may ship ahead
     * of its consumers.
     *
     * In a payments subsystem the asymmetry decides it: a typo'd type costs a
     * missed downstream reaction; a rolled-back capture costs a customer who has
     * been charged and has no record of it. The typo-catching moved to
     * `commerceEvent()`, which pairs type and payload at compile time and cannot
     * roll anything back.
     */
    expect(
      await sqlstate(sql`
        INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at)
        VALUES ('evt_future', 'loyalty.points.awarded', 'sub', '{}'::jsonb, ${now})`),
    ).toBeNull();
  });

  it('still refuses a negative attempt count', async () => {
    /*
     * The one check that stayed. It is not a type-evolution question — nothing a
     * future subsystem might legitimately write makes a negative attempt count
     * correct — so it cannot roll back a state change that should have succeeded.
     */
    expect(
      await sqlstate(sql`
        INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
        VALUES ('evt_neg', 'payment.captured', 'sub', '{}'::jsonb, ${now}, -1)`),
    ).toBe('23514');
  });
});
