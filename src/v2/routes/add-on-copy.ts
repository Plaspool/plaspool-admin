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

/** The full sentence, the way the editor's pickers read it. */
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

/** What the rule does, in two or three words: the head of both sentence shapes. */
function ruleHead(rule: AddOnRule, priceMinor: number, currency: string): string {
  if (rule.then === 'ask') return 'Ask';
  if (rule.amountMinor === 0) return 'Included free';
  if (rule.amountMinor != null && rule.amountMinor !== priceMinor) return `Included at ${formatMinor(rule.amountMinor, currency)}`;
  return 'Included';
}

/** One rule as a sentence: "Ask when Items in cart is between 1 and 4". */
export function describeRule(rule: AddOnRule, priceMinor: number, currency: string): string {
  const when = rule.when.length === 0 ? 'always' : `when ${rule.when.map((c) => describeCondition(c, currency)).join(' and ')}`;
  return `${ruleHead(rule, priceMinor, currency)} ${when}`;
}

/*
 * THE SHORT FORM — what the list shows in its "When it's offered" column,
 * after the owner saw the full sentence push Status off the screen (2026-09-06).
 * A condition in a few words: "1–4 items", "subtotal ₦20,000+", "tag: gift,
 * silk +1", "not signed in". The full sentence stays one hover away, behind
 * the (i), so nothing is lost — only moved.
 */

/** Attributes that read as a count of things: the noun follows the number. */
const COUNT_NOUNS: Partial<Record<AddOnAttribute, [one: string, many: string]>> = {
  item_count: ['item', 'items'],
  distinct_products: ['product', 'products'],
};

/** Attributes that read as a measure: the noun leads, the amount follows. */
const LEAD_NOUNS: Partial<Record<AddOnAttribute, string>> = {
  subtotal_minor: 'subtotal',
  total_weight_grams: 'weight',
};

/** The short noun for a set attribute — "state: Lagos", "code: PLA-1". */
const SET_NOUNS: Partial<Record<AddOnAttribute, string>> = {
  category: 'category',
  tag: 'tag',
  product: 'product',
  sku: 'code',
  country: 'country',
  region: 'state',
  district: 'district',
  shipping_option: 'delivery',
};

function shortAmount(attribute: AddOnAttribute, value: number, currency: string): string {
  if (kindOf(attribute) === 'money') return formatMinor(value, currency);
  if (attribute === 'total_weight_grams') return `${value.toLocaleString()} g`;
  return String(value);
}

export function shortCondition(condition: AddOnCondition, currency: string): string {
  const attribute = condition.attribute;
  const count = COUNT_NOUNS[attribute];
  const lead = LEAD_NOUNS[attribute] ?? ATTRIBUTE_LABELS[attribute].toLowerCase();
  const noun = (n: number) => (count ? (n === 1 ? count[0] : count[1]) : '');
  const amount = (n: number) => shortAmount(attribute, n, currency);
  switch (condition.op) {
    case 'eq':
      return count ? `exactly ${condition.value} ${noun(condition.value)}` : `${lead} exactly ${amount(condition.value)}`;
    case 'gte':
      return count ? `${condition.value}+ ${noun(2)}` : `${lead} ${amount(condition.value)}+`;
    case 'lte':
      return count ? `up to ${condition.value} ${noun(condition.value)}` : `${lead} up to ${amount(condition.value)}`;
    case 'between':
      return count
        ? `${condition.min}–${condition.max} ${noun(condition.max)}`
        : `${lead} ${amount(condition.min)}–${amount(condition.max)}`;
    case 'any_in':
    case 'none_in': {
      const not = condition.op === 'none_in';
      if (attribute === 'product') {
        const n = condition.values.length;
        return `${not ? 'not ' : ''}${n} ${n === 1 ? 'product' : 'products'}`;
      }
      const shown = condition.values.slice(0, 2).join(', ') || '—';
      const rest = condition.values.length - 2;
      const list = rest > 0 ? `${shown} +${rest}` : shown;
      return not ? `${SET_NOUNS[attribute] ?? lead} not ${list}` : `${SET_NOUNS[attribute] ?? lead}: ${list}`;
    }
    case 'is':
      if (attribute === 'signed_in') return condition.value ? 'signed in' : 'not signed in';
      if (attribute === 'has_discount_code') return condition.value ? 'with a discount code' : 'no discount code';
      return `${lead}: ${condition.value ? 'yes' : 'no'}`;
  }
}

/**
 * The list's lead — the first rule in a few words, "Ask · 1–4 items" — and
 * how many more rules follow it. Rules are read top to bottom and the first
 * that fits decides, so the first one is the one worth the column; the rest
 * are a count, and the (i) beside it carries every sentence in full.
 */
export function summariseRules(rules: readonly AddOnRule[], priceMinor: number, currency: string): { lead: string; more: number } {
  if (rules.length === 0) return { lead: 'Never offered', more: 0 };
  const [first] = rules;
  const when = first.when.length === 0 ? 'always' : first.when.map((c) => shortCondition(c, currency)).join(', ');
  return { lead: `${ruleHead(first, priceMinor, currency)} · ${when}`, more: rules.length - 1 };
}
