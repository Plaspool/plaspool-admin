import { describe, expect, it } from 'vitest';
import { computeTotals, parseFrozenTotals } from './compute';
import { money } from '../../../../shared/commerce/money';
import type { BulkTier } from '../../../../shared/commerce/ports';
import type { TotalsInput } from './compute';

/**
 * Discount codes through the totals engine (admin#100 Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CENTRAL CLAIM, and it is the same one `bulk.test.ts` makes one file over:
 * A CODE REDUCES THE TAXABLE BASE.
 *
 * `compute.ts` applies `adjustments` AFTER tax and says so at length — a
 * documented v1 simplification, not a tax position. A 10% code expressed as an
 * `Adjustment` on a ₦10,000 cart would charge 7.5% VAT on the full ₦10,000 and
 * then take ₦1,000 off, so the shop would collect ₦75 of VAT on money nobody
 * spent, on every receipt. The owner settled this on 2026-09-02: pre-tax, per
 * line. `vat is charged on the post-code total` below is the assertion that
 * fails if anyone ever moves this onto the adjustments path.
 *
 * THE TWO KINDS ARE DIFFERENT SHAPES OF PROBLEM, which is why they take
 * different routes through the arithmetic:
 *
 *   - `percent` is ALREADY per line. Each line is scaled by the same rate, and
 *     the results are summed — the engine's own "round per line, then sum" rule,
 *     which exists so a customer who adds up what they can see gets the total.
 *     No allocation, and therefore no remainder.
 *   - `fixed_amount` is genuinely cart-level: "₦1,000 off" has to be SPLIT. That
 *     is the allocation CLAUDE.md §6 warns a coupon must do properly, and the
 *     tests below pin that the parts sum to the target exactly.
 *
 * POINTS ARE UNAFFECTED and stay an `Adjustment`. The two now live at different
 * points in the pipeline, which is precisely what lets them compose.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Naira, minor units — 100 per naira, so ₦23,500 is 2 350 000. */
const ngn = (minor: number) => money(minor, 'NGN');

const VAT = { zone: 'NG', label: 'VAT', rateBps: 750 };
const NO_TAX = { zone: 'z', label: 'none', rateBps: 0 };

const TEN_PERCENT = { code: 'WELCOME10', label: '10% off', kind: 'percent', percentBps: 1000 } as const;

function totals(input: Partial<TotalsInput> & Pick<TotalsInput, 'lines'>) {
  const res = computeTotals({
    currency: 'NGN',
    shipping: null,
    tax: NO_TAX,
    adjustments: [],
    ...input,
  });
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return res.totals;
}

/** One line, priced, with no ladder. */
const line = (variantId: string, unitMinor: number, qty: number, bulkTiers: BulkTier[] = []) => ({
  variantId,
  productId: `prd_${variantId}`,
  qty,
  unit: ngn(unitMinor),
  bulkTiers,
});

describe('a percent code reduces the taxable base', () => {
  it('charges VAT on the post-code total, not the list total', () => {
    // ₦10,000 of goods, 10% off, 7.5% VAT.
    const withCode = totals({
      lines: [line('a', 1_000_000, 1)],
      tax: VAT,
      discount: TEN_PERCENT,
    });

    expect(withCode.subtotal.amount).toBe(1_000_000);
    expect(withCode.discountTotal.amount).toBe(-100_000);
    // 7.5% of ₦9,000, NOT of ₦10,000. The adjustments path would give 75_000.
    expect(withCode.taxTotal.amount).toBe(67_500);
    expect(withCode.grandTotal.amount).toBe(1_000_000 - 100_000 + 67_500);
  });

  it('is what an Adjustment would NOT have done — the difference is real money', () => {
    const lines = [line('a', 1_000_000, 1)];
    const asCode = totals({ lines, tax: VAT, discount: TEN_PERCENT });
    const asAdjustment = totals({
      lines,
      tax: VAT,
      adjustments: [{ code: 'x', label: '10% off', amount: ngn(-100_000) }],
    });

    // Same discount, same cart, ₦75 apart — the VAT on money nobody spent.
    expect(asAdjustment.grandTotal.amount - asCode.grandTotal.amount).toBe(7_500);
  });

  it('scales each line and sums the rounded parts, as tax already does', () => {
    // 333 and 667 at 10%: 33.3 → 33 and 66.7 → 67 half-up. Summing first and
    // rounding once would give 100; per line gives 100 too, but the LINES are
    // what the receipt shows and they must add up to the total shown.
    const t = totals({
      lines: [line('a', 333, 1), line('b', 667, 1)],
      discount: TEN_PERCENT,
    });

    expect(t.lines.map((l) => l.codeDiscount.amount)).toEqual([-33, -67]);
    expect(t.discountTotal.amount).toBe(-100);
  });
});

