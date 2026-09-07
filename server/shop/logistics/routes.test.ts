import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { DEFAULT_ADMIN_ORIGIN } from '../../admin-url';
import { registerLogisticsDeps, resetLogisticsDeps } from './deps';
import type { LogisticsCatalog } from './deps';
import { LogisticsError } from './port';
import type { LogisticsProvider, Packaging, ProviderId, ShipFrom } from './port';
import { logWebhook } from './repo';

/**
 * The courier settings surface, driven through the REAL app — router, origin
 * guard, session middleware, the domain gate, `shopApp()`'s `onError`.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, per CLAUDE.md §2: this row decides
 * whether a parcel is booked with a courier who will be paid for it, and a test
 * app that registers its own dependencies is exactly how an unwired composition
 * root stayed invisible for months here before.
 *
 * The fakes go in through the registry, so what is under test is the ROUTE.
 * `server/shop/composition.test.ts` registers nothing and is what proves
 * `shopApp()` actually wires the real catalog port.
 */

let ctx: TestCtx;
let http: HttpClient;

const NOW = 1_800_000_000_000;
const SEEDED_AT = 1_786_600_005_100;

const SETTINGS = '/api/shop/admin/logistics/settings';
const PROVIDER = '/api/shop/logistics/provider';
const REGISTER = '/api/shop/admin/logistics/webhooks/register';

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

interface ProviderStatus {
  configured: boolean;
  environment: 'sandbox' | 'live';
  webhookUrl: string;
}
interface SettingsView {
  provider: 'manual' | ProviderId;
  shipFrom: ShipFrom | null;
  packaging: Packaging;
  revision: number;
  providers: Record<ProviderId, ProviderStatus>;
  variantsMissingWeight: number;
  variantsTotal: number;
  recentWebhooks: { provider: ProviderId; applied: string }[];
}

/** Every `registerWebhook` any fake was asked to do, in order. */
let registered: { id: ProviderId; url: string }[] = [];

/**
 * A courier that answers nothing. Every method this suite does not drive throws
 * rather than returning a plausible shape, so a route reaching for one by
 * accident fails here instead of passing on invented data.
 */
function fakeProvider(id: ProviderId, onRegister?: (url: string) => void): LogisticsProvider {
  const unused = (method: string) => (): never => {
    throw new Error(`fake ${id}: ${method} is not driven by this suite`);
  };
  return {
    id,
    label: id,
    quote: unused('quote'),
    book: unused('book'),
    track: unused('track'),
    cancel: unused('cancel'),
    registerWebhook: async (url: string) => {
      registered.push({ id, url });
      onRegister?.(url);
    },
    parseWebhook: unused('parseWebhook'),
  };
}

