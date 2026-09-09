import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { users } from '../../db/schema';

/**
 * The three tables the delivery-courier subsystem owns (migrations 0980, 1000).
 *
 * DECLARED IN A FILE THIS SUBSYSTEM OWNS EXCLUSIVELY and re-exported from
 * `server/db/commerce-schema.ts`, following Catalog, Payments, Cart, Reviews and
 * Settings before it — that file has been wholesale-overwritten more than once
 * and a block declared inside it vanishes quietly, while a lost `export *` line
 * is one line `tsc` names immediately.
 *
 * ⚠️  NOT THE SOURCE OF TRUTH FOR THE DDL. `drizzle.config.ts` declares only
 *     `server/db/schema.ts`, so drizzle-kit has never seen any of these tables
 *     and never will. They exist because `migrations/0980_logistics.sql` and
 *     `1000_courier_places.sql` created them, hand-written in full. What this
 *     file buys is `$inferSelect`, one place to read the shape, and a home for
 *     the documentation; `schema-parity.test.ts` reads every shape back out of
 *     `information_schema` and `pg_constraint` so the description and its
 *     authority cannot drift.
 *
 * NOTHING IN `server/shop/logistics/` IMPORTS THESE OBJECTS. Every statement in
 * the subsystem is raw parameterised SQL through `db.execute`, as in Payments,
 * because the guards that matter — a CAS in an UPDATE's WHERE, a chain of
 * data-modifying CTEs — are not expressible in the query builder.
 *
 * The house rules apply and are asserted rather than trusted: `bigint` epoch-ms
 * rather than `timestamptz`, and a `check()` on every enum-ish column, because
 * `.$type<>()` is compile-time only and buys nothing against a bug that writes
 * `provider = 'dhl'`.
 */

/** The ship-from address, as stored. `line2` and `email` are genuinely optional
 *  at both couriers; `countryCode` is pinned to NG by the route's validator. */
export interface ShipFromJson {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

/** The box Terminal is quoted against. Centimetres and kilogrammes, as both
 *  providers' APIs expect them. */
export interface PackagingJson {
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
}

/**
 * Which courier is switched on, where we ship from, and what we ship in.
 *
 * `provider` IS THE FEATURE FLAG. One column with one value, CHECK-pinned to
 * `manual` / `fez` / `terminal`, so two couriers cannot be live at once by
 * construction rather than by a rule somebody has to remember.
 */
export const shopLogisticsSettings = pgTable(
  'shop_logistics_settings',
  {
    /** Pinned to `'main'` by a CHECK, as `shop_delivery_settings.id` is. There
     *  is one configuration, and a route that could name another is a route
     *  that could find a second answer. */
    id: text('id').primaryKey(),
    provider: text('provider').$type<'manual' | 'fez' | 'terminal'>().notNull().default('manual'),
    /** NULL until an operator fills it in. Required before Terminal may be
     *  switched on (Fez collects from an address held in their own portal). */
    shipFrom: jsonb('ship_from').$type<ShipFromJson>(),
    packaging: jsonb('packaging')
      .$type<PackagingJson>()
      .notNull()
      .default(
        sql`'{"name":"Spool box","lengthCm":22,"widthCm":22,"heightCm":8,"weightKg":0.25}'::jsonb`,
      ),
    /** Terminal's PA-… id, created lazily on the first quote and cleared
     *  whenever the packaging changes, so a stale box is never quoted. */
    terminalPackagingId: text('terminal_packaging_id'),
    /** CAS, as on `posts.revision` and `shop_delivery_settings.revision`. */
    revision: integer('revision').notNull().default(1),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /**
     * ON DELETE SET NULL, deliberately. Removing a teammate from the admin must
     * not take the courier configuration they last saved down with them — the
     * same decision `shop_delivery_settings` records.
     */
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('shop_logistics_settings_id_ck', sql`${t.id} = 'main'`),
    check(
      'shop_logistics_settings_provider_ck',
      sql`${t.provider} IN ('manual', 'fez', 'terminal')`,
    ),
    check('shop_logistics_settings_revision_ck', sql`${t.revision} > 0`),
    /* jsonb holds a scalar or an array just as happily as an object, and every
     * reader here indexes into it by key. */
    check('shop_logistics_settings_packaging_ck', sql`jsonb_typeof(${t.packaging}) = 'object'`),
    check(
      'shop_logistics_settings_ship_from_ck',
      sql`${t.shipFrom} IS NULL OR jsonb_typeof(${t.shipFrom}) = 'object'`,
    ),
  ],
);

/**
 * Every inbound courier webhook, verified or not.
 *
 * LOGGED BEFORE IT IS JUDGED, which is the point: the settings screen has to be
 * able to show that a courier's calls actually reach this admin, and a log that
 * only kept the ones that verified would be silent in exactly the case an
 * operator needs it — a wrong secret, or a provider calling the wrong URL.
 */
export const shopLogisticsWebhooks = pgTable(
  'shop_logistics_webhooks',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<'fez' | 'terminal'>().notNull(),
    /** What the payload named, which may match no parcel at all — hence
     *  `unmatched` below, and hence no foreign key. */
    providerRef: text('provider_ref'),
    rawStatus: text('raw_status'),
    /** The signature verdict, kept beside the row rather than inferred from
     *  `applied`: a verified delivery can still be ignored. */
    verified: boolean('verified').notNull(),
    applied: text('applied').$type<'applied' | 'ignored' | 'unmatched' | 'rejected'>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('shop_logistics_webhooks_provider_ck', sql`${t.provider} IN ('fez', 'terminal')`),
    check(
      'shop_logistics_webhooks_applied_ck',
      sql`${t.applied} IN ('applied', 'ignored', 'unmatched', 'rejected')`,
    ),
    /* The settings screen reads the newest ten and nothing else ever reads this
     * table. `id` breaks the tie so the page is stable across two deliveries
     * that landed in the same millisecond. */
    index('shop_logistics_webhooks_recent_idx').on(t.receivedAt.desc(), t.id),
  ],
);

