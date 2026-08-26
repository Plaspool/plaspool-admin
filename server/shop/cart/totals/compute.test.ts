/**
 * The totals engine, which is a PURE FUNCTION (brief §5).
 *
 * No database, no clock, no network, every input passed in. That is what makes
 * this file a table rather than a set of fixtures, and it is what makes a
 * customer dispute answerable: the same inputs give the same answer forever, and
 * the answer carries the itemised breakdown it was derived from.
 *
 * There is deliberately NO test here that boots PGlite. If one were needed, the
 * function would not be pure and the whole property would be gone.
 */
import { describe, expect, it } from 'vitest';
import { money } from '../../../../shared/commerce/money';
import { computeTotals } from './compute';
import type { TotalsInput } from './compute';
import type { Money } from '../../../../shared/commerce/money';

const GBP = 'GBP';
const gbp = (n: number): Money => money(n, GBP);

const VAT: TotalsInput['tax'] = { zone: 'domestic', label: 'VAT', rateBps: 2000 };
const NO_TAX: TotalsInput['tax'] = { zone: 'international', label: 'No VAT', rateBps: 0 };

const STANDARD: TotalsInput['shipping'] = {
  id: 'standard',
  label: 'Standard',
  amount: gbp(399),
  taxable: true,
};

function input(over: Partial<TotalsInput> = {}): TotalsInput {
  return {
    currency: GBP,
    lines: [{ variantId: 'var_a', productId: 'prd_var_a', qty: 1, unit: gbp(1999) }],
    shipping: null,
    tax: NO_TAX,
    adjustments: [],
    ...over,
  };
}

/** The result, or a failure of the test rather than a cascade of `!`. */
function ok(over: Partial<TotalsInput> = {}) {
  const result = computeTotals(input(over));
  if (!result.ok) throw new Error(`expected totals, got ${result.reason}`);
  return result.totals;
}

describe('the arithmetic', () => {
  it('multiplies unit by quantity exactly — no rounding happens on a line total', () => {
    const totals = ok({ lines: [{ variantId: 'var_a', productId: 'prd_var_a', qty: 3, unit: gbp(1999) }] });
    expect(totals.lines[0].lineTotal).toEqual(gbp(5997));
    expect(totals.subtotal).toEqual(gbp(5997));
  });

  it('sums several lines', () => {
    const totals = ok({
      lines: [
        { variantId: 'var_a', productId: 'prd_var_a', qty: 2, unit: gbp(1999) },
        { variantId: 'var_b', productId: 'prd_var_b', qty: 1, unit: gbp(500) },
      ],
    });
    expect(totals.subtotal).toEqual(gbp(4498));
  });

  it('adds shipping and reaches the grand total', () => {
    const totals = ok({ shipping: STANDARD });
    expect(totals.shippingTotal).toEqual(gbp(399));
    expect(totals.grandTotal).toEqual(gbp(2398));
  });

  it('is all zeros for a cart with no lines, rather than refusing', () => {
    /*
     * The correct arithmetic answer for an empty cart is zero, and a pure
     * function should give it — a storefront renders "£0.00" beside an empty
     * basket all the time. REFUSING an empty cart is a decision about
     * CHECKOUT, not about arithmetic, and it lives in `freezeCheckout` where a
     * caller can be told why. Splitting them is what keeps this function total.
     */
    const totals = ok({ lines: [], shipping: null, tax: VAT });
    expect(totals.subtotal).toEqual(gbp(0));
    expect(totals.taxTotal).toEqual(gbp(0));
    expect(totals.grandTotal).toEqual(gbp(0));
    expect(totals.lines).toEqual([]);
  });
});

