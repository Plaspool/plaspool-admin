import { moneyRefusalMessage, parseMajor, plainMajor } from '../../data/api-shop';
import { money } from '../lib/format';
import { MoneyField } from '../ui/Field';

/**
 * A VARIANT'S THREE PRICES, laid out in the order an owner thinks about them:
 * what the customer pays, what it costs you, and — optionally — the higher
 * "was" price shown crossed out. Shared by the new-product page (which creates
 * the first variant) and the variant editor, so the two can never word or
 * check these differently.
 *
 * Values are kept as typed strings; `readPricing` turns them into minor units
 * or a sentence saying what is wrong.
 */
export interface PricingValues {
  price: string;
  cost: string;
  original: string;
}

export const EMPTY_PRICING: PricingValues = { price: '', cost: '', original: '' };

export function pricingFrom(
  v: { price: { amount: number } | null; costMinor: number | null; compareAtMinor: number | null },
  currency: string,
): PricingValues {
  return {
    price: v.price ? plainMajor(v.price.amount, currency) : '',
    cost: v.costMinor != null ? plainMajor(v.costMinor, currency) : '',
    original: v.compareAtMinor != null ? plainMajor(v.compareAtMinor, currency) : '',
  };
}

export type ReadPricing =
  | { ok: true; priceMinor: number | null; costMinor: number | null; compareAtMinor: number | null }
  | { ok: false; error: string };

/** Empty means "not set" for every field. Original must beat the price. */
export function readPricing(values: PricingValues, currency: string): ReadPricing {
  const read = (raw: string, label: string) => {
    if (raw.trim() === '') return { ok: true as const, minor: null };
    const parsed = parseMajor(raw, currency);
    return parsed.ok
      ? { ok: true as const, minor: parsed.minor }
      : { ok: false as const, error: `${label}: ${moneyRefusalMessage(parsed.reason, currency)}` };
  };
  const price = read(values.price, 'Price');
  if (!price.ok) return price;
  const cost = read(values.cost, 'Cost price');
  if (!cost.ok) return cost;
  const original = read(values.original, 'Original price');
  if (!original.ok) return original;
  if (original.minor !== null) {
    if (price.minor === null) {
      return { ok: false, error: 'Set a price before adding an original price.' };
    }
    if (original.minor <= price.minor) {
      return {
        ok: false,
        error: `Original price must be higher than the price of ${money(price.minor, currency)}, or left empty.`,
      };
    }
  }
  return { ok: true, priceMinor: price.minor, costMinor: cost.minor, compareAtMinor: original.minor };
}

export function PricingFields({
  values,
  currency,
  onChange,
}: {
  values: PricingValues;
  currency: string;
  onChange: (next: PricingValues) => void;
}) {
  const parse = (raw: string) => {
    if (raw.trim() === '') return null;
    const p = parseMajor(raw, currency);
    return p.ok ? p.minor : null;
  };
  const price = parse(values.price);
  const cost = parse(values.cost);
  const original = parse(values.original);

  const profitHint = (() => {
    if (price === null) return 'What one costs you to make or buy. Only you see this.';
    if (cost === null) return 'Add it to see your profit on each sale. Only you see this.';
    const profit = price - cost;
    if (price === 0) return `${money(profit, currency)} profit on each sale.`;
    const pct = Math.round((profit / price) * 1000) / 10;
    return profit < 0
      ? `You lose ${money(-profit, currency)} on each sale at this price.`
      : `${money(profit, currency)} profit on each sale (${pct}% margin).`;
  })();

  const originalHint =
    original !== null && price !== null && original <= price
      ? `Must be higher than ${money(price, currency)}.`
      : original !== null && price !== null
        ? `Customers see ${money(original, currency)} crossed out, saving ${money(original - price, currency)}.`
        : 'Optional. A higher price shown crossed out, so customers see a saving.';

  /* The owner's quick-fill rules (2026-08-25): original offers price +20%,
     cost offers price −15%, both rounded to the whole naira. Offers only — Tab
     types the digits out, and an untouched field stays empty. */
  const roundNaira = (minor: number) => Math.round(minor / 100) * 100;
  const set = (key: keyof PricingValues) => (value: string) => onChange({ ...values, [key]: value });

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <MoneyField
            label="Price"
            currency={currency}
            value={values.price}
            hint="What customers pay in your shop."
            onChange={(e) => set('price')(e.target.value)}
          />
        </div>
        <div style={{ flex: '1 1 14rem' }}>
          <MoneyField
            label="Cost price"
            currency={currency}
            value={values.cost}
            hint={profitHint}
            suggestion={price !== null ? plainMajor(roundNaira(price * 0.85), currency) : undefined}
            onSuggest={set('cost')}
            onChange={(e) => set('cost')(e.target.value)}
          />
        </div>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 14rem' }}>
          <MoneyField
            label="Original price (optional)"
            currency={currency}
            value={values.original}
            hint={originalHint}
            suggestion={price !== null ? plainMajor(roundNaira(price * 1.2), currency) : undefined}
            onSuggest={set('original')}
            onChange={(e) => set('original')(e.target.value)}
          />
        </div>
        <div style={{ flex: '1 1 14rem' }} aria-hidden="true" />
      </div>
    </div>
  );
}
