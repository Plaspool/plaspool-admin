/**
 * The daily rate refreshes ON ITS OWN (1160): due-gated, margin baked in,
 * hand-set rates untouched, and never an exception into the sweep. The feed
 * is stubbed — no test here reaches the network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, TEST_ORIGIN } from '../../test/http';
import { REFRESH_AFTER_MS, feedValueToE12, refreshFeedRates, setFeedFetch } from './feed';
import { readFxState } from './state';

let ctx: TestCtx;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_fx_rates`);
  await ctx.db.execute(sql`
    UPDATE shop_currency_settings SET enabled = '{NGN,GHS,KES}', revision = 1, feed_margin_bps = 0
     WHERE id = 'main'`);
});

afterEach(() => setFeedFetch(null));

/** A feed stub: the first URL answers `primary`, the second `fallback`. */
function feed(primary: unknown, fallback: unknown = null) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const body = url.includes('open.er-api') ? primary : fallback;
    if (body === null) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { impl, calls };
}

const OK = { result: 'success', rates: { GHS: 0.008496176720, KES: 0.0831 } };

async function rate(code: string) {
  return (await readFxState(ctx.db, NOW)).rates.get(code);
}

describe('refreshFeedRates', () => {
  it('fetches when a switched-on currency has no rate, and moves the revision', async () => {
    const f = feed(OK);
    const r = await refreshFeedRates(ctx.db, { now: NOW, fetchImpl: f.impl });
    expect(r).toMatchObject({ skipped: false, source: 'open.er-api.com', refreshed: ['GHS', 'KES'], error: null });
    expect((await rate('GHS'))?.multiplierE12).toBe(8496176720n);
    // Once per number that moved: two currencies, two bumps.
    expect((await readFxState(ctx.db, NOW)).revision).toBe(3);
  });

  it('does not ask the feed while every daily rate is younger than twelve hours', async () => {
    await refreshFeedRates(ctx.db, { now: NOW, fetchImpl: feed(OK).impl });
    const f = feed(OK);
    const r = await refreshFeedRates(ctx.db, { now: NOW + REFRESH_AFTER_MS - 1, fetchImpl: f.impl });
    expect(r.skipped).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('asks again once one is due, and moves the revision only if the number moved', async () => {
    await refreshFeedRates(ctx.db, { now: NOW, fetchImpl: feed(OK).impl });
    const rev = (await readFxState(ctx.db, NOW)).revision;
    const r = await refreshFeedRates(ctx.db, { now: NOW + REFRESH_AFTER_MS, fetchImpl: feed(OK).impl });
    expect(r).toMatchObject({ refreshed: [], unchanged: ['GHS', 'KES'] });
    expect((await readFxState(ctx.db, NOW)).revision).toBe(rev);
    expect((await rate('GHS'))?.updatedAt).toBe(NOW + REFRESH_AFTER_MS);
  });

  it('never touches a hand-set rate, even when forced', async () => {
    await ctx.db.execute(sql`
      INSERT INTO shop_fx_rates (currency, multiplier_e12, source, updated_at)
      VALUES ('GHS', 9000000000, 'manual', 0)`);
    const r = await refreshFeedRates(ctx.db, { now: NOW, force: true, fetchImpl: feed(OK).impl });
    expect(r.manual).toEqual(['GHS']);
    expect(r.refreshed).toEqual(['KES']);
    expect((await rate('GHS'))?.multiplierE12).toBe(9000000000n);
  });

  it('bakes the stored margin into the multiplier it writes', async () => {
    await ctx.db.execute(sql`UPDATE shop_currency_settings SET feed_margin_bps = 300 WHERE id = 'main'`);
    await refreshFeedRates(ctx.db, { now: NOW, fetchImpl: feed(OK).impl });
    // 0.008496176720 × 1.03 = 0.0087510620216 → 0.008751062022
    expect((await rate('GHS'))?.multiplierE12).toBe(8751062022n);
    expect(feedValueToE12(0.00849617672, 300)).toBe(8751062022n);
  });

  it('falls back to the second feed, and reports a total outage without throwing', async () => {
    const f = feed(null, { ngn: { ghs: 0.0085, kes: 0.083 } });
    const r = await refreshFeedRates(ctx.db, { now: NOW, fetchImpl: f.impl });
    expect(r.source).toBe('currency-api (fawazahmed0)');
    expect((await rate('GHS'))?.multiplierE12).toBe(8500000000n);

    const down = await refreshFeedRates(ctx.db, { now: NOW, force: true, fetchImpl: feed(null, null).impl });
    expect(down.error).toBe('feed_unavailable');
    expect((await rate('GHS'))?.multiplierE12).toBe(8500000000n);
  });

  it('reports a currency the feed has no rate for', async () => {
    const r = await refreshFeedRates(ctx.db, {
      now: NOW,
      fetchImpl: feed({ result: 'success', rates: { GHS: 0.0085 } }).impl,
    });
    expect(r.missing).toEqual(['KES']);
  });
});

describe('the sweep and the button, through the real createApp()', () => {
  it('the sweep refreshes a due rate and says so', async () => {
    setFeedFetch(feed(OK).impl);
    const client = httpClient(ctx.db);
    await client.signIn(ctx.users.owner);
    const res = await client.post('/api/shop/admin/sweep', {}, { headers: { Origin: TEST_ORIGIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rates: { refreshed: string[] } };
    expect(body.rates.refreshed).toEqual(['GHS', 'KES']);
  });

  it('"Refresh rates now" forces it, and a new margin is applied at once', async () => {
    setFeedFetch(feed(OK).impl);
    const client = httpClient(ctx.db);
    await client.signIn(ctx.users.owner);
    let res = await client.post('/api/shop/admin/payments/currency/refresh', undefined, { headers: { Origin: TEST_ORIGIN } });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { revision: number; feedMarginBps: number; refresh: { refreshed: string[] } };
    expect(body.refresh.refreshed).toEqual(['GHS', 'KES']);

    res = await client.patch(
      '/api/shop/admin/payments/currency',
      { feedMarginBps: 300, revision: body.revision },
      { headers: { Origin: TEST_ORIGIN } },
    );
    body = (await res.json()) as typeof body;
    expect(body.feedMarginBps).toBe(300);
    expect(body.refresh.refreshed).toEqual(['GHS', 'KES']);
    expect((await rate('GHS'))?.multiplierE12).toBe(8751062022n);
  });
});
