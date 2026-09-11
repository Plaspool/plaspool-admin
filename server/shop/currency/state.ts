import { sql } from 'drizzle-orm';
import { CURRENCY_EXPONENT, exponentOf, isKnownCurrency } from '../../../shared/commerce/currencies';
import {
  BASE_CURRENCY,
  IDENTITY_E12,
  currencyForCountry,
  formatMultiplier,
  type ChargeRates,
} from '../../../shared/commerce/fx';
import { StaleWriteError } from '../../repo/errors';
import { providerCeilings } from '../payments/config';
import { gatewayCurrencies } from '../payments/routing';
import { readPaymentSettings } from '../payments/settings';
import type { Db } from '../../db/client';

/**
 * THE PUBLISHED NUMBERS — what the storefront multiplies by, and what a
 * payment link converts with. One reader, so the two can never be built from
 * different rows.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `revision` IS THE HANDSHAKE. It moves on every change that alters a
 * converted number — a multiplier written (feed or manual), a currency
 * switched on or off, a variant multiplier edited, the country map edited —
 * and the payment route refuses a storefront that displayed an older one
 * (409 `rates_changed`). Every write below bumps it IN THE SAME STATEMENT as
 * the change, so there is no instant at which a number moved and the revision
 * did not.
 *
 * A currency going STALE moves no number, so it bumps nothing: it simply
 * stops being offered, and the payment route's currency check catches a
 * storefront still showing it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type RateSource = 'feed' | 'manual';

export interface FxRate {
  currency: string;
  multiplierE12: bigint;
  source: RateSource;
  updatedAt: number;
}

/** Why a switched-on currency is not offered. `null` when it is. */
export type NotOfferedReason = 'disabled' | 'no_rate' | 'stale' | 'no_gateway' | 'unknown_currency';

export interface FxState {
  storeCurrency: string;
  enabled: string[];
  stalenessHours: number;
  revision: number;
  countries: Record<string, string>;
  fallbackCurrency: string;
  /** The owner's margin on the daily rate, baked in as each feed multiplier is written (1160). */
  feedMarginBps: number;
  rates: Map<string, FxRate>;
  /** currency → variantId → multiplier. */
  variantMultipliers: Map<string, Map<string, bigint>>;
  /** Currencies some gateway can charge (`routing.ts`'s intersection rule). */
  chargeable: Set<string>;
  /** enabled ∩ fresh multiplier ∩ chargeable, store currency first and always. */
  offered: string[];
  updatedAt: number;
  now: number;
}

const SETTINGS_ID = 'main';
const HOUR_MS = 3_600_000;

/** A `bigint` column: Neon answers a string, PGlite a number or bigint. */
function big(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.round(value));
  return BigInt(String(value));
}

function countriesOf(value: unknown): Record<string, string> {
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[A-Z]{2}$/.test(k) && typeof v === 'string' && /^[A-Z]{3}$/.test(v)) out[k] = v;
    }
  }
  return out;
}

/** Why `code` is or is not offered right now. */
export function notOfferedReason(state: Omit<FxState, 'offered'>, code: string): NotOfferedReason | null {
  if (code === state.storeCurrency) return null;
  if (!isKnownCurrency(code)) return 'unknown_currency';
  if (!state.enabled.includes(code)) return 'disabled';
  const rate = state.rates.get(code);
  if (!rate) return 'no_rate';
  if (rate.source === 'feed' && state.now - rate.updatedAt > state.stalenessHours * HOUR_MS) return 'stale';
  if (!state.chargeable.has(code)) return 'no_gateway';
  return null;
}

/**
 * Everything published, read once. NEVER THROWS for a missing settings row:
 * that is the naira-only shop, which is what it was before any of this.
 */
