import { describe, expect, it } from 'vitest';

import type { ShopOrder, ShopOrderRow, ShopShippingZone } from '../../data/api-shop';
/*
 * THE REAL SERVER RULE, IMPORTED, NOT PARAPHRASED.
 *
 * `serverZoneFor` is a second copy of `zoneFor`, and this repository has been
 * bitten before by two copies of one rule drifting apart (a sort key that
 * disagreed became a page boundary that skipped rows). The production module
 * cannot import `server/` — a browser bundle must not pull in the shipping
 * engine — but this SUITE can, because it runs under Vitest's `client` project
 * in a node environment. So the transcription is not asserted against
 * hand-written expectations that share the transcription's assumptions
 * (CLAUDE.md §2); it is asserted against the function it transcribes, over a
 * generated cross-product, and the seeded rates are asserted against the
 * server's own `DEFAULT_SHIPPING_ZONES` rather than against literals retyped
 * here.
 */
import type { ShippingZone } from '../../../server/shop/cart/checkout/shipping';
import {
  DEFAULT_SHIPPING_ZONES,
  zoneFor,
} from '../../../server/shop/cart/checkout/shipping';
import {
  ALIAS_COLLISIONS,
  AWAITING_ACTION_STATUSES,
  NG_REGIONS,
  NO_REGION_LABEL,
  SEEDED_DELIVERY_ZONES,
  SHARE_DECIMALS,
  UNKNOWN_CURRENCY,
  breakdown,
  deliveryZoneFrom,
  deliveryZoneOf,
  deliveryZoneTableFrom,
  normaliseRegion,
  regionByCode,
  serverZoneFor,
  zoneRegionCodes,
  type BreakdownGroup,
  type BreakdownZoneKnown,
  type DeliveryZoneTable,
  type GeographyBreakdown,
  type GroupZoneKnown,
} from './geography';
import LIVE from '../__fixtures__/orders-live.json';

/**
 * THE DESTINATION PANEL'S ARITHMETIC, DRIVEN AGAINST THE BYTES PRODUCTION SENT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `../__fixtures__/orders-live.json` IS A VERBATIM CAPTURE, AND THAT IS THE
 * POINT OF THIS FILE.
 *
 * CLAUDE.md §2: "A green suite has repeatedly meant nothing… Every serious bug
 * this year was found by driving the real thing." The specific way that has
 * bitten this repository is a fixture written from the same assumption as the
 * code — `Shop.test.tsx` proved an order screen worked against a payload shape
 * the server has never sent, eleven tests green while every operator saw an
 * error boundary.
 *
 * So the headline case here is not invented. Production's five orders carry
 * BOTH `"region": "Abuja"` and `"region": "Federal Capital Territory"`, for one
 * city, in the field the shop prices on. A naive group-by shows two
 * destinations. `THE LIVE ABUJA / FEDERAL CAPITAL TERRITORY COLLAPSE` below
 * asserts the whole of that behaviour off the capture, including the foil — it
 * proves the naive answer is 2 before proving this module's is 1.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const rows = LIVE.items as unknown as ShopOrderRow[];

/** Fixed, arbitrary, and later than every `placedAt` in the capture. */
const NOW = 1_787_200_000_000;

/**
 * The capture's own numbers, written out rather than recomputed from it.
 *
 * A test that sums the fixture and compares against the same sum asserts only
 * that addition is deterministic. These constants were read off the JSON by
 * hand, so a fixture re-capture that changes the data fails here loudly instead
 * of quietly agreeing with itself.
 */
const LIVE_ORDERS = 5;
const LIVE_GRAND_TOTAL = 12_900_000; // 2_500_000 + 4 × 2_600_000
const LIVE_SHIPPING_TOTAL = 1_500_000; // 5 × ₦3,000
const LIVE_OLDEST_PLACED_AT = 1_787_141_339_481; // order 2026-000001-H

/**
 * THE SEED, USED AS A STAND-IN FOR THE LIVE TABLE, AND ONLY WHERE THAT IS TRUE.
 *
 * `breakdown` has no default table any more, so every test that wants a rate
 * says which table it wants one from. The capture predates any rate edit — its
 * five orders were each charged the seeded ₦3,000, which the test below proves
 * off the frozen `shippingTotal` rather than off this constant — so the seed is
 * genuinely what those orders were priced against.
 */
const SEEDED = SEEDED_DELIVERY_ZONES;

/** A minimal, valid `ShopOrderRow`, for cases the live capture does not cover. */
function row(order: Partial<ShopOrder>): ShopOrderRow {
  return {
    order: {
      id: 'ord_test',
      orderNumber: '2026-000099-Z',
      customerId: null,
      email: 'someone@example.com',
      currency: 'NGN',
      subtotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      refundedTotal: 0,
      status: 'paid',
      shippingAddress: {},
      billingAddress: {},
      placedAt: NOW - 1000,
      paidAt: NOW - 900,
      fulfilledAt: null,
      cancelledAt: null,
      revision: 2,
      checkoutId: 'crt_test',
      paymentIntentId: null,
      ...order,
    },
    lines: [],
  };
}

const at = (region: unknown, rest: Record<string, unknown> = {}) => ({ region, ...rest });

/**
 * Narrow a group's delivery reading to the arm that has an answer.
 *
 * The `known` discriminant is the whole point of the shape — a UI cannot reach
 * `.zone` without deciding what to render when there is no zone table — so the
 * suite goes through the same door rather than casting past it.
 */
function zoneOf(group: BreakdownGroup): GroupZoneKnown {
  const reading = group.delivery;
  if (!reading.known) throw new Error(`group "${group.label}" carries no zone reading`);
  return reading;
}

function zonesOf(out: GeographyBreakdown): BreakdownZoneKnown {
  if (!out.delivery.known) throw new Error('breakdown carries no zone reading');
  return out.delivery;
}

// ════════════════════════════════════════════ the case this module exists for