describe('tax — rounded PER LINE, then summed', () => {
  it('rounds each line before summing, so the parts add up to the whole', () => {
    /*
     * THE CASE THAT DECIDES THE ORDER OF OPERATIONS. Three lines at 333p with
     * 20% VAT:
     *   per line:  round(333 × 0.20) = round(66.6) = 67, ×3 = 201
     *   on total:  round(999 × 0.20) = round(199.8) = 200
     * The two differ by a penny. Per-line is chosen because the invoice SHOWS
     * per-line tax: a customer who adds up the visible numbers and gets a
     * different answer from the total reports it as a bug, every time, and they
     * are right to — the breakdown is supposed to be the evidence for the total.
     */
    const totals = ok({
      lines: [
        { variantId: 'a', productId: 'prd_a', qty: 1, unit: gbp(333) },
        { variantId: 'b', productId: 'prd_b', qty: 1, unit: gbp(333) },
        { variantId: 'c', productId: 'prd_c', qty: 1, unit: gbp(333) },
      ],
      tax: VAT,
    });
    expect(totals.lines.map((l) => l.taxAmount.amount)).toEqual([67, 67, 67]);
    expect(totals.taxTotal).toEqual(gbp(201));
    expect(totals.grandTotal).toEqual(gbp(999 + 201));
  });

  it('taxes the LINE TOTAL, not the unit price times a rounded per-unit tax', () => {
    // 3 × 333 = 999; round(999 × 0.20) = 200. Taxing the unit and multiplying
    // would give 67 × 3 = 201 — a different, and wrong, answer for one line.
    const totals = ok({ lines: [{ variantId: 'a', productId: 'prd_a', qty: 3, unit: gbp(333) }], tax: VAT });
    expect(totals.lines[0].taxAmount).toEqual(gbp(200));
  });

  it('taxes shipping only when the zone says shipping is taxable', () => {
    const taxed = ok({ shipping: STANDARD, tax: VAT, lines: [] });
    expect(taxed.taxTotal).toEqual(gbp(80)); // 399 × 0.20 = 79.8 → 80

    const untaxed = ok({
      shipping: { ...STANDARD, taxable: false },
      tax: VAT,
      lines: [],
    });
    expect(untaxed.taxTotal).toEqual(gbp(0));
  });

  it('a zero rate produces zero tax, not an absent tax line', () => {
    const totals = ok({ tax: NO_TAX, shipping: STANDARD });
    expect(totals.taxTotal).toEqual(gbp(0));
    expect(totals.tax.rateBps).toBe(0);
    // The zone is still recorded: "no tax was charged, and here is why" is a
    // different statement from "tax was not considered".
    expect(totals.tax.label).toBe('No VAT');
  });

  it('marks a line non-taxable and charges it nothing', () => {
    const totals = ok({
      lines: [
        { variantId: 'a', productId: 'prd_a', qty: 1, unit: gbp(1000) },
        { variantId: 'b', productId: 'prd_b', qty: 1, unit: gbp(1000), taxable: false },
      ],
      tax: VAT,
    });
    expect(totals.lines.map((l) => l.taxAmount.amount)).toEqual([200, 0]);
    expect(totals.taxTotal).toEqual(gbp(200));
  });
});

describe('rounding edge cases', () => {
  const cases: Array<[number, number, number, string]> = [
    // [lineTotal, rateBps, expected tax, why]
    [10, 5000, 5, 'no remainder — no mode can change it'],
    [3, 5000, 2, 'exactly on the half rounds UP, away from zero'],
    [1, 5000, 1, '0.5 rounds up to 1, never down to 0'],
    [1999, 725, 145, '144.9275 rounds up'],
    [1999, 724, 145, '144.7276 rounds up'],
    [1001, 700, 70, '70.07 rounds down — the fractional part is below the half'],
    [1, 1, 0, 'a rate so small the tax is nothing — and it is 0, not 1'],
    [999999, 2000, 200000, 'a large line, exact'],
  ];

  for (const [lineTotal, rateBps, expected, why] of cases) {
    it(`${lineTotal}p at ${rateBps}bps is ${expected}p — ${why}`, () => {
      const totals = ok({
        lines: [{ variantId: 'a', productId: 'prd_a', qty: 1, unit: gbp(lineTotal) }],
        tax: { zone: 'z', label: 'T', rateBps },
      });
      expect(totals.lines[0].taxAmount.amount).toBe(expected);
    });
  }

  it('INVARIANT: the visible parts always add up to the grand total', () => {
    /*
     * Swept across a range rather than asserted at one point, because "the
     * breakdown justifies the total" is the property the whole engine exists
     * for, and an off-by-one that only shows at one price is exactly the kind
     * of thing a handful of examples misses.
     */
    for (let unit = 1; unit <= 400; unit += 7) {
      for (const rateBps of [0, 1, 725, 2000, 9999, 10000]) {
        for (const qty of [1, 3, 7]) {
          const totals = ok({
            lines: [
              { variantId: 'a', productId: 'prd_a', qty, unit: gbp(unit) },
              { variantId: 'b', productId: 'prd_b', qty: 1, unit: gbp(unit * 2 + 1) },
            ],
            shipping: STANDARD,
            tax: { zone: 'z', label: 'T', rateBps },
          });
          const visibleTax =
            totals.lines.reduce((n, l) => n + l.taxAmount.amount, 0) +
            (totals.shipping?.taxable ? shippingTaxOf(totals.shippingTotal.amount, rateBps) : 0);
          expect(totals.taxTotal.amount, `tax at unit=${unit} rate=${rateBps}`).toBe(visibleTax);
          expect(
            totals.grandTotal.amount,
            `total at unit=${unit} rate=${rateBps} qty=${qty}`,
          ).toBe(
            totals.subtotal.amount +
              totals.adjustmentTotal.amount +
              totals.shippingTotal.amount +
              totals.taxTotal.amount,
          );
        }
      }
    }
  });
});

/** Half-up, away from zero — written out here so the invariant test does not
 * borrow the implementation it is checking. */
function shippingTaxOf(amount: number, rateBps: number): number {
  const n = amount * rateBps;
  return Math.floor((2 * n + 10000) / 20000);
}

