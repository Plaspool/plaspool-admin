/**
 * The order and fulfilment state machines (brief §1, §8).
 *
 * THIS FILE IS THE ONE THE BRIEF WAS WRITTEN FOR. GAUNTLET II Part 2b Round 1 #1:
 *
 * > A predicate over current state alone cannot distinguish "never left A" from "went to
 * > B and came back". Every one of six lifecycle transitions re-applied a lost intent
 * > after an A→B→A interleaving. The measured consequence was a destroyed row with zero
 * > surviving revisions.
 *
 * Here the consequences are worse, and brief §1 names them: a re-applied `cancel` after
 * an operator reinstated an order is **a paid order that never ships**; a re-applied
 * `ship` is **a double shipment**.
 *
 * THREE THINGS EVERY BLOCK BELOW DOES.
 *
 * 1. **The A→B→A itself.** A raw SQL pair moves the row to the inverse state and back,
 *    landing between the operation's read and its CAS — PGlite is one connection with a
 *    FIFO queue, so statements enqueued after the call are enqueued before the suspended
 *    operation resumes. The op must be REFUSED and must write nothing: no status change,
 *    no timeline entry, no outbox event, no email intent.
 *
 * 2. **A mutation test on the generation pin.** Neutralised, the same interleaving
 *    RE-APPLIES — the original defect, reproduced on demand. Written as an assertion that
 *    the mutant misbehaves, so the pin cannot go quiet.
 *
 * 3. **A mutation test per state guard.** Neutralised, an operation that should be refused
 *    goes through. Part 2b found the equivalent guards had zero coverage across 254
 *    passing tests; the assumption here is that these are dead until seen red.
 *
 * THE RAW `UPDATE`s ARE ALSO THE POINT, not a convenience. Part 2b records that the
 * PRESCRIBED fix — a counter maintained by the transition function — did not pass its own
 * reproduction, because raw statements never go through that function. Every interleaving
 * below is raw SQL for exactly that reason: reinstating a wrongly-cancelled order,
 * correcting a status after a dispute and importing historical orders are all hand-run
 * SQL, and the trigger is what makes them move the pin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import { PREDICATE, countingMutant, rejection } from './test/mutate';
import {
  CHECKOUT,
  T0,
  checkoutCompleted,
  emittedEvents,
  insertEvents,
} from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import {
  cancelOrder,
  listTimeline,
  markOrderPaid,
  readOrder,
  readOrderByCheckout,
  refundOrder,
  settleOrderFulfilled,
  type Order,
  type OrderRead,
} from './repo/orders';
import {
  cancelFulfillment,
  createFulfillment,
  deliverFulfillment,
  readFulfillment,
  shipFulfillment,
} from './repo/fulfillments';
import { listIntents } from './repo/emails';
import { PreconditionFailedError, StaleWriteError } from '../../repo/errors';

let ctx: RawCtx;
const DEPS: ConsumerDeps = { origin: null };
const NOW = T0 + 10_000;
const ACTOR = 'usr_owner';

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/** A `pending` order from the fixture checkout. */
async function pendingOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = await readOrderByCheckout(ctx.db, CHECKOUT);
  if (!read) throw new Error('fixture did not create an order');
  return read;
}

async function paidOrder(): Promise<OrderRead> {
  const read = await pendingOrder();
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

async function generation(table: 'shop_orders' | 'shop_fulfillments', id: string) {
  const res = await ctx.db.execute(
    sql`SELECT lifecycle_generation FROM ${sql.raw(table)} WHERE id = ${id}`,
  );
  return Number(res.rows[0].lifecycle_generation);
}

const raw = (statement: string) => ctx.db.execute(sql.raw(statement));

/** Everything a refused transition must NOT have written. */
async function sideEffects(orderId: string) {
  return {
    timeline: (await listTimeline(ctx.db, orderId)).length,
    emitted: (await emittedEvents(ctx.db)).length,
    intents: (await listIntents(ctx.db, orderId)).length,
  };
}

// ============================================================ the happy paths

describe('the generation moves for lifecycle changes and nothing else', () => {
  it('a new order starts at 0, and each transition bumps it exactly once', async () => {
    const read = await pendingOrder();
    expect(await generation('shop_orders', read.order.id)).toBe(0);

    await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
    expect(await generation('shop_orders', read.order.id)).toBe(1);

    await refundOrder(
      ctx.db,
      read.order.id,
      { refundedAmount: 100, refundedTotal: 100, link: null, eventId: 'evt_x' },
      NOW,
      null,
    );
    expect(await generation('shop_orders', read.order.id)).toBe(2);
  });

  it('creating a fulfilment does NOT move it, which is what keeps a refund unblocked', async () => {
    /*
     * The half of the property that keeps the pin USEFUL rather than merely safe. If
     * every write to the order moved the generation, a refund racing a fulfilment being
     * created would 409 at a human — the fix for a lost-update bug would have become a
     * spurious-conflict bug, which is precisely the trap `savePost` avoids on the blog
     * side by not touching `status`.
     */
    const read = await paidOrder();
    const before = await generation('shop_orders', read.order.id);
    await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: null, trackingNumber: null },
      ACTOR,
      NOW,
    );
    expect(await generation('shop_orders', read.order.id)).toBe(before);
    // The revision DID move: something happened to the order.
    expect((await readOrder(ctx.db, read.order.id))!.order.revision).toBe(read.order.revision + 1);
  });
});