describe('THE LIVE ABUJA / FEDERAL CAPITAL TERRITORY COLLAPSE', () => {
  it('the capture really does spell one city two ways (the premise)', () => {
    const spellings = rows.map((r) => r.order.shippingAddress.region);
    expect(spellings).toContain('Abuja');
    expect(spellings).toContain('Federal Capital Territory');
    expect(rows).toHaveLength(LIVE_ORDERS);
  });

  it('a naive group-by on the raw field shows TWO destinations', () => {
    // The foil. If this ever drops to 1 the fixture was re-captured against a
    // fixed checkout form, and the rest of this describe block is moot — better
    // to be told than to keep passing a test that no longer proves anything.
    const naive = new Set(rows.map((r) => r.order.shippingAddress.region));
    expect(naive.size).toBe(2);
  });

  it('this module shows ONE, keyed on the ISO code', () => {
    const out = breakdown(rows, { now: NOW });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].code).toBe('NG-FC');
    expect(out.groups[0].label).toBe('Federal Capital Territory');
    expect(out.groups[0].orders).toBe(LIVE_ORDERS);
    expect(out.totalOrders).toBe(LIVE_ORDERS);
  });

  it('and REPORTS the collapse rather than performing it silently', () => {
    const out = breakdown(rows, { now: NOW });
    expect(out.groups[0].collapsed).toEqual([
      { raw: 'Abuja', orders: 4 },
      { raw: 'Federal Capital Territory', orders: 1 },
    ]);
    expect(out.collapses).toEqual([
      {
        code: 'NG-FC',
        label: 'Federal Capital Territory',
        variants: [
          { raw: 'Abuja', orders: 4 },
          { raw: 'Federal Capital Territory', orders: 1 },
        ],
      },
    ]);
  });

  it('both spellings are CONFIDENT — neither is a guess', () => {
    for (const r of rows) {
      const region = normaliseRegion(r.order.shippingAddress);
      expect(region.code).toBe('NG-FC');
      expect(region.confident).toBe(true);
      expect(region.matchedOn).toBe('region-name');
      expect(region.reason).toBeNull();
    }
    expect(breakdown(rows, { now: NOW }).inferredOrders).toBe(0);
  });

  it('the collapse agrees with the server: no disagreement on live data', () => {
    // Both live spellings are in `zone_abuja.regions` (migration 0240), so the
    // panel and the checkout price these five identically. A non-zero number
    // here would mean the screen was about to contradict a customer's receipt.
    const out = breakdown(rows, { now: NOW, zones: SEEDED });
    expect(zonesOf(out).disagreements).toBe(0);
    expect(zoneOf(out.groups[0]).serverZone?.id).toBe('zone_abuja');
    expect(zoneOf(out.groups[0]).zone?.id).toBe('zone_abuja');
    expect(zoneOf(out.groups[0]).viaFallback).toBe(false);
  });

  it('quotes the rate PRODUCTION CHARGED, proven off the frozen shippingTotal', () => {
    /*
     * NOT `expect(rate).toBe(300_000)`.
     *
     * A literal here is the same assumption as the code, written twice —
     * exactly the pattern CLAUDE.md §2 says has never caught anything. The
     * capture is evidence from outside this repository: five real orders, each
     * bound for Abuja, each with a FROZEN `shippingTotal` of what the customer
     * was actually billed. If the seeded Abuja rate this module carries ever
     * stops equalling that, the panel is about to print a number nobody paid.
     */
    const abuja = SEEDED.find((zone) => zone.id === 'zone_abuja');
    expect(abuja?.amountMinor).not.toBeNull();
    for (const r of rows) {
      expect(normaliseRegion(r.order.shippingAddress).code).toBe('NG-FC');
      expect(r.order.shippingTotal).toBe(abuja?.amountMinor);
    }
  });

  it('carries the live money, per currency, and the frozen delivery charged', () => {
    const out = breakdown(rows, { now: NOW });
    expect(out.groups[0].value).toEqual([
      {
        currency: 'NGN',
        orders: LIVE_ORDERS,
        grandTotal: LIVE_GRAND_TOTAL,
        refundedTotal: 0,
        netTotal: LIVE_GRAND_TOTAL,
        shippingTotal: LIVE_SHIPPING_TOTAL,
        sharePct: 100,
      },
    ]);
    expect(out.totals).toHaveLength(1);
    expect(out.totals[0].currency).toBe('NGN');
    expect(out.totals[0].grandTotal).toBe(LIVE_GRAND_TOTAL);
    expect(out.unusableMoneyFields).toBe(0);
  });

  it('every live order is still awaiting action, oldest first', () => {
    const out = breakdown(rows, { now: NOW });
    expect(out.groups[0].awaitingAction).toBe(LIVE_ORDERS);
    expect(out.groups[0].oldestAwaitingPlacedAt).toBe(LIVE_OLDEST_PLACED_AT);
    expect(out.groups[0].oldestAwaitingAgeMs).toBe(NOW - LIVE_OLDEST_PLACED_AT);
  });

  it('nothing is unclassified, and the one group takes 100% of the orders', () => {
    const out = breakdown(rows, { now: NOW });
    expect(out.unrecognised).toEqual({ orders: 0, reasons: [] });
    expect(out.nonNigerianOrders).toBe(0);
    expect(out.groups[0].sharePct).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════ the alias table

describe('the canonical table', () => {
  it('is 36 states plus the FCT, with unique ISO codes', () => {
    expect(NG_REGIONS).toHaveLength(37);
    expect(new Set(NG_REGIONS.map((r) => r.code)).size).toBe(37);
    expect(NG_REGIONS.some((r) => r.code === 'NG-FC')).toBe(true);
  });

  it('has no alias claimed by two regions', () => {
    // Hand-written lists invite exactly this: one state silently shadowing
    // another depending on table order. The index records collisions instead of
    // trusting review, so a future entry fails here rather than re-routing a parcel.
    expect(ALIAS_COLLISIONS).toEqual([]);
  });

  it('resolves a code back to its row, and refuses a null', () => {
    expect(regionByCode('NG-LA')?.name).toBe('Lagos');
    expect(regionByCode(null)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════ normalisation

describe('normaliseRegion — the spellings it accepts', () => {
  const confident: [string, string][] = [
    ['Abuja', 'NG-FC'],
    ['Federal Capital Territory', 'NG-FC'],
    ['FCT', 'NG-FC'],
    ['F.C.T.', 'NG-FC'],
    ['  fct  ', 'NG-FC'],
    ['Abuja FCT', 'NG-FC'],
    ['FCT, Abuja', 'NG-FC'],
    ['Lagos', 'NG-LA'],
    ['Lagos State', 'NG-LA'],
    ['LAGOS  STATE', 'NG-LA'],
    ['Cross River', 'NG-CR'],
    ['Cross-River', 'NG-CR'],
    ['crossriver', 'NG-CR'],
    ['Akwa-Ibom', 'NG-AK'],
    ['Nassarawa', 'NG-NA'],
    ['Rivers', 'NG-RI'],
  ];
  for (const [raw, code] of confident) {
    it(`"${raw}" is ${code}, confidently`, () => {
      const region = normaliseRegion(at(raw, { countryCode: 'NG' }));
      expect(region.code).toBe(code);
      expect(region.confident).toBe(true);
      expect(region.matchedOn).toBe('region-name');
      expect(region.raw).toBe(raw.trim());
      expect(region.reason).toBeNull();
    });
  }

  it('folds diacritics to one word rather than splitting the name', () => {
    // NFKD separates the marks; `COMBINING_MARKS` DELETES them. If it spaced
    // them instead, `Ọ̀yọ́` would fold to `o yo` and match nothing.
    const region = normaliseRegion(at('Ọ̀yọ́', { countryCode: 'NG' }));
    expect(region.code).toBe('NG-OY');
    expect(region.label).toBe('Oyo');
    expect(region.raw).toBe('Ọ̀yọ́');
  });

  it('keeps the operator’s own text on `raw`, never overwritten by the label', () => {
    const region = normaliseRegion(at('  f.c.t.  ', { countryCode: 'NG' }));
    expect(region.label).toBe('Federal Capital Territory');
    expect(region.raw).toBe('f.c.t.');
  });
});

describe('normaliseRegion — the guesses, labelled as guesses', () => {
  it('a city typed into the region box resolves but is NOT confident', () => {
    const region = normaliseRegion(at('Port Harcourt', { countryCode: 'NG' }));
    expect(region.code).toBe('NG-RI');
    expect(region.confident).toBe(false);
    expect(region.matchedOn).toBe('region-city');
  });

  it('falls through to `city` when the region box is junk', () => {
    const region = normaliseRegion(at('n/a', { city: 'Ikeja', countryCode: 'NG' }));
    expect(region.code).toBe('NG-LA');
    expect(region.confident).toBe(false);
    expect(region.matchedOn).toBe('city-field');
    expect(region.raw).toBe('n/a');
    expect(region.rawCity).toBe('Ikeja');
  });

  it('falls through to `city` when the region box is missing entirely', () => {
    const region = normaliseRegion({ city: 'Ibadan', countryCode: 'NG' });
    expect(region.code).toBe('NG-OY');
    expect(region.matchedOn).toBe('city-field');
    expect(region.raw).toBeNull();
  });

  it('a resolvable `region` is NEVER overridden by a disagreeing `city`', () => {
    // `region` is the field the shop prices on. Ogun is what this customer was
    // charged, so Ogun is what the panel must say.
    const region = normaliseRegion(at('Ogun', { city: 'Ikeja', countryCode: 'NG' }));
    expect(region.code).toBe('NG-OG');
    expect(region.confident).toBe(true);
  });

  it('a city named after its state resolves through the state, not the city list', () => {
    const region = normaliseRegion({ city: 'Kano', countryCode: 'NG' });
    expect(region.code).toBe('NG-KN');
  });
});

describe('normaliseRegion — hostile and absent input', () => {
  const hostile: [string, unknown, string][] = [
    ['undefined', undefined, 'no-address'],
    ['null', null, 'no-address'],
    ['a string', 'Lagos', 'no-address'],
    ['a number', 42, 'no-address'],
    ['an array', ['Lagos'], 'no-address'],
    ['an empty object', {}, 'no-region'],
    ['region: null', { region: null }, 'no-region'],
    ['region: a number', { region: 25 }, 'region-not-a-string'],
    ['region: an object', { region: { name: 'Lagos' } }, 'region-not-a-string'],
    ['region: an array', { region: ['Lagos'] }, 'region-not-a-string'],
    ['region: empty string', { region: '' }, 'region-blank'],
    ['region: whitespace', { region: '   \t\n ' }, 'region-blank'],
    ['region: unknown place', { region: 'Atlantis' }, 'region-unknown'],
    ['region: punctuation only', { region: '---' }, 'region-unknown'],
  ];
  for (const [name, address, reason] of hostile) {
    it(`${name} → ${reason}, without throwing`, () => {
      const region = normaliseRegion(address);
      expect(region.code).toBeNull();
      expect(region.reason).toBe(reason);
      expect(region.confident).toBe(false);
      expect(region.matchedOn).toBe('none');
    });
  }

  it('labels an unrecognised region with the operator’s own text', () => {
    expect(normaliseRegion({ region: 'Atlantis' }).label).toBe('Atlantis');
    expect(normaliseRegion({ region: '  Atlantis  ' }).raw).toBe('Atlantis');
  });

  it('labels an absent region with a named constant, not an empty cell', () => {
    expect(normaliseRegion(undefined).label).toBe(NO_REGION_LABEL);
    expect(normaliseRegion({}).label).toBe(NO_REGION_LABEL);
  });

  it('does not read a region off the prototype chain', () => {
    // `"__proto__"` and `"constructor"` are legal JSON keys, and a bare property
    // read answers with something for both on every object in the language.
    const polluted = JSON.parse('{"__proto__":{"region":"Lagos"},"city":"Nowhere"}');
    expect(normaliseRegion(polluted).code).toBeNull();
    expect(normaliseRegion(polluted).reason).toBe('no-region');
    expect(normaliseRegion({ constructor: 'Lagos' }).reason).toBe('no-region');
    expect(({} as Record<string, unknown>).region).toBeUndefined();
  });

  it('reads a null-prototype object exactly like a plain one', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
      region: 'Lagos',
      countryCode: 'NG',
    });
    expect(normaliseRegion(bare).code).toBe('NG-LA');
  });
});

describe('normaliseRegion — the country guard', () => {
  it('refuses to force a non-NG address into a Nigerian state', () => {
    for (const country of ['US', 'GB', 'NE', 'gb']) {
      const region = normaliseRegion(at('Delta', { countryCode: country }));
      expect(region.code).toBeNull();
      expect(region.reason).toBe('non-nigerian');
      expect(region.countryCode).toBe(country.toUpperCase());
      // The operator's own text survives — the panel still shows the destination.
      expect(region.label).toBe('Delta');
    }
  });

  it('refuses even when the region text is unmistakably Nigerian', () => {
    expect(normaliseRegion(at('Federal Capital Territory', { countryCode: 'GB' })).code).toBeNull();
    expect(normaliseRegion(at('Lagos', { countryCode: 'CA', city: 'Toronto' })).code).toBeNull();
  });

  it('accepts a lowercase or padded country code, as the server does', () => {
    expect(normaliseRegion(at('Lagos', { countryCode: 'ng' })).code).toBe('NG-LA');
    expect(normaliseRegion(at('Lagos', { countryCode: '  NG ' })).code).toBe('NG-LA');
  });

  it('treats an absent or unusable country as home, and records that it was absent', () => {
    for (const countryCode of [undefined, null, '', '   ', 42]) {
      const region = normaliseRegion(at('Lagos', { countryCode }));
      expect(region.code).toBe('NG-LA');
      expect(region.countryCode).toBeNull();
    }
  });
});

// ═════════════════════════════════════ the live zone table, and mapping to it

/**
 * A zone the OPERATOR created, in the shape `shopApi.listShippingZones()`
 * really returns it — `zone_<base36><random>` for an id, `ship_…` for the
 * option, an `estimate` string, a `position`, `isFallback` rather than
 * `fallback`, and no `codes` column anywhere.
 *
 * This row is the whole argument. Under the old closed `DeliveryZoneId` union
 * it could not be expressed at all: `error TS2322: Type 'string' is not
 * assignable to type 'DeliveryZoneId'`, on the id alone. So the documented way
 * to give this module the live rates did not compile, every caller fell back to
 * the compile-time seed, and a Port Harcourt order priced ₦5,000 by the server
 * rendered as ₦10,000 on the panel with `agrees: true` beside it.
 */
const LIVE_PORT_HARCOURT: ShopShippingZone = {
  id: 'zone_mt9x4k2f4a7b0c3d5e6f',
  label: 'Port Harcourt',
  countries: ['NG'],
  regions: ['Rivers'],
  taxRateBps: 0,
  taxLabel: 'No tax charged',
  shippingTaxable: false,
  isFallback: false,
  position: 3,
  options: [
    {
      id: 'ship_mt9x4k2h8b1c2d3e4f5a',
      zoneId: 'zone_mt9x4k2f4a7b0c3d5e6f',
      label: 'Standard delivery',
      amountMinor: 500_000,
      estimate: '2–3 working days',
      position: 0,
    },
  ],
};

/** The seed, as the admin API returns it, for building "the operator edited X" tables. */
const LIVE_SEED: ShopShippingZone[] = [
  {
    id: 'zone_abuja',
    label: 'Abuja',
    countries: ['NG'],
    regions: ['Abuja', 'FCT', 'Federal Capital Territory'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 0,
    options: [
      {
        id: 'ship_abuja_standard',
        zoneId: 'zone_abuja',
        label: 'Standard delivery',
        amountMinor: 300_000,
        estimate: '',
        position: 0,
      },
    ],
  },
  {
    id: 'zone_lagos',
    label: 'Lagos',
    countries: ['NG'],
    regions: ['Lagos'],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: false,
    position: 1,
    options: [
      {
        id: 'ship_lagos_standard',
        zoneId: 'zone_lagos',
        label: 'Standard delivery',
        amountMinor: 1_000_000,
        estimate: '',
        position: 0,
      },
    ],
  },
  {
    id: 'zone_rest_of_nigeria',
    label: 'Rest of Nigeria',
    countries: [],
    regions: [],
    taxRateBps: 0,
    taxLabel: 'No tax charged',
    shippingTaxable: false,
    isFallback: true,
    position: 2,
    options: [
      {
        id: 'ship_rest_of_nigeria_standard',
        zoneId: 'zone_rest_of_nigeria',
        label: 'Standard delivery',
        amountMinor: 1_000_000,
        estimate: '',
        position: 0,
      },
    ],
  },
];

describe('deliveryZoneTableFrom — the documented escape hatch, which now compiles', () => {
  it('maps a live operator-created row, id and all', () => {
    const zone = deliveryZoneFrom(LIVE_PORT_HARCOURT);
    expect(zone.id).toBe('zone_mt9x4k2f4a7b0c3d5e6f');
    expect(zone.label).toBe('Port Harcourt');
    expect(zone.countries).toEqual(['NG']);
    expect(zone.regions).toEqual(['Rivers']);
    expect(zone.amountMinor).toBe(500_000);
    expect(zone.fallback).toBe(false);
    expect(zone.options).toEqual([
      { id: 'ship_mt9x4k2h8b1c2d3e4f5a', label: 'Standard delivery', amountMinor: 500_000 },
    ]);
  });

  it('DERIVES the codes a zone claims from the regions the operator typed', () => {
    // There is no `codes` column and there never will be. Deriving it is what
    // makes a zone nobody hard-coded a first-class member of the table.
    expect(deliveryZoneFrom(LIVE_PORT_HARCOURT).codes).toEqual(['NG-RI']);
    expect(zoneRegionCodes(['Abuja', 'FCT', 'Federal Capital Territory'])).toEqual(['NG-FC']);
    expect(zoneRegionCodes(['Port Harcourt'])).toEqual(['NG-RI']);
    expect(zoneRegionCodes(['Lagos', 'Ikeja'])).toEqual(['NG-LA']);
    expect(zoneRegionCodes([])).toEqual([]);
    expect(zoneRegionCodes(['Atlantis'])).toEqual([]);
  });

  it('keeps a zone’s region strings VERBATIM, because the server compares bytes', () => {
    // `zoneFor` does `trim().toLowerCase()` on both sides, so a stored `" Lagos "`
    // DOES reach it — but tidying the table here would be this module deciding
    // that on the server's behalf. Faithful in, faithful out.
    const padded = deliveryZoneFrom({ ...LIVE_PORT_HARCOURT, regions: ['  Rivers  ', 'Bayelsa'] });
    expect(padded.regions).toEqual(['  Rivers  ', 'Bayelsa']);
    expect(padded.codes).toEqual(['NG-RI', 'NG-BY']);
  });

  it('quotes no single rate for a zone with two prices, or none, or a broken one', () => {
    const two = deliveryZoneFrom({
      ...LIVE_PORT_HARCOURT,
      options: [
        { ...LIVE_PORT_HARCOURT.options[0], id: 'a', amountMinor: 500_000 },
        { ...LIVE_PORT_HARCOURT.options[0], id: 'b', label: 'Express', amountMinor: 900_000 },
      ],
    });
    expect(two.amountMinor).toBeNull();
    expect(two.options).toHaveLength(2);

    expect(deliveryZoneFrom({ ...LIVE_PORT_HARCOURT, options: [] }).amountMinor).toBeNull();

    const broken = deliveryZoneFrom({
      ...LIVE_PORT_HARCOURT,
      options: [{ ...LIVE_PORT_HARCOURT.options[0], amountMinor: 2.7 }],
    });
    // A price this could not read is not a price of zero.
    expect(broken.amountMinor).toBeNull();
    expect(broken.options).toEqual([]);
  });

  it('never throws on a hostile row, whatever the network returned', () => {
    const garbage = [
      null,
      undefined,
      42,
      'zone',
      [],
      {},
      { id: 7, regions: 'Rivers', options: 'lots' },
      { id: 'z', options: [null, 3, { amountMinor: Number.NaN }] },
      JSON.parse('{"__proto__":{"id":"zone_evil"},"id":"zone_ok","options":[]}'),
    ] as unknown as ShopShippingZone[];

    expect(() => deliveryZoneTableFrom(garbage)).not.toThrow();
    for (const zone of deliveryZoneTableFrom(garbage)) {
      expect(typeof zone.id).toBe('string');
      expect(Array.isArray(zone.regions)).toBe(true);
      expect(zone.amountMinor === null || Number.isSafeInteger(zone.amountMinor)).toBe(true);
    }
  });
});

// ══════════════════ the transcription, differentially tested against its source

/** `DEFAULT_SHIPPING_ZONES`, in the shape the admin API hands the client. */
function asShopZone(zone: ShippingZone, position: number): ShopShippingZone {
  return {
    id: zone.id,
    label: zone.label,
    countries: [...zone.countries],
    regions: [...(zone.regions ?? [])],
    taxRateBps: zone.taxRateBps,
    taxLabel: zone.taxLabel,
    shippingTaxable: zone.shippingTaxable,
    isFallback: zone.fallback === true,
    position,
    options: zone.options.map((option, i) => ({
      id: option.id,
      zoneId: zone.id,
      label: option.label,
      amountMinor: option.amountMinor,
      estimate: '',
      position: i,
    })),
  };
}

const SERVER_TABLE: DeliveryZoneTable = deliveryZoneTableFrom(
  DEFAULT_SHIPPING_ZONES.map((zone, i) => asShopZone(zone, i)),
);

describe('serverZoneFor — differentially tested against the real `zoneFor`', () => {
  /*
   * EVERY SPELLING THIS MODULE KNOWS, TIMES EVERY COUNTRY SHAPE THAT REACHES
   * IT. Generated rather than listed, so adding a state or an alias to
   * `NG_REGIONS` widens the comparison automatically and a transcription that
   * drifts cannot hide behind a case nobody remembered to write down.
   */
  const REGION_CASES: (string | null)[] = [
    null,
    '',
    '   ',
    ...NG_REGIONS.flatMap((region) => [
      region.name,
      region.name.toUpperCase(),
      `  ${region.name}  `,
      ...region.aliases,
      ...region.cities.slice(0, 1),
    ]),
    'F.C.T.',
    'Abuja FCT',
    'FCT, Abuja',
    'Lagos State',
    'Ikeja',
    'Atlantis',
    '---',
    'Ọ̀yọ́',
  ];
  const COUNTRY_CASES = ['NG', 'ng', '  NG ', 'GB', 'US', 'NE', 'ZZ', ''];

  it(`agrees with \`zoneFor\` on all ${REGION_CASES.length * COUNTRY_CASES.length} pairs`, () => {
    expect(REGION_CASES.length * COUNTRY_CASES.length).toBeGreaterThan(140);
    const divergences: string[] = [];
    for (const country of COUNTRY_CASES) {
      for (const region of REGION_CASES) {
        const mine = serverZoneFor(country, region, SERVER_TABLE)?.id ?? null;
        const theirs = zoneFor(DEFAULT_SHIPPING_ZONES, country, region).id;
        if (mine !== theirs) {
          divergences.push(`${JSON.stringify(country)}/${JSON.stringify(region)}: ${mine} ≠ ${theirs}`);
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  it('the case set can TELL a right transcription from a plausible wrong one', () => {
    /*
     * THE FOIL, and the reason the pass above is worth anything. A differential
     * over a case set that no wrong implementation could fail proves only that
     * the code ran. So: run the SAME pairs through the most plausible wrong
     * transcription there is — one that matches on the CANONICAL region, which
     * is exactly what this module does for display and must never do for money
     * — and require that it diverges. If this ever stops finding differences,
     * the case set has gone blind and the test above is decoration.
     */
    const overClever = (country: string, region: string | null): string | null => {
      const code = region === null ? null : normaliseRegion({ region, countryCode: country }).code;
      const claimed =
        code === null
          ? undefined
          : SERVER_TABLE.find(
              (zone) =>
                zone.countries.includes(country.trim().toUpperCase()) && zone.codes.includes(code),
            );
      return claimed?.id ?? serverZoneFor(country, region, SERVER_TABLE)?.id ?? null;
    };

    const divergences: string[] = [];
    for (const country of COUNTRY_CASES) {
      for (const region of REGION_CASES) {
        if (overClever(country, region) !== zoneFor(DEFAULT_SHIPPING_ZONES, country, region).id) {
          divergences.push(`${JSON.stringify(country)}/${JSON.stringify(region)}`);
        }
      }
    }
    // `F.C.T.`, `Ikeja`, `Lagos State`, `Ọ̀yọ́`, every uppercased state name…
    expect(divergences.length).toBeGreaterThan(10);
  });

  it('the seeded rates this module carries are the server’s own, not retyped ones', () => {
    /*
     * `DEFAULT_SHIPPING_ZONES` is the server's empty-database fallback and
     * migration 0240 seeds the same values into the table. Comparing against it
     * — rather than against `300_000` written out here — is what makes an
     * edit to one side fail instead of quietly disagreeing. Ids differ by
     * design: the constant says `abuja`, the seeded ROW says `zone_abuja`.
     */
    const shape = (zone: {
      label: string;
      countries: readonly string[];
      regions: readonly string[];
      amountMinor: number | null;
      fallback: boolean;
    }) => ({
      label: zone.label,
      countries: [...zone.countries],
      regions: [...zone.regions],
      amountMinor: zone.amountMinor,
      fallback: zone.fallback,
    });
    expect(SEEDED_DELIVERY_ZONES.map(shape)).toEqual(SERVER_TABLE.map(shape));
  });

  it('matches exactly the three spellings migration 0240 seeds', () => {
    for (const raw of ['Abuja', 'FCT', 'Federal Capital Territory']) {
      expect(serverZoneFor('NG', raw, SEEDED)?.id).toBe('zone_abuja');
    }
    expect(serverZoneFor('NG', 'Lagos', SEEDED)?.id).toBe('zone_lagos');
  });

  it('is case- and whitespace-insensitive, and nothing more', () => {
    expect(serverZoneFor('NG', '  fEDERAL cAPITAL tERRITORY  ', SEEDED)?.id).toBe('zone_abuja');
    // The whole reason this module exists: the server does NOT know these.
    expect(serverZoneFor('NG', 'F.C.T.', SEEDED)?.id).toBe('zone_rest_of_nigeria');
    expect(serverZoneFor('NG', 'Abuja FCT', SEEDED)?.id).toBe('zone_rest_of_nigeria');
    expect(serverZoneFor('NG', 'Ikeja', SEEDED)?.id).toBe('zone_rest_of_nigeria');
    expect(serverZoneFor('NG', 'Lagos State', SEEDED)?.id).toBe('zone_rest_of_nigeria');
  });

  it('sends an unmatched region, and an unmatched country, to the fallback', () => {
    expect(serverZoneFor('NG', 'Oyo', SEEDED)?.id).toBe('zone_rest_of_nigeria');
    expect(serverZoneFor('NG', null, SEEDED)?.id).toBe('zone_rest_of_nigeria');
    // ⚠️  A London address is quoted "Rest of Nigeria" at ₦10,000 today. That is
    //     the live table's behaviour, not this module's opinion of it.
    expect(serverZoneFor('GB', 'Greater London', SEEDED)?.id).toBe('zone_rest_of_nigeria');
  });

  it('returns null rather than throwing when a table has no fallback', () => {
    // The server THROWS here (`ShippingConfigError`), and that difference is
    // deliberate: a misconfigured zone list must refuse a sale, not take a
    // read-only panel down with it.
    const broken = SEEDED.filter((zone) => !zone.fallback);
    expect(serverZoneFor('NG', 'Nowhere', broken)).toBeNull();
    expect(() => zoneFor(DEFAULT_SHIPPING_ZONES.filter((z) => !z.fallback), 'NG', 'Nowhere')).toThrow();
  });
});

describe('deliveryZoneOf', () => {
  const ng = (region: unknown) => normaliseRegion(at(region, { countryCode: 'NG' }));

  it('REFUSES to name a zone when it was handed no table', () => {
    // The blocking defect, as a test. Without a table there is no rate, no
    // server zone, and above all no `agrees: true` — an assertion the module
    // used to make from a compile-time copy of a seed the operator can edit.
    for (const zones of [null, undefined]) {
      const reading = deliveryZoneOf(ng('Abuja'), zones);
      expect(reading.known).toBe(false);
      expect(reading).toEqual({ known: false });
    }
  });

  it('puts the FCT in Abuja and agrees with the server on a seeded spelling', () => {
    const reading = deliveryZoneOf(ng('Abuja'), SEEDED);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone?.id).toBe('zone_abuja');
    expect(reading.zone?.amountMinor).toBe(300_000);
    expect(reading.viaFallback).toBe(false);
    expect(reading.serverZone?.id).toBe('zone_abuja');
    expect(reading.agrees).toBe(true);
  });

  it('DISAGREES with the server on a spelling only this module knows', () => {
    // This is the honest half. Display says Abuja; the customer was charged the
    // fallback's ₦10,000. Both readings are returned so a panel cannot confuse them.
    const reading = deliveryZoneOf(ng('F.C.T.'), SEEDED);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone?.id).toBe('zone_abuja');
    expect(reading.serverZone?.id).toBe('zone_rest_of_nigeria');
    expect(reading.agrees).toBe(false);
  });

  it('puts Lagos in Lagos', () => {
    const reading = deliveryZoneOf(ng('Lagos'), SEEDED);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone?.id).toBe('zone_lagos');
    expect(reading.agrees).toBe(true);
  });

  it('`viaFallback` names the ZONE that caught the address, not a failure to read it', () => {
    /*
     * 35 of 37 regions reach the fallback under the seeded table, every one of
     * them confidently recognised. A panel that renders this flag as a "guess"
     * badge would mark almost the whole country as guessed — the flag the badge
     * wants is `confident` / `matchedOn`, on the region, not this one.
     */
    for (const raw of ['Oyo', 'Kano', 'Rivers', 'Cross River']) {
      const region = ng(raw);
      const reading = deliveryZoneOf(region, SEEDED);
      if (!reading.known) throw new Error('expected a reading');
      expect(region.confident).toBe(true);
      expect(region.matchedOn).toBe('region-name');
      expect(reading.zone?.id).toBe('zone_rest_of_nigeria');
      expect(reading.viaFallback).toBe(true);
      expect(reading.agrees).toBe(true);
    }
    const claimed = deliveryZoneOf(ng('Lagos'), SEEDED);
    if (!claimed.known) throw new Error('expected a reading');
    expect(claimed.viaFallback).toBe(false);
  });

  it('an unrecognised Nigerian region still prices from the fallback', () => {
    const reading = deliveryZoneOf(ng('Atlantis'), SEEDED);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone?.id).toBe('zone_rest_of_nigeria');
    expect(reading.viaFallback).toBe(true);
    expect(reading.agrees).toBe(true);
  });

  it('a non-NG address gets NO zone here, and the server’s answer beside it', () => {
    const reading = deliveryZoneOf(
      normaliseRegion(at('Greater London', { countryCode: 'GB' })),
      SEEDED,
    );
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone).toBeNull();
    expect(reading.viaFallback).toBe(false);
    expect(reading.serverZone?.id).toBe('zone_rest_of_nigeria');
    expect(reading.agrees).toBe(false);
  });

  it('claims nothing at all from a table with no zones and no fallback', () => {
    const reading = deliveryZoneOf(ng('Lagos'), []);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone).toBeNull();
    expect(reading.viaFallback).toBe(false);
    expect(reading.serverZone).toBeNull();
    expect(reading.agrees).toBe(false);
  });

  it('reports the table it was given, not the rate it remembers', () => {
    // The owner edits Abuja to ₦4,500 in the admin. Nothing here is redeployed.
    const edited = deliveryZoneTableFrom(
      LIVE_SEED.map((zone) =>
        zone.id === 'zone_abuja'
          ? { ...zone, options: [{ ...zone.options[0], amountMinor: 450_000 }] }
          : zone,
      ),
    );
    const reading = deliveryZoneOf(ng('Abuja'), edited);
    if (!reading.known) throw new Error('expected a reading');
    expect(reading.zone?.amountMinor).toBe(450_000);
    const seeded = deliveryZoneOf(ng('Abuja'), SEEDED);
    if (!seeded.known) throw new Error('expected a reading');
    expect(seeded.zone?.amountMinor).toBe(300_000);
  });
});

// ═══════════════════════════════ the two scenarios the rewrite exists to stop

describe('the operator edits the zone table, and the panel follows', () => {
  const phOrder = row({
    shippingAddress: at('Rivers', { countryCode: 'NG' }),
    shippingTotal: 500_000,
  });

  it('a new Port Harcourt zone at ₦5,000 is what the panel quotes', () => {
    /*
     * THE BLOCKING DEFECT, END TO END. The operator adds this zone; the server
     * starts charging ₦5,000; before the rewrite the panel printed ₦10,000
     * beside that order and reported `agrees: true` and zero disagreements,
     * because it was reading a constant compiled into the bundle.
     */
    const live = deliveryZoneTableFrom([...LIVE_SEED, LIVE_PORT_HARCOURT]);
    const out = breakdown([phOrder], { now: NOW, zones: live });
    const reading = zoneOf(out.groups[0]);
    expect(out.groups[0].code).toBe('NG-RI');
    expect(reading.zone?.label).toBe('Port Harcourt');
    expect(reading.zone?.amountMinor).toBe(500_000);
    expect(reading.viaFallback).toBe(false);
    expect(reading.serverZone?.id).toBe(LIVE_PORT_HARCOURT.id);
    expect(reading.disagreements).toBe(0);
    expect(zonesOf(out).disagreements).toBe(0);
    // And the rate the panel prints is the one the order actually carries.
    expect(out.groups[0].value[0].shippingTotal).toBe(reading.zone?.amountMinor);
  });

  it('the seed would have quoted ₦10,000 for the same order (the foil)', () => {
    const out = breakdown([phOrder], { now: NOW, zones: SEEDED });
    const reading = zoneOf(out.groups[0]);
    expect(reading.zone?.id).toBe('zone_rest_of_nigeria');
    expect(reading.zone?.amountMinor).toBe(1_000_000);
    expect(out.groups[0].value[0].shippingTotal).toBe(500_000);
  });

  it('adding `F.C.T.` to the Abuja zone RETIRES the disagreement it reported', () => {
    /*
     * The module's own printed advice is "add the alias in the shipping-zones
     * screen". Following it used to change nothing, for ever, because the
     * comparison ran against a constant. It has to be readable off the table.
     */
    const fct = [row({ shippingAddress: at('F.C.T.', { countryCode: 'NG' }) })];
    const before = breakdown(fct, { now: NOW, zones: SEEDED });
    expect(zonesOf(before).disagreements).toBe(1);

    const fixed = deliveryZoneTableFrom(
      LIVE_SEED.map((zone) =>
        zone.id === 'zone_abuja' ? { ...zone, regions: [...zone.regions, 'F.C.T.'] } : zone,
      ),
    );
    const after = breakdown(fct, { now: NOW, zones: fixed });
    expect(zonesOf(after).disagreements).toBe(0);
    expect(zoneOf(after.groups[0]).serverZone?.id).toBe('zone_abuja');
  });
});

describe('breakdown — with no zone table, it says nothing about zones', () => {
  const some = [
    row({ shippingAddress: at('Abuja', { countryCode: 'NG' }) }),
    row({ shippingAddress: at('F.C.T.', { countryCode: 'NG' }) }),
    row({ shippingAddress: at('Greater London', { countryCode: 'GB' }) }),
  ];

  it('reports `{ known: false }`, not a rate and not an agreement', () => {
    const out = breakdown(some, { now: NOW });
    expect(out.delivery).toEqual({ known: false });
    for (const group of out.groups) expect(group.delivery).toEqual({ known: false });
    // Nowhere in the output is there a zone id, a rate, or the number 0 claiming
    // the panel and the checkout agree.
    expect(JSON.stringify(out)).not.toContain('zone_');
    expect(JSON.stringify(out)).not.toContain('disagreements');
  });

  it('`null` and omitted mean the same thing', () => {
    expect(breakdown(some, { now: NOW, zones: null })).toEqual(breakdown(some, { now: NOW }));
  });

  it('every fact that is NOT about zones still works', () => {
    const out = breakdown(some, { now: NOW });
    expect(out.totalOrders).toBe(3);
    expect(out.groups.map((g) => g.code)).toEqual(['NG-FC', null]);
    expect(out.groups[0].orders).toBe(2);
    expect(out.groups[0].collapsed).toEqual([
      { raw: 'Abuja', orders: 1 },
      { raw: 'F.C.T.', orders: 1 },
    ]);
    expect(out.nonNigerianOrders).toBe(1);
    expect(out.groups[0].awaitingAction).toBe(2);
    expect(out.totals[0].currency).toBe('NGN');
  });

  it('a group carries a reading exactly when the breakdown does', () => {
    for (const zones of [null, SEEDED]) {
      const out = breakdown(some, { now: NOW, zones });
      for (const group of out.groups) {
        expect(group.delivery.known).toBe(out.delivery.known);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════ breakdown

describe('breakdown — currencies are never summed', () => {
  const mixed = [
    row({ shippingAddress: at('Lagos', { countryCode: 'NG' }), currency: 'NGN', grandTotal: 1000 }),
    row({ shippingAddress: at('Lagos', { countryCode: 'NG' }), currency: 'GBP', grandTotal: 7 }),
  ];

  it('splits one group’s value by currency and keeps both codes', () => {
    const out = breakdown(mixed, { now: NOW });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].orders).toBe(2);
    expect(out.groups[0].value.map((v) => v.currency)).toEqual(['GBP', 'NGN']);
    expect(out.groups[0].value.map((v) => v.grandTotal)).toEqual([7, 1000]);
  });

  it('produces no total anywhere that is 1007', () => {
    // `stats.ts`: "summing GBP and EUR into one integer produces a number that
    // looks like a total and reconciles against nothing."
    const out = breakdown(mixed, { now: NOW });
    const everyTotal = [
      ...out.totals.map((t) => t.grandTotal),
      ...out.groups.flatMap((g) => g.value.map((v) => v.grandTotal)),
    ];
    expect(everyTotal).not.toContain(1007);
    expect(out.totals).toHaveLength(2);
  });

  it('shares are computed WITHIN a currency, never across', () => {
    const out = breakdown(
      [
        ...mixed,
        row({
          shippingAddress: at('Oyo', { countryCode: 'NG' }),
          currency: 'NGN',
          grandTotal: 3000,
        }),
      ],
      { now: NOW },
    );
    const lagos = out.groups.find((g) => g.code === 'NG-LA');
    expect(lagos?.value.find((v) => v.currency === 'GBP')?.sharePct).toBe(100);
    expect(lagos?.value.find((v) => v.currency === 'NGN')?.sharePct).toBe(25);
  });

  it('buckets an unusable currency visibly rather than guessing NGN', () => {
    const out = breakdown(
      [row({ shippingAddress: at('Lagos'), currency: '' as string, grandTotal: 500 })],
      { now: NOW },
    );
    expect(out.totals[0].currency).toBe(UNKNOWN_CURRENCY);
    expect(out.totals[0].grandTotal).toBe(500);
  });

  it('nets refunds without letting a refunded order leave the count', () => {
    const out = breakdown(
      [
        row({
          shippingAddress: at('Lagos'),
          grandTotal: 2000,
          refundedTotal: 2000,
          status: 'refunded',
        }),
      ],
      { now: NOW },
    );
    expect(out.totals[0]).toMatchObject({ orders: 1, grandTotal: 2000, netTotal: 0 });
  });
});

describe('breakdown — money it could not read', () => {
  it('refuses a fractional total instead of truncating it, and SAYS SO', () => {
    /*
     * `Math.trunc` turned ₦0.027 into 2 minor units and reported nothing, so a
     * corrupt figure became a plausible one and the evidence was gone. Minor
     * units are integers; a fraction is corrupt; a rewrite of the operator's
     * money is reported alongside its result or it is not performed.
     */
    const out = breakdown([row({ shippingAddress: at('Lagos'), grandTotal: 2.7 })], { now: NOW });
    expect(out.totals[0].grandTotal).toBe(0);
    expect(out.unusableMoneyFields).toBe(1);
    expect(out.totalOrders).toBe(1);
  });

  it('refuses the far end too — a number too big to add', () => {
    const out = breakdown(
      [row({ shippingAddress: at('Lagos'), grandTotal: 2 ** 53 + 1 })],
      { now: NOW },
    );
    expect(out.totals[0].grandTotal).toBe(0);
    expect(out.unusableMoneyFields).toBe(1);
  });

  it('does NOT count an absent field as corruption', () => {
    // A row with no `refundedTotal` is a row with no refunds, not a broken one.
    const out = breakdown(
      [{ order: { shippingAddress: at('Lagos') } } as unknown as ShopOrderRow],
      { now: NOW },
    );
    expect(out.unusableMoneyFields).toBe(0);
    expect(out.totals[0].grandTotal).toBe(0);
  });

  it('counts each broken field, not each broken row', () => {
    const out = breakdown(
      [
        row({
          shippingAddress: at('Lagos'),
          grandTotal: Number.NaN,
          refundedTotal: 'lots' as unknown as number,
          shippingTotal: Number.POSITIVE_INFINITY,
        }),
      ],
      { now: NOW },
    );
    expect(out.unusableMoneyFields).toBe(3);
  });
});

describe('breakdown — what it could not classify', () => {
  const messy = [
    row({ shippingAddress: at('Atlantis', { countryCode: 'NG' }) }),
    row({ shippingAddress: at('atlantis', { countryCode: 'NG' }) }),
    row({ shippingAddress: at('Lagos', { countryCode: 'NG' }) }),
  ];

  it('keeps unrecognised orders as a row, counted, never dropped', () => {
    const out = breakdown(messy, { now: NOW });
    expect(out.totalOrders).toBe(3);
    expect(out.unrecognised.orders).toBe(2);
    const unknown = out.groups.find((g) => !g.recognised);
    expect(unknown?.orders).toBe(2);
    expect(unknown?.code).toBeNull();
    expect(unknown?.label).toBe('Atlantis');
  });

  it('shows the raw spellings it merged inside the unrecognised bucket too', () => {
    const out = breakdown(messy, { now: NOW });
    const unknown = out.groups.find((g) => !g.recognised);
    expect(unknown?.collapsed).toEqual([
      { raw: 'Atlantis', orders: 1 },
      { raw: 'atlantis', orders: 1 },
    ]);
  });

  it('says WHY, per reason, instead of one silent bucket', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Atlantis') }),
        row({ shippingAddress: undefined as unknown as Record<string, unknown> }),
        row({ shippingAddress: {} }),
        row({ shippingAddress: at(42) }),
        row({ shippingAddress: at('   ') }),
        row({ shippingAddress: at('Delta', { countryCode: 'US' }) }),
      ],
      { now: NOW },
    );
    expect(out.unrecognised.orders).toBe(6);
    expect(out.unrecognised.reasons.map((r) => r.reason).sort()).toEqual([
      'no-address',
      'no-region',
      'non-nigerian',
      'region-blank',
      'region-not-a-string',
      'region-unknown',
    ]);
    expect(out.nonNigerianOrders).toBe(1);
  });

  it('does not merge two different unknown places, or two different countries', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Atlantis', { countryCode: 'NG' }) }),
        row({ shippingAddress: at('Narnia', { countryCode: 'NG' }) }),
        row({ shippingAddress: at('Ontario', { countryCode: 'CA' }) }),
        row({ shippingAddress: at('Ontario', { countryCode: 'US' }) }),
      ],
      { now: NOW },
    );
    expect(out.groups).toHaveLength(4);
    expect(out.groups.map((g) => g.countryCode).sort()).toEqual(['CA', 'NG', 'NG', 'US']);
    expect(out.groups.every((g) => !g.countryCodeMixed)).toBe(true);
  });

  it('counts an order with no address at all, rather than dropping the row', () => {
    const out = breakdown([row({ shippingAddress: {} })], { now: NOW });
    expect(out.totalOrders).toBe(1);
    expect(out.groups[0].label).toBe(NO_REGION_LABEL);
    expect(out.groups[0].sharePct).toBe(100);
  });

  it('sorts destinations above data-quality buckets, whatever their size', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Atlantis') }),
        row({ shippingAddress: at('Atlantis') }),
        row({ shippingAddress: at('Atlantis') }),
        row({ shippingAddress: at('Lagos') }),
      ],
      { now: NOW },
    );
    expect(out.groups.map((g) => g.code)).toEqual(['NG-LA', null]);
    // Still counted, and still visible at the top level.
    expect(out.unrecognised.orders).toBe(3);
  });

  it('orders destinations by count descending, then label, locale-independently', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Oyo') }),
        row({ shippingAddress: at('Lagos') }),
        row({ shippingAddress: at('Lagos') }),
        row({ shippingAddress: at('Kano') }),
      ],
      { now: NOW },
    );
    expect(out.groups.map((g) => g.label)).toEqual(['Lagos', 'Kano', 'Oyo']);
  });
});