/** One entry in a courier's list of regions. `code` is the courier's own state
 *  code — Terminal's `isoCode`, Fez's numeric id as a string — and `null` where
 *  a courier publishes a name and nothing to send back to it. */
export interface PlaceRegionJson {
  name: string;
  code: string | null;
}

/** A place inside a region. A NAME AND NOTHING ELSE, deliberately: this is the
 *  string the courier validates against, and anything more would be a second
 *  place to keep in step with somebody else's list. */
export interface PlaceCityJson {
  name: string;
}

/** One row of a courier's export catalogue — a COUNTRY AND A WEIGHT BRACKET,
 *  since that is what the courier sells. `countryCodes` is a LIST because a row
 *  may name a region rather than a country (Fez sells one called "Europe"), and
 *  EMPTY for a name nothing recognised: such a row is offered to nobody rather
 *  than guessed at. */
export interface ExportDestinationJson {
  id: number;
  name: string;
  place: string;
  countryCodes: string[];
  minKg: number | null;
  maxKg: number | null;
}

/** A bracket the courier sells. `"0 - 2"` is a RANGE, so `maxKg` is a ceiling. */
export interface ExportWeightJson {
  id: number;
  name: string;
  minKg: number | null;
  maxKg: number | null;
}

/**
 * WHAT EACH COURIER SAYS IT WILL ACCEPT, cached (migration 1000).
 *
 * A CACHE AND ONLY A CACHE. Terminal validates state AND city against its own
 * per-country lists and refuses anything else with a 400 that kills the whole
 * quote — measured 2026-09-07: 37 states for NG, ten place names inside the
 * FCT, 46 in Lagos. Asking it fresh would be 37 requests in a checkout, so an
 * admin presses a button, the answer lands here, and the storefront reads this
 * row. Dropping the table loses nothing but the button press.
 *
 * KEYED BY COURIER AND COUNTRY TOGETHER, so both couriers' lists can sit here
 * at once and switching the courier reads a different row rather than a list
 * the live one has never heard of.
 */
export const shopLogisticsPlaces = pgTable(
  'shop_logistics_places',
  {
    provider: text('provider').$type<'fez' | 'terminal'>().notNull(),
    /** ISO-3166 alpha-2, upper-case, pinned by a CHECK. Nothing here is
     *  Nigeria-only by construction. */
    country: text('country').notNull(),
    regions: jsonb('regions').$type<PlaceRegionJson[]>().notNull(),
    /**
     * `null` FOR A COURIER THAT ENFORCES NO CITY LIST — Fez takes a free-text
     * address and validates no city at all. "We enforce nothing" and "we
     * enforce a list that happens to be empty" send a storefront to opposite
     * behaviours, and only the first is true of Fez.
     */
    cities: jsonb('cities').$type<Record<string, PlaceCityJson[]>>(),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'shop_logistics_places_pk', columns: [t.provider, t.country] }),
    check('shop_logistics_places_provider_ck', sql`${t.provider} IN ('fez', 'terminal')`),
    check('shop_logistics_places_country_ck', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('shop_logistics_places_regions_ck', sql`jsonb_typeof(${t.regions}) = 'array'`),
    check(
      'shop_logistics_places_cities_ck',
      sql`${t.cities} IS NULL OR jsonb_typeof(${t.cities}) = 'object'`,
    ),
  ],
);

/**
 * WHERE THE COURIER CARRIES TO OUTSIDE NIGERIA (migration 1080).
 *
 * ONE ROW PER PROVIDER, not per provider and country: a courier publishes its
 * whole export catalogue in one call, and a row per destination would invent a
 * shape the source does not have plus a partial refresh that could leave two
 * halves disagreeing about the same fetch.
 */
export const shopLogisticsExports = pgTable(
  'shop_logistics_exports',
  {
    provider: text('provider').$type<'fez' | 'terminal'>().notNull(),
    /** `[{ id, name, place, countryCodes, minKg, maxKg }]`. A row is a country
     *  AND a weight bracket — "Ghana(0-2kg)" — so heavier parcels to the same
     *  country are different rows with different ids. */
    destinations: jsonb('destinations').$type<ExportDestinationJson[]>().notNull(),
    /** `[{ id, name, minKg, maxKg }]`. `"0 - 2"` is a RANGE: 2 kg is the
     *  bracket's ceiling, never a floor. */
    weights: jsonb('weights').$type<ExportWeightJson[]>().notNull(),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'shop_logistics_exports_pk', columns: [t.provider] }),
    check('shop_logistics_exports_provider_ck', sql`${t.provider} IN ('fez', 'terminal')`),
    check('shop_logistics_exports_destinations_ck', sql`jsonb_typeof(${t.destinations}) = 'array'`),
    check('shop_logistics_exports_weights_ck', sql`jsonb_typeof(${t.weights}) = 'array'`),
    check('shop_logistics_exports_fetched_at_ck', sql`${t.fetchedAt} > 0`),
  ],
);

export type DbShopLogisticsSettings = typeof shopLogisticsSettings.$inferSelect;
export type DbShopLogisticsWebhook = typeof shopLogisticsWebhooks.$inferSelect;
export type DbShopLogisticsPlaces = typeof shopLogisticsPlaces.$inferSelect;
export type DbShopLogisticsExports = typeof shopLogisticsExports.$inferSelect;
