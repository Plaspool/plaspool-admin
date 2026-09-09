import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '../../db/schema';
import { PAYMENT_STATUSES } from '../../../shared/commerce/ports';

/**
 * The Payments tables (contract §4, `03-payments.md` §3).
 *
 * DECLARED HERE, IN A FILE PAYMENTS OWNS EXCLUSIVELY, AND RE-EXPORTED FROM
 * `server/db/commerce-schema.ts`. Contract §4 says the commerce tables are
 * declared in that shared file, "which is append-only and shared: each agent
 * appends its own block and edits no other block." Append-only is a convention
 * with no mechanism behind it, and it did not hold: the file was overwritten
 * wholesale during a single afternoon and this subsystem's block was lost with
 * Cart's. Catalog reached the same conclusion independently and the same fix is
 * used here (their amendment A-CAT-009).
 *
 * §4's actual purpose survives intact — every commerce table is still reachable
 * from one import path — and the shared surface is now one `export *` line,
 * which a clobber costs one line to restore and which `tsc` names immediately
 * rather than losing quietly.
 *
 * THE DDL THAT ACTUALLY BUILDS THESE TABLES IS `migrations/0140_payments.sql`,
 * hand-written for the reasons stated in its header. Nothing in
 * `server/shop/payments/` imports the objects below: every statement in this
 * subsystem is raw parameterised SQL through `db.execute`, the same shape
 * `server/repo/posts.ts` uses for the CAS write path, because the guards that
 * matter here — a rank comparison, a sum-check inside an UPDATE's WHERE, a
 * chain of data-modifying CTEs — are not expressible in the query builder.
 * These declarations are the typed description of the schema and the home of
 * its documentation.
 *
 * Two rules carried over from `schema.ts` and not optional (contract §4):
 * timestamps are `bigint` epoch-milliseconds, never `timestamptz`; and every
 * enum-ish column carries a `check()`, because `.$type<>()` is compile-time
 * only and buys nothing against a bug that writes `status = 'paid'`.
 */

/** `'a', 'b', 'c'` — a SQL string list from a TS constant, so the two cannot drift. */
function sqlLiterals(values: readonly string[]) {
  return sql.join(
    values.map((v) => sql.raw(`'${v}'`)),
    sql`, `,
  );
}

/**
 * THE GATEWAY NAMES, and this is the one definition of them.
 *
 * On the wire and in the database, so §7's copy rules do not apply: these are
 * contract, not display strings. The screen may say "Flutterwave"; the column
 * says `flutterwave` and must keep doing so.
 */
