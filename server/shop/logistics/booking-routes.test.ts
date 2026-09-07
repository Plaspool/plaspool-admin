import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { resetOrderTables } from '../orders/test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from '../orders/test/fixtures';
import { sweepCommerceEvents } from '../orders/repo/consumer';
import type { ConsumerDeps } from '../orders/repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout } from '../orders/repo/orders';
import type { OrderRead } from '../orders/repo/orders';
import { listIntents } from '../orders/repo/emails';
import { registerLogisticsDeps, resetLogisticsDeps } from './deps';
import type { LogisticsCatalog } from './deps';
import { LogisticsError, PROVIDER_LABEL } from './port';
import type {
  BookingResult,
  LogisticsProvider,
  ProviderId,
  QuoteResult,
  ShipFrom,
  TrackResult,
} from './port';

/**
 * THE FOUR BOOKING ROUTES, driven through the REAL application — router,
 * origin guard, session middleware, the URL-prefix permission table and
 * `shopApp()`'s `onError` (CLAUDE.md §2, and the same argument
 * `routes.test.ts` makes for the settings surface).
 *
 * THE ORDER AND THE PARCEL ARE MADE THE WAY PRODUCTION MAKES THEM: a
 * `checkout.completed` event swept by the real consumer, `markOrderPaid`, then
 * `POST /api/shop/admin/orders/:id/fulfillments` through Orders' own route —
 * exactly as `server/shop/orders/fulfillment-tracking.test.ts` does. Nothing
 * here inserts a fulfilment by hand, so the courier routes are tested against
 * a parcel with the guards, triggers and counters a real one carries.
 *
 * THE PERMISSION LINE THIS PINS: these paths live under
 * `/api/shop/admin/fulfillments`, which `server/middleware/permissions.ts`
 * already maps to the `orders` domain. So the teammate who packs the box can
 * book the courier for it, and a `writer` cannot — which is the whole reason
 * they were not put under `/admin/logistics/*` with the settings.
 */

let ctx: TestCtx;
let http: HttpClient;

const NOW = T0 + 10_000;
const SEEDED_AT = 1_786_600_005_100;
const DEPS: ConsumerDeps = { origin: 'https://studio.test' };

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

/** Complete, unlike the canonical fixture's — see the `address_incomplete` case. */
const TO = {
  name: 'A Buyer',
  phone: '08031234567',
  line1: '1 Test Street',
  city: 'Wuse 2',
  region: 'FCT',
  postalCode: '900288',
  countryCode: 'NG',
};

const MUG = 'var_mug_navy';
const TEE = 'var_tee_m';

const courier = (id: string, path: string) => `/api/shop/admin/fulfillments/${id}/courier/${path}`;

interface Behaviour {
  quote?: QuoteResult;
  book?: BookingResult;
  track?: TrackResult;
  /** Thrown by every driven method — how a courier's refusal reaches a route. */
  fails?: LogisticsError;
}

/**
 * Every van this suite actually called off, in order.
 *
 * A COUNTER RATHER THAN A SPY BECAUSE THE ABSENCE IS THE ASSERTION: the bug
 * this pins is a cancel that reached the courier and then failed to record —
 * money spent and a collection stopped for a parcel already on its way.
 */
let cancelled: { ref: string; reason: string }[] = [];

function fakeProvider(id: ProviderId, b: Behaviour = {}): LogisticsProvider {
  const unused = (method: string) => (): never => {
    throw new Error(`fake ${id}: ${method} is not driven by this case`);
  };
  const answer = <T>(value: T | undefined, method: string): T => {
    if (b.fails) throw b.fails;
    if (value === undefined) throw new Error(`fake ${id}: ${method} is not driven by this case`);
    return value;
  };
  return {
    id,
    label: PROVIDER_LABEL[id],
    quote: async () => answer(b.quote, 'quote'),
    book: async () => answer(b.book, 'book'),
    track: async () => answer(b.track, 'track'),
    cancel: async (ref: string, reason: string) => {
      if (b.fails) throw b.fails;
      cancelled.push({ ref, reason });
    },
    registerWebhook: unused('registerWebhook'),
    parseWebhook: unused('parseWebhook'),
  };
}

