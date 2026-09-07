import { describe, expect, it } from 'vitest';
import { computeTotals, parseFrozenTotals } from './compute';
import { money } from '../../../../shared/commerce/money';
import type { FrozenAddOn } from '../../../../shared/commerce/ports';
import type { TotalsInput } from './compute';

/** Naira, minor units — 100 per naira. */
const ngn = (minor: number) => money(minor, 'NGN');
const VAT = { zone: 'NG', label: 'VAT', rateBps: 750 };

const line = (variantId: string, unitMinor: number, qty: number) => ({
  variantId,
  productId: `prd_${variantId}`,
  qty,
  unit: ngn(unitMinor),
});

const box: FrozenAddOn = {
  id: 'ado_box',
  title: 'Gift box',
  mode: 'chosen',
  listPrice: ngn(150_000),
  unitAmount: ngn(150_000),
  units: 1,
  basis: 'order',
  amount: ngn(150_000),
};
const freeBox: FrozenAddOn = { ...box, mode: 'included', amount: ngn(0) };

function totals(input: Partial<TotalsInput> & Pick<TotalsInput, 'lines'>) {
  const res = computeTotals({ currency: 'NGN', shipping: null, tax: VAT, adjustments: [], ...input });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res.totals;
}

describe('add-ons in the totals', () => {
  it('absent prices exactly as before, and reports an empty list and a zero', () => {
    const before = totals({ lines: [line('a', 1_000_000, 2)] });
    expect(before.addOns).toEqual([]);
    expect(before.addOnTotal).toEqual(ngn(0));
    expect(before.grandTotal).toEqual(ngn(2_150_000));
  });

  it('adds the amount to the grand total and taxes NOTHING on it', () => {
    const t = totals({ lines: [line('a', 1_000_000, 2)], addOns: [box] });
    expect(t.addOnTotal).toEqual(ngn(150_000));
    expect(t.taxTotal).toEqual(ngn(150_000)); // 7.5% of 2,000,000 — the goods only
    expect(t.grandTotal).toEqual(ngn(2_300_000));
    expect(t.addOns).toEqual([box]);
  });

  it('a free included add-on is on the record and moves nothing', () => {
    const t = totals({ lines: [line('a', 1_000_000, 2)], addOns: [freeBox] });
    expect(t.addOnTotal).toEqual(ngn(0));
    expect(t.grandTotal).toEqual(ngn(2_150_000));
    expect(t.addOns[0]?.mode).toBe('included');
  });

  it('a code discounts the goods, never the add-on', () => {
    const t = totals({
      lines: [line('a', 1_000_000, 2)],
      addOns: [box],
      discount: { code: 'TEN', label: '10% off', kind: 'percent', percentBps: 1000 },
    });
    expect(t.discountTotal).toEqual(ngn(-200_000));
    expect(t.addOnTotal).toEqual(ngn(150_000));
    // 2,000,000 − 200,000 + 150,000 + tax 135,000
    expect(t.grandTotal).toEqual(ngn(2_085_000));
  });

  it('INVARIANT: the visible parts add up, add-ons included', () => {
    for (const unit of [1, 333, 1_999, 1_000_000]) {
      for (const qty of [1, 3, 7]) {
        for (const amount of [0, 1, 150_000]) {
          const t = totals({
            lines: [line('a', unit, qty), line('b', unit + 1, qty)],
            addOns: [{ ...box, amount: ngn(amount) }],
          });
          const sum =
            t.subtotal.amount +
            t.discountTotal.amount +
            t.adjustmentTotal.amount +
            t.addOnTotal.amount +
            t.shippingTotal.amount +
            t.taxTotal.amount;
          expect(t.grandTotal.amount).toBe(sum);
        }
      }
    }
  });

  it('refuses an add-on in another currency, naming it', () => {
    const res = computeTotals({
      currency: 'NGN',
      lines: [line('a', 1_000_000, 1)],
      shipping: null,
      tax: VAT,
      adjustments: [],
      addOns: [{ ...box, amount: money(1500, 'USD'), listPrice: money(1500, 'USD') }],
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'currency_mismatch',
      found: [{ where: 'add_on:ado_box', currency: 'USD' }],
    });
  });
});

describe('parseFrozenTotals and the payloads that predate add-ons', () => {
  /** EXACTLY what a pre-add-on freeze stored: no addOns key, no addOnTotal key. */
  const legacy = {
    currency: 'NGN',
    lines: [
      {
        variantId: 'var_1',
        qty: 1,
        unit: { amount: 1_000_000, currency: 'NGN' },
        lineTotal: { amount: 1_000_000, currency: 'NGN' },
        taxable: true,
        taxAmount: { amount: 75_000, currency: 'NGN' },
      },
    ],
    shipping: null,
    tax: VAT,
    adjustments: [],
    subtotal: { amount: 1_000_000, currency: 'NGN' },
    adjustmentTotal: { amount: 0, currency: 'NGN' },
    shippingTotal: { amount: 0, currency: 'NGN' },
    taxTotal: { amount: 75_000, currency: 'NGN' },
    grandTotal: { amount: 1_075_000, currency: 'NGN' },
    rounding: 'half-up',
  };

  it('reads a legacy payload as "no add-ons" rather than refusing it', () => {
    const parsed = parseFrozenTotals(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.addOns).toEqual([]);
    expect(parsed!.addOnTotal).toEqual(ngn(0));
  });

  it('round-trips a payload with add-ons through JSON', () => {
    const t = totals({ lines: [line('a', 1_000_000, 2)], addOns: [box, freeBox] });
    const parsed = parseFrozenTotals(JSON.parse(JSON.stringify(t)));
    expect(parsed).toEqual(t);
  });

  it('refuses a corrupt add-on amount at the boundary', () => {
    const t = totals({ lines: [line('a', 1_000_000, 2)], addOns: [box] });
    const corrupt = JSON.parse(JSON.stringify(t));
    corrupt.addOns[0].amount = { amount: 'lots', currency: 'NGN' };
    expect(parseFrozenTotals(corrupt)).toBeNull();
  });
});
