import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Notification settings — the one row that decides who the shop tells when an
 * order is paid (migration 0980).
 *
 * DECLARED IN A FILE THIS SUBSYSTEM OWNS EXCLUSIVELY and re-exported from
 * `server/db/commerce-schema.ts`, following Catalog, Payments, Cart, Reviews
 * and Delivery settings before it — that file has been wholesale-overwritten
 * more than once and a block declared inside it vanishes quietly, while a lost
 * `export *` line is one line `tsc` names immediately.
 *
 * ⚠️  NOT THE SOURCE OF TRUTH FOR THE DDL. `drizzle.config.ts` declares only
 *     `server/db/schema.ts`, so drizzle-kit has never seen this table. It
 *     exists because migration `0980_order_notifications.sql` created it. What
 *     this buys is `$inferSelect` and one place to read the shape.
 *
 * The two house rules apply: `bigint` epoch-ms rather than `timestamptz`, and a
 * `check()` on every enum-ish column, because `.$type<>()` is compile-time only.
 */
export const shopNotificationSettings = pgTable(
  'shop_notification_settings',
  {
    /** Pinned to `'main'` by a CHECK. There is one answer to "who gets told",
     *  and a route that could name another is a route that could find two. */
    id: text('id').primaryKey(),
    /**
     * Addresses somebody typed in, on top of the team roster.
     *
     * AN EMPTY ARRAY IS THE ORDINARY STATE, and unlike
     * `shop_delivery_settings.servedRegions` there is deliberately no
     * `cardinality > 0` — see the migration header. "Nobody extra" is what most
     * shops mean, and a constraint forbidding it would force an operator to
     * invent an address in order to say "just the team".
     */
    orderRecipients: text('order_recipients').array().notNull(),
    /** Also mail everyone on the roster whose role holds the `orders` domain. */
    notifyTeam: boolean('notify_team').notNull(),
    /** The master switch over the paid-order mail. The in-app bell and the
     *  browser notification are separate surfaces and unaffected by it. */
    notifyOnOrder: boolean('notify_on_order').notNull(),
    /** CAS, as on `posts.revision`. Moves on every write. */
    revision: integer('revision').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('shop_notification_settings_id_ck', sql`${t.id} = 'main'`),
    check('shop_notification_settings_revision_ck', sql`${t.revision} > 0`),
    check(
      'shop_notification_settings_recipients_ck',
      sql`array_position(${t.orderRecipients}, NULL) IS NULL
          AND array_position(${t.orderRecipients}, '') IS NULL`,
    ),
  ],
);

export type DbShopNotificationSettings = typeof shopNotificationSettings.$inferSelect;
