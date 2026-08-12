import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { FakeProvider } from './provider/fake';
import { fakeCheckoutPort } from './checkout';
import { applyIntentStatus, cancelIntent, createIntent, getIntent } from './intents';
import { providerReferenceFor } from './ids';
import { mutateSql } from './test/mutate';
import { resetPayments } from './test/db';
import type { Db } from '../../db/client';

/**
 * The intent lifecycle: idempotency, the frozen amount, and the high-water
 * ladder that makes out-of-order webhooks safe.
 *
 * ON CONCURRENCY IN THIS HARNESS, stated plainly because overclaiming it would
 * be worse than not testing it. PGlite is one in-process connection with a FIFO
 * queue, so `Promise.all` does NOT give two statements executing at the same
 * instant with row-lock contention. What it gives — and what
 * `server/repo/posts.test.ts` already relies on and documents — is deterministic
 * STEP INTERLEAVING: when two multi-step operations are started together, every
 * step of one runs between steps of the other. That is exactly the interleaving
 * that defeats a read-then-check-then-write guard, which is the bug class
 * `03-payments.md` §5 and Part 2b are both about. It is not a proof of
 * lock-level serialisation, and nothing below claims to be.
 *
 * The mutation tests are the other half. Contract §10: "Assume your guards are
 * untested until you have watched the suite go red without them." Each one
 * rewrites a predicate to `true` en route to the driver and asserts the
 * behaviour actually changes.
 */

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let provider: FakeProvider;

const CHECKOUT = 'crt_01ABC';
const checkout = fakeCheckoutPort({
  [CHECKOUT]: { checkoutId: CHECKOUT, total: 40_333, currency: 'NGN' },
  crt_other: { checkoutId: 'crt_other', total: 999, currency: 'NGN' },
});

const now = 1_700_000_000_000;

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;

});

beforeEach(async () => {
  await resetPayments(db);
  provider = new FakeProvider();
});

afterAll(async () => {
  await ctx.close();
});

function input(overrides: Partial<Parameters<typeof createIntent>[3]> = {}) {
  return {
    checkoutId: CHECKOUT,
    email: 'buyer@example.com',
    idempotencyKey: 'idem-key-0001',
    ...overrides,
  };
}

async function outboxRows() {
  const res = await db.execute(
    sql`SELECT id, type, subject_id, payload FROM commerce_events ORDER BY id`,
  );
  return res.rows;
}

