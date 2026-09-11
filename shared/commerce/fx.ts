import { exponentOf } from './currencies';

/**
 * THE ONE CONVERSION — naira into another currency, at a published multiplier.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NAIRA IS THE ONLY REAL PRICE IN THE SHOP (owner, 2026-09-11). Carts,
 * catalogue, shipping, add-ons, bulk tiers, points, codes and order totals are
 * naira, always. Other currencies are MULTIPLIERS — target-currency units per
 * one naira — that the storefront applies itself for display, and a non-naira
 * amount becomes real money only when the payment link is created.
 *
 * So the storefront and this backend must produce IDENTICAL numbers, and the
 * only way two codebases do that is one formula over one set of published
 * integers:
 *
 *   target_minor = round_half_away_from_zero(
 *                    ngn_minor × multiplier_e12 × 10^exp(target) / 10^(exp(NGN) + 12))
 *
 * In BigInt, never floats — `0.1 + 0.2` is how two sides disagree by a pesewa.
 * NO ROUNDING BEYOND THE CURRENCY'S SMALLEST UNIT and NO HIDDEN BUFFER: a
 * margin, if the owner wants one, is baked into the stored multiplier, so the
 * published number IS the charged number.
 *
 * The storefront runs the same test vectors (`fx.test.ts`). Change this file
 * and theirs in the same breath, or not at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The shop's only real currency. Every amount converted here starts in it. */
export const BASE_CURRENCY = 'NGN';

const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

/** A multiplier as published: exactly twelve fractional digits, `"0.008496176720"`. */
const MULTIPLIER_TEXT = /^(\d{1,7})(?:\.(\d{1,12}))?$/;

/** `8496176720n` → `"0.008496176720"`. Verbatim, never through a float. */
export function formatMultiplier(e12: bigint): string {
  if (e12 <= 0n) throw new Error('multiplier must be positive');
  const whole = e12 / SCALE;
  const frac = (e12 % SCALE).toString().padStart(SCALE_DIGITS, '0');
  return `${whole}.${frac}`;
}

/**
 * `"0.00849617672"` → `8496176720n`. Accepts up to twelve fractional digits
 * and pads; refuses anything else (a sign, an exponent, a thirteenth digit)
 * rather than rounding it — an input that does not fit is a mistake to show,
 * not a number to guess at.
 */
export function parseMultiplier(text: string): bigint {
  const m = MULTIPLIER_TEXT.exec(text.trim());
  if (!m) throw new Error('multiplier must be a positive decimal with at most 12 fractional digits');
  const e12 = BigInt(m[1]) * SCALE + BigInt((m[2] ?? '').padEnd(SCALE_DIGITS, '0'));
  if (e12 <= 0n) throw new Error('multiplier must be positive');
  return e12;
}

/** Store currency's own multiplier: exactly 1. */
export const IDENTITY_E12 = SCALE;

/**
 * A naira minor amount in `target`'s minor units. Pure, exact, and the only
 * implementation of the formula in this codebase.
 *
 *   num = |ngn| × m_e12 × 10^exp_t ;  den = 10^(exp_NGN + 12)
 *   q   = (2·num + den) / (2·den)          — half away from zero, in integers
 *   result = sign(ngn) × q
 */
export function convertMinor(ngnMinor: number, multiplierE12: bigint, target: string): number {
  if (!Number.isSafeInteger(ngnMinor)) throw new Error('amount must be a safe integer');
  if (multiplierE12 <= 0n) throw new Error('multiplier must be positive');
  if (ngnMinor === 0) return 0;
  const sign = ngnMinor < 0 ? -1n : 1n;
  const num = BigInt(Math.abs(ngnMinor)) * multiplierE12 * 10n ** BigInt(exponentOf(target));
  const den = 10n ** BigInt(exponentOf(BASE_CURRENCY) + SCALE_DIGITS);
  const q = (2n * num + den) / (2n * den);
  const result = Number(sign * q);
  if (!Number.isSafeInteger(result)) throw new Error('converted amount out of safe range');
  return result === 0 ? 0 : result; // never -0
}

// ─────────────────────────────────────────────────────────── the breakdown

/** Which multipliers apply: the currency's, and any per-variant overrides. */
export interface ChargeRates {
  currency: string;
  multiplierE12: bigint;
  /** Per-variant overrides FOR THIS CURRENCY. Replaces `multiplierE12` on that variant's lines. */
  variantMultipliers: ReadonlyMap<string, bigint>;
}

export type ChargeComponentKind = 'line' | 'discount' | 'adjustment' | 'addOn' | 'shipping' | 'tax';

export interface ChargeComponent {
  kind: ChargeComponentKind;
  /** `variantId` for a line, the code for an adjustment, the add-on id; null otherwise. */
  ref: string | null;
  /** The naira figure, minor units, exactly as frozen. */
  ngnMinor: number;
  /** The multiplier used, as published (twelve fractional digits). */
  multiplier: string;
  /** The converted figure, minor units of the charge currency. */
  amount: number;
}

