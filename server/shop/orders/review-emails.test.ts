/**
 * The two messages a REVIEW is downstream of (migration 0640): the invitation
 * sent when an order is delivered, and the note telling a reviewer their review
 * is live.
 *
 * The claims worth pinning are the ones that are easy to get subtly wrong and
 * invisible when they are: that a three-parcel order sends THREE delivery
 * notices and exactly ONE invitation, that the invitation lists the whole order
 * rather than one parcel, and that approving the same review twice does not
 * mail somebody twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents, paymentCaptured } from './test/fixtures';
import { sweepCommerceEvents } from './repo/consumer';
import { readOrderByCheckout } from './repo/orders';
import { createFulfillment, deliverFulfillment, shipFulfillment } from './repo/fulfillments';
import { listIntents } from './repo/emails';
import { queueReviewApprovedEmail } from './review-mail';

let ctx: RawCtx;
const NOW = T0 + 10_000;
const ORIGIN = 'https://shop.test';
const ACTOR = 'usr_owner';
const LINK = { origin: ORIGIN, token: 'tok' };

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

async function paidOrder() {
  await insertEvents(ctx.db, [checkoutCompleted(), paymentCaptured()]);
  await sweepCommerceEvents(ctx.db, { origin: ORIGIN }, NOW);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

/** Ship then deliver one parcel covering `qty` of the line at `index`. */
async function deliverParcel(orderId: string, lineId: string, qty: number): Promise<void> {
  const fulfillment = await createFulfillment(
    ctx.db,
    orderId,
    { lines: [{ orderLineId: lineId, qty }], carrier: 'DHL', trackingNumber: 'T1' },
    ACTOR,
    NOW,
  );
  await shipFulfillment(ctx.db, fulfillment.id, NOW, LINK, ACTOR);
  await deliverFulfillment(ctx.db, fulfillment.id, NOW, ACTOR, LINK);
}

const kinds = async (orderId: string, kind: string) =>
  (await listIntents(ctx.db, orderId)).filter((intent) => intent.kind === kind);

describe('the review invitation', () => {
  it('is written by the SAME statement as the delivery, alongside the notice', async () => {
    const read = await paidOrder();
    await deliverParcel(read.order.id, read.lines[0]!.id, 1);

    /* No sweeper has run. The intent exists because the transition wrote it,
       which is the property this whole outbox exists to have. */
    expect(await kinds(read.order.id, 'delivered')).toHaveLength(1);
    expect(await kinds(read.order.id, 'review_invite')).toHaveLength(1);
  });

  it('is ONE PER ORDER while the delivery notice is one per PARCEL', async () => {
    const read = await paidOrder();
    /* Three parcels: two halves of the first line, then the second line. */
    await deliverParcel(read.order.id, read.lines[0]!.id, 1);
    await deliverParcel(read.order.id, read.lines[0]!.id, 1);
    await deliverParcel(read.order.id, read.lines[1]!.id, 1);

    /*
     * Three notices, because each is about a different box and a customer with
     * three parcels wants to know about all three. ONE invitation, because a
     * shop that asks three times for one order is a shop people filter — and it
     * is the dedupe key that enforces it, not a condition somebody could
     * forget: the second and third deliveries write nothing.
     */
    expect(await kinds(read.order.id, 'delivered')).toHaveLength(3);
    expect(await kinds(read.order.id, 'review_invite')).toHaveLength(1);
  });

  it('lists the WHOLE order, not just the parcel that happened to arrive first', async () => {
    const read = await paidOrder();
    await deliverParcel(read.order.id, read.lines[0]!.id, 1);

    const [invite] = await kinds(read.order.id, 'review_invite');
    const [notice] = await kinds(read.order.id, 'delivered');

    /* The notice names one line, because it is about one box. The invitation
       names both, because it is about the order and asks the reader to go and
       look at what they bought. */
    for (const line of read.lines) {
      expect(invite!.body).toContain(line.title);
    }
    expect(notice!.body).toContain(read.lines[0]!.title);
    expect(notice!.body).not.toContain(read.lines[1]!.title);
  });
});

describe('the review-approved message', () => {
  it('writes one intent, and a second call writes nothing', async () => {
    const read = await paidOrder();

    const first = await queueReviewApprovedEmail(
      ctx.db,
      { reviewId: 'rev_abc', orderId: read.order.id, to: 'reviewer@example.com' },
      NOW,
    );
    expect(first).toBe(true);

    /*
     * A review un-approved and approved again is not news to the person who
     * wrote it. The route also guards on the EDGE into `approved`; this is the
     * second of two independent guards, so the one that is wrong still cannot
     * send a duplicate.
     */
    const second = await queueReviewApprovedEmail(
      ctx.db,
      { reviewId: 'rev_abc', orderId: read.order.id, to: 'reviewer@example.com' },
      NOW + 1,
    );
    expect(second).toBe(false);
    expect(await kinds(read.order.id, 'review_approved')).toHaveLength(1);
  });

  it("goes to the REVIEW's address, which need not be the order's", async () => {
    const read = await paidOrder();
    await queueReviewApprovedEmail(
      ctx.db,
      { reviewId: 'rev_other', orderId: read.order.id, to: 'signed-up-later@example.com' },
      NOW,
    );

    /* A shopper who checked out as a guest under one address and signed up
       under another has an order carrying the first and a review carrying the
       second. The review is what this message is about. */
    const [intent] = await kinds(read.order.id, 'review_approved');
    expect(intent!.to).toBe('signed-up-later@example.com');
    expect(intent!.to).not.toBe(read.order.email);
  });

  it('answers false rather than throwing when the order has gone', async () => {
    /* Not a failure worth failing a moderator's approval over. */
    const sent = await queueReviewApprovedEmail(
      ctx.db,
      { reviewId: 'rev_orphan', orderId: 'ord_does_not_exist', to: 'nobody@example.com' },
      NOW,
    );
    expect(sent).toBe(false);
  });

  it('is a kind the intents table actually accepts', async () => {
    /*
     * Migration 0640 widened `shop_order_email_intents_kind_ck`, and a CHECK
     * that was never widened would fail as a raw 23514 at the moment a
     * moderator approved something — long after the code that needs it merged.
     * Asserted against the CONSTRAINT rather than against behaviour, because
     * the behaviour above would pass on a database whose migration never ran.
     */
    const res = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conname = 'shop_order_email_intents_kind_ck'`);
    const def = String(res.rows[0]!.def);
    expect(def).toContain('review_invite');
    expect(def).toContain('review_approved');
  });
});
