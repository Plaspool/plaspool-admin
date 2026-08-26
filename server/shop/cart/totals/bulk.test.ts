import { describe, expect, it } from 'vitest';
import { computeTotals, parseFrozenTotals } from './compute';
import { pickTier } from '../../../../shared/commerce/ports';
import { money } from '../../../../shared/commerce/money';
import type { BulkTier } from '../../../../shared/commerce/ports';
import type { TotalsInput } from './compute';

/**
 * Bulk quantity discounts through the totals engine (migration 0600).
 *
 * THE CENTRAL CLAIM UNDER TEST is that the discount reduces the TAXABLE BASE.
 * `compute.ts` applies `adjustments` after tax and says so; a bulk discount
 * expressed as one would charge VAT on money the customer never spent. That is
 * not a rounding nit on a 7.5% shop, and `vat is charged on the discounted
 * total` below is the assertion that would fail if anyone moved this onto the
 * adjustments path.
 */

/** Naira, minor units — 100 per naira, so ₦23,500 is 2 350 000. */
const ngn = (minor: number) => money(minor, 'NGN');

const LADDER: BulkTier[] = [
  { minQty: 3, percentBps: 500 },
  { minQty: 5, percentBps: 1000 },
  { minQty: 10, percentBps: 1500 },
];

const VAT = { zone: 'NG', label: 'VAT', rateBps: 750 };

function totals(input: Partial<TotalsInput> & Pick<TotalsInput, 'lines'>) {
  const res = computeTotals({
    currency: 'NGN',
    shipping: null,
    tax: { zone: 'z', label: 'none', rateBps: 0 },
    adjustments: [],
    ...input,
  });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res.totals;
}

describe('pickTier', () => {
  it('is INCLUSIVE at each rung — a "3+" tier applies at exactly 3', () => {
    // A rung the shop advertises as "3+" that did not apply at 3 would be a lie
    // told in the shop's own UI.
    expect(pickTier(LADDER, 2)).toBeNull();
    expect(pickTier(LADDER, 3)?.percentBps).toBe(500);
    expect(pickTier(LADDER, 4)?.percentBps).toBe(500);
    expect(pickTier(LADDER, 5)?.percentBps).toBe(1000);
    expect(pickTier(LADDER, 9)?.percentBps).toBe(1000);
    expect(pickTier(LADDER, 10)?.percentBps).toBe(1500);
    expect(pickTier(LADDER, 10_000)?.percentBps).toBe(1500);
  });

  it('takes the HIGHEST matching rung even when the ladder arrives unsorted', () => {
    // An admin PUT or a hand-written fixture can hand these over in any order;
    // reading "whichever came last" would be a silent mispricing.
    const shuffled = [LADDER[2], LADDER[0], LADDER[1]];
    expect(pickTier(shuffled, 7)?.percentBps).toBe(1000);
    expect(pickTier(shuffled, 12)?.percentBps).toBe(1500);
  });

  it('is null for an empty ladder at any quantity', () => {
    expect(pickTier([], 999)).toBeNull();
  });
});

