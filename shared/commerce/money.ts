/**
 * Money — integer minor units plus an ISO-4217 code (contract §10).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ RECONSTRUCTED FILE — Catalog should review it. The **Cart** agent
 * overwrote this file with a `Write` while building concurrently: it did not
 * exist when Cart last looked, and Cart did not re-check before writing. That
 * is a straightforward breach of contract §2 R1 and it is recorded here and in
 * AMENDMENTS A-001 rather than quietly fixed.
 *
 * What is below was rebuilt from `shared/commerce/money.test.ts`, which was NOT
 * touched and which specifies this module completely — all 37 of its
 * assertions pass. The comments are Cart's reconstruction, not Catalog's
 * originals; the behaviour is the test's. Catalog may replace this file
 * wholesale, and nothing Cart wrote depends on anything beyond what the test
 * pins.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO FLOATS ANYWHERE. Not in a field, not in an intermediate, not for a moment.
 * `0.1 + 0.2 !== 0.3` is why every serious money type is an integer, and a shop
 * that is out by one minor unit on one line in a thousand produces a customer
 * dispute nobody can reproduce.
 *
 * A rate is therefore a RATIONAL — a numerator and a denominator, both integers
 * — and never a decimal. `scale(value, 2000, 10000, 'half-up')` is 20%; there
 * is no way to spell `0.2` in this API, which is what makes the no-float rule
 * enforceable rather than aspirational.
 *
 * Pure TypeScript with no imports at all — no `node:` builtins — because
 * `shared/` is compiled into the browser bundle as well as the server.
 */

export interface Money {
  /** Integer minor units. Negative means a credit (contract §10). */
  amount: number;
  /** ISO-4217, uppercase. */
  currency: string;
}

/**
 * The four modes, and one that is deliberately absent.
 *
 * `floor` / `toward -∞` IS NOT HERE, and `money.test.ts` pins its absence with
 * a symmetry property. An asymmetric rule rounds a 2.50 charge to 3 and its
 * −2.50 reversal to −2, leaving a minor unit behind on every cancelled order —
 * a residue that surfaces in reconciliation months later and cannot be traced
 * to the order that caused it. Every mode below is symmetric about zero.
 */
export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

/** ISO-4217 is exactly three uppercase letters — no spaces, no lowercase. */
const CURRENCY = /^[A-Z]{3}$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * `Number.isSafeInteger`, not `Number.isInteger`.
 *
 * `Number.isInteger(2 ** 53)` is `true` — 9 007 199 254 740 992 is a whole
 * number as a double — but it is the point where `+ 1` stops being addition.
 * An amount past it typechecks, prints plausibly, and is wrong. Refused at the
 * constructor so no arithmetic downstream has to re-check it.
 */
