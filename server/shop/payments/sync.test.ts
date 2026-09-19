import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import { FakeProvider } from './provider/fake';
import { fakeCheckoutPort } from './checkout';
import { resetPayments } from './test/db';
import { createIntent, getIntent, listIntentsToSync } from './intents';
import { PAYMENT_SYNC_LIMIT, reconcileIntent, refreshIntentNow, syncPaymentIntents } from './sync';
import type { Db } from '../../db/client';
import type { PaymentIntentRow } from './intents';
import type { PaymentsCheckoutPort } from './checkout';

/**
 * THE BACKSTOP FOR A PAYMENT WEBHOOK THAT NEVER ARRIVED.
 *
 * WHAT MAKES THIS FILE DIFFERENT FROM `webhook.test.ts`, and the reason the
 * feature exists at all: every case here settles the charge AT THE GATEWAY and
 * never delivers a webhook. `FakeProvider.settle()` is exactly that — the
 * customer paid, the gateway knows, and nothing ever told us. That state is
 * invisible to `drainPaymentEvents`, because there is no stored event to drain,
 * so the drain runs clean and reports nothing wrong while the shopper has no
 * order. Only asking finds it, and this suite is the proof that asking works.
 *
 * A REAL DATABASE AND A FAKE GATEWAY, as `webhook.test.ts` runs: the intents,
 * the event log, the rank ladder, the outbox writes and the charge check are all
 * genuine, and the only stub is the gateway — because a sweep that reached a real
 * one would poll Paystack on every run of this suite.
 *
 * WHAT IT IS FOR is the RECOVERY, the BOUNDING and the FAILURE ISOLATION. What
 * `captured` does to an intent is `applyIntentStatus`, proved in
 * `intents.test.ts` and reached from here rather than re-derived. This file
 * proves that a lost capture is found, that we never ask about more than a page
 * of payments or about payments that cannot take money, and that one gateway
 * being down does not cost the others their answer — the property that makes it
 * safe to run inside a cron that also sends the mail.
 */

const CHECKOUT = 'crt_sync';
const NOW = 1_700_000_000_000;

let ctx: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let provider: FakeProvider;

/**
 * Cart's port, plus a record of when it was asked to complete a checkout.
 *
 * WHY A SPY AND NOT JUST THE FAKE. `checkout.completed` is written by the REAL
 * Cart port inside `complete()`, not by Payments — so at this level of the stack
 * the only observable fact is that Payments ASKED, and the ordering of that ask
 * against the outbox write is load-bearing (`reconcileIntent`'s header). This
 * records the outbox as it stood at the moment of the ask, which is what makes
 * "the checkout is completed BEFORE the intent moves" assertable rather than
 * merely commented.
 */
let completions: { checkoutId: string; outboxAtTheTime: string[] }[] = [];

const baseCheckout = fakeCheckoutPort({
  [CHECKOUT]: { checkoutId: CHECKOUT, total: 40_333, currency: 'NGN' },
});

const checkout: PaymentsCheckoutPort = {
  ...baseCheckout,
  async complete(d, checkoutId) {
    completions.push({ checkoutId, outboxAtTheTime: await outboxTypes() });
    return baseCheckout.complete(d, checkoutId);
  },
};

beforeAll(async () => {
  ctx = await freshDb();
  db = ctx.db;
});

beforeEach(async () => {
  await resetPayments(db);
  provider = new FakeProvider({ name: 'paystack' });
  completions = [];
});

afterAll(async () => {
  await ctx.close();
});

/** An intent at the gateway, with no webhook ever delivered. */
async function anIntent(key: string, createdAt = NOW): Promise<PaymentIntentRow> {
  const { intent } = await createIntent(
    db,
    provider,
    checkout,
    { checkoutId: CHECKOUT, email: 'buyer@example.com', idempotencyKey: key },
    createdAt,
  );
  return intent;
}

/** The deps `syncPaymentIntents` takes, wired to this file's fake gateway. */
function deps(over: { providerFor?: (name: string) => FakeProvider | null } = {}) {
  return {
    providerFor: over.providerFor ?? (() => provider),
    checkout,
  } as Parameters<typeof syncPaymentIntents>[1];
}

