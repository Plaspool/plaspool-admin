/**
 * SPOOLPOINTS, SPENT AND GIVEN BACK (admin#2).
 *
 * WHAT THIS FILE IS FOR, AND WHY IT IS NOT MERELY "REDEEM WORKS".
 *
 * Spec D9 says a quote DOES NOT RESERVE: the discount is decided at the freeze
 * and the debit happens at the capture, and a balance can fall in between. That
 * gap is not a bug to be closed here — it was decided deliberately — so the
 * point of this file is to PIN THE DECISION, because a decision that only exists
 * in a comment is one the next change silently reverses.
 *
 * The decision: **the customer is charged the total they agreed to, always.** A
 * balance that has fallen produces a paid order plus a recorded anomaly, never a
 * failed checkout and never a second charge.
 *
 * THE PORT IS A FAKE HERE, ON PURPOSE. `server/marketing/redemption/port.test.ts`
 * already proves the real implementation against marketing's own tables — its
 * partial unique index, its `CHECK (balance >= 0)`, its guarded debit. What is
 * unproven until this file is what ORDERS does with each answer, and a fake is
 * the only way to produce `insufficient_balance` on demand rather than by racing
 * a real balance and hoping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import {
  CHECKOUT,
  T0,
  checkoutCompleted,
  consumptionOf,
  insertEvents,
  paymentCaptured,
  paymentFailed,
  paymentRefunded,
} from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { readOrderByCheckout } from './repo/orders';
import type {
  PointsRedemptionPort,
  RedeemResult,
} from '../../../shared/marketing/redemption';

let ctx: RawCtx;

const NOW = T0 + 10_000;
const WALLET = 'buyer@example.test';
const POINTS = 250;

/** Every call the shop made, in order, so a test can assert on the arguments and
 *  not merely on the outcome. */
interface Recorder {
  redeems: Array<{
    orderId: string;
    orderNumber: string;
    email: string;
    points: number;
    currency: string;
  }>;
  releases: Array<{ orderId: string; orderNumber: string; reason: string }>;
}

/**
 * A `PointsRedemptionPort` that answers whatever the test needs.
 *
 * `quote` THROWS. Orders never quotes — the freeze does, in Cart — and a fake
 * that answered would let a test pass against a call that should not exist.
 */
function fakePort(
  answer: RedeemResult | (() => RedeemResult | Promise<RedeemResult>),
  rec: Recorder,
): PointsRedemptionPort {
  return {
    quote() {
      throw new Error('Orders must never quote; the freeze does');
    },
    async redeem(input) {
      rec.redeems.push(input);
      return typeof answer === 'function' ? await answer() : answer;
    },
    async release(input) {
      rec.releases.push(input);
      return { ok: true, entryId: 'entry_release', balance: 0 };
    },
  };
}

function recorder(): Recorder {
  return { redeems: [], releases: [] };
}

function depsWith(port: PointsRedemptionPort): ConsumerDeps {
  return { origin: null, redemption: () => port };
}

/** A checkout that spent points, and its capture. */
const REDEEMED = checkoutCompleted({ redemption: { email: WALLET, points: POINTS } });

/** Drain to a fixed point: the capture parks behind the checkout on the first
 *  pass, exactly as it does in production. */
async function drain(deps: ConsumerDeps): Promise<void> {
  await sweepCommerceEvents(ctx.db, deps, NOW, 50);
  await sweepCommerceEvents(ctx.db, deps, NOW, 50);
}

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

describe('the point count survives the trip from the freeze to the capture', () => {
  it('is stored on the order and spent with the order id, not the checkout id', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read).not.toBeNull();
    expect(rec.redeems).toEqual([
      {
        orderId: read!.order.id,
        /* BOTH IDENTIFIERS REACH THE PORT, and this is the assertion that says
         * the customer's one does: the ledger writes `orderNumber` into a
         * sentence a shopper reads back, and it is not recoverable on the far
         * side — marketing may not read `shop_orders`. */
        orderNumber: read!.order.orderNumber,
        email: WALLET,
        points: POINTS,
        currency: read!.order.currency,
      },
    ]);
  });

  it('spends nothing at checkout.completed — only at the capture', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED]);
    await sweepCommerceEvents(ctx.db, depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)), NOW, 50);

    // The order exists and is pending; no money has arrived, so no points are spent.
    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read!.order.status).toBe('pending');
    expect(rec.redeems).toEqual([]);
  });

  it('spends nothing for an ordinary order that carried no points', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));

    expect(rec.redeems).toEqual([]);
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))!.order.status).toBe('paid');
  });

  it('accepts a checkout.completed with no redemption field at all', async () => {
    // Every event written before admin#2 is still in the outbox. A schema that
    // parked them would be a paid customer with no order, twenty times over —
    // the mistake `billingAddress` already records.
    const rec = recorder();
    const legacy = checkoutCompleted();
    delete (legacy.payload as Record<string, unknown>).redemption;
    await insertEvents(ctx.db, [legacy, paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));

    expect((await readOrderByCheckout(ctx.db, CHECKOUT))!.order.status).toBe('paid');
  });
});