const fakeCatalog = (coverage: { missing: number; total: number }): LogisticsCatalog => ({
  weightsFor: async () => new Map(),
  weightCoverage: async () => coverage,
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
  registered = [];
  resetLogisticsDeps();
  registerLogisticsDeps({
    catalog: fakeCatalog({ missing: 7, total: 12 }),
    /* Fez wired, Terminal explicitly absent — the two halves of "configured". */
    providers: { fez: fakeProvider('fez'), terminal: null },
    now: () => NOW,
  });
  await ctx.db.execute(sql`DELETE FROM shop_logistics_webhooks`);
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, updated_at)
    VALUES ('main', 'manual', ${SEEDED_AT})`);
});

afterEach(() => {
  /* So one case's fakes cannot answer the next suite's questions. */
  resetLogisticsDeps();
});

/** A GET carrying the allow-listed Origin, which is what a browser sends. */
const getAs = (path: string) => http.get(path, { headers: { origin: TEST_ORIGIN } });

describe('GET the settings', () => {
  it('answers the seeded row with provider status, webhook URLs and weight coverage', async () => {
    await http.signIn({ email: 'owner@test.local' });
    const res = await getAs(SETTINGS);
    expect(res.status).toBe(200);

    const body = await json<SettingsView>(res);
    expect(body.provider).toBe('manual');
    expect(body.shipFrom).toBeNull();
    expect(body.packaging).toEqual({
      name: 'Spool box',
      lengthCm: 22,
      widthCm: 22,
      heightCm: 8,
      weightKg: 0.25,
    });
    expect(body.revision).toBe(1);

    expect(body.providers.fez.configured).toBe(true);
    expect(body.providers.terminal.configured).toBe(false);
    /* No courier credentials in this environment, so both read as the sandbox —
     * which is the direction a forgotten variable must fail in. */
    expect(body.providers.fez.environment).toBe('sandbox');
    expect(body.providers.terminal.environment).toBe('sandbox');

    expect(body.providers.fez.webhookUrl).toBe(`${TEST_ORIGIN}/api/shop/logistics/fez/webhook`);
    expect(body.providers.terminal.webhookUrl).toBe(
      `${TEST_ORIGIN}/api/shop/logistics/terminal/webhook`,
    );

    expect(body.variantsMissingWeight).toBe(7);
    expect(body.variantsTotal).toBe(12);
    expect(body.recentWebhooks).toEqual([]);
  });

  it('falls back to the pinned admin origin when the request carries no allow-listed one', async () => {
    await http.signIn({ email: 'owner@test.local' });
    /* A URL a courier must be able to call cannot be built from an attacker's
     * `Host`, and an unlisted `Origin` is not evidence of anything. */
    const body = await json<SettingsView>(
      await http.get(SETTINGS, { headers: { origin: 'https://evil.example' } }),
    );
    expect(body.providers.fez.webhookUrl).toBe(
      `${DEFAULT_ADMIN_ORIGIN}/api/shop/logistics/fez/webhook`,
    );
  });

  it('shows the recent deliveries, newest first, without their payloads', async () => {
    await logWebhook(ctx.db, {
      provider: 'fez',
      providerRef: 'FEZ-1',
      rawStatus: 'PICKED UP',
      verified: true,
      applied: 'applied',
      payload: { secret: 'a customer address' },
      now: NOW,
    });
    await http.signIn({ email: 'owner@test.local' });
    const body = await json<SettingsView>(await getAs(SETTINGS));
    expect(body.recentWebhooks).toHaveLength(1);
    expect(body.recentWebhooks[0]).toMatchObject({ provider: 'fez', applied: 'applied' });
    expect(JSON.stringify(body.recentWebhooks)).not.toContain('customer address');
  });
});

describe('PATCH the settings', () => {
  const signInOwner = () => http.signIn({ email: 'owner@test.local' });

  it('needs expectedRevision and refuses a stale one with 409 stale_write', async () => {
    await signInOwner();
    expect((await http.patch(SETTINGS, { provider: 'fez' })).status).toBe(400);

    const res = await http.patch(SETTINGS, { expectedRevision: 9, provider: 'fez' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'stale_write', expected: 9, actual: 1 });
  });

  it('switches to fez with a ship-from address and bumps the revision', async () => {
    await signInOwner();
    const res = await http.patch(SETTINGS, {
      expectedRevision: 1,
      provider: 'fez',
      shipFrom: SHIP_FROM,
    });
    expect(res.status).toBe(200);

    const body = await json<SettingsView>(res);
    expect(body.provider).toBe('fez');
    expect(body.shipFrom).toEqual(SHIP_FROM);
    expect(body.revision).toBe(2);

    /* The row moved, at the injected clock and under the acting teammate. */
    const row = await ctx.db.execute(sql`
      SELECT provider, updated_at, updated_by FROM shop_logistics_settings WHERE id = 'main'`);
    expect(String(row.rows[0]!.provider)).toBe('fez');
    expect(Number(row.rows[0]!.updated_at)).toBe(NOW);
    expect(String(row.rows[0]!.updated_by)).toBe(ctx.users.owner.id);
  });

  it('refuses a provider that is not configured: 409 provider_not_configured', async () => {
    await signInOwner();
    const res = await http.patch(SETTINGS, {
      expectedRevision: 1,
      provider: 'terminal',
      shipFrom: SHIP_FROM,
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'provider_not_configured',
      provider: 'terminal',
    });
    /* Refused, not half-applied. */
    expect((await json<SettingsView>(await getAs(SETTINGS))).provider).toBe('manual');
  });

  it('refuses terminal while the ship-from is incomplete: 409 ship_from_incomplete', async () => {
    registerLogisticsDeps({
      providers: { fez: fakeProvider('fez'), terminal: fakeProvider('terminal') },
    });
    await signInOwner();

    const res = await http.patch(SETTINGS, { expectedRevision: 1, provider: 'terminal' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual(
      expect.objectContaining({
        error: 'ship_from_incomplete',
        /* NAMED, so the screen can point at the empty boxes instead of saying
         * "the address is incomplete" over a form with nine of them. */
        missing: ['name', 'phone', 'line1', 'city', 'region', 'postalCode'],
      }),
    );
  });

  it('refuses clearing the address while on terminal too', async () => {
    registerLogisticsDeps({
      providers: { fez: fakeProvider('fez'), terminal: fakeProvider('terminal') },
    });
    await signInOwner();

    const on = await http.patch(SETTINGS, {
      expectedRevision: 1,
      provider: 'terminal',
      shipFrom: SHIP_FROM,
    });
    expect(on.status).toBe(200);

    const res = await http.patch(SETTINGS, { expectedRevision: 2, shipFrom: null });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'ship_from_incomplete' });

    /* The address the courier collects from is still there. */
    expect((await json<SettingsView>(await getAs(SETTINGS))).shipFrom).toEqual(SHIP_FROM);
  });

  it('refuses a malformed ship-from before anything reaches the database', async () => {
    await signInOwner();
    /* Each of these is a 400 and not a 409: the body is wrong, not the state.
       The email case also proves the validator is not a no-op. */
    for (const shipFrom of [
      { ...SHIP_FROM, email: 'not-an-email' },
      { ...SHIP_FROM, countryCode: 'GH' },
      { ...SHIP_FROM, name: '' },
      { ...SHIP_FROM, nickname: 'the depot' },
    ]) {
      const res = await http.patch(SETTINGS, { expectedRevision: 1, shipFrom });
      expect(res.status, JSON.stringify(shipFrom)).toBe(400);
    }
    expect((await json<SettingsView>(await getAs(SETTINGS))).revision).toBe(1);
  });

  it('lets the same clear through once the courier is back to manual', async () => {
    await signInOwner();
    const on = await http.patch(SETTINGS, { expectedRevision: 1, shipFrom: SHIP_FROM });
    expect(on.status).toBe(200);
    const off = await http.patch(SETTINGS, { expectedRevision: 2, shipFrom: null });
    expect(off.status).toBe(200);
    expect((await json<SettingsView>(off)).shipFrom).toBeNull();
  });
});

describe('the guards', () => {
  it('a supply_chain user can read the provider but gets 403 on the settings routes', async () => {
    await http.signIn({ email: 'supply@test.local' });
    expect((await getAs(PROVIDER)).status).toBe(200);
    expect((await getAs(SETTINGS)).status).toBe(403);
    expect((await http.patch(SETTINGS, { expectedRevision: 1, provider: 'fez' })).status).toBe(403);
    expect((await http.post(REGISTER, { provider: 'fez' })).status).toBe(403);
  });

  it('GET the provider answers { provider, label } and 401s without a session', async () => {
    expect((await getAs(PROVIDER)).status).toBe(401);

    await http.signIn({ email: 'writer@test.local' });
    expect(await json(await getAs(PROVIDER))).toMatchObject({
      provider: 'manual',
      label: 'By hand',
    });

    http.clearCookies();
    await http.signIn({ email: 'owner@test.local' });
    await http.patch(SETTINGS, { expectedRevision: 1, provider: 'fez', shipFrom: SHIP_FROM });
    expect(await json(await getAs(PROVIDER))).toMatchObject({
      provider: 'fez',
      label: 'Fez Delivery',
    });
  });
});

describe('POST webhooks/register', () => {
  it('calls the provider with the webhook URL this admin is reachable at', async () => {
    await http.signIn({ email: 'owner@test.local' });
    const res = await http.post(REGISTER, { provider: 'fez' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });
    expect(registered).toEqual([
      { id: 'fez', url: `${TEST_ORIGIN}/api/shop/logistics/fez/webhook` },
    ]);
  });

  it('refuses a courier that is not configured, and never calls anybody', async () => {
    await http.signIn({ email: 'owner@test.local' });
    const res = await http.post(REGISTER, { provider: 'terminal' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'provider_not_configured',
      provider: 'terminal',
    });
    expect(registered).toEqual([]);
  });

  it('reports a courier that refuses as 502 provider_error, not a 500', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', () => {
          throw new LogisticsError('provider_unavailable', 'Fez said no');
        }),
        terminal: null,
      },
    });
    await http.signIn({ email: 'owner@test.local' });
    const res = await http.post(REGISTER, { provider: 'fez' });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ error: 'provider_error' });
  });

  /**
   * A REFUSAL AND AN OUTAGE ARE NOT THE SAME ANSWER, and 502 says the second.
   *
   * `provider_rejected` is the courier reading our request and declining it —
   * an unreachable callback URL, an account not enabled for webhooks. Retrying
   * that produces the identical refusal forever, and the operator needs to read
   * WHAT the courier said, not "the other end failed". 422 is the code this
   * project already spends on exactly that (global constraints' error table),
   * and it is the code the booking routes use for the same class of answer.
   */
  it('reports a courier that REFUSED the URL as 422 provider_rejected', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', () => {
          throw new LogisticsError('provider_rejected', 'Fez will not call a .test host');
        }),
        terminal: null,
      },
    });
    await http.signIn({ email: 'owner@test.local' });
    const res = await http.post(REGISTER, { provider: 'fez' });
    expect(res.status).toBe(422);
    /* The courier's own words reach the screen. A generic message here is a
     * support ticket that starts with "it just says provider error". */
    expect(await json(res)).toMatchObject({
      error: 'provider_rejected',
      message: 'Fez will not call a .test host',
    });
  });

  /**
   * The adapter is registered but its OWN credentials are gone — a different
   * failure from `providerFor` answering null, arriving later and through the
   * throw rather than the guard. Same cause, so the same 409 and the same body:
   * an operator must not have to learn that two spellings of "this deployment
   * has no Fez credentials" mean one thing.
   */
  it('reports missing credentials as 409 provider_not_configured, not a 502', async () => {
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', () => {
          throw new LogisticsError('not_configured', 'FEZ_SECRET_KEY is not set');
        }),
        terminal: null,
      },
    });
    await http.signIn({ email: 'owner@test.local' });
    const res = await http.post(REGISTER, { provider: 'fez' });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: 'provider_not_configured', provider: 'fez' });
  });

  it('refuses a body naming manual, which is not a courier at all', async () => {
    await http.signIn({ email: 'owner@test.local' });
    expect((await http.post(REGISTER, { provider: 'manual' })).status).toBe(400);
  });
});
