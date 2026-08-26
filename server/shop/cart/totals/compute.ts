import { add, money, multiply, scale, sum, zero } from '../../../../shared/commerce/money';
import type { Money, RoundingMode } from '../../../../shared/commerce/money';
import { pickTier } from '../../../../shared/commerce/ports';
import type {
  Adjustment,
  BulkTier,
  FrozenTotals,
  ShippingQuote,
  TaxRate,
  TotalsLine,
} from '../../../../shared/commerce/ports';

/**
 * The totals engine. **A PURE FUNCTION** (brief §5).
 *
 * ═══ WHAT "PURE" BUYS, AND WHY IT IS WORTH THE INCONVENIENCE ═══
 *
 * No database. No clock. No network. No `Date.now()`, no `getDb()`, no
 * `CatalogPort`. Every input is passed in, and the module imports nothing from
 * `server/` at all — which is not a style preference but the property being
 * enforced: a function that could reach a price would be a function whose answer
 * depends on WHEN it ran, and the whole point of a frozen total is that it does
 * not.
 *
 * Three things follow from it and each is load-bearing:
 *
 * - **A customer dispute is answerable.** The stored `FrozenTotals` carries every
 *   input that produced it, so "why £41.98?" is re-run rather than reconstructed.
 * - **It is testable as a table.** `compute.test.ts` sweeps ~350 price/rate/qty
 *   combinations for the invariant that the visible parts add up to the whole.
 *   No fixture, no PGlite, no seeding.
 * - **It cannot silently change.** A price change between freeze and capture
 *   cannot reach it, because it has no way to ask.
 *
 * ═══ THE ORDER OF OPERATIONS, FIXED AND WRITTEN DOWN ═══
 *
 *   1. line total   = unit × qty                        (exact; both integers)
 *   2. line tax     = round(lineTotal × rate)           (ROUNDED HERE, per line)
 *   3. subtotal     = Σ line totals
 *   4. shipping tax = round(shipping × rate)            (if the zone taxes it)
 *   5. tax total    = Σ line taxes + shipping tax       (sum of ROUNDED parts)
 *   6. grand total  = subtotal + adjustments + shipping + tax
 *
 * ROUND PER LINE, THEN SUM — never sum then round. Three lines at 333p with 20%
 * VAT are 67 + 67 + 67 = 201, where rounding the total gives 200. The two differ
 * by a penny and the per-line answer is chosen because the invoice SHOWS the
 * per-line numbers: a customer who adds up what they can see and gets a
 * different answer from the total reports a bug, and they are right to.
 *
 * Every rounding goes through `scale()` in `shared/commerce/money.ts` — contract
 * §10's "one named function with a documented mode". There is no `Math.round`
 * and no `/` on an amount anywhere in this file.
 */

/**
 * `half-up`, away from zero, and RECORDED IN THE OUTPUT.
 *
 * Written into `FrozenTotals.rounding` so a two-year-old invoice can be
 * reproduced without knowing what the default was at the time — which is exactly
 * the fact nobody writes down.
 */
export const TOTALS_ROUNDING: RoundingMode = 'half-up';

/** 10 000 basis points is 100%; the denominator every rate is scaled by. */
const BPS = 10_000;

