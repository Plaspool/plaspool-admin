import { describe, expect, it } from 'vitest';
import { UNRENDERABLE, ageDays, ageLabel, isRenderable, isoAttr, safeFormat } from './when';

/**
 * The formatter that must never throw.
 *
 * `Intl.DateTimeFormat.prototype.format` throws `RangeError` on an invalid
 * date rather than returning a string, and a throw inside render is a
 * whole-screen error boundary. `/shop/orders` was unreachable in production for
 * exactly that reason. Each case below is a value that has plausibly reached a
 * formatter in this app: an absent field, a `Number()` of something
 * unparseable, a bigint epoch that arrived as a string, and a number outside
 * the ECMAScript time range.
 */

const FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const REAL = 1_787_175_360_356; // 2026-08-20, from the live order list.

describe('safeFormat', () => {
  it('formats a real epoch exactly as the bare formatter would', () => {
    expect(safeFormat(FMT, REAL)).toBe(FMT.format(new Date(REAL)));
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1787175360356'],
    ['an object', {}],
    // ±8.64e15 ms is the whole ECMAScript time range; `Date` does not clamp.
    ['beyond the time range', 8.64e15 + 1],
  ])('returns the placeholder for %s instead of throwing', (_label, value) => {
    expect(() => safeFormat(FMT, value)).not.toThrow();
    expect(safeFormat(FMT, value)).toBe(UNRENDERABLE);
  });

  it('refuses the bare formatter on the same input, which is the point', () => {
    // If this ever stops throwing, `safeFormat` has become decoration.
    expect(() => FMT.format(new Date(undefined as unknown as number))).toThrow(RangeError);
  });
});

describe('isRenderable', () => {
  it('accepts epoch zero, which is falsy and must not be mistaken for absent', () => {
    expect(isRenderable(0)).toBe(true);
    expect(safeFormat(FMT, 0)).not.toBe(UNRENDERABLE);
  });

  it('rejects every non-number', () => {
    expect(isRenderable('0')).toBe(false);
    expect(isRenderable(null)).toBe(false);
  });
});

describe('isoAttr', () => {
  it('gives a machine-readable string for `<time datetime>`', () => {
    expect(isoAttr(REAL)).toBe(new Date(REAL).toISOString());
  });

  it('gives undefined — not "" — so the attribute is omitted', () => {
    expect(isoAttr(undefined)).toBeUndefined();
    expect(isoAttr(Number.NaN)).toBeUndefined();
  });
});

describe('ageLabel', () => {
  const now = REAL;
  const min = 60_000;

  it('rounds down, so an ageing badge never overstates the wait', () => {
    // 47 hours is "1 day". A badge that said 2 would be crying wolf on a
    // colour that means "chase this".
    expect(ageLabel(now - 47 * 60 * min, now)).toBe('1 day');
    expect(ageLabel(now - 49 * 60 * min, now)).toBe('2 days');
  });

  it('singularises', () => {
    expect(ageLabel(now - min, now)).toBe('1 minute');
    expect(ageLabel(now - 2 * min, now)).toBe('2 minutes');
    expect(ageLabel(now - 60 * min, now)).toBe('1 hour');
  });

  it('says "just now" under a minute, and for a clock that runs backwards', () => {
    expect(ageLabel(now - 59_999, now)).toBe('just now');

    /*
     * THE ONLY COVER FOR SKEW, AND IT IS DELIBERATELY THE ONLY ONE. `ageLabel`
     * used to carry an `if (ms < 0) return 'just now'` that could never run,
     * because `ms < MINUTE` catches every negative first; it was removed rather
     * than reordered, so this is now the sole statement anywhere that a `from`
     * in the future must read as the present.
     *
     * FIVE MINUTES IS ORDINARY SKEW; THREE DAYS IS NOT, and both are asserted
     * because the failure that matters is a sign creeping back into the maths.
     * A regression would not produce a wrong-looking word — it would produce
     * "-3 days" or "3 days" on a badge whose colour means "chase this", either
     * of which reads as a real answer.
     */
    expect(ageLabel(now + 5 * min, now)).toBe('just now');
    expect(ageLabel(now + 3 * 24 * 60 * min, now)).toBe('just now');
    expect(ageLabel(now + 3 * 24 * 60 * min, now)).not.toContain('-');
  });

  it('returns the placeholder rather than "NaN days" on a broken input', () => {
    expect(ageLabel(undefined, now)).toBe(UNRENDERABLE);
    expect(ageLabel(REAL, Number.NaN)).toBe(UNRENDERABLE);
  });
});

describe('ageDays', () => {
  it('floors, and never returns a negative day count', () => {
    expect(ageDays(REAL - 47 * 3_600_000, REAL)).toBe(1);
    expect(ageDays(REAL + 3_600_000, REAL)).toBe(0);
  });

  it('returns null when it cannot tell, so a caller cannot colour on a guess', () => {
    expect(ageDays(undefined, REAL)).toBeNull();
  });
});
