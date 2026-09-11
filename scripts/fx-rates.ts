/**
 * Refresh the daily exchange rates by hand — the same `refreshFeedRates` the
 * sweep runs every twelve hours and the admin's "Refresh rates now" button
 * calls, forced.
 *
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --check
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --enable=GHS
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --margin-bps=300
 *
 * `--check` prints what the feed says and writes nothing. `--enable=GHS,KES`
 * switches those currencies on first. `--margin-bps=300` STORES a 3% margin
 * on the daily rate (migration 1160) — stored, so the automatic refreshes keep
 * applying it — and then refreshes with it. Prove it against `.dev.env` first.
 *
 * A hand-set ('manual') multiplier is never overwritten.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../server/db/schema';
import type { Db } from '../server/db/client';
import { isKnownCurrency } from '../shared/commerce/currencies';
import { formatMultiplier } from '../shared/commerce/fx';
import { feedValueToE12, fetchFeed, refreshFeedRates } from '../server/shop/currency/feed';
import { readFxState } from '../server/shop/currency/state';

const CHECK = process.argv.includes('--check');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ENABLE = (arg('enable') ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const MARGIN = arg('margin-bps');

async function main() {
  for (const c of ENABLE) if (!isKnownCurrency(c)) throw new Error(`unknown currency: ${c}`);
  const margin = MARGIN === undefined ? null : Number(MARGIN);
  if (margin !== null && (!Number.isInteger(margin) || margin < 0 || margin > 5000)) {
    throw new Error('--margin-bps must be a whole number from 0 to 5000');
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { schema }) as unknown as Db;
  const now = Date.now();

  if (CHECK) {
    const state = await readFxState(db, now);
    const feed = await fetchFeed();
    const codes = [...new Set([...state.enabled, ...ENABLE])].filter((c) => c !== state.storeCurrency);
    const bps = margin ?? state.feedMarginBps;
    for (const code of codes) {
      const e12 = feedValueToE12(feed.perNaira[code] as number, bps);
      const kind = state.rates.get(code)?.source === 'manual' ? ' (set by hand — would be left alone)' : '';
      console.log(`${code}: 1 NGN = ${e12 === null ? 'no rate' : formatMultiplier(e12)} ${code}${kind}  (${feed.source}, margin ${bps} bps)`);
    }
    console.log('check only — nothing written');
    return;
  }

  if (ENABLE.length > 0) {
    await db.execute(sql`
      UPDATE shop_currency_settings
         SET enabled = (SELECT array_agg(DISTINCT c) FROM unnest(enabled || ${sql.param(ENABLE)}::text[]) AS c),
             revision = revision + 1, updated_at = ${now}
       WHERE id = 'main'`);
    console.log(`switched on: ${ENABLE.join(', ')}`);
  }
  if (margin !== null) {
    await db.execute(sql`UPDATE shop_currency_settings SET feed_margin_bps = ${margin}, updated_at = ${now} WHERE id = 'main'`);
    console.log(`margin on the daily rate: ${margin} bps`);
  }

  const result = await refreshFeedRates(db, { now, force: true });
  console.log(JSON.stringify(result));
  if (result.error) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
