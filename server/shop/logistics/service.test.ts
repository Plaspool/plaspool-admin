import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { recordCourierBooking } from '../orders/repo/courier';
import { listIntents } from '../orders/repo/emails';
import { mintGuestToken } from '../orders/tokens';
import { storefrontOrigin } from '../storefront-url';
import { BUILT_IN } from '../../email/system-templates';
import { registerLogisticsDeps, resetLogisticsDeps, resolveLogisticsDeps } from './deps';
import type { LogisticsCatalog } from './deps';
import { LogisticsError, PROVIDER_LABEL } from './port';
import type {
  BookingResult,
  LogisticsProvider,
  ParcelInput,
  ProviderId,
  QuoteOption,
  QuoteResult,
  ShipFrom,
  TrackResult,
} from './port';
import { getLogisticsSettings } from './repo';
import {
  accessLinkFor,
  applyCourierUpdate,
  bookParcel,
  buildParcelInput,
  cancelParcelCourier,
  quoteParcel,
  refreshParcel,
} from './service';

/**
 * THE BOOKING SERVICE — what a parcel is quoted for, booked with, and what the
 * courier's answers do to it afterwards (spec §5.2–§5.4).
 *
 * A REAL DATABASE AND A FAKE COURIER. Everything below the port is genuine:
 * PGlite, the real `shop_fulfillments` guards, the real ship/deliver
 * transitions and the emails they enqueue. The only stub is the courier
 * itself, because the one thing a test must never do is book a parcel with
 * somebody who will invoice us for it.
 *
 * EVERY FAKE METHOD THIS SUITE DOES NOT DRIVE THROWS, rather than answering a
 * plausible shape — a service reaching for `track()` on the booking path fails
 * here instead of passing on invented data.
 */

let ctx: TestCtx;

const NOW = T0 + 10_000;
const SEEDED_AT = 1_786_600_005_100;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };

/** The address the shop collects from. Complete, so nothing refuses on it. */
const SHIP_FROM: ShipFrom = {
  name: 'PlaSpool',
  phone: '08030000000',
  email: 'dispatch@plaspool.com',
  line1: '12 Aminu Kano Crescent',
  city: 'Wuse 2',
  region: 'FCT',
  postalCode: '900288',
  countryCode: 'NG',
};

/**
 * A COMPLETE recipient address, which the canonical fixture deliberately is
 * not — `checkoutCompleted()` ships `{ name, line1, country }` and no city, so
 * every case here that wants a courier call has to say so. The incomplete one
 * is exercised on purpose in `booking-routes.test.ts`.
 */
const TO = {
  name: 'A Buyer',
  phone: '08031234567',
  line1: '1 Test Street',
  line2: 'Flat 2',
  city: 'Wuse 2',
  region: 'FCT',
  postalCode: '900288',
  countryCode: 'NG',
};

const MUG = 'var_mug_navy';
const TEE = 'var_tee_m';

interface Recorded {
  quote: ParcelInput[];
  book: {
    input: ParcelInput;
    optionId: string;
    quoteRef: string | null;
    chosen: QuoteOption | null;
  }[];
  track: string[];
  cancel: { providerRef: string; reason: string }[];
}
let calls: Recorded;

interface Behaviour {
  quote?: QuoteResult;
  /** What `quote` rejects with instead of answering — a courier refusing the parcel. */
  quoteError?: Error;
  book?: BookingResult;
  track?: TrackResult;
}

function fakeProvider(id: ProviderId, b: Behaviour = {}): LogisticsProvider {
  const unused = (method: string) => (): never => {
    throw new Error(`fake ${id}: ${method} is not driven by this case`);
  };
  return {
    id,
    /* The adapters set exactly this; a label that differed would let a test
       pass on a string production never produces. */
    label: PROVIDER_LABEL[id],
    quote: async (input) => {
      calls.quote.push(input);
      if (b.quoteError) throw b.quoteError;
      if (!b.quote) throw new Error(`fake ${id}: quote is not driven by this case`);
      return b.quote;
    },
    book: async (input, optionId, quoteRef, chosen) => {
      calls.book.push({ input, optionId, quoteRef, chosen });
      if (!b.book) throw new Error(`fake ${id}: book is not driven by this case`);
      return b.book;
    },
    track: async (providerRef) => {
      calls.track.push(providerRef);
      if (!b.track) throw new Error(`fake ${id}: track is not driven by this case`);
      return b.track;
    },
    cancel: async (providerRef, reason) => {
      calls.cancel.push({ providerRef, reason });
    },
    registerWebhook: unused('registerWebhook'),
    parseWebhook: unused('parseWebhook'),
  };
}

/**
 * Grams per variant. **An absent key is an absent variant**, which the port
 * says a caller must not read as zero — so a case that wants "no weight" says
 * `null` and a case that wants "unknown variant" leaves it out.
 */
