/**
 * Courier writes on a parcel (migration 0960's columns on shop_fulfillments).
 *
 * Every test drives the REAL statements against PGlite, because what these
 * functions are FOR is the guard inside the SQL: booking is refused by the
 * WHERE clause and not by a JS pre-check, and a replayed snapshot writes no
 * timeline row because the CTE reads the previous status. Neither property is
 * observable from the TypeScript.
 *
 * The first case books nothing at all and asserts the STORED DEFAULTS —
 * CLAUDE.md §2's rule, learned from a fixture that never once held the value
 * the application actually writes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../../../test/harness';
import { TEST_ORIGIN } from '../../../test/http';
import { resetOrderTables } from '../test/harness';
import { CHECKOUT, CUSTOMER_A, T0, checkoutCompleted, insertEvents } from '../test/fixtures';
import { sweepCommerceEvents } from './consumer';
import { markOrderPaid, readOrder, readOrderByCheckout, listTimeline, type OrderRead } from './orders';
import { createFulfillment, readFulfillment } from './fulfillments';
import {
  CourierConflictError, listCourierParcelsToSync, readFulfillmentByProviderRef, recordCourierBooking,
  recordCourierCancelled, recordCourierDraft, recordCourierSnapshot, recordCourierSyncError,
} from './courier';

let ctx: TestCtx;
const NOW = T0 + 10_000;
beforeAll(async () => { ctx = await freshDb(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await resetOrderTables(ctx.db); });

async function parcel(): Promise<{ order: OrderRead; id: string }> {
  await insertEvents(ctx.db, [{ ...checkoutCompleted({ customerId: CUSTOMER_A }), id: 'evt_chk_courier' }]);
  await sweepCommerceEvents(ctx.db, { origin: TEST_ORIGIN }, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  const order = (await readOrder(ctx.db, read.order.id))!;
  const f = await createFulfillment(ctx.db, order.order.id, { lines: [{ orderLineId: order.lines[0]!.id, qty: 1 }], carrier: null, trackingNumber: null }, 'u_admin', NOW);
  return { order, id: f.id };
}

const booking = {
  provider: 'fez' as const, providerRef: 'ASAC1', carrier: 'Fez Delivery', trackingNumber: 'ASAC1', trackingUrl: null,
  labelUrl: 'https://fez.test/m.pdf', costMinor: 645000, rawStatus: 'Pending Pick-Up', state: 'booked' as const,
  now: NOW + 1, actorId: 'u_admin', message: 'Booked with Fez Delivery · ₦6,450.00 · ASAC1',
};

describe('courier writes', () => {
  it('a fresh parcel carries no courier at all (the stored default)', async () => {
    const { id } = await parcel();
    const f = (await readFulfillment(ctx.db, id))!.fulfillment;
    expect(f).toMatchObject({ provider: null, providerRef: null, providerStatus: null, courierState: null, trackingUrl: null, labelUrl: null, providerCostMinor: null, providerSyncedAt: null, providerLastError: null });
  });

  it('books once: writes every column, appends courier_booked, refuses a second booking', async () => {
    const { order, id } = await parcel();
    const f = await recordCourierBooking(ctx.db, id, booking);
    expect(f).toMatchObject({ provider: 'fez', providerRef: 'ASAC1', carrier: 'Fez Delivery', trackingNumber: 'ASAC1', labelUrl: 'https://fez.test/m.pdf', providerCostMinor: 645000, providerStatus: 'Pending Pick-Up', courierState: 'booked', providerSyncedAt: NOW + 1, status: 'pending' });
    const timeline = await listTimeline(ctx.db, order.order.id);
    expect(timeline.at(-1)).toMatchObject({ type: 'courier_booked', message: booking.message, actorId: 'u_admin' });
    await expect(recordCourierBooking(ctx.db, id, booking)).rejects.toBeInstanceOf(CourierConflictError);
    expect(await readFulfillmentByProviderRef(ctx.db, 'fez', 'ASAC1')).toMatchObject({ id });
    expect(await readFulfillmentByProviderRef(ctx.db, 'terminal', 'ASAC1')).toBeNull();
  });

  it('a draft can be re-drafted and then booked; a booked parcel cannot be re-drafted', async () => {
    const { id } = await parcel();
    await recordCourierDraft(ctx.db, id, { provider: 'terminal', providerRef: 'SH-1', now: NOW });
    const again = await recordCourierDraft(ctx.db, id, { provider: 'terminal', providerRef: 'SH-2', now: NOW + 1 });
    expect(again).toMatchObject({ provider: 'terminal', providerRef: 'SH-2', courierState: 'draft' });
    await recordCourierBooking(ctx.db, id, { ...booking, provider: 'terminal', providerRef: 'SH-2', carrier: 'GIG Logistics', trackingNumber: 'GIG1' });
    await expect(recordCourierDraft(ctx.db, id, { provider: 'terminal', providerRef: 'SH-3', now: NOW + 2 })).rejects.toBeInstanceOf(CourierConflictError);
  });

  it('a snapshot changes the raw status once, fills links only when learned, and is a no-op on replay', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, booking);
    const first = await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', trackingUrl: 'https://t.test/1', now: NOW + 5, message: 'Fez Delivery: Dispatched — on its way' });
    expect(first.changed).toBe(true);
    expect(first.fulfillment).toMatchObject({ providerStatus: 'Dispatched', courierState: 'in_transit', trackingUrl: 'https://t.test/1', providerSyncedAt: NOW + 5, providerLastError: null });
    const replay = await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', trackingUrl: null, now: NOW + 6, message: 'Fez Delivery: Dispatched — on its way' });
    expect(replay.changed).toBe(false);
    expect(replay.fulfillment.trackingUrl).toBe('https://t.test/1'); // a null never erases a known link
    expect(replay.fulfillment.providerSyncedAt).toBe(NOW + 6);
    const updates = (await listTimeline(ctx.db, order.order.id)).filter((e) => e.type === 'courier_update');
    expect(updates).toHaveLength(1);
  });

  it('cancelling the courier keeps the parcel pending and lets it be booked again', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, booking);
    const f = await recordCourierCancelled(ctx.db, id, { now: NOW + 2, actorId: 'u_admin', message: 'Courier cancelled: changed our mind' });
    expect(f).toMatchObject({ status: 'pending', courierState: 'cancelled', providerStatus: 'Cancelled' });
    expect((await listTimeline(ctx.db, order.order.id)).at(-1)).toMatchObject({ type: 'courier_cancelled' });
    await expect(recordCourierBooking(ctx.db, id, { ...booking, providerRef: 'ASAC2', trackingNumber: 'ASAC2' })).resolves.toMatchObject({ providerRef: 'ASAC2', courierState: 'booked' });
  });

  it('lists parcels that still need syncing, oldest sync first, and records a sync error', async () => {
    const { id } = await parcel();
    expect(await listCourierParcelsToSync(ctx.db, 10)).toEqual([]);
    await recordCourierBooking(ctx.db, id, booking);
    const due = await listCourierParcelsToSync(ctx.db, 10);
    expect(due.map((f) => f.id)).toEqual([id]);
    await recordCourierSyncError(ctx.db, id, { now: NOW + 9, message: 'Fez didn’t answer' });
    expect((await readFulfillment(ctx.db, id))!.fulfillment).toMatchObject({ providerLastError: 'Fez didn’t answer', providerSyncedAt: NOW + 9 });
    await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Delivered', state: 'delivered', now: NOW + 10, message: 'Delivered' });
    expect(await listCourierParcelsToSync(ctx.db, 10)).toEqual([]);
    await ctx.db.execute(sql`SELECT 1`); // keeps the handle warm for afterAll
  });
});
