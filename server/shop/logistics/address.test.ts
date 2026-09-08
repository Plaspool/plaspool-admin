import { describe, expect, it } from 'vitest';
import { fezStateName, oneLine, readShippingAddress, splitName, terminalStateName, toE164, zipFor } from './address';

describe('readShippingAddress', () => {
  /* AN EXACT `toEqual`, KEPT EXACT. This narrows an opaque jsonb blob, so the
     only thing standing between a field the snapshot stopped carrying and a
     courier quietly not being told about it is a whole-object assertion. */
  it('narrows the jsonb snapshot and tolerates the older shapes', () => {
    expect(readShippingAddress({ name: 'Ada Obi', line1: '1 Test Close', line2: null, city: 'Gwarinpa', region: 'FCT', postalCode: null, countryCode: 'NG', phone: '08012345678' }))
      .toEqual({ name: 'Ada Obi', line1: '1 Test Close', line2: null, city: 'Gwarinpa', region: 'FCT', postalCode: null, countryCode: 'NG', phone: '08012345678', email: null, routingCity: null });
    expect(readShippingAddress({ name: 'A', line1: '1', city: 'Abuja', country: 'NG' }).countryCode).toBe('NG');
  });

  /* THE ZONE THE SHOPPER PICKED (migration 1020), carried BESIDE the city they
     typed. Every order placed before 1020 has none, so absent must read as
     `null` rather than as a throw — that fallback IS today's behaviour. */
  it('carries the routing city when there is one, and null when there is not', () => {
    const base = { name: 'Ada Obi', line1: '1 Test Close', city: 'Gwarinpa', region: 'FCT', countryCode: 'NG' };
    expect(readShippingAddress({ ...base, routingCity: 'Maitama' })).toMatchObject({ city: 'Gwarinpa', routingCity: 'Maitama' });
    expect(readShippingAddress(base).routingCity).toBeNull();
    expect(readShippingAddress({ ...base, routingCity: null }).routingCity).toBeNull();
    expect(readShippingAddress({ ...base, routingCity: '  ' }).routingCity).toBeNull();
  });
  it('reports what is missing rather than guessing', () => {
    expect(() => readShippingAddress({ name: 'A', city: 'Abuja', countryCode: 'NG' })).toThrow(/line1/);
  });
});

describe('helpers', () => {
  it('splits a name, repeating a lone token', () => {
    expect(splitName('Ada Obi')).toEqual({ firstName: 'Ada', lastName: 'Obi' });
    expect(splitName('Ada Ngozi Obi')).toEqual({ firstName: 'Ada', lastName: 'Ngozi Obi' });
    expect(splitName('Ada')).toEqual({ firstName: 'Ada', lastName: 'Ada' });
  });
  it.each([
    ['08012345678', '+2348012345678'], ['0801 234 5678', '+2348012345678'], ['2348012345678', '+2348012345678'],
    ['+2348012345678', '+2348012345678'], ['+44 20 7946 0958', '+442079460958'], ['12', null], ['', null],
  ])('toE164(%s) → %s', (raw, want) => expect(toE164(raw)).toBe(want));
  it.each([['Abuja', 'FCT'], ['FCT', 'FCT'], ['Federal Capital Territory', 'FCT'], ['Abuja FCT', 'FCT'], [' lagos ', 'Lagos'], ['Akwa Ibom', 'Akwa Ibom']])(
    'fezStateName(%s) → %s', (raw, want) => expect(fezStateName(raw)).toBe(want));
  /* The two couriers disagree about the capital territory, in opposite
     directions. Terminal's sandbox refused `FCT` outright on 2026-09-07 and
     answered with its own list of 37 names, in which it is `Abuja`. */
  it.each([
    ['FCT', 'Abuja'], ['fct', 'Abuja'], ['Abuja', 'Abuja'], ['Federal Capital Territory', 'Abuja'],
    ['Abuja FCT', 'Abuja'], [' lagos ', 'Lagos'], ['akwa  ibom', 'Akwa Ibom'], ['cross river', 'Cross River'],
    ['Nowhere', 'Nowhere'],
  ])('terminalStateName(%s) → %s', (raw, want) => expect(terminalStateName(raw)).toBe(want));

  it('spells the capital territory differently for each courier', () => {
    expect(fezStateName('Abuja')).toBe('FCT');
    expect(terminalStateName('FCT')).toBe('Abuja');
  });

  it('falls back to a state capital postcode, then Lagos', () => {
    expect(zipFor('900108', 'FCT')).toBe('900108');
    expect(zipFor(null, 'FCT')).toBe('900001');
    expect(zipFor('', 'Lagos')).toBe('100001');
    expect(zipFor(null, 'Nowhere')).toBe('100001');
  });
  it('joins an address onto one line', () => {
    expect(oneLine({ line1: '1 Test Close', line2: 'Flat 2', city: 'Gwarinpa' })).toBe('1 Test Close, Flat 2, Gwarinpa');
    expect(oneLine({ line1: '1 Test Close', line2: null, city: 'Gwarinpa' })).toBe('1 Test Close, Gwarinpa');
  });
});
