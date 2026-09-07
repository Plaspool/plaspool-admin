import { describe, expect, it } from 'vitest';
import { ADD_ON_ATTRIBUTES, ADD_ON_BASES, ADD_ON_MODES } from '../../../shared/commerce/add-ons';
import { ATTRIBUTE_LABELS, BASIS_LABELS, MODE_LABELS, describeCondition, describeRule, shortCondition, summariseRules } from './add-on-copy';

/**
 * Money, matched WITHOUT its exact locale rendering. `formatMinor` resolves
 * the process default locale, and `Intl` renders NGN as "45,000.00" with the
 * naira sign under a full ICU and with the bare "NGN" code under a small one
 * -- so a literal pin here passes on one machine and fails on a `LANG=C`
 * runner. `SpoolsAnalytics.test.tsx` states the same reasoning at length.
 * `norm` collapses the non-breaking space Intl puts before the code (U+00A0,
 * or the narrow U+202F) to a plain one; the digits are the point either way.
 * Escapes, not literal characters: an editor that "helpfully" normalises
 * whitespace turned the literal into a plain space once, and every money
 * assertion here failed on a string that was right.
 */
const norm = (s: string) => s.replace(/[  ]/g, ' ');

const demo = [
  { when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' },
  { when: [{ attribute: 'item_count', op: 'gte', value: 5 }], then: 'include', amountMinor: 0 },
] as const;

describe('add-on copy', () => {
  it('labels every attribute in the registry', () => {
    for (const key of Object.keys(ADD_ON_ATTRIBUTES)) {
      expect(ATTRIBUTE_LABELS[key as keyof typeof ATTRIBUTE_LABELS]).toBeTruthy();
    }
  });

  it('reads a condition the way the picker shows it', () => {
    expect(describeCondition({ attribute: 'item_count', op: 'between', min: 1, max: 4 }, 'NGN')).toBe('Items in cart is between 1 and 4');
    expect(describeCondition({ attribute: 'item_count', op: 'gte', value: 5 }, 'NGN')).toBe('Items in cart is at least 5');
    expect(norm(describeCondition({ attribute: 'subtotal_minor', op: 'lte', value: 4_500_000 }, 'NGN'))).toMatch(/^Cart subtotal is at most (?:₦|NGN ?)45,?000\.00$/);
    expect(describeCondition({ attribute: 'tag', op: 'any_in', values: ['pla', 'silk'] }, 'NGN')).toBe('Tag is any of pla or silk');
    expect(describeCondition({ attribute: 'signed_in', op: 'is', value: false }, 'NGN')).toBe('Signed in is no');
  });

  it('reads a rule as one sentence', () => {
    expect(describeRule(demo[0], 150_000, 'NGN')).toBe('Ask when Items in cart is between 1 and 4');
    expect(describeRule(demo[1], 150_000, 'NGN')).toBe('Included free when Items in cart is at least 5');
    expect(norm(describeRule({ when: [], then: 'include', amountMinor: 20_000 }, 150_000, 'NGN'))).toMatch(/^Included at (?:₦|NGN ?)200\.00 always$/);
    expect(describeRule({ when: [], then: 'ask' }, 150_000, 'NGN')).toBe('Ask always');
  });

  it('shortens a condition to a few words for the list', () => {
    expect(shortCondition({ attribute: 'item_count', op: 'between', min: 1, max: 4 }, 'NGN')).toBe('1–4 items');
    expect(shortCondition({ attribute: 'item_count', op: 'gte', value: 5 }, 'NGN')).toBe('5+ items');
    expect(shortCondition({ attribute: 'item_count', op: 'lte', value: 1 }, 'NGN')).toBe('up to 1 item');
    expect(shortCondition({ attribute: 'distinct_products', op: 'eq', value: 2 }, 'NGN')).toBe('exactly 2 products');
    expect(norm(shortCondition({ attribute: 'subtotal_minor', op: 'gte', value: 2_000_000 }, 'NGN'))).toMatch(/^subtotal (?:₦|NGN ?)20,?000\.00\+$/);
    expect(shortCondition({ attribute: 'total_weight_grams', op: 'between', min: 500, max: 2000 }, 'NGN')).toMatch(/^weight 500 g–2,?000 g$/);
    expect(shortCondition({ attribute: 'tag', op: 'any_in', values: ['gift', 'silk', 'pla'] }, 'NGN')).toBe('tag: gift, silk +1');
    expect(shortCondition({ attribute: 'region', op: 'none_in', values: ['Lagos'] }, 'NGN')).toBe('state not Lagos');
    expect(shortCondition({ attribute: 'product', op: 'any_in', values: ['prd_1', 'prd_2'] }, 'NGN')).toBe('2 products');
    expect(shortCondition({ attribute: 'signed_in', op: 'is', value: false }, 'NGN')).toBe('not signed in');
    expect(shortCondition({ attribute: 'has_discount_code', op: 'is', value: true }, 'NGN')).toBe('with a discount code');
  });

  it('leads the list with the first rule and counts the rest', () => {
    expect(summariseRules([...demo], 150_000, 'NGN')).toEqual({ lead: 'Ask · 1–4 items', more: 1 });
    expect(summariseRules([{ when: [], then: 'ask' }], 150_000, 'NGN')).toEqual({ lead: 'Ask · always', more: 0 });
    expect(summariseRules([], 150_000, 'NGN')).toEqual({ lead: 'Never offered', more: 0 });
  });

  /*
   * 0960's two words, and the promise that goes with them: EVERY PER-ORDER
   * SENTENCE IS UNCHANGED. 571 assertions across the v2 suites match on
   * visible text, so `each` had to be a suffix rather than a rewrite -- the
   * four assertions above are the ones that would have gone red.
   */
  it('says what a per-item rule costs, and what taking it out gives back', () => {
    const optOut = { when: [], then: 'opt_out', basis: 'item' } as const;
    expect(norm(describeRule(optOut, 50_000, 'NGN'))).toMatch(/^In the price, save (?:₦|NGN ?)500\.00 each always$/);
    expect(norm(describeRule({ when: [], then: 'opt_out' }, 50_000, 'NGN'))).toMatch(/^In the price, save (?:₦|NGN ?)500\.00 always$/);
    // Free to take out is not a saving, and must not read as one.
    expect(describeRule({ when: [], then: 'opt_out', amountMinor: 0 }, 50_000, 'NGN')).toBe('In the price always');
    expect(norm(describeRule({ when: [], then: 'ask', basis: 'item' }, 50_000, 'NGN'))).toMatch(/^Ask, (?:₦|NGN ?)500\.00 each always$/);
    expect(norm(describeRule({ when: [], then: 'include', basis: 'item' }, 50_000, 'NGN'))).toMatch(/^Included at (?:₦|NGN ?)500\.00 each always$/);
  });

  it('every mode and every basis has a label, straight off the registry', () => {
    for (const mode of ADD_ON_MODES) expect(MODE_LABELS[mode]).toBeTruthy();
    for (const basis of ADD_ON_BASES) expect(BASIS_LABELS[basis]).toBeTruthy();
  });
});
