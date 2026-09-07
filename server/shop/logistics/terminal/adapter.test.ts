import { describe, expect, it } from 'vitest';
import type { TerminalEnv } from '../config';
import { TERMINAL_LIVE_URL } from '../config';
import { LogisticsError } from '../port';
import type { ParcelInput, ParcelLine, QuoteOption, ShipFrom } from '../port';
import { createTerminalProvider } from './adapter';

/**
 * The Terminal Africa adapter, against a stubbed `fetch`. Every case asserts
 * path, method, headers and body key by key rather than snapshotting the
 * whole call, so a failure names the one field that moved — the same
 * discipline `fez/adapter.test.ts` uses. Unlike Fez, Terminal has no sign-in
 * step: every call carries the same bearer secret key from the start.
 */

const ENV: TerminalEnv = { secretKey: 'sk_test_abc123', baseUrl: 'https://terminal.test/v1' };

interface QueuedOk { status: number; json: unknown }
interface QueuedThrow { throwError: Error }
type Queued = QueuedOk | QueuedThrow;

interface RecordedCall { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A queue of canned `Response`s (or thrown errors), and a recorder of every call made against it. */
function terminalFetch(responses: Queued[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    const next = responses[i];
    i += 1;
    if (!next) throw new Error(`terminalFetch: no response queued for call #${i} (${String(input)})`);
    if ('throwError' in next) throw next.throwError;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A successful envelope: `{ status: true, message, data }`. */
function OK(data: unknown, message = 'ok'): QueuedOk {
  return { status: 200, json: { status: true, message, data } };
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
  name: 'Jane Doe', phone: '+2348012345678' as string | null, email: null as string | null,
  line1: '1 Test Close', line2: 'Flat 2' as string | null, city: 'Gwarinpa',
  region: 'Abuja', postalCode: null as string | null, countryCode: 'NG',
};

function item(o: Partial<ParcelLine> = {}): ParcelLine {
  return { orderLineId: 'oln_1', variantId: 'var_1', title: 'Test Widget', sku: 'SKU-1', qty: 2, unitMinor: 250000, weightGrams: 500, ...o };
}

function shipFrom(o: Partial<ShipFrom> = {}): ShipFrom {
  return { name: 'Plaspool Warehouse', phone: '+2348000000000', email: 'ops@plaspool.com', line1: '10 Warehouse Row', city: 'Ikeja', region: 'Lagos', postalCode: '100001', countryCode: 'NG', ...o };
}

function parcel(o: {
  to?: Partial<typeof DEFAULT_TO>; from?: ShipFrom | null; items?: ParcelLine[];
  fulfillmentId?: string; orderNumber?: string; packagingRef?: string | null;
} = {}): ParcelInput {
  return {
    fulfillmentId: o.fulfillmentId ?? 'fulfillment-1',
    orderNumber: o.orderNumber ?? 'ORD-100',
    to: { ...DEFAULT_TO, ...o.to },
    from: o.from === undefined ? null : o.from,
    items: o.items ?? [item()],
    valueMinor: 500000,
    packaging: { name: 'Spool box', lengthCm: 22, widthCm: 22, heightCm: 8, weightKg: 0.25 },
    packagingRef: o.packagingRef === undefined ? null : o.packagingRef,
  };
}

const CHOSEN: QuoteOption = { id: 'RT-1', carrier: 'DHL', label: 'DHL · Express', amountMinor: 350000, currency: 'NGN' };

describe('quote', () => {
  it('creates packaging, then quick-ships the parcel, and lists rates', async () => {
    const { fetchImpl, calls } = terminalFetch([
      OK({ packaging_id: 'PA-1' }),
      OK({ shipment_id: 'SH-1' }),
      OK([
        { rate_id: 'RT-1', carrier_name: 'DHL', carrier_rate_description: 'Express', amount: 3500, delivery_time: '1 - 2 days', pickup_time: 'Today' },
        { rate_id: 'RT-2', carrier_name: 'GIG Logistics', carrier_rate_description: null, amount: 2200, delivery_time: '2 - 4 days', pickup_time: 'Tomorrow' },
      ]),
    ]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel({ from: shipFrom() }));

    expect(calls[0]!.url).toBe('https://terminal.test/v1/packaging');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ name: 'Spool box', type: 'box', height: 8, width: 22, length: 22, size_unit: 'cm', weight: 0.25, weight_unit: 'kg' });
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_abc123');

    expect(calls[1]!.url).toBe('https://terminal.test/v1/shipments/quick');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.body).toEqual({
      pickup_address: {
        first_name: 'Plaspool', last_name: 'Warehouse', email: 'ops@plaspool.com', phone: '+2348000000000',
        line1: '10 Warehouse Row', city: 'Ikeja', state: 'Lagos', country: 'NG', zip: '100001', is_residential: false,
      },
      delivery_address: {
        first_name: 'Jane', last_name: 'Doe', phone: '+2348012345678',
        line1: '1 Test Close', line2: 'Flat 2', city: 'Gwarinpa', state: 'Abuja', country: 'NG', zip: '900001', is_residential: true,
      },
      parcel: {
        description: 'Order ORD-100',
        items: [{ name: 'Test Widget', description: 'SKU-1', currency: 'NGN', value: 2500, quantity: 2, weight: 0.5 }],
        packaging: 'PA-1', weight_unit: 'kg',
      },
      shipment_purpose: 'commercial',
      metadata: { fulfillmentId: 'fulfillment-1', orderNumber: 'ORD-100' },
    });
    expect(calls[1]!.headers.authorization).toBe('Bearer sk_test_abc123');

    expect(calls[2]!.url).toBe('https://terminal.test/v1/rates/shipment?shipment_id=SH-1&currency=NGN');
    expect(calls[2]!.method).toBe('GET');
    expect(calls[2]!.headers.authorization).toBe('Bearer sk_test_abc123');

    expect(result).toEqual({
      providerRef: 'SH-1',
      options: [
        { id: 'RT-1', carrier: 'DHL', label: 'DHL · Express', amountMinor: 350000, currency: 'NGN', eta: '1 - 2 days', pickupEta: 'Today' },
        { id: 'RT-2', carrier: 'GIG Logistics', label: 'GIG Logistics', amountMinor: 220000, currency: 'NGN', eta: '2 - 4 days', pickupEta: 'Tomorrow' },
      ],
      weightKg: 1,
      note: null,
      packagingRef: 'PA-1',
    });
  });

  it('skips the packaging call when a packagingRef is already cached', async () => {
    const { fetchImpl, calls } = terminalFetch([
      OK({ shipment_id: 'SH-2' }),
      OK([{ rate_id: 'RT-3', carrier_name: 'DHL', amount: 1000, delivery_time: '1 day', pickup_time: 'Today' }]),
    ]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel({ from: shipFrom(), packagingRef: 'PA-9' }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://terminal.test/v1/shipments/quick');
    const body = calls[0]!.body as { parcel: { packaging: string } };
    expect(body.parcel.packaging).toBe('PA-9');
    expect(result.packagingRef).toBeUndefined();
    expect(result.providerRef).toBe('SH-2');
  });

  it('maps rates, drops any without a usable id or amount, and defaults an unnamed carrier', async () => {
    const { fetchImpl } = terminalFetch([
      OK({ shipment_id: 'SH-3' }),
      OK([
        { rate_id: 'RT-1', carrier_name: 'DHL', carrier_rate_description: 'Express', amount: 10, delivery_time: '1 day', pickup_time: 'Today' },
        { rate_id: null, carrier_name: 'Bad Rate', amount: 20 },
        { rate_id: 'RT-4', carrier_name: 'Bad Amount', amount: 'not-a-number' },
        { rate_id: 'RT-5', amount: 15 },
      ]),
    ]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel({ from: shipFrom(), packagingRef: 'PA-9' }));

    expect(result.options).toEqual([
      { id: 'RT-1', carrier: 'DHL', label: 'DHL · Express', amountMinor: 1000, currency: 'NGN', eta: '1 day', pickupEta: 'Today' },
      { id: 'RT-5', carrier: 'Courier', label: 'Courier', amountMinor: 1500, currency: 'NGN' },
    ]);
  });

  it('drops a rate with no usable price instead of offering it for free, but keeps a numeric-string or fractional one', async () => {
    const { fetchImpl } = terminalFetch([
      OK({ shipment_id: 'SH-6' }),
      OK([
        { rate_id: 'RT-1', carrier_name: 'DHL', amount: null },
        { rate_id: 'RT-2', carrier_name: 'DHL', amount: '' },
        { rate_id: 'RT-3', carrier_name: 'DHL', amount: false },
        { rate_id: 'RT-4', carrier_name: 'DHL', amount: [] },
        { rate_id: 'RT-5', carrier_name: 'DHL', amount: '3500' },
        { rate_id: 'RT-6', carrier_name: 'DHL', amount: 3500.5 },
      ]),
    ]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.quote(parcel({ from: shipFrom(), packagingRef: 'PA-9' }));

    expect(result.options.map((o) => o.id)).toEqual(['RT-5', 'RT-6']);
    expect(result.options[0]!.amountMinor).toBe(350000);
    expect(result.options[1]!.amountMinor).toBe(350050);
  });

  it('refuses to quote without a ship-from address', async () => {
    const { fetchImpl, calls } = terminalFetch([]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const err = await failureOf(provider.quote(parcel({ from: null })));
    expect(err.code).toBe('address_incomplete');
    expect(err.message).toBe('Terminal Africa needs a ship-from address');
    expect(calls).toHaveLength(0);
  });

  it('refuses to quote when an item has no weight, naming the item', async () => {
    const { fetchImpl, calls } = terminalFetch([]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const items = [item({ title: 'Mystery Item', weightGrams: null })];
    const err = await failureOf(provider.quote(parcel({ from: shipFrom(), items })));
    expect(err.code).toBe('address_incomplete');
    expect(err.message).toBe('Mystery Item has no weight');
    expect(calls).toHaveLength(0);
  });

  it('refuses to quote when the recipient has no usable phone number, before any request is made', async () => {
    const { fetchImpl, calls } = terminalFetch([]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const err = await failureOf(provider.quote(parcel({ from: shipFrom(), to: { phone: null } })));
    expect(err.code).toBe('address_incomplete');
    expect(err.message).toBe('Terminal Africa needs a phone number for Jane Doe');
    expect(calls).toHaveLength(0);
  });

  /**
   * A PACKAGING RECORD SURVIVES THE QUOTE THAT FAILED AFTER MAKING IT.
   *
   * The addresses are validated before `/packaging` precisely so a bad one
   * creates nothing — but `/shipments/quick` is where Terminal judges the
   * address it will actually deliver to, and that is past the point of no
   * return. Losing the id there meant every retry of the quote an operator is
   * most likely to retry minted another record at Terminal, forever.
   */
  it('carries the packaging id it just created out on the failure that followed', async () => {
    const { fetchImpl } = terminalFetch([
      OK({ packaging_id: 'PA-1' }),
      { status: 400, json: { status: false, message: 'Invalid recipient state' } },
    ]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).quote(parcel({ from: shipFrom() })));

    // The failure itself is untouched — same code, same message Terminal gave.
    expect(err).toBeInstanceOf(LogisticsError);
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Invalid recipient state');
    expect(err.packagingRef).toBe('PA-1');
  });

  it('claims no packaging id on a failure when the ref was already cached', async () => {
    const { fetchImpl, calls } = terminalFetch([
      { status: 400, json: { status: false, message: 'Invalid recipient state' } },
    ]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).quote(parcel({ from: shipFrom(), packagingRef: 'PA-9' })));

    expect(calls).toHaveLength(1); // no /packaging call: this quote created nothing
    expect(err.code).toBe('provider_rejected');
    expect(err.packagingRef).toBeUndefined();
  });
});

describe('book', () => {
  it('books the chosen rate and returns the label and tracking details', async () => {
    const { fetchImpl, calls } = terminalFetch([
      OK({
        shipment_id: 'SH-1', carrier: 'DHL', status: 'confirmed',
        extras: { tracking_number: 'TRK-1', tracking_url: 'https://track.terminal.africa/TRK-1', shipping_label_url: 'https://cdn.terminal.africa/label.pdf' },
      }),
    ]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel({ from: shipFrom() }), 'RT-1', 'SH-1', CHOSEN);

    expect(calls[0]!.url).toBe('https://terminal.test/v1/shipments/pickup');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ rate_id: 'RT-1', shipment_id: 'SH-1' });
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_abc123');

    expect(result).toEqual({
      providerRef: 'SH-1', carrier: 'DHL',
      trackingNumber: 'TRK-1', trackingUrl: 'https://track.terminal.africa/TRK-1', labelUrl: 'https://cdn.terminal.africa/label.pdf',
      costMinor: 350000, rawStatus: 'confirmed', state: 'booked',
    });
  });

  it('reads the carrier from an object when Terminal sends { name }', async () => {
    const { fetchImpl } = terminalFetch([OK({ shipment_id: 'SH-1', carrier: { name: 'GIG Logistics' }, status: 'confirmed', extras: {} })]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'RT-1', 'SH-1', CHOSEN);
    expect(result.carrier).toBe('GIG Logistics');
  });

  it("falls back to the chosen option's carrier when Terminal names none", async () => {
    const { fetchImpl } = terminalFetch([OK({ shipment_id: 'SH-1', status: 'confirmed', extras: {} })]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'RT-1', 'SH-1', CHOSEN);
    expect(result.carrier).toBe('DHL');
  });

  it('falls back to the top-level tracking number and the nested tracking url, and to the quote ref for the provider ref', async () => {
    const { fetchImpl } = terminalFetch([OK({
      carrier: 'DHL', status: 'confirmed',
      carrier_tracking_number: 'FALLBACK-NUM',
      extras: { carrier_tracking_url: 'https://fallback.example/track' },
    })]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'RT-1', 'SH-1', CHOSEN);
    expect(result.providerRef).toBe('SH-1');
    expect(result.trackingNumber).toBe('FALLBACK-NUM');
    expect(result.trackingUrl).toBe('https://fallback.example/track');
  });

  it("treats a freshly booked shipment reported as 'draft' as booked", async () => {
    const { fetchImpl } = terminalFetch([OK({ shipment_id: 'SH-1', carrier: 'DHL', status: 'draft', extras: {} })]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.book(parcel(), 'RT-1', 'SH-1', CHOSEN);
    expect(result.rawStatus).toBe('draft');
    expect(result.state).toBe('booked');
  });

  it('refuses to book without a quote reference', async () => {
    const { fetchImpl, calls } = terminalFetch([]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const err = await failureOf(provider.book(parcel(), 'RT-1', null, CHOSEN));
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Get a Terminal quote before booking');
    expect(calls).toHaveLength(0);
  });
});

describe('track', () => {
  it('tracks a parcel by its provider reference', async () => {
    const { fetchImpl, calls } = terminalFetch([OK({
      status: 'in-transit', carrier: 'DHL',
      events: [{ description: 'Left origin hub' }, { description: 'Arrived at destination hub' }],
      extras: { tracking_number: 'TRK-1', tracking_url: 'https://track.terminal.africa/TRK-1' },
    })]);
    const provider = createTerminalProvider(ENV, { fetchImpl });
    const result = await provider.track('SH-1');

    expect(calls[0]!.url).toBe('https://terminal.test/v1/shipments/track/SH-1');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_abc123');

    expect(result).toEqual({
      rawStatus: 'in-transit', state: 'in_transit', description: 'Arrived at destination hub',
      trackingNumber: 'TRK-1', trackingUrl: 'https://track.terminal.africa/TRK-1', labelUrl: null,
      carrier: 'DHL',
    });
  });

  it('surfaces a missing status as bad_response', async () => {
    const { fetchImpl } = terminalFetch([OK({})]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).track('SH-1'));
    expect(err.code).toBe('bad_response');
  });
});

describe('cancel', () => {
  it('cancels a shipment by id', async () => {
    const { fetchImpl, calls } = terminalFetch([OK({})]);
    await createTerminalProvider(ENV, { fetchImpl }).cancel('SH-1', 'Customer changed their mind');
    expect(calls[0]!.url).toBe('https://terminal.test/v1/shipments/cancel');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ shipment_id: 'SH-1' });
  });
});

describe('registerWebhook', () => {
  it('registers against the sandbox as a non-live webhook', async () => {
    const { fetchImpl, calls } = terminalFetch([OK({})]);
    await createTerminalProvider(ENV, { fetchImpl }).registerWebhook('https://admin.plaspool.com/api/shop/logistics/terminal/webhook');
    expect(calls[0]!.url).toBe('https://terminal.test/v1/webhooks');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      name: 'PlaSpool admin', url: 'https://admin.plaspool.com/api/shop/logistics/terminal/webhook',
      events: ['shipment.created', 'shipment.updated'], active: true, live: false,
    });
  });

