/**
 * Fetch today's exchange rates and store them as MULTIPLIERS — the hand-run
 * refresh behind the published currency config.
 *
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --check
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --enable=GHS
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --margin-bps=300
 *
 * `--check` prints what it would store and writes nothing. `--enable=GHS,KES`
 * also switches those currencies on; without it, the currencies already
 * switched on are refreshed. Prove it against `.dev.env` first.
 *
 * THE MULTIPLIER IS WHAT THE FEEDS ALREADY QUOTE: units of X per ONE naira.
 * No inversion, so nothing is lost to a reciprocal. Stored ×10^12 as an
 * integer (`shop_fx_rates.multiplier_e12`, migration 1140).
 *
 * `--margin-bps` IS THE OWNER'S MARGIN, BAKED IN AT WRITE TIME: 300 stores a
 * multiplier 3% higher, so a shopper pays 3% more in cedis for the same naira.
 * The published number is then the charged number — there is no hidden
 * buffer anywhere downstream.
 *
 * A HAND-SET ('manual') MULTIPLIER IS NEVER OVERWRITTEN. The revision moves
 * only when a stored number actually changes; the age refreshes either way.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../server/db/schema';
import type { Db } from '../server/db/client';
import { isKnownCurrency } from '../shared/commerce/currencies';
import { formatMultiplier } from '../shared/commerce/fx';
import { writeFeedMultiplier } from '../server/shop/currency/state';

const CHECK = process.argv.includes('--check');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ENABLE = (arg('enable') ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const MARGIN_BPS = Number(arg('margin-bps') ?? '0');

async function feedA(): Promise<{ source: string; perNaira: Record<string, number> }> {
  const res = await fetch('https://open.er-api.com/v6/latest/NGN');
  if (!res.ok) throw new Error(`open.er-api ${res.status}`);
  const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (body.result !== 'success' || !body.rates) throw new Error('open.er-api: no rates');
  return { source: 'open.er-api.com', perNaira: body.rates };
}

async function feedB(): Promise<{ source: string; perNaira: Record<string, number> }> {
  const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/ngn.json');
  if (!res.ok) throw new Error(`currency-api ${res.status}`);
  const body = (await res.json()) as { ngn?: Record<string, number> };
  if (!body.ngn) throw new Error('currency-api: no rates');
  const perNaira: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.ngn)) perNaira[k.toUpperCase()] = v;
  return { source: 'currency-api (fawazahmed0)', perNaira };
}

/**
 * A feed's float, as an exact ×10^12 integer, with the margin applied in
 * integers. `toFixed(12)` reads the decimal the feed sent without a
 * multiplication's rounding error creeping into the last digits.
 */
function toE12(value: number, marginBps: number): bigint {
  const [whole, frac = ''] = value.toFixed(12).split('.');
  const e12 = BigInt(whole) * 10n ** 12n + BigInt(frac.padEnd(12, '0'));
  const withMargin = (e12 * BigInt(10_000 + marginBps) + 5_000n) / 10_000n;
  if (withMargin <= 0n) throw new Error('multiplier rounds to zero');
  return withMargin;
}

async function main() {
  for (const c of ENABLE) if (!isKnownCurrency(c)) throw new Error(`unknown currency: ${c}`);
  if (!Number.isInteger(MARGIN_BPS) || MARGIN_BPS < 0 || MARGIN_BPS > 5000) {
    throw new Error('--margin-bps must be a whole number from 0 to 5000');
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { schema }) as unknown as Db;

  const row = (await db.execute(sql`
    SELECT store_currency, enabled, revision FROM shop_currency_settings WHERE id = 'main'`)).rows[0] as
    | { store_currency: string; enabled: string[]; revision: number }
    | undefined;
  if (!row) throw new Error('shop_currency_settings has no main row — is migration 1140 applied?');
  const store = String(row.store_currency);
  const enabled = [...new Set([...(row.enabled ?? []).map(String), ...ENABLE])];
  const wanted = enabled.filter((c) => c !== store);
  if (wanted.length === 0) {
    console.log('Nothing to refresh: only the store currency is switched on. Pass --enable=GHS.');
    return;
  }

  let feed;
  try {
    feed = await feedA();
  } catch (e) {
    console.log(`first feed failed (${(e as Error).message}), trying the second`);
    feed = await feedB();
  }

  const now = Date.now();
  for (const currency of wanted) {
    const value = feed.perNaira[currency];
    if (!(typeof value === 'number' && value > 0 && Number.isFinite(value))) {
      console.log(`${currency}: no rate in ${feed.source}, skipped`);
      continue;
    }
    const e12 = toE12(value, MARGIN_BPS);
    const margin = MARGIN_BPS ? ` (+${MARGIN_BPS / 100}% margin)` : '';
    console.log(`${currency}: 1 NGN = ${formatMultiplier(e12)} ${currency}${margin}  (${feed.source})`);
    if (CHECK) continue;
    const r = await writeFeedMultiplier(db, currency, e12, now);
    if (!r.written) console.log(`  ${currency} is set by hand — left alone`);
    else if (r.bumped) console.log('  stored; revision moved');
    else console.log('  stored; number unchanged');
  }

  if (!CHECK && ENABLE.length > 0) {
    await db.execute(sql`
      UPDATE shop_currency_settings
         SET enabled = ${sql.param(enabled)}::text[], revision = revision + 1, updated_at = ${now}
       WHERE id = 'main'`);
    console.log(`switched on: ${enabled.join(', ')}`);
  }
  console.log(CHECK ? 'check only — nothing written' : 'done');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