// ================================================== A→B→A on the order machine

describe('a concurrent inverse pair cannot be re-applied — orders', () => {
  /**
   * `[name, run, setup, there, back]`. `there` and `back` are raw SET lists: the inverse
   * op somebody else performed, and the undo that returns the row to a state the
   * operation's own precondition ACCEPTS. That acceptance is the whole defect.
   */
  const cases: [
    string,
    (id: string) => Promise<unknown>,
    () => Promise<OrderRead>,
    string,
    string,
  ][] = [
    [
      'pay',
      (id) => markOrderPaid(ctx.db, id, NOW, null, null),
      pendingOrder,
      `status = 'paid', paid_at = 1`,
      `status = 'pending', paid_at = NULL`,
    ],
    [
      'cancel',
      (id) => cancelOrder(ctx.db, id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null),
      paidOrder,
      `status = 'cancelled', cancelled_at = 1`,
      `status = 'paid', cancelled_at = NULL`,
    ],
    [
      'refund',
      (id) =>
        refundOrder(
          ctx.db,
          id,
          { refundedAmount: 5400, refundedTotal: 5400, link: null, eventId: 'evt_r' },
          NOW,
          null,
        ),
      paidOrder,
      `status = 'refunded', refunded_total = 5400`,
      `status = 'paid', refunded_total = 0`,
    ],
  ];

  it.each(cases)(
    '%s that loses to an inverse pair is a 409, not a silent re-apply',
    async (_name, run, setup, there, back) => {
      const read = await setup();
      const id = read.order.id;
      const before = await readOrder(ctx.db, id);
      const effectsBefore = await sideEffects(id);

      const racing = run(id);
      await raw(`UPDATE shop_orders SET ${there}, revision = revision + 1 WHERE id = '${id}'`);
      await raw(`UPDATE shop_orders SET ${back}, revision = revision + 1 WHERE id = '${id}'`);
      const err = await rejection<StaleWriteError>(racing);

      expect(err).toBeInstanceOf(StaleWriteError);
      // A real conflict, so the two sides genuinely differ — the thing a refusal could
      // never say.
      expect(err.actual).toBeGreaterThan(err.expected);

      const after = await readOrder(ctx.db, id);
      // Exactly what the inverse pair left, and nothing the losing op wanted.
      expect(after!.order.status).toBe(before!.order.status);
      expect(after!.order.paidAt).toBe(before!.order.paidAt);
      expect(after!.order.cancelledAt).toBe(before!.order.cancelledAt);
      expect(after!.order.refundedTotal).toBe(before!.order.refundedTotal);
      expect(after!.order.revision).toBe(before!.order.revision + 2);
      // And it wrote no history, no event and no email.
      expect(await sideEffects(id)).toEqual(effectsBefore);
    },
  );

  it('the cancel case in full: the order stays paid and remains shippable', async () => {
    /*
     * The consequence, spelled out. Re-applying this cancel is not a wrong status — it is
     * a PAID ORDER THAT NEVER SHIPS, because every fulfilment path requires `paid` or
     * `partially_refunded`.
     */
    const read = await paidOrder();
    const id = read.order.id;

    const cancelling = cancelOrder(
      ctx.db,
      id,
      { reason: 'admin', actorId: ACTOR, link: null },
      NOW,
      null,
    );
    await raw(`UPDATE shop_orders SET status = 'cancelled', cancelled_at = 1, revision = revision + 1 WHERE id = '${id}'`);
    await raw(`UPDATE shop_orders SET status = 'paid', cancelled_at = NULL, revision = revision + 1 WHERE id = '${id}'`);
    await expect(cancelling).rejects.toBeInstanceOf(StaleWriteError);

    expect((await readOrder(ctx.db, id))!.order.status).toBe('paid');
    // Still shippable, which is the property the re-applied cancel would have destroyed.
    const fulfillment = await createFulfillment(
      ctx.db,
      id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 2 }], carrier: 'DHL', trackingNumber: 'T1' },
      ACTOR,
      NOW,
    );
    expect(fulfillment.status).toBe('pending');
  });

  it('THE GENERATION PIN IS LOAD-BEARING: neutralised, the cancel is re-applied', async () => {
    /*
     * The exact code the fix added, removed. The retry then finds `status = 'paid'` again,
     * cannot tell it from "nothing happened", and cancels an order somebody had
     * deliberately reinstated. The state predicate is still there and still true; it is
     * the generation, and only the generation, that carries this property.
     */
    const read = await paidOrder();
    const id = read.order.id;
    const mutant = countingMutant(ctx.db, PREDICATE.generationPin, 'true');

    const cancelling = cancelOrder(
      mutant.db,
      id,
      { reason: 'admin', actorId: ACTOR, link: null },
      NOW,
      null,
    );
    await raw(`UPDATE shop_orders SET status = 'cancelled', cancelled_at = 1, revision = revision + 1 WHERE id = '${id}'`);
    await raw(`UPDATE shop_orders SET status = 'paid', cancelled_at = NULL, revision = revision + 1 WHERE id = '${id}'`);
    await cancelling;

    // A paid order that will never ship: the defect, on demand.
    expect((await readOrder(ctx.db, id))!.order.status).toBe('cancelled');
    // And the mutant really did rewrite something — a regex that stopped matching would
    // make this test green while proving nothing.
    expect(mutant.rewritten()).toBeGreaterThan(0);
  });
});

