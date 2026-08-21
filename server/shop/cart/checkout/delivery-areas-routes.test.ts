import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, SEED_PASSWORD } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { httpClient, json } from '../../../test/http';
import type { HttpClient } from '../../../test/http';

/**
 * Per-district delivery (migration 0300), driven through the REAL app — router,
 * origin guard, session middleware, `shopApp()`'s `onError`.
 *
 * THROUGH `createApp()` AND NOT A TEST APP, deliberately. CLAUDE.md §2 records
 * this codebase's most expensive repeat bug: a suite that builds its own app
 * registers its own dependencies and therefore cannot see a missing composition
 * root. `GET /api/shop/orders` 401'd every real caller while its tests passed,
 * and the checkout webhook later ran with an unwired port for the same reason.
 * These routes decide whether the shop delivers somewhere and for how much, so
 * they are money-adjacent and get the real thing.
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

async function login(who: 'owner' | 'writer' = 'owner'): Promise<void> {
  const res = await http.post('/api/auth/login', {
    email: `${who}@test.local`,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
}

interface Area {
  areaKey: string;
  delivers: boolean;
  rateMinor: number | null;
  revision: number;
}

async function get(): Promise<Area[]> {
  const res = await http.get('/api/shop/admin/delivery-areas');
  expect(res.status).toBe(200);
  return (await json<{ items: Area[] }>(res)).items;
}

describe('the guard', () => {
  it('401s without a session', async () => {
    const res = await http.get('/api/shop/admin/delivery-areas');
    expect(res.status).toBe(401);
  });

  it('lets a writer READ the rates but not change them', async () => {
    await login('writer');
    expect((await http.get('/api/shop/admin/delivery-areas')).status).toBe(200);

    /*
     * Knowing what delivery costs is part of processing an order; deciding
     * whether the shop serves a city is not. Same split `MarketingAreas` makes
     * for service areas (spec D12).
     */
    const res = await http.put('/api/shop/admin/delivery-areas/maitama', {
      delivers: false,
      expectedRevision: null,
    });
    expect(res.status).toBe(403);
    expect(await get()).toEqual([]);
  });
});

describe('absence', () => {
  it('starts empty — a district nobody has priced has no row', async () => {
    await login();
    expect(await get()).toEqual([]);
  });
});

