import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { registerLogisticsDeps, resetLogisticsDeps, resolveLogisticsDeps } from './deps';
import { LogisticsError } from './port';
import type { LogisticsProvider, PlaceList, ProviderId } from './port';
import { PLACES_DEFAULT_COUNTRY, publicPlaces, readPlaces, refreshPlaces } from './places';

/**
 * THE PLACE CACHE — the courier's own answer to "which places will you
 * accept", written down so nothing on a request path has to ask again.
 *
 * A REAL DATABASE AND A FAKE COURIER, exactly as `service.test.ts`: the table,
 * its CHECKs and the upsert are genuine, and the only stub is the provider,
 * because 37 city requests against a live sandbox is not a unit test.
 *
 * TWO READERS AND ONE WRITER, and they are deliberately different shapes.
 * `refreshPlaces` is the admin button — it calls a courier, so it may fail and
 * says how. `publicPlaces` is what a storefront fetches, and it MUST NOT fail:
 * an empty cache is an empty list, never an error, or a shop with a courier
 * switched on and no refresh run yet has no checkout at all.
 */

let ctx: TestCtx;

const NOW = 1_800_000_000_000;
const LATER = NOW + 60_000;
const SEEDED_AT = 1_786_600_005_100;

const NG_REGIONS = [
  { name: 'Abuja', code: 'FC' },
  { name: 'Lagos', code: 'LA' },
];
const NG_CITIES = {
  FC: [{ name: 'Maitama' }, { name: 'Wuse' }, { name: 'Gwagwalada' }],
  LA: [{ name: 'Ikeja' }],
};

/**
 * A courier that answers a place list and nothing else. Every other method
 * throws rather than returning a plausible shape, so a caller reaching for one
 * fails here instead of passing on invented data.
 */
function fakeProvider(
  id: ProviderId,
  places?: (country: string) => Promise<PlaceList>,
): LogisticsProvider {
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
    registerWebhook: unused('registerWebhook'),
    parseWebhook: unused('parseWebhook'),
    ...(places ? { places: { list: places } } : {}),
  };
}

const listing = (): Promise<PlaceList> =>
  Promise.resolve({ regions: NG_REGIONS, cities: NG_CITIES });