describe('bulk discount in computeTotals', () => {
  it('leaves the unit alone below the first rung', () => {
    const t = totals({
      lines: [{ variantId: 'v', productId: 'p', qty: 2, unit: ngn(2_350_000), bulkTiers: LADDER }],
    });
    expect(t.lines[0].bulkPercentBps).toBe(0);
    expect(t.lines[0].effectiveUnit).toEqual(ngn(2_350_000));
    expect(t.lines[0].lineTotal).toEqual(ngn(4_700_000));
  });

  it('applies the rung and rounds the UNIT, so effectiveUnit × qty is exact', () => {
    const t = totals({
      lines: [{ variantId: 'v', productId: 'p', qty: 5, unit: ngn(2_350_000), bulkTiers: LADDER }],
    });
    const line = t.lines[0];
    expect(line.bulkQty).toBe(5);
    expect(line.bulkPercentBps).toBe(1000);
    // ₦23,500 less 10% is ₦21,150 — a clean per-unit number a receipt can print.
    expect(line.effectiveUnit).toEqual(ngn(2_115_000));
    // Exact by construction: the rounding already happened on the unit.
    expect(line.lineTotal).toEqual(ngn(2_115_000 * 5));
    expect(line.unit).toEqual(ngn(2_350_000));
  });

  it('SUMS QUANTITY PER PRODUCT ACROSS VARIANTS — the owner\'s rule', () => {
    // Three black plus two white is five spools of one product, and both lines
    // climb to the 10% rung together. Grouping by variant would leave a customer
    // who mixed colours worse off than one who did not, for no visible reason.
    const t = totals({
      lines: [
        { variantId: 'black', productId: 'pla', qty: 3, unit: ngn(2_000_000), bulkTiers: LADDER },
        { variantId: 'white', productId: 'pla', qty: 2, unit: ngn(2_000_000), bulkTiers: LADDER },
      ],
    });
    expect(t.lines.map((l) => l.bulkQty)).toEqual([5, 5]);
    expect(t.lines.map((l) => l.bulkPercentBps)).toEqual([1000, 1000]);
    expect(t.lines.map((l) => l.effectiveUnit.amount)).toEqual([1_800_000, 1_800_000]);
  });

  it('does NOT pool quantity across different products', () => {
    // Four of one and four of another is not eight of anything.
    const t = totals({
      lines: [
        { variantId: 'a', productId: 'pla', qty: 4, unit: ngn(1_000_000), bulkTiers: LADDER },
        { variantId: 'b', productId: 'abs', qty: 4, unit: ngn(1_000_000), bulkTiers: LADDER },
      ],
    });
    expect(t.lines.map((l) => l.bulkQty)).toEqual([4, 4]);
    expect(t.lines.map((l) => l.bulkPercentBps)).toEqual([500, 500]);
  });

  it('gives no discount when the ladder is empty — a complete answer', () => {
    // `resolveTiers` returns [] for a product with `bulkDiscountEnabled = false`,
    // so this is how "switched off" reaches the engine. There is no second flag.
    const t = totals({
      lines: [{ variantId: 'v', productId: 'p', qty: 50, unit: ngn(1_000_000), bulkTiers: [] }],
    });
    expect(t.lines[0].bulkPercentBps).toBe(0);
    expect(t.lines[0].effectiveUnit).toEqual(ngn(1_000_000));
  });

  it('treats an absent bulkTiers exactly as an empty one', () => {
    const t = totals({
      lines: [{ variantId: 'v', productId: 'p', qty: 50, unit: ngn(1_000_000) }],
    });
    expect(t.lines[0].bulkPercentBps).toBe(0);
  });

  it('CHARGES VAT ON THE DISCOUNTED TOTAL, not the list total', () => {
    // ═══ The assertion this whole design exists for. ═══
    // 5 × ₦20,000 at 10% off is ₦90,000 of goods. VAT at 7.5% is ₦6,750.
    // Were the discount an `Adjustment` — applied after tax, per compute.ts —
    // VAT would be charged on ₦100,000, i.e. ₦7,500, and the customer would pay
    // ₦750 of tax on money they never spent.
    const t = totals({
      tax: VAT,
      lines: [{ variantId: 'v', productId: 'p', qty: 5, unit: ngn(2_000_000), bulkTiers: LADDER }],
    });
    expect(t.subtotal).toEqual(ngn(9_000_000));
    expect(t.taxTotal).toEqual(ngn(675_000));
    expect(t.taxTotal).not.toEqual(ngn(750_000));
    expect(t.grandTotal).toEqual(ngn(9_675_000));
  });

  it('keeps a non-taxable line untaxed while still discounting it', () => {
    const t = totals({
      tax: VAT,
      lines: [
        {
          variantId: 'v',
          productId: 'p',
          qty: 5,
          unit: ngn(2_000_000),
          bulkTiers: LADDER,
          taxable: false,
        },
      ],
    });
    expect(t.lines[0].effectiveUnit).toEqual(ngn(1_800_000));
    expect(t.taxTotal).toEqual(ngn(0));
  });

  it('rounds half-up on a unit that does not divide evenly', () => {
    // 5% off 333 is 316.35 → 316 at half-up on the unit.
    const t = totals({
      lines: [{ variantId: 'v', productId: 'p', qty: 3, unit: ngn(333), bulkTiers: LADDER }],
    });
    expect(t.lines[0].effectiveUnit).toEqual(ngn(316));
    expect(t.lines[0].lineTotal).toEqual(ngn(948));
  });

  it('still adds up: subtotal is the sum of the DISCOUNTED line totals', () => {
    const t = totals({
      tax: VAT,
      lines: [
        { variantId: 'a', productId: 'pla', qty: 6, unit: ngn(2_350_000), bulkTiers: LADDER },
        { variantId: 'b', productId: 'abs', qty: 1, unit: ngn(999_999), bulkTiers: LADDER },
      ],
    });
    const summed = t.lines.reduce((n, l) => n + l.lineTotal.amount, 0);
    expect(t.subtotal.amount).toBe(summed);
    expect(t.grandTotal.amount).toBe(
      t.subtotal.amount + t.adjustmentTotal.amount + t.shippingTotal.amount + t.taxTotal.amount,
    );
  });
});