export async function readFxState(db: Db, now: number = Date.now()): Promise<FxState> {
  const [settingsRes, ratesRes, variantsRes, payments] = await Promise.all([
    db.execute(sql`
      SELECT store_currency, enabled, staleness_hours, revision, country_currency,
             fallback_currency, updated_at, feed_margin_bps
        FROM shop_currency_settings WHERE id = ${SETTINGS_ID}`),
    db.execute(sql`SELECT currency, multiplier_e12, source, updated_at FROM shop_fx_rates`),
    db.execute(sql`SELECT variant_id, currency, multiplier_e12, updated_at FROM shop_variant_multipliers`),
    readPaymentSettings(db),
  ]);

  const s = settingsRes.rows[0] as Record<string, unknown> | undefined;
  const storeCurrency = String(s?.store_currency ?? BASE_CURRENCY);
  let updatedAt = Number(s?.updated_at ?? 0);

  const rates = new Map<string, FxRate>();
  for (const r of ratesRes.rows as Record<string, unknown>[]) {
    const rate: FxRate = {
      currency: String(r.currency),
      multiplierE12: big(r.multiplier_e12),
      source: r.source === 'manual' ? 'manual' : 'feed',
      updatedAt: Number(r.updated_at),
    };
    rates.set(rate.currency, rate);
    updatedAt = Math.max(updatedAt, rate.updatedAt);
  }

  const variantMultipliers = new Map<string, Map<string, bigint>>();
  for (const r of variantsRes.rows as Record<string, unknown>[]) {
    const code = String(r.currency);
    if (!variantMultipliers.has(code)) variantMultipliers.set(code, new Map());
    variantMultipliers.get(code)!.set(String(r.variant_id), big(r.multiplier_e12));
    updatedAt = Math.max(updatedAt, Number(r.updated_at));
  }

  const base: Omit<FxState, 'offered'> = {
    storeCurrency,
    enabled: Array.isArray(s?.enabled) ? (s!.enabled as unknown[]).map(String) : [storeCurrency],
    stalenessHours: Number(s?.staleness_hours ?? 168),
    revision: Number(s?.revision ?? 0),
    countries: countriesOf(s?.country_currency),
    fallbackCurrency: String(s?.fallback_currency ?? storeCurrency),
    feedMarginBps: Number(s?.feed_margin_bps ?? 0),
    rates,
    variantMultipliers,
    chargeable: gatewayCurrencies(payments.currencies, providerCeilings()),
    updatedAt,
    now,
  };
  const offered = [storeCurrency, ...base.enabled.filter((c) => c !== storeCurrency && notOfferedReason(base, c) === null)];
  return { ...base, offered };
}

/** The multiplier a currency charges at: 1 for the store currency. */
export function multiplierFor(state: FxState, code: string): bigint {
  if (code === state.storeCurrency) return IDENTITY_E12;
  const rate = state.rates.get(code);
  if (!rate) throw new Error(`no multiplier for ${code}`);
  return rate.multiplierE12;
}

/** Everything `chargeBreakdown` needs to charge in `code`. */
export function chargeRatesFor(state: FxState, code: string): ChargeRates {
  return {
    currency: code,
    multiplierE12: multiplierFor(state, code),
    variantMultipliers: state.variantMultipliers.get(code) ?? new Map(),
  };
}

/** The currency a shopper in `country` pays in — the storefront runs the same rule. */
export function chargeCurrencyFor(state: FxState, country: string | null): string {
  return currencyForCountry(country, state.countries, state.offered, state.fallbackCurrency);
}

/**
 * `GET /api/public/shop/currency-config`'s `config`. Keeps `currencies`,
 * `default` and `revision` exactly where the storefront already reads them.
 * Multipliers are STRINGS with twelve fractional digits — `multiplier_e12`
 * printed verbatim — never a JSON float that a parser could round.
 */
