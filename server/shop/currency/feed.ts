import { readFxState, writeFeedMultiplier } from './state';
import type { Db } from '../../db/client';

/**
 * THE DAILY RATE, FETCHED AND STORED AS MULTIPLIERS — on a schedule, never on
 * a shopper's request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE IT RUNS: inside the sweep (`GET /admin/sweep`, the external cron's
 * ten-minute call), behind the "Refresh rates now" button, when the owner
 * opens the currency card, and from `scripts/fx-rates.ts`. NEVER on the
 * checkout path or the public config: a rate feed's bad afternoon must not
 * slow a page a shopper is waiting on.
 *
 * DUE, NOT EVERY TIME. A feed row younger than `REFRESH_AFTER_MS` is left
 * alone, so a sweep every ten minutes fetches at most twice a day — and the
 * feeds publish daily. Staleness (168h by default) is the far wall; this runs
 * long before it.
 *
 * A HAND-SET ('manual') MULTIPLIER IS NEVER TOUCHED. The owner's margin
 * (`feed_margin_bps`) is baked in at write time, so the published number is
 * the charged number. The revision moves only when a stored number does.
 *
 * NEVER THROWS. Every failure is an answer (`error`), because the sweep that
 * calls this is also settling payments.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const REFRESH_AFTER_MS = 12 * 3_600_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface Feed {
  source: string;
  /** Units of each currency per ONE naira — exactly the multiplier, unscaled. */
  perNaira: Record<string, number>;
}

export interface RateRefresh {
  /** True when nothing was due and no feed was asked. */
  skipped: boolean;
  source: string | null;
  /** Stored, and the number moved (the revision did too). */
  refreshed: string[];
  /** Stored, same number (only the age moved). */
  unchanged: string[];
  /** Left alone: set by hand. */
  manual: string[];
  /** The feed had no rate for these. */
  missing: string[];
  error: string | null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/*
 * THE NETWORK SEAM, for tests that drive the real `createApp()` (the sweep,
 * the refresh button) and must never reach a real rate feed. Resolved at call
 * time, so a later `setFeedFetch(null)` restores the real `fetch`.
 */
let feedFetchOverride: FetchLike | null = null;
export function setFeedFetch(impl: FetchLike | null): void {
  feedFetchOverride = impl;
}
const defaultFetch: FetchLike = (url, init) => (feedFetchOverride ?? fetch)(url, init);

async function openErApi(fetchImpl: FetchLike): Promise<Feed> {
  const res = await fetchImpl('https://open.er-api.com/v6/latest/NGN', {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`open.er-api ${res.status}`);
  const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (body.result !== 'success' || !body.rates) throw new Error('open.er-api: no rates');
  return { source: 'open.er-api.com', perNaira: body.rates };
}

async function currencyApi(fetchImpl: FetchLike): Promise<Feed> {
  const res = await fetchImpl(
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/ngn.json',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`currency-api ${res.status}`);
  const body = (await res.json()) as { ngn?: Record<string, number> };
  if (!body.ngn) throw new Error('currency-api: no rates');
  const perNaira: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.ngn)) perNaira[k.toUpperCase()] = v;
  return { source: 'currency-api (fawazahmed0)', perNaira };
}

/** The first feed that answers. Throws only when both fail. */
export async function fetchFeed(fetchImpl: FetchLike = defaultFetch): Promise<Feed> {
  try {
    return await openErApi(fetchImpl);
  } catch {
    return currencyApi(fetchImpl);
  }
}

/**
 * A feed's float as an exact ×10^12 integer, with the margin applied in
 * integers. `toFixed(12)` reads the decimal the feed sent without a
 * multiplication's rounding error reaching the last digits.
 */
export function feedValueToE12(value: number, marginBps: number): bigint | null {
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
  const [whole, frac = ''] = value.toFixed(12).split('.');
  const e12 = BigInt(whole) * 10n ** 12n + BigInt(frac.padEnd(12, '0'));
  const withMargin = (e12 * BigInt(10_000 + marginBps) + 5_000n) / 10_000n;
  return withMargin > 0n ? withMargin : null;
}

/**
 * Refresh every switched-on currency whose DAILY rate is due (or all of them,
 * `force`), from one feed call.
 */
export async function refreshFeedRates(
  db: Db,
  opts: { now?: number; force?: boolean; fetchImpl?: FetchLike; dueAfterMs?: number } = {},
): Promise<RateRefresh> {
  const now = opts.now ?? Date.now();
  const out: RateRefresh = {
    skipped: false,
    source: null,
    refreshed: [],
    unchanged: [],
    manual: [],
    missing: [],
    error: null,
  };
  try {
    const state = await readFxState(db, now);
    const targets = state.enabled.filter((c) => c !== state.storeCurrency);
    out.manual = targets.filter((c) => state.rates.get(c)?.source === 'manual');
    const dueAfter = opts.dueAfterMs ?? REFRESH_AFTER_MS;
    const work = targets.filter((c) => {
      const rate = state.rates.get(c);
      if (rate?.source === 'manual') return false;
      return opts.force || !rate || now - rate.updatedAt >= dueAfter;
    });
    if (work.length === 0) return { ...out, skipped: true };

    const feed = await fetchFeed(opts.fetchImpl ?? defaultFetch);
    out.source = feed.source;
    for (const code of work) {
      const e12 = feedValueToE12(feed.perNaira[code] as number, state.feedMarginBps);
      if (e12 === null) {
        out.missing.push(code);
        continue;
      }
      const written = await writeFeedMultiplier(db, code, e12, now);
      if (!written.written) out.manual.push(code); // turned manual between the read and the write
      else (written.bumped ? out.refreshed : out.unchanged).push(code);
    }
    return out;
  } catch (err) {
    // NAMES ONLY: a feed's error text is a third party's words, not ours to log.
    const error = err instanceof Error ? err.name : 'unknown';
    // eslint-disable-next-line no-console -- the only record that the daily rate did not refresh
    console.error('[currency] rate refresh failed', JSON.stringify({ error }));
    return { ...out, error: 'feed_unavailable' };
  }
}
