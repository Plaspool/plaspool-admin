/**
 * HOW MANY MINOR UNITS MAKE ONE MAJOR UNIT — per currency, never assumed.
 *
 * Every amount here is an integer in "minor units", and for naira that means
 * kobo, 100 to the naira. It is tempting to treat that as a law. It is not:
 * UGX, XOF, XAF and RWF have NO minor unit (ISO 4217 exponent 0), so for them
 * one "minor unit" IS one shilling or franc. Code that divides by 100 charges a
 * Ugandan shopper one hundredth of the price.
 *
 * AN UNKNOWN CODE THROWS. Guessing 2 for a currency nobody listed is exactly
 * the silent 100× error this table exists to prevent.
 */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  NGN: 2, GHS: 2, USD: 2, GBP: 2, EUR: 2, KES: 2, ZAR: 2, TZS: 2, ZMW: 2, EGP: 2,
  UGX: 0, XOF: 0, XAF: 0, RWF: 0,
});

export function isKnownCurrency(currency: string): boolean {
  return CURRENCY_EXPONENT[currency.toUpperCase()] !== undefined;
}

export function exponentOf(currency: string): number {
  const e = CURRENCY_EXPONENT[currency.toUpperCase()];
  if (e === undefined) throw new Error(`unknown currency exponent: ${currency}`);
  return e;
}

/** Minor units → the decimal a gateway that bills in major units wants. */
export function minorToMajor(minor: number, currency: string): number {
  if (!Number.isSafeInteger(minor)) throw new Error('minor amount must be a safe integer');
  return minor / 10 ** exponentOf(currency);
}

/** A gateway's major-unit decimal → our integer minor units. Rounds, because
 *  `19.99 * 100` is `1998.9999999999998` in IEEE-754 and must read as 1999. */
export function majorToMinor(major: number, currency: string): number {
  if (!Number.isFinite(major)) throw new Error('major amount must be finite');
  const minor = Math.round(major * 10 ** exponentOf(currency));
  if (!Number.isSafeInteger(minor)) throw new Error('minor amount out of safe range');
  return minor;
}
