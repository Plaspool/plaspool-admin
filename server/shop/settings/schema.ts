import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Delivery settings — the one row that decides how checkout asks for an address
 * (migration 0760).
 *
 * DECLARED IN A FILE THIS SUBSYSTEM OWNS EXCLUSIVELY and re-exported from
 * `server/db/commerce-schema.ts`, following Catalog, Payments, Cart and Reviews
 * before it — that file has been wholesale-overwritten more than once and a
 * block declared inside it vanishes quietly, while a lost `export *` line is
 * one line `tsc` names immediately.
 *
 * ⚠️  NOT THE SOURCE OF TRUTH FOR THE DDL. `drizzle.config.ts` declares only
 *     `server/db/schema.ts`, so drizzle-kit has never seen this table. It
 *     exists because migration `0760_shop_delivery_settings.sql` created it.
 *     What this buys is `$inferSelect` and one place to read the shape;
 *     `settings.test.ts` reads the columns back out of `information_schema` so
 *     the two cannot drift.
 *
 * The two house rules apply: `bigint` epoch-ms rather than `timestamptz`, and a
 * `check()` on every enum-ish column, because `.$type<>()` is compile-time only.
 */
export const shopDeliverySettings = pgTable(
  'shop_delivery_settings',
  {
    /** Pinned to `'main'` by a CHECK. There is one configuration, and a route
     *  that could name another is a route that could find a second answer. */
    id: text('id').primaryKey(),
    /**
     * `'district'` is the behaviour this shop has shipped since migration 0460
     * and the seeded value. `'simple'` drops the district question from the
     * storefront's form and prices every order at its state's zone rate.
     */
    addressMode: text('address_mode').$type<'district' | 'simple'>().notNull(),
    /** Offers the storefront's "Use my current location" button. Deliberately
     *  independent of the mode — see the migration header. */
    locationOffered: boolean('location_offered').notNull(),
    /**
     * Address regions the shop accepts, or `null` for no restriction (the
     * seeded value). Matched case- and whitespace-insensitively, the way
     * `zoneFor` matches a region.
     *
     * EXISTS BECAUSE `'simple'` TURNS OFF EVERY PER-DISTRICT REFUSAL: with no
     * district on the address there is nothing to consult, and the catch-all
     * zone covers all of Nigeria. An EMPTY array is refused by the column's
     * CHECK rather than read as "serve nowhere".
     */
    servedRegions: text('served_regions').array(),
    /**
     * Where the shop will ship at all (migration 1060). ISO-3166-1 alpha-2.
     *
     * NOT NULL AND NEVER EMPTY, unlike `servedRegions` — there is no spelling
     * of "everywhere". A country nobody named falls to the catch-all zone,
     * which is the bug 0900 fixed; see the migration header.
     */
    servedCountries: text('served_countries').array().notNull(),
    /** CAS, as on `posts.revision`. Moves on every write. */
    revision: integer('revision').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('shop_delivery_settings_id_ck', sql`${t.id} = 'main'`),
    check('shop_delivery_settings_mode_ck', sql`${t.addressMode} IN ('district', 'simple')`),
    check('shop_delivery_settings_revision_ck', sql`${t.revision} > 0`),
    check(
      'shop_delivery_settings_regions_ck',
      sql`${t.servedRegions} IS NULL
          OR (cardinality(${t.servedRegions}) > 0
              AND array_position(${t.servedRegions}, NULL) IS NULL
              AND array_position(${t.servedRegions}, '') IS NULL)`,
    ),
  ],
);

export type DbShopDeliverySettings = typeof shopDeliverySettings.$inferSelect;
