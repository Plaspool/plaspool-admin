import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { resetLogisticsEnv } from './config';
import { registerLogisticsDeps, resetLogisticsDeps } from './deps';
import { LogisticsError } from './port';
import type {
  LogisticsProvider,
  ParcelInput,
  ProviderDiagnostics,
  ProviderId,
  ProviderSimulateOutcome,
  QuoteResult,
  ShipFrom,
} from './port';

/**
 * `POST /admin/logistics/diagnostics`, driven through the REAL app — router,
 * origin guard, session middleware, the domain gate, `shopApp()`'s `onError`.
 *
 * THE POINT OF THE ENDPOINT IS THAT IT CANNOT FAIL. A courier refusing is what
 * the operator pressed the button to find out, so almost everything here
 * asserts a **200 carrying `ok: false`** — the four cases that are genuinely a
 * 4xx (unknown provider, one not configured, a missing ship-from, a check the
 * courier does not have) are the exceptions, and each is named below.
 *
 * The couriers themselves are fakes registered through `registerLogisticsDeps`,
 * so what is under test is the ROUTE and `diagnostics.ts`; the two adapters'
 * own wire shapes are pinned in `fez/adapter.test.ts` and
 * `terminal/adapter.test.ts` against a stubbed `fetch`.
 */

let ctx: TestCtx;
let http: HttpClient;

const NOW = 1_800_000_000_000;
const SEEDED_AT = 1_786_600_005_100;

const DIAGNOSTICS = '/api/shop/admin/logistics/diagnostics';
const SETTINGS = '/api/shop/admin/logistics/settings';

const SHIP_FROM: ShipFrom = {
  name: 'PlaSpool',
  phone: '08030000000',
  email: 'dispatch@plaspool.com',
  line1: '12 Aminu Kano Crescent',
  city: 'Wuse 2',
  region: 'Abuja',
  postalCode: '900288',
  countryCode: 'NG',
};

const TO = { line1: '1 Test Close', city: 'Gwarinpa', region: 'Abuja', postalCode: '900001' };

interface Envelope {
  check: string;
  ok: boolean;
  summary: string;
  detail?: Record<string, unknown>;
}

/** Every `ParcelInput` a fake courier was asked to quote, in order. */
let quoted: ParcelInput[] = [];

interface FakeOptions {
  environment?: 'sandbox' | 'live';
  ping?: () => Promise<Record<string, unknown>>;
  simulate?: (shipmentId: string) => Promise<ProviderSimulateOutcome>;
  quote?: (input: ParcelInput) => Promise<QuoteResult>;
  /** Drop the whole capability, as an adapter written before it would have. */
  noDiagnostics?: boolean;
}

/**
 * A courier that answers nothing it was not told to. Every method this suite
 * does not drive throws rather than returning a plausible shape, so a route
 * reaching for one by accident fails here instead of passing on invented data.
 */
function fakeProvider(id: ProviderId, o: FakeOptions = {}): LogisticsProvider {
  const unused = (method: string) => (): never => {
    throw new Error(`fake ${id}: ${method} is not driven by this suite`);
  };
  const diagnostics: ProviderDiagnostics = {
    environment: o.environment ?? 'sandbox',
    ping: o.ping ?? (async () => ({ probe: 'stub' })),
    ...(o.simulate ? { simulateWebhook: o.simulate } : {}),
  };
  return {
    id,
    label: id === 'fez' ? 'Fez Delivery' : 'Terminal Africa',
    quote: o.quote
      ? async (input: ParcelInput) => {
          quoted.push(input);
          return o.quote!(input);
        }
      : unused('quote'),
    book: unused('book'),
    track: unused('track'),
    cancel: unused('cancel'),
    registerWebhook: unused('registerWebhook'),
    parseWebhook: unused('parseWebhook'),
    ...(o.noDiagnostics ? {} : { diagnostics }),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
}

/**
 * Replace the global `fetch` so the webhook self-call is observable.
 *
 * IT HAS TO BE THE GLOBAL and not an injected seam: the whole value of that
 * check is that it leaves this process by the same door a courier's delivery
 * arrives at, so the thing under test is the real outbound call.
 */
function stubFetch(respond: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: unknown, init: RequestInit = {}): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? {}).forEach((value, key) => {
        headers[key] = value;
      });
      const call: RecordedCall = {
        url: String(input),
        method: init.method ?? 'GET',
        headers,
        body: typeof init.body === 'string' ? init.body : '',
        redirect: init.redirect,
      };
      calls.push(call);
      return respond(call);
    },
  );
  return calls;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function signInOwner(): Promise<void> {
  await http.signIn({ email: 'owner@test.local' });
}