export interface TotalsInputLine {
  variantId: string;
  /**
   * The product this variant belongs to (migration 0600) — the GROUPING KEY for
   * the bulk ladder, and the reason it is on the input at all.
   *
   * The owner's rule is "qty per product, across variants": three black spools
   * and two white ones are five spools of that product and reach the 10% rung
   * together. Grouping by `variantId` instead would leave a customer who mixed
   * colours worse off than one who did not, for no reason they could see.
   */
  productId: string;
  qty: number;
  /**
   * The live unit price, or `null` when `CatalogPort.quote()` could not resolve
   * the variant — deleted, unpublished or discontinued (brief §3).
   *
   * NULL IS A FIRST-CLASS INPUT rather than something the caller filters out
   * beforehand, and that is the design: if unresolvable lines were dropped
   * before they got here, the engine would happily total a cart that shows three
   * items and charge for two. It is handed the whole basket and refuses.
   */
  unit: Money | null;
  /**
   * Defaults to true. v1 has no tax classes — Catalog's `VariantQuote` exposes
   * none — so nothing sets this to false yet through the ordinary path. It is an
   * input rather than an assumption so that zero-rated goods (books, children's
   * clothing) are a data change and not an engine change.
   */
  taxable?: boolean;
  /**
   * The RESOLVED ladder for this line's product (migration 0600) — already run
   * through `bulkDiscountEnabled` and the store-wide default by
   * `resolveTiers`, so an empty array or an absent field both mean "no bulk
   * discount on this line" and the engine needs no second rule.
   *
   * Passed per line rather than per product on `TotalsInput` because a line is
   * the only thing the caller is guaranteed to be holding, and a parallel
   * product→ladder map would be one more thing that can be out of step with the
   * lines it describes.
   */
  bulkTiers?: readonly BulkTier[];
}

export interface TotalsInput {
  /** The store currency. Everything must agree with it or the whole is refused. */
  currency: string;
  lines: readonly TotalsInputLine[];
  shipping: ShippingQuote | null;
  tax: TaxRate;
  adjustments: readonly Adjustment[];
}

export type TotalsResult =
  | { ok: true; totals: FrozenTotals }
  /** One or more lines could not be priced. Naming them is the whole point. */
  | { ok: false; reason: 'unresolved_lines'; variantIds: string[] }
  /** Something arrived in a currency the cart is not in. Never coerced. */
  | {
      ok: false;
      reason: 'currency_mismatch';
      expected: string;
      found: Array<{ where: string; currency: string }>;
    }
  /** The cart's own currency is not ISO-4217 — a corrupt row, or a bad import. */
  | { ok: false; reason: 'bad_currency'; currency: string };

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Compute the totals, or say precisely why not.
 *
 * A RESULT AND NOT A THROW, for the same reason `ReservationResult` is one: each
 * failure below is something a customer has to be TOLD, with the specifics —
 * which line is unavailable, which currency disagreed. An exception has nowhere
 * to put that, and every caller would end up parsing a message to rebuild it.
 * TypeScript's discriminated union also makes ignoring the failure a compile
 * error rather than a silent `undefined`.
 */
