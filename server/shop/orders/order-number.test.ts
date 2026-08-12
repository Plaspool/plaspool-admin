/**
 * Order numbers (brief §3), and the check character's property proved rather than
 * asserted about.
 *
 * A check character whose error-detection is described in a comment is a comment. The
 * two censuses below enumerate EVERY single-digit substitution and EVERY adjacent
 * transposition over a corpus and require all of them to be caught — which is the
 * claim `order-number.ts` makes, and which is false for a composite modulus.
 */
import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../repo/errors';
import {
  checkCharacter,
  formatOrderNumber,
  parseOrderNumber,
  requireOrderNumber,
} from './order-number';

describe('the format', () => {
  it('is year, six padded digits, and a check character', () => {
    expect(formatOrderNumber(2026, 42)).toMatch(/^2026-000042-[A-Z]$/);
    expect(formatOrderNumber(2026, 4182)).toMatch(/^2026-004182-[A-Z]$/);
  });

  it('round-trips through the parser', () => {
    for (const sequence of [0, 1, 42, 999_999]) {
      const number = formatOrderNumber(2026, sequence);
      expect(parseOrderNumber(number)).toEqual({ year: 2026, sequence });
    }
  });

  it('keeps working past six digits rather than truncating', () => {
    // A shop that outgrows the padding must not start minting duplicates.
    const number = formatOrderNumber(2026, 1_000_000);
    expect(number).toMatch(/^2026-1000000-[A-Z]$/);
    expect(parseOrderNumber(number)).toEqual({ year: 2026, sequence: 1_000_000 });
  });

  it('never uses I, O or Z — the three that are read back as 1, 0 and 2', () => {
    const used = new Set<string>();
    for (let sequence = 0; sequence < 2000; sequence += 1) {
      used.add(formatOrderNumber(2026, sequence).slice(-1));
    }
    // All 23 appear over 2000 sequences, and none of them is a confusable.
    expect(used.size).toBe(23);
    for (const forbidden of ['I', 'O', 'Z']) expect(used.has(forbidden)).toBe(false);
  });
});

describe('the check character catches what brief §3 needs it to', () => {
  /** Every order number in a wide corpus: four years × 1500 sequences. */
  function corpus(): string[] {
    const out: string[] = [];
    for (const year of [2025, 2026, 2027, 2030]) {
      for (let sequence = 0; sequence < 1500; sequence += 1) {
        out.push(formatOrderNumber(year, sequence));
      }
    }
    return out;
  }

  it('EVERY single-digit substitution, exhaustively', () => {
    /*
     * The property: with a PRIME modulus and non-zero positional weights, `w · δ ≢ 0
     * (mod 23)` for every `0 < |δ| ≤ 9` and `0 < w ≤ 11`, because both factors are
     * below the modulus and 23 has no zero divisors. This census is what turns that
     * paragraph into a fact about the code.
     */
    let checked = 0;
    for (const number of corpus()) {
      const digits = number.slice(0, 4) + number.slice(5, -2);
      for (let i = 0; i < digits.length; i += 1) {
        for (let d = 0; d <= 9; d += 1) {
          if (digits[i] === String(d)) continue;
          const mutated = `${digits.slice(0, i)}${d}${digits.slice(i + 1)}`;
          expect(
            checkCharacter(mutated),
            `${digits} → ${mutated} was not detected`,
          ).not.toBe(checkCharacter(digits));
          checked += 1;
        }
      }
    }
    // Guard against the census silently checking nothing.
    expect(checked).toBeGreaterThan(300_000);
  });

  it('EVERY adjacent transposition of two different digits, exhaustively', () => {
    let checked = 0;
    for (const number of corpus()) {
      const digits = number.slice(0, 4) + number.slice(5, -2);
      for (let i = 0; i + 1 < digits.length; i += 1) {
        if (digits[i] === digits[i + 1]) continue;
        const mutated =
          digits.slice(0, i) + digits[i + 1] + digits[i] + digits.slice(i + 2);
        expect(
          checkCharacter(mutated),
          `${digits} → ${mutated} was not detected`,
        ).not.toBe(checkCharacter(digits));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('and a composite modulus would not — which is why 23 is prime', () => {
    /*
     * The counter-example, kept as a test so the choice of modulus cannot be
     * "simplified". With modulus 24 and the same weights, weight 8 (position 6) and a
     * digit change of 3 give `8 · 3 = 24 ≡ 0`, so the check character does not move
     * and a mistyped digit sails through.
     */
    const composite = (digits: string) => {
      let sum = 0;
      for (let i = 0; i < digits.length; i += 1) sum += (digits.charCodeAt(i) - 48) * (i + 2);
      return sum % 24;
    };
    // Position 6 has weight 8. 0 → 3 is δ=3.
    const original = '2026000042';
    const mutated = '2026003042';
    expect(composite(original)).toBe(composite(mutated));
    // The real one catches it.
    expect(checkCharacter(original)).not.toBe(checkCharacter(mutated));
  });
});

describe('a mistyped number is refused without touching the database', () => {
  it('parseOrderNumber is null for a wrong check character', () => {
    const good = formatOrderNumber(2026, 42);
    const bad = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    expect(parseOrderNumber(good)).not.toBeNull();
    expect(parseOrderNumber(bad)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['2026-000042', 'no check character'],
    ['26-000042-K', 'two-digit year'],
    ['2026-42-K', 'unpadded sequence'],
    ['2026-000042-k', 'lowercase check character'],
    ['2026-00004a-K', 'a letter in the sequence'],
    ['ord_01H8XYZ', 'an internal id'],
  ])('%s is not an order number (%s)', (value) => {
    expect(parseOrderNumber(value)).toBeNull();
  });

  it('requireOrderNumber is a 400, deliberately not a 404', () => {
    /*
     * The check character PROVES the value was mistyped, with no query run. Answering
     * 404 would make "you typed it wrong" and "that order is not yours" the same
     * answer, and a 400 additionally keeps 22 of every 23 guessed numbers off the
     * database entirely.
     */
    const err = (() => {
      try {
        requireOrderNumber('2026-000042-Q');
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).detail).toBe('orderNumber');
    expect(requireOrderNumber(formatOrderNumber(2026, 42))).toBe(formatOrderNumber(2026, 42));
  });
});
