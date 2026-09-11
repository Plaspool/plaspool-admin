/**
 * Fetch today's exchange rates and store them — the hand-run refresh until the
 * sweep does it on its own.
 *
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --check
 *     npx tsx --env-file=../../../.dev.env scripts/fx-rates.ts --enable=GHS
 *
 * `--check` prints the rates and writes nothing. `--enable=GHS,KES` also
 * switches those currencies on for shoppers; without it, the currencies
 * already switched on are refreshed. Prove it against `.dev.env` first.
 *
 * TWO FREE FEEDS, THE SECOND ONLY IF THE FIRST FAILS. Both quote "units of X
 * per ONE naira", so naira per unit is 1 / value, stored ×1e6 as an integer.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../server/db/schema';
import type { Db } from '../server/db/client';
import { isKnownCurrency } from '../shared/commerce/currencies';

const CHECK = process.argv.includes('--check');
const enableArg = process.argv.find((a) => a.startsWith('--enable='));
const ENABLE = enableArg
  ? enableArg.slice('--enable='.length).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  : [];

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

async function main() {
  for (const c of ENABLE) if (!isKnownCurrency(c)) throw new Error(`unknown currency: ${c}`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url), { schema }) as unknown as Db;

  const row = (await db.execute(sql`
    SELECT store_currency, enabled FROM shop_currency_settings WHERE id = 'main'`)).rows[0] as
    | { store_currency: string; enabled: string[] }
    | undefined;
  if (!row) throw new Error('shop_currency_settings has no main row — is migration 1120 applied?');
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
    const ratePpm = Math.round(1_000_000 / value);
    console.log(`${currency}: 1 ${currency} = NGN ${(ratePpm / 1e6).toFixed(4)}  (${feed.source})`);
    if (CHECK) continue;
    await db.execute(sql`
      INSERT INTO shop_fx_rates (currency, rate_ppm, fetched_at, source)
      VALUES (${currency}, ${ratePpm}, ${now}, ${feed.source})
      ON CONFLICT (currency) DO UPDATE
        SET rate_ppm = EXCLUDED.rate_ppm, fetched_at = EXCLUDED.fetched_at, source = EXCLUDED.source`);
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
