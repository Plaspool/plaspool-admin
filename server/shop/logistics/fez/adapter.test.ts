import { describe, expect, it } from 'vitest';
import type { FezEnv } from '../config';
import { LogisticsError } from '../port';
import type { ParcelInput, ParcelLine, QuoteOption, ShipFrom } from '../port';
import { createFezProvider } from './adapter';

/**
 * The Fez adapter, against a stubbed `fetch`. Every case asserts path, method,
 * headers and body key by key rather than snapshotting the whole call, so a
 * failure names the one field that moved.
 */

const ENV: FezEnv = { userId: 'G-1', password: 'sekrit', secretKey: 'env-secret-key', baseUrl: 'https://fez.test/v1' };

interface QueuedOk { status: number; json: unknown }
interface QueuedThrow { throwError: Error }
type Queued = QueuedOk | QueuedThrow;

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A queue of canned `Response`s (or thrown errors), and a recorder of every call made against it. */
function fezFetch(responses: Queued[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    const next = responses[i];
    i += 1;
    if (!next) throw new Error(`fezFetch: no response queued for call #${i} (${String(input)})`);
    if ('throwError' in next) throw next.throwError;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A successful `/user/authenticate` response. */
function AUTH_OK(token = 'tok-abc123', secretKey: string | null = 'org-secret-key'): QueuedOk {
  return {
    status: 200,
    json: {
      authDetails: { authToken: token, expireToken: '2099-01-01 00:00:00' },
      orgDetails: secretKey === null ? {} : { 'secret-key': secretKey },
    },
  };
}

/** The `LogisticsError` a promise rejected with. */
async function failureOf(promise: Promise<unknown>): Promise<LogisticsError> {
  try {
    await promise;
  } catch (err) {
    return err as LogisticsError;
  }
  throw new Error('expected the call to reject, and it resolved');
}

const DEFAULT_TO = {
  name: 'Jane Doe', phone: '+2348012345678', email: null as string | null,
  line1: '1 Test Close', line2: 'Flat 2' as string | null, city: 'Gwarinpa',
  region: 'Abuja', postalCode: null as string | null, countryCode: 'NG',
  /* Fez never reads this — see the `routing city` suite at the foot of this
     file for why that is deliberate rather than an omission. */
  routingCity: null as string | null,
};

function item(o: Partial<ParcelLine> = {}): ParcelLine {
  return { orderLineId: 'oln_1', variantId: 'var_1', title: 'Test Widget', sku: 'SKU-1', qty: 1, unitMinor: 500000, weightGrams: 500, ...o };
}

function shipFrom(o: Partial<ShipFrom> = {}): ShipFrom {
  return { name: 'Plaspool Warehouse', phone: '+2348000000000', line1: '10 Warehouse Row', city: 'Ikeja', region: 'Lagos', postalCode: '100001', countryCode: 'NG', ...o };
}

function parcel(o: { to?: Partial<typeof DEFAULT_TO>; from?: ShipFrom | null; items?: ParcelLine[]; fulfillmentId?: string; orderNumber?: string } = {}): ParcelInput {
  return {
    fulfillmentId: o.fulfillmentId ?? 'fulfillment-1',
    orderNumber: o.orderNumber ?? 'ORD-100',
    to: { ...DEFAULT_TO, ...o.to },
    from: o.from === undefined ? null : o.from,
    items: o.items ?? [item()],
    valueMinor: 500000,
    packaging: { name: 'Spool box', lengthCm: 22, widthCm: 22, heightCm: 8, weightKg: 0.25 },
    packagingRef: null,
  };
}

const CHOSEN: QuoteOption = { id: 'fez', carrier: 'Fez Delivery', label: 'Fez Delivery', amountMinor: 645000, currency: 'NGN' };

describe('quote', () => {
  it('authenticates, then prices and estimates a delivery', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { totalCost: 6450 } },
      { status: 200, json: { data: { eta: '2 - 5 day(s)' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel({ from: shipFrom() }));

    expect(calls[0]!.url).toBe('https://fez.test/v1/user/authenticate');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ user_id: 'G-1', password: 'sekrit' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['secret-key']).toBeUndefined();

    expect(calls[1]!.url).toBe('https://fez.test/v1/order/cost');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({ state: 'FCT', weight: 1, pickUpState: 'Lagos' });
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-abc123');
    expect(calls[1]!.headers['secret-key']).toBe('env-secret-key');

    expect(calls[2]!.url).toBe('https://fez.test/v1/delivery-time-estimate');
    expect(calls[2]!.method).toBe('POST');
    expect(calls[2]!.body).toEqual({ delivery_type: 'local', pick_up_state: 'Lagos', drop_off_state: 'FCT' });

    expect(result).toEqual({
      providerRef: null,
      weightKg: 1,
      options: [{ id: 'fez', carrier: 'Fez Delivery', label: 'Fez Delivery', amountMinor: 645000, currency: 'NGN', eta: '2 - 5 day(s)' }],
      note: null,
    });
  });

  it('omits pickUpState and pick_up_state when there is no ship-from address', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { totalCost: 3000 } },
      { status: 200, json: { data: { eta: '1 - 2 day(s)' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    await provider.quote(parcel());

    expect(calls[1]!.body).toEqual({ state: 'FCT', weight: 1 });
    expect(calls[2]!.body).toEqual({ delivery_type: 'local', drop_off_state: 'FCT' });
  });

  it('warns about missing weights but still quotes at the 1 kg floor', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { totalCost: 3000 } },
      { status: 200, json: { data: { eta: '1 - 2 day(s)' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const items = [
      item({ orderLineId: 'oln_1', variantId: 'var_1', weightGrams: null }),
      item({ orderLineId: 'oln_2', variantId: 'var_2', weightGrams: null }),
    ];
    const result = await provider.quote(parcel({ items }));

    expect(result.weightKg).toBe(1);
    expect(result.note).toBe('2 items have no weight; Fez will be told 1 kg');
  });

  it('does not fail the quote when the ETA call fails', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { totalCost: 3000 } },
      { status: 500, json: {} },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel());

    expect(result.options[0]!.amountMinor).toBe(300000);
    expect(result.options[0]!.eta).toBeUndefined();
  });
});

