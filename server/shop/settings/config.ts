import type { AddressMode, DeliverySettings } from './repo';
import type { ProviderSetting } from '../logistics/repo';

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
  | 'routingCity'
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
  /**
   * Present on the two fields whose values come from a LIST rather than from
   * the keyboard — the list is fetched, not enumerated here. `'areas'` is
   * marketing's served areas (`district`); `'places'` is the active courier's
   * own place list (`routingCity`). The URL for each is on the payload beside
   * `fields`, so a storefront never hardcodes one.
   */
  source?: 'areas' | 'places';
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
  /**
   * WHERE THE COURIER'S OWN PLACE LIST LIVES, and the copy that explains why a
   * shopper is being asked to pick from it (migration 1020).
   *
   * `null`, AND THE FIELD HIDDEN, FOR A COURIER WITH NO CITY LIST. Fez
   * validates no city at all and `manual` is not a courier, so asking either
   * shop's customers to choose from a list nothing will ever check is a
   * question with no answer. Only Terminal enforces one.
   *
   * The list is keyed by the region's `code`, which is what `regions[].code`
   * from that endpoint carries — the region NAME is not interchangeable with
   * it.
   */
  routingCity: {
    source: '/api/public/shop/delivery-places';
    label: string;
    help: string;
    /** What to say when the shopper's own town is not on the courier's list —
     *  the case this whole feature exists for. */
    unlistedHelp: string;
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
 * WHERE THE SHOP SHIPS, FROM THE ROW — `shop_delivery_settings.served_countries`.
 *
 * THIS WAS A PINNED CONSTANT UNTIL MIGRATION 1060, and the constant was the
 * whole reason international checkout was impossible: the storefront gates
 * Continue on `allowed`, so a hardcoded `['NG']` refused every foreign address
 * no matter what zones existed. It is a column now, so opening a country is a
 * setting an owner changes — not a deploy of two repositories.
 *
 * `locked` AND `default` ARE DERIVED, NEVER STORED. One country renders as
 * text and is necessarily its own default; several render a dropdown, and the
 * owner's ordering decides what it pre-selects. Storing either alongside the
 * list would be storing something that can disagree with it.
 *
 * WHAT THIS DOES NOT DO IS PRICE ANYTHING. Adding a country here does not
 * create a zone for it — `zoneFor` will hand an unzoned country the catch-all
 * rate, which is the ₦50,000 fail-safe. Set the zone's rate FIRST; the admin
 * card says so, and it is why the two live on the same screen.
 */
function countryFor(servedCountries: readonly string[]): DeliveryConfig['country'] {
  return {
    /* The CHECK guarantees at least one element, so the head is total. A row
     * hand-edited past the constraint would render an empty selector, which is
     * visibly broken rather than silently permissive — the right way round. */
    default: servedCountries[0],
    allowed: servedCountries,
    locked: servedCountries.length === 1,
  };
}

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
  /* The city's limit, because it holds the same kind of thing — a place name
   * off the courier's list — and a courier that published a longer one than we
   * accept would be refusing our own storefront's pick. */
  routingCity: 120,
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
 * `line2` IS THE LANDMARK FIELD, AND IT IS THE SAME FIELD IN BOTH MODES.
 *
 * It always reached both couriers — Terminal's own `line2`, and Fez's free-text
 * `recipientAddress` through `oneLine()` — but district mode used to label it
 * "Apartment, floor" with no help at all, which asks for a taxonomy and gets a
 * rider nothing, while simple mode asked for the gate colour. One definition,
 * so a rider gets the same detail whichever form the shop is running.
 *
 * This is also why the courier-places work adds no landmark column: there is
 * already one, and it is already wired end to end.
 */
const DIRECTIONS: AddressFieldConfig = {
  key: 'line2',
  show: true,
  required: false,
  label: 'Extra directions',
  help: 'Gate colour, floor, who to ask for.',
  maxLength: ADDRESS_MAX_LENGTHS.line2,
  autocomplete: 'address-line2',
};

/**
 * THE COURIER'S DELIVERY ZONE — asked AFTER the real town, in both modes.
 *
 * The shopper answers where they actually are first; the zone is the follow-up
 * that only makes sense once they have ("you said Gwarinpa — which of these is
 * nearest?"). Their own answer is never overwritten: `city` keeps it, and it is
 * what the rider reads.
 *
 * `required` FOLLOWS `show`, and that is a statement about the FORM, not about
 * the wire. `PUT /checkout/addresses` must never require this field — the
 * config is cached 60s with 300s stale-while-revalidate, so a storefront can be
 * six minutes behind — but a form that has just rendered the list and the copy
 * explaining it can insist. Exactly the split `district` has had since 0460.
 */
function routingCityField(show: boolean): AddressFieldConfig {
  return {
    key: 'routingCity',
    show,
    required: show,
    label: 'Nearest delivery zone',
    help: 'The courier only recognises these. Your address above is what the rider follows.',
    maxLength: ADDRESS_MAX_LENGTHS.routingCity,
    autocomplete: 'off',
    source: 'places',
  };
}

/**
 * BY AREA — what this shop ships today (migrations 0300 and 0460).
 *
 * The shopper picks a district from `marketing_service_areas`; the key they
 * pick is what `shop_delivery_areas` prices by and refuses by. Nothing in this
 * branch is new.
 */
function districtFields(routingCity: boolean): AddressFieldConfig[] {
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
    routingCityField(routingCity),
    {
      key: 'line1',
      show: true,
      required: true,
      label: 'Street address',
      maxLength: ADDRESS_MAX_LENGTHS.line1,
      autocomplete: 'address-line1',
    },
    DIRECTIONS,
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
function simpleFields(routingCity: boolean): AddressFieldConfig[] {
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
    routingCityField(routingCity),
    {
      key: 'line1',
      show: true,
      required: true,
      label: 'Address',
      help: 'House number, street, and the nearest landmark.',
      maxLength: ADDRESS_MAX_LENGTHS.line1,
      autocomplete: 'address-line1',
    },
    DIRECTIONS,
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

/** Migration 1000's cache, served by `server/shop/settings/public.ts`. */
const PLACES_SOURCE = '/api/public/shop/delivery-places';

/**
 * WHICH COURIERS VALIDATE A CITY, exhaustively — a `Record` rather than an
 * array, so adding a courier to `ProviderSetting` fails to compile until
 * somebody answers this question for it.
 *
 * IT IS NOT THE SAME AS "PUBLISHES A PLACE LIST". Fez publishes one — its 37
 * states — and enforces nothing below the state, which is why its cached row
 * carries `cities: null`. `manual` is not a courier at all. Only Terminal
 * refuses an unrecognised city, and only for Terminal is it honest to make a
 * shopper choose from a list.
 */
const VALIDATES_CITY: Record<ProviderSetting, boolean> = {
  manual: false,
  fez: false,
  terminal: true,
};

/**
 * The one thing this endpoint is for: the form, from the row.
 *
 * THE COURIER IS PASSED IN, NOT LOOKED UP. This is a pure function over its
 * arguments — no database, no clock, no request — and reaching into
 * `shop_logistics_settings` from here to answer one boolean would cost that,
 * and with it the property that `config.test.ts` can check the whole contract
 * by calling it. The two routes that serve this already hold a database handle;
 * reading the row is their job.
 *
 * The default is the no-list answer, so every caller written before couriers
 * existed keeps describing exactly the form it described before.
 */
export function deliveryConfigFor(
  settings: DeliverySettings,
  courier: ProviderSetting = 'manual',
): DeliveryConfig {
  const simple = settings.addressMode === 'simple';
  const routingCity = VALIDATES_CITY[courier] ?? false;
  return {
    mode: settings.addressMode,
    revision: settings.revision,
    country: countryFor(settings.servedCountries),
    fields: simple ? simpleFields(routingCity) : districtFields(routingCity),
    districts: simple
      ? null
      : {
          source: AREAS_SOURCE,
          groupBy: 'region',
          help: 'Pick the area closest to you. It sets your delivery price.',
          unlistedMessage: "We don't deliver there yet. Pick another area, or get in touch.",
        },
    routingCity: routingCity
      ? {
          source: PLACES_SOURCE,
          label: 'Nearest delivery zone',
          help: 'The courier only recognises these. Your address above is what the rider follows.',
          /* THE CASE THIS FEATURE EXISTS FOR. A shopper in Gwarinpa will not
           * find Gwarinpa on Terminal's list, and the honest reading of a form
           * that says nothing is "they do not deliver to me". Say what to do
           * and say that their own address is what gets followed. */
          unlistedHelp:
            "Can't see your town? Pick the closest one — we deliver to the address you typed.",
        }
      : null,
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