export const PROVIDER_NAMES = ['paystack', 'flutterwave'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const shopPaymentIntents = pgTable(
  'shop_payment_intents',
  {
    /** `pi_…` (contract §10). */
    id: text('id').primaryKey(),
    /**
     * From Cart. NOT AN FK, by contract §2 R3: `shop_carts` is Cart's table and
     * a foreign key would be Payments reading it. It is also what lets the two
     * subsystems be migrated and deployed independently.
     */
    checkoutId: text('checkout_id').notNull(),
    /**
     * The reference the provider transacts under. UNIQUE, nullable.
     *
     * Nullable because a provider that mints its own identifier has none until
     * it has answered. Paystack is the other shape — the `reference` is ours and
     * is derived from the intent id — so under Paystack this is populated at
     * creation. The nullability is what keeps a second provider from being a
     * migration.
     */
    providerIntentId: text('provider_intent_id').unique(),
    /**
     * MINOR UNITS, FROZEN, NEVER RECOMPUTED (`03-payments.md` §1).
     *
     * It arrives once from `CheckoutPort.totals()` and is the only figure ever
     * charged. The rest of this application happily re-derives excerpts and word
     * counts from current state; a capture that re-derived its amount is a
     * capture that can charge a figure the customer never saw.
     */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<(typeof PAYMENT_STATUSES)[number]>().notNull(),
    /**
     * WHICH GATEWAY TOOK THIS PAYMENT. Set once, at creation, and never
     * rewritten — flipping the admin switch must not re-route money that has
     * already moved.
     *
     * The default is added here and dropped in a later task, once every INSERT
     * names the column. It backfills the existing rows, all Paystack. Dropping it
     * before the code names the column is a 23502, which hides the intent rather
     * than showing it: an INSERT that forgets the column now fails loudly.
     */
    provider: text('provider').$type<ProviderName>().notNull(),
    /**
     * The gateway's OWN id, when it differs from the reference we supply.
     * NULL for Paystack, which transacts under ours. Flutterwave needs it for
     * refunds and mints it at charge time, so it arrives later than the row.
     */
    providerChargeId: text('provider_charge_id'),
    /**
     * The caller's key. UNIQUE — this column IS the idempotency mechanism.
     *
     * A JS "have I already charged this" check on a prior read is the defect
     * Part 2b found across six lifecycle transitions: evaluated against a
     * snapshot a concurrent request has already invalidated. A unique index is
     * evaluated by the database at write time, and the loser is told so.
     */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /**
     * A digest of the request this key was first used for.
     *
     * Idempotency returns the FIRST call's result, which is only safe while the
     * second call asks the same question. A key reused with a different amount
     * is a caller bug, and answering it with the old intent would hand back an
     * authorization URL for one figure while the caller believes another.
     */
    requestFingerprint: text('request_fingerprint').notNull(),
    /** Where to send the customer. Not a secret — a one-shot checkout URL. */
    authorizationUrl: text('authorization_url'),
    /**
     * Sum of refunds against this intent that have NOT FAILED — a RESERVATION,
     * incremented in the same statement that inserts a refund and decremented
     * when one fails.
     *
     * NOT DERIVED BY `SUM()` AT READ TIME, and that difference is the whole
     * sum-check. Two concurrent partial refunds that each read a total of 0 and
     * each pass a JS check will both insert, and together exceed the capture.
     * As a column, the guard becomes `refunded_total + $new <= amount` inside an
     * UPDATE's own WHERE, which Postgres re-evaluates against the winner's
     * committed row before the loser proceeds.
     */
    refundedTotal: integer('refunded_total').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /**
     * A SCRUBBED, ENUMERATED failure code — never a provider message.
     *
     * GAUNTLET II Part 1 Round 1 found an error whose `message` and `stack`
     * carried a live password hash, and Round 2 found the fix was one method
     * wide. Provider prose can quote the input that caused it; this column holds
     * only what `scrubProviderError` produced.
     */
    lastError: text('last_error'),
    /** The CAS token. Monotonic per intent. */
    revision: integer('revision').notNull(),
  },
  (t) => [
    check('shop_payment_intents_status_ck', sql`${t.status} IN (${sqlLiterals(PAYMENT_STATUSES)})`),
    check('shop_payment_intents_provider_ck', sql`${t.provider} IN ('paystack', 'flutterwave')`),
    check('shop_payment_intents_revision_ck', sql`${t.revision} > 0`),
    /** A charge of nothing is not a charge; negative would be a credit. */
    check('shop_payment_intents_amount_ck', sql`${t.amount} > 0`),
    /**
     * THE REFUND INVARIANT, held by the database rather than by the statement
     * that usually maintains it — so it is true of an import, a backfill and SQL
     * run by hand at 2am, none of which go through `refunds.ts`.
     */
    check(
      'shop_payment_intents_refunded_total_ck',
      sql`${t.refundedTotal} >= 0 AND ${t.refundedTotal} <= ${t.amount}`,
    ),
    index('shop_payment_intents_checkout_idx').on(t.checkoutId),
    index('shop_payment_intents_status_idx').on(t.status),
  ],
);

/**
 * THE RAW PROVIDER LOG. APPEND-ONLY; nothing ever deletes from it.
 *
 * The only artefact that can answer "what did the provider actually tell us,
 * and when" during a dispute, so it stores the VERIFIED RAW PAYLOAD rather than
 * our parse of it. A parse is a belief; the payload is evidence.
 */
export const shopPaymentEvents = pgTable(
  'shop_payment_events',
  {
    /** `pev_…`. */
    id: text('id').primaryKey(),
    /**
     * WHICH GATEWAY sent this event. Two gateways will eventually deliver to
     * two different webhook endpoints, so this is known the instant the event
     * is verified and stored — never inferred from the payload.
     */
    provider: text('provider').$type<ProviderName>().notNull(),
    /**
     * THE DEDUPE KEY — a UNIQUE constraint, never a prior read.
     *
     * Paystack redelivers a non-200 every 3 minutes for four attempts and then
     * hourly for 72 hours, so the same event arrives repeatedly and sometimes
     * concurrently. Its envelope is `{ event, data }` with NO event id and no
     * event-id header, so this value is DERIVED — see `providerEventIdOf` in
     * `provider/paystack.ts` for how, and why a raw-body digest is the fallback
     * rather than the primary.
     */
    providerEventId: text('provider_event_id').notNull().unique(),
    /**
     * Resolved if we can, NULL if not — and DELIBERATELY NOT A FOREIGN KEY.
     *
     * The row must be stored the instant the signature verifies. An FK would
     * make an unresolvable-but-verified event a failed INSERT, i.e. the one case
     * where the evidence matters most is the case where we discard it and answer
     * the provider with a 500 it retries for 72 hours.
     */
    intentId: text('intent_id'),
    type: text('type').notNull(),
    /** The verified raw body, as received. */
    payload: jsonb('payload').notNull(),
    receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
    processedAt: bigint('processed_at', { mode: 'number' }),
    lastError: text('last_error'),
    /**
     * NOT AN ERROR — a note that the event was applied out of order, or arrived
     * after a later one had already moved the intent past it, or was a type we
     * deliberately ignore.
     *
     * Separate from `lastError` because a drain must retry the second and must
     * not retry the first. `captured` arriving for an intent we had already
     * marked `cancelled` is the case that matters: the money is real, the
     * cancellation was ours, and nothing about that is a failure to process.
     */
    anomaly: text('anomaly'),
  },
  (t) => [
    check('shop_payment_events_provider_ck', sql`${t.provider} IN ('paystack', 'flutterwave')`),
    index('shop_payment_events_intent_idx').on(t.intentId),
    index('shop_payment_events_pending_idx').on(t.processedAt, t.receivedAt),
  ],
);

export const shopRefunds = pgTable(
  'shop_refunds',
  {
    /** `rfd_…`. */
    id: text('id').primaryKey(),
    intentId: text('intent_id')
      .notNull()
      .references(() => shopPaymentIntents.id),
    /** Positive minor units. A refund is not a negative charge (`03` §6). */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    reason: text('reason'),
    providerRefundId: text('provider_refund_id'),
    /**
     * UNIQUE, AND CLAIMED BEFORE THE PROVIDER IS CALLED.
     *
     * Paystack's `POST /refund` has no idempotency key of its own: calling it
     * twice creates two refunds and pays the customer twice. So the row is
     * inserted first — winning the unique index is what earns the right to make
     * the call — and a retry loses the insert and read-throughs to the first
     * refund. This ordering is the whole protection, and reversing it
     * reintroduces double-refunds silently.
     */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /**
     * Three states, mapped down from the provider's four. Paystack reports
     * `pending`/`processing`/`processed`/`failed`; the middle two are the same
     * fact to this system — money committed, not yet confirmed gone.
     */
    status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /** Admin-initiated only in v1 (contract §13): an owner, never a customer. */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    check('shop_refunds_status_ck', sql`${t.status} IN ('pending', 'succeeded', 'failed')`),
    check('shop_refunds_amount_ck', sql`${t.amount} > 0`),
    index('shop_refunds_intent_idx').on(t.intentId),
    /**
     * PARTIAL UNIQUE, the same shape as `posts.slug` and for the same reason: a
     * plain UNIQUE cannot hold many rows sharing "not assigned yet", but
     * Postgres permits many NULLs — and every refund is NULL here until the
     * provider has answered.
     */
    uniqueIndex('shop_refunds_provider_refund_uq')
      .on(t.providerRefundId)
      .where(sql`${t.providerRefundId} IS NOT NULL`),
  ],
);

/**
 * WHICH GATEWAY TAKES A PAYMENT — one row, `id = 'main'` (migration 1100).
 *
 * A CHECK-CONSTRAINED SINGLETON rather than one row by convention, following
 * `shop_delivery_settings`: "there is exactly one configuration" becomes
 * something the database enforces, so a second row cannot appear and leave two
 * answers to "who takes the money" for whichever sorted first.
 *
 * TWO CURRENCY LISTS EXIST IN THIS SYSTEM AND THESE ARE THE OTHER ONES.
 * `ProviderCapabilities.currencies` in the adapter is what a gateway's API
 * CAN charge. These columns are what each account has SWITCHED ON. Routing
 * reads these. The split exists because a capability list in code would lie:
 * Paystack's USD is not enabled on this account, so a hardcoded ['NGN','USD']
 * would route a dollar charge to a gateway that refuses it.
 */
export const shopPaymentSettings = pgTable(
  'shop_payment_settings',
  {
    /** Pinned to `'main'` by a CHECK. */
    id: text('id').primaryKey(),
    /** The gateway everyone gets, unless a rule below overrides it. */
    activeProvider: text('active_provider').$type<ProviderName>().notNull(),
    /**
     * The gateway for orders shipping outside Nigeria, or NULL for "no country
     * rule — everyone gets `activeProvider`".
     */
    internationalProvider: text('international_provider').$type<ProviderName>(),
    /** ISO 4217, uppercase. Never empty — the CHECK forbids it. */
    paystackCurrencies: text('paystack_currencies').array().notNull(),
    flutterwaveCurrencies: text('flutterwave_currencies').array().notNull(),
    /** CAS, as on `posts.revision`. Moves on every write. */
    revision: integer('revision').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('shop_payment_settings_id_ck', sql`${t.id} = 'main'`),
    check('shop_payment_settings_active_ck', sql`${t.activeProvider} IN ('paystack', 'flutterwave')`),
    check(
      'shop_payment_settings_intl_ck',
      sql`${t.internationalProvider} IS NULL
          OR ${t.internationalProvider} IN ('paystack', 'flutterwave')`,
    ),
    check('shop_payment_settings_revision_ck', sql`${t.revision} > 0`),
    check(
      'shop_payment_settings_paystack_ccy_ck',
      sql`cardinality(${t.paystackCurrencies}) > 0
          AND array_position(${t.paystackCurrencies}, NULL) IS NULL
          AND array_to_string(${t.paystackCurrencies}, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'`,
    ),
    check(
      'shop_payment_settings_flutterwave_ccy_ck',
      sql`cardinality(${t.flutterwaveCurrencies}) > 0
          AND array_position(${t.flutterwaveCurrencies}, NULL) IS NULL
          AND array_to_string(${t.flutterwaveCurrencies}, ',') ~ '^[A-Z]{3}(,[A-Z]{3})*$'`,
    ),
  ],
);

export type DbShopPaymentSettings = typeof shopPaymentSettings.$inferSelect;

export type DbPaymentIntent = typeof shopPaymentIntents.$inferSelect;
export type DbPaymentEvent = typeof shopPaymentEvents.$inferSelect;
export type DbRefund = typeof shopRefunds.$inferSelect;