describe('book', () => {
  it('books a parcel and fetches its manifest URL', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { orderNos: { 'fulfillment-1': 'ASAC1' } } },
      { status: 200, json: { data: { url: 'https://cdn.fezdelivery.co/manifest.pdf' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const input = parcel({ from: shipFrom(), to: { email: 'jane@example.com' } });
    const result = await provider.book(input, 'fez', null, CHOSEN);

    expect(calls[1]!.url).toBe('https://fez.test/v1/order');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual([{
      recipientAddress: '1 Test Close, Flat 2, Gwarinpa',
      recipientState: 'FCT',
      recipientName: 'Jane Doe',
      recipientPhone: '+2348012345678',
      recipientEmail: 'jane@example.com',
      uniqueID: 'fulfillment-1',
      BatchID: 'ORD-100',
      itemDescription: '1× Test Widget',
      valueOfItem: '5000',
      weight: 1,
      fragile: false,
      pickUpAddress: '10 Warehouse Row, Ikeja',
      pickUpState: 'Lagos',
    }]);

    expect(calls[2]!.url).toBe('https://fez.test/v1/orders/ASAC1/manifest-url');
    expect(calls[2]!.method).toBe('GET');

    expect(result).toEqual({
      providerRef: 'ASAC1',
      carrier: 'Fez Delivery',
      trackingNumber: 'ASAC1',
      trackingUrl: null,
      labelUrl: 'https://cdn.fezdelivery.co/manifest.pdf',
      costMinor: 645000,
      rawStatus: 'Pending Pick-Up',
      state: 'booked',
    });
  });

  it('omits recipientEmail and the pick-up fields when they are absent', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { orderNos: { 'fulfillment-1': 'ASAC1' } } },
      { status: 404, json: {} },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'fez', null, CHOSEN);

    expect(calls[1]!.body).not.toHaveProperty('recipientEmail');
    expect(calls[1]!.body).not.toHaveProperty('pickUpAddress');
    expect(calls[1]!.body).not.toHaveProperty('pickUpState');
    expect(result.labelUrl).toBeNull();
    expect(result.providerRef).toBe('ASAC1');
  });

  it('books with no chosen option, leaving costMinor null', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { orderNos: { 'fulfillment-1': 'ASAC1' } } },
      { status: 404, json: {} },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'fez', null, null);
    expect(result.costMinor).toBeNull();
  });

  /**
   * `orderNos` IS KEYED BY THE uniqueID WE SENT, and reading it any other way
   * is how a parcel ends up permanently carrying somebody else's waybill —
   * `providerRef` and `trackingNumber` are both taken from it, so a wrong one
   * is the reference we later track, cancel and match webhooks by, and the
   * number the customer is mailed.
   */
  it('refuses an orderNos that answers under a key other than the uniqueID we sent', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { orderNos: { 'someone-elses-id': 'WRONG' } } },
    ]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).book(parcel(), 'fez', null, CHOSEN));
    expect(err).toBeInstanceOf(LogisticsError);
    expect(err.code).toBe('bad_response');
    expect(err.message).toContain('fulfillment-1');
    // What Fez actually said is kept for whoever looks; none of it becomes this parcel's reference.
    expect(err.detail).toEqual({ orderNos: { 'someone-elses-id': 'WRONG' } });
  });

  it('refuses an empty orderNos', async () => {
    const { fetchImpl } = fezFetch([AUTH_OK(), { status: 200, json: { orderNos: {} } }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).book(parcel(), 'fez', null, CHOSEN));
    expect(err.code).toBe('bad_response');
  });
});