describe('THE D9 DECISION — a balance that fell between the freeze and the capture', () => {
  /**
   * The whole reason this file exists. `insufficient_balance` is not a checkout
   * failure: the customer agreed to a total, paid it, and must get their order.
   */
  it('still pays the order, and records the shortfall as an anomaly', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: false, code: 'insufficient_balance' }, rec)));

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read!.order.status).toBe('paid');
    expect(read!.order.paidAt).not.toBeNull();

    const consumption = await consumptionOf(ctx.db, paymentCaptured().id);
    expect(consumption!.outcome).toBe('applied');
    // The fixed prefix is the contract: one `LIKE` has to find every one of these.
    expect(consumption!.detail).toContain('anomaly:');
    expect(consumption!.detail).toContain('insufficient_balance');
  });

  it('does not move what the customer is charged', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);

    const funded = await (async () => {
      await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));
      const read = await readOrderByCheckout(ctx.db, CHECKOUT);
      return read!.order.grandTotal;
    })();

    await resetOrderTables(ctx.db);
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: false, code: 'insufficient_balance' }, recorder())));
    const unfunded = (await readOrderByCheckout(ctx.db, CHECKOUT))!.order.grandTotal;

    // The frozen total is the frozen total. Whether the ledger could fund the
    // discount changes the SHOP's books, never the customer's charge.
    expect(unfunded).toBe(funded);
  });

  it('treats redemption_disabled the same way — paid, and written down', async () => {
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain(depsWith(fakePort({ ok: false, code: 'redemption_disabled' }, recorder())));

    expect((await readOrderByCheckout(ctx.db, CHECKOUT))!.order.status).toBe('paid');
    expect((await consumptionOf(ctx.db, paymentCaptured().id))!.detail).toContain('anomaly:');
  });

  it('a THROWING port still pays the order rather than parking it', async () => {
    /*
     * The failure mode this guards is the expensive one. `spendPoints` runs
     * AFTER `markOrderPaid`, so a throw that escaped would park an event whose
     * state change has already been applied — and the next sweep would replay
     * it forever. A missing debit is recoverable by hand; a stuck paid order is
     * not recoverable by the customer at all.
     */
    const rec = recorder();
    const exploding = fakePort(() => {
      throw new Error('marketing is down');
    }, rec);

    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain(depsWith(exploding));

    const consumption = await consumptionOf(ctx.db, paymentCaptured().id);
    expect((await readOrderByCheckout(ctx.db, CHECKOUT))!.order.status).toBe('paid');
    expect(consumption!.outcome).toBe('applied');
    expect(consumption!.detail).toContain('anomaly:');
  });

  it('an unwired port pays the order and spends nothing', async () => {
    // A deployment that has not wired marketing is a deployment, not an outage.
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured()]);
    await drain({ origin: null });

    expect((await readOrderByCheckout(ctx.db, CHECKOUT))!.order.status).toBe('paid');
    expect((await consumptionOf(ctx.db, paymentCaptured().id))!.detail).toBeNull();
  });
});

describe('giving the points back', () => {
  it('releases on a failed payment', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED, paymentFailed()]);
    await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));

    const read = await readOrderByCheckout(ctx.db, CHECKOUT);
    expect(read!.order.status).toBe('cancelled');
    expect(rec.releases).toEqual([
      { orderId: read!.order.id, orderNumber: read!.order.orderNumber, reason: 'payment_failed' },
    ]);
  });

  it('releases on a refund', async () => {
    const rec = recorder();
    await insertEvents(ctx.db, [REDEEMED, paymentCaptured(), paymentRefunded()]);
    await sweepCommerceEvents(ctx.db, depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)), NOW, 50);
    await sweepCommerceEvents(ctx.db, depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)), NOW, 50);
    await sweepCommerceEvents(ctx.db, depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)), NOW, 50);

    expect(rec.releases.map((r) => r.reason)).toContain('payment_refunded');
  });

  it('calls release even for an order that never spent a point', async () => {
    /*
     * `release()` answers `entryId: null` for "nothing to release" and documents
     * that as a SUCCESS, precisely so no caller has to check first. Asserting the
     * unconditional call is asserting that we took the port at its word — a
     * caller that pre-checked would be a second place for the rule to be wrong.
     */
    const rec = recorder();
    await insertEvents(ctx.db, [checkoutCompleted(), paymentFailed()]);
    await drain(depsWith(fakePort({ ok: true, entryId: 'e1', balance: 0 }, rec)));

    expect(rec.releases).toHaveLength(1);
  });
});
