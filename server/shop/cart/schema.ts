import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Cart + Checkout tables (contract §4), declared in a file Cart owns
 * exclusively and re-exported from `server/db/commerce-schema.ts`.
 *
 * WHY NOT DECLARED IN `commerce-schema.ts` DIRECTLY, WHICH IS WHAT §4 SAYS.
 * Because "shared, append-only" turned out to be a convention with no mechanism
 * behind it: that file was overwritten wholesale several times in one afternoon
 * by different agents, and Catalog's and Payments' blocks were silently lost
 * before either of them moved to this pattern. A single `export *` line is a
 * surface that costs one line to restore and that `tsc` names immediately;
 * three hundred lines of table declarations vanish quietly. §4's actual purpose
 * — every commerce table reachable from one import path — is preserved exactly.
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL. `drizzle.config.ts`
 *     declares `schema: './server/db/schema.ts'` and nothing else, so
 *     drizzle-kit has never seen these tables. They exist because migration
 *     `0120_cart_checkout.sql` created them. What this file buys is `$inferSelect`
 *     types and one place to read the shape — and it is kept honest rather than
 *     decorative by `server/shop/cart/schema.test.ts`, which reads every column
 *     name back out of `information_schema` and fails if the two disagree.
 *
 * Two rules carry over from `server/db/schema.ts` and are not optional:
 *
 * - **Timestamps are `bigint` epoch-milliseconds, never `timestamptz`.** A
 *   `timestamptz` reads back as a `Date` from PGlite and a string from Neon, and
 *   `toEpochMs` — the function that closes that divergence — works on neither.
 * - **Every enum-ish column carries a `check()`,** because `.$type<>()` is
 *   compile-time only and buys exactly nothing at runtime.
 */

/** epoch-ms. `mode: 'number'` so a read is a number in both drivers. */
const epochMs = (name: string) => bigint(name, { mode: 'number' });

// ------------------------------------------------------------------ identity

/**
 * A customer is NOT a user (contract §7). No password, no role, and an email
 * that may be absent — a pure guest has none.
 */
export const shopCustomers = pgTable(
  'shop_customers',
  {
    id: text('id').primaryKey(),
    email: text('email').unique('shop_customers_email_uq'),
    displayName: text('display_name'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    // Postgres permits many NULLs in a UNIQUE column but exactly ONE empty
    // string, so `''` would make the SECOND guest-turned-account row fail with a
    // raw 23505. The identical trap `normaliseSlug` handles for `posts.slug`.
    check('shop_customers_email_ck', sql`${t.email} IS NULL OR ${t.email} <> ''`),
  ],
);

/**
 * `id` is an HMAC-SHA-256 of the token under `SESSION_SECRET`, hex — never the
 * raw token. Same construction as `sessions`, and for the same reason: a bare
 * digest is offline-computable, so a stolen dump could be attacked with a
 * precomputed table and the winning row replayed as a live session.
 */
export const shopCustomerSessions = pgTable(
  'shop_customer_sessions',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => shopCustomers.id, { onDelete: 'cascade' }),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    lastSeenAt: epochMs('last_seen_at').notNull(),
  },
  (t) => [index('shop_customer_sessions_customer_idx').on(t.customerId)],
);

// ---------------------------------------------------------------------- cart