describe('token caching', () => {
  it('reuses a cached token across two operations', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { totalCost: 1000 } },
      { status: 200, json: { data: { eta: '1 day' } } },
      { status: 200, json: { totalCost: 1000 } },
      { status: 200, json: { data: { eta: '1 day' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    await provider.quote(parcel());
    await provider.quote(parcel());

    expect(calls.filter((c) => c.url.endsWith('/user/authenticate'))).toHaveLength(1);
  });

  it('re-authenticates once after a 401 and retries the request', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK('tok-1'),
      { status: 401, json: { description: 'Token expired' } },
      AUTH_OK('tok-2'),
      { status: 200, json: { totalCost: 1000 } },
      { status: 200, json: { data: { eta: '1 day' } } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel());

    expect(result.options[0]!.amountMinor).toBe(100000);
    expect(calls.filter((c) => c.url.endsWith('/user/authenticate'))).toHaveLength(2);
    const costCalls = calls.filter((c) => c.url.endsWith('/order/cost'));
    expect(costCalls).toHaveLength(2);
    expect(costCalls[1]!.headers.authorization).toBe('Bearer tok-2');
  });

  it('surfaces a second consecutive 401 as provider_rejected', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK('tok-1'),
      { status: 401, json: { description: 'Token expired' } },
      AUTH_OK('tok-2'),
      { status: 401, json: { description: 'Token expired' } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const err = await failureOf(provider.quote(parcel()));

    expect(err.code).toBe('provider_rejected');
    expect(err.status).toBe(401);
  });
});

describe('error mapping', () => {
  it('maps a 400 with a description onto provider_rejected, carrying the message', async () => {
    const { fetchImpl } = fezFetch([AUTH_OK(), { status: 400, json: { description: 'Invalid state' } }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).quote(parcel()));
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Invalid state');
  });

  it('maps a 503 onto provider_unavailable', async () => {
    const { fetchImpl } = fezFetch([AUTH_OK(), { status: 503, json: {} }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).quote(parcel()));
    expect(err.code).toBe('provider_unavailable');
  });

  it('maps a thrown TimeoutError onto provider_unavailable', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { fetchImpl } = fezFetch([AUTH_OK(), { throwError: timeoutErr }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).quote(parcel()));
    expect(err.code).toBe('provider_unavailable');
  });

  it('maps a 200 with no orderNos onto bad_response', async () => {
    const { fetchImpl } = fezFetch([AUTH_OK(), { status: 200, json: { status: 'Success' } }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).book(parcel(), 'fez', null, CHOSEN));
    expect(err.code).toBe('bad_response');
  });
});

