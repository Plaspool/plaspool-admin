import { sql } from 'drizzle-orm';
import { exponentOf, isKnownCurrency } from '../../../shared/commerce/currencies';
import { BadRequestError } from '../../repo/errors';
import type { Db } from '../../db/client';
import type { CatalogPort } from '../cart/catalog-port';
import type { CheckoutConfig } from '../cart/checkout/repo';

/**
 * PAYING IN YOUR OWN CURRENCY — the one place a naira amount becomes another.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY AMOUNT IN THIS SHOP STARTS IN NAIRA. Catalogue prices, zone rates, the
 * courier's quote, add-ons, fixed discounts. So conversion happens ONCE, where
 * a naira amount enters a non-naira cart — `catalogIn` for product prices,
 * `toCurrency` for everything else — and `computeTotals` never learns that
 * currencies other than the cart's exist.
 *
 * That split is also the safety net. `money()` refuses to add two currencies,
 * so a naira amount that reaches a cedi cart WITHOUT going through here throws
 * instead of mispricing. A conversion someone forgets fails loudly.
 *
 * NEVER CALLS AN FX API. The rate is read from `shop_fx_rates`, which a sweep
 * refreshes. A rate feed's bad afternoon must not stop the shop taking money.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A 400 `{ error: 'bad_request', detail: 'currency_unavailable' }` through the
 *  shared error handler — the storefront already reads a 400 on a currency as
 *  "not offered, fall back to naira". */
export class CurrencyUnavailableError extends BadRequestError {
  readonly code = 'currency_unavailable';
  constructor(readonly currency: string, readonly reason: 'not_enabled' | 'no_rate' | 'stale' | 'unknown') {
    super('currency_unavailable');
    this.name = 'CurrencyUnavailableError';
  }
}

export interface CurrencySettings {
  storeCurrency: string;
  enabled: string[];
  bufferBps: number;
  stalenessHours: number;
  revision: number;
}

export interface PricingContext {
  storeCurrency: string;
  currency: string;
  /** Naira per ONE unit of `currency`, ×1e6. Null for a store-currency cart. */
  ratePpm: number | null;
  bufferBps: number;
  /** Hand-set prices in `currency`, by variant id. */
  overrides: ReadonlyMap<string, number>;
}

const FALLBACK: CurrencySettings = {
  storeCurrency: 'NGN',
  enabled: ['NGN'],
  bufferBps: 500,
  stalenessHours: 168,
  revision: 0,
};