  it('registers against the live host as a live webhook', async () => {
    const liveEnv: TerminalEnv = { secretKey: 'sk_live_xyz', baseUrl: TERMINAL_LIVE_URL };
    const { fetchImpl, calls } = terminalFetch([OK({})]);
    await createTerminalProvider(liveEnv, { fetchImpl }).registerWebhook('https://admin.plaspool.com/api/shop/logistics/terminal/webhook');
    expect(calls[0]!.body).toMatchObject({ live: true });
  });
});

describe('error mapping', () => {
  it('maps a 400 with a message onto provider_rejected, carrying the message', async () => {
    const { fetchImpl } = terminalFetch([{ status: 400, json: { status: false, message: 'Invalid address' } }]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).cancel('SH-1', 'reason'));
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Invalid address');
  });

  it('maps a 401 onto provider_rejected', async () => {
    const { fetchImpl } = terminalFetch([{ status: 401, json: { status: false, message: 'Unauthorized' } }]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).cancel('SH-1', 'reason'));
    expect(err.code).toBe('provider_rejected');
  });

  it('maps a 500 onto provider_unavailable', async () => {
    const { fetchImpl } = terminalFetch([{ status: 500, json: { status: false, message: 'Server error' } }]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).cancel('SH-1', 'reason'));
    expect(err.code).toBe('provider_unavailable');
  });

  it('maps a thrown TimeoutError onto provider_unavailable', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { fetchImpl } = terminalFetch([{ throwError: timeoutErr }]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).cancel('SH-1', 'reason'));
    expect(err.code).toBe('provider_unavailable');
  });

  it('maps a 200 with no packaging id onto bad_response', async () => {
    const { fetchImpl } = terminalFetch([OK({})]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).quote(parcel({ from: shipFrom() })));
    expect(err.code).toBe('bad_response');
  });

  it('maps a 200 with no shipment id onto bad_response', async () => {
    const { fetchImpl } = terminalFetch([OK({})]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).quote(parcel({ from: shipFrom(), packagingRef: 'PA-9' })));
    expect(err.code).toBe('bad_response');
  });
});

