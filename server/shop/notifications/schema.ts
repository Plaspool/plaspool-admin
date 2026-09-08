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

/**
 * The devices Web Push may reach (migration 1040).
 *
 * ONE ROW PER DEVICE. A subscription is minted by one browser on one machine
 * and its `endpoint` is that device's identity, so the UNIQUE sits there rather
 * than on `userId` — the same person's phone and laptop are two rows and both
 * are meant to buzz. Re-subscribing therefore upserts on `endpoint`; keyed on
 * the person instead, a second device would silently replace the first.
 *
 * NOTHING HERE IS A SECRET OF OURS. `p256dh` and `auth` are the BROWSER's
 * public key and a per-subscription salt, minted client-side and inert without
 * the endpoint they belong to. The key that proves the shop sent a message is
 * `VAPID_PRIVATE_KEY`, an environment variable, and it is never stored.
 *
 * Same two caveats as the table above: drizzle-kit has never seen this, and the
 * DDL in `1040_push_subscriptions.sql` is what actually made it.
 */
export const shopPushSubscriptions = pgTable(
  'shop_push_subscriptions',
  {
    id: text('id').primaryKey(),
    /** Whose device it is. CASCADE on the FK: an account that is gone has no
     *  devices, and an orphan row would push to somebody who has left. */
    userId: uuid('user_id').notNull(),
    /** The push service's URL for this device — its identity. */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** Free text from the browser, shown so a person can tell one device from
     *  another. Never parsed. */
    userAgent: text('user_agent'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /** When a push to it last succeeded; NULL until one does. */
    lastSuccessAt: bigint('last_success_at', { mode: 'number' }),
  },
  (t) => [
    check(
      'shop_push_subscriptions_endpoint_ck',
      sql`${t.endpoint} LIKE 'https://%' AND length(${t.endpoint}) BETWEEN 12 AND 2000`,
    ),
    check('shop_push_subscriptions_p256dh_ck', sql`length(${t.p256dh}) BETWEEN 16 AND 255`),
    check('shop_push_subscriptions_auth_ck', sql`length(${t.auth}) BETWEEN 8 AND 255`),
  ],
);

export type DbShopPushSubscription = typeof shopPushSubscriptions.$inferSelect;