// ================================================ mutation tests: order guards

describe('every order state guard is load-bearing', () => {
  it('pay: neutralised, an already-paid order is paid again', async () => {
    const read = await paidOrder();
    const before = await readOrder(ctx.db, read.order.id);
    expect(before!.order.status).toBe('paid');

    const mutant = countingMutant(ctx.db, PREDICATE.orderIsPending, 'true');
    const again = await markOrderPaid(mutant.db, read.order.id, NOW + 5, null, null);

    // `paid_at` overwritten and a second `paid` timeline entry: the audit trail of when
    // the money actually arrived, silently rewritten.
    expect(again.paidAt).toBe(NOW + 5);
    expect(mutant.rewritten()).toBeGreaterThan(0);
    const paidEntries = (await listTimeline(ctx.db, read.order.id)).filter(
      (entry) => entry.type === 'paid',
    );
    expect(paidEntries).toHaveLength(2);
  });

  it('pay: unmutated, the same call is REFUSED rather than lost', async () => {
    const read = await paidOrder();
    const err = await rejection<PreconditionFailedError>(
      markOrderPaid(ctx.db, read.order.id, NOW + 5, null, null),
    );
    expect(err).toBeInstanceOf(PreconditionFailedError);
    expect(err.operation).toBe('pay');
    // `PreconditionFailedError` and not `StaleWriteError`: nothing is stale, the request
    // is simply refused. The consumer maps the two differently — refused is `ignored`,
    // stale is `parked`.
    expect((await readOrder(ctx.db, read.order.id))!.order.paidAt).toBe(NOW);
  });

  it('cancel: neutralised, a cancelled order is cancelled again', async () => {
    const read = await paidOrder();
    await cancelOrder(ctx.db, read.order.id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null);

    const mutant = countingMutant(ctx.db, PREDICATE.orderIsCancellable, 'true');
    const again = await cancelOrder(
      mutant.db,
      read.order.id,
      { reason: 'admin', actorId: ACTOR, link: null },
      NOW + 5,
      null,
    );
    expect(again.cancelledAt).toBe(NOW + 5);
    expect(mutant.rewritten()).toBeGreaterThan(0);
    // A second `order.cancelled` in the outbox — every consumer releases the stock twice.
    expect((await emittedEvents(ctx.db)).filter((e) => e.type === 'order.cancelled')).toHaveLength(2);
  });

  it('cancel: unmutated, a FULFILLED order is refused rather than falsified', async () => {
    /*
     * Once goods have shipped, "cancelled" is a false record of what happened. The correct
     * action is a refund, which leaves the shipment in the history. A decision, not an
     * omission — so it gets a test.
     */
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: read.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
        carrier: 'DHL',
        trackingNumber: 'T1',
      },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);
    await settleOrderFulfilled(
      ctx.db,
      read.order.id,
      { fulfillmentId: fulfillment.id, carrier: 'DHL', trackingNumber: 'T1' },
      NOW,
    );
    expect((await readOrder(ctx.db, read.order.id))!.order.status).toBe('fulfilled');

    const err = await rejection<PreconditionFailedError>(
      cancelOrder(ctx.db, read.order.id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null),
    );
    expect(err).toBeInstanceOf(PreconditionFailedError);
    expect((await readOrder(ctx.db, read.order.id))!.order.status).toBe('fulfilled');
  });

  it('refund: neutralised, a PENDING order can be refunded', async () => {
    // Money returned against an order nobody has paid for.
    const read = await pendingOrder();
    const mutant = countingMutant(ctx.db, PREDICATE.orderIsRefundable, 'true');
    const refunded = await refundOrder(
      mutant.db,
      read.order.id,
      { refundedAmount: 5400, refundedTotal: 5400, link: null, eventId: 'evt_r' },
      NOW,
      null,
    );
    expect(refunded.status).toBe('refunded');
    expect(mutant.rewritten()).toBeGreaterThan(0);
  });

  it('refund: unmutated, a pending order is refused', async () => {
    const read = await pendingOrder();
    await expect(
      refundOrder(
        ctx.db,
        read.order.id,
        { refundedAmount: 5400, refundedTotal: 5400, link: null, eventId: 'evt_r' },
        NOW,
        null,
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await readOrder(ctx.db, read.order.id))!.order).toMatchObject({
      status: 'pending',
      refundedTotal: 0,
    });
  });
});

