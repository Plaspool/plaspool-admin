import { describe, expect, it } from 'vitest';
import { ADDRESS_MAX_LENGTHS, deliveryConfigFor } from './config';
import type { AddressFieldKey } from './config';
import type { DeliverySettings } from './repo';

/**
 * The address form, as a pure function of the settings row.
 *
 * NO DATABASE HERE ON PURPOSE. `deliveryConfigFor` reads nothing and takes
 * everything as an argument, so the whole contract the storefront renders from
 * is checkable by calling it — the same property `totals/compute.ts` has and
 * for the same reason. The route that serves it is driven for real in
 * `public.test.ts`, which is where the headers and the mount are asserted.
 */

const DISTRICT_MODE: DeliverySettings = {
  addressMode: 'district',
  locationOffered: false,
  servedRegions: null,
  servedCountries: ['NG'],
  revision: 1,
  updatedAt: 0,
};

const SIMPLE_MODE: DeliverySettings = { ...DISTRICT_MODE, addressMode: 'simple', revision: 2 };

const shown = (settings: DeliverySettings): AddressFieldKey[] =>
  deliveryConfigFor(settings)
    .fields.filter((f) => f.show)
    .map((f) => f.key);

const required = (settings: DeliverySettings): AddressFieldKey[] =>
  deliveryConfigFor(settings)
    .fields.filter((f) => f.show && f.required)
    .map((f) => f.key);

describe('mode: district — today’s form, written down', () => {
  it('asks for the district, in the order the storefront renders', () => {
    expect(shown(DISTRICT_MODE)).toEqual([
      'name',
      'phone',
      'region',
      'district',
      'city',
      'line1',
      'line2',
    ]);
  });

  it('marks line2 optional and everything else required', () => {
    expect(required(DISTRICT_MODE)).toEqual(['name', 'phone', 'region', 'district', 'city', 'line1']);
  });

  it('points at the areas list so the storefront does not hardcode the URL', () => {
    expect(deliveryConfigFor(DISTRICT_MODE).districts).toMatchObject({
      source: '/api/public/marketing/areas',
      groupBy: 'region',
    });
  });
});

