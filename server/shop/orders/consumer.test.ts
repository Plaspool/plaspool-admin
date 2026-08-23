/**
 * The event consumer (brief §4, contract §6) — driven ENTIRELY from the fixture file,
 * with Catalog, Cart and Payments not existing.
 *
 * FOUR PROPERTIES CARRY THIS FILE.
 *
 * **Idempotency is a constraint, not a prior read.** Brief §4 is explicit, and Part 2b
 * is why: a `SELECT` that decides whether to insert is evaluated against a snapshot a
 * concurrent writer has already invalidated. So the tests below do not merely assert
 * "one order" — they DROP the constraints and assert that two appear, which is the only
 * way to know which mechanism was doing the work.
 *
 * **Out-of-order is ordinary.** `payment.captured` before `checkout.completed` parks
 * with a recognisable message and resolves later. It never throws and never drops.
 *
 * **Unknown types are ignored and logged.** That is what lets Payments ship an event
 * type before this build has heard of it — the entire premise of four concurrent
 * subsystems.
 *
 * **Totals are copied, never recomputed.** The inconsistent-totals fixture must survive
 * a round trip through the database unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import {
  CHECKOUT,
  CUSTOMER_A,
  T0,
  checkoutCompleted,
  checkoutMalformed,
  checkoutWithInconsistentTotals,
  consumptionOf,
  emittedEvents,
  insertEvents,
  otherSubsystemEvent,
  outboxState,
  paymentAuthorized,
  paymentCaptured,
  paymentFailed,
  paymentRefunded,
  paymentRefundFailed,
  unknownType,
  type EventFixture,
} from './test/fixtures';
import {
  PARK_ATTEMPT_LIMIT,
  handleEvent,
  sweepCommerceEvents,
  type ConsumerDeps,
} from './repo/consumer';
import { listTimeline, readOrderByCheckout } from './repo/orders';
import { listIntents } from './repo/emails';

let ctx: RawCtx;

/** No origin, so emails carry no link — the link itself is tested in `emails.test.ts`. */
const DEPS: ConsumerDeps = { origin: null };

const NOW = T0 + 10_000;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/** Write fixtures and drain the outbox once, as a cron invocation would. */
async function drive(rows: EventFixture[], now = NOW) {
  await insertEvents(ctx.db, rows);
  return sweepCommerceEvents(ctx.db, DEPS, now);
}

/**
 * Run a body with `commerce_events_type_ck` removed — and this helper is itself a
 * finding, recorded as `AMENDMENTS.md` A-002.
 *
 * `0140_payments` adds `CHECK (type IN (…the eleven…))` to the shared outbox, reasoning
 * that "a type outside the list is a §6 violation, and a loud one here beats an event
 * nobody consumes". That is defensible on its own terms. Its measured consequence is
 * that **contract §6 rule 4 cannot be reached through the database at all**: a row whose
 * type this build has never heard of is `23514` at insert time, so the branch that
 * "ignores it and logs" is unreachable from a real table.
 *
 * Worse, and this is the part that is not merely academic: §6 rule 1 requires the event
 * to be written in the SAME TRANSACTION as the state change that caused it. So a
 * producer that emits a twelfth type before the migration adding it has run does not get
 * a logged no-op — **it loses its state change**. A capture would roll back because the
 * outbox refused the event type.
 *
 * The consumer's behaviour is correct either way and is what is under test here, so the
 * constraint is lifted for the duration rather than worked around. Nothing in
 * `server/shop/orders/**` depends on its absence.
 */
async function withoutEventTypeCheck(body: () => Promise<void>): Promise<void> {
  await ctx.db.execute(sql`ALTER TABLE commerce_events DROP CONSTRAINT IF EXISTS commerce_events_type_ck`);
  try {
    await body();
  } finally {
    // The rows written by the body would themselves violate the constraint being put
    // back, so the table is emptied first. `beforeEach` would do it anyway; doing it
    // here keeps the restore from depending on test order.
    await resetOrderTables(ctx.db);
    await ctx.db.execute(sql`
      ALTER TABLE commerce_events ADD CONSTRAINT commerce_events_type_ck CHECK (type IN (
        'catalog.variant.published', 'catalog.variant.unpublished',
        'catalog.inventory.adjusted', 'checkout.completed',
        'payment.authorized', 'payment.captured', 'payment.failed',
        'payment.refunded', 'payment.refund_failed',
        'order.created', 'order.fulfilled', 'order.cancelled'))`);
  }
}

