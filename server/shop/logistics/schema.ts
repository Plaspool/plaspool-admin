import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from '../../db/schema';

/**
 * The two tables the delivery-courier subsystem owns (migration 0980).
 *
 * DECLARED IN A FILE THIS SUBSYSTEM OWNS EXCLUSIVELY and re-exported from
 * `server/db/commerce-schema.ts`, following Catalog, Payments, Cart, Reviews and
 * Settings before it — that file has been wholesale-overwritten more than once
 * and a block declared inside it vanishes quietly, while a lost `export *` line
 * is one line `tsc` names immediately.
 *
 * ⚠️  NOT THE SOURCE OF TRUTH FOR THE DDL. `drizzle.config.ts` declares only
 *     `server/db/schema.ts`, so drizzle-kit has never seen either table and
 *     never will. They exist because `migrations/0980_logistics.sql` created
 *     them, hand-written in full. What this file buys is `$inferSelect`, one
 *     place to read the shape, and a home for the documentation;
 *     `schema-parity.test.ts` reads both shapes back out of `information_schema`
 *     and `pg_constraint` so the description and its authority cannot drift.
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

export type DbShopLogisticsSettings = typeof shopLogisticsSettings.$inferSelect;
export type DbShopLogisticsWebhook = typeof shopLogisticsWebhooks.$inferSelect;