// ============================================ mutation tests: the settle guards

describe('paid → fulfilled: both halves of the guard are load-bearing', () => {
  async function partlyShipped(): Promise<{ read: OrderRead; fulfillmentId: string }> {
    const read = await paidOrder();
    // ONE of two lines, and only part of it.
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: 'DHL', trackingNumber: 'T1' },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);
    return { read, fulfillmentId: fulfillment.id };
  }

  it('a partly shipped order is NOT fulfilled, and that is not an error', async () => {
    const { read, fulfillmentId } = await partlyShipped();
    const settled = await settleOrderFulfilled(
      ctx.db,
      read.order.id,
      { fulfillmentId, carrier: 'DHL', trackingNumber: 'T1' },
      NOW,
    );
    // `null`, not a throw: settling is asked for by nobody and its ordinary answer is
    // "not yet". An exception here would make a partial shipment an error in a log.
    expect(settled).toBeNull();
    expect((await readOrder(ctx.db, read.order.id))!.order.status).toBe('paid');
    expect(await emittedEvents(ctx.db)).toHaveLength(1); // order.created only
  });

  it('THE COVERAGE PREDICATE IS LOAD-BEARING: neutralised, a part-shipped order is fulfilled', async () => {
    const { read, fulfillmentId } = await partlyShipped();
    const mutant = countingMutant(ctx.db, PREDICATE.nothingUnshipped, 'true');

    const settled = await settleOrderFulfilled(
      mutant.db,
      read.order.id,
      { fulfillmentId, carrier: 'DHL', trackingNumber: 'T1' },
      NOW,
    );
    expect(settled?.status).toBe('fulfilled');
    expect(mutant.rewritten()).toBeGreaterThan(0);
    // `order.fulfilled` emitted for an order with one of three items in a parcel.
    expect((await emittedEvents(ctx.db)).map((e) => e.type)).toEqual([
      'order.created',
      'order.fulfilled',
    ]);
  });

  it('fully shipped: settled once, and order.fulfilled emitted exactly once', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: read.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
        carrier: 'DHL',
        trackingNumber: 'T1',
      },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);

    const first = await settleOrderFulfilled(
      ctx.db,
      read.order.id,
      { fulfillmentId: fulfillment.id, carrier: 'DHL', trackingNumber: 'T1' },
      NOW,
    );
    expect(first?.status).toBe('fulfilled');

    // Called again — as a second shipment on a multi-parcel order would. `status = 'paid'`
    // can match only once, and the emit is in the same statement, so exactly-once needs no
    // check that the event has already been written.
    const second = await settleOrderFulfilled(
      ctx.db,
      read.order.id,
      { fulfillmentId: fulfillment.id, carrier: 'DHL', trackingNumber: 'T1' },
      NOW + 1,
    );
    expect(second).toBeNull();
    expect((await emittedEvents(ctx.db)).filter((e) => e.type === 'order.fulfilled')).toHaveLength(1);
  });

  it('THE STATUS HALF IS LOAD-BEARING: neutralised, a cancelled order is fulfilled', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: read.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
        carrier: 'DHL',
        trackingNumber: 'T1',
      },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);
    await cancelOrder(ctx.db, read.order.id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null);

    const mutant = countingMutant(ctx.db, PREDICATE.orderIsPaid, 'true');
    const settled = await settleOrderFulfilled(
      mutant.db,
      read.order.id,
      { fulfillmentId: fulfillment.id, carrier: 'DHL', trackingNumber: 'T1' },
      NOW + 1,
    );
    expect(settled?.status).toBe('fulfilled');
    expect(mutant.rewritten()).toBeGreaterThan(0);
  });

  it('unmutated, a cancelled order is left alone', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: read.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
        carrier: 'DHL',
        trackingNumber: 'T1',
      },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);
    await cancelOrder(ctx.db, read.order.id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null);

    expect(
      await settleOrderFulfilled(
        ctx.db,
        read.order.id,
        { fulfillmentId: fulfillment.id, carrier: 'DHL', trackingNumber: 'T1' },
        NOW + 1,
      ),
    ).toBeNull();
    expect((await readOrder(ctx.db, read.order.id))!.order.status).toBe('cancelled');
  });
});

