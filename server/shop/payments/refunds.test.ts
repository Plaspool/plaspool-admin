import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { FakeProvider } from './provider/fake';
import { fakeCheckoutPort } from './checkout';
import { applyIntentStatus, createIntent, getIntent } from './intents';
import { applyRefundEvent, createRefund, listRefunds } from './refunds';
import { mutateSql } from './test/mutate';
import { resetPayments } from './test/db';
import type { Db } from '../../db/client';
import type { PaymentIntentRow } from './intents';

/**
 * Refunds: the SQL sum-check, idempotency before the provider call, and the
 * distinction between a refund that failed and a refund whose outcome is
 * unknown.
 *
 * §9 asks for the sum-check to be "enforced in SQL and proven with concurrent
 * partial refunds that together exceed the captured amount — exactly one must
 * fail". That is the centre of this file, and it is proven three ways: the
 * behaviour, the guard removed (the CHECK constraint catches it), and BOTH nets
 * removed (the money is over-refunded, which is what the two nets exist to
 * prevent).
 */

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let provider: FakeProvider;
let owner: string;

const CHECKOUT = 'crt_refunds';
const CAPTURED = 1_000;
const checkout = fakeCheckoutPort({
  [CHECKOUT]: { checkoutId: CHECKOUT, total: CAPTURED, currency: 'NGN' },
});
const now = 1_700_000_000_000;

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
  owner = ctx.users.owner.id;
});

beforeEach(async () => {
  await resetPayments(db);
  provider = new FakeProvider();
});

afterAll(async () => {
  await ctx.close();
});

/** An intent that has been paid, ready to refund. */
async function capturedIntent(): Promise<PaymentIntentRow> {
  const { intent } = await createIntent(
    db,
    provider,
    checkout,
    { checkoutId: CHECKOUT, email: 'buyer@example.com', idempotencyKey: 'idem-intent' },
    now,
  );
  await db.execute(sql`
    INSERT INTO shop_payment_events (id, provider_event_id, intent_id, type, payload, received_at)
    VALUES ('pev_cap', 'charge.success:cap', ${intent.id}, 'charge.success', '{}'::jsonb, ${now})`);
  await applyIntentStatus(
    db,
    {
      eventRowId: 'pev_cap',
      intentId: intent.id,
      next: 'captured',
      providerIntentId: intent.providerIntentId,
      failureReason: null,
    },
    now,
  );
  return (await getIntent(db, intent.id)) as PaymentIntentRow;
}