describe('the amount is frozen from CheckoutPort and never recomputed', () => {
  it('takes the total from the port, and the request body carries no amount at all', async () => {
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    expect(intent.amount).toBe(40_333);
    expect(intent.currency).toBe('NGN');
    // The provider was asked to charge exactly that, with no conversion.
    expect(provider.calls[0]).toMatchObject({ op: 'createIntent', amount: 40_333 });
  });

  it('keeps the frozen amount even when the checkout later says something else', async () => {
    /*
     * `03-payments.md` §1: "A capture that recomputes is a capture that can
     * charge a figure the customer never saw." The cart moving underneath —
     * a price change, a line edited in another tab — must not reach an intent
     * that already exists.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const moved = fakeCheckoutPort({
      [CHECKOUT]: { checkoutId: CHECKOUT, total: 1, currency: 'NGN' },
    });
    await createIntent(db, provider, moved, input(), now).catch(() => null);

    expect((await getIntent(db, intent.id))?.amount).toBe(40_333);
  });

  it('emits the frozen amount into the outbox, not a re-read', async () => {
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const stored = await storeChargeEvent(intent.id);
    await applyIntentStatus(
      db,
      {
        eventRowId: stored,
        intentId: intent.id,
        next: 'captured',
        providerIntentId: providerReferenceFor(intent.id),
        failureReason: null,
      },
      now,
    );
    const [event] = await outboxRows();
    expect(event.type).toBe('payment.captured');
    expect(event.payload).toMatchObject({
      intentId: intent.id,
      checkoutId: CHECKOUT,
      amount: 40_333,
      currency: 'NGN',
    });
  });
});

/** A stored, verified provider event to apply. */
async function storeChargeEvent(intentId: string, suffix = ''): Promise<string> {
  const id = `pev_test${suffix}`;
  await db.execute(sql`
    INSERT INTO shop_payment_events (id, provider_event_id, intent_id, type, payload, received_at)
    VALUES (${id}, ${`charge.success:${intentId}${suffix}`}, ${intentId},
            'charge.success', '{}'::jsonb, ${now})`);
  return id;
}

describe('idempotency is a UNIQUE column and a read-through', () => {
  it('returns the first call’s result for the same key, and calls the provider ONCE', async () => {
    const first = await createIntent(db, provider, checkout, input(), now);
    const second = await createIntent(db, provider, checkout, input(), now);

    expect(second.created).toBe(false);
    expect(second.intent.id).toBe(first.intent.id);
    /*
     * THE ASSERTION THAT MATTERS IS THE CALL COUNT, not the returned value. A
     * broken implementation that charged twice and returned the first result
     * would satisfy every equality above.
     */
    expect(provider.countOf('createIntent')).toBe(1);
  });

  it('creates ONE intent when the same key is used by interleaved callers', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createIntent(db, provider, checkout, input(), now)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(5);

    const ids = new Set(
      ok.map((r) => (r as PromiseFulfilledResult<{ intent: { id: string } }>).value.intent.id),
    );
    expect(ids.size, 'five callers, one intent').toBe(1);

    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM shop_payment_intents`);
    expect(Number(rows.rows[0].n)).toBe(1);
    expect(provider.countOf('createIntent')).toBe(1);
  });

  it('REFUSES a key reused for a different request, rather than answering with the old intent', async () => {
    await createIntent(db, provider, checkout, input(), now);
    const err = await createIntent(
      db,
      provider,
      checkout,
      input({ checkoutId: 'crt_other' }),
      now,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestError);
    // 400 and not 500: it is permanent, and contract §10 makes a 500 a request
    // the client re-sends five times.
    expect((err as BadRequestError).detail).toBe('idempotency_key');
  });

  it('shows what the fingerprint check is protecting against', async () => {
    /*
     * NOT A `mutateSql` MUTATION, because this guard is a JS comparison rather
     * than a SQL predicate and rewriting statement text cannot reach it. What
     * is asserted instead is the thing that makes the guard necessary: the
     * intent stored under this key charges 40,333, so a build that answered the
     * 999 request with it would hand back an authorization URL for one figure
     * while the caller believed another.
     */
    const first = await createIntent(db, provider, checkout, input(), now);
    expect(first.intent.amount).toBe(40_333);
    await expect(checkout.totals(db, 'crt_other')).resolves.toMatchObject({
      grandTotal: { amount: 999, currency: 'NGN' },
    });
    await expect(
      createIntent(db, provider, checkout, input({ checkoutId: 'crt_other' }), now),
    ).rejects.toBeInstanceOf(BadRequestError);
    // And nothing was created for the second request.
    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM shop_payment_intents`);
    expect(Number(rows.rows[0].n)).toBe(1);
  });
});

describe('a lost provider response is recoverable, and never a second charge', () => {
  it('re-sends the SAME derived reference after a timeout', async () => {
    /*
     * `03-payments.md` §5: "The dangerous case is a provider call that
     * succeeded while the response was lost; only a key makes that
     * recoverable." The reference is a pure function of the intent id, so the
     * retry presents the same one — which Paystack either accepts or refuses as
     * a duplicate. A reference minted per ATTEMPT would make every timeout a
     * second transaction.
     */
    provider.program('createIntent', { kind: 'fail', code: 'timeout' });

    await expect(createIntent(db, provider, checkout, input(), now)).rejects.toMatchObject({
      code: 'timeout',
      indeterminate: true,
    });

    // The row exists and holds the failure, with no provider reference yet.
    const rows = await db.execute(
      sql`SELECT id, provider_intent_id, last_error FROM shop_payment_intents`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].provider_intent_id).toBeNull();
    // An ENUMERATED code, never a provider message.
    expect(rows.rows[0].last_error).toBe('timeout');

    const { intent, created } = await createIntent(db, provider, checkout, input(), now);
    expect(created).toBe(false);
    expect(intent.providerIntentId).toBe(providerReferenceFor(intent.id));
    expect(intent.lastError).toBeNull();

    const references = provider.calls.filter((c) => c.op === 'createIntent').map((c) => c.ref);
    expect(references).toHaveLength(2);
    expect(new Set(references).size, 'both attempts used one reference').toBe(1);
  });

  it('treats a duplicate reference as reconciliation, not as a failure', async () => {
    /*
     * The other half of the same story: our first attempt DID get through, and
     * the answer was lost after the provider had created the transaction. The
     * retry is refused as a duplicate — and that refusal means success, so the
     * adapter is asked what the transaction actually is rather than the
     * checkout being abandoned.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const reference = providerReferenceFor(intent.id);
    provider.settle(reference, 'captured');
    // Simulate the response having been lost: the row forgets the reference.
    await db.execute(
      sql`UPDATE shop_payment_intents SET provider_intent_id = NULL WHERE id = ${intent.id}`,
    );

    const again = await createIntent(db, provider, checkout, input(), now);
    expect(again.intent.providerIntentId).toBe(reference);
    expect(provider.countOf('fetchIntent')).toBe(1);
    // Two createIntent attempts, one transaction at the provider.
    expect(provider.countOf('createIntent')).toBe(2);
  });
});

describe('the status ladder tolerates out-of-order arrival', () => {
  async function captured() {
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);
    await applyIntentStatus(
      db,
      {
        eventRowId: row,
        intentId: intent.id,
        next: 'captured',
        providerIntentId: providerReferenceFor(intent.id),
        failureReason: null,
      },
      now,
    );
    return intent;
  }

  it('resolves captured-before-authorized to CAPTURED and records the anomaly', async () => {
    const intent = await captured();
    const late = await storeChargeEvent(intent.id, '-late');

    const result = await applyIntentStatus(
      db,
      {
        eventRowId: late,
        intentId: intent.id,
        next: 'authorized',
        providerIntentId: null,
        failureReason: null,
      },
      now,
    );

    expect(result.claimed, 'the late event is acknowledged, not refused').toBe(true);
    expect(result.moved, 'but it does not pull the intent backwards').toBe(false);
    expect(result.emittedEventId).toBeNull();
    expect((await getIntent(db, intent.id))?.status).toBe('captured');

    const events = await db.execute(
      sql`SELECT anomaly, processed_at FROM shop_payment_events WHERE id = ${late}`,
    );
    // RECORDED rather than thrown (§4): the event is not wrong, it is late.
    expect(events.rows[0].anomaly).toBe('superseded:authorized:after:captured');
    expect(events.rows[0].processed_at).not.toBeNull();

    expect(await outboxRows()).toHaveLength(1);
  });

  it('lets money arrive after a local cancellation, and flags it for a human', async () => {
    /*
     * Paystack has no remote cancel — abandoning a transaction IS the
     * cancellation — so a customer can pay a checkout we marked cancelled.
     * Refusing that would mean holding money we deny having.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    await cancelIntent(db, intent.id, now);
    expect((await getIntent(db, intent.id))?.status).toBe('cancelled');

    const row = await storeChargeEvent(intent.id, '-after-cancel');
    const result = await applyIntentStatus(
      db,
      {
        eventRowId: row,
        intentId: intent.id,
        next: 'captured',
        providerIntentId: providerReferenceFor(intent.id),
        failureReason: null,
      },
      now,
    );

    expect(result.moved).toBe(true);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
    expect(await outboxRows()).toHaveLength(1);
  });

  it('acknowledges an event for an intent it cannot resolve, instead of 500ing forever', async () => {
    await db.execute(sql`
      INSERT INTO shop_payment_events (id, provider_event_id, type, payload, received_at)
      VALUES ('pev_orphan', 'charge.success:ghost', 'charge.success', '{}'::jsonb, ${now})`);

    const result = await applyIntentStatus(
      db,
      {
        eventRowId: 'pev_orphan',
        intentId: null,
        next: 'captured',
        providerIntentId: 'ghost',
        failureReason: null,
      },
      now,
    );

    expect(result.claimed).toBe(true);
    expect(result.moved).toBe(false);
    const rows = await db.execute(
      sql`SELECT anomaly FROM shop_payment_events WHERE id = 'pev_orphan'`,
    );
    expect(rows.rows[0].anomaly).toBe('unresolved_intent');
  });

  it('applies one state change and one outbox event for a triply-delivered event', async () => {
    /*
     * §9: "Duplicate webhook delivery (same providerEventId ×3, concurrently)
     * produces exactly one state change and one outbox event." The dedupe on
     * `provider_event_id` is tested in `webhook.test.ts`; this is the second
     * gate — three drains racing on ONE stored row.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        applyIntentStatus(
          db,
          {
            eventRowId: row,
            intentId: intent.id,
            next: 'captured',
            providerIntentId: providerReferenceFor(intent.id),
            failureReason: null,
          },
          now,
        ),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => r.moved)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
    expect((await getIntent(db, intent.id))?.revision).toBe(3); // create, attach, capture
  });

  it('mutation: without the rank guard, a late event drags a captured intent backwards', async () => {
    /*
     * Contract §10: "Assume your guards are untested until you have watched the
     * suite go red without them." Replacing the rank comparison with `true` is
     * exactly the mutation Part 2b ran across six lifecycle transitions, where
     * it broke NONE of 254 tests.
     */
    const intent = await captured();
    const late = await storeChargeEvent(intent.id, '-mut');

    const blind = mutateSql(db, 'shop_payment_status_rank(status) <', '-1 <');
    await applyIntentStatus(
      blind,
      {
        eventRowId: late,
        intentId: intent.id,
        next: 'authorized',
        providerIntentId: null,
        failureReason: null,
      },
      now,
    );

    // With the guard gone the intent is dragged back to `authorized` and a
    // second, wrong outbox event is emitted. That is what the guard prevents.
    expect((await getIntent(db, intent.id))?.status).toBe('authorized');
    expect(await outboxRows()).toHaveLength(2);
  });

  it('mutation: the claim gate holds re-delivery on its own, with the rank guard removed', async () => {
    /*
     * TWO INDEPENDENT GUARDS, ISOLATED. The first attempt at this test mutated
     * only the claim dependency and stayed green — because the RANK guard also
     * refuses a repeat (`captured` is not below `captured`), so neither
     * mutation alone is observable through the other. That is a real property
     * worth pinning rather than a nuisance: it is defence in depth, and a test
     * that could not tell them apart would let either rot.
     *
     * So the rank guard is removed FIRST, and the claim gate is then shown
     * holding three deliveries to one application entirely by itself.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);

    const noRank = mutateSql(db, 'shop_payment_status_rank(status) <', '-1 <');
    const apply = (handle: Db) =>
      applyIntentStatus(
        handle,
        {
          eventRowId: row,
          intentId: intent.id,
          next: 'captured',
          providerIntentId: null,
          failureReason: null,
        },
        now,
      );

    await Promise.all([apply(noRank), apply(noRank), apply(noRank)]);
    expect((await outboxRows()).length, 'the claim gate alone holds it to one').toBe(1);
  });

  it('mutation: with BOTH guards removed, the same event applies three times', async () => {
    /*
     * The control for the test above. With the rank comparison AND the
     * `EXISTS (SELECT 1 FROM claimed)` dependency gone, three deliveries of one
     * event write three outbox rows — which is what those two lines prevent,
     * and what §9 means by "exactly one state change and one outbox event".
     *
     * The `EXISTS` in particular is easy to lose by accident: a data-modifying
     * CTE runs whether or not anything references it, so deleting that
     * dependency leaves the statement looking correct while silently removing
     * the once-only gate.
     */
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);

    const blind = mutateSql(
      mutateSql(db, 'shop_payment_status_rank(status) <', '-1 <'),
      'AND EXISTS (SELECT 1 FROM claimed)',
      'AND true',
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        applyIntentStatus(
          blind,
          {
            eventRowId: row,
            intentId: intent.id,
            next: 'captured',
            providerIntentId: null,
            failureReason: null,
          },
          now,
        ),
      ),
    );

    expect((await outboxRows()).length, 'three outbox events instead of one').toBe(3);
  });
});

describe('failure is recorded without carrying provider prose', () => {
  it('emits payment.failed with an enumerated reason', async () => {
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);
    await applyIntentStatus(
      db,
      {
        eventRowId: row,
        intentId: intent.id,
        next: 'failed',
        providerIntentId: null,
        failureReason: 'declined',
      },
      now,
    );
    const [event] = await outboxRows();
    expect(event.type).toBe('payment.failed');
    expect(event.payload).toMatchObject({ reason: 'declined', amount: 40_333 });
  });
});

describe('cancel', () => {
  it('refuses to cancel something already captured, as a permanent 400', async () => {
    const { intent } = await createIntent(db, provider, checkout, input(), now);
    const row = await storeChargeEvent(intent.id);
    await applyIntentStatus(
      db,
      {
        eventRowId: row,
        intentId: intent.id,
        next: 'captured',
        providerIntentId: null,
        failureReason: null,
      },
      now,
    );
    await expect(cancelIntent(db, intent.id, now)).rejects.toBeInstanceOf(BadRequestError);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });

  it('404s an intent that does not exist, rather than reporting a status refusal', async () => {
    await expect(cancelIntent(db, 'pi_nope', now)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});