describe('breakdown — a group’s country is the group’s, not the first row’s', () => {
  const lagosUnstated = row({ shippingAddress: at('Lagos') });
  const lagosNg = row({ shippingAddress: at('Lagos', { countryCode: 'NG' }) });

  it('reports the country when every order in the group agrees', () => {
    const out = breakdown([lagosNg, lagosNg], { now: NOW });
    expect(out.groups[0].countryCode).toBe('NG');
    expect(out.groups[0].countryCodeMixed).toBe(false);
  });

  it('refuses to pick one when they do not, WHICHEVER WAY ROUND THEY ARRIVE', () => {
    /*
     * This was the bug: the field held whatever the FIRST row said, so the same
     * three Lagos orders reported `'NG'` or `null` purely by page order, and a
     * re-sort of the list above could change it. `serverZone` already took the
     * mixed-value problem seriously via `serverZoneMixed`; this field now does.
     */
    const forwards = breakdown([lagosNg, lagosUnstated], { now: NOW }).groups[0];
    const backwards = breakdown([lagosUnstated, lagosNg], { now: NOW }).groups[0];
    expect(forwards.countryCode).toBeNull();
    expect(backwards.countryCode).toBeNull();
    expect(forwards.countryCodeMixed).toBe(true);
    expect(backwards.countryCodeMixed).toBe(true);
    // Both orders are still in the group; nothing was dropped to get here.
    expect(forwards.orders).toBe(2);
  });

  it('separates "nobody said" from "they disagreed"', () => {
    const silent = breakdown([lagosUnstated, lagosUnstated], { now: NOW }).groups[0];
    expect(silent.countryCode).toBeNull();
    expect(silent.countryCodeMixed).toBe(false);
  });
});