export function publicCurrencyConfig(state: FxState) {
  const rates: Record<string, { multiplier: string; exponent: number }> = {};
  const variantMultipliers: Record<string, Record<string, string>> = {};
  for (const code of state.offered) {
    rates[code] = { multiplier: formatMultiplier(multiplierFor(state, code)), exponent: exponentOf(code) };
    const overrides = state.variantMultipliers.get(code);
    if (code !== state.storeCurrency && overrides && overrides.size > 0) {
      variantMultipliers[code] = Object.fromEntries(
        [...overrides].map(([variantId, e12]) => [variantId, formatMultiplier(e12)]),
      );
    }
  }
  return {
    base: state.storeCurrency,
    revision: state.revision,
    default: state.storeCurrency,
    currencies: state.offered,
    rates,
    variantMultipliers,
    countries: state.countries,
    fallbackCurrency: state.fallbackCurrency,
    updatedAt: state.updatedAt,
  };
}

export type PublicCurrencyConfig = ReturnType<typeof publicCurrencyConfig>;

// ───────────────────────────────────────────────────────────────── writes

/** The one revision bump, as a statement fragment every write embeds. */
const bump = (now: number) => sql`
  UPDATE shop_currency_settings
     SET revision = revision + 1, updated_at = ${now}
   WHERE id = ${SETTINGS_ID}
  RETURNING revision`;

/**
 * A FEED multiplier. NEVER OVERWRITES A MANUAL ONE — the owner's hand-set
 * number stands until they clear it. The age always refreshes (that is what
 * staleness measures); the revision moves only when the number did.
 */
export async function writeFeedMultiplier(
  db: Db,
  currency: string,
  e12: bigint,
  now: number = Date.now(),
): Promise<{ written: boolean; bumped: boolean }> {
  const res = await db.execute(sql`
    WITH prev AS (
      SELECT multiplier_e12 FROM shop_fx_rates WHERE currency = ${currency}
    ),
    up AS (
      INSERT INTO shop_fx_rates (currency, multiplier_e12, source, updated_at)
      VALUES (${currency}, ${e12.toString()}::bigint, 'feed', ${now})
      ON CONFLICT (currency) DO UPDATE
         SET multiplier_e12 = EXCLUDED.multiplier_e12, updated_at = EXCLUDED.updated_at
       WHERE shop_fx_rates.source = 'feed'
      RETURNING multiplier_e12
    ),
    bumped AS (
      UPDATE shop_currency_settings
         SET revision = revision + 1, updated_at = ${now}
       WHERE id = ${SETTINGS_ID}
         AND EXISTS (SELECT 1 FROM up)
         AND (SELECT multiplier_e12 FROM up) IS DISTINCT FROM (SELECT multiplier_e12 FROM prev)
      RETURNING revision
    )
    SELECT (SELECT count(*) FROM up)::int AS written, (SELECT count(*) FROM bumped)::int AS bumped`);
  const row = res.rows[0] ?? {};
  return { written: Number(row.written) > 0, bumped: Number(row.bumped) > 0 };
}

/** The owner's own multiplier. Never goes stale; a feed run never touches it. */
export async function setManualMultiplier(
  db: Db,
  currency: string,
  e12: bigint,
  now: number = Date.now(),
): Promise<void> {
  await db.execute(sql`
    WITH up AS (
      INSERT INTO shop_fx_rates (currency, multiplier_e12, source, updated_at)
      VALUES (${currency}, ${e12.toString()}::bigint, 'manual', ${now})
      ON CONFLICT (currency) DO UPDATE
         SET multiplier_e12 = EXCLUDED.multiplier_e12, source = 'manual', updated_at = EXCLUDED.updated_at
      RETURNING currency
    )
    ${bump(now)}`);
}

/** Forget a currency's multiplier — a manual one goes back to waiting for the feed. */
export async function clearMultiplier(db: Db, currency: string, now: number = Date.now()): Promise<void> {
  await db.execute(sql`
    WITH gone AS (DELETE FROM shop_fx_rates WHERE currency = ${currency} RETURNING currency)
    UPDATE shop_currency_settings
       SET revision = revision + 1, updated_at = ${now}
     WHERE id = ${SETTINGS_ID} AND EXISTS (SELECT 1 FROM gone)`);
}

