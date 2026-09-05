import type { AddressMode, DeliverySettings } from './repo';

/**
 * THE ADDRESS FORM, AS DATA — what `GET /api/public/shop/delivery-config`
 * answers and what the storefront renders its checkout address step from.
 *
 * A PURE FUNCTION OVER THE SETTINGS ROW. No database, no clock, no request: the
 * route reads one row and calls this, so the whole contract below is testable
 * by calling it, and `config.test.ts` does exactly that for both modes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE SERVER DESCRIBES THE FORM AT ALL.
 *
 * Because the alternative is two hardcoded forms in the storefront and a flag
 * to pick between them — which means every change to either one is a storefront
 * deploy, and the two drift the first time only one of them is updated. Here
 * the mode, the field set, the order and the limits arrive together, so a
 * storefront that renders this payload faithfully cannot be showing a field the
 * server has stopped wanting.
 *
 * `mode: 'district'` REPRODUCES TODAY. That is the contract: with the switch
 * off, a shopper cannot tell this endpoint exists. Nothing here is new
 * behaviour — it is the form the shop already ships, written down.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE `maxLength` VALUES ARE THE REAL SERVER LIMITS, copied from the `Address`
 * schema in `server/shop/cart/routes/checkout.ts`. They are on the wire so the
 * form can refuse a 201st character itself instead of letting the shopper write
 * a paragraph and then be 400'd by a route that names a field and nothing else.
 * `config.test.ts` reads them back off that schema so the two cannot drift.
 */

/** Every address field the storefront can be asked to render. */
export type AddressFieldKey =
  | 'name'
  | 'phone'
  | 'region'
  | 'district'
  | 'city'
  | 'line1'
  | 'line2'
  | 'postalCode';

export interface AddressFieldConfig {
  key: AddressFieldKey;
  /** Render it. A `false` field must be OMITTED from the request body, not
   *  sent as `""` — `district` and `postalCode` are both nullable-optional
   *  server-side, and absent means "no opinion", which is what is wanted. */
  show: boolean;
  required: boolean;
  label: string;
  /** One line under the input. Absent means none. */
  help?: string;
  maxLength: number;
  /** The `autocomplete` attribute. Browsers fill these; typing an address on a
   *  phone is the single worst part of any checkout. */
  autocomplete: string;
  /** Present only on `district`: the list is fetched, not enumerated here. */
  source?: 'areas';
}

export interface DeliveryConfig {
  mode: AddressMode;
  /** `shop_delivery_settings.revision`. Moves on every save, so a storefront
   *  can tell a genuinely new config from a re-fetch of the same one. */
  revision: number;
  country: { default: string; allowed: readonly string[]; locked: boolean };
  /** IN RENDER ORDER. The array IS the order — do not sort it. */
  fields: readonly AddressFieldConfig[];
  districts: {
    source: string;
    groupBy: 'region';
    help: string;
    unlistedMessage: string;
  } | null;
  location: {
    offer: boolean;
    required: boolean;
    label: string;
    help: string;
    maxAccuracyMeters: number;
    /** ALWAYS FALSE, and on the wire so it cannot quietly become true. See
     *  migration 0780: there is no geographic data in this system to price a
     *  coordinate against. */
    pricing: false;
  };
  /** Address regions the shop accepts, or `null` for no restriction. The form
   *  can refuse before submit; the server refuses again at `PUT
   *  /checkout/addresses`, which is the one that counts. */
  servedRegions: readonly string[] | null;
}

/**
 * ONE COUNTRY, PINNED. `shop_addresses_country_ck` demands `^[A-Z]{2}$` and
 * every shipping zone this shop has ever had is Nigerian — a country selector
 * offering places with no zone is a selector whose every other choice quotes
 * the catch-all rate. `locked` tells the storefront to render it as text, not
 * a dropdown.
 */
const COUNTRY = { default: 'NG', allowed: ['NG'] as const, locked: true };

/**
 * The limits, mirroring `Address` in `server/shop/cart/routes/checkout.ts`.
 * Named rather than inlined so the drift test has one thing to compare.
 */
export const ADDRESS_MAX_LENGTHS: Record<AddressFieldKey, number> = {
  name: 200,
  phone: 40,
  region: 120,
  district: 120,
  city: 120,
  line1: 200,
  line2: 200,
  postalCode: 40,
};

/**
 * `postalCode` IS HIDDEN IN BOTH MODES, and that is not part of the switch.
 * Nigeria has postcodes and essentially nobody uses them; the column stays,
 * every address written before this keeps its value, and the field simply is
 * not asked for. Turned back on by editing this line, not by a setting — a
 * toggle for a field nobody wants is a toggle nobody will ever move.
 */
const POSTAL_CODE: AddressFieldConfig = {
  key: 'postalCode',
  show: false,
  required: false,
  label: 'Postcode',
  maxLength: ADDRESS_MAX_LENGTHS.postalCode,
  autocomplete: 'postal-code',
};

/** Shared by both modes, and identical in both — nothing about who you are or
 *  how to reach you changes when the district question goes away. */
const IDENTITY: readonly AddressFieldConfig[] = [
  {
    key: 'name',
    show: true,
    required: true,
    label: 'Full name',
    maxLength: ADDRESS_MAX_LENGTHS.name,
    autocomplete: 'name',
  },
  {
    key: 'phone',
    show: true,
    required: true,
    label: 'Phone number',
    help: 'The rider calls this when they arrive.',
    maxLength: ADDRESS_MAX_LENGTHS.phone,
    autocomplete: 'tel',
  },
];