describe('a fixed-amount code is allocated across the lines', () => {
  const fixed = (minor: number) =>
    ({ code: 'SAVE', label: 'Fixed off', kind: 'fixed_amount', amount: ngn(minor) }) as const;

  it('splits the amount so the parts sum to EXACTLY the target', () => {
    // ₦10 across three equal lines is 3.33 each — the classic remainder. The
    // parts must still sum to 1000, not 999.
    const t = totals({
      lines: [line('a', 1_000, 1), line('b', 1_000, 1), line('c', 1_000, 1)],
      discount: fixed(1_000),
    });

    const parts = t.lines.map((l) => l.codeDiscount.amount);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-1_000);
    expect(t.discountTotal.amount).toBe(-1_000);
    // Largest remainder: the extra units go to the earliest lines, so the split
    // is deterministic rather than "whatever the float did".
    expect(parts).toEqual([-334, -333, -333]);
  });

  it('allocates in proportion to what each line is worth', () => {
    const t = totals({
      lines: [line('a', 3_000, 1), line('b', 1_000, 1)],
      discount: fixed(400),
    });

    expect(t.lines.map((l) => l.codeDiscount.amount)).toEqual([-300, -100]);
  });

  it('is CLAMPED to the goods subtotal — a code can never pay more than the cart', () => {
    // ₦500 off a ₦10 cart. Without the clamp the grand total goes negative and
    // the shop owes the customer money for shopping.
    const t = totals({
      lines: [line('a', 1_000, 1)],
      shipping: { id: 's', label: 'Standard', amount: ngn(300_000), taxable: false },
      discount: fixed(50_000),
    });

    expect(t.discountTotal.amount).toBe(-1_000);
    // Shipping is still owed in full: the clamp caps the discount, it does not
    // let a code eat delivery.
    expect(t.grandTotal.amount).toBe(1_000 - 1_000 + 300_000);
  });

  it('refuses a code priced in another currency rather than coercing it', () => {
    const res = computeTotals({
      currency: 'NGN',
      lines: [line('a', 1_000, 1)],
      shipping: null,
      tax: NO_TAX,
      adjustments: [],
      discount: { code: 'USD5', label: '$5 off', kind: 'fixed_amount', amount: money(500, 'USD') },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('currency_mismatch');
  });
});

describe('what the code does NOT touch', () => {
  it('leaves shipping out of the base — a percent code discounts goods only', () => {
    const t = totals({
      lines: [line('a', 1_000_000, 1)],
      shipping: { id: 's', label: 'Standard', amount: ngn(1_000_000), taxable: false },
      discount: TEN_PERCENT,
    });

    // 10% of the GOODS (₦10,000), not of goods + ₦10,000 delivery.
    expect(t.discountTotal.amount).toBe(-100_000);
    expect(t.shippingTotal.amount).toBe(1_000_000);
  });

  it('applies AFTER the bulk ladder, on the already-discounted line', () => {
    // 5 units at ₦10 with a 10%-at-5 rung → effective unit ₦9, line ₦45.
    // The code then takes 10% of ₦45, not of ₦50.
    const t = totals({
      lines: [line('a', 1_000, 5, [{ minQty: 5, percentBps: 1000 }])],
      discount: TEN_PERCENT,
    });

    expect(t.lines[0].effectiveUnit.amount).toBe(900);
    expect(t.lines[0].lineTotal.amount).toBe(4_500);
    expect(t.lines[0].codeDiscount.amount).toBe(-450);
  });

  it('composes with points without either moving the other’s base', () => {
    const t = totals({
      lines: [line('a', 1_000_000, 1)],
      tax: VAT,
      discount: TEN_PERCENT,
      adjustments: [{ code: 'points_redemption', label: '500 points', amount: ngn(-50_000) }],
    });

    // The code is pre-tax; the points are post-tax. Both are in the total once.
    expect(t.discountTotal.amount).toBe(-100_000);
    expect(t.adjustmentTotal.amount).toBe(-50_000);
    expect(t.taxTotal.amount).toBe(67_500);
    expect(t.grandTotal.amount).toBe(1_000_000 - 100_000 - 50_000 + 67_500);
  });

  it('is absent from a cart with no code, and changes nothing', () => {
    const plain = totals({ lines: [line('a', 1_000_000, 1)], tax: VAT });

    expect(plain.discount).toBeNull();
    expect(plain.discountTotal.amount).toBe(0);
    expect(plain.lines[0].codeDiscount.amount).toBe(0);
    // The pre-Part-B number, unchanged: this feature is additive or it is a
    // repricing of every cart in the shop.
    expect(plain.grandTotal.amount).toBe(1_075_000);
  });
});

describe('reading back a stored total', () => {
  it('rebuilds the code fields, so a receipt can name what was applied', () => {
    const t = totals({ lines: [line('a', 1_000_000, 1)], tax: VAT, discount: TEN_PERCENT });
    const parsed = parseFrozenTotals(JSON.parse(JSON.stringify(t)));

    expect(parsed).not.toBeNull();
    expect(parsed?.discount?.code).toBe('WELCOME10');
    expect(parsed?.discountTotal.amount).toBe(-100_000);
    expect(parsed?.lines[0].codeDiscount.amount).toBe(-100_000);
  });

  it('reads a payload frozen BEFORE this feature without calling it corrupt', () => {
    /*
     * EVERY ORDER IN THE SHOP TODAY. `frozen_totals` is jsonb, copied and never
     * recomputed, so every checkout frozen before this migration has a payload
     * with `discount`, `discountTotal` and `codeDiscount` absent — permanently.
     * Read them the way the other fields are read and `m(undefined)` throws, the
     * catch turns it into null, and every historical order renders as "these
     * totals are corrupt". This is the same seam the three bulk fields needed.
     */
    const t = totals({ lines: [line('a', 1_000_000, 1)], tax: VAT });
    const historical = JSON.parse(JSON.stringify(t)) as Record<string, unknown>;
    delete historical.discount;
    delete historical.discountTotal;
    for (const l of historical.lines as Record<string, unknown>[]) delete l.codeDiscount;

    const parsed = parseFrozenTotals(historical);

    expect(parsed).not.toBeNull();
    expect(parsed?.discount).toBeNull();
    expect(parsed?.discountTotal.amount).toBe(0);
    expect(parsed?.lines[0].codeDiscount.amount).toBe(0);
    expect(parsed?.grandTotal.amount).toBe(1_075_000);
  });
});