/** Save a ship-from through the real settings route, as an operator would. */
async function saveShipFrom(): Promise<void> {
  const res = await http.patch(SETTINGS, { expectedRevision: 1, shipFrom: SHIP_FROM });
  expect(res.status).toBe(200);
}

async function packagingIdOnRow(): Promise<string | null> {
  const res = await ctx.db.execute(
    sql`SELECT terminal_packaging_id FROM shop_logistics_settings WHERE id = 'main'`,
  );
  const value = (res.rows[0] as Record<string, unknown> | undefined)?.terminal_packaging_id;
  return value == null ? null : String(value);
}

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  http.clearCookies();
  quoted = [];
  resetLogisticsDeps();
  registerLogisticsDeps({
    catalog: { weightsFor: async () => new Map(), weightCoverage: async () => ({ missing: 0, total: 0 }) },
    providers: { fez: fakeProvider('fez'), terminal: fakeProvider('terminal') },
    now: () => NOW,
  });
  await ctx.db.execute(sql`DELETE FROM shop_logistics_webhooks`);
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, updated_at)
    VALUES ('main', 'manual', ${SEEDED_AT})`);
});

/** The courier credentials a case may set; cleared so none leaks into the next. */
const ENV_KEYS = ['FEZ_USER_ID', 'FEZ_PASSWORD', 'FEZ_SECRET_KEY', 'TERMINAL_SECRET_KEY'];

afterEach(() => {
  vi.unstubAllGlobals();
  resetLogisticsDeps();
  for (const key of ENV_KEYS) delete process.env[key];
  resetLogisticsEnv();
});

describe('check: connection', () => {
  it('reports a courier that answers, naming the environment', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', {
          environment: 'sandbox',
          ping: async () => ({ probe: 'POST /order/cost', amountMinor: 645000 }),
        }),
        terminal: null,
      },
    });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'connection', provider: 'fez' });
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(body.check).toBe('connection');
    expect(body.ok).toBe(true);
    expect(body.summary).toContain('sandbox');
    expect(body.summary).toContain('Fez Delivery');
    expect(body.detail).toMatchObject({
      provider: 'fez',
      environment: 'sandbox',
      response: { probe: 'POST /order/cost', amountMinor: 645000 },
    });
  });

  /**
   * THE CASE THE ENDPOINT EXISTS FOR. A courier refusing our credentials is a
   * SUCCESSFUL diagnostic — the operator asked a question and got an answer —
   * so it is a 200 carrying their words, never a 502 the client retries five
   * times for a verdict that cannot change.
   */
  it('reports a courier that refuses as 200 ok:false, carrying its own message', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', {
          ping: () => {
            throw new LogisticsError('provider_rejected', 'Invalid user credentials', { status: 401 });
          },
        }),
        terminal: null,
      },
    });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'connection', provider: 'fez' });
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(false);
    expect(body.summary).toBe('Invalid user credentials');
    expect(body.detail).toMatchObject({ provider: 'fez', code: 'provider_rejected', status: 401 });
  });

  it('refuses a courier this deployment has no credentials for with 409', async () => {
    registerLogisticsDeps({ providers: { fez: fakeProvider('fez'), terminal: null } });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'connection', provider: 'terminal' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'provider_not_configured',
      provider: 'terminal',
    });
  });

  it('refuses an unknown courier and an unknown key with 400', async () => {
    await signInOwner();
    expect((await http.post(DIAGNOSTICS, { check: 'connection', provider: 'dhl' })).status).toBe(400);
    expect((await http.post(DIAGNOSTICS, { check: 'nonsense', provider: 'fez' })).status).toBe(400);
    expect(
      (await http.post(DIAGNOSTICS, { check: 'connection', provider: 'fez', extra: 1 })).status,
    ).toBe(400);
  });
});

describe('check: quote', () => {
  const OPTIONS: QuoteResult = {
    providerRef: 'SH-1',
    weightKg: 1.5,
    note: null,
    options: [
      { id: 'RT-1', carrier: 'DHL', label: 'DHL · Express', amountMinor: 785000, currency: 'NGN' },
      { id: 'RT-2', carrier: 'GIG Logistics', label: 'GIG Logistics', amountMinor: 367690, currency: 'NGN' },
    ],
    packagingRef: 'PA-9',
  };

  it('quotes a synthetic parcel off the saved ship-from and packaging', async () => {
    registerLogisticsDeps({
      providers: { fez: null, terminal: fakeProvider('terminal', { quote: async () => OPTIONS }) },
    });
    await signInOwner();
    await saveShipFrom();

    const res = await http.post(DIAGNOSTICS, {
      check: 'quote',
      provider: 'terminal',
      to: TO,
      weightGrams: 1500,
    });
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('2 options, cheapest ₦3,676.90 (GIG Logistics)');
    expect(body.detail).toMatchObject({
      provider: 'terminal',
      weightKg: 1.5,
      shipmentId: 'SH-1',
      options: OPTIONS.options,
    });

    /* The parcel the courier was handed: the SAVED address and box, a
       one-item ₦10,000 load at the weight asked for, and an id no real
       parcel can collide with. */
    expect(quoted).toHaveLength(1);
    const input = quoted[0]!;
    expect(input.from).toEqual(SHIP_FROM);
    expect(input.packaging).toEqual({
      name: 'Spool box',
      lengthCm: 22,
      widthCm: 22,
      heightCm: 8,
      weightKg: 0.25,
    });
    expect(input.to).toMatchObject({ line1: TO.line1, city: TO.city, region: TO.region, postalCode: TO.postalCode, countryCode: 'NG' });
    expect(input.items).toHaveLength(1);
    expect(input.items[0]!.weightGrams).toBe(1500);
    expect(input.valueMinor).toBe(1_000_000);
    expect(input.fulfillmentId).toMatch(/^diag_/);

    /* The one thing a diagnostic is allowed to persist. */
    expect(await packagingIdOnRow()).toBe('PA-9');
  });

  it('defaults the parcel to 1000 g when no weight is given', async () => {
    registerLogisticsDeps({
      providers: { fez: null, terminal: fakeProvider('terminal', { quote: async () => OPTIONS }) },
    });
    await signInOwner();
    await saveShipFrom();

    await http.post(DIAGNOSTICS, { check: 'quote', provider: 'terminal', to: TO });
    expect(quoted[0]!.items[0]!.weightGrams).toBe(1000);
  });

  /**
   * TERMINAL ONLY, exactly as the settings patch refuses it: Fez collects from
   * an address held in their own portal, so a Fez quote with no ship-from here
   * is an ordinary question with an ordinary answer.
   */
  it('refuses a Terminal quote with no ship-from saved, with 409 and the missing fields', async () => {
    registerLogisticsDeps({
      providers: { fez: null, terminal: fakeProvider('terminal', { quote: async () => OPTIONS }) },
    });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'quote', provider: 'terminal', to: TO });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'ship_from_incomplete' });
    expect((await json<{ missing: string[] }>(await http.post(DIAGNOSTICS, { check: 'quote', provider: 'terminal', to: TO }))).missing).toContain('line1');
    expect(quoted).toEqual([]);
  });

  it('lets a Fez quote through with no ship-from at all', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', {
          quote: async () => ({
            providerRef: null,
            weightKg: 1,
            note: null,
            options: [{ id: 'fez', carrier: 'Fez Delivery', label: 'Fez Delivery', amountMinor: 645000, currency: 'NGN' }],
          }),
        }),
        terminal: null,
      },
    });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'quote', provider: 'fez', to: TO });
    expect(res.status).toBe(200);
    const body = await json<Envelope>(res);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('1 option, cheapest ₦6,450.00 (Fez Delivery)');
    expect(quoted[0]!.from).toBeNull();
  });

  /**
   * THE REASON THIS CHECK IS WORTH A BUTTON. Terminal accepts 46 cities in
   * Lagos and 10 in Abuja, and refuses everything else — a real Abuja order is
   * usually refused. The operator has no way to discover which names are
   * acceptable except by failing a booking, so the courier's own words and its
   * own list come back verbatim.
   */
  it('reports a refused quote as 200 ok:false, with the message verbatim and the accepted names', async () => {
    registerLogisticsDeps({
      providers: {
        fez: null,
        terminal: fakeProvider('terminal', {
          quote: () => {
            throw new LogisticsError(
              'provider_rejected',
              'Delivery Address - Invalid city, please select a city from the list of cities',
              {
                status: 400,
                detail: {
                  status: false,
                  message: 'Delivery Address - Invalid city, please select a city from the list of cities',
                  data: [{ name: 'Abaji' }, { name: 'Bwari' }, { name: 'Gwagwalada' }],
                },
              },
            );
          },
        }),
      },
    });
    await signInOwner();
    await saveShipFrom();

    const res = await http.post(DIAGNOSTICS, { check: 'quote', provider: 'terminal', to: TO });
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(false);
    expect(body.summary).toBe(
      'Delivery Address - Invalid city, please select a city from the list of cities',
    );
    expect(body.detail).toMatchObject({
      provider: 'terminal',
      code: 'provider_rejected',
      status: 400,
      accepted: ['Abaji', 'Bwari', 'Gwagwalada'],
    });
  });

  /**
   * A failed quote can still have cost us a packaging record at Terminal, and
   * the quotes most likely to fail are exactly the ones an operator retries.
   */
  it('keeps a packaging record a failed quote left behind', async () => {
    registerLogisticsDeps({
      providers: {
        fez: null,
        terminal: fakeProvider('terminal', {
          quote: () => {
            const err = new LogisticsError('provider_rejected', 'Invalid state');
            err.packagingRef = 'PA-77';
            throw err;
          },
        }),
      },
    });
    await signInOwner();
    await saveShipFrom();

    const body = await json<Envelope>(
      await http.post(DIAGNOSTICS, { check: 'quote', provider: 'terminal', to: TO }),
    );
    expect(body.ok).toBe(false);
    expect(await packagingIdOnRow()).toBe('PA-77');
  });
});

describe('check: webhook_self_test', () => {
  const FEZ_KEY = 'fez-hook-secret';
  const TERMINAL_KEY = 'terminal-hook-secret';

  function wireFez(): void {
    process.env.FEZ_USER_ID = 'G-1';
    process.env.FEZ_PASSWORD = 'sekrit';
    process.env.FEZ_SECRET_KEY = FEZ_KEY;
    resetLogisticsEnv();
  }

  function wireTerminal(): void {
    process.env.TERMINAL_SECRET_KEY = TERMINAL_KEY;
    resetLogisticsEnv();
  }

  it('posts a correctly signed Fez update at our own webhook address', async () => {
    wireFez();
    const calls = stubFetch(() => jsonResponse(200, { ok: true, unmatched: true }));
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'webhook_self_test', provider: 'fez' });
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${TEST_ORIGIN}/api/shop/logistics/fez/webhook`);
    expect(call.method).toBe('POST');
    /* A redirect is somewhere else, and a signed body must never follow one. */
    expect(call.redirect).toBe('manual');

    const sent = JSON.parse(call.body) as { orderNumber: string; status: string };
    expect(sent.orderNumber).toMatch(/^DIAG-/);
    const ts = call.headers['x-timestamp']!;
    expect(ts).toBeTruthy();
    expect(call.headers['x-signature']).toBe(
      createHmac('sha256', FEZ_KEY).update(sent.orderNumber + sent.status + ts).digest('hex'),
    );

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe('Your webhook address accepted a correctly signed update.');
    expect(body.detail).toMatchObject({
      provider: 'fez',
      url: `${TEST_ORIGIN}/api/shop/logistics/fez/webhook`,
      status: 200,
    });
  });

  it('posts a correctly signed Terminal update, hashed over the exact bytes sent', async () => {
    wireTerminal();
    const calls = stubFetch(() => jsonResponse(200, { ok: true, unmatched: true }));
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'webhook_self_test', provider: 'terminal' });
    expect(res.status).toBe(200);

    const call = calls[0]!;
    expect(call.url).toBe(`${TEST_ORIGIN}/api/shop/logistics/terminal/webhook`);
    expect(call.headers['x-terminal-signature']).toBe(
      createHmac('sha512', TERMINAL_KEY).update(call.body).digest('hex'),
    );
    const sent = JSON.parse(call.body) as { event: string; data: { shipment_id: string } };
    expect(sent.event).toBe('shipment.updated');
    expect(sent.data.shipment_id).toMatch(/^DIAG-/);

    expect((await json<Envelope>(res)).ok).toBe(true);
  });

  it('reports a refusal at our own address as ok:false, naming the status and the code', async () => {
    wireFez();
    stubFetch(() => jsonResponse(401, { error: 'bad_signature' }));
    await signInOwner();

    const body = await json<Envelope>(
      await http.post(DIAGNOSTICS, { check: 'webhook_self_test', provider: 'fez' }),
    );
    expect(body.ok).toBe(false);
    expect(body.summary).toBe(
      'Your webhook address refused a correctly signed update (401 bad_signature).',
    );
  });

  /**
   * `configured` AND `webhookReady` ARE TWO DIFFERENT QUESTIONS for Fez, and
   * this is the one that turns on the second. Naming the variable is the whole
   * answer — attempting the call without it would sign with nothing and report
   * a 401 that means something else entirely.
   */
  it('names FEZ_SECRET_KEY rather than calling anybody when it is absent', async () => {
    process.env.FEZ_USER_ID = 'G-1';
    process.env.FEZ_PASSWORD = 'sekrit';
    resetLogisticsEnv();
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, { check: 'webhook_self_test', provider: 'fez' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(false);
    expect(body.summary).toContain('FEZ_SECRET_KEY');
    expect(body.detail).toMatchObject({ missing: 'FEZ_SECRET_KEY' });
  });
});