describe('parseFrozenTotals — orders frozen before migration 0600', () => {
  /**
   * `FrozenTotals` is stored as jsonb and COPIED, NEVER RECOMPUTED, so every
   * order placed before this shipped has a payload without the three bulk keys
   * and always will. If `parseFrozenTotals` refused those, reading any
   * historical order would 500 — the feature would break the past.
   */
  const legacy = {
    currency: 'NGN',
    lines: [
      {
        variantId: 'v',
        qty: 2,
        unit: { amount: 2_000_000, currency: 'NGN' },
        lineTotal: { amount: 4_000_000, currency: 'NGN' },
        taxable: true,
        taxAmount: { amount: 300_000, currency: 'NGN' },
      },
    ],
    shipping: null,
    tax: { zone: 'NG', label: 'VAT', rateBps: 750 },
    adjustments: [],
    subtotal: { amount: 4_000_000, currency: 'NGN' },
    adjustmentTotal: { amount: 0, currency: 'NGN' },
    shippingTotal: { amount: 0, currency: 'NGN' },
    taxTotal: { amount: 300_000, currency: 'NGN' },
    grandTotal: { amount: 4_300_000, currency: 'NGN' },
    rounding: 'half-up',
  };

  it('reads a legacy payload rather than refusing it', () => {
    const parsed = parseFrozenTotals(legacy);
    expect(parsed).not.toBeNull();
  });

  it('substitutes what the legacy payload meant: no ladder, so no discount', () => {
    const line = parseFrozenTotals(legacy)!.lines[0];
    expect(line.bulkPercentBps).toBe(0);
    // The effective price WAS the list price when no ladder existed.
    expect(line.effectiveUnit).toEqual(ngn(2_000_000));
    // Evaluated at "just this line" by definition, so qty and not 0 — a 0 would
    // render as "you're buying 0 of this product" on a receipt.
    expect(line.bulkQty).toBe(2);
  });

  it('round-trips a NEW payload without losing the discount', () => {
    const fresh = totals({
      tax: VAT,
      lines: [{ variantId: 'v', productId: 'p', qty: 5, unit: ngn(2_000_000), bulkTiers: LADDER }],
    });
    const parsed = parseFrozenTotals(JSON.parse(JSON.stringify(fresh)));
    expect(parsed!.lines[0].bulkPercentBps).toBe(1000);
    expect(parsed!.lines[0].effectiveUnit).toEqual(ngn(1_800_000));
    expect(parsed!.lines[0].bulkQty).toBe(5);
  });
});