describe('breakdown — shares', () => {
  it('rounds to one decimal place, decided here and not in the component', () => {
    expect(SHARE_DECIMALS).toBe(1);
    const out = breakdown(
      [
        row({ shippingAddress: at('Lagos') }),
        row({ shippingAddress: at('Oyo') }),
        row({ shippingAddress: at('Kano') }),
      ],
      { now: NOW },
    );
    expect(out.groups.map((g) => g.sharePct)).toEqual([33.3, 33.3, 33.3]);
  });

  it('is ALLOWED not to sum to 100, and deliberately does not', () => {
    // Each row is rounded on its own, so three thirds render 99.9. Forcing the
    // column to 100 (largest remainder) would print at least one row a number
    // that is not that row's share — an operator checking one row against the
    // order count would find the screen wrong. Per-row truth wins.
    const out = breakdown(
      [
        row({ shippingAddress: at('Lagos') }),
        row({ shippingAddress: at('Oyo') }),
        row({ shippingAddress: at('Kano') }),
      ],
      { now: NOW },
    );
    const sum = out.groups.reduce((n, g) => n + g.sharePct, 0);
    expect(sum).toBeCloseTo(99.9, 6);
    expect(sum).not.toBe(100);
  });

  it('rounds half away from zero at the boundary', () => {
    // 3/8 = 37.5%, 5/8 = 62.5% — both exact, neither a rounding artefact.
    const rowsOf = (n: number, region: string) =>
      Array.from({ length: n }, () => row({ shippingAddress: at(region) }));
    const out = breakdown([...rowsOf(3, 'Lagos'), ...rowsOf(5, 'Oyo')], { now: NOW });
    expect(out.groups.map((g) => g.sharePct)).toEqual([62.5, 37.5]);
  });

  it('does not divide by zero on an empty page', () => {
    const out = breakdown([], { now: NOW });
    expect(out).toMatchObject({
      generatedAt: NOW,
      totalOrders: 0,
      groups: [],
      collapses: [],
      inferredOrders: 0,
      nonNigerianOrders: 0,
      unusableMoneyFields: 0,
      totals: [],
    });
    expect(out.unrecognised).toEqual({ orders: 0, reasons: [] });
  });

  it('gives a zero-value currency a zero share, not a hundred', () => {
    const out = breakdown([row({ shippingAddress: at('Lagos'), grandTotal: 0 })], { now: NOW });
    expect(out.totals[0].sharePct).toBe(0);
    expect(out.groups[0].value[0].sharePct).toBe(0);
  });

  it('REFUSES a share when the rows cancel, rather than printing ±25,000%', () => {
    /*
     * `shop_orders.grand_total` carries no `>= 0` CHECK, and the old guard only
     * caught `whole <= 0`. Totals of −500, +500 and +3 leave a denominator of 3
     * and shares of −16,667% and +16,667%, rendered as percentages on a screen
     * whose entire value is that the numbers on it can be trusted. Clamping
     * would have hidden them behind a plausible 0% and 100%.
     */
    const out = breakdown(
      [
        row({ shippingAddress: at('Lagos'), grandTotal: -500 }),
        row({ shippingAddress: at('Oyo'), grandTotal: 500 }),
        row({ shippingAddress: at('Kano'), grandTotal: 3 }),
      ],
      { now: NOW },
    );
    expect(out.totals[0].grandTotal).toBe(3);
    for (const group of out.groups) {
      for (const value of group.value) {
        expect(value.sharePct === null || (value.sharePct >= 0 && value.sharePct <= 100)).toBe(
          true,
        );
      }
    }
    const shares = out.groups.map((g) => g.value[0].sharePct);
    expect(shares).toContain(null);
    // The ORDER share is untouched: counts cannot cancel.
    expect(out.groups.map((g) => g.sharePct)).toEqual([33.3, 33.3, 33.3]);
  });

  it('refuses a whole-breakdown share for a currency that nets negative', () => {
    const out = breakdown([row({ shippingAddress: at('Lagos'), grandTotal: -500 })], { now: NOW });
    expect(out.totals[0].grandTotal).toBe(-500);
    expect(out.totals[0].sharePct).toBeNull();
  });
});