/**
 * The owner's test bench: the two calls `diagnostics.ts` cannot make for itself
 * because they need this client's credentials and base URL.
 */
describe('diagnostics', () => {
  it('reports the environment from the base URL it was built with', () => {
    expect(createTerminalProvider(ENV, {}).diagnostics!.environment).toBe('sandbox');
    expect(
      createTerminalProvider({ ...ENV, baseUrl: TERMINAL_LIVE_URL }, {}).diagnostics!.environment,
    ).toBe('live');
  });

  it('pings the webhook list, and reports the URLs registered over there', async () => {
    const { fetchImpl, calls } = terminalFetch([
      OK([
        { id: 'WH-1', url: 'https://admin.plaspool.com/api/shop/logistics/terminal/webhook', active: true },
        { id: 'WH-2', url: 'https://old.example/hook', active: false },
      ]),
    ]);
    const out = await createTerminalProvider(ENV, { fetchImpl }).diagnostics!.ping();

    expect(calls[0]!.url).toBe('https://terminal.test/v1/webhooks');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_abc123');
    expect(calls[0]!.body).toBeUndefined();

    expect(out).toEqual({
      probe: 'GET /webhooks',
      webhooks: 2,
      urls: [
        'https://admin.plaspool.com/api/shop/logistics/terminal/webhook',
        'https://old.example/hook',
      ],
    });
  });

  it('lets a refused ping escape as the LogisticsError the caller classifies', async () => {
    const { fetchImpl } = terminalFetch([{ status: 401, json: { status: false, message: 'Unauthorized' } }]);
    const err = await failureOf(createTerminalProvider(ENV, { fetchImpl }).diagnostics!.ping());
    expect(err.code).toBe('provider_rejected');
    expect(err.message).toBe('Unauthorized');
  });

  it('simulates, then reads the delivery log, and counts what came back', async () => {
    const { fetchImpl, calls } = terminalFetch([
      OK({ queued: true }, 'Webhook simulation queued'),
      OK([{ id: 'DL-1', response_code: 200 }], 'Deliveries retrieved'),
    ]);
    const out = await createTerminalProvider(ENV, { fetchImpl }).diagnostics!.simulateWebhook!('SH-1');

    expect(calls[0]!.url).toBe('https://terminal.test/v1/webhooks/simulate');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ event: 'shipment.updated', shipment_id: 'SH-1' });

    expect(calls[1]!.url).toBe('https://terminal.test/v1/webhooks/deliveries?shipment_id=SH-1');
    expect(calls[1]!.method).toBe('GET');

    expect(out).toEqual({
      simulate: { ok: true, message: 'Webhook simulation queued' },
      deliveries: { ok: true, message: 'Deliveries retrieved', count: 1 },
    });
  });

  /**
   * THE SANDBOX AS IT ACTUALLY BEHAVES, and the reason this check reports both
   * halves: the simulator answers "queued" and the delivery log answers an
   * error, so a call that threw on the second would lose the evidence.
   */
  it('reports a delivery log that errors WITHOUT throwing, keeping both answers', async () => {
    const { fetchImpl } = terminalFetch([
      OK({ queued: true }, 'Webhook simulation queued'),
      { status: 400, json: { status: false, message: 'An unknown error occurred, please try again' } },
    ]);
    const out = await createTerminalProvider(ENV, { fetchImpl }).diagnostics!.simulateWebhook!('SH-1');

    expect(out).toEqual({
      simulate: { ok: true, message: 'Webhook simulation queued' },
      deliveries: { ok: false, message: 'An unknown error occurred, please try again', count: null },
    });
  });

  /** The delivery log is where the truth is, so it is read even when the simulator refused. */
  it('still reads the delivery log when the simulation itself is refused', async () => {
    const { fetchImpl, calls } = terminalFetch([
      { status: 404, json: { status: false, message: 'Shipment not found' } },
      OK([], 'Deliveries retrieved'),
    ]);
    const out = await createTerminalProvider(ENV, { fetchImpl }).diagnostics!.simulateWebhook!('SH-9');

    expect(calls).toHaveLength(2);
    expect(out).toEqual({
      simulate: { ok: false, message: 'Shipment not found' },
      /* Zero and "we could not tell" are different findings — this is zero. */
      deliveries: { ok: true, message: 'Deliveries retrieved', count: 0 },
    });
  });

  it('counts null rather than zero when the log answers in a shape it cannot count', async () => {
    const { fetchImpl } = terminalFetch([
      OK({ queued: true }, 'queued'),
      OK({ pending: 'unknown' }, 'ok'),
    ]);
    const out = await createTerminalProvider(ENV, { fetchImpl }).diagnostics!.simulateWebhook!('SH-1');
    expect(out.deliveries.count).toBeNull();
  });
});