export const shopCarts = pgTable(
  'shop_carts',
  {
    id: text('id').primaryKey(),
    /** NULLABLE, and contract §7 makes that load-bearing: a cart exists before
     * any identity does. SET NULL, not CASCADE — deleting a customer must not
     * destroy the cart rows an order was built from. */
    customerId: text('customer_id').references(() => shopCustomers.id, {
      onDelete: 'set null',
    }),
    currency: text('currency').notNull(),
    status: text('status').$type<'open' | 'converting' | 'converted' | 'abandoned'>().notNull(),
    email: text('email'),
    shippingOptionId: text('shipping_option_id'),
    taxZone: text('tax_zone'),
    /** THE FROZEN TOTALS. `CheckoutPort.totals()` reads this and never
     * recomputes (brief §5). */
    frozenTotals: jsonb('frozen_totals'),
    /** The goods, frozen at the same instant from the same `quote` calls. */
    frozenLines: jsonb('frozen_lines'),
    frozenAt: epochMs('frozen_at'),
    /**
     * SPOOLPOINTS QUOTED AT THE FREEZE (admin#2, migration 0260).
     *
     * The discount itself is already inside `frozenTotals.adjustments`; these
     * two carry the integer point count and the wallet it was quoted against,
     * because an `Adjustment` is `{ code, label, amount }` and `redeem()` needs
     * the count. Written by the same statement as `frozenTotals`, so a discount
     * and the points that paid for it cannot disagree.
     *
     * NULL is the ordinary cart. Both or neither — `shop_carts_redemption_ck`.
     */
    redemptionPoints: integer('redemption_points'),
    redemptionEmail: text('redemption_email'),
    /** Uppercase discount code, or NULL when none is applied (migration 0820). */
    discountCode: text('discount_code'),
    /** { "<addOnId>": "accepted" | "declined" } (migration 0940). NULL = nothing answered. */
    addOnChoices: jsonb('add_on_choices').$type<Record<string, 'accepted' | 'declined'>>(),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    /** CAS, same as `posts.revision`. Moves on EVERY write of any kind, which is
     * what makes an A→B→A status change visible and a generation trigger
     * unnecessary — see `cart/repo.ts`. */
    revision: integer('revision').notNull(),
  },
  (t) => [
    index('shop_carts_customer_idx').on(t.customerId),
    check(
      'shop_carts_status_ck',
      sql`${t.status} IN ('open','converting','converted','abandoned')`,
    ),
    check('shop_carts_revision_ck', sql`${t.revision} > 0`),
    check(
      'shop_carts_redemption_ck',
      sql`(${t.redemptionPoints} IS NULL AND ${t.redemptionEmail} IS NULL)
          OR (${t.redemptionPoints} > 0 AND ${t.redemptionEmail} <> '')`,
    ),
    check('shop_carts_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'shop_carts_frozen_ck',
      sql`(${t.frozenTotals} IS NULL AND ${t.frozenLines} IS NULL AND ${t.frozenAt} IS NULL)
          OR (${t.frozenTotals} IS NOT NULL AND ${t.frozenLines} IS NOT NULL
              AND ${t.frozenAt} IS NOT NULL)`,
    ),
    check(
      'shop_carts_add_on_choices_ck',
      sql`${t.addOnChoices} IS NULL OR jsonb_typeof(${t.addOnChoices}) = 'object'`,
    ),
    check(
      'shop_carts_discount_code_ck',
      sql`${t.discountCode} IS NULL OR (${t.discountCode} <> '' AND length(${t.discountCode}) <= 64)`,
    ),
  ],
);

export const shopCartLines = pgTable(
  'shop_cart_lines',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id')
      .notNull()
      .references(() => shopCarts.id, { onDelete: 'cascade' }),
    /** DELIBERATELY NOT A FOREIGN KEY (contract §2 R3, brief §3). `shop_variants`
     * is Catalog's; a cross-subsystem FK turns a catalog cleanup into a cart
     * failure, and CASCADE across the boundary would let Catalog silently empty
     * somebody's basket. */
    variantId: text('variant_id').notNull(),
    qty: integer('qty').notNull(),
    addedAt: epochMs('added_at').notNull(),
    // NO PRICE COLUMN, ON PURPOSE (brief §3). `schema.test.ts` fails if one
    // is ever added: a price on a cart line is a third source of truth that goes
    // stale and that nobody notices going stale.
  },
  (t) => [
    uniqueIndex('shop_cart_lines_cart_variant_uq').on(t.cartId, t.variantId),
    check('shop_cart_lines_qty_ck', sql`${t.qty} > 0`),
  ],
);

// -------------------------------------------------------------- reservations

/**
 * The hold, and the CLOCK that governs it. Catalog owns the count; Cart owns
 * the expiry (brief §4).
 *
 * `id` IS the idempotency key Catalog dedupes on, so it is minted here and
 * handed across the port rather than being Catalog's to choose.
 */