describe('breakdown — the operator’s queue', () => {
  it('counts money-taken-goods-not-gone, and not orders awaiting the customer', () => {
    expect(AWAITING_ACTION_STATUSES).toEqual(['paid', 'partially_refunded']);
    const out = breakdown(
      [
        row({ shippingAddress: at('Lagos'), status: 'paid' }),
        row({ shippingAddress: at('Lagos'), status: 'partially_refunded' }),
        row({ shippingAddress: at('Lagos'), status: 'pending' }),
        row({ shippingAddress: at('Lagos'), status: 'cancelled' }),
        row({ shippingAddress: at('Lagos'), status: 'refunded' }),
        row({ shippingAddress: at('Lagos'), status: 'fulfilled' }),
      ],
      { now: NOW },
    );
    expect(out.groups[0].orders).toBe(6);
    expect(out.groups[0].awaitingAction).toBe(2);
  });

  it('drops an order out of the queue the instant it ships', () => {
    const out = breakdown(
      [row({ shippingAddress: at('Lagos'), status: 'paid', fulfilledAt: NOW - 10 })],
      { now: NOW },
    );
    expect(out.groups[0].awaitingAction).toBe(0);
    expect(out.groups[0].oldestAwaitingPlacedAt).toBeNull();
    expect(out.groups[0].oldestAwaitingAgeMs).toBeNull();
  });

  it('takes the whole definition from the caller when asked', () => {
    const out = breakdown([row({ shippingAddress: at('Lagos'), status: 'pending' })], {
      now: NOW,
      awaitingStatuses: ['pending'],
    });
    expect(out.groups[0].awaitingAction).toBe(1);
  });

  it('ages from the `now` it was given, and clamps a skewed clock at zero', () => {
    const placedAt = NOW + 60_000; // a browser clock a minute behind the server
    const out = breakdown([row({ shippingAddress: at('Lagos'), placedAt })], { now: NOW });
    expect(out.groups[0].oldestAwaitingPlacedAt).toBe(placedAt);
    expect(out.groups[0].oldestAwaitingAgeMs).toBe(0);
  });
});

