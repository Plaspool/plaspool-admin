import { add, money, multiply, scale, sum, zero } from '../../../../shared/commerce/money';
import type { Money, RoundingMode } from '../../../../shared/commerce/money';
import { pickTier } from '../../../../shared/commerce/ports';
import type {
  Adjustment,
  BulkTier,
  CodeDiscount,
  FrozenAddOn,
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
 *   6. grand total  = subtotal + adjustments + add-ons + shipping + tax
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

/**
 * Split `target` minor units across `weights` so the parts sum to EXACTLY it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LARGEST REMAINDER (Hamilton), and the alternative is what makes it necessary.
 * Rounding each line's exact share independently loses or invents money: ₦10
 * across three equal lines is 3.33 each, which rounds to 333 three times and
 * sums to 999. The customer is then shown three lines that do not add up to the
 * discount they were promised, and the kobo is unaccounted for on the invoice.
 *
 * So every line gets the FLOOR of its exact share, and the leftover units — at
 * most one per line, by construction — go to the lines with the largest
 * discarded fractions. Ties break on the earlier line, so the split is
 * deterministic: the same cart allocates the same way on the preview, on the
 * freeze and on a re-read a year later, which is the only version of this that
 * can be reconciled.
 *
 * `BigInt` THROUGHOUT, and not defensively. `target × weight` is a product of
 * two minor-unit amounts: a ₦10,000,000 cart is 10^9 minor units, and 10^9 ×
 * 10^9 is 10^18 — well past `Number.MAX_SAFE_INTEGER` at ~9×10^15. In floating
 * point the shares would come back subtly wrong on exactly the largest orders,
 * which is the worst possible place to find out. This is the same argument
 * `scale()` makes in `shared/commerce/money.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function allocate(target: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (target <= 0 || total <= 0) return weights.map(() => 0);

  const t = BigInt(target);
  const w = BigInt(total);
  const parts = weights.map((weight) => (t * BigInt(weight)) / w);
  const remainders = weights.map((weight, i) => (t * BigInt(weight)) % w);

  let left = t - parts.reduce((a, b) => a + b, 0n);
  // Largest discarded fraction first; the earlier line wins a tie, so nothing
  // here depends on the sort being stable.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => (remainders[b] === remainders[a] ? a - b : remainders[b] > remainders[a] ? 1 : -1));
  for (const i of order) {
    if (left <= 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts.map(Number);
}

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
  /**
   * The cart's discount code, or nothing (admin#100 Part B).
   *
   * OPTIONAL, AND ABSENT PRICES EXACTLY AS THIS ENGINE PRICED BEFORE IT
   * EXISTED — `code-discount.test.ts` asserts the untouched grand total, because
   * a feature that repriced every cart in the shop on the way in would be a
   * migration wearing an input's clothes.
   */
  discount?: CodeDiscount | null;
  /**
   * The add-ons to charge (spec 2026-09-06). OPTIONAL, and absent prices
   * exactly as before — `add-ons.test.ts` pins the untouched grand total.
   * Already resolved by Cart: an unanswered ask is simply not in this list.
   */
  addOns?: readonly FrozenAddOn[];
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
  /* A `fixed_amount` code is a PRICE — "500 off" is not one until it says 500
   * of what — so it is checked exactly as the adjustments are. A `percent` has
   * no currency to disagree about. */
  if (input.discount?.kind === 'fixed_amount' && input.discount.amount.currency !== currency) {
    found.push({
      where: `discount:${input.discount.code}`,
      currency: input.discount.amount.currency,
    });
  }
  for (const addOn of input.addOns ?? []) {
    if (addOn.amount.currency !== currency) {
      found.push({ where: `add_on:${addOn.id}`, currency: addOn.amount.currency });
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

  // 1b — the bulk ladder per line. Split from the tax step below because the
  // code discount in 1c has to see every `lineTotal` before any line can be
  // taxed: a cart-level amount cannot be allocated one line at a time.
  const priced = input.lines.map((line) => {
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
    return {
      variantId: line.variantId,
      qty: line.qty,
      unit,
      bulkQty,
      bulkPercentBps,
      effectiveUnit,
      lineTotal,
      taxable: line.taxable !== false,
    };
  });

  /*
   * 1c — THE DISCOUNT CODE, BEFORE THE TAX BELOW AND AFTER THE LADDER ABOVE
   * (admin#100 Part B, owner's decision 2026-09-02).
   *
   * Same position in the pipeline as the bulk ladder and for the same reason:
   * a code must reduce the TAXABLE BASE, and the `adjustments` path further
   * down applies after tax, so expressing this as an adjustment would charge
   * the customer VAT on money they did not spend. CLAUDE.md §6 spells out that
   * a cart-level coupon may NOT simply reuse `effectiveUnit` for this — it needs
   * real allocation, which is what `allocate` above does.
   *
   * GOODS ONLY. Shipping is not in the base: delivery is passed through at close
   * to cost, and a code that discounted it would eat dispatch on every order.
   *
   * `percent` NEEDS NO ALLOCATION — every line is scaled by the same rate and
   * the rounded parts are summed, which is the engine's own "round per line,
   * then sum" rule (see the header). `fixed_amount` is the cart-level one, and
   * it is CLAMPED to the goods subtotal first: ₦500 off a ₦10 cart must not
   * produce a negative total and a shop that pays people to shop.
   */
  // Hoisted to a local so the discriminant narrows inside the closure below —
  // `input.discount` is a mutable property and TypeScript will not carry a
  // narrowing of one into a callback.
  const discount = input.discount ?? null;
  const goods = priced.map((line) => line.lineTotal.amount);
  const goodsTotal = goods.reduce((a, b) => a + b, 0);
  const codeDiscounts: number[] = !discount
    ? priced.map(() => 0)
    : discount.kind === 'percent'
      ? priced.map(
          (line) => scale(line.lineTotal, discount.percentBps, BPS, TOTALS_ROUNDING).amount,
        )
      : allocate(Math.min(discount.amount.amount, goodsTotal), goods);

  // 2 — the tax, per line, on the line as BOTH discounts left it.
  const lines: TotalsLine[] = priced.map((line, i) => {
    /* Negative, like an `Adjustment`: it is a summand, and one sign convention
     * for "money that moves a total" is one fewer thing to get backwards.
     *
     * The zero is spelled out rather than negated, because `-0` is a real value
     * in JavaScript that compares unequal to `0` under `Object.is` — so every
     * undiscounted line would carry a negative zero into the jsonb and into
     * every test that compares totals. */
    const off = codeDiscounts[i];
    const codeDiscount = off === 0 ? zero(currency) : money(-off, currency);
    const taxBase = add(line.lineTotal, codeDiscount);
    return {
      ...line,
      codeDiscount,
      // On the line after the ladder AND the code — the correct taxable base.
      taxAmount: line.taxable ? scale(taxBase, rate, BPS, TOTALS_ROUNDING) : zero(currency),
    };
  });

  // 3 — the LIST value of the goods. The code is reported separately, below, so
  // an invoice can show what was struck through rather than only the result.
  const subtotal = sum(
    lines.map((line) => line.lineTotal),
    currency,
  );

  const discountTotal = sum(
    lines.map((line) => line.codeDiscount),
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
   * THE ADD-ONS: a flat summand, after tax and outside every discount. Not
   * taxed (owner's decision, 2026-09-06), not a line (Orders would snapshot a
   * variant), not an Adjustment (those are payment instruments). Points
   * come off the whole bill, so they can still pay for one.
   */
  const addOns = [...(input.addOns ?? [])];
  const addOnTotal = sum(
    addOns.map((addOn) => addOn.amount),
    currency,
  );

  /*
   * 6 — ADJUSTMENTS ARE STILL APPLIED AFTER TAX, and that is now a narrow
   * statement rather than a general one.
   *
   * `adjustments` carries SpoolPoints redemption, and points are spent against
   * the order as a whole rather than against any line — there is no taxable
   * base for them to reduce, because the shopper is paying part of the bill
   * with a different instrument rather than buying the goods for less.
   *
   * WHAT USED TO SIT HERE was a warning that a real discount needs allocating
   * across lines before step 2. It does, and step 1c now does it — see there,
   * and CLAUDE.md §6. What survives of that warning is the part that still
   * binds: A CART-WIDE COUPON MAY NOT REUSE THE `codeDiscount` PATH WITHOUT
   * THINKING. It works for a code because a code is a share of the goods; a
   * gift card is a payment instrument and belongs where the points are.
   */
  const grandTotal = add(
    add(add(add(add(subtotal, discountTotal), adjustmentTotal), addOnTotal), shippingTotal),
    taxTotal,
  );

  return {
    ok: true,
    totals: {
      currency,
      lines,
      shipping: input.shipping,
      tax: input.tax,
      adjustments: [...input.adjustments],
      discount,
      addOns,
      addOnTotal,
      subtotal,
      discountTotal,
      adjustmentTotal,
      shippingTotal,
      taxTotal,
      grandTotal,
      rounding: TOTALS_ROUNDING,
    },
  };
}

/**
 * Rebuild the stored `discount`, or null for a payload frozen before there was
 * one. Kept out of `parseFrozenTotals` because it is the only field there whose
 * shape depends on a discriminant, and inlining the branch made the surrounding
 * object literal hard to read.
 */
function rebuildDiscount(value: unknown, m: (v: unknown) => Money): CodeDiscount | null {
  if (value === null || value === undefined) return null;
  const raw = value as Record<string, unknown>;
  const code = String(raw.code);
  const label = String(raw.label);
  return raw.kind === 'fixed_amount'
    ? { code, label, kind: 'fixed_amount', amount: m(raw.amount) }
    : { code, label, kind: 'percent', percentBps: Number(raw.percentBps) };
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
        /* THE SAME SEAM, ONE FEATURE LATER (admin#100 Part B). Every checkout
         * frozen before discount codes existed has no `codeDiscount` on any
         * line, permanently — and no code was applied to it, so zero is not a
         * guess but what that payload meant. */
        codeDiscount: line.codeDiscount === undefined ? zero(currency) : m(line.codeDiscount),
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
      /* Absent on every pre-Part-B payload, and `null` is what those meant:
       * no code was applied. Rebuilt through `m()` on the `fixed_amount` arm so
       * a corrupted amount is refused at this boundary like every other. */
      discount: rebuildDiscount(raw.discount, m),
      /* THE SAME SEAM, ONE FEATURE LATER (spec 2026-09-06). Absent on every
         payload frozen before add-ons existed, and "no add-ons" is what those
         meant. Each amount goes back through m() so a corrupt row is refused. */
      addOns: Array.isArray(raw.addOns)
        ? (raw.addOns as unknown[]).map((entry) => {
            const addOn = entry as Record<string, unknown>;
            return {
              id: String(addOn.id),
              title: String(addOn.title),
              mode: addOn.mode === 'included' ? 'included' : 'chosen',
              listPrice: m(addOn.listPrice),
              amount: m(addOn.amount),
            } satisfies FrozenAddOn;
          })
        : [],
      addOnTotal: raw.addOnTotal === undefined ? zero(currency) : m(raw.addOnTotal),
      subtotal: m(raw.subtotal),
      discountTotal: raw.discountTotal === undefined ? zero(currency) : m(raw.discountTotal),
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
