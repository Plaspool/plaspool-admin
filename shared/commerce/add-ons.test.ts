import { describe, expect, it } from 'vitest';
import {
  ADD_ON_ATTRIBUTES,
  amountFor,
  attributesOfKind,
  evaluateAddOns,
  factsFrom,
  holds,
} from './add-ons';
import type { AddOnCartInput, AddOnCondition, AddOnFacts, AddOnRecord, AddOnRule } from './add-ons';

/**
 * The evaluator as a table. Every rule of §4 of the spec is a row here, so a
 * later attribute is added by adding a row rather than by re-reading the code.
 */
const facts = (over: Partial<AddOnFacts> = {}): AddOnFacts => ({
  currency: 'NGN',
  itemCount: 3,
  distinctProducts: 2,
  subtotalMinor: 4_500_000,
  totalWeightGrams: 3000,
  categories: ['Filament'],
  tags: ['pla', 'silk'],
  productIds: ['prd_a', 'prd_b'],
  skus: ['PLA-RED', 'PLA-BLUE'],
  country: 'NG',
  region: 'Lagos',
  district: 'lagos-ikeja',
  shippingOptionId: 'standard',
  signedIn: true,
  hasDiscountCode: false,
  choices: {},
  ...over,
});

const ask = (when: AddOnRule['when'] = []): AddOnRule => ({ when, then: 'ask' });
const include = (when: AddOnRule['when'] = [], amountMinor?: number | null): AddOnRule => ({
  when,
  then: 'include',
  ...(amountMinor === undefined ? {} : { amountMinor }),
});

const box = (rules: AddOnRule[], over: Partial<AddOnRecord> = {}): AddOnRecord => ({
  id: 'ado_box',
  title: 'Gift box',
  description: 'Boxed and ribboned.',
  imageUrl: null,
  priceMinor: 150_000,
  currency: 'NGN',
  rules,
  ...over,
});

describe('the registry', () => {
  it('sorts every attribute into exactly one kind', () => {
    const all = Object.keys(ADD_ON_ATTRIBUTES);
    const sorted = [
      ...attributesOfKind(['number', 'money']),
      ...attributesOfKind(['set']),
      ...attributesOfKind(['flag']),
    ];
    expect([...sorted].sort()).toEqual([...all].sort());
  });
});

describe('holds', () => {
  it.each([
    ['eq', { attribute: 'item_count', op: 'eq', value: 3 }, true],
    ['eq miss', { attribute: 'item_count', op: 'eq', value: 4 }, false],
    ['gte at the edge', { attribute: 'item_count', op: 'gte', value: 3 }, true],
    ['lte at the edge', { attribute: 'item_count', op: 'lte', value: 3 }, true],
    ['between inclusive low', { attribute: 'item_count', op: 'between', min: 3, max: 4 }, true],
    ['between inclusive high', { attribute: 'item_count', op: 'between', min: 1, max: 3 }, true],
    ['between miss', { attribute: 'item_count', op: 'between', min: 4, max: 9 }, false],
    ['money', { attribute: 'subtotal_minor', op: 'gte', value: 4_500_000 }, true],
    ['weight', { attribute: 'total_weight_grams', op: 'lte', value: 2999 }, false],
    ['distinct', { attribute: 'distinct_products', op: 'eq', value: 2 }, true],
    ['category, case-insensitive', { attribute: 'category', op: 'any_in', values: [' filament '] }, true],
    ['tag none_in', { attribute: 'tag', op: 'none_in', values: ['abs'] }, true],
    ['tag none_in hit', { attribute: 'tag', op: 'none_in', values: ['PLA'] }, false],
    ['product ids are exact', { attribute: 'product', op: 'any_in', values: ['PRD_A'] }, false],
    ['sku exact', { attribute: 'sku', op: 'any_in', values: ['PLA-RED'] }, true],
    ['country uppercased', { attribute: 'country', op: 'any_in', values: ['ng'] }, true],
    ['region', { attribute: 'region', op: 'any_in', values: ['lagos'] }, true],
    ['district', { attribute: 'district', op: 'none_in', values: ['abuja-wuse'] }, true],
    ['shipping option', { attribute: 'shipping_option', op: 'any_in', values: ['standard'] }, true],
    ['flag true', { attribute: 'signed_in', op: 'is', value: true }, true],
    ['flag false', { attribute: 'has_discount_code', op: 'is', value: true }, false],
  ] as const)('%s', (_name, condition, expected) => {
    expect(holds(condition as AddOnCondition, facts())).toBe(expected);
  });

  it('an absent address fact fails any_in and satisfies none_in', () => {
    const noAddress = facts({ country: null, region: null, district: null });
    expect(holds({ attribute: 'region', op: 'any_in', values: ['Lagos'] }, noAddress)).toBe(false);
    expect(holds({ attribute: 'region', op: 'none_in', values: ['Lagos'] }, noAddress)).toBe(true);
  });
});

