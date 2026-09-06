import { describe, expect, it } from 'vitest';
import { ADD_ON_ATTRIBUTES } from '../../../shared/commerce/add-ons';
import { ATTRIBUTE_LABELS, describeCondition, describeRules } from './add-on-copy';

/**
 * Money, matched WITHOUT its exact locale rendering. `formatMinor` resolves
 * the process default locale, and `Intl` renders NGN as "45,000.00" with the
 * naira sign under a full ICU and with the bare "NGN" code under a small one
 * -- so a literal pin here passes on one machine and fails on a `LANG=C`
 * runner. `SpoolsAnalytics.test.tsx` states the same reasoning at length.
 * `norm` collapses the non-breaking space Intl puts before the code to a
 * plain one; the digits are the point either way.
 */
const norm = (s: string) => s.replace(/ /g, ' ');

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

  it('summarises the demo rules', () => {
    const rules = [
      { when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' },
      { when: [{ attribute: 'item_count', op: 'gte', value: 5 }], then: 'include', amountMinor: 0 },
    ] as const;
    expect(describeRules([...rules], 150_000, 'NGN')).toBe(
      'Ask when Items in cart is between 1 and 4 · Included free when Items in cart is at least 5',
    );
    expect(norm(describeRules([{ when: [], then: 'include', amountMinor: 20_000 }], 150_000, 'NGN'))).toMatch(/^Included at (?:₦|NGN ?)200\.00 always$/);
    expect(describeRules([{ when: [], then: 'ask' }], 150_000, 'NGN')).toBe('Ask always');
  });
});