describe('track', () => {
  it('tracks a parcel by its provider reference', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { order: { orderStatus: 'Dispatched' }, history: [{ statusDescription: 'Rider en route to drop-off' }] } },
      { status: 404, json: {} },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });
    const result = await provider.track('ASAC1');

    expect(calls[1]!.url).toBe('https://fez.test/v1/order/track/ASAC1');
    expect(calls[1]!.method).toBe('GET');
    expect(result.rawStatus).toBe('Dispatched');
    expect(result.state).toBe('in_transit');
    expect(result.description).toBe('Rider en route to drop-off');
  });
});

describe('cancel', () => {
  it('sends the order number and a reason', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), { status: 200, json: {} }]);
    await createFezProvider(ENV, { fetchImpl }).cancel('ASAC1', 'Customer changed their mind');

    expect(calls[1]!.url).toBe('https://fez.test/v1/order/cancel');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({ orderNo: 'ASAC1', reason: 'Customer changed their mind' });
  });

  it('surfaces a 400 as provider_rejected', async () => {
    const { fetchImpl } = fezFetch([AUTH_OK(), { status: 400, json: { description: 'Already delivered' } }]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).cancel('ASAC1', 'Customer changed their mind'));
    expect(err.code).toBe('provider_rejected');
  });
});

describe('registerWebhook', () => {
  it('registers the callback URL', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), { status: 200, json: {} }]);
    await createFezProvider(ENV, { fetchImpl }).registerWebhook('https://admin.plaspool.com/api/shop/logistics/fez/webhook');

    expect(calls[1]!.url).toBe('https://fez.test/v1/webhooks/store');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({ webhook: 'https://admin.plaspool.com/api/shop/logistics/fez/webhook' });
  });
});

describe('secret key fallback', () => {
  it('falls back to the org secret key from the auth response when the environment has none', async () => {
    const envNoSecret: FezEnv = { ...ENV, secretKey: null };
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK('tok-1', 'org-secret-xyz'),
      { status: 200, json: { totalCost: 1000 } },
      { status: 200, json: { data: { eta: '1 day' } } },
    ]);
    const provider = createFezProvider(envNoSecret, { fetchImpl });
    await provider.quote(parcel());

    expect(calls[1]!.headers['secret-key']).toBe('org-secret-xyz');
  });
});

/**
 * The owner's test bench. Fez has no read-only endpoint that proves less, so
 * `ping` is a price — which is also the only call that exercises BOTH the
 * sign-in and the `secret-key` header in one round trip.
 */
describe('diagnostics', () => {
  it('reports the environment from the base URL it was built with', () => {
    expect(createFezProvider(ENV, {}).diagnostics!.environment).toBe('sandbox');
    expect(
      createFezProvider({ ...ENV, baseUrl: 'https://api.fezdelivery.co/v1' }, {}).diagnostics!
        .environment,
    ).toBe('live');
  });

  it('pings with a trivial priced state, and never hands back the sign-in body', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), { status: 200, json: { totalCost: 6450 } }]);
    const out = await createFezProvider(ENV, { fetchImpl }).diagnostics!.ping();

    expect(calls[1]!.url).toBe('https://fez.test/v1/order/cost');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({ state: 'Lagos', weight: 1 });
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-abc123');

    expect(out).toEqual({
      probe: 'POST /order/cost',
      state: 'Lagos',
      weightKg: 1,
      amountMinor: 645000,
    });
    /* `orgDetails['secret-key']` is a credential, and it reaches nothing here. */
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  /**
   * The refusal a connection check is actually for: the SIGN-IN is rejected, so
   * nothing after it is ever attempted. Fez's own words escape as a
   * `provider_rejected`, which is what puts them on the operator's screen
   * verbatim instead of behind "the courier failed".
   */
  it('lets a refused sign-in escape as the LogisticsError the caller classifies', async () => {
    const { fetchImpl, calls } = fezFetch([
      { status: 401, json: { description: 'Invalid user credentials' } },
    ]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).diagnostics!.ping());
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Invalid user credentials');
    /* Never reached `/order/cost`: there was nothing to price with. */
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://fez.test/v1/user/authenticate');
  });

  it('offers no webhook simulator, because Fez has none', () => {
    expect(createFezProvider(ENV, {}).diagnostics!.simulateWebhook).toBeUndefined();
  });
});