describe('breakdown — purity, in a form that can fail', () => {
  /*
   * WHAT THIS REPLACED, AND WHY. The old test was
   * `expect(breakdown(x)).toEqual(breakdown(x))`, which cannot fail for any
   * deterministic implementation — it asserts that calling a function twice
   * with the same arguments does the same thing, which is true of every
   * function in the language that does not read a clock, and this one is
   * exactly the function that might. It caught nothing.
   *
   * These three CAN fail: a `Date.now()` slipped into the body shows up as a
   * field that moves when `now` does not; a mutation of the caller's rows or
   * zone table shows up in the round trip; and a field that secretly derives
   * from `now` shows up when `now` moves and nothing else does.
   */
  it('mutates neither the rows nor the zone table it was handed', () => {
    const zones = deliveryZoneTableFrom([...LIVE_SEED, LIVE_PORT_HARCOURT]);
    const rowsBefore = JSON.stringify(rows);
    const zonesBefore = JSON.stringify(zones);
    breakdown(rows, { now: NOW, zones });
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    expect(JSON.stringify(zones)).toBe(zonesBefore);
  });

  it('reads no clock: every field is identical across a real interval', () => {
    const first = JSON.stringify(breakdown(rows, { now: NOW, zones: SEEDED }));
    const spin = Date.now();
    while (Date.now() === spin) {
      /* burn at least one millisecond of wall clock between the two calls */
    }
    expect(JSON.stringify(breakdown(rows, { now: NOW, zones: SEEDED }))).toBe(first);
  });

  it('moves EXACTLY the two fields that depend on `now`, and nothing else', () => {
    const step = 60_000;
    const a = breakdown(rows, { now: NOW, zones: SEEDED });
    const b = breakdown(rows, { now: NOW + step, zones: SEEDED });
    expect(a.generatedAt).toBe(NOW);
    expect(b.generatedAt).toBe(NOW + step);
    expect(b.groups[0].oldestAwaitingAgeMs).toBe((a.groups[0].oldestAwaitingAgeMs ?? 0) + step);

    const strip = (out: GeographyBreakdown) =>
      JSON.stringify({
        ...out,
        generatedAt: null,
        groups: out.groups.map((group) => ({ ...group, oldestAwaitingAgeMs: null })),
      });
    expect(strip(b)).toBe(strip(a));
  });
});

