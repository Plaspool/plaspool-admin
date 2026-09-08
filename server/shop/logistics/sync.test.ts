import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from '../orders/test/fixtures';
import { sweepCommerceEvents } from '../orders/repo/consumer';
import type { ConsumerDeps } from '../orders/repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout } from '../orders/repo/orders';
import type { OrderRead } from '../orders/repo/orders';
import { createFulfillment, readFulfillment } from '../orders/repo/fulfillments';
import type { Fulfillment } from '../orders/repo/fulfillments';
import { recordCourierBooking, recordCourierSnapshot } from '../orders/repo/courier';
import { registerLogisticsDeps, resetLogisticsDeps, resolveLogisticsDeps } from './deps';
import { LogisticsError, PROVIDER_LABEL } from './port';
import type { LogisticsProvider, ProviderId, TrackResult } from './port';
import { COURIER_SYNC_LIMIT, syncCourierStatuses } from './sync';

/**
 * THE SWEEP'S BACKSTOP FOR A WEBHOOK THAT NEVER ARRIVED (spec §5.6).
 *
 * A REAL DATABASE AND A FAKE COURIER, exactly as `service.test.ts` runs: the
 * page of due parcels, the snapshot guards, the ship/deliver transitions and
 * the email intents are all genuine, and the only stub is the courier — because
 * a sweep that reached a real one would poll somebody's live API on every run
 * of this suite.
 *
 * WHAT THIS FILE IS ACTUALLY FOR is the BOUNDING and the FAILURE ISOLATION, not
 * the transition table: what "delivered" does to a parcel is `service.ts`'s
 * `applyCourierUpdate`, proved once in `service.test.ts` and reached from here
 * rather than re-derived. This suite proves that the sweep asks only about
 * parcels whose story is unfinished, that it never asks about more than one
 * page of them, and that one courier failing does not cost the other parcels
 * their update — which is the property that makes it safe to run this inside a
 * cron that also settles payments.
 */

let ctx: TestCtx;

const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };

/** Every `track()` this suite drives, in call order, so "who was asked" is assertable. */
let tracked: string[];

/**
 * What the fake courier answers per waybill. A missing key THROWS rather than
 * answering a plausible shape: a sweep that reached for a parcel this case did
 * not set up must fail here rather than pass on invented data.
 */
type TrackScript = Record<string, TrackResult | Error>;

function fakeProvider(id: ProviderId, script: TrackScript): LogisticsProvider {
  const unused = (method: string) => (): never => {
    throw new Error(`fake ${id}: ${method} is not driven by this case`);
  };
  return {
    id,
    label: PROVIDER_LABEL[id],
    track: async (providerRef) => {
      tracked.push(providerRef);
      const answer = script[providerRef];
      if (answer === undefined) throw new Error(`fake ${id}: no track script for ${providerRef}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    quote: unused('quote'),
    book: unused('book'),
    cancel: unused('cancel'),
    registerWebhook: unused('registerWebhook'),
    parseWebhook: unused('parseWebhook'),
  };
}

/** Wire one courier and a frozen clock. `null` means "that courier is not set up here". */
function wire(providers: Partial<Record<ProviderId, LogisticsProvider | null>>): void {
  registerLogisticsDeps({ providers, now: () => NOW });
}

const DISPATCHED: TrackResult = {
  rawStatus: 'Dispatched',
  state: 'in_transit',
  description: 'Out with the rider',
};

async function paidOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** One parcel over `qty` of the order's `lineIndex`th line, through the real repository. */
function parcelOver(order: OrderRead, lineIndex: number, qty = 1): Promise<Fulfillment> {
  return createFulfillment(
    ctx.db,
    order.order.id,
    { lines: [{ orderLineId: order.lines[lineIndex].id, qty }], carrier: null, trackingNumber: null },
    ctx.users.owner.id,
    NOW,
  );
}

/** A parcel with a live Fez booking on it, ready for the sweep to ask about. */
async function booked(order: OrderRead, lineIndex: number, ref: string): Promise<Fulfillment> {
  const parcel = await parcelOver(order, lineIndex);
  return recordCourierBooking(ctx.db, parcel.id, {
    provider: 'fez',
    providerRef: ref,
    carrier: 'Fez Delivery',
    trackingNumber: ref,
    trackingUrl: `https://fezdelivery.co/track/${ref}`,
    labelUrl: null,
    costMinor: 645_000,
    rawStatus: 'Pending Pick-Up',
    state: 'booked',
    now: NOW,
    actorId: ctx.users.owner.id,
    message: `Booked with Fez Delivery · ${ref}`,
  });
}

const reread = async (id: string): Promise<Fulfillment> =>
  (await readFulfillment(ctx.db, id))!.fulfillment;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  tracked = [];
  resetLogisticsDeps();
  await resetOrderTables(ctx.db);
});

afterEach(() => {
  /* Module state: a fake left registered would answer the next suite's questions. */
  resetLogisticsDeps();
});