describe('check: provider_simulate', () => {
  /**
   * THE EVIDENCE FOR A SUPPORT TICKET. Terminal's `POST /webhooks/simulate`
   * answers "queued" and never delivers, and their own delivery log answers an
   * error — so both halves are reported, and `ok` turns on whether a delivery
   * was actually recorded rather than on whether the simulation was accepted.
   */
  it('reports both answers, and stays ok:false when the delivery log errors', async () => {
    registerLogisticsDeps({
      providers: {
        fez: null,
        terminal: fakeProvider('terminal', {
          simulate: async (shipmentId) => ({
            simulate: { ok: true, message: `queued for ${shipmentId}` },
            deliveries: { ok: false, message: 'An unknown error occurred, please try again', count: null },
          }),
        }),
      },
    });
    await signInOwner();

    const res = await http.post(DIAGNOSTICS, {
      check: 'provider_simulate',
      provider: 'terminal',
      shipmentId: 'SH-1',
    });
    expect(res.status).toBe(200);

    const body = await json<Envelope>(res);
    expect(body.ok).toBe(false);
    expect(body.summary).toContain('An unknown error occurred, please try again');
    expect(body.detail).toMatchObject({
      provider: 'terminal',
      shipmentId: 'SH-1',
      simulate: { ok: true, message: 'queued for SH-1' },
      deliveries: { ok: false, message: 'An unknown error occurred, please try again', count: null },
    });
  });

  it('is ok:true only when a delivery is actually recorded', async () => {
    registerLogisticsDeps({
      providers: {
        fez: null,
        terminal: fakeProvider('terminal', {
          simulate: async () => ({
            simulate: { ok: true, message: 'queued' },
            deliveries: { ok: true, message: 'ok', count: 1 },
          }),
        }),
      },
    });
    await signInOwner();

    const body = await json<Envelope>(
      await http.post(DIAGNOSTICS, { check: 'provider_simulate', provider: 'terminal', shipmentId: 'SH-1' }),
    );
    expect(body.ok).toBe(true);
    expect(body.summary).toContain('1');
  });

  /** Fez has no simulator, so asking for one is a malformed request. */
  it('refuses the check for Fez with 400 bad_request', async () => {
    await signInOwner();
    const res = await http.post(DIAGNOSTICS, {
      check: 'provider_simulate',
      provider: 'fez',
      shipmentId: 'SH-1',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request' });
  });

  it('says so rather than throwing when the wired courier cannot simulate', async () => {
    registerLogisticsDeps({
      providers: { fez: null, terminal: fakeProvider('terminal') },
    });
    await signInOwner();

    const body = await json<Envelope>(
      await http.post(DIAGNOSTICS, { check: 'provider_simulate', provider: 'terminal', shipmentId: 'SH-1' }),
    );
    expect(body.ok).toBe(false);
    expect(body.summary).toContain('cannot');
  });
});

describe('the guard', () => {
  it('a supply_chain user gets 403 on the whole endpoint', async () => {
    await http.signIn({ email: 'supply@test.local' });
    for (const body of [
      { check: 'connection', provider: 'fez' },
      { check: 'quote', provider: 'fez', to: TO },
      { check: 'webhook_self_test', provider: 'fez' },
      { check: 'provider_simulate', provider: 'terminal', shipmentId: 'SH-1' },
    ]) {
      expect((await http.post(DIAGNOSTICS, body)).status, JSON.stringify(body)).toBe(403);
    }
  });

  it('401s without a session', async () => {
    expect((await http.post(DIAGNOSTICS, { check: 'connection', provider: 'fez' })).status).toBe(401);
  });
});
