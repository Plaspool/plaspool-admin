import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, SEED_PASSWORD } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { httpClient, json } from '../../../test/http';
import type { HttpClient } from '../../../test/http';

/**
 * Admin CRUD for shipping zones (migration 0240, admin#19), driven through the
 * real app — router, origin guard, session middleware, `shopApp()`'s `onError`.
 */

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

async function login(): Promise<void> {
  const res = await http.post('/api/auth/login', {
    email: 'owner@test.local',
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
}

describe('GET /admin/shipping-zones', () => {
  it('401s without a session', async () => {
    const res = await http.get('/api/shop/admin/shipping-zones');
    expect(res.status).toBe(401);
  });

  it('lists the seeded Nigerian zones with their options', async () => {
    await login();
    const res = await http.get('/api/shop/admin/shipping-zones');
    expect(res.status).toBe(200);
    const body = await json<{ items: Array<{ id: string; options: unknown[] }> }>(res);
    expect(body.items.map((z) => z.id).sort()).toEqual([
      'zone_abuja',
      'zone_lagos',
      'zone_rest_of_nigeria',
    ]);
    for (const zone of body.items) {
      expect(zone.options).toHaveLength(1);
    }
  });
});

describe('shipping zone CRUD', () => {
  it('creates, updates and deletes a zone (auth-gated, success path)', async () => {
    await login();

    const createRes = await http.post('/api/shop/admin/shipping-zones', {
      label: 'Test Zone',
      countries: ['NG'],
      regions: ['Kaduna'],
      taxRateBps: 0,
      taxLabel: 'No tax charged',
      shippingTaxable: false,
      isFallback: false,
      position: 10,
    });
    expect(createRes.status).toBe(201);
    const created = (await json<{ zone: { id: string; label: string } }>(createRes)).zone;
    expect(created.label).toBe('Test Zone');

    const patchRes = await http.patch(`/api/shop/admin/shipping-zones/${created.id}`, {
      label: 'Renamed Zone',
    });
    expect(patchRes.status).toBe(200);
    const patched = (await json<{ zone: { label: string } }>(patchRes)).zone;
    expect(patched.label).toBe('Renamed Zone');

    const deleteRes = await http.del(`/api/shop/admin/shipping-zones/${created.id}`);
    expect(deleteRes.status).toBe(200);
  });

  it('POST /admin/shipping-zones 401s without a session', async () => {
    const anon = httpClient(ctx.db);
    const res = await anon.post('/api/shop/admin/shipping-zones', {
      label: 'Nope',
      countries: [],
      regions: [],
      taxRateBps: 0,
      taxLabel: '',
      shippingTaxable: false,
      isFallback: false,
      position: 0,
    });
    expect(res.status).toBe(401);
  });

  /*
   * EXACTLY ONE FALLBACK ZONE. The migration seeds `zone_rest_of_nigeria` as
   * the fallback, so a second `isFallback: true` — whether created fresh or
   * flipped onto an existing zone — must be refused by the partial unique
   * index, not silently accepted.
   */
  it('refuses creating a second fallback zone', async () => {
    await login();
    const res = await http.post('/api/shop/admin/shipping-zones', {
      label: 'Second Fallback',
      countries: [],
      regions: [],
      taxRateBps: 0,
      taxLabel: '',
      shippingTaxable: false,
      isFallback: true,
      position: 99,
    });
    expect(res.status).toBe(409);
  });

  it('refuses flipping an existing zone to fallback while another already is', async () => {
    await login();
    const res = await http.patch('/api/shop/admin/shipping-zones/zone_abuja', {
      isFallback: true,
    });
    expect(res.status).toBe(409);
  });
});

describe('shipping option CRUD', () => {
  it('creates, updates and deletes an option under a zone', async () => {
    await login();

    const createRes = await http.post('/api/shop/admin/shipping-options', {
      zoneId: 'zone_abuja',
      label: 'Express',
      amountMinor: 500_000,
      estimate: 'Same day',
    });
    expect(createRes.status).toBe(201);
    const option = (
      await json<{ option: { id: string; amountMinor: number } }>(createRes)
    ).option;
    expect(option.amountMinor).toBe(500_000);

    const patchRes = await http.patch(`/api/shop/admin/shipping-options/${option.id}`, {
      amountMinor: 450_000,
    });
    expect(patchRes.status).toBe(200);
    expect((await json<{ option: { amountMinor: number } }>(patchRes)).option.amountMinor).toBe(
      450_000,
    );

    const deleteRes = await http.del(`/api/shop/admin/shipping-options/${option.id}`);
    expect(deleteRes.status).toBe(200);
  });

  it('refuses a negative rate', async () => {
    await login();
    const res = await http.post('/api/shop/admin/shipping-options', {
      zoneId: 'zone_abuja',
      label: 'Bad',
      amountMinor: -1,
    });
    expect(res.status).toBe(400);
  });
});

describe('checkout picks up live database rates', () => {
  it('GET /api/shop/checkout/shipping-options reflects an admin rate edit with no redeploy', async () => {
    await login();

    // Bump Abuja's rate through the admin route.
    const optRows = await ctx.db.execute(
      sql`SELECT id FROM shop_shipping_options WHERE zone_id = 'zone_abuja'`,
    );
    const optionId = (optRows.rows[0] as { id: string }).id;
    const patchRes = await http.patch(`/api/shop/admin/shipping-options/${optionId}`, {
      amountMinor: 350_000,
    });
    expect(patchRes.status).toBe(200);

    // Build a cart and address it to Abuja, then read the live quote.
    const cartRes = await http.post('/api/shop/cart', {});
    expect([200, 201]).toContain(cartRes.status);

    const addrRes = await http.request('/api/shop/checkout/addresses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shipping: {
          name: 'Test Buyer',
          line1: '1 Test Street',
          line2: null,
          city: 'Abuja',
          region: 'Abuja',
          postalCode: null,
          countryCode: 'NG',
          phone: null,
        },
        billing: null,
      }),
    });
    expect(addrRes.status).toBe(200);
    const body = await json<{ options: Array<{ amount: { amount: number } }> }>(addrRes);
    expect(body.options[0]?.amount.amount).toBe(350_000);
  });
});
