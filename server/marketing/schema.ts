import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The marketing tables (rewards programs, the return lifecycle, the points
 * ledger, banners, discount codes), declared in a file this subsystem owns
 * exclusively rather than in `server/db/schema.ts`.
 *
 * WHY NOT IN `server/db/schema.ts`, WHERE THE BLOG'S OWN TABLES ARE.
 * `drizzle.config.ts` declares `schema: './server/db/schema.ts'` and nothing
 * else, so that file is the ONE input to `db:generate` — adding nine tables to it
 * means a generated migration and a new snapshot. On the day this was written
 * that file was carrying the concurrent shop session's uncommitted work, and two
 * writers in one drizzle-kit input is how `server/db/commerce-schema.ts` lost
 * Catalog's and Payments' blocks in a single afternoon. Declared here instead,
 * these tables are objects drizzle-kit cannot see at all, which is precisely what
 * makes `0011_marketing.sql` a LEGAL hand-written migration under the rule
 * `server/db/migrations.test.ts` states: a hand-written migration may only touch
 * objects drizzle-kit cannot model. `server/email/schema.ts` and
 * `server/shop/cart/schema.ts` reached the same arrangement from the same
 * problem.
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL, AND IT MUST NOT BECOME
 *     ONE. The tables exist because migration `0011_marketing.sql` created them.
 *     What this buys is `$inferSelect` types and one place to read the shape —
 *     and it is kept honest rather than decorative by
 *     `server/marketing/schema.test.ts`, which reads every column name back out
 *     of `information_schema` and fails if the two disagree.
 *
 *     Adding this path to `drizzle.config.ts` would make the next `db:generate`
 *     emit `CREATE TABLE marketing_programs` for a table that already exists. If
 *     it is ever done it has to be done together with a baseline snapshot.
 *
 * The two rules from `server/db/schema.ts` hold here and are not optional:
 * timestamps are `bigint` epoch-milliseconds and never `timestamptz`, and every
 * enum-ish column carries a `check()` because `.$type<>()` is compile-time only
 * and buys nothing at runtime.
 *
 * A third rule is this subsystem's own: cross-domain ids (`customer_id`,
 * `order_id`, `actor_id`) are plain `text` with NO `.references()`. They belong
 * to the shop and to `users`; marketing stores them and never joins on them.
 */

/** epoch-ms. `mode: 'number'` so a read is a number in both drivers. */
const epochMs = (name: string) => bigint(name, { mode: 'number' });

// ------------------------------------------------------------------- programs

/**
 * A rewards program — and every word the customer will read, as data.
 *
 * `key` IS THE ONLY STABLE HANDLE (spec D2a), and it is un-editable by
 * CONSTRUCTION rather than by discipline: the PATCH schema in
 * `programs/routes.ts` has no `key` field at all, so `.strict()` refuses one with
 * a 400. Everything else on this row — the name, both points labels, both unit
 * labels — is renameable on day one, which is why nothing anywhere may match on
 * them (`no-hardcoded-labels.test.ts` greps for exactly that).
 */