describe('breakdown — server disagreement, surfaced', () => {
  it('counts an alias the panel knows and the zone table does not', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Abuja', { countryCode: 'NG' }) }),
        row({ shippingAddress: at('F.C.T.', { countryCode: 'NG' }) }),
      ],
      { now: NOW, zones: SEEDED },
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].code).toBe('NG-FC');
    expect(zonesOf(out).disagreements).toBe(1);
    expect(zoneOf(out.groups[0]).disagreements).toBe(1);
    // No single honest server answer for a group the server prices two ways —
    // and the group SAYS that, rather than leaving `null` to mean two things.
    expect(zoneOf(out.groups[0]).serverZone).toBeNull();
    expect(zoneOf(out.groups[0]).serverZoneMixed).toBe(true);
    // The panel's own reading is still Abuja, and still ₦3,000.
    expect(zoneOf(out.groups[0]).zone?.id).toBe('zone_abuja');
  });

  it('counts a non-Nigerian address the fallback would silently swallow', () => {
    const out = breakdown(
      [row({ shippingAddress: at('Greater London', { countryCode: 'GB' }) })],
      { now: NOW, zones: SEEDED },
    );
    expect(zonesOf(out).disagreements).toBe(1);
    expect(out.nonNigerianOrders).toBe(1);
    expect(zoneOf(out.groups[0]).zone).toBeNull();
    expect(zoneOf(out.groups[0]).serverZone?.id).toBe('zone_rest_of_nigeria');
    expect(zoneOf(out.groups[0]).serverZoneMixed).toBe(false);
  });

  it('counts inferred regions separately from confident ones', () => {
    const out = breakdown(
      [
        row({ shippingAddress: at('Rivers', { countryCode: 'NG' }) }),
        row({ shippingAddress: at('Port Harcourt', { countryCode: 'NG' }) }),
        row({ shippingAddress: at('n/a', { city: 'Port Harcourt', countryCode: 'NG' }) }),
      ],
      { now: NOW },
    );
    expect(out.groups[0].code).toBe('NG-RI');
    expect(out.groups[0].orders).toBe(3);
    expect(out.groups[0].inferred).toBe(2);
    expect(out.inferredOrders).toBe(2);
  });

  it('only lists a collapse where two spellings actually became one row', () => {
    const out = breakdown([row({ shippingAddress: at('Lagos', { countryCode: 'NG' }) })], {
      now: NOW,
    });
    expect(out.groups[0].collapsed).toEqual([{ raw: 'Lagos', orders: 1 }]);
    expect(out.collapses).toEqual([]);
  });

  it('echoes the zone table it read, so a panel can label its own rates', () => {
    const edited = deliveryZoneTableFrom(
      LIVE_SEED.map((zone) =>
        zone.id === 'zone_lagos'
          ? { ...zone, options: [{ ...zone.options[0], amountMinor: 1_250_000 }] }
          : zone,
      ),
    );
    const out = breakdown([row({ shippingAddress: at('Lagos') })], { now: NOW, zones: edited });
    expect(zonesOf(out).zones).toBe(edited);
    expect(zoneOf(out.groups[0]).zone?.amountMinor).toBe(1_250_000);
  });
});

