import { money } from '../../../../shared/commerce/money';
import type { ShippingQuote, TaxRate } from '../../../../shared/commerce/ports';

/**
 * Shipping zones, their options, and the flat tax rate that goes with each.
 *
 * PURE CONFIGURATION PLUS PURE FUNCTIONS. Nothing here reads a database, a clock
 * or the network, because everything here is an INPUT to the totals engine and
 * the totals engine's defining property is that every input is passed in
 * (brief §5). A `zoneFor()` that queried a table would put a database inside the
 * one function that must not have one.
 *
 * TAX IS A FLAT RATE PER ZONE, AND THAT IS DELIBERATE, NOT LAZY. Contract §13
 * puts tax-as-a-service explicitly out of scope: "Real tax is a provider, and
 * choosing one is its own project." What matters is that the SEAM is a plain
 * `TaxRate` value, so replacing this file with a provider call is an
 * implementation swap and not a rewrite of the engine — brief §5's requirement,
 * met by making the rate an argument rather than a lookup.
 *
 * THE NUMBERS BELOW ARE PLACEHOLDERS AND ARE WRONG FOR ANY REAL SHOP. They are
 * shaped correctly and priced arbitrarily; a real deployment injects its own
 * `zones` through `ShopCartDeps`. Said out loud here because a hard-coded 20%
 * that nobody notices is hard-coded is precisely the class of thing GAUNTLET
 * keeps finding — a claim the code makes that nobody checked.
 */

export interface ShippingOptionConfig {
  id: string;
  label: string;
  /** Minor units, in the store currency. Integer. */
  amountMinor: number;
}

export interface ShippingZone {
  id: string;
  label: string;
  /** ISO-3166-1 alpha-2, uppercase. Ignored when `fallback` is true. */
  countries: readonly string[];
  /** Basis points. `2000` is 20%. */
  taxRateBps: number;
  taxLabel: string;
  /**
   * Whether delivery itself is taxed here. Explicit because the answer genuinely
   * differs by jurisdiction, and a system that assumed one way would be quietly
   * wrong in the other by a few pence on every order.
   */
  shippingTaxable: boolean;
  options: readonly ShippingOptionConfig[];
  /** Exactly one zone carries this. It matches every country no other zone claims. */
  fallback?: boolean;
}

/** Contract §13: one store currency, no conversion, no per-customer currency. */
export const DEFAULT_STORE_CURRENCY = 'GBP';

export const DEFAULT_SHIPPING_ZONES: readonly ShippingZone[] = [
  {
    id: 'domestic',
    label: 'United Kingdom',
    countries: ['GB'],
    taxRateBps: 2000,
    taxLabel: 'VAT',
    shippingTaxable: true,
    options: [
      { id: 'standard', label: 'Standard (3–5 days)', amountMinor: 399 },
      { id: 'express', label: 'Express (next day)', amountMinor: 799 },
    ],
  },
  {
    id: 'eu',
    label: 'Europe',
    countries: ['IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'SE', 'DK', 'PL'],
    // Zero, and not because Europe is untaxed: on an export the importing
    // country's authority collects, and this shop is not registered to collect
    // it. A shop that IS registered sets its own rate here.
    taxRateBps: 0,
    taxLabel: 'No VAT charged (export)',
    shippingTaxable: false,
    options: [{ id: 'standard', label: 'Standard (5–10 days)', amountMinor: 999 }],
  },
  {
    id: 'international',
    label: 'Rest of world',
    countries: [],
    taxRateBps: 0,
    taxLabel: 'No VAT charged (export)',
    shippingTaxable: false,
    options: [{ id: 'standard', label: 'Standard (10–20 days)', amountMinor: 1999 }],
    fallback: true,
  },
];

export class ShippingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShippingConfigError';
  }
}

/**
 * The zone a country ships to.
 *
 * AN UNMATCHED COUNTRY FALLS BACK; IT DOES NOT DEFAULT TO THE FIRST ZONE. Those
 * are different, and the difference is money: falling into `domestic` would
 * charge 20% VAT to a customer in a country this shop does not collect VAT for,
 * and would quote a £3.99 delivery for a parcel that costs £19.99 to send. The
 * fallback zone is declared rather than positional so reordering the list cannot
 * silently change what an unknown country is charged.
 *
 * A configuration with no fallback THROWS rather than picking one. A shop that
 * cannot price a destination must refuse the destination, not guess.
 */
export function zoneFor(zones: readonly ShippingZone[], countryCode: string): ShippingZone {
  const code = countryCode.trim().toUpperCase();
  const exact = zones.find((zone) => zone.countries.includes(code));
  if (exact) return exact;
  const fallback = zones.find((zone) => zone.fallback);
  if (!fallback) {
    throw new ShippingConfigError(
      `no zone covers ${code} and no fallback zone is configured`,
    );
  }
  return fallback;
}

/** The zone's options, priced in the store currency. */
export function shippingOptionsFor(
  zone: ShippingZone,
  currency: string,
): ShippingQuote[] {
  return zone.options.map((option) => ({
    id: option.id,
    label: option.label,
    amount: money(option.amountMinor, currency),
    taxable: zone.shippingTaxable,
  }));
}

/** One option by id, or `null` — an unknown id is the caller's 400, not a throw. */
export function shippingOptionById(
  zone: ShippingZone,
  currency: string,
  id: string,
): ShippingQuote | null {
  return shippingOptionsFor(zone, currency).find((option) => option.id === id) ?? null;
}

export function taxRateFor(zone: ShippingZone): TaxRate {
  return { zone: zone.id, label: zone.taxLabel, rateBps: zone.taxRateBps };
}

/**
 * The rate applied when no address has been given yet.
 *
 * ZERO, AND NAMED, so a totals preview before an address exists cannot silently
 * present a domestic-VAT figure that the real checkout then changes. A customer
 * who sees a number go UP at the last step abandons; one who sees tax appear
 * when they enter an address they know is taxed does not.
 */
export function unknownZoneTaxRate(): TaxRate {
  return { zone: 'unknown', label: 'Tax calculated at checkout', rateBps: 0 };
}
