import { describe, expect, it } from 'vitest';
import {
  ADD_ON_ATTRIBUTES,
  basisFor,
  unitAmountFor,
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
        unitAmount: { amount: 150_000, currency: 'NGN' },
        units: 1,
        basis: 'order',
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
    expect(unitAmountFor(box([]), include([], 0))).toBe(0);
    expect(unitAmountFor(box([]), include([], 20_000))).toBe(20_000);
    expect(unitAmountFor(box([]), include([], null))).toBe(150_000);
    expect(unitAmountFor(box([]), ask())).toBe(150_000);
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
/**
 * PER-ITEM PRICING AND TAKING SOMETHING BACK OUT (migration 0960).
 *
 * The owner's worked example is the first test and every number in it is
 * theirs: a box already inside the product price, 500 naira each, offered for
 * removal on carts of one to four items, and 2,000 naira back when four are
 * taken out.
 */
describe('basis and opt_out', () => {
  const optOut = (when: AddOnRule['when'] = [], over: Partial<AddOnRule> = {}): AddOnRule => ({
    when,
    then: 'opt_out',
    ...over,
  });
  const only = (rules: AddOnRule[], over: Partial<AddOnFacts> = {}) =>
    evaluateAddOns([box(rules, { priceMinor: 50_000 })], facts(over))[0];

  it("the owner's example: four items, box taken out, 2,000 naira back", () => {
    const rule = optOut([{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], { basis: 'item' });
    const offer = only([rule], { itemCount: 4, choices: { ado_box: 'declined' } });
    expect(offer.mode).toBe('opt_out');
    expect(offer.units).toBe(4);
    expect(offer.unitAmount).toEqual({ amount: -50_000, currency: 'NGN' });
    expect(offer.amount).toEqual({ amount: -200_000, currency: 'NGN' });
  });

  it('kept, or never answered, costs nothing at all — it is already in the price', () => {
    const rule = optOut([], { basis: 'item' });
    expect(only([rule], { itemCount: 4 }).amount.amount).toBe(0);
    expect(only([rule], { itemCount: 4 }).choice).toBe(null);
    expect(only([rule], { itemCount: 4, choices: { ado_box: 'accepted' } }).amount.amount).toBe(0);
    // Kept still reports what one WOULD have been worth, so a screen can say
    // "save 500 each" without a second read.
    expect(only([rule], { itemCount: 4 }).unitAmount.amount).toBe(50_000);
  });

  it('a cart of five is over the limit, so nothing is offered and the boxes stay', () => {
    const rule = optOut([{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], { basis: 'item' });
    expect(evaluateAddOns([box([rule])], facts({ itemCount: 5, choices: { ado_box: 'declined' } }))).toEqual([]);
  });

  it('per item multiplies a CHARGE too, and per order is still the default', () => {
    const perItem = only([{ when: [], then: 'include', basis: 'item' }], { itemCount: 3 });
    expect(perItem.amount).toEqual({ amount: 150_000, currency: 'NGN' });
    expect(perItem.units).toBe(3);

    const perOrder = only([{ when: [], then: 'include' }], { itemCount: 3 });
    expect(perOrder.amount).toEqual({ amount: 50_000, currency: 'NGN' });
    expect(perOrder.units).toBe(1);
    expect(perOrder.basis).toBe('order');
  });

  it('an ask still charges nothing until it is accepted, per item or not', () => {
    const rule: AddOnRule = { when: [], then: 'ask', basis: 'item' };
    expect(only([rule], { itemCount: 3 }).amount.amount).toBe(0);
    expect(only([rule], { itemCount: 3, choices: { ado_box: 'declined' } }).amount.amount).toBe(0);
    expect(only([rule], { itemCount: 3, choices: { ado_box: 'accepted' } }).amount.amount).toBe(150_000);
  });

  it('the rule amount overrides the price PER UNIT, not per cart', () => {
    const offer = only([{ when: [], then: 'include', basis: 'item', amountMinor: 10_000 }], { itemCount: 6 });
    expect(offer.unitAmount.amount).toBe(10_000);
    expect(offer.amount.amount).toBe(60_000);
    // The list price is untouched: it is what one is worth, so a strike-through
    // has something to strike.
    expect(offer.price.amount).toBe(50_000);
  });

  /*
   * THE BACKSTOP. A misconfigured saving must cost the shop the cart at worst,
   * and must never mint a negative payment intent — Paystack cannot be asked
   * for one, and a checkout that cannot be paid is worse than a wrong price.
   */
  it('savings are capped at the goods subtotal, and the cap is shared across add-ons', () => {
    const huge = only([optOut([], { basis: 'item', amountMinor: 5_000_000 })], {
      itemCount: 1,
      subtotalMinor: 2_800_000,
      choices: { ado_box: 'declined' },
    });
    expect(huge.amount.amount).toBe(-2_800_000);

    const two = evaluateAddOns(
      [
        box([optOut([], { amountMinor: 200_000 })], { id: 'a', priceMinor: 200_000 }),
        box([optOut([], { amountMinor: 200_000 })], { id: 'b', priceMinor: 200_000 }),
      ],
      facts({ subtotalMinor: 300_000, choices: { a: 'declined', b: 'declined' } }),
    );
    expect(two.map((o) => o.amount.amount)).toEqual([-200_000, -100_000]);
  });

  it('a rule stored before 0960 has no basis key and still means once per order', () => {
    const legacy = JSON.parse('{"when":[],"then":"include"}') as AddOnRule;
    expect(basisFor(legacy)).toBe('order');
    expect(only([legacy], { itemCount: 9 }).units).toBe(1);
  });
});
