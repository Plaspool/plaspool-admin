import { ADD_ON_ATTRIBUTES } from '../../../shared/commerce/add-ons';
import type { AddOnAttribute, AddOnCondition, AddOnRule } from '../../../shared/commerce/add-ons';
import { formatMinor } from '../../data/api-shop';

/**
 * The admin's words for the rule builder (CLAUDE.md §7: plain, name the thing).
 * One label per registry entry — `add-on-copy.test.ts` fails the day the
 * registry grows without one.
 */
export const ATTRIBUTE_LABELS: Record<AddOnAttribute, string> = {
  item_count: 'Items in cart',
  distinct_products: 'Different products',
  subtotal_minor: 'Cart subtotal',
  total_weight_grams: 'Total weight (grams)',
  category: 'Category',
  tag: 'Tag',
  product: 'Product',
  sku: 'Product code',
  country: 'Delivery country',
  region: 'Delivery state',
  district: 'Delivery district',
  shipping_option: 'Delivery option',
  signed_in: 'Signed in',
  has_discount_code: 'Has a discount code',
};

export const NUMBER_OPS = [
  { value: 'eq', label: 'is exactly' },
  { value: 'gte', label: 'is at least' },
  { value: 'lte', label: 'is at most' },
  { value: 'between', label: 'is between' },
] as const;

export const SET_OPS = [
  { value: 'any_in', label: 'is any of' },
  { value: 'none_in', label: 'is none of' },
] as const;

export function kindOf(attribute: AddOnAttribute): 'number' | 'money' | 'set' | 'flag' {
  return ADD_ON_ATTRIBUTES[attribute].kind;
}

function amountWord(attribute: AddOnAttribute, value: number, currency: string): string {
  return kindOf(attribute) === 'money' ? formatMinor(value, currency) : String(value);
}

export function describeCondition(condition: AddOnCondition, currency: string): string {
  const label = ATTRIBUTE_LABELS[condition.attribute];
  switch (condition.op) {
    case 'eq':
    case 'gte':
    case 'lte': {
      const op = NUMBER_OPS.find((o) => o.value === condition.op)!.label;
      return `${label} ${op} ${amountWord(condition.attribute, condition.value, currency)}`;
    }
    case 'between':
      return `${label} is between ${amountWord(condition.attribute, condition.min, currency)} and ${amountWord(condition.attribute, condition.max, currency)}`;
    case 'any_in':
    case 'none_in': {
      const op = SET_OPS.find((o) => o.value === condition.op)!.label;
      return `${label} ${op} ${condition.values.join(' or ')}`;
    }
    case 'is':
      return `${label} is ${condition.value ? 'yes' : 'no'}`;
  }
}

/** "Ask when … · Included free when …" — the list's one-line summary. */
export function describeRules(rules: readonly AddOnRule[], priceMinor: number, currency: string): string {
  return rules
    .map((rule) => {
      const head =
        rule.then === 'ask'
          ? 'Ask'
          : rule.amountMinor === 0
            ? 'Included free'
            : rule.amountMinor != null && rule.amountMinor !== priceMinor
              ? `Included at ${formatMinor(rule.amountMinor, currency)}`
              : 'Included';
      const when = rule.when.length === 0 ? 'always' : `when ${rule.when.map((c) => describeCondition(c, currency)).join(' and ')}`;
      return `${head} ${when}`;
    })
    .join(' · ');
}