export function computeTotals(input: TotalsInput): TotalsResult {
  const { currency } = input;
  if (!CURRENCY.test(currency)) return { ok: false, reason: 'bad_currency', currency };

  /*
   * UNRESOLVED LINES FIRST, and every one of them, not just the first. A
   * customer told "something in your basket is unavailable" has to hunt; one
   * told which line does not. Checking before the currency scan is deliberate
   * too: a line with no price has no currency to disagree about, and reporting
   * `currency_mismatch` for it would be misleading.
   */
  const unresolved = input.lines.filter((line) => line.unit === null);
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: 'unresolved_lines',
      variantIds: unresolved.map((line) => line.variantId),
    };
  }

  /*
   * EVERY mismatch, collected, rather than throwing on the first.
   *
   * `add()` in `money.ts` already throws across currencies, so the arithmetic
   * below could not silently coerce even if this check were absent — but a
   * thrown `MoneyError` from three frames down is a 500 with no field name, and
   * this is a condition the caller can be told about precisely. Contract §10:
   * "no arithmetic that crosses currencies without an explicit conversion step",
   * and there is no conversion step in v1 (§13), so there is no right answer to
   * pick — only a refusal to make.
   */
  const found: Array<{ where: string; currency: string }> = [];
  for (const line of input.lines) {
    if (line.unit && line.unit.currency !== currency) {
      found.push({ where: `line:${line.variantId}`, currency: line.unit.currency });
    }
  }
  if (input.shipping && input.shipping.amount.currency !== currency) {
    found.push({
      where: `shipping:${input.shipping.id}`,
      currency: input.shipping.amount.currency,
    });
  }
  for (const adjustment of input.adjustments) {
    if (adjustment.amount.currency !== currency) {
      found.push({ where: `adjustment:${adjustment.code}`, currency: adjustment.amount.currency });
    }
  }
  if (found.length > 0) return { ok: false, reason: 'currency_mismatch', expected: currency, found };

  const rate = input.tax.rateBps;

  /*
   * 1a — THE BULK LADDER, and it runs BEFORE the per-line tax below. That
   * ordering is the whole design (see `0600_bulk_discount_tiers.sql`): a
   * quantity discount must reduce the TAXABLE BASE, and the `adjustments` path
   * further down applies after tax, so expressing this as an adjustment would
   * charge the customer VAT on money they did not spend.
   *
   * Quantity is summed PER PRODUCT across every line, so mixed variants of one
   * product climb the ladder together.
   */
  const qtyByProduct = new Map<string, number>();
  for (const line of input.lines) {
    qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) ?? 0) + line.qty);
  }

  // 1b and 2 — per line, in one pass, so the breakdown and the sums cannot drift.
  const lines: TotalsLine[] = input.lines.map((line) => {
    // Non-null by the `unresolved` check above; narrowed for the type checker.
    const unit = line.unit as Money;
    const bulkQty = qtyByProduct.get(line.productId) ?? line.qty;
    const tier = pickTier(line.bulkTiers ?? [], bulkQty);
    const bulkPercentBps = tier?.percentBps ?? 0;
    /*
     * ROUNDED ON THE UNIT, THEN MULTIPLIED — never `scale(lineTotal, …)`.
     *
     * Discounting the line total leaves a per-unit price carrying a fraction of
     * a kobo, so the receipt's "₦21,150 each × 5" would not equal its own line
     * total and nobody could tell which number was lying. Rounding once, here,
     * makes `effectiveUnit × qty` exact by construction.
     *
     * `BPS - bulkPercentBps` rather than subtracting a computed discount: one
     * rounding instead of two, and it cannot produce a negative unit because
     * the column is checked `> 0 AND <= 5000`.
     */
    const effectiveUnit =
      bulkPercentBps === 0
        ? unit
        : scale(unit, BPS - bulkPercentBps, BPS, TOTALS_ROUNDING);
    const lineTotal = multiply(effectiveUnit, line.qty);
    const taxable = line.taxable !== false;
    return {
      variantId: line.variantId,
      qty: line.qty,
      unit,
      bulkQty,
      bulkPercentBps,
      effectiveUnit,
      lineTotal,
      taxable,
      // On the DISCOUNTED `lineTotal` — the correct taxable base.
      taxAmount: taxable ? scale(lineTotal, rate, BPS, TOTALS_ROUNDING) : zero(currency),
    };
  });

  // 3
  const subtotal = sum(
    lines.map((line) => line.lineTotal),
    currency,
  );

  // 4
  const shippingTotal = input.shipping ? input.shipping.amount : zero(currency);
  const shippingTax =
    input.shipping && input.shipping.taxable
      ? scale(shippingTotal, rate, BPS, TOTALS_ROUNDING)
      : zero(currency);

  // 5 — a sum of already-rounded parts, never a rounding of a sum.
  const taxTotal = add(
    sum(
      lines.map((line) => line.taxAmount),
      currency,
    ),
    shippingTax,
  );

  const adjustmentTotal = sum(
    input.adjustments.map((adjustment) => adjustment.amount),
    currency,
  );

  /*
   * 6 — ADJUSTMENTS ARE APPLIED AFTER TAX IN V1, and this is a known
   * simplification rather than a considered tax position.
   *
   * A real discount reduces the taxable base, which needs the discount ALLOCATED
   * across lines before step 2 — with its own edge cases (allocation remainders,
   * non-taxable lines, per-line caps). Contract §13 puts discounts, coupons and
   * gift cards out of scope for v1 exactly so that is not invented under time
   * pressure, and `adjustments` is the documented extension point where it will
   * go. `compute.test.ts` pins this behaviour so nobody mistakes it for a
   * working discount engine.
   */
  const grandTotal = add(add(add(subtotal, adjustmentTotal), shippingTotal), taxTotal);

  return {
    ok: true,
    totals: {
      currency,
      lines,
      shipping: input.shipping,
      tax: input.tax,
      adjustments: [...input.adjustments],
      subtotal,
      adjustmentTotal,
      shippingTotal,
      taxTotal,
      grandTotal,
      rounding: TOTALS_ROUNDING,
    },
  };
}