export const shopReservations = pgTable(
  'shop_reservations',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id')
      .notNull()
      .references(() => shopCarts.id, { onDelete: 'cascade' }),
    variantId: text('variant_id').notNull(),
    qty: integer('qty').notNull(),
    createdAt: epochMs('created_at').notNull(),
    expiresAt: epochMs('expires_at').notNull(),
    /** The arbiter of the sweeper-versus-capture race. Every transition is a
     * conditional `UPDATE … WHERE state = 'held'`, so exactly one side moves it
     * and exactly one side calls Catalog. */
    state: text('state').$type<'held' | 'released' | 'committed' | 'expired'>().notNull(),
  },
  (t) => [
    index('shop_reservations_cart_idx').on(t.cartId),
    check('shop_reservations_qty_ck', sql`${t.qty} > 0`),
    check(
      'shop_reservations_state_ck',
      sql`${t.state} IN ('held','released','committed','expired')`,
    ),
    // NOTE: `shop_reservations_sweep_idx` is PARTIAL (`WHERE state = 'held'`)
    // and drizzle-kit cannot express it. It lives only in migration 0120, and
    // `schema.test.ts` asserts it is applied.
  ],
);

// ----------------------------------------------------------------- addresses

/**
 * Snapshotted onto the order later; never mutated after conversion — enforced
 * by every write going through `updateCartFields`, which is guarded on
 * `status = 'open'`.
 */
