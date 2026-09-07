import { describe, expect, it } from 'vitest';
import { declaredValueMinor, fezKg, missingWeights, terminalItemKg, totalGrams } from './weights';

const line = (o: Partial<Parameters<typeof totalGrams>[0][number]> = {}) => ({
  orderLineId: 'oln_1', variantId: 'var_1', sku: 'A', title: 'A', qty: 2, unitMinor: 250000, weightGrams: 500, ...o,
});

describe('weights', () => {
  it('sums qty × grams, skipping lines with no weight', () => {
    expect(totalGrams([line(), line({ weightGrams: null })])).toBe(1000);
    expect(totalGrams([])).toBe(0);
  });
  it('lists the lines with no weight, once each', () => {
    expect(missingWeights([line(), line({ orderLineId: 'oln_2', variantId: 'var_2', weightGrams: null })]).map((l) => l.variantId)).toEqual(['var_2']);
  });
  it('Fez weight is whole kilograms, never below 1', () => {
    expect(fezKg(0)).toBe(1);
    expect(fezKg(999)).toBe(1);
    expect(fezKg(1000)).toBe(1);
    expect(fezKg(1001)).toBe(2);
  });
  it('Terminal item weight is kilograms to three decimals with a floor', () => {
    expect(terminalItemKg(500)).toBe(0.5);
    expect(terminalItemKg(1234)).toBe(1.234);
    expect(terminalItemKg(1)).toBe(0.01);
  });
  it('declared value is the parcel lines’ money, minor units', () => {
    expect(declaredValueMinor([line(), line({ qty: 1, unitMinor: 100 })])).toBe(500100);
  });
});