async function setProvider(provider: 'manual' | ProviderId): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE shop_logistics_settings SET provider = ${provider} WHERE id = 'main'`);
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  resetLogisticsDeps();
  registerLogisticsDeps({ now: () => NOW });
  await ctx.db.execute(sql`DELETE FROM shop_logistics_places`);
  await ctx.db.execute(sql`DELETE FROM shop_logistics_settings`);
  await ctx.db.execute(sql`
    INSERT INTO shop_logistics_settings (id, provider, updated_at)
    VALUES ('main', 'manual', ${SEEDED_AT})`);
});

afterEach(() => {
  resetLogisticsDeps();
});

describe('refreshPlaces', () => {
  it('asks the courier that is switched on, caches what it said, and counts it', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });

    const out = await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');
    expect(out).toEqual({
      country: 'NG',
      provider: 'terminal',
      regions: 2,
      /* Every city across every region, not the number of regions that have
         one — the operator's question is "how much did we just learn". */
      cities: 4,
      updatedAt: NOW,
    });

    const row = await readPlaces(ctx.db, 'terminal', 'NG');
    expect(row).toEqual({
      provider: 'terminal',
      country: 'NG',
      regions: NG_REGIONS,
      cities: NG_CITIES,
      fetchedAt: NOW,
    });
  });

  it('is idempotent — a second refresh replaces the row rather than adding one', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });
    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');

    registerLogisticsDeps({
      providers: {
        terminal: fakeProvider('terminal', () =>
          Promise.resolve({ regions: [{ name: 'Kano', code: 'KN' }], cities: { KN: [] } }),
        ),
        fez: null,
      },
      now: () => LATER,
    });
    const again = await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');
    expect(again).toMatchObject({ regions: 1, cities: 0, updatedAt: LATER });

    const count = await ctx.db.execute(sql`SELECT count(*) AS n FROM shop_logistics_places`);
    expect(Number(count.rows[0]!.n)).toBe(1);
    expect((await readPlaces(ctx.db, 'terminal', 'NG'))?.regions).toEqual([
      { name: 'Kano', code: 'KN' },
    ]);
  });

  /* A courier with no city list stores `null`, which is NOT an empty object:
     "we enforce no cities" and "we enforce a list that happens to be empty"
     send a storefront to opposite behaviours. */
  it('stores a null city map for a courier that does not enforce one', async () => {
    await setProvider('fez');
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', () =>
          Promise.resolve({ regions: [{ name: 'Kano', code: '1' }], cities: null }),
        ),
        terminal: null,
      },
      now: () => NOW,
    });

    expect(await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG')).toMatchObject({
      provider: 'fez',
      regions: 1,
      cities: 0,
    });
    expect((await readPlaces(ctx.db, 'fez', 'NG'))?.cities).toBeNull();
  });

  it('upper-cases the country, so ng and NG are one cache row', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });

    expect(await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'ng')).toMatchObject({
      country: 'NG',
    });
    expect(await readPlaces(ctx.db, 'terminal', 'NG')).not.toBeNull();
  });

  it('hands the courier the country it was asked about', async () => {
    await setProvider('terminal');
    const asked: string[] = [];
    registerLogisticsDeps({
      providers: {
        terminal: fakeProvider('terminal', (country) => {
          asked.push(country);
          return listing();
        }),
        fez: null,
      },
      now: () => NOW,
    });

    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'gh');
    expect(asked).toEqual(['GH']);
  });

  /**
   * A COURIER WITHOUT THE CAPABILITY IS AN ANSWER, NOT A FAILURE. The adapter
   * is here and its credentials work; it simply publishes no list. That is
   * something the settings screen renders ("this courier has no place list"),
   * so it comes back as a refusal the route turns into a 409 rather than an
   * exception that reads as a courier outage.
   */
  it('refuses with places_unsupported when the active courier publishes no list', async () => {
    await setProvider('fez');
    registerLogisticsDeps({
      providers: { fez: fakeProvider('fez'), terminal: null },
      now: () => NOW,
    });

    expect(await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG')).toEqual({
      refused: 'places_unsupported',
      provider: 'fez',
    });
    expect(await readPlaces(ctx.db, 'fez', 'NG')).toBeNull();
  });

  it('throws not_configured when the shop ships by hand', async () => {
    await setProvider('manual');
    await expect(refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG')).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('throws not_configured when this deployment has no credentials for the courier', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({ providers: { terminal: null, fez: null }, now: () => NOW });

    const err = await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogisticsError);
    expect((err as LogisticsError).code).toBe('not_configured');
  });

  /* The courier's own failure is not this application's, and it escapes
     unchanged so `routes.ts#providerFailure` can classify it exactly as it
     classifies a refused quote. */
  it('lets a courier failure escape as the LogisticsError the route maps', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: {
        terminal: fakeProvider('terminal', () =>
          Promise.reject(new LogisticsError('provider_rejected', 'Terminal will not list GH')),
        ),
        fez: null,
      },
      now: () => NOW,
    });

    const err = await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG').catch((e: unknown) => e);
    expect((err as LogisticsError).code).toBe('provider_rejected');
    expect((err as LogisticsError).message).toBe('Terminal will not list GH');
    /* Nothing was written: a failed fetch must not blank a cache that was
       serving a storefront perfectly well a moment ago. */
    expect(await readPlaces(ctx.db, 'terminal', 'NG')).toBeNull();
  });
});

describe('readPlaces', () => {
  it('answers null for a courier and country nothing has been cached for', async () => {
    expect(await readPlaces(ctx.db, 'terminal', 'NG')).toBeNull();
  });

  it('keys the cache by courier as well as country', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });
    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');

    expect(await readPlaces(ctx.db, 'terminal', 'NG')).not.toBeNull();
    expect(await readPlaces(ctx.db, 'fez', 'NG')).toBeNull();
    expect(await readPlaces(ctx.db, 'terminal', 'GH')).toBeNull();
  });
});