/** The settings row, or today's shop (naira only) if it is not there yet. */
export async function readCurrencySettings(db: Db): Promise<CurrencySettings> {
  const res = await db.execute(sql`
    SELECT store_currency, enabled, buffer_bps, staleness_hours, revision
      FROM shop_currency_settings WHERE id = 'main'`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return FALLBACK;
  return {
    storeCurrency: String(r.store_currency ?? 'NGN'),
    enabled: Array.isArray(r.enabled) ? (r.enabled as unknown[]).map(String) : ['NGN'],
    bufferBps: Number(r.buffer_bps ?? 500),
    stalenessHours: Number(r.staleness_hours ?? 168),
    revision: Number(r.revision ?? 0),
  };
}

/** Currencies a shopper may pick right now: switched on AND a fresh rate. */
export async function offeredCurrencies(db: Db, now: number = Date.now()): Promise<CurrencySettings & { offered: string[] }> {
  const settings = await readCurrencySettings(db);
  const rates = await db.execute(sql`SELECT currency, fetched_at FROM shop_fx_rates`);
  const fresh = new Set<string>();
  const limit = settings.stalenessHours * 3_600_000;
  for (const row of rates.rows as Record<string, unknown>[]) {
    if (now - Number(row.fetched_at) <= limit) fresh.add(String(row.currency));
  }
  const offered = settings.enabled.filter(
    (c) => c === settings.storeCurrency || (isKnownCurrency(c) && fresh.has(c)),
  );
  if (!offered.includes(settings.storeCurrency)) offered.unshift(settings.storeCurrency);
  return { ...settings, offered };
}

/**
 * Everything a request needs to price in `currency`, loaded once. Throws
 * `CurrencyUnavailableError` if the currency is not switched on, has no rate,
 * or its rate is older than the staleness limit — a stale currency is
 * withdrawn, never priced at an old rate.
 */
export async function pricingContext(db: Db, currency: string, now: number = Date.now()): Promise<PricingContext> {
  const code = currency.trim().toUpperCase();
  const settings = await readCurrencySettings(db);
  const base = { storeCurrency: settings.storeCurrency, currency: code, bufferBps: settings.bufferBps };

  if (code === settings.storeCurrency) return { ...base, ratePpm: null, overrides: new Map() };
  if (!isKnownCurrency(code)) throw new CurrencyUnavailableError(code, 'unknown');
  if (!settings.enabled.includes(code)) throw new CurrencyUnavailableError(code, 'not_enabled');

  const rate = await db.execute(sql`SELECT rate_ppm, fetched_at FROM shop_fx_rates WHERE currency = ${code}`);
  const row = rate.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new CurrencyUnavailableError(code, 'no_rate');
  if (now - Number(row.fetched_at) > settings.stalenessHours * 3_600_000) {
    throw new CurrencyUnavailableError(code, 'stale');
  }

  const ov = await db.execute(sql`SELECT variant_id, amount_minor FROM shop_variant_prices WHERE currency = ${code}`);
  const overrides = new Map<string, number>();
  for (const o of ov.rows as Record<string, unknown>[]) overrides.set(String(o.variant_id), Number(o.amount_minor));

  return { ...base, ratePpm: Number(row.rate_ppm), overrides };
}

/**
 * `pricingContext`, minus the database read when the request is already in
 * the store currency — so a naira shopper's basket and checkout run exactly
 * the queries they ran before this feature existed.
 */
export async function contextFor(db: Db, currency: string, storeCurrency: string): Promise<PricingContext> {
  if (currency.trim().toUpperCase() === storeCurrency) {
    return { storeCurrency, currency: storeCurrency, ratePpm: null, bufferBps: 0, overrides: new Map() };
  }
  return pricingContext(db, currency);
}

/**
 * A store-currency amount, in the cart's currency. THE ONE CONVERSION.
 *
 *   major_target = (storeMinor / 10^exp(store)) × 1e6 / ratePpm × (1 + buffer)
 *   result       = ceil(major_target) whole units, in target minor units
 *
 * ROUNDS UP to a whole major unit, never nearest: the buffer is a floor under
 * margin and rounding must not eat into it. Done in BigInt so the division is
 * exact before the ceiling — float `/` then `Math.ceil` can land a unit high on
 * a value that should be exact.
 */
export function toCurrency(storeMinor: number, ctx: PricingContext): number {
  if (ctx.currency === ctx.storeCurrency || ctx.ratePpm === null) return storeMinor;
  if (storeMinor === 0) return 0;
  const sign = storeMinor < 0 ? -1n : 1n;
  const abs = BigInt(Math.abs(storeMinor));
  const storeScale = 10n ** BigInt(exponentOf(ctx.storeCurrency));
  const targetScale = 10n ** BigInt(exponentOf(ctx.currency));
  // major_target × 10000 × ratePpm = abs × 1e6 × (10000 + buffer) / storeScale
  // whole target units = ceil( abs × 1e6 × (10000 + buffer) / (storeScale × ratePpm × 10000) )
  const num = abs * 1_000_000n * BigInt(10_000 + ctx.bufferBps);
  const den = storeScale * BigInt(ctx.ratePpm) * 10_000n;
  const wholeUnits = (num + den - 1n) / den; // ceiling division
  const minor = wholeUnits * targetScale;
  return Number(sign * minor);
}

/** A variant's price in the cart's currency: hand-set if set, else converted. */
export function variantPriceIn(variantId: string, storeMinor: number, ctx: PricingContext): number {
  if (ctx.currency === ctx.storeCurrency) return storeMinor;
  const set = ctx.overrides.get(variantId);
  return set !== undefined ? set : toCurrency(storeMinor, ctx);
}

/**
 * A CatalogPort whose `quote()` prices come back in `ctx.currency`.
 *
 * A DECORATOR, the same shape as `scrubbedProvider` around a gateway: every
 * method passes through and only `quote().price` changes. Wrapping the port
 * means every existing `quote.price` reader — checkout lines, the basket view,
 * add-ons, courier rates — gets the converted price without being edited.
 */
export function catalogIn(catalog: CatalogPort, ctx: PricingContext): CatalogPort {
  if (ctx.currency === ctx.storeCurrency) return catalog;
  return {
    ...catalog,
    async quote(db, variantId) {
      const q = await catalog.quote(db, variantId);
      if (!q) return q;
      return { ...q, price: { amount: variantPriceIn(variantId, q.price.amount, ctx), currency: ctx.currency } };
    },
  };
}

/**
 * A catalogue variant as the storefront renders it, in `ctx.currency`. The
 * compare-at price converts too, and is dropped when a hand-set price has
 * reached it — "was GH₵90, now GH₵95" is not a sale.
 */
export function variantIn<
  V extends { id: string; price: { amount: number; currency: string } | null; compareAtMinor: number | null },
>(variant: V, ctx: PricingContext): V {
  if (ctx.currency === ctx.storeCurrency || variant.price === null) return variant;
  const amount = variantPriceIn(variant.id, variant.price.amount, ctx);
  const compare = variant.compareAtMinor === null ? null : toCurrency(variant.compareAtMinor, ctx);
  return {
    ...variant,
    price: { amount, currency: ctx.currency },
    compareAtMinor: compare !== null && compare > amount ? compare : null,
  };
}

/**
 * The checkout config, re-denominated for a non-naira cart: every zone's
 * delivery rate converted, the district override converted as it is read
 * (`fromStore`), and `storeCurrency` — which in `checkout/repo.ts` only ever
 * LABELS a shipping quote — set to the cart's currency.
 *
 * THE COURIER IS NOT HERE. Its quote is a naira amount carried inside the
 * option id; a non-naira cart is not offered it at all (the routes pass no
 * catalog to `shippingOffer`/`setShipping`), so it prices at the zone rate.
 */
export function configIn(config: CheckoutConfig, ctx: PricingContext): CheckoutConfig {
  if (ctx.currency === ctx.storeCurrency) return config;
  const convert = (storeMinor: number) => toCurrency(storeMinor, ctx);
  return {
    ...config,
    storeCurrency: ctx.currency,
    fromStore: convert,
    zones: config.zones.map((zone) => ({
      ...zone,
      options: zone.options.map((option) => ({ ...option, amountMinor: convert(option.amountMinor) })),
    })),
  };
}
