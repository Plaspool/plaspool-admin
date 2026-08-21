import { describe, expect, it } from 'vitest';
import { parseNaira, nairaValue, byRegion } from './ShopDeliveryAreas';
import type { ServiceArea } from '../data/api-marketing';

/**
 * The money crossing, and the grouping under the state picker.
 *
 * `parseNaira` IS THE ONLY PLACE A HUMAN'S TYPING BECOMES MINOR UNITS on this
 * screen, and every failure it can have is a wrong charge: 100 per naira, so a
 * factor slip is not a rounding error but a two-orders-of-magnitude one.
 */

describe('parseNaira', () => {
  it('reads whole naira as minor units — 100 per naira', () => {
    expect(parseNaira('3000')).toBe(300_000);
    expect(parseNaira('10000')).toBe(1_000_000);
    /* ₦3,000 is 300000. Confirmed against a live price, not assumed
       (CLAUDE.md §6) — the seeded Abuja rate. */
    expect(parseNaira('0')).toBe(0);
  });

  it('accepts what a person actually types', () => {
    expect(parseNaira(' 3000 ')).toBe(300_000);
    expect(parseNaira('₦3000')).toBe(300_000);
    expect(parseNaira('3,000')).toBe(300_000);
    expect(parseNaira('3000.50')).toBe(300_050);
    expect(parseNaira('3000.05')).toBe(300_005);
  });

  it('REFUSES rather than rounds, because guessing invents a charge', () => {
    // Three decimal places is not a naira amount. Rounding it either way is a
    // kobo the shop never agreed to.
    expect(parseNaira('3000.456')).toBeNull();
    expect(parseNaira('-100')).toBeNull();
    expect(parseNaira('abc')).toBeNull();
    expect(parseNaira('3e4')).toBeNull();
    expect(parseNaira('')).toBeNull();
    expect(parseNaira('   ')).toBeNull();
    // A lone separator is not zero.
    expect(parseNaira('.')).toBeNull();
    expect(parseNaira('₦')).toBeNull();
  });

  it('round-trips through nairaValue', () => {
    for (const minor of [0, 5, 100, 300_000, 1_000_000, 300_050]) {
      expect(parseNaira(nairaValue(minor))).toBe(minor);
    }
  });
});

describe('nairaValue', () => {
  it('drops the kobo when there is none, and keeps two digits when there is', () => {
    expect(nairaValue(300_000)).toBe('3000');
    expect(nairaValue(300_050)).toBe('3000.50');
    // Five kobo is `.05`, never `.5` — which would round-trip as fifty.
    expect(nairaValue(300_005)).toBe('3000.05');
    expect(nairaValue(0)).toBe('0');
  });
});

// ────────────────────────────────────────────────────────────────── grouping

function area(over: Partial<ServiceArea> & { key: string; region: string }): ServiceArea {
  return {
    id: `a_${over.key}`,
    name: over.key,
    active: true,
    seeded: true,
    revision: 1,
    needsAction: 0,
    open: 0,
    loadUnits: 0,
    oldestAgeMs: null,
    ...over,
  };
}

describe('byRegion', () => {
  const areas = [
    area({ key: 'maitama', region: 'Federal Capital Territory' }),
    area({ key: 'wuse', region: 'Federal Capital Territory' }),
    area({ key: 'ikeja', region: 'Lagos' }),
  ];

  it('keeps the API order and counts what delivers per region', () => {
    const groups = byRegion(areas, (a) => a.key !== 'wuse');
    expect(groups.map((g) => g.region)).toEqual(['Federal Capital Territory', 'Lagos']);
    expect(groups[0]!.on).toBe(1);
    expect(groups[0]!.areas).toHaveLength(2);
    expect(groups[1]!.on).toBe(1);
  });

  it('counts a district with no opinion as delivering — absence is not "off"', () => {
    // The predicate the screen passes defaults to `true` for a district with no
    // row, matching the column default. A tally that treated absence as off
    // would tell an owner the shop had stopped serving a city it is serving.
    const groups = byRegion(areas, () => true);
    expect(groups.map((g) => g.on)).toEqual([2, 1]);
  });
});
