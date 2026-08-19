import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIPPING_ZONES,
  ShippingConfigError,
  shippingOptionsFor,
  zoneFor,
} from './shipping';
import type { ShippingZone } from './shipping';

/**
 * `zoneFor` region matching (admin#19) and the real NG rate arithmetic.
 *
 * `DEFAULT_SHIPPING_ZONES` is exercised directly because it is now the
 * empty-database fallback and must itself carry the correct Nigerian values —
 * a wrong fallback would be invisible until the day the database is empty.
 */

describe('zoneFor — region matching', () => {
  it('matches a zone by exact region', () => {
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Lagos');
    expect(zone.id).toBe('lagos');
  });

  it('matches case-insensitively', () => {
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'lagos').id).toBe('lagos');
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'LAGOS').id).toBe('lagos');
  });

  it('matches whitespace-insensitively', () => {
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', '  Lagos  ').id).toBe('lagos');
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', '\tLagos\n').id).toBe('lagos');
  });

  it('matches Abuja under any of its named regions', () => {
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Abuja').id).toBe('abuja');
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'FCT').id).toBe('abuja');
    expect(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'federal capital territory').id).toBe('abuja');
  });

  it('falls through to the fallback zone for an unrecognised region', () => {
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Kano');
    expect(zone.id).toBe('rest-of-nigeria');
  });

  it('falls through to the fallback zone for a null region', () => {
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', null);
    expect(zone.id).toBe('rest-of-nigeria');
  });

  it('falls through to the fallback zone when region is omitted (2-arg call)', () => {
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG');
    expect(zone.id).toBe('rest-of-nigeria');
  });

  it('still throws when no fallback zone is configured', () => {
    const noFallback: ShippingZone[] = DEFAULT_SHIPPING_ZONES.map((z) => ({
      ...z,
      fallback: false,
    }));
    expect(() => zoneFor(noFallback, 'NG', 'Kano')).toThrow(ShippingConfigError);
    expect(() => zoneFor(noFallback, 'ZZ')).toThrow(ShippingConfigError);
  });

  it('an unmatched country falls back rather than defaulting to the first zone', () => {
    // The fallback zone's `countries: []` is what makes it catch anything no
    // other zone claims — matching the original UK config's `international`
    // zone, whose `countries: []` meant the same thing.
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'US', 'Lagos');
    expect(zone.id).toBe('rest-of-nigeria');
  });
});

describe('rate arithmetic — the real NG values, in minor units', () => {
  it('Abuja delivery is exactly ₦3,000 (300000 minor units)', () => {
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Abuja');
    const [option] = shippingOptionsFor(zone, 'NGN');
    expect(option.amount.amount).toBe(300_000);
  });

  it('Lagos and the fallback are exactly ₦10,000 (1000000 minor units)', () => {
    const lagos = shippingOptionsFor(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Lagos'), 'NGN')[0];
    const rest = shippingOptionsFor(zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Kano'), 'NGN')[0];
    expect(lagos.amount.amount).toBe(1_000_000);
    expect(rest.amount.amount).toBe(1_000_000);
  });

  /*
   * A ₦23,000 spool (a live variant price, 100 minor units per naira) plus
   * Abuja delivery. Hardcoded literal minor-unit numbers so a 100x scale slip
   * cannot pass silently.
   */
  it('a ₦23,000 spool plus Abuja delivery totals 2,600,000 minor units', () => {
    const itemMinor = 2_300_000;
    const zone = zoneFor(DEFAULT_SHIPPING_ZONES, 'NG', 'Abuja');
    const [option] = shippingOptionsFor(zone, 'NGN');
    expect(option.amount.amount).toBe(300_000);
    expect(itemMinor + option.amount.amount).toBe(2_600_000);
  });

  it('no zone carries a tax rate — taxRateBps is 0 everywhere', () => {
    for (const zone of DEFAULT_SHIPPING_ZONES) {
      expect(zone.taxRateBps).toBe(0);
    }
  });
});
