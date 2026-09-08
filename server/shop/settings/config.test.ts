import { describe, expect, it } from 'vitest';
import { ADDRESS_MAX_LENGTHS, deliveryConfigFor } from './config';
import type { AddressFieldKey } from './config';
import type { DeliverySettings } from './repo';
import type { ProviderSetting } from '../logistics/repo';

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

const shown = (settings: DeliverySettings, courier?: ProviderSetting): AddressFieldKey[] =>
  deliveryConfigFor(settings, courier)
    .fields.filter((f) => f.show)
    .map((f) => f.key);

const required = (settings: DeliverySettings, courier?: ProviderSetting): AddressFieldKey[] =>
  deliveryConfigFor(settings, courier)
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

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * `line2` IS THE LANDMARK FIELD, IN BOTH MODES.
   *
   * It always was — simple mode calls it "Extra directions" and asks for the
   * gate colour, and that text already reaches BOTH couriers (Terminal's
   * `line2`, and Fez's free-text `recipientAddress` through `oneLine()`).
   * District mode labelled it "Apartment, floor" with no help at all, which
   * asked for a taxonomy and got a rider nothing. Same field, same words, so
   * a rider gets the same detail whichever form the shop is running.
   *
   * This is why the courier-places work adds NO landmark column: there is
   * already one, and it is already wired end to end.
   * ═══════════════════════════════════════════════════════════════════════
   */
  it('asks for directions in line2, in the same words simple mode uses', () => {
    const line2 = deliveryConfigFor(DISTRICT_MODE).fields.find((f) => f.key === 'line2');
    expect(line2?.label).toBe('Extra directions');
    expect(line2?.help).toBe('Gate colour, floor, who to ask for.');
    expect(line2).toEqual(deliveryConfigFor(SIMPLE_MODE).fields.find((f) => f.key === 'line2'));
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
 * THE ROUTING CITY — A DELIVERY ZONE, NOT WHERE ANYBODY LIVES.
 *
 * It exists because Terminal validates `city` against its own per-country list
 * and refuses anything else with a 400 that kills the whole quote: ten place
 * names inside the FCT, measured 2026-09-07, and "Gwarinpa" is not one of them.
 * So the shopper PICKS a zone from the courier's own list, and the words they
 * typed stay in `city` and on the lines a rider reads.
 *
 * IT IS NULL, AND THE FIELD HIDDEN, FOR A COURIER WITH NO CITY LIST. Fez
 * validates no city at all and `manual` is not a courier — asking either shop's
 * customers to pick from a list nothing will ever check is a question with no
 * answer. That is why the courier is an ARGUMENT here: this stays a pure
 * function of what it is handed, and the routes do the reading.
 * ═══════════════════════════════════════════════════════════════════════════
 */
describe('routingCity', () => {
  it('is null — and the field hidden — for a shop that ships by hand', () => {
    for (const settings of [DISTRICT_MODE, SIMPLE_MODE]) {
      expect(deliveryConfigFor(settings, 'manual').routingCity).toBeNull();
      expect(shown(settings, 'manual')).not.toContain('routingCity');
    }
  });

  /* Fez HAS a place list — its 37 states — and enforces no city inside them.
     "No list to enforce" and "no lists at all" are different facts, and only
     the first one is what hides this field. */
  it('is null for Fez, which validates no city at all', () => {
    expect(deliveryConfigFor(SIMPLE_MODE, 'fez').routingCity).toBeNull();
    expect(shown(SIMPLE_MODE, 'fez')).not.toContain('routingCity');
  });

  it('points Terminal’s shops at the cached place list', () => {
    expect(deliveryConfigFor(SIMPLE_MODE, 'terminal').routingCity).toMatchObject({
      source: '/api/public/shop/delivery-places',
    });
    const pointer = deliveryConfigFor(SIMPLE_MODE, 'terminal').routingCity!;
    // Every string is copy the storefront renders; none may be blank.
    expect(pointer.label).toBeTruthy();
    expect(pointer.help).toBeTruthy();
    /* THE UNLISTED CASE IS THE WHOLE POINT. A shopper whose town is not on the
       courier's list must be told to pick the nearest one and reassured that
       the rider still follows the address they typed — otherwise the honest
       reading of the form is "we do not deliver to you". */
    expect(pointer.unlistedHelp).toBeTruthy();
  });

  /* AFTER `city`, DELIBERATELY. The shopper answers where they actually are
     first; the zone is the follow-up question that only makes sense once they
     have. Same position in both modes, so the two forms read alike. */
  it('is asked after the real city, in both modes', () => {
    expect(shown(DISTRICT_MODE, 'terminal')).toEqual([
      'name', 'phone', 'region', 'district', 'city', 'routingCity', 'line1', 'line2',
    ]);
    expect(shown(SIMPLE_MODE, 'terminal')).toEqual([
      'name', 'phone', 'region', 'city', 'routingCity', 'line1', 'line2',
    ]);
  });

  /* REQUIRED IN THE FORM, NEVER ON THE WIRE — the same split `district` has
     had since 0460. The server may not require it: this config is cached 60s
     with 300s stale-while-revalidate, so for up to six minutes a storefront can
     be rendering a form that has never heard of the field, and a required
     server-side check would 400 every one of those submissions. The FORM can
     insist, because the form is the copy that just told the shopper why. */
  it('is required in the form wherever it is shown', () => {
    expect(required(SIMPLE_MODE, 'terminal')).toContain('routingCity');
  });

  /* The default keeps every caller that has not been taught about couriers —
     and every test written before this — reading the form they read before. */
  it('defaults to the no-list answer when no courier is named', () => {
    expect(deliveryConfigFor(SIMPLE_MODE).routingCity).toBeNull();
    expect(shown(SIMPLE_MODE)).toEqual(shown(SIMPLE_MODE, 'manual'));
  });

  /* Hidden, but still LISTED, for the same reason `district` is in simple mode:
     a storefront keying off the array rather than off the courier has nothing
     to special-case, and the absence is explicit rather than inferred. */
  it('is still listed when hidden, so the absence is explicit', () => {
    const field = deliveryConfigFor(SIMPLE_MODE, 'fez').fields.find((f) => f.key === 'routingCity');
    expect(field).toMatchObject({ show: false, required: false });
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
      // Every courier, so a field that only one of them shows is covered too.
      for (const courier of ['manual', 'fez', 'terminal'] as const) {
        for (const field of deliveryConfigFor(settings, courier).fields) {
          expect(field.maxLength, field.key).toBe(ADDRESS_MAX_LENGTHS[field.key]);
          expect(field.maxLength, field.key).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every shown field an autocomplete hint — typing an address on a phone is the worst part of any checkout', () => {
    for (const courier of ['manual', 'fez', 'terminal'] as const) {
      for (const field of deliveryConfigFor(SIMPLE_MODE, courier).fields.filter((f) => f.show)) {
        expect(field.autocomplete, field.key).toBeTruthy();
      }
    }
  });
});