const fakeCatalog = (weights: Record<string, number | null>): LogisticsCatalog => ({
  weightsFor: async (_db, ids) =>
    new Map(ids.filter((id) => id in weights).map((id) => [id, weights[id]])),
  weightCoverage: async () => ({ missing: 0, total: 0 }),
});

/** Wire one courier, with the catalogue's weights and a frozen clock. */
function wire(
  providers: Partial<Record<ProviderId, LogisticsProvider | null>>,
  weights: Record<string, number | null> = { [MUG]: 400, [TEE]: 250 },
): void {
  registerLogisticsDeps({ catalog: fakeCatalog(weights), providers, now: () => NOW });
}

/** Put the settings row in a known state. Ship-from is set unless cleared. */
async function settings(
  provider: 'manual' | ProviderId,
  opts: { shipFrom?: ShipFrom | null; terminalPackagingId?: string | null } = {},
): Promise<void> {
  const from = opts.shipFrom === undefined ? SHIP_FROM : opts.shipFrom;
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, ship_from, terminal_packaging_id, updated_at)
    VALUES ('main', ${provider}, ${from === null ? null : JSON.stringify(from)}::jsonb,
            ${opts.terminalPackagingId ?? null}::text, ${SEEDED_AT})`);
}

async function paidOrder(address: Record<string, unknown> = TO): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted({ shippingAddress: address })]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** A parcel over some of the order, through the real repository. */
function parcelOver(
  order: OrderRead,
  lines: { orderLineId: string; qty: number }[],
): Promise<Fulfillment> {
  return createFulfillment(
    ctx.db,
    order.order.id,
    { lines, carrier: null, trackingNumber: null },
    ctx.users.owner.id,
    NOW,
  );
}

/** One of the two mug units — the order line holds 2, so the parcel's own qty shows. */
const oneMug = (order: OrderRead) => parcelOver(order, [{ orderLineId: order.lines[0].id, qty: 1 }]);

/** Everything the order owes, so `settleOrderFulfilled` has something to settle. */
const wholeOrder = (order: OrderRead) =>
  parcelOver(
    order,
    order.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
  );

/** A parcel already booked with Fez, straight through the repository. */
function booked(f: Fulfillment): Promise<Fulfillment> {
  return recordCourierBooking(ctx.db, f.id, {
    provider: 'fez',
    providerRef: 'ASAC1',
    carrier: 'Fez Delivery',
    trackingNumber: 'ASAC1',
    trackingUrl: 'https://fezdelivery.co/track/ASAC1',
    labelUrl: null,
    costMinor: 645_000,
    rawStatus: 'Pending Pick-Up',
    state: 'booked',
    now: NOW,
    actorId: ctx.users.owner.id,
    message: 'Booked with Fez Delivery',
  });
}

async function timeline(orderId: string): Promise<{ type: string; message: string }[]> {
  const res = await ctx.db.execute(sql`
    SELECT type, message FROM shop_order_events
     WHERE order_id = ${orderId} ORDER BY occurred_at ASC, id ASC`);
  return res.rows.map((r) => ({ type: String(r.type), message: String(r.message) }));
}

const reread = async (id: string): Promise<Fulfillment> =>
  (await readFulfillment(ctx.db, id))!.fulfillment;

const FEZ_QUOTE: QuoteResult = {
  providerRef: null,
  weightKg: 2,
  note: null,
  options: [
    { id: 'fez', carrier: 'Fez Delivery', label: 'Fez Delivery', amountMinor: 645_000, currency: 'NGN' },
  ],
};

const FEZ_BOOKING: BookingResult = {
  providerRef: 'ASAC1',
  carrier: 'Fez Delivery',
  trackingNumber: 'ASAC1',
  trackingUrl: 'https://fezdelivery.co/track/ASAC1',
  labelUrl: 'https://fezdelivery.co/manifest/ASAC1',
  costMinor: 645_000,
  rawStatus: 'Pending Pick-Up',
  state: 'booked',
};

const TERMINAL_QUOTE: QuoteResult = {
  providerRef: 'SH-1',
  weightKg: 1.05,
  note: null,
  packagingRef: 'PA-77',
  options: [
    { id: 'rate_a', carrier: 'DHL', label: 'DHL · Express', amountMinor: 900_000, currency: 'NGN' },
    { id: 'rate_b', carrier: 'GIG', label: 'GIG · Economy', amountMinor: 400_000, currency: 'NGN' },
  ],
};

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  calls = { quote: [], book: [], track: [], cancel: [] };
  resetLogisticsDeps();
  await resetOrderTables(ctx.db);
  await settings('manual');
});

afterEach(() => {
  /* Module state: a fake left registered would answer the next suite's questions. */
  resetLogisticsDeps();
});

// ============================================================ buildParcelInput

describe('buildParcelInput', () => {
  it('carries the PARCEL, not the order: its lines, its quantities, its value', async () => {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    const { input, missing } = await buildParcelInput(
      ctx.db,
      resolveLogisticsDeps(),
      order,
      parcel,
      await getLogisticsSettings(ctx.db),
    );

    /* The order has two lines and two mugs; this parcel has one line and one
       mug, and both halves of that have to survive into the courier request. */
    expect(input.items).toEqual([
      {
        orderLineId: order.lines[0].id,
        variantId: MUG,
        title: 'Enamel Mug',
        sku: 'MUG-NAVY',
        qty: 1,
        unitMinor: 1500,
        weightGrams: 400,
      },
    ]);
    /* Σ unit × qty for THIS parcel — never the order's grand total, which
       includes a t-shirt that is still in the warehouse. */
    expect(input.valueMinor).toBe(1500);
    expect(input.fulfillmentId).toBe(parcel.id);
    expect(input.orderNumber).toBe(order.order.orderNumber);
    expect(missing).toEqual([]);

    expect(input.to).toMatchObject({
      name: 'A Buyer',
      line1: '1 Test Street',
      line2: 'Flat 2',
      city: 'Wuse 2',
      region: 'FCT',
      postalCode: '900288',
      countryCode: 'NG',
      phone: '08031234567',
    });
    /* The address carries no email, so the order's stands in — a courier with
       no address to notify is a courier that cannot notify. */
    expect(input.to.email).toBe(order.order.email);

    expect(input.from).toEqual(SHIP_FROM);
    expect(input.packaging).toEqual({
      name: 'Spool box',
      lengthCm: 22,
      widthCm: 22,
      heightCm: 8,
      weightKg: 0.25,
    });
    expect(input.packagingRef).toBeNull();
  });

  it('reads weights through the catalog port and names the lines that have none', async () => {
    wire({ fez: fakeProvider('fez') }, { [MUG]: null, [TEE]: 250 });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await wholeOrder(order);

    const { input, missing } = await buildParcelInput(
      ctx.db,
      resolveLogisticsDeps(),
      order,
      parcel,
      await getLogisticsSettings(ctx.db),
    );

    expect(input.items.map((i) => i.weightGrams)).toEqual([null, 250]);
    expect(missing.map((l) => l.variantId)).toEqual([MUG]);
  });

  it('carries the cached Terminal packaging record when the settings hold one', async () => {
    wire({ terminal: fakeProvider('terminal') });
    await settings('terminal', { terminalPackagingId: 'PA-77' });
    const order = await paidOrder();
    const parcel = await oneMug(order);

    const { input } = await buildParcelInput(
      ctx.db,
      resolveLogisticsDeps(),
      order,
      parcel,
      await getLogisticsSettings(ctx.db),
    );
    expect(input.packagingRef).toBe('PA-77');
  });
});

// ================================================================= quoteParcel

describe('quoteParcel', () => {
  it('refuses provider_manual on the seeded row, and calls nobody', async () => {
    wire({ fez: fakeProvider('fez') });
    const order = await paidOrder();
    const parcel = await oneMug(order);

    expect(await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW)).toEqual({
      refused: 'provider_manual',
    });
    expect(calls.quote).toEqual([]);
  });

  it('refuses provider_not_configured when the courier has no credentials here', async () => {
    wire({ fez: null });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    expect(await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW)).toEqual({
      refused: 'provider_not_configured',
    });
  });

  it('answers null for a parcel that does not exist', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE }) });
    await settings('fez');
    expect(await quoteParcel(ctx.db, resolveLogisticsDeps(), 'ful_nope', NOW)).toBeNull();
  });

  it('refuses already_booked once a courier holds the parcel', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE }) });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);
    await booked(parcel);

    expect(await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW)).toEqual({
      refused: 'already_booked',
    });
    expect(calls.quote).toEqual([]);
  });

  it('TERMINAL: refuses weights_missing BEFORE the courier is called at all', async () => {
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE }) }, { [MUG]: null, [TEE]: 250 });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await wholeOrder(order);

    const out = await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);
    expect(out).toEqual({
      refused: 'weights_missing',
      lines: [
        {
          orderLineId: order.lines[0].id,
          variantId: MUG,
          sku: 'MUG-NAVY',
          title: 'Enamel Mug',
        },
      ],
    });
    /* The owner's rule: nothing is quoted for Terminal until every line has a
       weight, and "before any provider call" is the half that a later refactor
       could quietly lose. */
    expect(calls.quote).toEqual([]);
  });

  it('TERMINAL: stores the draft on the parcel and caches the packaging record', async () => {
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE }) });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    const out = await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);
    expect(out).toEqual({
      provider: 'terminal',
      providerLabel: 'Terminal Africa',
      weightKg: 1.05,
      quoteRef: 'SH-1',
      note: null,
      options: TERMINAL_QUOTE.options,
      missingWeights: [],
    });

    const after = await reread(parcel.id);
    expect(after.provider).toBe('terminal');
    expect(after.providerRef).toBe('SH-1');
    expect(after.courierState).toBe('draft');
    /* A draft is not a booking: nothing has been promised to a customer yet. */
    expect(after.status).toBe('pending');
    expect(after.trackingNumber).toBeNull();

    expect((await getLogisticsSettings(ctx.db)).terminalPackagingId).toBe('PA-77');
  });

  /**
   * A QUOTE THAT FAILED CAN STILL HAVE COST US A RECORD AT THE COURIER.
   *
   * Terminal creates the packaging record before it asks for a shipment, so a
   * refusal after that point leaves one behind — and `LogisticsError` carries
   * its id out for exactly this. Cache it before the failure travels on, or
   * every retry of the quote an operator is most likely to retry (fix the
   * address, quote again) mints another.
   */
  it('TERMINAL: caches the packaging record a failed quote created, and still fails', async () => {
    const failed = new LogisticsError('provider_rejected', 'Invalid recipient state', { status: 400, packagingRef: 'PA-1' });
    wire({ terminal: fakeProvider('terminal', { quoteError: failed }) });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    await expect(quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW)).rejects.toBe(failed);
    expect((await getLogisticsSettings(ctx.db)).terminalPackagingId).toBe('PA-1');
    /* The failure is still a failure: no draft on the parcel, nothing promised. */
    const after = await reread(parcel.id);
    expect(after.provider).toBeNull();
    expect(after.courierState).toBeNull();

    /* And the next attempt is handed the cached id, so it creates nothing. */
    wire({ terminal: fakeProvider('terminal', { quote: { ...TERMINAL_QUOTE, packagingRef: undefined } }) });
    await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);
    expect(calls.quote.at(-1)!.packagingRef).toBe('PA-1');
  });

  it('TERMINAL: a failed quote that created nothing caches nothing', async () => {
    wire({ terminal: fakeProvider('terminal', { quoteError: new LogisticsError('provider_unavailable', 'Terminal Africa timed out') }) });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    await expect(quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW)).rejects.toBeInstanceOf(LogisticsError);
    expect((await getLogisticsSettings(ctx.db)).terminalPackagingId).toBeNull();
  });

  it('FEZ: missing weights are soft — reported, never refused, and nothing is stored', async () => {
    wire({ fez: fakeProvider('fez', { quote: { ...FEZ_QUOTE, note: '1 item has no weight' } }) }, {
      [MUG]: null,
      [TEE]: 250,
    });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await wholeOrder(order);

    const out = await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);
    expect(out).toEqual({
      provider: 'fez',
      providerLabel: 'Fez Delivery',
      weightKg: 2,
      quoteRef: null,
      note: '1 item has no weight',
      options: FEZ_QUOTE.options,
      missingWeights: [
        { orderLineId: order.lines[0].id, variantId: MUG, sku: 'MUG-NAVY', title: 'Enamel Mug' },
      ],
    });
    expect(calls.quote).toHaveLength(1);

    /* Fez has no draft to hold on to, so a quote leaves the parcel untouched. */
    const after = await reread(parcel.id);
    expect(after.provider).toBeNull();
    expect(after.providerRef).toBeNull();
    expect(after.courierState).toBeNull();
  });
});

// ================================================================== bookParcel

describe('bookParcel', () => {
  it('writes every courier column and files the booking on the timeline', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: FEZ_BOOKING }) });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    const out = await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });

    expect(out).toMatchObject({
      id: parcel.id,
      status: 'pending',
      provider: 'fez',
      providerRef: 'ASAC1',
      carrier: 'Fez Delivery',
      trackingNumber: 'ASAC1',
      trackingUrl: 'https://fezdelivery.co/track/ASAC1',
      labelUrl: 'https://fezdelivery.co/manifest/ASAC1',
      providerCostMinor: 645_000,
      providerStatus: 'Pending Pick-Up',
      courierState: 'booked',
      providerSyncedAt: NOW,
    });

    /* The message an operator reads on the order, to the kobo and the waybill. */
    expect(await timeline(order.order.id)).toContainEqual({
      type: 'courier_booked',
      message: 'Booked with Fez Delivery · ₦6,450.00 · ASAC1',
    });
  });

  it('re-quotes Fez to learn what we are about to pay, and hands the adapter the option', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: { ...FEZ_BOOKING, costMinor: null } }) });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });

    expect(calls.quote).toHaveLength(1);
    expect(calls.book).toHaveLength(1);
    expect(calls.book[0]).toMatchObject({
      optionId: 'fez',
      quoteRef: null,
      chosen: FEZ_QUOTE.options[0],
    });
    /* Fez's booking answer carries no price, so the quoted option is what the
       row records and what the timeline quotes. */
    expect((await reread(parcel.id)).providerCostMinor).toBe(645_000);
  });

  it('an optionId nobody offered still books — the re-quote decides, never the caller', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: FEZ_BOOKING }) });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'a-rate-from-last-week',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });
    expect(calls.book[0].chosen).toEqual(FEZ_QUOTE.options[0]);
  });

  it('a re-quote with no options at all hands the adapter chosen: null', async () => {
    wire({
      fez: fakeProvider('fez', {
        quote: { ...FEZ_QUOTE, options: [] },
        book: { ...FEZ_BOOKING, costMinor: null },
      }),
    });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });
    expect(calls.book[0].chosen).toBeNull();
    /* Nothing knows the price, so nothing invents one. */
    expect((await reread(parcel.id)).providerCostMinor).toBeNull();
    expect(await timeline(order.order.id)).toContainEqual({
      type: 'courier_booked',
      message: 'Booked with Fez Delivery · ASAC1',
    });
  });

  it('a second booking is refused already_booked, from the repository guard', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: FEZ_BOOKING }) });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);
    const args = {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    };

    expect(await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, args)).toMatchObject({
      providerRef: 'ASAC1',
    });
    expect(await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, args)).toEqual({
      refused: 'already_booked',
    });
  });

  it('TERMINAL: a quoteRef that is not the stored draft is provider_rejected', async () => {
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE }) });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await oneMug(order);
    await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);

    for (const quoteRef of [null, 'SH-0']) {
      await expect(
        bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
          optionId: 'rate_a',
          quoteRef,
          actorId: ctx.users.owner.id,
          now: NOW,
        }),
      ).rejects.toMatchObject({ name: 'LogisticsError', code: 'provider_rejected' });
    }
    /* A stale rate is never sent to the courier. */
    expect(calls.book).toEqual([]);
  });

  it('TERMINAL: books against the stored draft, with the chosen rate as the price', async () => {
    const booking: BookingResult = {
      providerRef: 'SH-1',
      carrier: 'GIG',
      trackingNumber: 'TRK-9',
      trackingUrl: 'https://track.terminal.africa/TRK-9',
      labelUrl: null,
      costMinor: null,
      rawStatus: 'confirmed',
      state: 'booked',
    };
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE, book: booking }) });
    await settings('terminal');
    const order = await paidOrder();
    const parcel = await oneMug(order);
    await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW);

    const out = await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'rate_b',
      quoteRef: 'SH-1',
      actorId: ctx.users.owner.id,
      now: NOW,
    });

    /* Terminal's price is the rate that was chosen — the adapter is not
       re-quoted, because a second quote would mint a second draft. */
    expect(calls.quote).toHaveLength(1);
    expect(calls.book[0]).toMatchObject({ optionId: 'rate_b', quoteRef: 'SH-1', chosen: null });
    expect(out).toMatchObject({
      provider: 'terminal',
      providerRef: 'SH-1',
      carrier: 'GIG',
      trackingNumber: 'TRK-9',
      courierState: 'booked',
      providerCostMinor: null,
    });
  });
});

// ========================================================== applyCourierUpdate

describe('applyCourierUpdate', () => {
  const apply = (f: Fulfillment, u: TrackResult) =>
    applyCourierUpdate(ctx.db, f, u, {
      now: NOW,
      link: null,
      templates: BUILT_IN,
      label: 'Fez Delivery',
    });

  /** A booked parcel over the WHOLE order, so a settlement has something to settle. */
  async function bookedParcel(): Promise<{ order: OrderRead; parcel: Fulfillment }> {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await booked(await wholeOrder(order));
    return { order, parcel };
  }

  it('pending + picked_up SHIPS the parcel and mails the customer the tracking link', async () => {
    const { order, parcel } = await bookedParcel();

    const out = await apply(parcel, {
      rawStatus: 'Picked-Up',
      state: 'picked_up',
      description: 'Collected from the merchant',
    });

    expect(out.transitioned).toBe('shipped');
    expect(out.changed).toBe(true);
    expect(out.fulfillment).toMatchObject({
      status: 'shipped',
      shippedAt: NOW,
      courierState: 'picked_up',
      providerStatus: 'Picked-Up',
    });

    const shipments = (await listIntents(ctx.db, order.order.id)).filter(
      (intent) => intent.kind === 'shipment',
    );
    expect(shipments).toHaveLength(1);
    /* The courier's own tracking page, which only a booking can have written. */
    expect(shipments[0].body).toContain('https://fezdelivery.co/track/ASAC1');
    expect(shipments[0].body).toContain('ASAC1');

    expect((await timeline(order.order.id)).map((e) => e.type)).toContain('courier_update');
    expect(await timeline(order.order.id)).toContainEqual({
      type: 'courier_update',
      message: 'Fez Delivery: Picked-Up — Collected from the merchant',
    });
  });

  it('pending + delivered ships THEN delivers, and both messages go out', async () => {
    const { order, parcel } = await bookedParcel();

    const out = await apply(parcel, {
      rawStatus: 'Delivered',
      state: 'delivered',
      description: null,
    });

    expect(out.transitioned).toBe('delivered');
    expect(out.fulfillment).toMatchObject({
      status: 'delivered',
      shippedAt: NOW,
      deliveredAt: NOW,
    });

    const kinds = (await listIntents(ctx.db, order.order.id)).map((i) => i.kind);
    expect(kinds).toContain('shipment');
    expect(kinds).toContain('delivered');

    /* The only parcel on the order arrived, so the order is settled — through
       the existing repo function, with the courier's own carrier on the event. */
    expect((await readOrder(ctx.db, order.order.id))!.order.status).toBe('fulfilled');
  });

  it('shipped + in_transit changes the row once; a replay changes and appends nothing', async () => {
    const { order, parcel } = await bookedParcel();
    await apply(parcel, { rawStatus: 'Picked-Up', state: 'picked_up', description: null });

    const update: TrackResult = {
      rawStatus: 'Dispatched',
      state: 'in_transit',
      description: 'On the van',
    };
    const first = await apply(await reread(parcel.id), update);
    expect(first.changed).toBe(true);
    expect(first.transitioned).toBeNull();
    expect(first.fulfillment.status).toBe('shipped');
    expect(first.fulfillment.courierState).toBe('in_transit');

    const second = await apply(await reread(parcel.id), update);
    expect(second.changed).toBe(false);
    expect(second.transitioned).toBeNull();

    const updates = (await timeline(order.order.id)).filter((e) => e.type === 'courier_update');
    expect(updates.filter((e) => e.message.includes('Dispatched'))).toHaveLength(1);

    /* One shipment mail, not two. */
    expect(
      (await listIntents(ctx.db, order.order.id)).filter((i) => i.kind === 'shipment'),
    ).toHaveLength(1);
  });

  it('shipped + returned records the courier state and leaves the parcel status alone', async () => {
    const { parcel } = await bookedParcel();
    await apply(parcel, { rawStatus: 'Picked-Up', state: 'picked_up', description: null });

    const out = await apply(await reread(parcel.id), {
      rawStatus: 'Returned',
      state: 'returned',
      description: 'Recipient unreachable',
    });
    expect(out.transitioned).toBeNull();
    expect(out.fulfillment).toMatchObject({ status: 'shipped', courierState: 'returned' });
  });

  it('the booked status it already holds is a no-op with no timeline entry', async () => {
    const { order, parcel } = await bookedParcel();
    const before = await timeline(order.order.id);

    const out = await apply(parcel, {
      rawStatus: 'Pending Pick-Up',
      state: 'booked',
      description: null,
    });
    expect(out.changed).toBe(false);
    expect(out.transitioned).toBeNull();
    expect(out.fulfillment.status).toBe('pending');
    expect(await timeline(order.order.id)).toEqual(before);
  });

  it('a status nobody has a mapping for is recorded as unknown and moves nothing', async () => {
    const { parcel } = await bookedParcel();

    const out = await apply(parcel, {
      rawStatus: 'Held At Depot',
      state: 'unknown',
      description: null,
    });
    expect(out.changed).toBe(true);
    expect(out.transitioned).toBeNull();
    expect(out.fulfillment).toMatchObject({
      status: 'pending',
      courierState: 'unknown',
      /* The raw word is kept verbatim, which is the whole point of `unknown`. */
      providerStatus: 'Held At Depot',
    });
  });

  it('learns the links a courier only sends later, and never blanks the ones it has', async () => {
    const { parcel } = await bookedParcel();

    const out = await apply(parcel, {
      rawStatus: 'Dispatched',
      state: 'in_transit',
      description: null,
      labelUrl: 'https://fezdelivery.co/manifest/ASAC1',
      trackingUrl: null,
    });
    expect(out.fulfillment.labelUrl).toBe('https://fezdelivery.co/manifest/ASAC1');
    expect(out.fulfillment.trackingUrl).toBe('https://fezdelivery.co/track/ASAC1');
  });
});

// =================================================== refreshParcel / cancelling

describe('refreshParcel', () => {
  it('asks the courier and applies what it says', async () => {
    wire({
      fez: fakeProvider('fez', {
        track: { rawStatus: 'Dispatched', state: 'in_transit', description: 'On the van' },
      }),
    });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await booked(await wholeOrder(order));

    const out = await refreshParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      now: NOW,
      templates: BUILT_IN,
    });

    expect(calls.track).toEqual(['ASAC1']);
    expect(out).toMatchObject({ changed: true, transitioned: 'shipped' });
    expect(out!.fulfillment).toMatchObject({ status: 'shipped', courierState: 'in_transit' });
  });

  it('is null for a parcel with no courier on it, and asks nobody', async () => {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    expect(
      await refreshParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
        now: NOW,
        templates: BUILT_IN,
      }),
    ).toBeNull();
    expect(calls.track).toEqual([]);
  });

  it('throws not_configured when the courier that booked it is gone from this server', async () => {
    wire({ fez: null });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await booked(await wholeOrder(order));

    await expect(
      refreshParcel(ctx.db, resolveLogisticsDeps(), parcel.id, { now: NOW, templates: BUILT_IN }),
    ).rejects.toMatchObject({ name: 'LogisticsError', code: 'not_configured' });
  });
});

describe('cancelParcelCourier', () => {
  it('calls the courier off and takes back every promise made in its name', async () => {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await booked(await wholeOrder(order));

    const out = await cancelParcelCourier(ctx.db, resolveLogisticsDeps(), parcel.id, {
      reason: 'Customer changed the address',
      actorId: ctx.users.owner.id,
      now: NOW,
    });

    expect(calls.cancel).toEqual([
      { providerRef: 'ASAC1', reason: 'Customer changed the address' },
    ]);
    expect(out).toMatchObject({
      status: 'pending',
      courierState: 'cancelled',
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      providerStatus: null,
    });
    expect(await timeline(order.order.id)).toContainEqual({
      type: 'courier_cancelled',
      message: 'Courier cancelled: Customer changed the address',
    });
  });

  it('a blank reason still cancels, and the message stays a sentence', async () => {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await booked(await wholeOrder(order));

    await cancelParcelCourier(ctx.db, resolveLogisticsDeps(), parcel.id, {
      reason: '',
      actorId: ctx.users.owner.id,
      now: NOW,
    });
    expect(await timeline(order.order.id)).toContainEqual({
      type: 'courier_cancelled',
      message: 'Courier cancelled',
    });
  });

  it('is null for a parcel nothing was booked on', async () => {
    wire({ fez: fakeProvider('fez') });
    await settings('fez');
    const order = await paidOrder();
    const parcel = await oneMug(order);

    expect(
      await cancelParcelCourier(ctx.db, resolveLogisticsDeps(), parcel.id, {
        reason: '',
        actorId: ctx.users.owner.id,
        now: NOW,
      }),
    ).toBeNull();
    expect(calls.cancel).toEqual([]);
  });
});

describe('accessLinkFor', () => {
  it('is the STOREFRONT origin and a guest token for this order, not the admin', async () => {
    wire({ fez: fakeProvider('fez') });
    const order = await paidOrder();

    expect(accessLinkFor(order, NOW)).toEqual({
      origin: storefrontOrigin(),
      token: mintGuestToken(
        { orderNumber: order.order.orderNumber, email: order.order.email },
        NOW,
      ),
    });
  });
});

// ======================================================= routing-city override

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAFF RESCUING AN ORDER WHOSE CITY THE COURIER WILL NOT RECOGNISE.
 *
 * Every order placed before migration 1020 carries no routing city at all, and
 * Terminal accepts only ten place names inside the FCT — so most of them are
 * refused with nothing on screen to do about it. The override is the way
 * through: the booking calls take a zone, `buildParcelInput` prefers it, and
 * THE CUSTOMER'S OWN ADDRESS IS NEVER REWRITTEN.
 *
 * THREE STEPS, AND ALL THREE ARE ASSERTED HERE: the override beats the stored
 * zone, the stored zone beats nothing, and nothing leaves `routingCity` null —
 * which is where the adapters' own `routingCity ?? city` takes over (pinned in
 * `terminal/adapter.test.ts`, deliberately unread in `fez/adapter.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('the routing-city override', () => {
  /** The same buyer, having picked a zone at checkout. */
  const TO_WITH_ZONE = { ...TO, routingCity: 'Wuse' };

  const parcelInput = async (order: OrderRead, parcel: Fulfillment, routingCity?: string) =>
    (
      await buildParcelInput(
        ctx.db,
        resolveLogisticsDeps(),
        order,
        parcel,
        await getLogisticsSettings(ctx.db),
        routingCity,
      )
    ).input;

  it('prefers the override over the zone stored on the order', async () => {
    wire({ terminal: fakeProvider('terminal') });
    await settings('terminal');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    const input = await parcelInput(order, parcel, 'Maitama');
    expect(input.to.routingCity).toBe('Maitama');
    /* THE POINT OF THE WHOLE FEATURE: what the customer typed is untouched. */
    expect(input.to.city).toBe('Wuse 2');
    expect(input.to.line1).toBe('1 Test Street');
    expect(input.to.line2).toBe('Flat 2');
  });

  it('falls back to the zone stored on the order when no override is given', async () => {
    wire({ terminal: fakeProvider('terminal') });
    await settings('terminal');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    expect((await parcelInput(order, parcel)).to.routingCity).toBe('Wuse');
  });

  it('carries null when there is neither — the adapters fall back to the real city', async () => {
    wire({ terminal: fakeProvider('terminal') });
    await settings('terminal');
    /* An order placed before 1020: no `routingCity` key at all. */
    const order = await paidOrder();
    const parcel = await oneMug(order);

    const input = await parcelInput(order, parcel);
    expect(input.to.routingCity).toBeNull();
    expect(input.to.city).toBe('Wuse 2');
  });

  /* A blank box is not a zone. Without this, an operator who cleared the field
     would send `""` and Terminal would refuse an empty city instead of falling
     back to the one it was going to refuse anyway. */
  it('treats a blank override as no override at all', async () => {
    wire({ terminal: fakeProvider('terminal') });
    await settings('terminal');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    expect((await parcelInput(order, parcel, '   ')).to.routingCity).toBe('Wuse');
    expect((await parcelInput(order, parcel, '  Maitama ')).to.routingCity).toBe('Maitama');
  });

  it('quoteParcel hands the override to the courier', async () => {
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE }) });
    await settings('terminal');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW, 'Maitama');
    expect(calls.quote).toHaveLength(1);
    expect(calls.quote[0].to.routingCity).toBe('Maitama');
    expect(calls.quote[0].to.city).toBe('Wuse 2');
  });

  it('bookParcel hands the override to the courier, on the re-quote AND the booking', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: FEZ_BOOKING }) });
    await settings('fez');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
      routingCity: 'Maitama',
    });

    /* Fez is re-quoted to learn the price before it is booked, and BOTH calls
       have to carry the zone — a booking priced against one zone and shipped
       against another is a bill nobody can reconcile. */
    expect(calls.quote.at(-1)!.to.routingCity).toBe('Maitama');
    expect(calls.book).toHaveLength(1);
    expect(calls.book[0].input.to.routingCity).toBe('Maitama');
  });

  /**
   * NOTHING IS PERSISTED, AND THAT IS THE WHOLE DESIGN.
   *
   * The shipment goes out with a zone the courier accepts and the customer's
   * address stays the words they wrote. A "helpful" write here would rewrite
   * somebody's home address to a district they do not live in, on an order
   * they have already paid for.
   */
  it('writes the override nowhere — the customer’s address is byte-identical afterwards', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE, book: FEZ_BOOKING }) });
    await settings('fez');
    const order = await paidOrder(TO_WITH_ZONE);
    const parcel = await oneMug(order);

    const storedAddress = async (): Promise<unknown> =>
      (
        await ctx.db.execute(sql`
          SELECT shipping_address FROM shop_orders WHERE id = ${order.order.id}`)
      ).rows[0]!.shipping_address;
    const before = await storedAddress();

    await quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW, 'Maitama');
    await bookParcel(ctx.db, resolveLogisticsDeps(), parcel.id, {
      optionId: 'fez',
      quoteRef: null,
      actorId: ctx.users.owner.id,
      now: NOW,
      routingCity: 'Maitama',
    });

    expect(await storedAddress()).toEqual(before);
    expect((before as { routingCity?: string }).routingCity).toBe('Wuse');
    /* And not into the checkout's own address table either. This harness makes
       its order from an event and writes no `shop_addresses` row at all; the
       count is what keeps it that way. */
    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM shop_addresses WHERE routing_city IS NOT NULL`);
    expect(rows.rows[0]!.n).toBe(0);
  });
});

/**
 * A guard against the one refusal that must never be silent: an order whose
 * address a courier cannot collect at.
 */
describe('an address a courier cannot use', () => {
  it('throws address_incomplete, naming the fields', async () => {
    wire({ fez: fakeProvider('fez', { quote: FEZ_QUOTE }) });
    await settings('fez');
    /* The canonical fixture: name, line1, a country, and no city. */
    const order = await paidOrder({ name: 'A Buyer', line1: '1 Test Street', country: 'GB' });
    const parcel = await oneMug(order);

    await expect(
      quoteParcel(ctx.db, resolveLogisticsDeps(), parcel.id, NOW),
    ).rejects.toMatchObject({
      name: 'LogisticsError',
      code: 'address_incomplete',
      detail: ['city'],
    });
    expect(calls.quote).toEqual([]);
  });
});