it('asks only about the parcels whose story is unfinished, and applies what it hears', async () => {
  const order = await paidOrder();
  const a = await booked(order, 0, 'ASAC1');
  const b = await booked(order, 0, 'ASAC2');
  /* Already arrived. `listCourierParcelsToSync` excludes it, so a courier that
     would answer for it is never asked — which is the whole point of the page. */
  const done = await booked(order, 1, 'ASAC3');
  await recordCourierSnapshot(ctx.db, done.id, {
    rawStatus: 'Delivered',
    state: 'delivered',
    now: NOW + 1,
    message: 'Fez Delivery: Delivered',
  });

  wire({ fez: fakeProvider('fez', { ASAC1: DISPATCHED, ASAC2: DISPATCHED }) });

  const summary = await syncCourierStatuses(ctx.db, resolveLogisticsDeps(), NOW + 2);

  expect(summary).toEqual({ checked: 2, changed: 2, transitioned: 2, failed: 0 });
  expect(tracked.sort()).toEqual(['ASAC1', 'ASAC2']);

  /* Applied THROUGH `applyCourierUpdate`, so `Dispatched` ships the parcel and
     the shipment email is queued by the same statement — not re-derived here. */
  expect(await reread(a.id)).toMatchObject({ status: 'shipped', courierState: 'in_transit' });
  expect(await reread(b.id)).toMatchObject({ status: 'shipped', courierState: 'in_transit' });
  expect(await reread(done.id)).toMatchObject({ status: 'pending', providerStatus: 'Delivered' });
});

it('a courier that fails on one parcel costs that parcel its update and no other', async () => {
  const order = await paidOrder();
  const bad = await booked(order, 0, 'ASAC1');
  const good = await booked(order, 0, 'ASAC2');

  wire({
    fez: fakeProvider('fez', {
      ASAC1: new LogisticsError('provider_unavailable', 'Fez Delivery is unreachable'),
      ASAC2: DISPATCHED,
    }),
  });

  const summary = await syncCourierStatuses(ctx.db, resolveLogisticsDeps(), NOW + 2);

  expect(summary).toEqual({ checked: 2, changed: 1, transitioned: 1, failed: 1 });

  /* The failure is RECORDED on the parcel rather than thrown: an operator has to
     be able to see that we asked and could not get an answer. */
  const failed = await reread(bad.id);
  expect(failed.providerLastError).toBe('Fez Delivery is unreachable');
  expect(failed).toMatchObject({ status: 'pending', courierState: 'booked', providerSyncedAt: NOW + 2 });

  expect(await reread(good.id)).toMatchObject({ status: 'shipped', providerLastError: null });
});

it('a parcel booked with a courier this deployment no longer has is a recorded failure, not a throw', async () => {
  const order = await paidOrder();
  const parcel = await booked(order, 0, 'ASAC1');

  /* A registered `null` is an ANSWER — "Fez is not configured here" — which is
     the shop that has since moved to Terminal with Fez parcels still in flight. */
  wire({ fez: null });

  const summary = await syncCourierStatuses(ctx.db, resolveLogisticsDeps(), NOW + 2);

  expect(summary).toEqual({ checked: 1, changed: 0, transitioned: 0, failed: 1 });
  expect(tracked).toEqual([]);
  expect((await reread(parcel.id)).providerLastError).toContain('Fez Delivery');
});

it('takes one page at a time, oldest sync first', async () => {
  const order = await paidOrder();
  await booked(order, 0, 'ASAC1');
  await booked(order, 0, 'ASAC2');
  await booked(order, 1, 'ASAC3');

  wire({ fez: fakeProvider('fez', { ASAC1: DISPATCHED, ASAC2: DISPATCHED, ASAC3: DISPATCHED }) });

  const summary = await syncCourierStatuses(ctx.db, resolveLogisticsDeps(), NOW + 2, 2);

  expect(summary.checked).toBe(2);
  expect(tracked).toHaveLength(2);
  /* The remaining parcel is simply next time's work — nothing is lost by the cap. */
  const rows = await ctx.db.execute(sql`
    SELECT count(*)::int AS n FROM shop_fulfillments WHERE status = 'pending' AND provider_ref IS NOT NULL`);
  expect(Number(rows.rows[0]?.n)).toBe(1);
});

it('costs nothing at all when there is no parcel to ask about', async () => {
  await paidOrder();
  wire({ fez: fakeProvider('fez', {}) });

  const summary = await syncCourierStatuses(ctx.db, resolveLogisticsDeps(), NOW + 2);

  expect(summary).toEqual({ checked: 0, changed: 0, transitioned: 0, failed: 0 });
  expect(tracked).toEqual([]);
});

it('bounds itself by default, so a cron cannot be handed a backlog to choke on', () => {
  expect(COURIER_SYNC_LIMIT).toBeLessThanOrEqual(50);
  expect(COURIER_SYNC_LIMIT).toBeGreaterThan(0);
});