/**
 * Rebuild a `FrozenTotals` read back out of `jsonb`.
 *
 * `CheckoutPort.totals()` reads the stored column, and what comes back from the
 * driver is a plain object that has never been near `money()`. This puts every
 * amount through the constructor again, so a row corrupted by a hand-run UPDATE
 * or a bad import is refused at the boundary rather than flowing into a charge.
 * Returns `null` rather than throwing so the caller decides the status code.
 */
export function parseFrozenTotals(value: unknown): FrozenTotals | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  try {
    const currency = String(raw.currency);
    const m = (v: unknown): Money => {
      const c = v as { amount: unknown; currency: unknown };
      const parsed = money(Number(c.amount), String(c.currency));
      if (parsed.currency !== currency) throw new Error('currency');
      return parsed;
    };
    const lines = (raw.lines as unknown[]).map((entry) => {
      const line = entry as Record<string, unknown>;
      const qty = Number(line.qty);
      const unit = m(line.unit);
      /*
       * ═══════════════════════════════════════════════════════════════════════
       * THE THREE BULK FIELDS ARE READ DEFENSIVELY, AND THIS IS THE COMPATIBILITY
       * SEAM FOR EVERY ORDER THAT ALREADY EXISTS.
       *
       * `FrozenTotals` is stored as `jsonb` and is copied, never recomputed — so
       * every checkout and order frozen before migration 0600 has a payload with
       * `bulkQty`, `bulkPercentBps` and `effectiveUnit` absent, permanently.
       * Read them the way the fields above are read and `m(undefined)` throws,
       * the `catch` below turns it into `null`, and the caller renders "these
       * totals are corrupt" for every historical order in the shop.
       *
       * The substitutions are what those payloads meant: no ladder existed, so
       * nothing was discounted, so the effective price WAS the list price.
       * `bulkQty` falls back to the line's own `qty` rather than 0 — the ladder
       * was evaluated at "just this line" by definition when there was no ladder.
       * ═══════════════════════════════════════════════════════════════════════
       */
      const effectiveUnit = line.effectiveUnit === undefined ? unit : m(line.effectiveUnit);
      return {
        variantId: String(line.variantId),
        qty,
        unit,
        bulkQty: line.bulkQty === undefined ? qty : Number(line.bulkQty),
        bulkPercentBps: line.bulkPercentBps === undefined ? 0 : Number(line.bulkPercentBps),
        effectiveUnit,
        lineTotal: m(line.lineTotal),
        taxable: Boolean(line.taxable),
        taxAmount: m(line.taxAmount),
      } satisfies TotalsLine;
    });
    const shippingRaw = raw.shipping as Record<string, unknown> | null;
    const shipping: ShippingQuote | null = shippingRaw
      ? {
          id: String(shippingRaw.id),
          label: String(shippingRaw.label),
          amount: m(shippingRaw.amount),
          taxable: Boolean(shippingRaw.taxable),
        }
      : null;
    const taxRaw = raw.tax as Record<string, unknown>;
    return {
      currency,
      lines,
      shipping,
      tax: {
        zone: String(taxRaw.zone),
        label: String(taxRaw.label),
        rateBps: Number(taxRaw.rateBps),
      },
      adjustments: (raw.adjustments as unknown[]).map((entry) => {
        const adjustment = entry as Record<string, unknown>;
        return {
          code: String(adjustment.code),
          label: String(adjustment.label),
          amount: m(adjustment.amount),
        } satisfies Adjustment;
      }),
      subtotal: m(raw.subtotal),
      adjustmentTotal: m(raw.adjustmentTotal),
      shippingTotal: m(raw.shippingTotal),
      taxTotal: m(raw.taxTotal),
      grandTotal: m(raw.grandTotal),
      rounding: String(raw.rounding) as RoundingMode,
    };
  } catch {
    return null;
  }
}
