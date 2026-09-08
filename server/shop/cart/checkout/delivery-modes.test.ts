import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from '../test/harness';
import { httpClient, json } from '../../../test/http';
import { seedSellable } from '../../catalog/test/catalog-harness';
import { SHOP_CURRENCY } from '../../currency';
import type { HttpClient } from '../../../test/http';
import type { TestCtx } from '../test/harness';

/**
 * ADDRESS MODE AND THE MONEY PATH (migrations 0760 and 0780), driven through
 * the REAL app.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, per CLAUDE.md §2 — and here the
 * reason is sharper than usual: what is under test is whether a switch on one
 * table changes what a shopper is CHARGED via a different one, and a test app
 * that wired its own `CheckoutConfig` would answer a question nobody asked.
 * `loadConfig` reading the settings row on every checkout call is precisely the
 * thing that could be missing.
 */

let ctx: TestCtx;
let http: HttpClient;
/** A real, published, priced variant — the freeze needs a line to get as far
 *  as the address rules, and `seedSellable` goes through Catalog's own path. */
let tee: { id: string };

beforeAll(async () => {
  ctx = await freshDb();
  tee = (
    await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Navy Tee',
      onHand: 100,
      amount: 1999,
      currency: SHOP_CURRENCY,
    })
  ).variant;
});
afterAll(() => ctx.close());

/** Abuja — a district-priced address. The zone rate for Abuja is ₦3,000. */
const ABUJA = {
  name: 'A Shopper',
  line1: '12 Gana Street',
  city: 'Abuja',
  region: 'Abuja',
  countryCode: 'NG',
  district: 'maitama',
};

const ZONE_RATE_ABUJA_MINOR = 300_000;
const DISTRICT_RATE_MINOR = 750_000;

/**
 * A FRESH IP PER TEST. `POST /api/shop/cart` is rate-limited per IP
 * (`CART_CREATE_LIMIT`), and this suite creates a cart in every `beforeEach` —
 * so one shared address turns the twenty-first test into a 429 that looks like
 * a bug in whatever it happened to be asserting.
 */
let ipCounter = 0;

beforeEach(async () => {
  await resetShopTables(ctx.db);
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings
       SET address_mode = 'district', location_offered = false, served_regions = NULL,
           served_countries = '{NG}', revision = 1
     WHERE id = 'main'`);
  http = httpClient(ctx.db);
  ipCounter += 1;
  const ip = { headers: { 'x-real-ip': `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` } };
  expect((await http.post('/api/shop/cart', undefined, ip)).status).toBe(201);
});

async function setMode(mode: 'district' | 'simple'): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings SET address_mode = ${mode} WHERE id = 'main'`);
}

async function setServedCountries(countries: string[]): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings
       SET served_countries = ARRAY[${sql.join(countries.map((c) => sql`${c}`), sql`, `)}]::text[]
     WHERE id = 'main'`);
}

async function setServedRegions(regions: string[] | null): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings
       SET served_regions = ${regions === null ? sql`NULL::text[]` : sql`ARRAY[${sql.join(regions.map((r) => sql`${r}`), sql`, `)}]::text[]`}
     WHERE id = 'main'`);
}

/** An opinion about one district: switched off, or priced. */
async function ruleDistrict(areaKey: string, delivers: boolean, rateMinor: number | null) {
  await ctx.db.execute(sql`
    INSERT INTO shop_delivery_areas (id, area_key, delivers, rate_minor, revision, created_at, updated_at)
    VALUES (${`darea_${areaKey}`}, ${areaKey}, ${delivers}, ${rateMinor}::bigint, 1, 1, 1)
    ON CONFLICT (area_key) DO UPDATE
      SET delivers = EXCLUDED.delivers, rate_minor = EXCLUDED.rate_minor`);
}

interface AddressResult {
  zone: string;
  options: Array<{ id: string; amount: { amount: number } }>;
}

async function putAddress(shipping: unknown): Promise<Response> {
  return http.request('/api/shop/checkout/addresses', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shipping }),
  });
}