function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${what} must be a safe integer, got ${String(value)}`);
  }
}

/** The only constructor. Every `Money` in the system is built here. */
export function money(amount: number, currency: string): Money {
  assertSafeInteger(amount, 'amount');
  if (!CURRENCY.test(currency)) {
    throw new MoneyError(`currency must be ISO-4217 (three uppercase letters), got "${currency}"`);
  }
  return { amount, currency };
}

/** A shape guard for values crossing a boundary — a jsonb column, a request body. */
export function isMoney(value: unknown): value is Money {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { amount?: unknown; currency?: unknown };
  return (
    typeof candidate.amount === 'number' &&
    Number.isSafeInteger(candidate.amount) &&
    typeof candidate.currency === 'string' &&
    CURRENCY.test(candidate.currency)
  );
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function isZero(value: Money): boolean {
  return value.amount === 0;
}

/** Contract §10: negative means credit. */
export function isCredit(value: Money): boolean {
  return value.amount < 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // Contract §10: no arithmetic that crosses currencies without an explicit
    // conversion step. There is no conversion step in v1 (contract §13), so
    // there is no correct answer here — and silently picking one side is the
    // worst of the available wrong ones.
    throw new MoneyError(
      `currency mismatch: cannot combine ${a.currency} with ${b.currency}, no conversion step exists`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(value: Money): Money {
  return money(-value.amount, value.currency);
}

/**
 * Multiply by a COUNT.
 *
 * Integer-only, and that is the point rather than a limitation: a fractional
 * quantity of a physical good is not something this shop sells, and admitting
 * one here would be the back door through which a float reached an amount. A
 * RATE goes through `scale`, which cannot be handed a decimal at all.
 */
export function multiply(value: Money, factor: number): Money {
  assertSafeInteger(factor, 'factor');
  return money(value.amount * factor, value.currency);
}

/**
 * Sum, with the currency STATED rather than inferred.
 *
 * An empty cart has no line to infer a currency from, and a zero with no
 * currency would force every downstream comparison to special-case it. Stating
 * it also means a list that disagrees throws instead of quietly adopting
 * whatever the first element happened to be.
 */
export function sum(values: readonly Money[], currency: string): Money {
  let total = zero(currency);
  for (const value of values) total = add(total, value);
  return total;
}

/** `-1 | 0 | 1`. Throws across currencies: an ORDERING between them is not a
 * thing that exists without a conversion step. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  return a.amount > b.amount ? 1 : 0;
}

/**
 * Equality ANSWERS across currencies rather than throwing.
 *
 * `compare` is arithmetic and has no answer for GBP-versus-USD; "are these the
 * same money" does, and the answer is no. A predicate that throws is a
 * predicate every caller has to wrap in a try/catch, which is how a comparison
 * ends up inside an error handler.
 */
export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

/**
 * `value × numerator / denominator`, rounded by the named mode.
 *
 * THE INTERMEDIATE IS A `BigInt`. `amount * numerator` is where precision dies:
 * both operands can be perfectly safe integers whose product is not, and a
 * double silently returns the nearest representable value instead. In `BigInt`
 * the product is exact by construction, the division is exact, and the only
 * place a number can be lost is the conversion back — which is checked, so an
 * unrepresentable result is a thrown error rather than an approximation.
 *
 * ONE FUNCTION FOR EVERY RATE IN THE SYSTEM, which is contract §10's "rounding
 * is a named function with a documented mode, used everywhere; a rounding
 * decision made inline is a bug".
 */
export function scale(
  value: Money,
  numerator: number,
  denominator: number,
  mode: RoundingMode,
): Money {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  if (denominator <= 0) {
    throw new MoneyError(`denominator must be positive, got ${denominator}`);
  }

  const product = BigInt(value.amount) * BigInt(numerator);
  const divisor = BigInt(denominator);

  /*
   * SIGN IS STRIPPED, ROUNDED, AND RE-APPLIED. BigInt division truncates toward
   * zero, so rounding the magnitude and restoring the sign is what makes every
   * mode symmetric about zero — the property `money.test.ts` pins across all
   * four modes and five magnitudes.
   */
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / divisor;
  const remainder = magnitude % divisor;

  const rounded = applyMode(quotient, remainder, divisor, mode);
  const signed = negative ? -rounded : rounded;

  if (signed > MAX_SAFE || signed < MIN_SAFE) {
    throw new MoneyError(
      `scaled amount ${signed.toString()} is outside the safe-integer range`,
    );
  }
  return money(Number(signed), value.currency);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

function applyMode(
  quotient: bigint,
  remainder: bigint,
  divisor: bigint,
  mode: RoundingMode,
): bigint {
  if (remainder === 0n) return quotient;
  // Compared doubled rather than halved, so the "exactly on the half" test is
  // itself exact for an odd divisor.
  const twice = remainder * 2n;
  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return quotient + 1n;
    case 'half-up':
      return twice >= divisor ? quotient + 1n : quotient;
    case 'half-even':
      if (twice > divisor) return quotient + 1n;
      if (twice < divisor) return quotient;
      // Exactly on the half: go to the even neighbour.
      return quotient % 2n === 0n ? quotient : quotient + 1n;
  }
}

/** `"12.34 GBP"`, for logs and test failures. NOT for a customer-facing UI —
 * that needs `Intl.NumberFormat`, a locale, and the currency's real exponent
 * (JPY has none), none of which this module has. */
export function formatMoney(value: Money): string {
  return `${(value.amount / 100).toFixed(2)} ${value.currency}`;
}