describe('breakdown — total against hostile rows', () => {
  it('never throws, whatever the page contains', () => {
    const garbage = [
      null,
      undefined,
      42,
      'row',
      [],
      {},
      { order: null },
      { order: 'nope' },
      { order: [] },
      { order: {} },
      { order: { shippingAddress: 'Lagos' } },
      { order: { shippingAddress: { region: { toString: () => 'Lagos' } } } },
      { order: { currency: 7, grandTotal: 'lots', refundedTotal: null, status: 9 } },
      { order: { grandTotal: Number.NaN, shippingTotal: Number.POSITIVE_INFINITY } },
      { order: { placedAt: 'yesterday', fulfilledAt: Number.NaN, status: 'paid' } },
      JSON.parse('{"order":{"shippingAddress":{"__proto__":{"region":"Lagos"}}}}'),
    ] as unknown as ShopOrderRow[];

    expect(() => breakdown(garbage, { now: NOW, zones: SEEDED })).not.toThrow();
    const out = breakdown(garbage, { now: NOW, zones: SEEDED });
    expect(out.totalOrders).toBe(garbage.length);
    expect(out.unrecognised.orders).toBe(garbage.length);
    // Nothing corrupt leaked into the money.
    for (const total of out.totals) {
      expect(Number.isFinite(total.grandTotal)).toBe(true);
      expect(Number.isFinite(total.netTotal)).toBe(true);
      expect(Number.isFinite(total.shippingTotal)).toBe(true);
    }
  });

  it('does not read `order` off the prototype chain either', () => {
    /*
     * The file's one bare property read, in a module that states twice that
     * every field goes through `own()`. `Object.create` is not reachable from
     * `JSON.parse`, so this was never going to fire on a real response — but a
     * stated invariant with a hole in it is worse than no invariant, because
     * the next reader trusts it.
     */
    const inherited = Object.create({
      order: {
        shippingAddress: { region: 'Lagos', countryCode: 'NG' },
        grandTotal: 9999,
        currency: 'NGN',
      },
    }) as ShopOrderRow;
    const out = breakdown([inherited], { now: NOW });
    expect(out.groups[0].code).toBeNull();
    expect(out.groups[0].label).toBe(NO_REGION_LABEL);
    expect(out.unrecognised.reasons).toEqual([{ reason: 'no-address', orders: 1 }]);
    expect(out.totals[0].grandTotal).toBe(0);
    expect(out.totals[0].currency).toBe(UNKNOWN_CURRENCY);
  });

  it('survives a non-finite `now` without emitting NaN ages OR a NaN timestamp', () => {
    /*
     * `generatedAt` used to pass `opts.now` through untouched while the ages
     * beside it were sanitised, so `breakdown(rows, { now: NaN }).generatedAt`
     * was `NaN` — and `Intl.DateTimeFormat().format(NaN)` throws `RangeError:
     * Invalid time value`, which is the exact crash that put this route in its
     * error boundary. `null`, not `0`: `0` is a real instant that renders as
     * 1 January 1970 and reads as a fact, and `null` is not assignable to
     * `format`, so the compiler makes the caller decide.
     */
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = breakdown([row({ shippingAddress: at('Lagos') })], { now });
      expect(out.groups[0].oldestAwaitingAgeMs).toBe(0);
      expect(out.generatedAt).toBeNull();
      expect(() =>
        new Intl.DateTimeFormat('en-GB').format(out.generatedAt ?? undefined),
      ).not.toThrow();
    }
    expect(breakdown([], { now: 0 }).generatedAt).toBe(0);
    expect(breakdown([], { now: NOW }).generatedAt).toBe(NOW);
  });
});
