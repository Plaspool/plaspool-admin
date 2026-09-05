import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import type { DeliveryConfig } from './config';
import type { DeliverySettings } from './repo';

/**
 * `/api/shop/admin/delivery-settings` — the switch, driven through the REAL
 * app: router, origin guard, session middleware, the domain gate and
 * `shopApp()`'s `onError`.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, per CLAUDE.md §2. This row can turn
 * off every per-district refusal in the shop at once, which makes it as
 * money-adjacent as anything here.
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

const PATH = '/api/shop/admin/delivery-settings';

beforeEach(async () => {
  http.clearCookies();
  await ctx.db.execute(sql`
    UPDATE shop_delivery_settings
       SET address_mode = 'district', location_offered = false, served_regions = NULL, revision = 1
     WHERE id = 'main'`);
});

interface Payload {
  settings: DeliverySettings;
  config: DeliveryConfig;
}

async function read(): Promise<Payload> {
  const res = await http.get(PATH);
  expect(res.status).toBe(200);
  return json<Payload>(res);
}

describe('the guard', () => {
  it('401s without a session', async () => {
    expect((await http.get(PATH)).status).toBe(401);
    expect((await http.patch(PATH, { expectedRevision: 1, addressMode: 'simple' })).status).toBe(
      401,
    );
  });

  /*
   * `settings` is granted to the owner and developers only (shared/roles.ts).
   * A writer's job is products and the blog; deciding whether the shop asks for
   * a district is not a thing they should be able to do by accident.
   */
  it('403s every role that does not hold `settings`', async () => {
    for (const who of ['writer', 'supply', 'support', 'marketing']) {
      http.clearCookies();
      await http.signIn({ email: `${who}@test.local` });
      expect((await http.get(PATH)).status).toBe(403);
      expect(
        (await http.patch(PATH, { expectedRevision: 1, addressMode: 'simple' })).status,
      ).toBe(403);
    }
  });

  it('lets a developer in — owner-grade everywhere except about each other', async () => {
    await http.signIn({ email: 'developer@test.local' });
    expect((await http.get(PATH)).status).toBe(200);
  });
});

describe('GET', () => {
  it('answers the row AND the config the storefront will render from it', async () => {
    await http.signIn({ email: 'owner@test.local' });
    const { settings, config } = await read();
    expect(settings).toMatchObject({
      addressMode: 'district',
      locationOffered: false,
      servedRegions: null,
      revision: 1,
    });
    /* The screen must be able to show what the storefront will actually get,
       and deriving that in the admin UI would put a second copy of
       `deliveryConfigFor` where nothing compares it to the first. */
    expect(config.mode).toBe('district');
    expect(config.fields.filter((f) => f.show).map((f) => f.key)).toContain('district');
  });
});

describe('PATCH', () => {
  beforeEach(async () => {
    await http.signIn({ email: 'owner@test.local' });
  });

  it('flips the mode and moves the revision', async () => {
    const res = await http.patch(PATH, { expectedRevision: 1, addressMode: 'simple' });
    expect(res.status).toBe(200);
    const { settings, config } = await json<Payload>(res);
    expect(settings.addressMode).toBe('simple');
    expect(settings.revision).toBe(2);
    expect(config.districts).toBeNull();
  });

  it('changes only what it names', async () => {
    await http.patch(PATH, { expectedRevision: 1, locationOffered: true });
    const { settings } = await read();
    expect(settings).toMatchObject({
      addressMode: 'district',
      locationOffered: true,
      servedRegions: null,
    });
  });

  /* Two settings tabs must not quietly overwrite each other — the CAS is in the
     UPDATE's own WHERE, so there is no read-compare-write window to lose. */
  it('409s a save based on a revision somebody else has already moved', async () => {
    expect((await http.patch(PATH, { expectedRevision: 1, addressMode: 'simple' })).status).toBe(
      200,
    );
    const stale = await http.patch(PATH, { expectedRevision: 1, addressMode: 'district' });
    expect(stale.status).toBe(409);
    expect((await read()).settings.addressMode).toBe('simple');
  });

  it('refuses a key it has never heard of', async () => {
    const res = await http.patch(PATH, { expectedRevision: 1, addressMod: 'simple' });
    expect(res.status).toBe(400);
  });

  it('refuses a mode that is not one of the two', async () => {
    expect((await http.patch(PATH, { expectedRevision: 1, addressMode: 'gps' })).status).toBe(400);
  });

  it('refuses a save with no expectedRevision at all', async () => {
    expect((await http.patch(PATH, { addressMode: 'simple' })).status).toBe(400);
  });
});

describe('served regions — the way back from simple mode', () => {
  beforeEach(async () => {
    await http.signIn({ email: 'owner@test.local' });
  });

  it('stores a list', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      servedRegions: ['Abuja', 'Lagos'],
    });
    expect(res.status).toBe(200);
    expect((await json<Payload>(res)).settings.servedRegions).toEqual(['Abuja', 'Lagos']);
  });

  /* Normalised rather than refused: an owner who types " Lagos " has said
     something correct, and a validation error about whitespace is pedantry. */
  it('trims, and drops a second spelling of the same place', async () => {
    const res = await http.patch(PATH, {
      expectedRevision: 1,
      servedRegions: ['  Lagos  ', 'lagos', 'LAGOS', 'Abuja'],
    });
    expect(res.status).toBe(200);
    expect((await json<Payload>(res)).settings.servedRegions).toEqual(['Lagos', 'Abuja']);
  });

  it('clears the restriction on an explicit null', async () => {
    await http.patch(PATH, { expectedRevision: 1, servedRegions: ['Abuja'] });
    const res = await http.patch(PATH, { expectedRevision: 2, servedRegions: null });
    expect(res.status).toBe(200);
    expect((await json<Payload>(res)).settings.servedRegions).toBeNull();
  });

  it('leaves the restriction alone when the key is absent', async () => {
    await http.patch(PATH, { expectedRevision: 1, servedRegions: ['Abuja'] });
    await http.patch(PATH, { expectedRevision: 2, addressMode: 'simple' });
    expect((await read()).settings.servedRegions).toEqual(['Abuja']);
  });

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * "Serve nowhere" and "serve everywhere" are one keystroke apart in a
   * settings screen, and only one of them shuts the shop. `[]` is neither — it
   * is a 400 naming the field, not a CHECK violation surfacing as a 500.
   * ═════════════════════════════════════════════════════════════════════════
   */
  it('refuses an empty list rather than closing the shop', async () => {
    expect((await http.patch(PATH, { expectedRevision: 1, servedRegions: [] })).status).toBe(400);
    expect((await read()).settings.servedRegions).toBeNull();
  });

  it('refuses a list that trims away to nothing', async () => {
    const res = await http.patch(PATH, { expectedRevision: 1, servedRegions: ['   ', ' '] });
    expect(res.status).toBe(400);
    expect((await read()).settings.servedRegions).toBeNull();
  });
});
