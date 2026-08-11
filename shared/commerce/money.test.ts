import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  add,
  compare,
  equals,
  formatMoney,
  isCredit,
  isMoney,
  isZero,
  money,
  multiply,
  negate,
  scale,
  subtract,
  sum,
  zero,
} from './money';
import type { RoundingMode } from './money';

/**
 * Contract §10's money rules, as executable assertions.
 *
 * OWNERSHIP NOTE. §10 names Catalog as the author of `money.ts`. During the
 * concurrent build the file was created, replaced and converged on by more than
 * one agent (amendments A-008 and A-CAT-009); Catalog contributed this suite,
 * which the module did not have at any point. That is the useful half of the
 * ownership: `money.ts` is what all four subsystems compute totals with, and it
 * was shipping untested.
 *
 * The rules a TYPE cannot enforce are what earns the most here: an amount that
 * is not an integer, arithmetic that silently crosses currencies, and a rate
 * that arrives as a float.
 */

const gbp = (n: number) => money(n, 'GBP');

describe('money()', () => {
  it('accepts integer minor units and an ISO-4217 code', () => {
    expect(gbp(1999)).toEqual({ amount: 1999, currency: 'GBP' });
    expect(money(0, 'JPY')).toEqual({ amount: 0, currency: 'JPY' });
    // Negative means credit (contract §10), not an error.
    expect(money(-500, 'USD').amount).toBe(-500);
  });

  it.each([
    ['a fractional amount', 19.99],
    ['a float that looks whole', 0.1 + 0.2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past 2^53', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', (_name, amount) => {
    expect(() => money(amount, 'GBP')).toThrow(MoneyError);
  });

  it.each(['gbp', 'GB', 'GBPX', 'GBP ', '', '123', 'G8P'])(
    'refuses currency %o',
    (currency) => {
      expect(() => money(100, currency)).toThrow(MoneyError);
    },
  );
});

describe('isMoney()', () => {
  it('is true only for a validated shape', () => {
    expect(isMoney({ amount: 1, currency: 'GBP' })).toBe(true);
    expect(isMoney({ amount: 1.5, currency: 'GBP' })).toBe(false);
    expect(isMoney({ amount: 1, currency: 'gbp' })).toBe(false);
    expect(isMoney({ amount: '1', currency: 'GBP' })).toBe(false);
    expect(isMoney(null)).toBe(false);
    expect(isMoney(undefined)).toBe(false);
    expect(isMoney(100)).toBe(false);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within one currency', () => {
    expect(add(gbp(1999), gbp(1))).toEqual(gbp(2000));
    expect(subtract(gbp(1999), gbp(2000))).toEqual(gbp(-1));
    expect(negate(gbp(250))).toEqual(gbp(-250));
  });

  it('REFUSES TO CROSS CURRENCIES — the rule a type cannot enforce', () => {
    // Contract §13 rules multi-currency out of v1, so there is no conversion
    // step and therefore no correct answer. Silently picking a side would be
    // the worst of the available wrong answers.
    expect(() => add(gbp(100), money(100, 'USD'))).toThrow(MoneyError);
    expect(() => subtract(gbp(100), money(100, 'EUR'))).toThrow(MoneyError);
    expect(() => compare(gbp(100), money(100, 'USD'))).toThrow(MoneyError);
    // `equals` is a QUESTION, not arithmetic, so it answers rather than throws.
    expect(equals(gbp(100), money(100, 'USD'))).toBe(false);
    expect(equals(gbp(100), gbp(100))).toBe(true);
  });

  it('multiplies by an integer count and refuses a rate', () => {
    expect(multiply(gbp(1999), 3)).toEqual(gbp(5997));
    expect(multiply(gbp(1999), 0)).toEqual(gbp(0));
    // A fractional quantity of a physical good is not a thing this shop sells,
    // and it is the back door a float would reach an amount through.
    expect(() => multiply(gbp(1999), 1.5)).toThrow(MoneyError);
  });

  it('overflows loudly rather than silently', () => {
    // 2^53 is where `+` stops being addition. A wrong total that typechecks is
    // worse than a thrown error on a path no shop reaches.
    expect(() => multiply(money(Number.MAX_SAFE_INTEGER, 'GBP'), 2)).toThrow(MoneyError);
    expect(() => add(money(Number.MAX_SAFE_INTEGER, 'GBP'), gbp(1))).toThrow(MoneyError);
  });

  it('sums an empty list into the currency it was GIVEN, not one it inferred', () => {
    // An empty cart has no line to infer a currency from, and a zero with no
    // currency would force every downstream comparison to special-case it.
    expect(sum([], 'GBP')).toEqual(zero('GBP'));
    expect(sum([gbp(1), gbp(2), gbp(3)], 'GBP')).toEqual(gbp(6));
    expect(() => sum([gbp(1), money(2, 'USD')], 'GBP')).toThrow(MoneyError);
  });

  it('answers the small predicates', () => {
    expect(isZero(zero('GBP'))).toBe(true);
    expect(isCredit(gbp(-1))).toBe(true);
    expect(isCredit(gbp(0))).toBe(false);
    expect(compare(gbp(1), gbp(2))).toBe(-1);
    expect(compare(gbp(2), gbp(1))).toBe(1);
    expect(compare(gbp(2), gbp(2))).toBe(0);
  });
});

describe('scale()', () => {
  it('applies a rational rate with no float anywhere', () => {
    // 20% VAT on £19.99 is 399.8 pence.
    expect(scale(gbp(1999), 2000, 10000, 'half-up')).toEqual(gbp(400));
    expect(scale(gbp(1999), 2000, 10000, 'down')).toEqual(gbp(399));
  });

  /** `value × 1 / denominator`, per mode. Written out; no arithmetic in the table. */
  it.each<[number, number, RoundingMode, number]>([
    // 5/2 = 2.5 — exactly on the half, which is where the four modes differ.
    [5, 2, 'half-up', 3],
    [5, 2, 'half-even', 2], // 2 is the even neighbour
    [5, 2, 'down', 2],
    [5, 2, 'up', 3],
    // 7/2 = 3.5 — half-even goes UP here, to the even 4. That the two half
    // modes differ per case is the whole reason the mode has to be named.
    [7, 2, 'half-up', 4],
    [7, 2, 'half-even', 4],
    [7, 2, 'down', 3],
    [7, 2, 'up', 4],
    // 49/20 = 2.45 — below the half, so only `up` moves it.
    [49, 20, 'half-up', 2],
    [49, 20, 'half-even', 2],
    [49, 20, 'down', 2],
    [49, 20, 'up', 3],
    // 40/20 = 2 exactly — no remainder, so no mode may change it.
    [40, 20, 'half-up', 2],
    [40, 20, 'up', 2],
  ])('%d/%d under %s is %d', (value, denominator, mode, expected) => {
    expect(scale(gbp(value), 1, denominator, mode).amount).toBe(expected);
  });

  it('is SYMMETRIC ABOUT ZERO in every mode, so a refund reverses its charge', () => {
    /*
     * The property that makes credit safe. An asymmetric rule (floor toward
     * −∞) rounds a £2.50 charge to £3 and its −£2.50 reversal to −£2, leaving a
     * penny behind on every cancelled order — the kind of residue that surfaces
     * in reconciliation months later. Absent from `RoundingMode` for exactly
     * this reason, and pinned here so it stays absent.
     */
    const modes: RoundingMode[] = ['half-up', 'half-even', 'down', 'up'];
    for (const mode of modes) {
      for (const amount of [5, 7, 49, 1999, 100_003]) {
        const forward = scale(gbp(amount), 1, 3, mode);
        const reverse = scale(gbp(-amount), 1, 3, mode);
        expect(reverse, `${mode} on ${amount}`).toEqual(negate(forward));
      }
    }
  });

  it('refuses a float rate, which is the whole point of the rational form', () => {
    // 8.25% written the way somebody reaching for a float would write it.
    expect(() => scale(gbp(1999), 8.25, 100, 'half-up')).toThrow(MoneyError);
    expect(() => scale(gbp(1999), 1, 12.5, 'half-up')).toThrow(MoneyError);
    expect(() => scale(gbp(1999), 1, 0, 'half-up')).toThrow(MoneyError);
    expect(() => scale(gbp(1999), 1, -3, 'half-up')).toThrow(MoneyError);
  });

  it('computes the intermediate product in BigInt, not in doubles', () => {
    /*
     * EXECUTED, NOT REASONED. `amount * numerator` is where precision dies:
     * both operands can be perfectly safe integers whose product is not, and a
     * double silently returns the nearest representable value instead. This case
     * is exact only if the intermediate is exact.
     */
    const big = money(1_000_000_000, 'GBP'); // £10,000,000.00
    expect(scale(big, 999_999, 1_000_000, 'half-up').amount).toBe(999_999_000);
    // And an intermediate that genuinely cannot fit is refused rather than
    // approximated.
    expect(() => scale(money(Number.MAX_SAFE_INTEGER, 'GBP'), 3, 1, 'half-up')).toThrow(
      MoneyError,
    );
  });
});

describe('formatMoney()', () => {
  it('renders a two-decimal currency for a log line', () => {
    expect(formatMoney(gbp(1999))).toBe('19.99 GBP');
    expect(formatMoney(gbp(-1999))).toBe('-19.99 GBP');
  });

  it('IS FOR LOGS ONLY, and a zero-decimal currency is why', () => {
    /*
     * IT ASSUMES TWO MINOR DIGITS. JPY has none, so ¥1999 renders as
     * "19.99 JPY" — a hundredfold error in a log line used to diagnose a money
     * dispute. Contract §13 pins ONE store currency for v1, which is the only
     * thing keeping this from being live; a second currency makes it live.
     *
     * Recorded rather than fixed: `formatMoney`'s own docstring already says a
     * customer-facing figure needs `Intl.NumberFormat`, a locale and the
     * currency's real exponent, and none of those belong in a module that must
     * not import anything. Pinned here so the next person to reach for it on a
     * customer-facing surface finds the reason not to, rather than discovering
     * it from a support ticket.
     *
     * THE OTHER SUSPICION DID NOT SURVIVE EXECUTION, and is recorded because
     * that is the useful half: `value.amount / 100` is the one floating-point
     * operation in a module whose whole purpose is not to have any, so it was
     * expected to lose precision near the constructor's ceiling. It does not —
     * `formatMoney(money(MAX_SAFE_INTEGER))` round-trips back to exactly
     * MAX_SAFE_INTEGER. An integer under 2^53 divided by 100 and printed to two
     * decimals stays exact for every constructible amount, so there is no bug
     * here and the assertion that claimed one was removed rather than weakened.
     */
    expect(formatMoney(money(1999, 'JPY'))).toBe('19.99 JPY');
  });
});