async function refundedTotal(intentId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT refunded_total FROM shop_payment_intents WHERE id = ${intentId}`,
  );
  return Number(res.rows[0].refunded_total);
}

async function outboxRows() {
  const res = await db.execute(sql`SELECT type, payload FROM commerce_events ORDER BY id`);
  return res.rows;
}

describe('the sum-check: total refunded can never exceed captured', () => {
  it('accepts a partial refund and reserves it against the intent', async () => {
    const intent = await capturedIntent();
    const { refund } = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 400, idempotencyKey: 'r-1', createdBy: owner },
      now,
    );
    expect(refund.amount).toBe(400);
    expect(refund.status).toBe('pending');
    expect(await refundedTotal(intent.id)).toBe(400);
    /*
     * The intent is still `captured`. A refund is not a negative charge (§6):
     * the status only moves when the provider confirms the money has actually
     * gone, which arrives as a webhook.
     */
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });

  it('refuses a single refund larger than the capture, as a permanent 400', async () => {
    const intent = await capturedIntent();
    const err = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: CAPTURED + 1, idempotencyKey: 'r-big', createdBy: owner },
      now,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).detail).toBe('amount');
    expect(await refundedTotal(intent.id)).toBe(0);
    // And the provider was never asked. The guard runs before the call.
    expect(provider.countOf('refund')).toBe(0);
  });

  it('EXACTLY ONE of two concurrent partials that together exceed the capture succeeds', async () => {
    /*
     * §9's named case: 600 + 600 against a capture of 1,000.
     *
     * The guard is `refunded_total + $new <= amount` inside the UPDATE's own
     * WHERE, and the refund INSERT is fed `FROM` that UPDATE's RETURNING — so a
     * failed guard produces zero rows rather than a refund. The read that a JS
     * implementation would have done does not exist, which is why there is
     * nothing here for an interleaving to defeat.
     */
    const intent = await capturedIntent();
    const results = await Promise.allSettled([
      createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 600, idempotencyKey: 'r-a', createdBy: owner },
        now,
      ),
      createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 600, idempotencyKey: 'r-b', createdBy: owner },
        now,
      ),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError);

    expect(await refundedTotal(intent.id)).toBe(600);
    expect(await listRefunds(db, intent.id)).toHaveLength(1);
    // The loser never reached the provider, so no money moved for it.
    expect(provider.countOf('refund')).toBe(1);
  });

  it('lets partials that fit run to the full captured amount and no further', async () => {
    const intent = await capturedIntent();
    for (const [i, amount] of [500, 300, 200].entries()) {
      await createRefund(
        db,
        provider,
        { intentId: intent.id, amount, idempotencyKey: `r-${i}`, createdBy: owner },
        now,
      );
    }
    expect(await refundedTotal(intent.id)).toBe(1_000);

    await expect(
      createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 1, idempotencyKey: 'r-over', createdBy: owner },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('mutation: with the WHERE guard removed, the CHECK constraint catches the over-refund', async () => {
    /*
     * NET TWO. The guard lives in the statement; the CHECK on
     * `refunded_total <= amount` lives in the table, so the invariant survives
     * an import, a backfill or SQL run by hand — none of which go through
     * `createRefund`. Removing the guard turns a silent over-refund into a
     * 23514.
     */
    const intent = await capturedIntent();
    await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 600, idempotencyKey: 'r-first', createdBy: owner },
      now,
    );

    const blind = mutateSql(
      db,
      '<= shop_payment_intents.amount',
      '<= 999999999',
    );
    const err = await createRefund(
      blind,
      provider,
      { intentId: intent.id, amount: 600, idempotencyKey: 'r-second', createdBy: owner },
      now,
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code, 'the table CHECK refused it').toBe('23514');
    expect(await refundedTotal(intent.id)).toBe(600);
  });

  it('mutation: with BOTH nets removed, the customer is refunded more than they paid', async () => {
    /*
     * THE CONTROL, and the reason both nets exist. With the statement guard
     * mutated away AND the table CHECK dropped, 600 + 600 against a capture of
     * 1,000 goes through and `refunded_total` reaches 1,200. That is real money
     * leaving twice, and it is what the two lines above prevent.
     */
    const intent = await capturedIntent();
    /* AND ITS CHARGED TWIN (1140): a naira charge tracks the same figure in
       `charge_refunded_minor`, whose own CHECK is a third net. Dropped with
       the first so this control still shows what the naira nets prevent. */
    await db.execute(sql`
      ALTER TABLE shop_payment_intents DROP CONSTRAINT shop_payment_intents_refunded_total_ck`);
    await db.execute(sql`
      ALTER TABLE shop_payment_intents DROP CONSTRAINT shop_payment_intents_charge_refunded_ck`);

    try {
      const blind = mutateSql(db, '<= shop_payment_intents.amount', '<= 999999999');
      for (const key of ['r-x', 'r-y']) {
        await createRefund(
          blind,
          provider,
          { intentId: intent.id, amount: 600, idempotencyKey: key, createdBy: owner },
          now,
        );
      }

      expect(await refundedTotal(intent.id)).toBe(1_200);
      expect(await listRefunds(db, intent.id)).toHaveLength(2);
    } finally {
      /*
       * PUT IT BACK, in a `finally`, because this file shares one database
       * across its tests (see `test/db.ts`). A dropped constraint that leaked
       * into the rest of the run would silently disarm the sibling test above —
       * the one asserting the CHECK catches an over-refund — and it would still
       * be green, which is the worst way for a safety net to disappear.
       *
       * The truncate in `beforeEach` clears rows, not schema, so this is the
       * one place that has to clean up after itself.
       */
      await db.execute(sql`TRUNCATE shop_refunds, shop_payment_intents CASCADE`);
      await db.execute(sql`
        ALTER TABLE shop_payment_intents ADD CONSTRAINT shop_payment_intents_refunded_total_ck
          CHECK (refunded_total >= 0 AND refunded_total <= amount)`);
      await db.execute(sql`
        ALTER TABLE shop_payment_intents ADD CONSTRAINT shop_payment_intents_charge_refunded_ck
          CHECK (charge_refunded_minor >= 0
                 AND (charge_amount_minor IS NULL OR charge_refunded_minor <= charge_amount_minor))`);
    }
  });

  it('the CHECK constraint is still armed after the mutation test above', async () => {
    /*
     * A canary on that `finally`. If the restore is ever lost, this fails
     * immediately and names the reason, instead of the sibling mutation test
     * quietly starting to pass for the wrong reason.
     */
    const intent = await capturedIntent();
    const err = await db
      .execute(sql`UPDATE shop_payment_intents SET refunded_total = ${CAPTURED + 1}
                    WHERE id = ${intent.id}`)
      .then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('23514');
  });

  it('refuses a refund against an intent that was never captured', async () => {
    const { intent } = await createIntent(
      db,
      provider,
      checkout,
      { checkoutId: CHECKOUT, email: 'b@e.co', idempotencyKey: 'idem-uncaptured' },
      now,
    );
    const err = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 100, idempotencyKey: 'r-nope', createdBy: owner },
      now,
    ).catch((e: unknown) => e);
    expect((err as BadRequestError).detail).toBe('status');
  });

  it('404s an intent that does not exist', async () => {
    await expect(
      createRefund(
        db,
        provider,
        { intentId: 'pi_ghost', amount: 100, idempotencyKey: 'r-ghost', createdBy: owner },
        now,
      ),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

describe('idempotency is claimed BEFORE the provider is called', () => {
  it('returns the first refund for a repeated key and calls the provider ONCE', async () => {
    /*
     * Paystack's `POST /refund` has no idempotency key: two calls make two
     * refunds and pay the customer twice. `FakeProvider.refund` deliberately
     * mirrors that — it dedupes nothing — so this assertion is about OUR
     * mechanism and cannot be satisfied by the fake being polite.
     */
    const intent = await capturedIntent();
    const first = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 300, idempotencyKey: 'r-same', createdBy: owner },
      now,
    );
    const second = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 300, idempotencyKey: 'r-same', createdBy: owner },
      now,
    );

    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);
    expect(provider.countOf('refund')).toBe(1);
    // And the reservation was taken once, not twice.
    expect(await refundedTotal(intent.id)).toBe(300);
  });

  it('rolls the reservation back when the key collides, so a retry does not eat the balance', async () => {
    /*
     * The whole `createRefund` statement is atomic, so when the INSERT raises
     * 23505 the `claim` CTE's increment of `refunded_total` is rolled back with
     * it. Were the reservation and the insert two statements, every retry would
     * silently consume more of the refundable balance.
     */
    const intent = await capturedIntent();
    for (let i = 0; i < 4; i += 1) {
      await createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 300, idempotencyKey: 'r-retry', createdBy: owner },
        now,
      );
    }
    expect(await refundedTotal(intent.id)).toBe(300);
    expect(await listRefunds(db, intent.id)).toHaveLength(1);
  });
});

describe('a failed refund and an unknown one are not the same thing', () => {
  it('releases the reservation when the provider definitively refuses', async () => {
    const intent = await capturedIntent();
    provider.program('refund', { kind: 'fail', code: 'invalid_request' });

    await expect(
      createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 400, idempotencyKey: 'r-fail', createdBy: owner },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // No money moved, so the balance becomes refundable again.
    expect(await refundedTotal(intent.id)).toBe(0);
    expect((await listRefunds(db, intent.id))[0].status).toBe('failed');
  });

  it('KEEPS the reservation when the outcome is unknown', async () => {
    /*
     * THE DISTINCTION THAT DECIDES WHETHER A CUSTOMER IS PAID TWICE
     * (`03-payments.md` §5). A timeout is not a failure, it is an absence of
     * information: the refund may well have been created. Releasing the
     * reservation here would let an operator refund the same money again and
     * find out from the bank.
     */
    const intent = await capturedIntent();
    provider.program('refund', { kind: 'fail', code: 'timeout' });

    const { refund } = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount: 400, idempotencyKey: 'r-timeout', createdBy: owner },
      now,
    );

    expect(refund.status).toBe('pending');
    expect(await refundedTotal(intent.id), 'still reserved').toBe(400);
    // The remaining balance is 600, not 1,000 — a second refund cannot take the
    // money that may already be on its way back.
    await expect(
      createRefund(
        db,
        provider,
        { intentId: intent.id, amount: 700, idempotencyKey: 'r-after', createdBy: owner },
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('settling a refund from a verified webhook', () => {
  async function pendingRefund(amount: number, key = 'r-w') {
    const intent = await capturedIntent();
    const { refund } = await createRefund(
      db,
      provider,
      { intentId: intent.id, amount, idempotencyKey: key, createdBy: owner },
      now,
    );
    await db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_r', ${'refund.processed:' + refund.providerRefundId}, 'refund.processed',
              '{}'::jsonb, ${now})`);
    return { intent, refund };
  }

  it('marks it succeeded, moves the intent to partially_refunded, and emits payment.refunded', async () => {
    const { intent, refund } = await pendingRefund(400);
    const result = await applyRefundEvent(
      db,
      { eventRowId: 'pev_r', providerRefundId: refund.providerRefundId as string, status: 'succeeded' },
      now,
    );

    expect(result.settled).toBe(true);
    expect((await listRefunds(db, intent.id))[0].status).toBe('succeeded');
    expect((await getIntent(db, intent.id))?.status).toBe('partially_refunded');

    const events = await outboxRows();
    expect(events.filter((e) => e.type === 'payment.refunded')).toHaveLength(1);
    /*
     * SELECTED BY TYPE, NOT BY POSITION. Both outbox rows are minted in the
     * same millisecond, and `ids.ts` says plainly that ULID order within one
     * millisecond is random — so `events[last]` is a coin flip between
     * `payment.captured` and `payment.refunded`. It passed here and failed in
     * the sibling test below, which is the most misleading way for a test to be
     * wrong.
     */
    expect(events.find((e) => e.type === 'payment.refunded')?.payload).toMatchObject({
      intentId: intent.id,
      checkoutId: CHECKOUT,
      refundId: refund.id,
      refundedAmount: 400,
      refundedTotal: 400,
      // §7: the payload must be self-sufficient, remaining balance included.
      remainingBalance: 600,
    });
  });

  it('moves the intent to refunded when the whole capture is returned', async () => {
    const { intent, refund } = await pendingRefund(CAPTURED);
    await applyRefundEvent(
      db,
      { eventRowId: 'pev_r', providerRefundId: refund.providerRefundId as string, status: 'succeeded' },
      now,
    );
    expect((await getIntent(db, intent.id))?.status).toBe('refunded');
    const events = await outboxRows();
    expect(events.find((e) => e.type === 'payment.refunded')?.payload).toMatchObject({
      refundedTotal: CAPTURED,
      remainingBalance: 0,
    });
  });

  it('gives the reservation back on refund.failed AND emits payment.refund_failed (task-d4)', async () => {
    const { intent, refund } = await pendingRefund(400);
    const result = await applyRefundEvent(
      db,
      { eventRowId: 'pev_r', providerRefundId: refund.providerRefundId as string, status: 'failed' },
      now,
    );

    expect(result.settled).toBe(true);
    expect((await listRefunds(db, intent.id))[0].status).toBe('failed');
    expect(await refundedTotal(intent.id)).toBe(0);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');

    // The succeeded arm never fires on a failed settlement — this is a pure
    // addition beside it, not a replacement.
    const events = await outboxRows();
    expect(events.filter((e) => e.type === 'payment.refunded')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'payment.refund_failed')).toHaveLength(1);
    expect(result.emittedEventId).not.toBeNull();

    // Selected by TYPE, not by position — see the comment on the succeeded
    // test above; both outbox rows here (`payment.captured`,
    // `payment.refund_failed`) mint in the same millisecond.
    expect(events.find((e) => e.type === 'payment.refund_failed')?.payload).toMatchObject({
      intentId: intent.id,
      checkoutId: CHECKOUT,
      refundId: refund.id,
      failedAmount: 400,
      // The POST-UNWIND figure: the reservation was already given back above.
      refundedTotal: 0,
    });
  });

  it('applies once when the same FAILED settlement is delivered three times (task-d4)', async () => {
    const { intent, refund } = await pendingRefund(400);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        applyRefundEvent(
          db,
          {
            eventRowId: 'pev_r',
            providerRefundId: refund.providerRefundId as string,
            status: 'failed',
          },
          now,
        ),
      ),
    );
    expect(results.filter((r) => r.settled)).toHaveLength(1);
    expect((await outboxRows()).filter((e) => e.type === 'payment.refund_failed')).toHaveLength(1);
    expect(await refundedTotal(intent.id)).toBe(0);
  });

  it('applies once when the same settlement is delivered three times', async () => {
    const { intent, refund } = await pendingRefund(400);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        applyRefundEvent(
          db,
          {
            eventRowId: 'pev_r',
            providerRefundId: refund.providerRefundId as string,
            status: 'succeeded',
          },
          now,
        ),
      ),
    );
    expect(results.filter((r) => r.settled)).toHaveLength(1);
    expect((await outboxRows()).filter((e) => e.type === 'payment.refunded')).toHaveLength(1);
    expect(await refundedTotal(intent.id)).toBe(400);
  });

  it('leaves an unmatched refund event UNPROCESSED, for a later drain', async () => {
    /*
     * Deliberately different from the intent path. A `refund.*` webhook can beat
     * our own `UPDATE … SET provider_refund_id` by milliseconds, so the row may
     * exist a moment later — marking the event processed would discard a real
     * event over a race.
     */
    await capturedIntent();
    await db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_unmatched', 'refund.processed:nobody', 'refund.processed', '{}'::jsonb, ${now})`);

    const result = await applyRefundEvent(
      db,
      { eventRowId: 'pev_unmatched', providerRefundId: 'nobody', status: 'succeeded' },
      now,
    );

    expect(result.unresolved).toBe(true);
    expect(result.settled).toBe(false);
    const row = await db.execute(
      sql`SELECT processed_at, last_error FROM shop_payment_events WHERE id = 'pev_unmatched'`,
    );
    expect(row.rows[0].processed_at, 'left pending so a drain retries it').toBeNull();
    expect(row.rows[0].last_error).toBe('unresolved_refund');
  });
});