const fakeCatalog = (weights: Record<string, number | null>): LogisticsCatalog => ({
  weightsFor: async (_db, ids) =>
    new Map(ids.filter((id) => id in weights).map((id) => [id, weights[id]])),
  weightCoverage: async () => ({ missing: 0, total: 0 }),
});

function wire(
  providers: Partial<Record<ProviderId, LogisticsProvider | null>>,
  weights: Record<string, number | null> = { [MUG]: 400, [TEE]: 250 },
): void {
  registerLogisticsDeps({ catalog: fakeCatalog(weights), providers, now: () => NOW });
}

async function settings(provider: 'manual' | ProviderId): Promise<void> {
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, ship_from, updated_at)
    VALUES ('main', ${provider}, ${JSON.stringify(SHIP_FROM)}::jsonb, ${SEEDED_AT})`);
}

async function paidOrder(address: Record<string, unknown> = TO): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted({ shippingAddress: address })]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** One parcel over the whole order, through Orders' own route. */
async function createParcel(order: OrderRead): Promise<string> {
  const res = await http.post(`/api/shop/admin/orders/${order.order.id}/fulfillments`, {
    lines: order.lines.map((line) => ({ orderLineId: line.id, qty: line.qty })),
  });
  expect(res.status).toBe(201);
  return (await json<{ fulfillment: { id: string } }>(res)).fulfillment.id;
}

interface ParcelJson {
  id: string;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  provider: string | null;
  providerRef: string | null;
  providerStatus: string | null;
  courierState: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  providerCostMinor: number | null;
  providerSyncedAt: number | null;
  providerLastError: string | null;
}

const FEZ_QUOTE: QuoteResult = {
  providerRef: null,
  weightKg: 2,
  note: '1 item has no weight; Fez will be told 1 kg',
  options: [
    {
      id: 'fez',
      carrier: 'Fez Delivery',
      label: 'Fez Delivery',
      amountMinor: 645_000,
      currency: 'NGN',
      eta: '1-2 days',
    },
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
  options: [
    { id: 'rate_a', carrier: 'DHL', label: 'DHL · Express', amountMinor: 900_000, currency: 'NGN' },
  ],
};

/** Fez wired and answering everything this suite drives; the default. */
const fezReady = () =>
  wire({
    fez: fakeProvider('fez', {
      quote: FEZ_QUOTE,
      book: FEZ_BOOKING,
      track: { rawStatus: 'Dispatched', state: 'in_transit', description: 'On the van' },
    }),
    terminal: null,
  });

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  http.clearCookies();
  cancelled = [];
  resetLogisticsDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await settings('manual');
});

afterEach(() => {
  resetLogisticsDeps();
});

/** A paid order with one parcel, the owner signed in. */
async function scene(address: Record<string, unknown> = TO) {
  await http.signIn({ email: 'owner@test.local' });
  const order = await paidOrder(address);
  return { order, parcel: await createParcel(order) };
}

// ======================================================================= quote

describe('POST courier/quote', () => {
  it('409 provider_manual while the shop still ships by hand', async () => {
    fezReady();
    const { parcel } = await scene();
    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'provider_manual' });
  });

  it('answers the spec shape once Fez is switched on', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      provider: 'fez',
      providerLabel: 'Fez Delivery',
      weightKg: 2,
      quoteRef: null,
      note: '1 item has no weight; Fez will be told 1 kg',
      options: FEZ_QUOTE.options,
      /* ALWAYS PRESENT, `[]` when every line has a weight — a client that had
         to tell absent from empty would tell them apart wrongly. */
      missingWeights: [],
    });
  });

  it('422 weights_missing for Terminal, naming the lines to fix', async () => {
    wire({ terminal: fakeProvider('terminal', { quote: TERMINAL_QUOTE }), fez: null }, {
      [MUG]: null,
      [TEE]: 250,
    });
    const { order, parcel } = await scene();
    await settings('terminal');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: 'weights_missing',
      lines: [
        {
          orderLineId: order.lines[0].id,
          variantId: MUG,
          sku: 'MUG-NAVY',
          title: 'Enamel Mug',
        },
      ],
    });
  });

  it('404 for a parcel that does not exist', async () => {
    fezReady();
    await http.signIn({ email: 'owner@test.local' });
    await settings('fez');
    const res = await http.post(courier('ful_nope', 'quote'));
    expect(res.status).toBe(404);
    /* The application's own error table, not a route that simply is not there
       — which is what this assertion is here to tell apart. */
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });

  it('409 already_booked once a courier holds it', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    expect((await http.post(courier(parcel, 'book'), { optionId: 'fez' })).status).toBe(200);

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'already_booked' });
  });
});

// ======================================================================== book

describe('POST courier/book', () => {
  it('200 { fulfillment } with every courier field on the parcel', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'book'), { optionId: 'fez' });
    expect(res.status).toBe(200);
    const body = await json<{ fulfillment: ParcelJson }>(res);
    expect(body.fulfillment).toMatchObject({
      id: parcel,
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
      providerLastError: null,
    });
  });

  it('a second book is 409 already_booked', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    expect((await http.post(courier(parcel, 'book'), { optionId: 'fez' })).status).toBe(200);

    const res = await http.post(courier(parcel, 'book'), { optionId: 'fez' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'already_booked' });
  });

  it('400 without an optionId — the body is wrong, not the state', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    expect((await http.post(courier(parcel, 'book'), {})).status).toBe(400);
    expect((await http.post(courier(parcel, 'book'), { optionId: 'fez', rate: 1 })).status).toBe(
      400,
    );
  });
});

// ============================================================ refresh / cancel

describe('POST courier/refresh', () => {
  it('applies what the courier says and ships the parcel', async () => {
    fezReady();
    const { order, parcel } = await scene();
    await settings('fez');
    await http.post(courier(parcel, 'book'), { optionId: 'fez' });

    const res = await http.post(courier(parcel, 'refresh'));
    expect(res.status).toBe(200);
    const body = await json<{
      fulfillment: ParcelJson;
      changed: boolean;
      transitioned: string | null;
    }>(res);
    expect(body).toMatchObject({ changed: true, transitioned: 'shipped' });
    expect(body.fulfillment).toMatchObject({ status: 'shipped', courierState: 'in_transit' });

    /* The customer heard about it through the ordinary shipment mail, with the
       courier's own tracking page in it. */
    const shipments = (await listIntents(ctx.db, order.order.id)).filter(
      (i) => i.kind === 'shipment',
    );
    expect(shipments).toHaveLength(1);
    expect(shipments[0].body).toContain('https://fezdelivery.co/track/ASAC1');
  });

  it('404 for a parcel with no courier booked on it', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    const res = await http.post(courier(parcel, 'refresh'));
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'gone' });
  });
});

describe('POST courier/cancel', () => {
  it('200 with courierState cancelled and the promises taken back', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    await http.post(courier(parcel, 'book'), { optionId: 'fez' });

    const res = await http.post(courier(parcel, 'cancel'), { reason: 'Address was wrong' });
    expect(res.status).toBe(200);
    const body = await json<{ fulfillment: ParcelJson }>(res);
    expect(body.fulfillment).toMatchObject({
      status: 'pending',
      courierState: 'cancelled',
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
    });
  });

  it('takes no body at all — the reason is optional, like every reason here', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    await http.post(courier(parcel, 'book'), { optionId: 'fez' });

    expect((await http.post(courier(parcel, 'cancel'))).status).toBe(200);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * THE PARCEL OUTRAN THE CANCEL — 409, AND THE VAN IS LEFT ALONE.
   *
   * The shipped bug had two halves and the second was the expensive one.
   * `cancelParcelCourier` called `provider.cancel()` FIRST and recorded
   * SECOND, and the recording guard is `status = 'pending'` — so a parcel a
   * webhook had just shipped produced: a real collection called off at the
   * courier, a customer already holding a shipment email quoting that
   * waybill, and an operator told `{"error":"internal"}`, i.e. that the
   * server had crashed and the cancel had probably not happened.
   *
   * `refresh` stands in for the webhook here: it is the same
   * `applyCourierUpdate`, so the parcel arrives at `shipped` by the exact
   * route a real Fez callback takes.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('409 already_shipped once the parcel has gone out, WITHOUT calling the courier off', async () => {
    fezReady();
    const { parcel } = await scene();
    await settings('fez');
    await http.post(courier(parcel, 'book'), { optionId: 'fez' });
    expect((await http.post(courier(parcel, 'refresh'))).status).toBe(200);

    const res = await http.post(courier(parcel, 'cancel'), { reason: 'Customer changed their mind' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'already_shipped' });
    expect(cancelled).toEqual([]);
  });
});

// ====================================================================== guards

describe('the guards', () => {
  it('a supply_chain teammate can book — these are ORDERS, not settings', async () => {
    fezReady();
    await http.signIn({ email: 'owner@test.local' });
    const order = await paidOrder();
    const parcel = await createParcel(order);
    await settings('fez');

    http.clearCookies();
    await http.signIn({ email: 'supply@test.local' });
    expect((await http.post(courier(parcel, 'quote'))).status).toBe(200);
    expect((await http.post(courier(parcel, 'book'), { optionId: 'fez' })).status).toBe(200);
  });

  it('a writer gets 403, and no session at all gets 401', async () => {
    fezReady();
    await http.signIn({ email: 'owner@test.local' });
    const order = await paidOrder();
    const parcel = await createParcel(order);
    await settings('fez');

    http.clearCookies();
    expect((await http.post(courier(parcel, 'quote'))).status).toBe(401);

    await http.signIn({ email: 'writer@test.local' });
    for (const path of ['quote', 'book', 'refresh', 'cancel']) {
      const res = await http.post(courier(parcel, path), { optionId: 'fez' });
      expect(res.status, path).toBe(403);
    }
  });
});

// ============================================= how a courier's failure arrives

describe('a courier that will not play', () => {
  const failing = (err: LogisticsError) =>
    wire({ fez: fakeProvider('fez', { fails: err }), terminal: null });

  it('a refusal is 422 provider_rejected, carrying the courier own words', async () => {
    failing(new LogisticsError('provider_rejected', 'Invalid state'));
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: 'provider_rejected',
      message: 'Invalid state',
    });
  });

  it('an outage is 502 provider_error — the one answer worth retrying', async () => {
    failing(new LogisticsError('provider_unavailable', 'Fez timed out'));
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: 'provider_error', message: 'Fez timed out' });
  });

  it('missing credentials on the adapter itself are 409 provider_not_configured', async () => {
    failing(new LogisticsError('not_configured', 'FEZ_SECRET_KEY is not set'));
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'provider_not_configured' });
  });

  it('an address a courier cannot collect at is 422 address_incomplete, naming the fields', async () => {
    fezReady();
    /* The canonical fixture: no city. Refused BEFORE the courier is called. */
    const { parcel } = await scene({ name: 'A Buyer', line1: '1 Test Street', country: 'GB' });
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: 'address_incomplete',
      missing: ['city'],
    });
  });

  it('a courier this deployment has no credentials for is 409, before anything is asked', async () => {
    wire({ fez: null, terminal: null });
    const { parcel } = await scene();
    await settings('fez');

    const res = await http.post(courier(parcel, 'quote'));
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'provider_not_configured' });
  });
});