describe('PUT /admin/delivery-areas/:areaKey', () => {
  it('creates on the first write and reports revision 1', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/wuse', {
      rateMinor: 350_000,
      expectedRevision: null,
    });
    expect(res.status).toBe(200);
    const { area } = await json<{ area: Area }>(res);
    expect(area).toMatchObject({
      areaKey: 'wuse',
      rateMinor: 350_000,
      /* The column default, not something the client sent — absence means the
       * shop already delivers there, so a first write that only names a price
       * must not switch delivery off as a side effect. */
      delivers: true,
      revision: 1,
    });
  });

  it('bumps the revision and keeps the fields it was not given', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/wuse', {
      delivers: false,
      expectedRevision: 1,
    });
    expect(res.status).toBe(200);
    const { area } = await json<{ area: Area }>(res);
    expect(area).toMatchObject({ delivers: false, rateMinor: 350_000, revision: 2 });
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE ONE THAT MATTERS: ABSENT ≠ NULL.
   *
   * `rateMinor` absent means "leave the rate alone"; an explicit `null` means
   * "clear the override, price from the state's zone". Collapsing them is the
   * bug that would make every partial write silently wipe a rate, and it is
   * exactly what a `COALESCE` implementation would do — which is why the repo
   * uses `CASE WHEN <provided>`.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('leaves the rate alone when the key is absent', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/wuse', {
      delivers: true,
      expectedRevision: 2,
    });
    const { area } = await json<{ area: Area }>(res);
    expect(area.rateMinor).toBe(350_000);
  });

  it('clears the override when the key is an explicit null', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/wuse', {
      rateMinor: null,
      expectedRevision: 3,
    });
    const { area } = await json<{ area: Area }>(res);
    expect(area.rateMinor).toBeNull();
    /* And `null` is not zero — free delivery stays expressible. */
    const zero = await http.put('/api/shop/admin/delivery-areas/wuse', {
      rateMinor: 0,
      expectedRevision: 4,
    });
    expect((await json<{ area: Area }>(zero)).area.rateMinor).toBe(0);
  });

  it('refuses a stale write instead of clobbering it', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/wuse', {
      rateMinor: 999_999,
      expectedRevision: 1,
    });
    expect(res.status).toBe(409);
    const after = (await get()).find((a) => a.areaKey === 'wuse');
    expect(after?.rateMinor).toBe(0);
  });

  it('refuses a first write that lost a race to another first write', async () => {
    await login();
    // `garki` already exists after this call…
    expect(
      (await http.put('/api/shop/admin/delivery-areas/garki', { rateMinor: 1, expectedRevision: null }))
        .status,
    ).toBe(200);
    // …so a second caller still asserting "there is no row" must lose.
    expect(
      (await http.put('/api/shop/admin/delivery-areas/garki', { rateMinor: 2, expectedRevision: null }))
        .status,
    ).toBe(409);
  });

  it('rejects a negative rate', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/asokoro', {
      rateMinor: -1,
      expectedRevision: null,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown key rather than ignoring it', async () => {
    await login();
    const res = await http.put('/api/shop/admin/delivery-areas/asokoro', {
      rate: 3000,
      expectedRevision: null,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/delivery-areas/bulk', () => {
  it('sets one rate across many districts, creating and updating in one pass', async () => {
    await login();
    const res = await http.post('/api/shop/admin/delivery-areas/bulk', {
      // `wuse` exists (revision 5 by now), the other two do not.
      areaKeys: ['wuse', 'gudu', 'durumi'],
      rateMinor: 500_000,
    });
    expect(res.status).toBe(200);
    const { items } = await json<{ items: Area[] }>(res);
    expect(items).toHaveLength(3);
    expect(items.every((a) => a.rateMinor === 500_000)).toBe(true);

    const all = await get();
    for (const key of ['wuse', 'gudu', 'durumi']) {
      expect(all.find((a) => a.areaKey === key)?.rateMinor).toBe(500_000);
    }
  });

  it('does not touch the switches — repricing is not a decision to start delivering', async () => {
    await login();
    /*
     * SELF-CONTAINED ON PURPOSE. An earlier draft of this test leaned on the
     * state `wuse` happened to be in by this point in the file and asserted
     * `false` — which was simply wrong (it had been switched back on two tests
     * earlier). Worse, once corrected to `true` it proved nothing: `true` is
     * also the column default, so a bulk write that DID clobber the switch
     * would have passed it. Switch a district off here, reprice it here, and
     * the assertion has something to fail on.
     */
    const off = await http.put('/api/shop/admin/delivery-areas/jabi', {
      delivers: false,
      expectedRevision: null,
    });
    expect((await json<{ area: Area }>(off)).area.delivers).toBe(false);

    const res = await http.post('/api/shop/admin/delivery-areas/bulk', {
      areaKeys: ['jabi'],
      rateMinor: 750_000,
    });
    expect(res.status).toBe(200);

    const after = (await json<{ items: Area[] }>(res)).items[0]!;
    expect(after.rateMinor).toBe(750_000);
    expect(after.delivers).toBe(false);
  });

  it('is forbidden to a writer', async () => {
    await login('writer');
    const res = await http.post('/api/shop/admin/delivery-areas/bulk', {
      areaKeys: ['wuse'],
      rateMinor: 1,
    });
    expect(res.status).toBe(403);
  });

  it('rejects an empty list rather than silently doing nothing', async () => {
    await login();
    const res = await http.post('/api/shop/admin/delivery-areas/bulk', {
      areaKeys: [],
      rateMinor: 1,
    });
    expect(res.status).toBe(400);
  });
});
