import { parseMultiplier } from '../../../shared/commerce/fx';
import type { CurrencySource, NotOfferedReason } from '../../data/api-currency';

/**
 * Plain words for currencies and their multipliers — shared by the Payments
 * screen's two cards and the variant editor, so "cedis" is spelled one way.
 *
 * DISPLAY ONLY. The short forms below go through a float, which is fine for a
 * sentence a person reads and never fine for a number anything is charged at:
 * the exact twelve-digit string is always shown beside the short one, and the
 * wire only ever carries the text the owner typed.
 */

/**
 * Every currency either gateway's API can charge, in words. Anything not named
 * here still renders — as its own bare code — rather than disappearing.
 */
export const CURRENCY_NAME: Record<string, string> = {
  NGN: 'naira',
  USD: 'dollars',
  GBP: 'pounds',
  EUR: 'euros',
  GHS: 'cedis',
  KES: 'Kenyan shillings',
  UGX: 'Ugandan shillings',
  TZS: 'Tanzanian shillings',
  ZAR: 'rand',
  XOF: 'West African CFA francs',
  XAF: 'Central African CFA francs',
  RWF: 'Rwandan francs',
  ZMW: 'Zambian kwacha',
  EGP: 'Egyptian pounds',
};

export const currencyName = (code: string): string => CURRENCY_NAME[code] ?? code;

export const capFirst = (s: string): string =>
  s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);

/** "Cedis (GHS)". */
export const currencyLabel = (code: string): string => `${capFirst(currencyName(code))} (${code})`;

/** `"0.008496176720"` → `"0.00849617672"`; `"1.000000000000"` → `"1"`. Exact, string-only. */
export function trimMultiplier(multiplier: string): string {
  return multiplier.includes('.') ? multiplier.replace(/0+$/, '').replace(/\.$/, '') : multiplier;
}

/** Four significant figures, for a sentence: `"0.008496176720"` → `"0.008496"`. */
export function shortMultiplier(multiplier: string): string {
  const n = Number(multiplier);
  if (!Number.isFinite(n) || n <= 0) return multiplier;
  if (n >= 1000) return n.toLocaleString('en-NG', { maximumFractionDigits: 2 });
  const p = n.toPrecision(4);
  if (p.includes('e')) return trimMultiplier(multiplier);
  return p.includes('.') ? p.replace(/0+$/, '').replace(/\.$/, '') : p;
}

/** "1 naira = 0.008496 cedis". */
export function rateSentence(code: string, multiplier: string): string {
  return `1 naira = ${shortMultiplier(multiplier)} ${currencyName(code)}`;
}

/** "1 GHS = ₦117.70" — the same rate the other way round, the way people quote it. */
export function inverseSentence(code: string, multiplier: string): string | null {
  const n = Number(multiplier);
  if (!Number.isFinite(n) || n <= 0) return null;
  const naira = (1 / n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `1 ${code} = ₦${naira}`;
}

/** `null` when the text is a rate the server will take; otherwise what to fix. */
export function multiplierProblem(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Type a rate.';
  try {
    parseMultiplier(t);
    return null;
  } catch {
    return 'Use a number above zero with up to 12 digits after the point, like 0.0085.';
  }
}

export const SOURCE_LABEL: Record<CurrencySource, string> = {
  feed: 'Daily rate',
  manual: 'Set by hand',
};

/** "updated 3 hours ago". */
export function ageWords(ageHours: number | null): string | null {
  if (ageHours === null) return null;
  if (ageHours < 1) return 'updated less than an hour ago';
  if (ageHours < 48) return `updated ${ageHours} hour${ageHours === 1 ? '' : 's'} ago`;
  const days = Math.floor(ageHours / 24);
  return `updated ${days} days ago`;
}

/** "7 days" / "36 hours". */
export function hoursWords(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Why shoppers can't pay in it, in the owner's words. */
export const REASON_LABEL: Record<NotOfferedReason, string> = {
  disabled: 'Switched off',
  no_rate: 'No rate yet',
  stale: 'Rate out of date',
  no_gateway: 'No payment gateway takes it',
  unknown_currency: 'Not a currency the shop knows',
};
