import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import type { DeliveryConfig } from './config';

/**
 * `GET /api/public/shop/delivery-config`, driven through the REAL app.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, deliberately. CLAUDE.md §2 records
 * this codebase's most expensive repeat bug: a suite that builds its own app
 * registers its own dependencies and therefore cannot see a missing composition
 * root. This route decides which questions a shopper is asked before they pay,
 * so it gets the real thing — mount order included, since being ABOVE
 * `sessionMiddleware` is the entire reason its cache header is safe.
 *
 * AND THE HEADERS ARE ASSERTED, NOT THE BEHAVIOUR. §2 again: three routes have
 * shipped in this codebase without the CORS headers they needed and passed
 * every test, because a server-side test never enforces CORS. A cacheable
 * public route's headers ARE its contract.
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

const PATH = '/api/public/shop/delivery-config';

async function config(): Promise<DeliveryConfig> {
  const res = await http.get(PATH);
  expect(res.status).toBe(200);
  return (await json<{ config: DeliveryConfig }>(res)).config;
}

async function setMode(mode: 'district' | 'simple', locationOffered = false): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings
       SET address_mode = ${mode}, location_offered = ${locationOffered}, revision = revision + 1
     WHERE id = 'main'`);
}

describe('the headers, which are the contract', () => {
  it('is cacheable and cross-origin readable', async () => {
    const res = await http.get(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  /*
   * ITS ABSENCE IS THE CORRECT ANSWER HERE, and the only route in this codebase
   * where that is true. A credentialed fetch would make a `Cache-Control:
   * public` response per-viewer, which is exactly what the mount above
   * `sessionMiddleware` exists to prevent (threat T6).
   */
  it('does NOT allow credentials — a cacheable response must not vary by cookie', async () => {
    const res = await http.get(PATH);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('cookielessness, by construction', () => {
  /*
   * Mounted above `sessionMiddleware`, `c.get('user')` is structurally
   * `undefined` in the handler. The observable consequence is that a signed-in
   * operator and an anonymous shopper get byte-identical answers — if that ever
   * stops being true, something reader-specific has been added and a shared
   * cache will hand one reader's copy to another.
   */
  it('answers a signed-in operator exactly what it answers a stranger', async () => {
    const anonymous = await (await http.get(PATH)).text();
    await http.signIn({ email: 'owner@test.local' });
    const signedIn = await (await http.get(PATH)).text();
    expect(signedIn).toBe(anonymous);
    http.clearCookies();
  });
});

describe('with the switch off — today, exactly', () => {
  it('asks for a district and names the list to fetch', async () => {
    await setMode('district');
    const c = await config();
    expect(c.mode).toBe('district');
    expect(c.fields.filter((f) => f.show).map((f) => f.key)).toEqual([
      'name',
      'phone',
      'region',
      'district',
      'city',
      'line1',
      'line2',
    ]);
    expect(c.districts?.source).toBe('/api/public/marketing/areas');
    expect(c.location.offer).toBe(false);
  });
});

describe('with the switch on', () => {
  it('drops the district and stops naming a list', async () => {
    await setMode('simple');
    const c = await config();
    expect(c.mode).toBe('simple');
    expect(c.fields.filter((f) => f.show).map((f) => f.key)).not.toContain('district');
    expect(c.districts).toBeNull();
  });

  it('offers the location button once the owner turns it on, and never requires it', async () => {
    await setMode('simple', true);
    const c = await config();
    expect(c.location.offer).toBe(true);
    expect(c.location.required).toBe(false);
    expect(c.location.pricing).toBe(false);
  });
});

describe('a missing row', () => {
  /*
   * Migration 0760 seeds it and no route deletes it, so this is a hand-run
   * DELETE or a restore from before the migration. A shopper must still be able
   * to check out, so the answer is the form the shop shipped last week — with
   * `revision: 0`, which the column's own CHECK (`revision > 0`) makes
   * impossible to confuse with a real save.
   */
  it('serves the district form rather than 404ing a storefront out of a checkout', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_delivery_settings WHERE id = 'main'`);
    const c = await config();
    expect(c.mode).toBe('district');
    expect(c.revision).toBe(0);
    expect(c.location.offer).toBe(false);

    await ctx.db.execute(sql`
      INSERT INTO shop_delivery_settings (id, address_mode, location_offered, revision, updated_at)
      VALUES ('main', 'district', false, 1, 1)`);
  });
});

/**
 * `GET /api/public/shop/delivery-places` — the courier's own place lists, on
 * the wire beside the form that uses them.
 *
 * HERE AND NOT IN `logistics/` BECAUSE OF WHERE IT IS MOUNTED. It is the same
 * router, above `sessionMiddleware`, so it is cookieless by construction and
 * `Cache-Control: public` is safe for the same reason `delivery-config`'s is.
 * Ten minutes rather than sixty seconds: a courier's list of states moves about
 * once a year, and it is refreshed by an admin pressing a button.
 */
describe('the public place lists', () => {
  const PLACES = '/api/public/shop/delivery-places';

  interface PlacesPayload {
    country: string;
    provider: 'manual' | 'fez' | 'terminal';
    updatedAt: number | null;
    regions: { name: string; code: string | null }[];
    cities: Record<string, { name: string }[]> | null;
  }

  const REGIONS = [
    { name: 'Abuja', code: 'FC' },
    { name: 'Lagos', code: 'LA' },
  ];
  const CITIES = { FC: [{ name: 'Maitama' }], LA: [{ name: 'Ikeja' }] };

  async function cache(provider: 'fez' | 'terminal', country: string, at: number): Promise<void> {
    await ctx.db.execute(sql`
      UPDATE shop_logistics_settings SET provider = ${provider} WHERE id = 'main'`);
    await ctx.db.execute(sql`
      INSERT INTO shop_logistics_places (provider, country, regions, cities, fetched_at)
      VALUES (${provider}, ${country}, ${JSON.stringify(REGIONS)}::jsonb,
              ${JSON.stringify(CITIES)}::jsonb, ${at})
      ON CONFLICT (provider, country) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`);
  }

  async function reset(): Promise<void> {
    await ctx.db.execute(sql`DELETE FROM shop_logistics_places`);
    await ctx.db.execute(sql`
      UPDATE shop_logistics_settings SET provider = 'manual' WHERE id = 'main'`);
  }

  it('is cacheable, cross-origin readable, and sets no cookie', async () => {
    const res = await http.get(PLACES);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=600, stale-while-revalidate=3600',
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    /* Its absence is the correct answer, exactly as on `delivery-config`: a
       credentialed fetch would make a `Cache-Control: public` response
       per-viewer. */
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  /**
   * THE DEGRADATION THAT IS THE WHOLE POINT. Nothing is cached yet, so the
   * answer is an empty list and a 200 — the storefront falls back to free text.
   * A 404 here would be a shop that cannot take an order because an admin has
   * not pressed a button.
   */
  it('answers an empty list rather than 404ing when nothing is cached', async () => {
    await reset();
    const res = await http.get(PLACES);
    expect(res.status).toBe(200);
    expect(await json<PlacesPayload>(res)).toEqual({
      country: 'NG',
      provider: 'manual',
      updatedAt: null,
      regions: [],
      cities: null,
    });
  });

  it('serves the cached list of the courier that is switched on', async () => {
    await cache('terminal', 'NG', 1_800_000_000_000);
    expect(await json<PlacesPayload>(await http.get(PLACES))).toEqual({
      country: 'NG',
      provider: 'terminal',
      updatedAt: 1_800_000_000_000,
      regions: REGIONS,
      cities: CITIES,
    });
    await reset();
  });

  it('takes a country, and answers an empty list for one nothing is cached for', async () => {
    await cache('terminal', 'NG', 1_800_000_000_000);
    const res = await http.get(`${PLACES}?country=gh`);
    expect(res.status).toBe(200);
    expect(await json<PlacesPayload>(res)).toMatchObject({
      country: 'GH',
      provider: 'terminal',
      regions: [],
      cities: null,
    });
    await reset();
  });

  /* A junk query string is not a reason to break a checkout. It falls back to
     the country the address form is locked to, and SAYS which one it used. */
  it('falls back to the default country rather than 400ing on a junk one', async () => {
    const res = await http.get(`${PLACES}?country=Nigeria`);
    expect(res.status).toBe(200);
    expect(await json<PlacesPayload>(res)).toMatchObject({ country: 'NG' });
  });

  it('answers a signed-in operator exactly what it answers a stranger', async () => {
    await cache('terminal', 'NG', 1_800_000_000_000);
    const anonymous = await (await http.get(PLACES)).text();
    await http.signIn({ email: 'owner@test.local' });
    const signedIn = await (await http.get(PLACES)).text();
    expect(signedIn).toBe(anonymous);
    http.clearCookies();
    await reset();
  });

  /**
   * The singleton is seeded by migration 0980 and no route deletes it, so this
   * is a hand-run DELETE — and the admin read THROWS on exactly that. A
   * storefront must still render a checkout, so this one answers `manual`.
   */
  it('survives a missing courier settings row', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_logistics_settings WHERE id = 'main'`);
    expect(await json<PlacesPayload>(await http.get(PLACES))).toMatchObject({
      provider: 'manual',
      regions: [],
    });
    await ctx.db.execute(sql`
      INSERT INTO shop_logistics_settings (id, provider, updated_at)
      VALUES ('main', 'manual', 1786600005100)`);
  });
});