describe('a line whose variant has vanished', () => {
  it('REFUSES to produce totals rather than quietly dropping the line', () => {
    /*
     * The failure this prevents is a cart that shows three items and a total
     * that covers two. `CatalogPort.quote()` returns null for a variant that has
     * been deleted, unpublished or discontinued (brief §3), and the cart still
     * renders that line as "no longer available" — but there is no honest number
     * to charge while it is there, so freezing is refused and the customer is
     * told which line to remove.
     */
    const result = computeTotals(
      input({
        lines: [
          { variantId: 'var_a', productId: 'prd_var_a', qty: 1, unit: gbp(1999) },
          { variantId: 'var_gone', productId: 'prd_var_gone', qty: 2, unit: null },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'unresolved_lines') throw new Error(`got ${result.reason}`);
    // The variant ids ride along: "something is unavailable" is not actionable,
    // "this one is" is.
    expect(result.variantIds).toEqual(['var_gone']);
  });

  it('names EVERY unresolved line, not just the first', () => {
    const result = computeTotals(
      input({
        lines: [
          { variantId: 'gone_1', productId: 'prd_gone_1', qty: 1, unit: null },
          { variantId: 'here', productId: 'prd_here', qty: 1, unit: gbp(100) },
          { variantId: 'gone_2', productId: 'prd_gone_2', qty: 1, unit: null },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'unresolved_lines') throw new Error(`got ${result.reason}`);
    expect(result.variantIds).toEqual(['gone_1', 'gone_2']);
  });
});

describe('a currency mismatch is REFUSED, never coerced', () => {
  it('refuses a line priced in another currency', () => {
    const result = computeTotals(
      input({
        lines: [
          { variantId: 'var_a', productId: 'prd_var_a', qty: 1, unit: gbp(1999) },
          { variantId: 'var_eur', productId: 'prd_var_eur', qty: 1, unit: money(1999, 'EUR') },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'currency_mismatch') throw new Error(`got ${result.reason}`);
    expect(result.found).toEqual([{ where: 'line:var_eur', currency: 'EUR' }]);
    expect(result.expected).toBe('GBP');
  });

  it('refuses a shipping quote in another currency', () => {
    const result = computeTotals(
      input({ shipping: { ...STANDARD, amount: money(399, 'USD') } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'currency_mismatch') throw new Error(`got ${result.reason}`);
    expect(result.found).toEqual([{ where: 'shipping:standard', currency: 'USD' }]);
  });

  it('refuses an adjustment in another currency', () => {
    const result = computeTotals(
      input({
        adjustments: [{ code: 'X', label: 'X', amount: money(-100, 'EUR') }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('currency_mismatch');
  });

  it('refuses a cart currency that is not ISO-4217, rather than building a Money that throws', () => {
    const result = computeTotals(input({ currency: 'pounds' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_currency');
  });
});

describe('adjustments — the documented extension point, empty in v1', () => {
  it('applies them AFTER tax and says so in the breakdown', () => {
    /*
     * DOCUMENTED, PINNED, AND KNOWN TO BE WRONG FOR A REAL DISCOUNT. In most
     * jurisdictions a discount reduces the taxable base, which needs the
     * discount ALLOCATED across lines before tax is computed — a real feature
     * with real edge cases (allocation remainders, non-taxable lines, per-line
     * caps). Contract §13 puts discounts out of scope for v1 precisely so that
     * is not invented under time pressure.
     *
     * So v1 does the simple, deterministic thing and this test exists to stop it
     * being mistaken for a working discount engine: an adjustment moves the
     * grand total and does NOT move the tax.
     */
    const totals = ok({
      lines: [{ variantId: 'a', productId: 'prd_a', qty: 1, unit: gbp(1000) }],
      tax: VAT,
      adjustments: [{ code: 'WELCOME', label: '£1 off', amount: gbp(-100) }],
    });
    expect(totals.taxTotal).toEqual(gbp(200)); // unchanged by the discount
    expect(totals.adjustmentTotal).toEqual(gbp(-100));
    expect(totals.grandTotal).toEqual(gbp(1000 - 100 + 200));
  });

  it('carries them into the breakdown so the number is justifiable', () => {
    const totals = ok({
      adjustments: [{ code: 'WELCOME', label: '£1 off', amount: gbp(-100) }],
    });
    expect(totals.adjustments).toEqual([
      { code: 'WELCOME', label: '£1 off', amount: gbp(-100) },
    ]);
  });

  it('is empty by default, which is what v1 ships', () => {
    expect(ok().adjustments).toEqual([]);
    expect(ok().adjustmentTotal).toEqual(gbp(0));
  });
});

describe('purity', () => {
  it('gives the same answer twice, and does not mutate its input', () => {
    const arg = input({ shipping: STANDARD, tax: VAT });
    const frozen = JSON.stringify(arg);
    const first = computeTotals(arg);
    const second = computeTotals(arg);
    expect(JSON.stringify(arg)).toBe(frozen);
    expect(first).toEqual(second);
  });

  it('records the rounding mode it used, so the number is reproducible later', () => {
    // Without this, reproducing a two-year-old invoice requires knowing what the
    // default was at the time — which is exactly the thing nobody records.
    expect(ok().rounding).toBe('half-up');
  });

  it('reads no clock: the same input at two different instants agrees', () => {
    const arg = input({ shipping: STANDARD, tax: VAT });
    const a = computeTotals(arg);
    const b = computeTotals(structuredClone(arg));
    expect(a).toEqual(b);
  });
});