async function orderCount(): Promise<number> {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_orders`);
  return Number(res.rows[0].n);
}

// -------------------------------------------------------------- order creation

describe('checkout.completed creates the order', () => {
  it('status pending, everything snapshotted, totals frozen', async () => {
    const summary = await drive([checkoutCompleted()]);
    expect(summary).toMatchObject({ applied: 1, ignored: 0, parked: 0 });

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read).not.toBeNull();
    expect(read?.order).toMatchObject({
      status: 'pending',
      customerId: CUSTOMER_A,
      email: 'Buyer@Example.test',
      currency: 'USD',
      subtotal: 4500,
      shippingTotal: 500,
      taxTotal: 400,
      grandTotal: 5400,
      refundedTotal: 0,
      paidAt: null,
      revision: 1,
      checkoutId: CHECKOUT,
    });
    // `placedAt` is when the CHECKOUT completed, not when this sweep ran.
    expect(read?.order.placedAt).toBe(T0);
    expect(read?.order.orderNumber).toMatch(/^\d{4}-\d{6}-[A-Z]$/);

    // The address is a SNAPSHOT, stored not referenced.
    expect(read?.order.shippingAddress).toEqual({
      name: 'A Buyer',
      line1: '1 Test Street',
      country: 'GB',
    });

    // Every line field is a snapshot too — sku, title, options, unit price.
    expect(read?.lines).toHaveLength(2);
    expect(read?.lines[0]).toMatchObject({
      lineNo: 0,
      variantId: 'var_mug_navy',
      sku: 'MUG-NAVY',
      title: 'Enamel Mug',
      optionValues: { Colour: 'Navy' },
      qty: 2,
      unitAmount: 1500,
      lineTotal: 3000,
      fulfilledQty: 0,
    });
  });

  it('NO order.created is emitted yet — an unpaid order is not one to act on', async () => {
    await drive([checkoutCompleted()]);
    expect(await emittedEvents(ctx.db)).toEqual([]);
  });

  it('writes one timeline entry and the "we have your order" email', async () => {
    /*
     * THE EMAIL IS NEW HERE (migration 0320) AND IT IS SAFE BECAUSE OF WHEN THIS
     * EVENT FIRES. `checkout.completed` is emitted by `CheckoutPort.complete`,
     * which is called from the CAPTURE path — so it exists only for a customer
     * whose charge already succeeded at Paystack. A declined card never produces
     * this event and therefore never produces this message, which was the concern
     * that kept the create path silent until now.
     *
     * What it buys: the order is still `pending` at this point and stays that way
     * until `payment.captured` is applied by a later sweep — up to a minute on
     * this deployment. Sending nothing left the customer with a confirmation page
     * that times out and no mail, whose obvious reading is "it failed, pay again".
     */
    await drive([checkoutCompleted()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    const timeline = await listTimeline(ctx.db, read!.order.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: 'placed', message: 'Order placed' });

    const intents = await listIntents(ctx.db, read!.order.id);
    expect(intents.map((i) => i.kind)).toEqual(['placed']);
    /* It must NOT claim the money has arrived — the capture can still fail, and
     * "payment received" followed by a cancellation is worse than saying nothing. */
    expect(intents[0].body).not.toContain('payment received');
    expect(intents[0].subject).toContain('We have your order');
  });

  it('STORES TOTALS THAT DO NOT ADD UP, through the database, unchanged', async () => {
    // The end-to-end version of the `inbound.test.ts` case: proof that nothing between
    // the payload and the column recomputes a frozen total.
    await drive([checkoutWithInconsistentTotals()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order).toMatchObject({
      subtotal: 1,
      shippingTotal: 1,
      taxTotal: 1,
      grandTotal: 5400,
    });
  });
});

// ------------------------------------------------------------------ idempotency

describe('redelivery creates exactly one order (brief §8)', () => {
  it('the same event three times, concurrently', async () => {
    /*
     * THREE CALLS, ONE STATEMENT EACH. PGlite is one connection with a FIFO queue, so
     * the three inserts are serialised at the driver — which is exactly the interleaving
     * that matters here: each call has already read and decided before the others' rows
     * exist, and the CONSTRAINT is what refuses the second and third. A prior-read guard
     * would let all three through, which is what the mutation test below measures.
     */
    const row = checkoutCompleted();
    await insertEvents(ctx.db, [row]);
    const event = {
      id: row.id,
      type: row.type,
      subjectId: row.subjectId,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: 0,
    };

    const results = await Promise.all([
      handleEvent(ctx.db, event, DEPS, NOW),
      handleEvent(ctx.db, event, DEPS, NOW),
      handleEvent(ctx.db, event, DEPS, NOW),
    ]);

    expect(await orderCount()).toBe(1);
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'ignored')).toHaveLength(2);
  });

  it('two sweeps over the same row: the second finds nothing to do', async () => {
    await drive([checkoutCompleted()]);
    const second = await sweepCommerceEvents(ctx.db, DEPS, NOW + 1);
    // The consumption row takes it out of the candidate set entirely.
    expect(second).toMatchObject({ applied: 0, ignored: 0, parked: 0 });
    expect(await orderCount()).toBe(1);
  });

  it('a DIFFERENT event id for the same checkout is still one order', async () => {
    /*
     * The case `source_event_id` alone cannot see, and the reason `checkout_id` is also
     * UNIQUE: a provider or an operator re-emitting `checkout.completed` under a fresh
     * id. Nothing about the second row looks like a duplicate until the constraint says
     * so.
     */
    await drive([checkoutCompleted()]);
    const reissued = { ...checkoutCompleted(), id: 'evt_checkout_2', occurredAt: T0 + 5 };
    const summary = await drive([reissued], NOW + 1);

    expect(summary).toMatchObject({ applied: 0, ignored: 1 });
    expect(await orderCount()).toBe(1);
    expect((await consumptionOf(ctx.db, 'evt_checkout_2'))?.detail).toContain('duplicate order');
  });

  it('THE CONSTRAINTS ARE LOAD-BEARING: dropped, the redelivery creates a second order', async () => {
    /*
     * THE MUTATION TEST. Part 2b found that replacing `deleted_at IS NULL` with `true`
     * broke none of 254 tests, because every precondition was satisfied by a JS check on
     * a stale read. The equivalent here is dropping the three constraints that decide
     * idempotency and asserting that the suite's "exactly one order" property BREAKS. If
     * this test ever stops producing two orders, a prior read has crept in and the
     * constraint has gone quiet.
     *
     * `mutating()` — the SQL-rewriting proxy in `server/repo/lifecycle.test.ts` — cannot
     * reach these: they are DDL, not a predicate in a statement. Dropping them is the
     * same operator applied one level down, and it is strictly stronger: it removes the
     * guarantee from the database rather than from one statement's text.
     */
    await ctx.db.execute(sql`ALTER TABLE shop_orders DROP CONSTRAINT shop_orders_checkout_uq`);
    await ctx.db.execute(sql`ALTER TABLE shop_orders DROP CONSTRAINT shop_orders_source_event_uq`);
    await ctx.db.execute(sql`
      ALTER TABLE shop_order_event_consumptions DROP CONSTRAINT shop_order_event_consumptions_pk`);
    try {
      const row = checkoutCompleted();
      await insertEvents(ctx.db, [row]);
      const event = {
        id: row.id,
        type: row.type,
        subjectId: row.subjectId,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: 0,
      };
      await handleEvent(ctx.db, event, DEPS, NOW);
      await handleEvent(ctx.db, event, DEPS, NOW);

      // TWO orders for one checkout: the defect, reproduced on demand.
      expect(await orderCount()).toBe(2);
    } finally {
      /*
       * The duplicate rows this test just created would themselves violate the
       * constraints being restored, so the tables are emptied first. Measured: without
       * this, `ADD CONSTRAINT … PRIMARY KEY` raises 23505 and the failure is reported
       * against the mutation test rather than against the cleanup.
       */
      await resetOrderTables(ctx.db);
      await ctx.db.execute(sql`
        ALTER TABLE shop_order_event_consumptions
          ADD CONSTRAINT shop_order_event_consumptions_pk PRIMARY KEY (consumer, event_id)`);
      await ctx.db.execute(sql`
        ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_source_event_uq UNIQUE (source_event_id)`);
      await ctx.db.execute(sql`
        ALTER TABLE shop_orders ADD CONSTRAINT shop_orders_checkout_uq UNIQUE (checkout_id)`);
    }
  });
});

// ------------------------------------------------------------- out of order

describe('events arrive out of order (brief §4)', () => {
  it('payment.captured before checkout.completed PARKS, then resolves', async () => {
    const captured = paymentCaptured();
    const first = await drive([captured]);

    expect(first).toMatchObject({ applied: 0, ignored: 0, parked: 1 });
    expect(await orderCount()).toBe(0);

    // Parked, not dropped: `processed_at` stays NULL, `last_error` says why, and there
    // is NO consumption row — which is what makes it retryable (§6 rule 3).
    const state = await outboxState(ctx.db, captured.id);
    expect(state.processedAt).toBeNull();
    expect(state.attempts).toBe(1);
    expect(state.lastError).toContain('awaiting predecessor: checkout.completed');
    expect(await consumptionOf(ctx.db, captured.id)).toBeNull();

    // The predecessor arrives. One sweep resolves both, oldest first.
    const second = await drive([checkoutCompleted()], NOW + 1);
    expect(second.applied).toBe(2);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('paid');
    expect((await outboxState(ctx.db, captured.id)).processedAt).toBe(NOW + 1);
  });

  it('both in one sweep, in the wrong insertion order, still works', async () => {
    /*
     * The sweep orders by `occurred_at`, so a capture written to the table BEFORE its
     * checkout is still processed after it. Processing by arrival order would park on
     * every provider retry.
     */
    const summary = await drive([paymentCaptured(), checkoutCompleted()]);
    expect(summary).toMatchObject({ applied: 2, parked: 0 });
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.status).toBe('paid');
  });

  it('a park is retried on the next sweep and abandoned only after the limit', async () => {
    const captured = paymentCaptured();
    await insertEvents(ctx.db, [captured]);

    for (let i = 1; i <= PARK_ATTEMPT_LIMIT; i += 1) {
      const summary = await sweepCommerceEvents(ctx.db, DEPS, NOW + i);
      expect(summary.parked, `sweep ${i}`).toBe(1);
      expect((await outboxState(ctx.db, captured.id)).attempts).toBe(i);
    }

    // Abandoned: a consumption row appears so the sweep budget is not spent forever.
    const abandoned = await consumptionOf(ctx.db, captured.id);
    expect(abandoned?.outcome).toBe('abandoned');
    // And it DESTROYED NOTHING — the payload and the error are still there.
    const state = await outboxState(ctx.db, captured.id);
    expect(state.lastError).toContain('awaiting predecessor');
    expect(await sweepCommerceEvents(ctx.db, DEPS, NOW + 99)).toMatchObject({ parked: 0 });

    // Recovery is a human deleting the consumption row, which puts it back in the set.
    await ctx.db.execute(sql`
      DELETE FROM shop_order_event_consumptions WHERE event_id = ${captured.id}`);
    expect(await sweepCommerceEvents(ctx.db, DEPS, NOW + 100)).toMatchObject({ parked: 1 });
  });

  it('a payload this build cannot read PARKS rather than being lost', async () => {
    /*
     * PARKED AND NOT IGNORED, deliberately. During a parallel build the realistic cause
     * is that this consumer's schema is wrong, and the fix is a redeploy — after which
     * the row must still be there to process. Ignoring it would discard a completed
     * checkout because of a field name.
     */
    const bad = checkoutMalformed();
    const summary = await drive([bad]);
    expect(summary).toMatchObject({ parked: 1 });
    expect(await consumptionOf(ctx.db, bad.id)).toBeNull();
    expect((await outboxState(ctx.db, bad.id)).lastError).toContain('payload not readable');
    // The field path, never the value.
    expect((await outboxState(ctx.db, bad.id)).lastError).not.toContain('two things');
  });
});

// ------------------------------------------------------------- unknown types

describe('unknown and unhandled types (contract §6 rule 4)', () => {
  it('an unknown type is ignored and logged, never thrown', async () => {
    await withoutEventTypeCheck(async () => {
      const summary = await drive([unknownType()]);
      expect(summary).toMatchObject({ applied: 0, ignored: 1, parked: 0 });
      const consumption = await consumptionOf(ctx.db, 'evt_unknown_1');
      expect(consumption?.outcome).toBe('ignored');
      expect(consumption?.detail).toContain('unknown type: loyalty.points.awarded');
    });
  });

  it('and the shared CHECK is currently what makes that branch unreachable', async () => {
    /*
     * THE FINDING, AS AN ASSERTION (AMENDMENTS.md A-002). With
     * `commerce_events_type_ck` in place — added by `0140_payments` — a twelfth event
     * type cannot be WRITTEN at all. Since §6 rule 1 requires the event to be written in
     * the same transaction as the state change that caused it, the producer of such an
     * event does not get a logged no-op in its consumer: it loses its own state change to
     * a 23514.
     *
     * Asserted here rather than argued in a document, because §9's evidence rule is
     * binding and because this test will start failing the day the constraint changes —
     * which is exactly when this comment should be re-read.
     */
    await expect(insertEvents(ctx.db, [unknownType()])).rejects.toMatchObject({
      code: '23514',
      constraint: 'commerce_events_type_ck',
    });
  });

  it('a KNOWN type this subsystem does not handle is ignored too', async () => {
    const summary = await drive([otherSubsystemEvent()]);
    expect(summary).toMatchObject({ ignored: 1 });
    expect((await consumptionOf(ctx.db, 'evt_catalog_1'))?.detail).toContain('not handled by orders');
  });

  it('this subsystem ignores its OWN emissions rather than re-examining them forever', async () => {
    // `order.created` etc. land in the same table this consumer reads. Without an
    // explicit decline they would be candidates on every sweep for the life of the shop.
    await drive([checkoutCompleted(), paymentCaptured()]);
    const emitted = await emittedEvents(ctx.db);
    expect(emitted).toHaveLength(1);

    const next = await sweepCommerceEvents(ctx.db, DEPS, NOW + 1);
    expect(next).toMatchObject({ applied: 0, ignored: 1, parked: 0 });
    expect((await consumptionOf(ctx.db, emitted[0].id))?.outcome).toBe('ignored');

    // And once declined, it is never a candidate again.
    expect(await sweepCommerceEvents(ctx.db, DEPS, NOW + 2)).toMatchObject({ ignored: 0 });
  });

  it('one bad row does not stop the rest of the sweep', async () => {
    await withoutEventTypeCheck(async () => {
      const summary = await drive([
        unknownType(),
        checkoutMalformed(),
        checkoutCompleted(),
        paymentCaptured(),
      ]);
      expect(summary.applied).toBe(2);
      expect(summary.ignored).toBe(1);
      expect(summary.parked).toBe(1);
      expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.status).toBe('paid');
    });
  });
});

// ------------------------------------------------------------ payment reactions

describe('payment.authorized', () => {
  it('records on the timeline and changes no status (brief §4)', async () => {
    await drive([checkoutCompleted(), paymentAuthorized()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('pending');
    expect(read?.order.revision).toBe(1);
    const timeline = await listTimeline(ctx.db, read!.order.id);
    expect(timeline.map((entry) => entry.type)).toEqual(['placed', 'payment_authorized']);
  });

  it('is exactly-once even though it CASes nothing', async () => {
    await drive([checkoutCompleted(), paymentAuthorized()]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW + 1);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    const authorizations = (await listTimeline(ctx.db, read!.order.id)).filter(
      (entry) => entry.type === 'payment_authorized',
    );
    expect(authorizations).toHaveLength(1);
  });
});

describe('payment.captured', () => {
  it('order → paid, emits order.created, writes the confirmation intent', async () => {
    await drive([checkoutCompleted(), paymentCaptured()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order).toMatchObject({ status: 'paid', paidAt: NOW });

    const emitted = await emittedEvents(ctx.db);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('order.created');
    expect(emitted[0].subjectId).toBe(read!.order.id);
    expect(emitted[0].payload).toMatchObject({
      orderNumber: read!.order.orderNumber,
      checkoutId: CHECKOUT,
      customerId: CUSTOMER_A,
      total: { amount: 5400, currency: 'USD' },
      paidAt: NOW,
    });
    // The lines ride along so no consumer has to ask Catalog what was bought.
    expect((emitted[0].payload.lines as unknown[])).toHaveLength(2);

    /* Two by this point: `placed` from `checkout.completed`, `confirmation` from
     * the capture. Both unsent — the sweeper has not run. */
    const intents = await listIntents(ctx.db, read!.order.id);
    expect(intents.map((i) => i.kind)).toEqual(['placed', 'confirmation']);
    const confirmation = intents.find((i) => i.kind === 'confirmation')!;
    expect(confirmation).toMatchObject({ sentAt: null, attempts: 0 });
    expect(confirmation.subject).toContain('confirmed');
  });

  it('a capture against a CANCELLED order is an anomaly, recorded and not applied', async () => {
    /*
     * Reachable, and Payments' own status ladder says so: `failed → captured` is real
     * because a customer can pay a checkout we locally gave up on. Resurrecting the
     * order would override a deliberate cancellation and re-sell released stock;
     * dropping the event silently would lose the fact that money exists. So: no state
     * change, and a loud `anomaly:` record.
     */
    await drive([checkoutCompleted(), paymentFailed()]);
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.status).toBe('cancelled');

    const late = paymentCaptured({ id: 'evt_captured_late', occurredAt: T0 + 3000 });
    const summary = await drive([late], NOW + 1);

    /*
     * Asserted per-event rather than on the aggregate count: the previous sweep EMITTED
     * `order.cancelled`, which is an unprocessed candidate this consumer also declines, so
     * `ignored` is legitimately 2. An aggregate assertion here would have been a test that
     * passes for the wrong reason as soon as the emit set changes.
     */
    expect(summary.applied).toBe(0);
    const forLate = summary.dispositions.find((d) => d.eventId === 'evt_captured_late');
    expect(forLate?.disposition.kind).toBe('ignored');
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('cancelled');
    expect(read?.order.paidAt).toBeNull();
    const consumption = await consumptionOf(ctx.db, 'evt_captured_late');
    expect(consumption?.detail).toContain('anomaly: capture for a cancelled order');
    expect((await outboxState(ctx.db, 'evt_captured_late')).lastError).toContain('anomaly:');
  });
});

describe('payment.failed', () => {
  it('order → cancelled, and order.cancelled carries the lines so stock can be released', async () => {
    await drive([checkoutCompleted(), paymentFailed()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order).toMatchObject({ status: 'cancelled', cancelledAt: NOW });

    const emitted = await emittedEvents(ctx.db);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('order.cancelled');
    expect(emitted[0].payload).toMatchObject({ reason: 'payment_failed', actorId: null });
    expect(emitted[0].payload.lines).toEqual([
      { orderLineId: read!.lines[0].id, variantId: 'var_mug_navy', sku: 'MUG-NAVY', qty: 2 },
      { orderLineId: read!.lines[1].id, variantId: 'var_tee_m', sku: 'TEE-M', qty: 1 },
    ]);
  });

  it('sends NO cancellation email for an order that was never paid', async () => {
    // A `pending` order is a checkout whose payment never completed. The customer has
    // not been charged and has no reason to hear from us; mailing them would turn every
    // card decline into a message about an order they do not believe they placed.
    await drive([checkoutCompleted(), paymentFailed()]);
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    /*
     * The `placed` intent from `checkout.completed` is there and is expected; what
     * this test is about is that NO CANCELLATION was added on top of it. The rule
     * is unchanged by migration 0320 — only the baseline it is measured against.
     */
    const kinds = (await listIntents(ctx.db, read!.order.id)).map((i) => i.kind);
    expect(kinds).toEqual(['placed']);
    expect(kinds).not.toContain('cancellation');
  });

  it('but DOES mail when the order had been paid', async () => {
    await drive([checkoutCompleted(), paymentCaptured()]);
    const failed = paymentFailed({ id: 'evt_failed_late', occurredAt: T0 + 4000 });
    await drive([failed], NOW + 1);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('cancelled');
    const kinds = (await listIntents(ctx.db, read!.order.id)).map((i) => i.kind);
    expect(kinds).toEqual(['placed', 'confirmation', 'cancellation']);
  });
});

describe('payment.refunded', () => {
  it('a partial refund → partially_refunded, decided against the frozen total', async () => {
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive([paymentRefunded({ refundedAmount: 1400, refundedTotal: 1400 })], NOW + 1);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order).toMatchObject({ status: 'partially_refunded', refundedTotal: 1400 });
  });

  it('a full refund → refunded', async () => {
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive([paymentRefunded({ refundedAmount: 5400, refundedTotal: 5400 })], NOW + 1);
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order).toMatchObject({
      status: 'refunded',
      refundedTotal: 5400,
    });
  });

  it('the cumulative total is COPIED, not accumulated', async () => {
    /*
     * `refundedTotal` is every succeeded refund against the intent, including this one.
     * Accumulating (`+= refundedAmount`) would double-count a redelivery and would end
     * on whichever of two out-of-order events arrived last. Two partial refunds of 1400
     * and 2000 must leave 3400, not 4800.
     */
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive(
      [paymentRefunded({ id: 'evt_ref_1', refundId: 'ref_1', refundedAmount: 1400, refundedTotal: 1400 })],
      NOW + 1,
    );
    await drive(
      [paymentRefunded({ id: 'evt_ref_2', refundId: 'ref_2', refundedAmount: 2000, refundedTotal: 3400 })],
      NOW + 2,
    );

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order).toMatchObject({ status: 'partially_refunded', refundedTotal: 3400 });
  });

  it('a LATE OLDER refund event cannot walk the figure backwards', async () => {
    // `GREATEST` is what makes out-of-order safe. Without it, the 1400 arriving second
    // would report the order as less refunded than it is — and the customer would be
    // told they are still charged for money we have already returned.
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive(
      [paymentRefunded({ id: 'evt_ref_2', refundId: 'ref_2', refundedAmount: 2000, refundedTotal: 3400 })],
      NOW + 1,
    );
    await drive(
      [paymentRefunded({ id: 'evt_ref_1', refundId: 'ref_1', refundedAmount: 1400, refundedTotal: 1400 })],
      NOW + 2,
    );

    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.refundedTotal).toBe(3400);
  });

  it('writes one refund email per refund event, not per order', async () => {
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive(
      [paymentRefunded({ id: 'evt_ref_1', refundId: 'ref_1', refundedAmount: 1400, refundedTotal: 1400 })],
      NOW + 1,
    );
    await drive(
      [paymentRefunded({ id: 'evt_ref_2', refundId: 'ref_2', refundedAmount: 2000, refundedTotal: 3400 })],
      NOW + 2,
    );

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    const refunds = (await listIntents(ctx.db, read!.order.id)).filter((i) => i.kind === 'refund');
    expect(refunds).toHaveLength(2);
  });

  it('a refund for an order that does not exist parks', async () => {
    const summary = await drive([paymentRefunded()]);
    expect(summary).toMatchObject({ parked: 1 });
    expect((await outboxState(ctx.db, 'evt_refund_1')).lastError).toContain(
      'awaiting predecessor',
    );
  });
});

describe('payment.refund_failed (task-d4)', () => {
  it('writes a refund_failed timeline entry and changes no status', async () => {
    // Two separate sweeps, deliberately: `paid` and `refund_failed` are both
    // stamped with the SWEEP's `now`, and ids.ts says plainly that ULID order
    // within one millisecond is random — a single combined drive would give
    // both entries the SAME occurred_at and make the ordering assertion below
    // a coin flip. Two `now` values (`NOW`, `NOW + 1`) settle it honestly.
    await drive([checkoutCompleted(), paymentCaptured()]);
    await drive([paymentRefundFailed()], NOW + 1);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    // UNCHANGED — this event never transitions `shop_orders.status`, on
    // purpose. See `recordRefundFailure`'s own comment in `./repo/orders`.
    expect(read?.order.status).toBe('paid');
    const timeline = await listTimeline(ctx.db, read!.order.id);
    expect(timeline.map((entry) => entry.type)).toEqual(['placed', 'paid', 'refund_failed']);
    expect(timeline.at(-1)?.message).toContain('needs attention');
  });

  it('does NOT resurrect an order that is already cancelled', async () => {
    /*
     * THE D3 GAP THIS TASK CLOSES, AS A PROPERTY RATHER THAN A STORY.
     * `payment.failed` is the only way this fixture-only file can reach a
     * cancelled order (the anomaly test above, in `payment.captured`, uses
     * the same route) — it is not the exact D3 choreography (a PAID order
     * cancelled WITH a refund choice, `b9051ab`), which is proven end to end
     * through the real `createApp()` in `composition.test.ts`'s task-d4
     * block. This file's job is the narrower, subsystem-level property: NO
     * MATTER HOW the order came to be cancelled, this event does not move it.
     * Un-cancelling here would be a second, messier failure — reservations
     * already released, goods possibly gone (`recordRefundFailure`'s comment).
     */
    await drive([checkoutCompleted(), paymentFailed()]);
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))?.order.status).toBe('cancelled');

    const summary = await drive([paymentRefundFailed({ occurredAt: T0 + 3000 })], NOW + 1);
    expect(summary).toMatchObject({ applied: 1 });

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read?.order.status).toBe('cancelled');
    const timeline = await listTimeline(ctx.db, read!.order.id);
    expect(timeline.map((entry) => entry.type)).toContain('refund_failed');
  });

  it('three concurrent deliveries of the same event write exactly one timeline entry', async () => {
    /*
     * The redelivery guard this task adds, proven the same way brief §8's own
     * redelivery tests are: THREE CONCURRENT CALLS, ONE CLAIM. PGlite
     * serialises them at the driver, so each has already read and decided
     * before the others' rows exist — `recordRefundFailure`'s `claim` CTE
     * (`ON CONFLICT DO NOTHING` on `(consumer, event_id)`) is what refuses
     * the second and third, not a prior read.
     */
    await drive([checkoutCompleted(), paymentCaptured()]);
    const row = paymentRefundFailed();
    await insertEvents(ctx.db, [row]);
    const event = {
      id: row.id,
      type: row.type,
      subjectId: row.subjectId,
      payload: row.payload,
      occurredAt: row.occurredAt,
      attempts: 0,
    };

    const results = await Promise.all([
      handleEvent(ctx.db, event, DEPS, NOW),
      handleEvent(ctx.db, event, DEPS, NOW),
      handleEvent(ctx.db, event, DEPS, NOW),
    ]);

    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'ignored')).toHaveLength(2);

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    const entries = (await listTimeline(ctx.db, read!.order.id)).filter(
      (entry) => entry.type === 'refund_failed',
    );
    expect(entries).toHaveLength(1);
  });

  it('a refund-failed event for an order that does not exist parks', async () => {
    const summary = await drive([paymentRefundFailed()]);
    expect(summary).toMatchObject({ parked: 1 });
    expect((await outboxState(ctx.db, 'evt_refund_failed_1')).lastError).toContain(
      'awaiting predecessor',
    );
  });
});