/**
 * THE PLACE LIST — states and nothing under them.
 *
 * Fez does not validate cities at all and takes a free-text address, so
 * `cities` is `null` rather than `{}`: "we enforce no city list" and "we
 * enforce a list that happens to be empty" send a storefront to opposite
 * behaviours, and only the first is true here.
 */
describe('places', () => {
  it('reads the states and answers no city list at all', async () => {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      {
        status: 200,
        json: {
          status: 'Success',
          states: [
            { id: 1, state: 'Kano' },
            { id: 25, state: 'Lagos' },
          ],
        },
      },
    ]);

    const out = await createFezProvider(ENV, { fetchImpl }).places!.list('NG');

    expect(calls[1]!.url).toBe('https://fez.test/v1/states');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-abc123');
    expect(out).toEqual({
      /* Fez's id is a NUMBER on the wire and a string here, because every code
         in a `PlaceList` is one — the cache column and the public payload do
         not get to hold two spellings of the same thing. */
      regions: [
        { name: 'Kano', code: '1' },
        { name: 'Lagos', code: '25' },
      ],
      cities: null,
    });
  });

  it('drops an entry with no state name rather than listing a blank', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { status: 'Success', states: [{ id: 1, state: '' }, { id: 2 }] } },
    ]);
    expect(await createFezProvider(ENV, { fetchImpl }).places!.list('NG')).toEqual({
      regions: [],
      cities: null,
    });
  });

  it('lets a refusal escape as the LogisticsError the caller classifies', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 403, json: { description: 'Not permitted' } },
    ]);
    const err = await failureOf(createFezProvider(ENV, { fetchImpl }).places!.list('NG'));
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Not permitted');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FEZ IS TOLD NOTHING ABOUT THE ROUTING CITY, AND THAT IS THE POINT.
 *
 * Fez validates no city at all — `recipientAddress` is free text and only
 * `recipientState` is checked against a list. So substituting the shopper's
 * picked zone into the line a RIDER READS would buy nothing and would cost
 * them the street they actually live on: "Maitama" instead of "Gwarinpa", for
 * a courier that was always going to accept "Gwarinpa".
 *
 * This suite exists so that nobody later "fixes" the asymmetry with Terminal
 * by making `oneLine()` prefer the routing value. The request must not move.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('routing city', () => {
  /** The `/order` body for a booking, with and without a picked zone. */
  async function orderBody(routingCity: string | null): Promise<unknown> {
    const { fetchImpl, calls } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { orderNos: { 'fulfillment-1': 'ASAC1' } } },
      { status: 200, json: { data: { url: 'https://cdn.fezdelivery.co/manifest.pdf' } } },
    ]);
    const input = parcel({ from: shipFrom(), to: { city: 'Gwarinpa', routingCity } });
    await createFezProvider(ENV, { fetchImpl }).book(input, 'fez', null, CHOSEN);
    return calls[1]!.body;
  }

  it('books byte-identically whether or not a zone was picked', async () => {
    const withZone = await orderBody('Maitama');
    const without = await orderBody(null);
    expect(JSON.stringify(withZone)).toBe(JSON.stringify(without));
  });

  it('keeps the customer’s own city in the line the rider reads', async () => {
    expect(await orderBody('Maitama')).toMatchObject([
      { recipientAddress: '1 Test Close, Flat 2, Gwarinpa', recipientState: 'FCT' },
    ]);
  });
});