async function outboxTypes(): Promise<string[]> {
  const res = await db.execute(sql`SELECT type FROM commerce_events ORDER BY id`);
  return res.rows.map((r) => String(r.type));
}

async function eventTypes(): Promise<string[]> {
  const res = await db.execute(sql`SELECT type FROM shop_payment_events ORDER BY id`);
  return res.rows.map((r) => String(r.type));
}

async function syncedAt(id: string): Promise<number | null> {
  const res = await db.execute(
    sql`SELECT provider_synced_at FROM shop_payment_intents WHERE id = ${id}`,
  );
  const v = res.rows[0]?.provider_synced_at;
  return v == null ? null : Number(v);
}

async function lastErrorOf(id: string): Promise<string | null> {
  const res = await db.execute(sql`SELECT last_error FROM shop_payment_intents WHERE id = ${id}`);
  const v = res.rows[0]?.last_error;
  return v == null ? null : String(v);
}

describe('a capture whose webhook never arrived', () => {
  it('is found, applied, and announced to Orders', async () => {
    const intent = await anIntent('idem-lost-capture');
    /* The customer pays. The gateway knows. NOTHING tells us — no webhook, no
       confirm, no browser coming back. This is the production incident. */
    provider.settle(intent.providerIntentId!, 'captured');

    /* Before: the shop has no idea. This is the assertion that makes the rest of
       the case mean something — it is also exactly what an operator sees. */
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    expect(await outboxTypes()).toEqual([]);

    const out = await syncPaymentIntents(db, deps(), NOW);

    expect(out).toEqual({ checked: 1, changed: 1, captured: 1, failed: 0 });
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
    /* Orders is told, which is the only way an order ever gets created. */
    expect(await outboxTypes()).toEqual(['payment.captured']);
    /*
     * AND THE CHECKOUT WAS COMPLETED FIRST — `outboxAtTheTime` is empty, so
     * `payment.captured` had not been written yet when Cart was asked. That
     * ordering is load-bearing: Orders' consumer parks `payment.captured` on its
     * `checkout.completed` predecessor, so the other order leaves a parked event
     * for a later pass and the order uncreated until then.
     */
    expect(completions).toEqual([{ checkoutId: CHECKOUT, outboxAtTheTime: [] }]);
    /* And the evidence: an append-only row saying we ASKED, not that we were told. */
    expect(await eventTypes()).toEqual(['verify.captured']);
  });

  it('is not applied twice when the sweep runs again', async () => {
    const intent = await anIntent('idem-twice');
    provider.settle(intent.providerIntentId!, 'captured');

    await syncPaymentIntents(db, deps(), NOW);
    /* The re-check floor would normally stop a second ask this soon, so the
       candidate is forced back into range to drive the dedupe rather than the
       floor — the floor has its own case below. */
    await db.execute(sql`UPDATE shop_payment_intents SET provider_synced_at = NULL`);
    const second = await syncPaymentIntents(db, deps(), NOW + 1000);

    expect(second.captured).toBe(0);
    /* One announcement, one event row, and Cart asked exactly once — a second
       capture must be a no-op at every layer, not just at the status. */
    expect(await outboxTypes()).toEqual(['payment.captured']);
    expect(await eventTypes()).toEqual(['verify.captured']);
    expect(completions).toHaveLength(1);
  });

  it('is found by the admin button too, ignoring the re-check floor', async () => {
    const intent = await anIntent('idem-button');
    provider.settle(intent.providerIntentId!, 'captured');
    /* Asked seconds ago — the sweep would skip it, a person pressing a button
       must not be made to wait fifteen minutes for their own answer. */
    await db.execute(sql`UPDATE shop_payment_intents SET provider_synced_at = ${NOW}`);
    expect(await listIntentsToSync(db, { now: NOW, limit: 10 })).toEqual([]);

    const { result, intent: after } = await refreshIntentNow(db, intent.id, {
      provider,
      checkout,
      now: NOW,
    });

    expect(result.gatewayStatus).toBe('captured');
    expect(result.moved).toBe(true);
    expect(after.status).toBe('captured');
  });
});