describe('mode: simple — the district question goes away', () => {
  it('drops the district and asks six things', () => {
    expect(shown(SIMPLE_MODE)).toEqual(['name', 'phone', 'region', 'city', 'line1', 'line2']);
  });

  /*
   * The storefront is told to omit a hidden field from the body rather than
   * send `""`. `district` is `.nullable().optional()` server-side, so an
   * omission already means "no opinion — zone rate"; an empty string would be
   * an area key nothing matches, which is the same answer by accident rather
   * than on purpose.
   */
  it('still LISTS district and postalCode, hidden — absence is explicit, not inferred', () => {
    const keys = deliveryConfigFor(SIMPLE_MODE).fields.map((f) => f.key);
    expect(keys).toContain('district');
    expect(keys).toContain('postalCode');
    const district = deliveryConfigFor(SIMPLE_MODE).fields.find((f) => f.key === 'district');
    expect(district).toMatchObject({ show: false, required: false });
  });

  it('stops naming a district source, so nothing fetches the list', () => {
    expect(deliveryConfigFor(SIMPLE_MODE).districts).toBeNull();
  });

  it('re-labels the address lines for how directions are actually given', () => {
    const fields = deliveryConfigFor(SIMPLE_MODE).fields;
    expect(fields.find((f) => f.key === 'line1')?.help).toContain('landmark');
    expect(fields.find((f) => f.key === 'line2')?.label).toBe('Extra directions');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE FIELD THAT MAY NEVER BE HIDDEN.
 *
 * `zoneFor` derives the shipping zone — and therefore the delivery price AND
 * the tax rate — from `countryCode` + `region`, in BOTH modes. A config that
 * hid this would put every order into the catch-all zone, quoting
 * rest-of-Nigeria delivery for a parcel going three streets away.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('region', () => {
  it('is shown and required in every mode', () => {
    for (const settings of [DISTRICT_MODE, SIMPLE_MODE]) {
      const region = deliveryConfigFor(settings).fields.find((f) => f.key === 'region');
      expect(region).toMatchObject({ show: true, required: true });
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE SHOP WILL SHIP, FROM THE ROW RATHER THAN FROM A CONSTANT.
 *
 * `country` was three hardcoded values until this. The storefront gates its
 * whole checkout on `allowed` — a non-matching address disables Continue — so
 * this is the switch that opens international selling, and it opens WITHOUT a
 * storefront deploy.
 *
 * `locked` AND `default` ARE DERIVED, NOT STORED. One country renders as text
 * and is its own default; several render a dropdown. Two more columns could
 * disagree with the list; a derivation cannot.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('country', () => {
  it('lists every country the shop serves, unlocked once there is a choice', () => {
    expect(deliveryConfigFor({ ...DISTRICT_MODE, servedCountries: ['NG', 'GB', 'US'] }).country)
      .toEqual({ default: 'NG', allowed: ['NG', 'GB', 'US'], locked: false });
  });

  /* The owner's ordering IS the default — first in the list is what the form
   * pre-selects, so re-ordering the field re-points the default with it. */
  it('takes the default from the head of the list, not from a pinned NG', () => {
    const config = deliveryConfigFor({ ...DISTRICT_MODE, servedCountries: ['GB', 'NG'] });
    expect(config.country.default).toBe('GB');
    expect(config.country.locked).toBe(false);
  });

  it('locks the field again when the shop serves exactly one country', () => {
    expect(deliveryConfigFor({ ...DISTRICT_MODE, servedCountries: ['GB'] }).country).toEqual({
      default: 'GB',
      allowed: ['GB'],
      locked: true,
    });
  });
});

describe('location', () => {
  it('is not offered until the owner turns it on', () => {
    expect(deliveryConfigFor(SIMPLE_MODE).location.offer).toBe(false);
  });

  it('is offered when they do, and is never required', () => {
    const on = deliveryConfigFor({ ...SIMPLE_MODE, locationOffered: true }).location;
    expect(on.offer).toBe(true);
    expect(on.required).toBe(false);
  });

  /*
   * ON THE WIRE SO IT CANNOT QUIETLY BECOME TRUE. There is no geographic data
   * anywhere in this system to price a coordinate against — see migration
   * 0780. The field exists to stop the next person wiring a pin into a rate by
   * assuming it was meant to be one.
   */
  it('says it prices nothing, in both modes and either switch position', () => {
    for (const offered of [true, false]) {
      for (const settings of [DISTRICT_MODE, SIMPLE_MODE]) {
        expect(deliveryConfigFor({ ...settings, locationOffered: offered }).location.pricing).toBe(
          false,
        );
      }
    }
  });
});

describe('the rest of the payload', () => {
  it('carries the revision, so a storefront can tell a new config from a re-fetch', () => {
    expect(deliveryConfigFor(DISTRICT_MODE).revision).toBe(1);
    expect(deliveryConfigFor(SIMPLE_MODE).revision).toBe(2);
  });

  it('pins the country — every zone this shop has is Nigerian', () => {
    expect(deliveryConfigFor(DISTRICT_MODE).country).toEqual({
      default: 'NG',
      allowed: ['NG'],
      locked: true,
    });
  });

  it('passes the served regions through untouched', () => {
    const config = deliveryConfigFor({ ...SIMPLE_MODE, servedRegions: ['Abuja', 'Lagos'] });
    expect(config.servedRegions).toEqual(['Abuja', 'Lagos']);
    expect(deliveryConfigFor(SIMPLE_MODE).servedRegions).toBeNull();
  });

  /*
   * The limits are not merely equal to the wire schema's — they ARE the wire
   * schema's. `server/shop/cart/routes/checkout.ts` builds its `Address` zod
   * from this same constant, so drift is unrepresentable rather than tested.
   * What is left to check is that every field actually publishes one, since a
   * missing `maxLength` renders as an unbounded input.
   */
  it('publishes a length for every field it describes', () => {
    for (const settings of [DISTRICT_MODE, SIMPLE_MODE]) {
      for (const field of deliveryConfigFor(settings).fields) {
        expect(field.maxLength).toBe(ADDRESS_MAX_LENGTHS[field.key]);
        expect(field.maxLength).toBeGreaterThan(0);
      }
    }
  });

  it('gives every shown field an autocomplete hint — typing an address on a phone is the worst part of any checkout', () => {
    for (const field of deliveryConfigFor(SIMPLE_MODE).fields.filter((f) => f.show)) {
      expect(field.autocomplete).toBeTruthy();
    }
  });
});