export const marketingPrograms = pgTable(
  'marketing_programs',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    kind: text('kind').$type<'unit_return' | 'adhoc'>().notNull(),
    name: text('name').notNull(),
    pointsLabelSingular: text('points_label_singular').notNull(),
    pointsLabelPlural: text('points_label_plural').notNull(),
    /** NULL for `adhoc`: points granted by hand count no units. */
    unitLabelSingular: text('unit_label_singular'),
    unitLabelPlural: text('unit_label_plural'),
    minUnitsPerReturn: integer('min_units_per_return'),
    pointsPerUnit: integer('points_per_unit'),
    status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
    /**
     * THE RESERVED EXTENSION POINT, deliberately empty in v1 — the zod schema
     * pins it to `{}`. A future condition (expiry, multipliers, tiered rates)
     * lands as a widened schema plus an interpreter and NO migration.
     */
    conditions: jsonb('conditions').$type<Record<string, never>>().notNull().default({}),
    /**
     * True ONLY for rows migration 0011 installed. The "Seeded preset" chip in
     * the UI derives from this and from nothing else: deriving it by matching the
     * preset's key or name is the one thing the naming discipline forbids.
     */
    seeded: boolean('seeded').notNull().default(false),
    /** CAS, same as `posts.revision`. `revision === 1` is also how the Overview
     * checklist recognises a preset nobody has reviewed yet. */
    revision: integer('revision').notNull().default(1),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    /** `ON DELETE SET NULL` in the migration: removing the account that created a
     * program must not remove the rules the business awards points under. */
    createdBy: uuid('created_by'),
  },
  (t) => [
    uniqueIndex('marketing_programs_key_uq').on(t.key),
    check(
      'marketing_programs_key_ck',
      sql`${t.key} <> '' AND ${t.key} = lower(${t.key}) AND ${t.key} ~ '^[a-z0-9][a-z0-9_-]*$'`,
    ),
    check('marketing_programs_kind_ck', sql`${t.kind} IN ('unit_return','adhoc')`),
    check('marketing_programs_name_ck', sql`${t.name} <> '' AND ${t.name} = btrim(${t.name})`),
    check(
      'marketing_programs_points_labels_ck',
      sql`${t.pointsLabelSingular} <> '' AND ${t.pointsLabelPlural} <> ''`,
    ),
    check(
      'marketing_programs_min_units_ck',
      sql`${t.minUnitsPerReturn} IS NULL OR ${t.minUnitsPerReturn} > 0`,
    ),
    check(
      'marketing_programs_points_per_unit_ck',
      sql`${t.pointsPerUnit} IS NULL OR ${t.pointsPerUnit} > 0`,
    ),
    /* A `unit_return` program with no rate is a program the inspect statement
     * cannot price; an `adhoc` program with a minimum is a rule nothing reads. */
    check(
      'marketing_programs_kind_fields_ck',
      sql`(${t.kind} = 'unit_return') = (${t.unitLabelSingular} IS NOT NULL
           AND ${t.unitLabelPlural} IS NOT NULL AND ${t.minUnitsPerReturn} IS NOT NULL
           AND ${t.pointsPerUnit} IS NOT NULL)`,
    ),
    check('marketing_programs_status_ck', sql`${t.status} IN ('active','paused')`),
    check('marketing_programs_revision_ck', sql`${t.revision} > 0`),
  ],
);

// ------------------------------------------------------------------- settings

/**
 * The cross-program layer, as a CHECK-pinned singleton (`id = 'main'`).
 *
 * Redemption economics are an INTEGER RATIONAL —
 * `redemptionRatePoints` points are worth `redemptionRateMinor` minor units —
 * converted through `shared/commerce/money.ts` `scale()`, never a float. And
 * `redemption_enabled` cannot be true while the money side is zero: the seed
 * ships disabled at a placeholder rate, so a forgotten review costs copy rather
 * than discounting every cart to nothing.
 */