export interface ChargeBreakdown {
  currency: string;
  exponent: number;
  /**
   * The CURRENCY's multiplier at the time of the charge — what every
   * non-line component used, and what a partial refund converts with later
   * (never today's rate).
   */
  multiplier: string;
  /** Σ component amounts. THE charged total — never a converted naira total. */
  amount: number;
  /** The naira grand total the components came from. */
  ngnTotal: number;
  components: ChargeComponent[];
}

/**
 * The frozen naira totals, as much of them as the breakdown reads. Structural,
 * so `FrozenTotals` (ports.ts) and a parsed jsonb payload both fit.
 */
export interface BreakdownTotals {
  lines: ReadonlyArray<{ variantId: string; lineTotal: { amount: number } }>;
  shipping: { amount: { amount: number } } | null;
  shippingTotal?: { amount: number };
  discountTotal?: { amount: number };
  adjustments: ReadonlyArray<{ code: string; amount: { amount: number } }>;
  addOns?: ReadonlyArray<{ id: string; amount: { amount: number } }>;
  taxTotal: { amount: number };
  grandTotal: { amount: number };
}

/**
 * THE CONTRACT: what a non-naira payment link charges, component by component.
 *
 * CONVERT EACH COMPONENT, THEN ADD. NEVER CONVERT A NAIRA TOTAL. The components
 * are exactly the figures the storefront shows separately, so the total it
 * shows is the sum of what it converted — and the gateway is asked for the
 * same sum. (Three spools, shipping and points at GHS 0.008496176720 sum to
 * 70772 pesewas; converting the naira total gives 70773, which neither side
 * displayed.)
 *
 *   - each line's `lineTotal` — AFTER bulk discount, never unit × qty — at the
 *     variant's override for this currency if one exists, else the currency's;
 *   - the discount code's `discountTotal`, negative;
 *   - each adjustment (points), negative;
 *   - each add-on;
 *   - shipping;
 *   - tax, if any.
 *
 * Everything but a line uses the currency's multiplier. Zero components are
 * omitted: they convert to zero and the storefront shows no row for them.
 *
 * THE NAIRA COMPONENTS MUST SUM TO THE NAIRA GRAND TOTAL, and this refuses a
 * totals object where they do not — that is a shape this function does not
 * understand, and charging it would be guessing.
 */
export function chargeBreakdown(totals: BreakdownTotals, rates: ChargeRates): ChargeBreakdown {
  const base = rates.multiplierE12;
  const components: ChargeComponent[] = [];
  const push = (kind: ChargeComponentKind, ref: string | null, ngnMinor: number, m: bigint) => {
    if (ngnMinor === 0) return;
    components.push({
      kind,
      ref,
      ngnMinor,
      multiplier: formatMultiplier(m),
      amount: convertMinor(ngnMinor, m, rates.currency),
    });
  };

  for (const line of totals.lines) {
    push('line', line.variantId, line.lineTotal.amount, rates.variantMultipliers.get(line.variantId) ?? base);
  }
  push('discount', null, totals.discountTotal?.amount ?? 0, base);
  for (const adj of totals.adjustments) push('adjustment', adj.code, adj.amount.amount, base);
  for (const addOn of totals.addOns ?? []) push('addOn', addOn.id, addOn.amount.amount, base);
  push('shipping', null, totals.shipping ? totals.shipping.amount.amount : (totals.shippingTotal?.amount ?? 0), base);
  push('tax', null, totals.taxTotal.amount, base);

  const ngnSum = components.reduce((s, c) => s + c.ngnMinor, 0);
  if (ngnSum !== totals.grandTotal.amount) {
    throw new Error(`charge breakdown does not cover the grand total (${ngnSum} vs ${totals.grandTotal.amount})`);
  }
  return {
    currency: rates.currency,
    exponent: exponentOf(rates.currency),
    multiplier: formatMultiplier(base),
    amount: components.reduce((s, c) => s + c.amount, 0),
    ngnTotal: totals.grandTotal.amount,
    components,
  };
}

// ────────────────────────────────────────────────── which currency to charge

/**
 * The currency a shopper in `country` pays in: the map's answer if it is
 * offered, else the fallback if IT is offered, else naira. The storefront
 * applies the same rule to the same published map, so the two agree.
 */
export function currencyForCountry(
  country: string | null,
  map: Readonly<Record<string, string>>,
  offered: readonly string[],
  fallback: string,
): string {
  const mapped = country ? map[country.toUpperCase()] : undefined;
  if (mapped && offered.includes(mapped)) return mapped;
  if (offered.includes(fallback)) return fallback;
  return BASE_CURRENCY;
}