describe('publicPlaces — what a storefront is served', () => {
  /**
   * THE DEGRADATION THAT IS THE WHOLE POINT. Terminal is switched on and
   * nobody has pressed refresh yet. The answer is an empty list with a 200, so
   * the storefront falls back to free text; a 404 or a throw here would be a
   * shop that cannot take an order because an admin has not pressed a button.
   */
  it('answers an empty list rather than failing when nothing is cached', async () => {
    await setProvider('terminal');
    expect(await publicPlaces(ctx.db, 'NG')).toEqual({
      country: 'NG',
      provider: 'terminal',
      updatedAt: null,
      regions: [],
      cities: null,
    });
  });

  it('serves the cached row for the courier that is switched on', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });
    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');

    expect(await publicPlaces(ctx.db, 'NG')).toEqual({
      country: 'NG',
      provider: 'terminal',
      updatedAt: NOW,
      regions: NG_REGIONS,
      cities: NG_CITIES,
    });
  });

  /**
   * SWITCHING COURIER SWITCHES THE LIST, with no second write anywhere. Both
   * rows can sit in the cache at once; which one a shopper is shown is decided
   * by the settings row alone, so flipping the courier cannot leave a
   * storefront picking from a list the live courier has never heard of.
   */
  it('follows the active courier, not whichever row was written last', async () => {
    await setProvider('terminal');
    registerLogisticsDeps({
      providers: { terminal: fakeProvider('terminal', listing), fez: null },
      now: () => NOW,
    });
    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');

    await setProvider('fez');
    registerLogisticsDeps({
      providers: {
        fez: fakeProvider('fez', () =>
          Promise.resolve({ regions: [{ name: 'FCT', code: '1' }], cities: null }),
        ),
        terminal: null,
      },
      now: () => LATER,
    });
    await refreshPlaces(ctx.db, resolveLogisticsDeps(), 'NG');

    expect(await publicPlaces(ctx.db, 'NG')).toEqual({
      country: 'NG',
      provider: 'fez',
      updatedAt: LATER,
      regions: [{ name: 'FCT', code: '1' }],
      cities: null,
    });
  });

  it('answers manual with no list at all, because there is no courier to ask', async () => {
    await setProvider('manual');
    expect(await publicPlaces(ctx.db, 'NG')).toEqual({
      country: 'NG',
      provider: 'manual',
      updatedAt: null,
      regions: [],
      cities: null,
    });
  });

  /**
   * The singleton is seeded by migration 0980 and no route deletes it, so this
   * is a hand-run DELETE or a restore from before it — and `getLogisticsSettings`
   * THROWS on exactly that. A storefront must still be able to render a
   * checkout, so this read answers `manual` where the settings screen gets an
   * error.
   */
  it('survives a missing settings row, which the admin read deliberately does not', async () => {
    await ctx.db.execute(sql`DELETE FROM shop_logistics_settings WHERE id = 'main'`);
    expect(await publicPlaces(ctx.db, 'NG')).toMatchObject({ provider: 'manual', regions: [] });

    await ctx.db.execute(sql`
      INSERT INTO shop_logistics_settings (id, provider, updated_at)
      VALUES ('main', 'manual', ${SEEDED_AT})`);
  });

  it('pins its default country to the one the address form is locked to', () => {
    expect(PLACES_DEFAULT_COUNTRY).toBe('NG');
  });
});

/**
 * The DDL migration 1000 applied, read back from the database rather than from
 * the file — CLAUDE.md §4's rule, and the reason the production ledger's mixed
 * line endings cannot be trusted to say whether anything ran.
 */
describe('what the table itself refuses', () => {
  const insert = (
    provider: string,
    country: string,
    regions: string,
    cities: string | null,
  ): Promise<unknown> =>
    ctx.db.execute(sql`
      INSERT INTO shop_logistics_places (provider, country, regions, cities, fetched_at)
      VALUES (${provider}, ${country}, ${regions}::jsonb, ${cities}::jsonb, ${NOW})`);

  it('refuses a courier it has never heard of', async () => {
    await expect(insert('dhl', 'NG', '[]', null)).rejects.toThrow();
  });

  it('refuses a country that is not two upper-case letters', async () => {
    await expect(insert('fez', 'ng', '[]', null)).rejects.toThrow();
    await expect(insert('fez', 'NGA', '[]', null)).rejects.toThrow();
  });

  /* jsonb holds a scalar as happily as an array, and every reader here indexes
     into these — the same argument `shop_logistics_settings_packaging_ck` makes. */
  it('refuses regions that are not an array and cities that are not an object', async () => {
    await expect(insert('fez', 'NG', '{}', null)).rejects.toThrow();
    await expect(insert('fez', 'NG', '[]', '[]')).rejects.toThrow();
  });

  it('takes one row per courier and country, and no more', async () => {
    await insert('fez', 'NG', '[]', null);
    await expect(insert('fez', 'NG', '[]', null)).rejects.toThrow();
    /* The same courier in another country, and another courier in the same
       one, are both different rows. */
    await insert('fez', 'GH', '[]', null);
    await insert('terminal', 'NG', '[]', '{}');
  });
});