export const marketingSettings = pgTable(
  'marketing_settings',
  {
    id: text('id').primaryKey(),
    pointsLabelSingular: text('points_label_singular').notNull(),
    pointsLabelPlural: text('points_label_plural').notNull(),
    redemptionEnabled: boolean('redemption_enabled').notNull().default(false),
    redemptionRatePoints: integer('redemption_rate_points').notNull(),
    redemptionRateMinor: integer('redemption_rate_minor').notNull(),
    redemptionCurrency: text('redemption_currency').notNull(),
    minRedeemPoints: integer('min_redeem_points').notNull().default(0),
    /** Basis points of a cart that points may pay for. 10000 = all of it. */
    maxRedeemBps: integer('max_redeem_bps').notNull().default(10000),
    /** `ON DELETE SET NULL` in the migration: a dangling pointer would be a 500
     * on every intake, while NULL is a state the route already answers with
     * `409 program_paused`. */
    defaultReturnProgramId: text('default_return_program_id'),
    revision: integer('revision').notNull().default(1),
    updatedAt: epochMs('updated_at').notNull(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('marketing_settings_id_ck', sql`${t.id} = 'main'`),
    check(
      'marketing_settings_points_labels_ck',
      sql`${t.pointsLabelSingular} <> '' AND ${t.pointsLabelPlural} <> ''`,
    ),
    /* Zero points-per-anything is a division by zero in `quote()`. */
    check('marketing_settings_rate_points_ck', sql`${t.redemptionRatePoints} > 0`),
    check('marketing_settings_rate_minor_ck', sql`${t.redemptionRateMinor} >= 0`),
    check(
      'marketing_settings_enabled_rate_ck',
      sql`NOT ${t.redemptionEnabled} OR ${t.redemptionRateMinor} > 0`,
    ),
    check('marketing_settings_currency_ck', sql`${t.redemptionCurrency} ~ '^[A-Z]{3}$'`),
    check('marketing_settings_min_redeem_ck', sql`${t.minRedeemPoints} >= 0`),
    check('marketing_settings_max_bps_ck', sql`${t.maxRedeemBps} BETWEEN 1 AND 10000`),
    check('marketing_settings_revision_ck', sql`${t.revision} > 0`),
  ],
);

// -------------------------------------------------------------- service areas

/**
 * A place a van goes — and the reason the rewards programme is honest about
 * where it works.
 *
 * A return comes back only because a driver fetches it, so the programme
 * operates where there are drivers. THE MODEL IS NATIONAL AND ONLY THE DATA IS
 * ONE CITY: an area is a name in a region with an active flag, every area
 * outside the served region ships INACTIVE, and expanding is an owner switching
 * rows on rather than a migration. Nothing in this file, the routes or the
 * screens may name the city that is served today — both grep guards fail on it,
 * because the served set is editable and anything that matched on the place
 * would be wrong the first time a district was switched off.
 *
 * `key` IS THE STABLE HANDLE AND `name` IS WHAT PEOPLE READ. The shipped dataset
 * has real errors in it, and the fix is a rename on the Areas screen rather than
 * an edit to a migration that has already run — so the name moves, the key does
 * not, and `seeded` keeps meaning "this row was not typed by a person" across
 * any number of renames.
 */
export const marketingServiceAreas = pgTable(
  'marketing_service_areas',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    /** The state. Areas are grouped by it on the Areas screen, and the switcher
     *  groups by it only when more than one region has a served area. */
    region: text('region').notNull(),
    name: text('name').notNull(),
    /**
     * Lowercase spellings a person might type — `wuse 2`, `cbd`. The resolver
     * folds case and punctuation out of `name` too, so this holds only the OTHER
     * spellings and never a second copy of the name.
     */
    aliases: text('aliases').array().notNull().default([]),
    /** OFF BY DEFAULT. The failure mode of a forgotten flag is then "we do not
     *  serve there" rather than "we promised a van we cannot send". */
    active: boolean('active').notNull().default(false),
    /** True only for rows migration 0012 installed. Renaming one keeps it true —
     *  it only ever meant "this row did not come from a person". */
    seeded: boolean('seeded').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('marketing_service_areas_key_uq').on(t.key),
    index('marketing_service_areas_region_idx').on(t.region, t.active, t.sortOrder),
    check(
      'marketing_service_areas_key_ck',
      sql`${t.key} <> '' AND ${t.key} = lower(${t.key}) AND ${t.key} ~ '^[a-z0-9][a-z0-9_-]*$'`,
    ),
    check(
      'marketing_service_areas_region_ck',
      sql`${t.region} <> '' AND ${t.region} = btrim(${t.region})`,
    ),
    check('marketing_service_areas_name_ck', sql`${t.name} <> '' AND ${t.name} = btrim(${t.name})`),
    /* The array's own text form, because a CHECK may not contain a subquery and
     * `unnest` in one is a subquery. An element with a capital in it is the only
     * way the rendered literal can differ from its own `lower()`. */
    check(
      'marketing_service_areas_aliases_ck',
      sql`${t.aliases}::text = lower(${t.aliases}::text)
          AND array_position(${t.aliases}, '') IS NULL
          AND array_position(${t.aliases}, NULL) IS NULL`,
    ),
    check('marketing_service_areas_sort_order_ck', sql`${t.sortOrder} >= 0`),
    check('marketing_service_areas_revision_ck', sql`${t.revision} > 0`),
    /*
     * NOTE: `marketing_service_areas_region_name_uq` — UNIQUE over
     * `(region, lower(name))` — is an EXPRESSION index, which drizzle-kit cannot
     * model any more than it can a partial one. It lives only in migration 0012,
     * and `schema.test.ts` asserts the REFUSAL rather than the name: an index
     * that exists without the `lower()` would let one region hold "Utako" and
     * "utako" as two boards.
     */
  ],
);