export const shopAddresses = pgTable(
  'shop_addresses',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id')
      .notNull()
      .references(() => shopCarts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'shipping' | 'billing'>().notNull(),
    name: text('name').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    region: text('region'),
    postalCode: text('postal_code'),
    countryCode: text('country_code').notNull(),
    phone: text('phone'),
    /** `marketing_service_areas.key`, CHOSEN from the storefront's picker and
     *  never parsed from street text. Null = no district named = zone rate.
     *  Migration 0460 has the argument. */
    district: text('district'),
    /**
     * THE COURIER'S DELIVERY ZONE (migration 1020) — not a description of where
     * anybody lives, and never a replacement for `city`.
     *
     * Terminal validates `city` against its own per-country list and refuses
     * anything else with a 400 that kills the whole quote — ten place names
     * inside the FCT, and "Gwarinpa" is not one of them. So the shopper picks a
     * zone from the courier's own list (cached by migration 1000) and it lands
     * here, while `city` keeps the words they typed and the rider still reads
     * them. Only Terminal is told this value; Fez enforces no city list and its
     * free-text address is still built from `city`.
     *
     * NULL FALLS BACK TO `city`, which is exactly today's behaviour — and is
     * what every address written before this column has.
     */
    routingCity: text('routing_city'),
    /**
     * THE OPTIONAL PIN (migration 0780) — where the door actually is.
     *
     * MICRO-DEGREES AS `integer`, THE WAY MONEY IS MINOR UNITS. `numeric` reads
     * back as a string from both drivers and `double precision` makes 9.05785 a
     * value that no longer compares equal to itself across a round trip. Degrees
     * × 1e6 is exact, identical in Neon and PGlite, and resolves to about 11cm.
     * The WIRE is decimal degrees; `checkout/repo.ts` is the only file that
     * knows about the scale.
     *
     * IT PRICES NOTHING AND CANNOT. Nothing in this system holds coordinates to
     * measure it against — see the migration header.
     */
    locationLatE6: integer('location_lat_e6'),
    locationLngE6: integer('location_lng_e6'),
    /** Metres. Null for a `'pin'`, which has no accuracy figure to report. */
    locationAccuracyM: integer('location_accuracy_m'),
    locationSource: text('location_source').$type<'device' | 'pin'>(),
    locationCapturedAt: epochMs('location_captured_at'),
  },
  (t) => [
    uniqueIndex('shop_addresses_cart_kind_uq').on(t.cartId, t.kind),
    check('shop_addresses_kind_ck', sql`${t.kind} IN ('shipping','billing')`),
    // ISO-3166-1 alpha-2. The shipping zone and therefore the TAX RATE are
    // derived from this, so a lowercase or three-letter code would silently pick
    // the fallback zone and charge the wrong tax.
    check('shop_addresses_country_ck', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    /* ALL OR NOTHING, so half a pin cannot exist. `accuracy_m` is exempt inside
     * the present branch: a hand-dropped pin genuinely has none. */
    check(
      'shop_addresses_location_ck',
      sql`(${t.locationLatE6} IS NULL AND ${t.locationLngE6} IS NULL
           AND ${t.locationAccuracyM} IS NULL AND ${t.locationSource} IS NULL
           AND ${t.locationCapturedAt} IS NULL)
          OR (${t.locationLatE6} IS NOT NULL AND ${t.locationLngE6} IS NOT NULL
              AND ${t.locationSource} IS NOT NULL AND ${t.locationCapturedAt} IS NOT NULL)`,
    ),
    /* A swapped lat/lng is the classic mistake here and it is silent: bounding
     * latitude at 90 catches a longitude in the latitude slot for every point
     * outside the tropics. */
    check(
      'shop_addresses_location_lat_ck',
      sql`${t.locationLatE6} IS NULL OR ${t.locationLatE6} BETWEEN -90000000 AND 90000000`,
    ),
    check(
      'shop_addresses_location_lng_ck',
      sql`${t.locationLngE6} IS NULL OR ${t.locationLngE6} BETWEEN -180000000 AND 180000000`,
    ),
    check(
      'shop_addresses_location_accuracy_ck',
      sql`${t.locationAccuracyM} IS NULL OR ${t.locationAccuracyM} >= 0`,
    ),
    check(
      'shop_addresses_location_source_ck',
      sql`${t.locationSource} IS NULL OR ${t.locationSource} IN ('device', 'pin')`,
    ),
  ],
);

// -------------------------------------------------------- outbox consumption

/**
 * Idempotency for Cart's outbox consumer, keyed on `(consumer, event_id)` —
 * contract §6 rule 2, as a PRIMARY KEY rather than as a convention.
 *
 * SEPARATE FROM `shop_order_event_consumptions`, WHICH HAS THE IDENTICAL SHAPE.
 * That table is Orders' and R3 makes ownership exclusive, so Cart cannot use it.
 * The columns here are deliberately the same names so that merging the two into
 * one `commerce_event_consumptions` is a rename rather than a redesign —
 * amendment A-012.
 */
export const shopCartEventConsumptions = pgTable(
  'shop_cart_event_consumptions',
  {
    consumer: text('consumer').notNull(),
    eventId: text('event_id').notNull(),
    handledAt: epochMs('handled_at').notNull(),
    /** `parked` is still a candidate; `abandoned` needs a human, not a retry. */
    outcome: text('outcome')
      .$type<'parked' | 'applied' | 'ignored' | 'abandoned'>()
      .notNull(),
    /** PER CONSUMER. Two consumers incrementing `commerce_events.attempts` makes
     * it mean nothing to either of them. */
    attempts: integer('attempts').notNull().default(0),
    /** A field path or a short reason. NEVER a value. */
    detail: text('detail'),
  },
  (t) => [
    primaryKey({ name: 'shop_cart_event_consumptions_pk', columns: [t.consumer, t.eventId] }),
    index('shop_cart_event_consumptions_retry_idx').on(t.consumer, t.outcome),
    check(
      'shop_cart_event_consumptions_outcome_ck',
      sql`${t.outcome} IN ('parked','applied','ignored','abandoned')`,
    ),
    check('shop_cart_event_consumptions_attempts_ck', sql`${t.attempts} >= 0`),
  ],
);

export type DbShopCustomer = typeof shopCustomers.$inferSelect;
export type DbShopCart = typeof shopCarts.$inferSelect;
export type DbShopCartLine = typeof shopCartLines.$inferSelect;
export type DbShopReservation = typeof shopReservations.$inferSelect;
export type DbShopAddress = typeof shopAddresses.$inferSelect;