describe('what it refuses to count', () => {
  it('records a short payment as an anomaly and applies nothing', async () => {
    const intent = await anIntent('idem-short');
    /* Paid — but not what we asked for. `chargeVerdict`'s case, reached through a
       verification exactly as a real underpayment would be. */
    provider.settle(intent.providerIntentId!, 'captured', { amount: 40_000 });

    const out = await syncPaymentIntents(db, deps(), NOW);

    expect(out).toMatchObject({ checked: 1, changed: 0, captured: 0 });
    /* The money is NOT counted: no order is announced and the intent stays
       unpaid, which is the only honest outcome for "they paid the wrong sum". */
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    expect(await outboxTypes()).toEqual([]);
    /* But it is written down — an operator has to be able to find it. */
    const res = await db.execute(sql`SELECT anomaly FROM shop_payment_events`);
    expect(res.rows[0]?.anomaly).toBeTruthy();
  });

  it('writes no event at all for a payment that simply has not happened', async () => {
    const intent = await anIntent('idem-unpaid');

    const out = await syncPaymentIntents(db, deps(), NOW);

    expect(out).toEqual({ checked: 1, changed: 0, captured: 0, failed: 0 });
    /*
     * THE ABSENCE OF NEWS IS NOT NEWS. An abandoned cart is asked about every
     * fifteen minutes for three days; if each answer wrote a row, the money log
     * would fill with `verify.requires_payment` for carts nobody ever paid.
     */
    expect(await eventTypes()).toEqual([]);
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    /* We still record that we looked, or the page would never advance past it. */
    expect(await syncedAt(intent.id)).toBe(NOW);
  });
});

describe('one gateway being down', () => {
  it('costs that intent its answer and no other', async () => {
    const unreachable = await anIntent('idem-down-1');
    const paid = await anIntent('idem-down-2');
    provider.settle(paid.providerIntentId!, 'captured');
    /*
     * WHICH INTENT IS ASKED FIRST IS PINNED, not left to id order: the queue is
     * `provider_synced_at ASC NULLS FIRST, id ASC`, so giving `paid` a stale
     * timestamp puts the never-asked one in front of it. Without this the
     * programmed failure lands on whichever id sorted lower, and the case passes
     * or fails by luck — it did, on the first run.
     */
    await db.execute(
      sql`UPDATE shop_payment_intents SET provider_synced_at = ${NOW - 60 * 60_000}
           WHERE id = ${paid.id}`,
    );
    /* So this failure is consumed by `unreachable`, and `paid` is asked after. */
    provider.program('fetchIntent', { kind: 'fail', code: 'provider_unavailable' });

    const out = await syncPaymentIntents(db, deps(), NOW);

    expect(out.checked).toBe(2);
    expect(out.failed).toBe(1);
    /* The one that WAS reachable and had been paid is recovered regardless —
       a gateway's bad afternoon must not cost the other payments their answer. */
    expect((await getIntent(db, paid.id))?.status).toBe('captured');
    /* And both advanced, so a permanently-failing reference cannot starve the
       queue behind it on every pass forever. */
    expect(await syncedAt(unreachable.id)).toBe(NOW);
    expect(await syncedAt(paid.id)).toBe(NOW);
  });

  it('records why, on the intent the operator is looking at', async () => {
    const intent = await anIntent('idem-why');
    provider.program('fetchIntent', { kind: 'fail', code: 'provider_unavailable' });

    await syncPaymentIntents(db, deps(), NOW);

    expect(await lastErrorOf(intent.id)).toBeTruthy();
  });

  it('treats a gateway with no keys here as a recorded failure, not a silent skip', async () => {
    const intent = await anIntent('idem-nokeys');
    provider.settle(intent.providerIntentId!, 'captured');

    const out = await syncPaymentIntents(db, deps({ providerFor: () => null }), NOW);

    expect(out).toEqual({ checked: 1, changed: 0, captured: 0, failed: 1 });
    /* Nothing was applied, because nothing was asked — and the row says so
       rather than looking like a payment we checked and found unpaid. */
    expect((await getIntent(db, intent.id))?.status).toBe('requires_payment');
    expect(await lastErrorOf(intent.id)).toContain('not set up');
  });
});