describe('evaluateAddOns', () => {
  it('the first rule that fits decides, and [] conditions always fit', () => {
    const offers = evaluateAddOns(
      [box([ask([{ attribute: 'item_count', op: 'between', min: 1, max: 4 }]), include([{ attribute: 'item_count', op: 'gte', value: 5 }])])],
      facts({ itemCount: 5 }),
    );
    expect(offers).toEqual([
      {
        id: 'ado_box',
        title: 'Gift box',
        description: 'Boxed and ribboned.',
        imageUrl: null,
        price: { amount: 150_000, currency: 'NGN' },
        amount: { amount: 150_000, currency: 'NGN' },
        mode: 'include',
        choice: null,
      },
    ]);
    expect(evaluateAddOns([box([include()])], facts({ itemCount: 0 }))[0]?.mode).toBe('include');
  });

  it('no rule fits → no offer; a foreign currency is skipped, not refused', () => {
    expect(evaluateAddOns([box([ask([{ attribute: 'item_count', op: 'gte', value: 9 }])])], facts())).toEqual([]);
    expect(evaluateAddOns([box([ask()], { currency: 'USD' })], facts())).toEqual([]);
  });

  it('a rule may override the amount; 0 is free; absent means the price', () => {
    expect(amountFor(box([]), include([], 0))).toBe(0);
    expect(amountFor(box([]), include([], 20_000))).toBe(20_000);
    expect(amountFor(box([]), include([], null))).toBe(150_000);
    expect(amountFor(box([]), ask())).toBe(150_000);
    const [free] = evaluateAddOns([box([include([], 0)])], facts());
    expect(free?.amount).toEqual({ amount: 0, currency: 'NGN' });
    expect(free?.price).toEqual({ amount: 150_000, currency: 'NGN' });
  });

  it('ask carries the stored choice; include ignores it', () => {
    const chosen = facts({ choices: { ado_box: 'accepted' } });
    expect(evaluateAddOns([box([ask()])], chosen)[0]?.choice).toBe('accepted');
    expect(evaluateAddOns([box([include()])], chosen)[0]?.choice).toBeNull();
    expect(evaluateAddOns([box([ask()])], facts())[0]?.choice).toBeNull();
  });

  it('keeps the input order', () => {
    const offers = evaluateAddOns(
      [box([ask()], { id: 'ado_1' }), box([ask()], { id: 'ado_2' })],
      facts(),
    );
    expect(offers.map((o) => o.id)).toEqual(['ado_1', 'ado_2']);
  });
});

describe('factsFrom', () => {
  it('derives every fact from the cart input and the product lookup', () => {
    const input: AddOnCartInput = {
      currency: 'NGN',
      lines: [
        { productId: 'prd_a', variantId: 'var_1', sku: 'PLA-RED', qty: 2, weightGrams: 1000, lineTotalMinor: 3_000_000 },
        { productId: 'prd_a', variantId: 'var_2', sku: 'PLA-BLUE', qty: 1, weightGrams: null, lineTotalMinor: 1_500_000 },
        { productId: 'prd_b', variantId: 'var_3', sku: 'ABS-BLK', qty: 1, weightGrams: 750, lineTotalMinor: 900_000 },
      ],
      subtotalMinor: 5_400_000,
      address: { country: 'NG', region: 'Lagos', district: null },
      shippingOptionId: null,
      signedIn: false,
      hasDiscountCode: true,
      choices: null,
    };
    const products = new Map([
      ['prd_a', { category: 'Filament', tags: ['pla'] }],
      ['prd_b', { category: 'Filament', tags: ['abs', 'black'] }],
    ]);
    expect(factsFrom(input, products)).toEqual({
      currency: 'NGN',
      itemCount: 4,
      distinctProducts: 2,
      subtotalMinor: 5_400_000,
      totalWeightGrams: 2750,
      categories: ['Filament'],
      tags: ['pla', 'abs', 'black'],
      productIds: ['prd_a', 'prd_b'],
      skus: ['PLA-RED', 'PLA-BLUE', 'ABS-BLK'],
      country: 'NG',
      region: 'Lagos',
      district: null,
      shippingOptionId: null,
      signedIn: false,
      hasDiscountCode: true,
      choices: {},
    });
  });
});
