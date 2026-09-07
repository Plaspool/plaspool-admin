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
import { NotFoundError } from '../../../repo/errors';
import { resetOrderTables } from '../test/harness';
import { CHECKOUT, CUSTOMER_A, T0, checkoutCompleted, insertEvents } from '../test/fixtures';
import { sweepCommerceEvents } from './consumer';
import { markOrderPaid, readOrder, readOrderByCheckout, listTimeline, type OrderRead } from './orders';
import { createFulfillment, readFulfillment, shipFulfillment } from './fulfillments';
import { listIntents } from './emails';
import {
  CourierConflictError, listCourierParcelsToSync, readFulfillmentByProviderRef, recordCourierBooking,
  recordCourierCancelled, recordCourierDraft, recordCourierSnapshot, recordCourierSyncError,
} from './courier';

let ctx: TestCtx;
const NOW = T0 + 10_000;
beforeAll(async () => { ctx = await freshDb(); });
afterAll(async () => { await ctx.close(); });
beforeEach(async () => { await resetOrderTables(ctx.db); });

async function paidOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [{ ...checkoutCompleted({ customerId: CUSTOMER_A }), id: 'evt_chk_courier' }]);
  await sweepCommerceEvents(ctx.db, { origin: TEST_ORIGIN }, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/**
 * One more parcel on an order that already has some. The checkout fixture's
 * first line is qty 2 and its second is qty 1, so ONE paid order carries three
 * parcels of qty 1 — which is what lets the ordering and uniqueness cases below
 * compare parcels without seeding a second checkout.
 */
async function extraParcel(order: OrderRead, lineIndex: number): Promise<string> {
  const f = await createFulfillment(ctx.db, order.order.id, { lines: [{ orderLineId: order.lines[lineIndex]!.id, qty: 1 }], carrier: null, trackingNumber: null }, 'u_admin', NOW);
  return f.id;
}

async function parcel(): Promise<{ order: OrderRead; id: string }> {
  const order = await paidOrder();
  return { order, id: await extraParcel(order, 0) };
}

/** Whatever a rejected promise settled with, so a class AND its fields can both be asserted. */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

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
    const again = await rejection(recordCourierBooking(ctx.db, id, booking));
    expect(again).toBeInstanceOf(CourierConflictError);
    // The DEFAULT reason: this parcel is spoken for, not that its reference is.
    expect(again).toMatchObject({ code: 'already_booked', reason: 'already_booked' });
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

  /**
   * The (provider, provider_ref) unique index is a CONFLICT, not a 500.
   *
   * Two parcels reaching for the same waybill is an ordinary consequence of a
   * retried booking that the courier answered twice, and the raw 23505 has no
   * row in `server/middleware/errors.ts` — it would answer `{"error":"internal"}`
   * and be retried five times for a request whose answer can never change.
   */
  it('a reference another parcel already holds is a conflict, and says which kind', async () => {
    const order = await paidOrder();
    const mine = await extraParcel(order, 0);
    const theirs = await extraParcel(order, 1);
    await recordCourierBooking(ctx.db, mine, booking);

    const clash = await rejection(recordCourierBooking(ctx.db, theirs, booking));
    expect(clash).toBeInstanceOf(CourierConflictError);
    expect(clash).toMatchObject({ code: 'already_booked', reason: 'ref_in_use' });

    const drafted = await rejection(recordCourierDraft(ctx.db, theirs, { provider: 'fez', providerRef: 'ASAC1', now: NOW }));
    expect(drafted).toBeInstanceOf(CourierConflictError);
    expect(drafted).toMatchObject({ reason: 'ref_in_use' });

    // Nothing landed on the second parcel, and the first still owns the reference.
    expect((await readFulfillment(ctx.db, theirs))!.fulfillment).toMatchObject({ provider: null, providerRef: null, courierState: null });
    expect(await readFulfillmentByProviderRef(ctx.db, 'fez', 'ASAC1')).toMatchObject({ id: mine });
  });

  it('every courier write on a parcel that does not exist is a 404, not a conflict', async () => {
    const missing = 'ful_no_such_parcel';
    await expect(recordCourierDraft(ctx.db, missing, { provider: 'fez', providerRef: 'X-1', now: NOW })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordCourierBooking(ctx.db, missing, { ...booking, providerRef: 'X-2', trackingNumber: 'X-2' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordCourierSnapshot(ctx.db, missing, { rawStatus: 'Dispatched', state: 'in_transit', now: NOW, message: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordCourierCancelled(ctx.db, missing, { now: NOW, actorId: null, message: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a snapshot for a parcel that has no courier on it is a 404', async () => {
    const { id } = await parcel();
    await expect(recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', now: NOW, message: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a snapshot changes the raw status once, fills links only when learned, and is a no-op on replay', async () => {
    const { order, id } = await parcel();
    const booked = await recordCourierBooking(ctx.db, id, booking);
    const first = await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', trackingUrl: 'https://t.test/1', now: NOW + 5, message: 'Fez Delivery: Dispatched — on its way' });
    expect(first.changed).toBe(true);
    expect(first.fulfillment).toMatchObject({ providerStatus: 'Dispatched', courierState: 'in_transit', trackingUrl: 'https://t.test/1', providerSyncedAt: NOW + 5, providerLastError: null });
    expect(first.fulfillment.revision).toBe(booked.revision + 1);
    const replay = await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', trackingUrl: null, now: NOW + 6, message: 'Fez Delivery: Dispatched — on its way' });
    expect(replay.changed).toBe(false);
    expect(replay.fulfillment.trackingUrl).toBe('https://t.test/1'); // a null never erases a known link
    expect(replay.fulfillment.providerSyncedAt).toBe(NOW + 6);
    /* A replay is NOT a write anyone can lose a CAS to. The poll runs every few
     * minutes and says the same thing each time; bumping the revision would
     * invalidate an admin's open ship dialog for no change at all. */
    expect(replay.fulfillment.revision).toBe(first.fulfillment.revision);
    const updates = (await listTimeline(ctx.db, order.order.id)).filter((e) => e.type === 'courier_update');
    expect(updates).toHaveLength(1);
  });

  /**
   * The other half of "a replay is a no-op": it is a no-op about the TIMELINE
   * and the REVISION, not about the row. A courier that only produces the
   * waybill on its third poll is ordinary, and a snapshot that refused to learn
   * it because the status word had not moved would leave the parcel without the
   * label an operator prints.
   *
   * This is the case that walks the second of the two UPDATEs end to end — its
   * SET list carries everything except the status and the revision.
   */
  it('a replay that finally carries the label learns it, with no timeline row and no revision bump', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, { ...booking, labelUrl: null });
    const first = await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Dispatched', state: 'in_transit', now: NOW + 5, message: 'Fez Delivery: Dispatched' });
    expect(first.changed).toBe(true);

    const late = await recordCourierSnapshot(ctx.db, id, {
      rawStatus: 'Dispatched', state: 'in_transit', labelUrl: 'https://fez.test/label.pdf',
      carrier: 'GIG Logistics', trackingNumber: 'GIG-9', now: NOW + 6, message: 'Fez Delivery: Dispatched',
    });
    expect(late.changed).toBe(false);
    expect(late.fulfillment).toMatchObject({
      labelUrl: 'https://fez.test/label.pdf', carrier: 'GIG Logistics', trackingNumber: 'GIG-9',
      providerStatus: 'Dispatched', courierState: 'in_transit', providerSyncedAt: NOW + 6, providerLastError: null,
    });
    expect(late.fulfillment.revision).toBe(first.fulfillment.revision);
    expect((await listTimeline(ctx.db, order.order.id)).filter((e) => e.type === 'courier_update')).toHaveLength(1);
  });

  it('cancelling the courier voids its tracking, keeps the parcel pending, and lets it be booked again', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, { ...booking, trackingUrl: 'https://t.test/1' });
    const f = await recordCourierCancelled(ctx.db, id, { now: NOW + 2, actorId: 'u_admin', message: 'Courier cancelled: changed our mind' });
    // `provider_status` is the COURIER'S last raw word, and an admin cancel is
    // not that — it goes to NULL, not to a made-up 'Cancelled' of our own.
    expect(f).toMatchObject({ status: 'pending', courierState: 'cancelled', providerStatus: null });
    /* EVERY WAY A CUSTOMER COULD BE POINTED AT A COURIER THAT IS NOT COMING is
     * cleared, because the next thing an operator does is ship the parcel by
     * hand — and the shipment email reads carrier, tracking number and tracking
     * link straight off this row. */
    expect(f).toMatchObject({ carrier: null, trackingNumber: null, trackingUrl: null, labelUrl: null });
    // The reference stays: a webhook arriving late still has to find this parcel.
    expect(f).toMatchObject({ provider: 'fez', providerRef: 'ASAC1' });
    expect((await listTimeline(ctx.db, order.order.id)).at(-1)).toMatchObject({ type: 'courier_cancelled' });
    await expect(recordCourierBooking(ctx.db, id, { ...booking, providerRef: 'ASAC2', trackingNumber: 'ASAC2' })).resolves.toMatchObject({ providerRef: 'ASAC2', courierState: 'booked' });
  });

  /**
   * `provider_status` HOLDS THE COURIER'S OWN WORD, NEVER OURS — and this is
   * why. Had the admin cancel written its own `'Cancelled'` into that column,
   * a courier that genuinely goes on to send `Cancelled` for the same parcel
   * would read as the status we already have: `recordCourierSnapshot`'s
   * `changed` CTE compares by `IS DISTINCT FROM`, so the real webhook would
   * match the `same` branch, skip the timeline row, and leave nobody able to
   * tell "we called this off" apart from "the courier called this off" on the
   * parcel's own history. NULL can never equal a courier's raw string, so the
   * genuine webhook always lands.
   */
  it('a courier Cancelled webhook after an admin cancel still changes the row and reaches the timeline', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, booking);
    await recordCourierCancelled(ctx.db, id, { now: NOW + 2, actorId: 'u_admin', message: 'Courier cancelled: changed our mind' });

    const snapshot = await recordCourierSnapshot(ctx.db, id, {
      rawStatus: 'Cancelled',
      state: 'cancelled',
      now: NOW + 3,
      message: 'Fez Delivery: Cancelled',
    });
    expect(snapshot.changed).toBe(true);
    expect(snapshot.fulfillment.providerStatus).toBe('Cancelled');
    expect((await listTimeline(ctx.db, order.order.id)).filter((e) => e.type === 'courier_update')).toHaveLength(1);
  });

  /**
   * THE CASE THAT ACTUALLY MATTERS: cancelling does not just leave a tidy row,
   * it changes what the customer is told. Book with Fez, the courier falls
   * through, cancel it, ship the parcel by hand — the shipment email queued by
   * that ship must not read like Fez is still coming.
   */
  it('booking, then cancelling, then shipping by hand mails no dead courier link or number', async () => {
    const { order, id } = await parcel();
    await recordCourierBooking(ctx.db, id, { ...booking, trackingUrl: 'https://t.test/1' });
    await recordCourierCancelled(ctx.db, id, { now: NOW + 2, actorId: 'u_admin', message: 'Courier cancelled: changed our mind' });
    await shipFulfillment(ctx.db, id, NOW + 3, null, 'u_admin');

    const shipment = (await listIntents(ctx.db, order.order.id)).find((i) => i.kind === 'shipment');
    expect(shipment).toBeDefined();
    // No tracking PAGE (the panel's third row) and no trace of the cancelled ASAC1 booking at all.
    expect(shipment!.body).not.toContain('Track:');
    expect(shipment!.body).not.toContain('ASAC1');
    expect(shipment!.body).not.toContain('Fez Delivery');
  });

  it('refuses to cancel a courier on a parcel that has none, or that has already shipped', async () => {
    const { id } = await parcel();
    // Nothing booked: there is no courier to call off.
    await expect(recordCourierCancelled(ctx.db, id, { now: NOW + 1, actorId: null, message: 'x' })).rejects.toBeInstanceOf(CourierConflictError);

    await recordCourierBooking(ctx.db, id, booking);
    await shipFulfillment(ctx.db, id, NOW + 2, null, 'u_admin');
    await expect(recordCourierCancelled(ctx.db, id, { now: NOW + 3, actorId: null, message: 'x' })).rejects.toBeInstanceOf(CourierConflictError);
    /* The shipment email has gone out quoting this number. Blanking it here
     * would make the row disagree with what the customer was told. */
    expect((await readFulfillment(ctx.db, id))!.fulfillment).toMatchObject({ status: 'shipped', courierState: 'booked', carrier: 'Fez Delivery', trackingNumber: 'ASAC1' });
  });

  it('lists parcels that still need syncing, and records a sync error', async () => {
    const { id } = await parcel();
    expect(await listCourierParcelsToSync(ctx.db, 10)).toEqual([]);
    const booked = await recordCourierBooking(ctx.db, id, booking);
    const due = await listCourierParcelsToSync(ctx.db, 10);
    expect(due.map((f) => f.id)).toEqual([id]);
    await recordCourierSyncError(ctx.db, id, { now: NOW + 9, message: 'Fez didn’t answer' });
    const failed = (await readFulfillment(ctx.db, id))!.fulfillment;
    expect(failed).toMatchObject({ providerLastError: 'Fez didn’t answer', providerSyncedAt: NOW + 9 });
    // A courier write moves the revision — the file header's rule, and the sync
    // error is one: the parcel now shows a warning it did not show before.
    expect(failed.revision).toBe(booked.revision + 1);
    await recordCourierSnapshot(ctx.db, id, { rawStatus: 'Delivered', state: 'delivered', now: NOW + 10, message: 'Delivered' });
    expect(await listCourierParcelsToSync(ctx.db, 10)).toEqual([]);
  });

  /**
   * THE ORDER AND THE LIMIT ARE THE WHOLE CONTRACT of this query: the sweep
   * takes a slice per pass, so a parcel that sorts last is a parcel that never
   * gets polled. Asserted with three parcels rather than read off the SQL.
   */
  it('sorts the sync queue never-synced first, then oldest sync first, and honours the limit', async () => {
    const order = await paidOrder();
    const never = await extraParcel(order, 0);
    const older = await extraParcel(order, 0);
    const newer = await extraParcel(order, 1);
    await recordCourierBooking(ctx.db, never, { ...booking, providerRef: 'REF-NEVER', trackingNumber: 'REF-NEVER', now: NOW + 1 });
    await recordCourierBooking(ctx.db, older, { ...booking, providerRef: 'REF-OLD', trackingNumber: 'REF-OLD', now: NOW + 100 });
    await recordCourierBooking(ctx.db, newer, { ...booking, providerRef: 'REF-NEW', trackingNumber: 'REF-NEW', now: NOW + 200 });
    /* Only a raw statement can produce a booked parcel that has never been
     * synced — every writer in this file stamps provider_synced_at. The column
     * is nullable in migration 0960 all the same, so NULLS FIRST has to hold. */
    await ctx.db.execute(sql`UPDATE shop_fulfillments SET provider_synced_at = NULL WHERE id = ${never}`);

    expect((await listCourierParcelsToSync(ctx.db, 10)).map((f) => f.id)).toEqual([never, older, newer]);
    expect((await listCourierParcelsToSync(ctx.db, 1)).map((f) => f.id)).toEqual([never]);
    expect((await listCourierParcelsToSync(ctx.db, 2)).map((f) => f.id)).toEqual([never, older]);
    await ctx.db.execute(sql`SELECT 1`); // keeps the handle warm for afterAll
  });
});