/**
 * LOCKERS. The shapes here are the ones production actually answers, read off
 * the live API on 2026-09-09 rather than invented: Lagos has 9 lockers, the
 * FCT has 2, and a state Fez has built none in answers with the array empty
 * and BOTH caps absent — which is the case a fixture would never have thought
 * to include, and the one the storefront meets most often.
 */
describe('lockers', () => {
  const LAGOS_OK = {
    status: 200,
    json: {
      status: 'Success',
      Lockers: [
        { lockerID: '2100015344', lockerAddress: 'AP Filling Station, Admiralty Way, Lekki 1, Lagos' },
        { lockerID: '2100015345', lockerAddress: 'Ap Filling Station, Oniru, Lekki Phase 1, Lagos' },
      ],
      maxWeight: '5',
      maxValueOfItem: '100000',
    },
  };

  it('lists a state, and converts the caps Fez sends as quoted naira', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), LAGOS_OK]);
    const provider = createFezProvider(ENV, { fetchImpl });

    const out = await provider.lockers!.list('Lagos');

    expect(calls[1]?.url).toBe('https://fez.test/v1/Lockers/Lagos');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.headers['secret-key']).toBe('env-secret-key');
    expect(out.lockers).toEqual([
      { id: '2100015344', address: 'AP Filling Station, Admiralty Way, Lekki 1, Lagos' },
      { id: '2100015345', address: 'Ap Filling Station, Oniru, Lekki Phase 1, Lagos' },
    ]);
    /* Weight stays kilograms; value becomes MINOR units, so ₦100,000 is
       10,000,000 and a caller comparing against a cart total never has to
       remember which side of the wire it came from. */
    expect(out.maxWeightKg).toBe(5);
    expect(out.maxValueMinor).toBe(10_000_000);
  });

  it('sends the courier its own name for the capital, so Abuja reaches FCT', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), LAGOS_OK]);
    const provider = createFezProvider(ENV, { fetchImpl });

    await provider.lockers!.list('Abuja');

    /* The whole reason `fezStateName` is applied here: Terminal says Abuja,
       Fez says FCT, and a shopper's address may carry either. */
    expect(calls[1]?.url).toBe('https://fez.test/v1/Lockers/FCT');
  });

  it('answers a state with no lockers as an empty list, not a failure', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 200, json: { status: 'Success', Lockers: [] } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });

    const out = await provider.lockers!.list('Kano');

    expect(out.lockers).toEqual([]);
    /* NULL, NOT ZERO. Fez omits both caps for a state it has no lockers in,
       and a zero would read as "nothing may ever be sent", which would filter
       out every cart rather than simply offering no locker. */
    expect(out.maxWeightKg).toBeNull();
    expect(out.maxValueMinor).toBeNull();
  });

  it('drops a row missing either half, because neither can be used alone', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      {
        status: 200,
        json: {
          Lockers: [
            { lockerID: '1', lockerAddress: '   ' },
            { lockerAddress: 'An address nobody can book' },
            { lockerID: '2', lockerAddress: 'Usable' },
          ],
        },
      },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });

    expect((await provider.lockers!.list('Lagos')).lockers).toEqual([{ id: '2', address: 'Usable' }]);
  });

  it('escapes the state rather than pasting it into the path', async () => {
    const { fetchImpl, calls } = fezFetch([AUTH_OK(), { status: 200, json: { Lockers: [] } }]);
    const provider = createFezProvider(ENV, { fetchImpl });

    await provider.lockers!.list('Akwa Ibom');

    expect(calls[1]?.url).toBe('https://fez.test/v1/Lockers/Akwa%20Ibom');
  });

  it('lets a refusal out as a LogisticsError, like every other Fez call', async () => {
    const { fetchImpl } = fezFetch([
      AUTH_OK(),
      { status: 401, json: { status: 'Error', description: 'Organization Secret Key is Required' } },
    ]);
    const provider = createFezProvider(ENV, { fetchImpl });

    /* Two 401s: the client re-authenticates once and gives up on the second,
       so the queue running dry IS the second attempt. */
    await expect(provider.lockers!.list('Lagos')).rejects.toBeInstanceOf(LogisticsError);
  });
});
