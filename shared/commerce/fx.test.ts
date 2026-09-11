import { describe, expect, it } from 'vitest';
import {
  chargeBreakdown,
  convertMinor,
  currencyForCountry,
  formatMultiplier,
  parseMultiplier,
} from './fx';

/*
 * THE VECTORS ARE A CONTRACT. The storefront runs these exact rows against its
 * own implementation; a row changed here and not there is a pesewa of drift
 * between what a shopper reads and what the gateway charges.
 */
const VECTORS: Array<[ngnMinor: number, multiplier: string, currency: string, expected: number]> = [
  [2800000, '0.008496176720', 'GHS', 23789],
  [2660000, '0.008496176720', 'GHS', 22600],
  [50000, '0.008496176720', 'GHS', 425],
  [2800000, '0.009000000000', 'GHS', 25200], // a variant override
  [2800000, '0.000625000000', 'USD', 1750],
  [12000, '0.000625000000', 'USD', 8], // 7.5 rounds up
  [-12000, '0.000625000000', 'USD', -8], // and away from zero
  [-120000, '0.000625000000', 'USD', -75],
  [2800000, '2.387654321000', 'UGX', 66854], // exponent 0
  [2800000, '0.384615384615', 'XOF', 10769], // exponent 0
  [1, '0.008496176720', 'GHS', 0],
  [0, '0.008496176720', 'GHS', 0],
];

describe('convertMinor — the published vectors', () => {
  it.each(VECTORS)('%i NGN at %s → %s %i', (ngn, multiplier, currency, expected) => {
    expect(convertMinor(ngn, parseMultiplier(multiplier), currency)).toBe(expected);
  });

  it('never returns -0', () => {
    expect(Object.is(convertMinor(-1, parseMultiplier('0.008496176720'), 'GHS'), 0)).toBe(true);
  });
});

describe('multiplier text', () => {
  it('prints exactly twelve fractional digits, verbatim', () => {
    expect(formatMultiplier(8496176720n)).toBe('0.008496176720');
    expect(formatMultiplier(1_000_000_000_000n)).toBe('1.000000000000');
    expect(formatMultiplier(2_387_654_321_000n)).toBe('2.387654321000');
  });

  it('round-trips and pads short input', () => {
    expect(parseMultiplier('0.00849617672')).toBe(8496176720n);
    expect(formatMultiplier(parseMultiplier('0.009'))).toBe('0.009000000000');
  });

  it('refuses what it cannot represent rather than rounding it', () => {
    for (const bad of ['-0.1', '1e-3', '0.0000000000001', '0', '0.000000000000', 'abc', '']) {
      expect(() => parseMultiplier(bad), bad).toThrow();
    }
  });
});

const GHS = { currency: 'GHS', multiplierE12: parseMultiplier('0.008496176720'), variantMultipliers: new Map() };

function totals(over: Partial<Parameters<typeof chargeBreakdown>[0]> = {}) {
  return {
    lines: [{ variantId: 'var_a', lineTotal: { amount: 7980000 } }],
    shipping: { amount: { amount: 450000 } },
    discountTotal: { amount: 0 },
    adjustments: [{ code: 'points', amount: { amount: -100000 } }],
    addOns: [],
    taxTotal: { amount: 0 },
    grandTotal: { amount: 8330000 },
    ...over,
  };
}

describe('chargeBreakdown — convert each component, then add', () => {
  it('charges 70772 for the checkout vector, not the 70773 a converted total gives', () => {
    const b = chargeBreakdown(totals(), GHS);
    expect(b.components.map((c) => [c.kind, c.amount])).toEqual([
      ['line', 67799],
      ['adjustment', -850],
      ['shipping', 3823],
    ]);
    expect(b.amount).toBe(70772);
    expect(convertMinor(8330000, GHS.multiplierE12, 'GHS')).toBe(70773);
    expect(b.ngnTotal).toBe(8330000);
  });

  it('uses a variant override on that variant only; shipping keeps the currency multiplier', () => {
    const rates = { ...GHS, variantMultipliers: new Map([['var_a', parseMultiplier('0.009')]]) };
    const b = chargeBreakdown(
      totals({
        lines: [
          { variantId: 'var_a', lineTotal: { amount: 2800000 } },
          { variantId: 'var_b', lineTotal: { amount: 2800000 } },
        ],
        adjustments: [],
        grandTotal: { amount: 6050000 },
      }),
      rates,
    );
    expect(b.components).toEqual([
      { kind: 'line', ref: 'var_a', ngnMinor: 2800000, multiplier: '0.009000000000', amount: 25200 },
      { kind: 'line', ref: 'var_b', ngnMinor: 2800000, multiplier: '0.008496176720', amount: 23789 },
      { kind: 'shipping', ref: null, ngnMinor: 450000, multiplier: '0.008496176720', amount: 3823 },
    ]);
    expect(b.amount).toBe(25200 + 23789 + 3823);
  });

  it('covers codes, add-ons and tax, and converts an exponent-0 currency', () => {
    const b = chargeBreakdown(
      totals({
        lines: [{ variantId: 'var_a', lineTotal: { amount: 2800000 } }],
        discountTotal: { amount: -280000 },
        adjustments: [],
        addOns: [{ id: 'ado_box', amount: { amount: 50000 } }],
        taxTotal: { amount: 210000 },
        grandTotal: { amount: 2800000 - 280000 + 50000 + 450000 + 210000 },
      }),
      { currency: 'UGX', multiplierE12: parseMultiplier('2.387654321'), variantMultipliers: new Map() },
    );
    expect(b.exponent).toBe(0);
    expect(b.components.map((c) => c.kind)).toEqual(['line', 'discount', 'addOn', 'shipping', 'tax']);
    expect(b.components.map((c) => c.amount)).toEqual([66854, -6685, 1194, 10744, 5014]);
    expect(b.amount).toBe(66854 - 6685 + 1194 + 10744 + 5014);
  });

  it('refuses totals whose components do not sum to the grand total', () => {
    expect(() => chargeBreakdown(totals({ grandTotal: { amount: 8330001 } }), GHS)).toThrow(/grand total/);
  });
});

describe('currencyForCountry', () => {
  const map = { NG: 'NGN', GH: 'GHS', US: 'USD' };
  it('uses the map when the mapped currency is offered', () => {
    expect(currencyForCountry('GH', map, ['NGN', 'GHS'], 'NGN')).toBe('GHS');
    expect(currencyForCountry('gh', map, ['NGN', 'GHS'], 'NGN')).toBe('GHS');
  });
  it('falls back when the mapped currency is not offered, then to naira', () => {
    expect(currencyForCountry('US', map, ['NGN', 'GHS'], 'GHS')).toBe('GHS');
    expect(currencyForCountry('US', map, ['NGN'], 'GHS')).toBe('NGN');
    expect(currencyForCountry('FR', map, ['NGN', 'GHS'], 'NGN')).toBe('NGN');
    expect(currencyForCountry(null, map, ['NGN', 'GHS'], 'NGN')).toBe('NGN');
  });
});
