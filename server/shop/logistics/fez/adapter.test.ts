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