// ------------------------------------------------------------ return requests

/**
 * The row the whole lifecycle moves through.
 *
 * `pointsPerUnitSnapshot` IS COPIED AT CREATION AND NEVER RE-READ THROUGH THE FK.
 * A customer told "ten a unit" on Monday is awarded ten a unit on Friday even if
 * the shop repriced on Wednesday; repricing mid-flight is done by cancelling and
 * recreating, and the timeline records both halves.
 *
 * There is deliberately NO `accepted + rejected = declared` constraint: the
 * customer says six, the driver comes back with five, and a database that refuses
 * to record that forces staff to lie to it. What IS pinned is the money —
 * `marketing_return_requests_award_ck`.
 */
export const marketingReturnRequests = pgTable(
  'marketing_return_requests',
  {
    id: text('id').primaryKey(),
    programId: text('program_id').notNull(),
    /** The shop's id when there is one. Guest checkout is the default path, so
     * `customerEmail` is what everything actually keys on. No FK — it is another
     * subsystem's id (spec D10). */
    customerId: text('customer_id'),
    customerEmail: text('customer_email').notNull(),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    pickupAddress: text('pickup_address'),
    /**
     * WHICH BOARD THIS RETURN IS ON. NULL means out of area — a legal state (a
     * phone-in from out of town) and an unrewardable one.
     *
     * A REAL FOREIGN KEY, unlike `customerId` two lines up: that is the shop's
     * id and this is marketing's own row in marketing's own table, which the
     * switcher's counts join against on every read. Declared in migration 0012
     * with no `ON DELETE`, so an area that has ever held a return cannot be
     * deleted — switching it off is the retirement.
     */
    serviceAreaId: text('service_area_id'),
    qtyDeclared: integer('qty_declared').notNull(),
    qtyAccepted: integer('qty_accepted'),
    qtyRejected: integer('qty_rejected'),
    pointsPerUnitSnapshot: integer('points_per_unit_snapshot').notNull(),
    pointsAwarded: integer('points_awarded'),
    rejectedReason: text('rejected_reason'),
    cancelReason: text('cancel_reason'),
    source: text('source').$type<'customer' | 'admin'>().notNull(),
    status: text('status')
      .$type<
        'requested' | 'scheduled' | 'collected' | 'received' | 'awarded' | 'rejected' | 'cancelled'
      >()
      .notNull()
      .default('requested'),
    pickupScheduledAt: epochMs('pickup_scheduled_at'),
    driverName: text('driver_name'),
    driverPhone: text('driver_phone'),
    scheduledAt: epochMs('scheduled_at'),
    collectedAt: epochMs('collected_at'),
    receivedAt: epochMs('received_at'),
    closedAt: epochMs('closed_at'),
    revision: integer('revision').notNull().default(1),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    index('marketing_return_requests_keyset_idx').on(
      t.status,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    check(
      'marketing_return_requests_email_ck',
      sql`${t.customerEmail} <> '' AND ${t.customerEmail} = lower(${t.customerEmail})`,
    ),
    check('marketing_return_requests_qty_declared_ck', sql`${t.qtyDeclared} > 0`),
    check(
      'marketing_return_requests_qty_counts_ck',
      sql`(${t.qtyAccepted} IS NULL OR ${t.qtyAccepted} >= 0)
          AND (${t.qtyRejected} IS NULL OR ${t.qtyRejected} >= 0)`,
    ),
    check('marketing_return_requests_points_snapshot_ck', sql`${t.pointsPerUnitSnapshot} > 0`),
    check(
      'marketing_return_requests_points_awarded_ck',
      sql`${t.pointsAwarded} IS NULL OR ${t.pointsAwarded} >= 0`,
    ),
    check('marketing_return_requests_source_ck', sql`${t.source} IN ('customer','admin')`),
    check(
      'marketing_return_requests_status_ck',
      sql`${t.status} IN ('requested','scheduled','collected','received',
                          'awarded','rejected','cancelled')`,
    ),
    /* The award arithmetic, in the database — so an edit to the inspect statement
     * cannot pay a number nobody can reconstruct from the row. */
    check(
      'marketing_return_requests_award_ck',
      sql`${t.status} <> 'awarded'
          OR (${t.qtyAccepted} >= 1 AND ${t.qtyRejected} IS NOT NULL
              AND ${t.pointsAwarded} = ${t.qtyAccepted} * ${t.pointsPerUnitSnapshot})`,
    ),
    /*
     * THE SERVICE-AREA GATE'S TEETH (migration 0012). Every other layer that
     * keeps an unserved address from earning is code — the picker, the intake
     * route's 409, a board with nowhere to put it — and code is edited. This is
     * what makes "outside the served set cannot earn" true with all of them
     * deleted. It does not block `rejected` or `cancelled`: an out-of-area
     * return must still be closable, with a reason.
     */
    check(
      'marketing_return_requests_area_award_ck',
      sql`${t.status} <> 'awarded' OR ${t.serviceAreaId} IS NOT NULL`,
    ),
    check('marketing_return_requests_revision_ck', sql`${t.revision} > 0`),
    /* NOTE: `marketing_return_requests_area_idx` — `(service_area_id, status,
     * created_at DESC, id DESC)`, the board's read — is in migration 0012. */
    /*
     * NOTE: `marketing_return_requests_open_uq` — UNIQUE `(customer_email)`
     * WHERE the status is one of the four live ones — is PARTIAL, and drizzle-kit
     * cannot express the predicate any more than it can express
     * `shop_reservations_sweep_idx`'s. It lives only in migration 0011, and
     * `schema.test.ts` asserts both that it is applied and that a second open
     * return is actually refused: an index that exists but is not partial would
     * pass a name check and forbid a customer from ever returning twice.
     */
  ],
);

// ------------------------------------------------------------ timeline events

/**
 * Append-only history. `data` carries the `inspected` event's counts AND the four
 * label values as they read at that instant, so a rename changes the future and
 * never the history (spec D2d).
 */
export const marketingReturnEvents = pgTable(
  'marketing_return_events',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    type: text('type')
      .$type<
        | 'requested'
        | 'scheduled'
        | 'collected'
        | 'received'
        | 'inspected'
        | 'rejected'
        | 'cancelled'
        | 'note'
      >()
      .notNull(),
    actorType: text('actor_type').$type<'admin' | 'customer' | 'system'>().notNull(),
    /** TEXT, no FK to `users` — the same choice `shop_order_events` made: an FK
     * would make a return's history unwritable the day an account is removed. */
    actorId: text('actor_id'),
    note: text('note'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    occurredAt: epochMs('occurred_at').notNull(),
  },
  (t) => [
    index('marketing_return_events_request_idx').on(t.requestId, t.occurredAt, t.id),
    check(
      'marketing_return_events_type_ck',
      sql`${t.type} IN ('requested','scheduled','collected','received',
                        'inspected','rejected','cancelled','note')`,
    ),
    check(
      'marketing_return_events_actor_ck',
      sql`${t.actorType} IN ('admin','customer','system')`,
    ),
  ],
);

// --------------------------------------------------------------------- ledger

/**
 * Append-only, and the only explanation of any balance.
 *
 * `balanceAfter` is recorded on every row because the statement that writes it
 * already knows it — the balance CTE returns the new value and the ledger INSERT
 * selects from that CTE. Without it, rendering "120 → 180" needs a window
 * function over a customer's whole history on every page.
 *
 * `reason` IS RENDER-FINAL AT WRITE TIME, never a template resolved later: the
 * words a customer is shown for a March award must still read as they did in
 * March after the shop renames the programme in June.
 *
 * IT IS NULLABLE SINCE MIGRATION 0840 (owner's instruction, 2026-09-03): a
 * manual adjustment may be saved with nothing typed. The CHECK below stays and
 * still refuses the empty string, so blank has exactly one spelling.
 */
export const marketingLedger = pgTable(
  'marketing_ledger',
  {
    id: text('id').primaryKey(),
    customerEmail: text('customer_email').notNull(),
    customerId: text('customer_id'),
    /** Nullable — a manual adjustment belongs to no program. */
    programId: text('program_id'),
    kind: text('kind')
      .$type<'return_award' | 'manual' | 'redemption' | 'redemption_release'>()
      .notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason'),
    returnRequestId: text('return_request_id'),
    /** The shop's order id. TEXT, no FK. */
    orderId: text('order_id'),
    actorType: text('actor_type').$type<'admin' | 'customer' | 'system'>().notNull(),
    actorId: text('actor_id'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    index('marketing_ledger_customer_idx').on(
      t.customerEmail,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    check(
      'marketing_ledger_email_ck',
      sql`${t.customerEmail} <> '' AND ${t.customerEmail} = lower(${t.customerEmail})`,
    ),
    check(
      'marketing_ledger_kind_ck',
      sql`${t.kind} IN ('return_award','manual','redemption','redemption_release')`,
    ),
    check('marketing_ledger_delta_ck', sql`${t.delta} <> 0`),
    check('marketing_ledger_balance_after_ck', sql`${t.balanceAfter} >= 0`),
    check('marketing_ledger_reason_ck', sql`${t.reason} <> ''`),
    check('marketing_ledger_actor_ck', sql`${t.actorType} IN ('admin','customer','system')`),
    /* Each kind, coupled to the columns that make it auditable. */
    /*
     * AN IMPLICATION, NOT AN EQUALITY — relaxed by migration 0012 so the
     * inspection's optional bonus can be a `manual` row that says WHICH return
     * earned it. The half that mattered is kept: an award still cannot exist
     * without a return. The bonus is a second row rather than a bigger award
     * because `marketing_return_requests_award_ck` pins the award to exactly
     * quantity times rate, and that equality is what makes the arithmetic
     * unforgeable.
     */
    check(
      'marketing_ledger_award_link_ck',
      sql`${t.kind} <> 'return_award' OR ${t.returnRequestId} IS NOT NULL`,
    ),
    check(
      'marketing_ledger_order_link_ck',
      sql`${t.kind} NOT IN ('redemption','redemption_release') OR ${t.orderId} IS NOT NULL`,
    ),
    check(
      'marketing_ledger_award_sign_ck',
      sql`${t.kind} <> 'return_award' OR (${t.delta} > 0 AND ${t.programId} IS NOT NULL)`,
    ),
    check('marketing_ledger_redemption_sign_ck', sql`${t.kind} <> 'redemption' OR ${t.delta} < 0`),
    check(
      'marketing_ledger_release_sign_ck',
      sql`${t.kind} <> 'redemption_release' OR ${t.delta} > 0`,
    ),
    /*
     * NOTE: the three IDEMPOTENCY indexes — `marketing_ledger_award_uq`
     * (`WHERE kind = 'return_award'`), `marketing_ledger_redemption_uq` and
     * `marketing_ledger_release_uq` (both `WHERE kind = …` over `order_id`) — are
     * PARTIAL and live only in migration 0011. They are the reason awarding one
     * return twice is a 23505 with every application guard deleted, so
     * `schema.test.ts` asserts the refusal itself and not merely the names.
     *
     * `marketing_ledger_bonus_uq` — `(return_request_id) WHERE kind = 'manual'
     * AND return_request_id IS NOT NULL` — is the fourth, added by 0012. A bonus
     * is money minted by hand, which is if anything the more attractive thing to
     * replay, so it gets the same structural refusal an award has.
     */
  ],
);

// ------------------------------------------------------------------- balances

/**
 * The O(1) counter, maintained in the SAME statement as every ledger insert.
 *
 * `SUM(delta)` would be correct, would get slower forever, and — the half that
 * matters — cannot be made safe against concurrent debits. The debit is
 * `UPDATE … SET balance = balance - $x WHERE customer_email = $e AND balance >= $x`
 * with the ledger INSERT selecting FROM that CTE, so the loser of a race updates
 * zero rows and inserts nothing. `CHECK (balance >= 0)` is the backstop that
 * makes a future debit written without that predicate fail loudly.
 *
 * `lifetimeEarned` counts credits only and is not derivable from `balance`: a
 * customer who earned 500 and spent 500 must read as loyal, not as a stranger.
 */
export const marketingBalances = pgTable(
  'marketing_balances',
  {
    customerEmail: text('customer_email').primaryKey(),
    customerId: text('customer_id'),
    balance: integer('balance').notNull(),
    lifetimeEarned: integer('lifetime_earned').notNull().default(0),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    check(
      'marketing_balances_email_ck',
      sql`${t.customerEmail} <> '' AND ${t.customerEmail} = lower(${t.customerEmail})`,
    ),
    check('marketing_balances_balance_ck', sql`${t.balance} >= 0`),
    check('marketing_balances_lifetime_ck', sql`${t.lifetimeEarned} >= 0`),
  ],
);

// --------------------------------------------------------------- email intents

/**
 * The notification outbox, copied end to end from `shop_order_email_intents`.
 *
 * The intent is written in the SAME statement as the transition that owes it, and
 * delivery happens later from a sweeper: an inspection that genuinely happened
 * must not be rolled back because a mail provider was down, and warehouse staff
 * must not wait on SMTP with a customer in front of them.
 *
 * `subject`/`text`/`html` are PRE-RENDERED from the labels as they read at that
 * instant — the same snapshot rule `email_broadcasts` follows, because the
 * recipient keeps the message forever.
 */
export const marketingEmailIntents = pgTable(
  'marketing_email_intents',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<'return_awarded' | 'return_rejected'>().notNull(),
    returnRequestId: text('return_request_id').notNull(),
    /** `'<kind>:<request_id>'`. The insert is `ON CONFLICT DO NOTHING`, so this
     * is what turns a replayed inspect into a no-op rather than a second mail. */
    dedupeKey: text('dedupe_key').notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    /** A legal column name, used verbatim so the API field, the TypeScript field
     * and the column are one word in all three places — `email_templates` made
     * the same call. Quoted in the migration's CHECK, where it reads as a type. */
    text: text('text').notNull(),
    html: text('html').notNull(),
    /** The CAS column. Two sweeps both read `attempts = n`, both try
     * `SET attempts = n + 1 WHERE attempts = n`, and exactly one matches. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: epochMs('sent_at'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('marketing_email_intents_dedupe_uq').on(t.dedupeKey),
    check('marketing_email_intents_kind_ck', sql`${t.kind} IN ('return_awarded','return_rejected')`),
    check(
      'marketing_email_intents_bodies_ck',
      sql`${t.toEmail} <> '' AND ${t.subject} <> '' AND ${t.text} <> '' AND ${t.html} <> ''`,
    ),
    check('marketing_email_intents_attempts_ck', sql`${t.attempts} >= 0`),
    /*
     * NOTE: `marketing_email_intents_pending_idx` is PARTIAL
     * (`WHERE sent_at IS NULL`) and drizzle-kit cannot express it, exactly like
     * `email_broadcast_recipients_drain_idx`. It lives only in migration 0011 —
     * after a year of awards the unsent rows are a vanishing fraction, and a full
     * index would carry every delivered row forever for a predicate that never
     * selects one.
     */
  ],
);

// -------------------------------------------------------------------- banners

/**
 * The only thing in this subsystem the public internet reads.
 *
 * Scheduling is a WHERE CLAUSE AT READ TIME, not a job — both Hobby cron slots
 * are already spent, and a banner has to start and stop on the second it was told
 * to. `shared/marketing/banners.ts#deriveBannerStatus` is the client-side twin of
 * that predicate, and a parity test feeds both the same fixtures.
 *
 * There is NO delete: `archived` is the third status, because a banner that ran is
 * a record of what the shop said in public.
 */
export const marketingBanners = pgTable(
  'marketing_banners',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    ctaText: text('cta_text'),
    ctaUrl: text('cta_url'),
    placement: text('placement').$type<'top_bar' | 'popup' | 'section'>().notNull(),
    status: text('status').$type<'draft' | 'live' | 'archived'>().notNull().default('draft'),
    startsAt: epochMs('starts_at'),
    endsAt: epochMs('ends_at'),
    priority: integer('priority').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    index('marketing_banners_live_idx').on(t.status, t.placement, t.priority.desc()),
    check('marketing_banners_title_ck', sql`${t.title} <> '' AND ${t.title} = btrim(${t.title})`),
    /* A SECURITY constraint, not tidiness: this table is served by a cookieless
     * public endpoint and rendered on the storefront, so a `javascript:`
     * destination here is stored XSS with a publish button in front of it. */
    check(
      'marketing_banners_cta_url_ck',
      sql`${t.ctaUrl} IS NULL OR ${t.ctaUrl} ~ '^(https?://|/)'`,
    ),
    check(
      'marketing_banners_cta_pair_ck',
      sql`(${t.ctaText} IS NULL) = (${t.ctaUrl} IS NULL)`,
    ),
    check('marketing_banners_placement_ck', sql`${t.placement} IN ('top_bar','popup','section')`),
    check('marketing_banners_status_ck', sql`${t.status} IN ('draft','live','archived')`),
    /* An inverted window can never satisfy the read-time predicate, and a banner
     * that can never show looks exactly like one that has not started yet. */
    check(
      'marketing_banners_window_ck',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
    check('marketing_banners_revision_ck', sql`${t.revision} > 0`),
  ],
);

// ------------------------------------------------------------ discount codes

/**
 * The MODEL, ahead of the surface that will redeem it. v1 ships CRUD and nothing
 * else — `computeTotals` never sees these rows yet, and the Discounts screen is
 * an honest placeholder. The table exists now because the shape is knowable now
 * and because adding columns to a table with rows in it is a migration.
 */
export const marketingDiscountCodes = pgTable(
  'marketing_discount_codes',
  {
    id: text('id').primaryKey(),
    /** Uppercase at rest, uppercased by the route before validation. 'SUMMER'
     * and 'summer' as two rows is a customer typing one and being told it does
     * not exist. */
    code: text('code').notNull(),
    kind: text('kind').$type<'percent' | 'fixed_amount'>().notNull(),
    percentBps: integer('percent_bps'),
    amountMinor: integer('amount_minor'),
    currency: text('currency'),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    startsAt: epochMs('starts_at'),
    endsAt: epochMs('ends_at'),
    maxRedemptions: integer('max_redemptions'),
    redeemedCount: integer('redeemed_count').notNull().default(0),
    note: text('note'),
    revision: integer('revision').notNull().default(1),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    createdBy: uuid('created_by'),
  },
  (t) => [
    uniqueIndex('marketing_discount_codes_code_uq').on(t.code),
    check(
      'marketing_discount_codes_code_ck',
      sql`${t.code} = upper(${t.code}) AND ${t.code} ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'`,
    ),
    check('marketing_discount_codes_kind_ck', sql`${t.kind} IN ('percent','fixed_amount')`),
    check(
      'marketing_discount_codes_percent_ck',
      sql`${t.percentBps} IS NULL OR ${t.percentBps} BETWEEN 1 AND 10000`,
    ),
    check(
      'marketing_discount_codes_amount_ck',
      sql`${t.amountMinor} IS NULL OR ${t.amountMinor} > 0`,
    ),
    check(
      'marketing_discount_codes_currency_ck',
      sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
    /* Each kind is priced from its own columns and only its own: a percent
     * discount carrying an amount is two answers to "how much off". */
    check(
      'marketing_discount_codes_kind_fields_ck',
      sql`((${t.kind} = 'percent') = (${t.percentBps} IS NOT NULL))
          AND ((${t.kind} = 'fixed_amount') = (${t.amountMinor} IS NOT NULL
                                               AND ${t.currency} IS NOT NULL))`,
    ),
    check('marketing_discount_codes_status_ck', sql`${t.status} IN ('active','disabled')`),
    check(
      'marketing_discount_codes_window_ck',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
    check(
      'marketing_discount_codes_max_redemptions_ck',
      sql`${t.maxRedemptions} IS NULL OR ${t.maxRedemptions} > 0`,
    ),
    check('marketing_discount_codes_redeemed_count_ck', sql`${t.redeemedCount} >= 0`),
    check('marketing_discount_codes_revision_ck', sql`${t.revision} > 0`),
  ],
);

export type DbMarketingServiceArea = typeof marketingServiceAreas.$inferSelect;
export type DbMarketingProgram = typeof marketingPrograms.$inferSelect;
export type DbMarketingSettings = typeof marketingSettings.$inferSelect;
export type DbMarketingReturnRequest = typeof marketingReturnRequests.$inferSelect;
export type DbMarketingReturnEvent = typeof marketingReturnEvents.$inferSelect;
export type DbMarketingLedgerEntry = typeof marketingLedger.$inferSelect;
export type DbMarketingBalance = typeof marketingBalances.$inferSelect;
export type DbMarketingEmailIntent = typeof marketingEmailIntents.$inferSelect;
export type DbMarketingBanner = typeof marketingBanners.$inferSelect;
export type DbMarketingDiscountCode = typeof marketingDiscountCodes.$inferSelect;