// ============================================ A→B→A on the fulfilment machine

describe('a concurrent inverse pair cannot be re-applied — fulfilments', () => {
  async function pendingFulfillment(): Promise<{ order: Order; fulfillmentId: string }> {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: 'DHL', trackingNumber: 'T1' },
      ACTOR,
      NOW,
    );
    return { order: read.order, fulfillmentId: fulfillment.id };
  }

  it('ship that loses to a shipped→pending pair is a 409, not a second shipment', async () => {
    const { order, fulfillmentId } = await pendingFulfillment();
    const intentsBefore = (await listIntents(ctx.db, order.id)).length;

    const shipping = shipFulfillment(ctx.db, fulfillmentId, NOW, null, ACTOR);
    await raw(`UPDATE shop_fulfillments SET status = 'shipped', shipped_at = 1, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    await raw(`UPDATE shop_fulfillments SET status = 'pending', shipped_at = NULL, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    const err = await rejection<StaleWriteError>(shipping);

    expect(err).toBeInstanceOf(StaleWriteError);
    const after = await readFulfillment(ctx.db, fulfillmentId);
    expect(after!.fulfillment.status).toBe('pending');
    expect(after!.fulfillment.shippedAt).toBeNull();
    // No second tracking email — the thing brief §1 calls a double shipment.
    expect(await listIntents(ctx.db, order.id)).toHaveLength(intentsBefore);
  });

  it('THE FULFILMENT PIN IS LOAD-BEARING: neutralised, the ship is re-applied', async () => {
    const { order, fulfillmentId } = await pendingFulfillment();
    const mutant = countingMutant(ctx.db, PREDICATE.generationPin, 'true');

    const shipping = shipFulfillment(mutant.db, fulfillmentId, NOW, null, ACTOR);
    await raw(`UPDATE shop_fulfillments SET status = 'shipped', shipped_at = 1, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    await raw(`UPDATE shop_fulfillments SET status = 'pending', shipped_at = NULL, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    await shipping;

    expect((await readFulfillment(ctx.db, fulfillmentId))!.fulfillment.status).toBe('shipped');
    expect(mutant.rewritten()).toBeGreaterThan(0);
    // A shipment email for a parcel an operator had just marked un-shipped.
    expect((await listIntents(ctx.db, order.id)).filter((i) => i.kind === 'shipment')).toHaveLength(1);
  });

  it('cancel_fulfillment that loses to a shipped→pending pair is refused', async () => {
    const { fulfillmentId } = await pendingFulfillment();

    const cancelling = cancelFulfillment(ctx.db, fulfillmentId, NOW, ACTOR);
    await raw(`UPDATE shop_fulfillments SET status = 'shipped', shipped_at = 1, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    await raw(`UPDATE shop_fulfillments SET status = 'pending', shipped_at = NULL, revision = revision + 1 WHERE id = '${fulfillmentId}'`);
    await expect(cancelling).rejects.toBeInstanceOf(StaleWriteError);

    expect((await readFulfillment(ctx.db, fulfillmentId))!.fulfillment.status).toBe('pending');
  });
});

describe('every fulfilment state guard is load-bearing', () => {
  async function shippedFulfillment(): Promise<string> {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: 'DHL', trackingNumber: 'T1' },
      ACTOR,
      NOW,
    );
    await shipFulfillment(ctx.db, fulfillment.id, NOW, null, ACTOR);
    return fulfillment.id;
  }

  it('ship: neutralised, a shipped fulfilment ships again — a DOUBLE SHIPMENT', async () => {
    const id = await shippedFulfillment();
    const before = await readFulfillment(ctx.db, id);
    const mutant = countingMutant(ctx.db, PREDICATE.fulfillmentIsPending, 'true');

    const again = await shipFulfillment(mutant.db, id, NOW + 5, null, ACTOR);
    expect(again.shippedAt).toBe(NOW + 5);
    expect(again.shippedAt).not.toBe(before!.fulfillment.shippedAt);
    expect(mutant.rewritten()).toBeGreaterThan(0);
    // Two `shipped` entries on the customer-visible timeline.
    const timeline = await listTimeline(ctx.db, before!.fulfillment.orderId);
    expect(timeline.filter((entry) => entry.type === 'shipped')).toHaveLength(2);
  });

  it('ship: unmutated, a shipped fulfilment is refused', async () => {
    const id = await shippedFulfillment();
    const err = await rejection<PreconditionFailedError>(
      shipFulfillment(ctx.db, id, NOW + 5, null, ACTOR),
    );
    expect(err).toBeInstanceOf(PreconditionFailedError);
    expect(err.operation).toBe('ship');
  });

  it('deliver: neutralised, a PENDING fulfilment is delivered', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: null, trackingNumber: null },
      ACTOR,
      NOW,
    );
    const mutant = countingMutant(ctx.db, PREDICATE.fulfillmentIsShipped, 'true');
    const delivered = await deliverFulfillment(mutant.db, fulfillment.id, NOW, ACTOR);
    // Delivered without ever having shipped.
    expect(delivered.status).toBe('delivered');
    expect(delivered.shippedAt).toBeNull();
    expect(mutant.rewritten()).toBeGreaterThan(0);
  });

  it('deliver: unmutated, a pending fulfilment is refused', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: read.lines[0].id, qty: 1 }], carrier: null, trackingNumber: null },
      ACTOR,
      NOW,
    );
    await expect(deliverFulfillment(ctx.db, fulfillment.id, NOW, ACTOR)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('cancel_fulfillment: neutralised, a DELIVERED fulfilment is cancelled', async () => {
    const id = await shippedFulfillment();
    await deliverFulfillment(ctx.db, id, NOW, ACTOR);
    const mutant = countingMutant(ctx.db, PREDICATE.fulfillmentIsCancellable, 'true');

    const cancelled = await cancelFulfillment(mutant.db, id, NOW, ACTOR);
    expect(cancelled.status).toBe('cancelled');
    expect(mutant.rewritten()).toBeGreaterThan(0);
    // And the released quantity is back — goods a customer is holding, counted as
    // available to ship again. Contract §13 puts returns out of scope precisely so this
    // does not happen by accident.
    const read = await readOrder(ctx.db, cancelled.orderId);
    expect(read!.lines[0].fulfilledQty).toBe(0);
  });

  it('cancel_fulfillment: unmutated, a delivered fulfilment is refused', async () => {
    const id = await shippedFulfillment();
    await deliverFulfillment(ctx.db, id, NOW, ACTOR);
    await expect(cancelFulfillment(ctx.db, id, NOW, ACTOR)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });
});