/**
 * Which currencies are switched on. CAS on `revision`: two tabs editing the
 * list must not silently undo each other. The store currency is always in —
 * the database's own CHECK refuses a list without it.
 */
export async function setEnabledCurrencies(
  db: Db,
  enabled: readonly string[],
  baseRevision: number,
  userId: string | null,
  now: number = Date.now(),
): Promise<number> {
  const res = await db.execute(sql`
    UPDATE shop_currency_settings
       SET enabled = ${sql.param([...enabled])}::text[],
           revision = revision + 1, updated_at = ${now}, updated_by = ${userId}
     WHERE id = ${SETTINGS_ID} AND revision = ${baseRevision}
    RETURNING revision`);
  if (res.rows[0]) return Number(res.rows[0].revision);
  const cur = await db.execute(sql`SELECT revision FROM shop_currency_settings WHERE id = ${SETTINGS_ID}`);
  throw new StaleWriteError(baseRevision, Number(cur.rows[0]?.revision ?? 0));
}

/**
 * The owner's margin on the daily rate. Moves no number by itself — the
 * refresh that follows it (`feed.ts`) rewrites the feed multipliers, and that
 * write moves the revision. CAS on `revision`, like the currency list.
 */
export async function setFeedMargin(
  db: Db,
  marginBps: number,
  baseRevision: number,
  userId: string | null,
  now: number = Date.now(),
): Promise<void> {
  const res = await db.execute(sql`
    UPDATE shop_currency_settings
       SET feed_margin_bps = ${marginBps}, updated_at = ${now}, updated_by = ${userId}
     WHERE id = ${SETTINGS_ID} AND revision = ${baseRevision}
    RETURNING revision`);
  if (res.rows[0]) return;
  const cur = await db.execute(sql`SELECT revision FROM shop_currency_settings WHERE id = ${SETTINGS_ID}`);
  throw new StaleWriteError(baseRevision, Number(cur.rows[0]?.revision ?? 0));
}

/** One variant's multiplier for one currency; `null` removes the override. */
export async function setVariantMultiplier(
  db: Db,
  variantId: string,
  currency: string,
  e12: bigint | null,
  userId: string | null,
  now: number = Date.now(),
): Promise<void> {
  if (e12 === null) {
    await db.execute(sql`
      WITH gone AS (
        DELETE FROM shop_variant_multipliers
         WHERE variant_id = ${variantId} AND currency = ${currency}
        RETURNING variant_id
      )
      UPDATE shop_currency_settings
         SET revision = revision + 1, updated_at = ${now}
       WHERE id = ${SETTINGS_ID} AND EXISTS (SELECT 1 FROM gone)`);
    return;
  }
  await db.execute(sql`
    WITH up AS (
      INSERT INTO shop_variant_multipliers (variant_id, currency, multiplier_e12, updated_at, updated_by)
      VALUES (${variantId}, ${currency}, ${e12.toString()}::bigint, ${now}, ${userId})
      ON CONFLICT (variant_id, currency) DO UPDATE
         SET multiplier_e12 = EXCLUDED.multiplier_e12, updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by
      RETURNING variant_id
    )
    ${bump(now)}`);
}

/** A variant's overrides, for the variant editor. */
export async function variantMultipliersFor(
  db: Db,
  variantId: string,
): Promise<Array<{ currency: string; multiplier: string; updatedAt: number }>> {
  const res = await db.execute(sql`
    SELECT currency, multiplier_e12, updated_at FROM shop_variant_multipliers
     WHERE variant_id = ${variantId} ORDER BY currency`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    currency: String(r.currency),
    multiplier: formatMultiplier(big(r.multiplier_e12)),
    updatedAt: Number(r.updated_at),
  }));
}

/** Every currency this codebase knows the exponent of — what the admin may switch on. */
export const KNOWN_CURRENCIES: readonly string[] = Object.keys(CURRENCY_EXPONENT);