describe('which payments it asks about', () => {
  it('skips one that is already captured or beyond', async () => {
    const intent = await anIntent('idem-done');
    provider.settle(intent.providerIntentId!, 'captured');
    await syncPaymentIntents(db, deps(), NOW);
    await db.execute(sql`UPDATE shop_payment_intents SET provider_synced_at = NULL`);

    /* Settled money is not a candidate: the ladder puts `captured` at the top,
       and a refund's unknown answer is resolved by the owner elsewhere. */
    expect(await listIntentsToSync(db, { now: NOW + 1000, limit: 10 })).toEqual([]);
  });

  it('still asks about one we gave up on, because money can still arrive', async () => {
    const intent = await anIntent('idem-failed');
    await db.execute(sql`UPDATE shop_payment_intents SET status = 'failed' WHERE id = ${intent.id}`);
    provider.settle(intent.providerIntentId!, 'captured');

    /*
     * `paymentStatusRank` puts `failed` and `cancelled` BELOW `authorized` for
     * exactly this reason: Paystack lets a customer retry a failed attempt on the
     * same reference, so `failed → captured` is a real transition. A candidate
     * query that listed statuses by hand would eventually disagree with that
     * ladder; this one asks the ladder.
     */
    const out = await syncPaymentIntents(db, deps(), NOW);

    expect(out.captured).toBe(1);
    expect((await getIntent(db, intent.id))?.status).toBe('captured');
  });

  it('skips one with no gateway reference, because there is nothing to ask', async () => {
    const intent = await anIntent('idem-noref');
    await db.execute(
      sql`UPDATE shop_payment_intents SET provider_intent_id = NULL WHERE id = ${intent.id}`,
    );

    expect(await listIntentsToSync(db, { now: NOW, limit: 10 })).toEqual([]);
  });

  it('skips one older than the window', async () => {
    const intent = await anIntent('idem-old');
    /* Four days old: a checkout link nobody paid in three days is not going to
       be paid, and the candidate set is every abandoned cart the shop ever had. */
    const old = NOW - 4 * 24 * 60 * 60 * 1000;
    await db.execute(sql`UPDATE shop_payment_intents SET created_at = ${old} WHERE id = ${intent.id}`);

    expect(await listIntentsToSync(db, { now: NOW, limit: 10 })).toEqual([]);
  });

  it('skips one asked about inside the re-check floor, and takes it after', async () => {
    const intent = await anIntent('idem-floor');
    await db.execute(
      sql`UPDATE shop_payment_intents SET provider_synced_at = ${NOW} WHERE id = ${intent.id}`,
    );

    const tooSoon = await listIntentsToSync(db, { now: NOW + 60_000, limit: 10 });
    const later = await listIntentsToSync(db, { now: NOW + 20 * 60_000, limit: 10 });

    expect(tooSoon).toEqual([]);
    expect(later.map((i) => i.id)).toEqual([intent.id]);
  });

  it('never asks about more than one page', async () => {
    for (let n = 0; n < PAYMENT_SYNC_LIMIT + 3; n += 1) await anIntent(`idem-page-${n}`);

    const out = await syncPaymentIntents(db, deps(), NOW);

    /* The bound is the point: `vercel.json` caps this function at 30 seconds and
       does not retry what it killed, so a backlog has to drain across runs. */
    expect(out.checked).toBe(PAYMENT_SYNC_LIMIT);
  });

  it('takes the ones nobody has ever asked about first', async () => {
    const asked = await anIntent('idem-order-asked');
    const never = await anIntent('idem-order-never');
    await db.execute(
      sql`UPDATE shop_payment_intents SET provider_synced_at = ${NOW - 60 * 60_000} WHERE id = ${asked.id}`,
    );

    const page = await listIntentsToSync(db, { now: NOW, limit: 10 });

    expect(page[0]?.id).toBe(never.id);
  });
});

describe('reconcileIntent is the one mechanism', () => {
  it('reports newEvent separately from moved, which is what a caller sweeps on', async () => {
    const intent = await anIntent('idem-shape');
    provider.settle(intent.providerIntentId!, 'captured');

    const first = await reconcileIntent(db, intent, { provider, checkout, now: NOW });
    /* The same answer a second time: a NEW event was not written, so a caller
       must not run a sweep for it — the distinction the confirm route needs. */
    const again = await reconcileIntent(db, intent, { provider, checkout, now: NOW });

    expect(first).toMatchObject({ gatewayStatus: 'captured', moved: true, newEvent: true });
    expect(again).toMatchObject({ moved: false, newEvent: false, duplicate: true });
  });
});