/**
 * `region` IS REQUIRED IN BOTH MODES AND IS NEVER HIDDEN.
 *
 * The shipping zone — and therefore the delivery price and the tax rate — is
 * derived from `countryCode` + `region` by `zoneFor`, in both modes. An address
 * with no region falls into the catch-all zone, which prices rest-of-Nigeria
 * delivery for a parcel that might be going three streets away. A config that
 * hid this field would be a config that mispriced every order rendered from it.
 */
const REGION: AddressFieldConfig = {
  key: 'region',
  show: true,
  required: true,
  label: 'State',
  maxLength: ADDRESS_MAX_LENGTHS.region,
  autocomplete: 'address-level1',
};

/**
 * BY AREA — what this shop ships today (migrations 0300 and 0460).
 *
 * The shopper picks a district from `marketing_service_areas`; the key they
 * pick is what `shop_delivery_areas` prices by and refuses by. Nothing in this
 * branch is new.
 */
function districtFields(): AddressFieldConfig[] {
  return [
    ...IDENTITY,
    REGION,
    {
      key: 'district',
      show: true,
      required: true,
      label: 'Area',
      help: 'Pick the area closest to you. It sets your delivery price.',
      maxLength: ADDRESS_MAX_LENGTHS.district,
      autocomplete: 'off',
      source: 'areas',
    },
    {
      key: 'city',
      show: true,
      required: true,
      label: 'Town or city',
      maxLength: ADDRESS_MAX_LENGTHS.city,
      autocomplete: 'address-level2',
    },
    {
      key: 'line1',
      show: true,
      required: true,
      label: 'Street address',
      maxLength: ADDRESS_MAX_LENGTHS.line1,
      autocomplete: 'address-line1',
    },
    {
      key: 'line2',
      show: true,
      required: false,
      label: 'Apartment, floor',
      maxLength: ADDRESS_MAX_LENGTHS.line2,
      autocomplete: 'address-line2',
    },
    POSTAL_CODE,
  ];
}

/**
 * SIMPLE — six fields, no list to search.
 *
 * The two address lines are labelled for how people here actually give
 * directions: the street, then the landmark and the gate. That is the whole
 * point of the mode — the shop was asking for a taxonomy when what it needed
 * was a sentence a rider can follow.
 *
 * `district` and `postalCode` ARE STILL LISTED, with `show: false`. A storefront
 * that keys off the array rather than off the mode then has nothing to special
 * case, and the absence is explicit rather than inferred from a missing entry.
 */
function simpleFields(): AddressFieldConfig[] {
  return [
    ...IDENTITY,
    REGION,
    {
      key: 'city',
      show: true,
      required: true,
      label: 'Town or city',
      maxLength: ADDRESS_MAX_LENGTHS.city,
      autocomplete: 'address-level2',
    },
    {
      key: 'line1',
      show: true,
      required: true,
      label: 'Address',
      help: 'House number, street, and the nearest landmark.',
      maxLength: ADDRESS_MAX_LENGTHS.line1,
      autocomplete: 'address-line1',
    },
    {
      key: 'line2',
      show: true,
      required: false,
      label: 'Extra directions',
      help: 'Gate colour, floor, who to ask for.',
      maxLength: ADDRESS_MAX_LENGTHS.line2,
      autocomplete: 'address-line2',
    },
    {
      key: 'district',
      show: false,
      required: false,
      label: 'Area',
      maxLength: ADDRESS_MAX_LENGTHS.district,
      autocomplete: 'off',
    },
    POSTAL_CODE,
  ];
}

/**
 * WHERE THE DISTRICT LIST COMES FROM — marketing's public areas route, which
 * has served the returns form's picker since it was written.
 *
 * A URL ON THE WIRE RATHER THAN A CONSTANT IN THE STOREFRONT, so "which list"
 * and "is there a list" arrive as one answer. `null` in simple mode is what
 * tells a storefront to stop fetching it, without it having to infer that from
 * the mode string.
 */
const AREAS_SOURCE = '/api/public/marketing/areas';

/** The one thing this endpoint is for: the form, from the row. */
export function deliveryConfigFor(settings: DeliverySettings): DeliveryConfig {
  const simple = settings.addressMode === 'simple';
  return {
    mode: settings.addressMode,
    revision: settings.revision,
    country: COUNTRY,
    fields: simple ? simpleFields() : districtFields(),
    districts: simple
      ? null
      : {
          source: AREAS_SOURCE,
          groupBy: 'region',
          help: 'Pick the area closest to you. It sets your delivery price.',
          unlistedMessage: "We don't deliver there yet. Pick another area, or get in touch.",
        },
    location: {
      offer: settings.locationOffered,
      /* NEVER REQUIRED. A permission prompt the shopper must accept to buy
       * anything is a permission prompt that loses the sale, and a denied one
       * would leave the form unfinishable. Asking once and taking no for an
       * answer is the whole design. */
      required: false,
      label: 'Use my current location',
      help: "We'll save the spot so the rider can find you. It doesn't change your price.",
      /* Past this the fix is a neighbourhood, not a door. The reading is still
       * KEPT — a 2km fix narrows a rider's search — but the storefront says so
       * rather than presenting it as a pin. */
      maxAccuracyMeters: 500,
      pricing: false,
    },
    servedRegions: settings.servedRegions,
  };
}