async function deliveryMinor(shipping: unknown): Promise<number> {
  const res = await putAddress(shipping);
  expect(res.status).toBe(200);
  const body = await json<AddressResult>(res);
  expect(body.options.length).toBeGreaterThan(0);
  return body.options[0].amount.amount;
}

describe('mode: district — nothing about the existing behaviour moves', () => {
  it('still lets a per-area rate replace the zone amount', async () => {
    await ruleDistrict('maitama', true, DISTRICT_RATE_MINOR);
    expect(await deliveryMinor(ABUJA)).toBe(DISTRICT_RATE_MINOR);
  });

  it('still refuses an address in a switched-off area, at the door', async () => {
    await ruleDistrict('maitama', false, null);
    const res = await putAddress(ABUJA);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('outside_delivery_area');
  });

  it('prices an unruled district at the state’s zone rate — a table of opinions, not places', async () => {
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FLIP MID-CHECKOUT — the whole reason `address_mode` touches the money
 * path at all.
 *
 * A district only reaches `districtRuling` because it is STORED on the address
 * row, and a stored district outlives the switch that stopped collecting it.
 * Without the short-circuit, a cart addressed on Monday under the district form
 * would still be priced — or refused — by that district at Friday's freeze,
 * while the shopper looks at a form that never asked.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('mode: simple — a stored district stops deciding anything', () => {
  it('ignores a per-area rate and charges the state’s zone rate', async () => {
    await ruleDistrict('maitama', true, DISTRICT_RATE_MINOR);
    await setMode('simple');
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  it('ignores a switched-off area rather than refusing an address it no longer asks about', async () => {
    await ruleDistrict('maitama', false, null);
    await setMode('simple');
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  it('does not change what a district-less address costs — that path never moved', async () => {
    await setMode('simple');
    const { district: _dropped, ...noDistrict } = ABUJA;
    expect(await deliveryMinor(noDistrict)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  /* The switch is read per request, not baked at boot: an owner who flips it
     back must have the areas pricing again on the very next call. */
  it('goes straight back when the switch is flipped back', async () => {
    await ruleDistrict('maitama', true, DISTRICT_RATE_MINOR);
    await setMode('simple');
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
    await setMode('district');
    expect(await deliveryMinor(ABUJA)).toBe(DISTRICT_RATE_MINOR);
  });
});

/**
 * WHERE THE SHOP WILL SHIP AT ALL — migration 1060.
 *
 * The country was a hardcoded constant on the public config until this, so the
 * storefront disabled Continue for every foreign address no matter which zones
 * existed. These drive the whole path: the setting, the public config the
 * storefront gates on, and the server-side refusal that has to agree with it.
 */
const LONDON = {
  name: 'A Shopper',
  line1: '10 Downing Street',
  city: 'London',
  region: 'England',
  countryCode: 'GB',
};

describe('served countries', () => {
  it('refuses a country the shop has not named, with its OWN error code', async () => {
    const res = await putAddress(LONDON);
    expect(res.status).toBe(400);
    /* Not `outside_service_region`: that one names a Nigerian state, and the
       next step for a shopper in London is not to pick a different state. */
    const body = JSON.stringify(await res.json());
    expect(body).toContain('outside_service_country');
    expect(body).not.toContain('outside_service_region');
  });

  it('lets the address through once the owner opens the country', async () => {
    await setServedCountries(['NG', 'GB']);
    const res = await putAddress(LONDON);
    expect(res.status).toBe(200);
  });

  it('still ships Nigeria on the seeded single-country list', async () => {
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  /*
   * THE SCOPING RULE, END TO END. `served_regions` holds Nigerian STATES, so
   * applying it to a foreign address refuses every one of them — and the owner
   * would "fix" that by clearing a restriction protecting something real.
   */
  it('does not let a Nigerian region list refuse a foreign address', async () => {
    await setServedCountries(['NG', 'GB']);
    await setServedRegions(['Abuja', 'Lagos']);
    expect((await putAddress(LONDON)).status).toBe(200);
    // ...while still refusing the Nigerian state that is genuinely off the list.
    expect((await putAddress({ ...ABUJA, region: 'Kano', district: undefined })).status).toBe(400);
  });

  it('tells the storefront what it may offer, so the form and the server agree', async () => {
    await setServedCountries(['NG', 'GB']);
    const res = await http.request('/api/public/shop/delivery-config', { method: 'GET' });
    const { config } = (await res.json()) as {
      config: { country: { default: string; allowed: string[]; locked: boolean } };
    };
    expect(config.country).toEqual({ default: 'NG', allowed: ['NG', 'GB'], locked: false });
  });

  it('locks the field again when the shop serves one country', async () => {
    const res = await http.request('/api/public/shop/delivery-config', { method: 'GET' });
    const { config } = (await res.json()) as { config: { country: { locked: boolean } } };
    expect(config.country.locked).toBe(true);
  });
});

/**
 * The way back from simple mode. A switched-off district was the only way this
 * shop could say "we do not go there"; with no district collected, nothing is
 * consulted and the catch-all zone covers all of Nigeria.
 */
describe('served regions', () => {
  it('lets a named region through', async () => {
    await setServedRegions(['Abuja', 'Lagos']);
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  it('matches the way zoneFor matches — case and whitespace folded', async () => {
    await setServedRegions(['  aBuJa ']);
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  it('refuses a region outside the list, with its OWN error code', async () => {
    await setServedRegions(['Lagos']);
    const res = await putAddress(ABUJA);
    expect(res.status).toBe(400);
    /* Not `outside_delivery_area`: the storefront's message for that one names
       a district the customer picked from a list, and there is no list here. */
    const body = JSON.stringify(await res.json());
    expect(body).toContain('outside_service_region');
    expect(body).not.toContain('outside_delivery_area');
  });

  it('refuses an address with no region at all — the catch-all zone is what the restriction exists to stop', async () => {
    await setServedRegions(['Abuja']);
    const { region: _dropped, ...noRegion } = ABUJA;
    const res = await putAddress(noRegion);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('outside_service_region');
  });

  it('applies in BOTH modes — where the shop delivers is not a property of which form is on screen', async () => {
    await setServedRegions(['Lagos']);
    for (const mode of ['district', 'simple'] as const) {
      await setMode(mode);
      expect((await putAddress(ABUJA)).status).toBe(400);
    }
  });

  it('does nothing at all when it is null, which is the seeded value', async () => {
    await setServedRegions(null);
    expect(await deliveryMinor(ABUJA)).toBe(ZONE_RATE_ABUJA_MINOR);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ADDED MID-CHECKOUT — the case `putAddresses` alone cannot catch.
   *
   * The address was accepted when there was no restriction. The owner adds one
   * while the cart sits at the payment step. Every later step has to refuse it,
   * because the freeze is the last instant a refusal costs nothing: past it,
   * the answer is a refund for a delivery the shop has just said it will not
   * make. This is the same argument the district refusal already makes, and it
   * is why the check is in four places rather than one.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('refuses at every later step once the restriction appears', async () => {
    expect((await http.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 })).status).toBe(
      201,
    );
    const accepted = await putAddress(ABUJA);
    expect(accepted.status).toBe(200);
    const optionId = (await json<AddressResult>(accepted)).options[0].id;

    await setServedRegions(['Lagos']);

    // The options list goes empty rather than quoting a price for a place the
    // shop has stopped serving.
    const options = await http.get('/api/shop/checkout/shipping-options');
    expect(options.status).toBe(200);
    expect((await json<{ options: unknown[] }>(options)).options).toEqual([]);

    // Choosing a delivery option is refused...
    const shipping = await http.request('/api/shop/checkout/shipping', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId }),
    });
    expect(shipping.status).toBe(400);
    expect(JSON.stringify(await shipping.json())).toContain('outside_service_region');

    // ...and so is the freeze, with its own 409 code rather than the catch-all
    // `precondition_failed`, which reads to a storefront as a glitch to retry.
    const frozen = await http.post('/api/shop/checkout/freeze');
    expect(frozen.status).toBe(409);
    expect(await json<{ error: string }>(frozen)).toMatchObject({
      error: 'outside_service_region',
    });
  });
});

describe('the location pin (migration 0780)', () => {
  const PIN = { lat: 9.05785, lng: 7.49508, accuracyM: 32.4, source: 'device' as const };

  async function storedLocation(): Promise<Record<string, unknown> | undefined> {
    const res = await ctx.db.execute(sql`
      SELECT location_lat_e6, location_lng_e6, location_accuracy_m, location_source,
             location_captured_at
        FROM shop_addresses WHERE kind = 'shipping'`);
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  it('round-trips a coordinate through integer micro-degrees', async () => {
    expect((await putAddress({ ...ABUJA, location: PIN })).status).toBe(200);
    const row = await storedLocation();
    expect(Number(row?.location_lat_e6)).toBe(9_057_850);
    expect(Number(row?.location_lng_e6)).toBe(7_495_080);
    /* `coords.accuracy` is a float and the column is `integer`. */
    expect(Number(row?.location_accuracy_m)).toBe(32);
    expect(row?.location_source).toBe('device');
  });

  /* The client does not get to say when the fix was taken: an operator reads
     that as fact, and clock skew on a phone would make some of them wrong with
     nothing on screen saying so. */
  it('stamps capturedAt server-side and refuses one sent by the client', async () => {
    const before = Date.now();
    expect((await putAddress({ ...ABUJA, location: PIN })).status).toBe(200);
    const at = Number((await storedLocation())?.location_captured_at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());

    const res = await putAddress({ ...ABUJA, location: { ...PIN, capturedAt: 1 } });
    expect(res.status).toBe(400);
  });

  it('accepts a hand-dropped pin with no accuracy figure', async () => {
    const res = await putAddress({
      ...ABUJA,
      location: { lat: 9.05785, lng: 7.49508, source: 'pin' },
    });
    expect(res.status).toBe(200);
    const row = await storedLocation();
    expect(row?.location_accuracy_m).toBeNull();
    expect(row?.location_source).toBe('pin');
  });

  /*
   * Re-submitting the form without sharing a location CLEARS the previous pin
   * rather than leaving a stale one attached to an address that has since
   * changed — the five columns move together on the UPDATE branch.
   */
  it('clears a pin when the address is re-submitted without one', async () => {
    expect((await putAddress({ ...ABUJA, location: PIN })).status).toBe(200);
    expect(Number((await storedLocation())?.location_lat_e6)).toBe(9_057_850);
    expect((await putAddress(ABUJA)).status).toBe(200);
    expect((await storedLocation())?.location_lat_e6).toBeNull();
  });

  it('refuses an out-of-range coordinate before the column has to', async () => {
    expect((await putAddress({ ...ABUJA, location: { ...PIN, lat: 99 } })).status).toBe(400);
    expect((await putAddress({ ...ABUJA, location: { ...PIN, lng: 181 } })).status).toBe(400);
  });

  it('refuses an unknown source and a negative accuracy', async () => {
    expect((await putAddress({ ...ABUJA, location: { ...PIN, source: 'guess' } })).status).toBe(400);
    expect((await putAddress({ ...ABUJA, location: { ...PIN, accuracyM: -1 } })).status).toBe(400);
  });

  it('prices nothing — the pin never moves the delivery amount', async () => {
    const without = await deliveryMinor(ABUJA);
    const with_ = await deliveryMinor({ ...ABUJA, location: PIN });
    expect(with_).toBe(without);
  });

  /*
   * ACCEPTED IN BOTH MODES. `location.offer` gates whether the STOREFRONT asks;
   * the route accepts a pin either way, so a config the shopper's browser
   * cached a minute ago cannot produce a request the server refuses. The same
   * tolerance `district` has in the other direction.
   */
  it('is accepted regardless of the mode or the switch', async () => {
    for (const mode of ['district', 'simple'] as const) {
      await setMode(mode);
      expect((await putAddress({ ...ABUJA, location: PIN })).status).toBe(200);
    }
  });
});
