import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The email-marketing tables (HANDOFF §2 A6), declared in a file this subsystem
 * owns exclusively rather than in `server/db/schema.ts`.
 *
 * WHY NOT IN `server/db/schema.ts`, WHERE THE BLOG'S OWN TABLES ARE.
 * `drizzle.config.ts` declares `schema: './server/db/schema.ts'` and nothing else,
 * so that file is the ONE input to `db:generate` — adding four tables to it means
 * a generated migration and a new snapshot. On the day this was written that file
 * was carrying another session's uncommitted work, and two writers in one
 * drizzle-kit input is how `server/db/commerce-schema.ts` lost Catalog's and
 * Payments' blocks in a single afternoon. Declared here instead, these tables are
 * objects drizzle-kit cannot see at all, which is precisely what makes
 * `0008_email_marketing.sql` a LEGAL hand-written migration under the rule
 * `server/db/migrations.test.ts` states: a hand-written migration may only touch
 * objects drizzle-kit cannot model. `server/repo/categories-schema.ts` and
 * `server/shop/cart/schema.ts` reached the same arrangement from the same problem.
 *
 * ⚠️  THIS FILE IS NOT THE SOURCE OF TRUTH FOR THE DDL, AND IT MUST NOT BECOME
 *     ONE. The tables exist because migration `0008_email_marketing.sql` created
 *     them. What this buys is `$inferSelect` types and one place to read the shape
 *     — and it is kept honest rather than decorative by
 *     `server/email/schema.test.ts`, which reads every column name back out of
 *     `information_schema` and fails if the two disagree.
 *
 *     Adding this path to `drizzle.config.ts` would make the next `db:generate`
 *     emit `CREATE TABLE email_templates` for a table that already exists. If it
 *     is ever done it has to be done together with a baseline snapshot.
 *
 * The two rules from `server/db/schema.ts` hold here and are not optional:
 * timestamps are `bigint` epoch-milliseconds and never `timestamptz`, and every
 * enum-ish column carries a `check()` because `.$type<>()` is compile-time only
 * and buys nothing at runtime.
 */

/** epoch-ms. `mode: 'number'` so a read is a number in both drivers. */
const epochMs = (name: string) => bigint(name, { mode: 'number' });

// ----------------------------------------------------------------- templates

export const emailTemplates = pgTable(
  'email_templates',
  {
    /** Defaulted, unlike `emailSubscribers.id`: nothing about a template is
     * derived from its id, so there is no reason for the process to mint one. */
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    /**
     * BOTH BODIES, ALWAYS. `server/mail/port.ts` states the rule: "`text` and
     * `html` are both required: no client sees only one." A template with an
     * empty text part renders blank in every plain-text client, and the person
     * who wrote it never sees that because their own client renders the HTML.
     */
    text: text('text').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
    /** `ON DELETE SET NULL` in the migration: removing the writer who last edited
     * a template must not remove the template. */
    updatedBy: uuid('updated_by'),
    /**
     * Which system message this row IS, or `null` for one an operator wrote
     * (migration 0320). `server/mail/defaults.ts` owns the vocabulary.
     *
     * NOTE: `email_templates_system_key_uq` is a PARTIAL unique index
     * (`WHERE system_key IS NOT NULL`), which drizzle-kit cannot express any more
     * than it can express the functional index above it. It lives only in
     * migration 0320, and so does the trigger that refuses to delete a row with
     * this column set.
     */
    systemKey: text('system_key'),
  },
  (t) => [
    check('email_templates_name_ck', sql`${t.name} <> '' AND ${t.name} = btrim(${t.name})`),
    check('email_templates_subject_ck', sql`${t.subject} <> ''`),
    check('email_templates_bodies_ck', sql`${t.html} <> '' AND ${t.text} <> ''`),
    /*
     * NOTE: `email_templates_name_lower_uq` — UNIQUE over `lower(name)` — is a
     * FUNCTIONAL index, which drizzle-kit cannot express any more than it can
     * express `shop_reservations_sweep_idx`'s partial predicate. It lives only in
     * migration 0008, and `schema.test.ts` asserts both that it is applied and
     * that a second casing is actually refused: an index that exists but is not
     * unique over `lower(name)` would pass a name check and fail nothing else,
     * while leaving 'Welcome' and 'welcome' as two entries in the composer's
     * picker.
     */
  ],
);

// --------------------------------------------------------------- subscribers

export const emailSubscribers = pgTable(
  'email_subscribers',
  {
    /**
     * NO `.defaultRandom()`, DELIBERATELY, and this is the line most likely to be
     * "tidied" back. `token` is an HMAC OF `id`, so the id has to exist in the
     * process before the row does — with a database-side default the insert would
     * have to read the id back and issue a second UPDATE to fill the token, which
     * is a window in which a subscriber exists with no unsubscribe link.
     */
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    /** Often absent: an import or a checkout hands over an address and nothing
     * else. `server/email/render.ts` documents what `{{name}}` does then. */
    name: text('name'),
    source: text('source').$type<'customer' | 'manual' | 'import'>().notNull(),
    /**
     * WHEN they opted in. Its absence is NOT suppression — an operator-added
     * address has no consent timestamp and is still mailable; `unsubscribedAt` is
     * the only thing that stops a send. Collapsing the two into one nullable
     * boolean would lose the difference between "never asked" and "asked to stop".
     */
    consentAt: epochMs('consent_at'),
    unsubscribedAt: epochMs('unsubscribed_at'),
    /** HMAC-SHA-256 of `id` under `SESSION_SECRET`, hex — the whole authority of
     * `GET/POST /api/public/unsubscribe`. */
    token: text('token').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('email_subscribers_email_uq').on(t.email),
    uniqueIndex('email_subscribers_token_uq').on(t.token),
    index('email_subscribers_keyset_idx').on(t.createdAt.desc(), t.id.desc()),
    check('email_subscribers_email_ck', sql`${t.email} <> '' AND ${t.email} = lower(${t.email})`),
    check(
      'email_subscribers_source_ck',
      sql`${t.source} IN ('customer','manual','import')`,
    ),
    check('email_subscribers_token_ck', sql`${t.token} <> ''`),
  ],
);

// ---------------------------------------------------------------- broadcasts

export const emailBroadcasts = pgTable(
  'email_broadcasts',
  {
    id: uuid('id').primaryKey(),
    /** Provenance only. The three snapshot columns below are the authority, which
     * is why the migration can afford `ON DELETE SET NULL` here. */
    templateId: uuid('template_id'),
    /**
     * WHO this broadcast was for (migration 1000). `all_subscribers` is every
     * non-suppressed row in `email_subscribers` — the only thing a broadcast
     * could mean before the "Not bought yet" screen existed, which is why it is
     * the DEFAULT and why no existing row had to be touched. `picked` reads its
     * addresses from `email_broadcast_audience`.
     */
    audienceKind: text('audience_kind')
      .$type<'all_subscribers' | 'picked'>()
      .notNull()
      .default('all_subscribers'),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    status: text('status').$type<'draft' | 'sending' | 'sent' | 'failed'>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: epochMs('created_at').notNull(),
    /** Named by HANDOFF §2 A6 and written by nothing yet. A nullable column
     * nobody fills costs nothing; adding one to a table with rows in it is a
     * migration. */
    scheduledAt: epochMs('scheduled_at'),
    startedAt: epochMs('started_at'),
    finishedAt: epochMs('finished_at'),
    /** Maintained by the drain in the same statement that resolves a recipient,
     * so the progress view can poll one row instead of aggregating the queue. */
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
  },
  (t) => [
    index('email_broadcasts_status_idx').on(t.status, t.createdAt.desc()),
    check(
      'email_broadcasts_status_ck',
      sql`${t.status} IN ('draft','sending','sent','failed')`,
    ),
    check(
      'email_broadcasts_audience_kind_ck',
      sql`${t.audienceKind} IN ('all_subscribers','picked')`,
    ),
    check('email_broadcasts_subject_ck', sql`${t.subject} <> ''`),
    check('email_broadcasts_bodies_ck', sql`${t.html} <> '' AND ${t.text} <> ''`),
    check(
      'email_broadcasts_counts_ck',
      sql`${t.sentCount} >= 0 AND ${t.failedCount} >= 0`,
    ),
  ],
);

/**
 * The per-recipient queue, built in the image of `shop_order_email_intents`.
 *
 * NO ADDRESS SNAPSHOT — the one place this diverges from the order outbox, and
 * the migration explains why at length: suppression means somebody who
 * unsubscribes between "send" and the batch that would have reached them is not
 * mailed, and that is only true if the address and `unsubscribed_at` are read
 * through the join at CLAIM time rather than frozen at enqueue time.
 */
export const emailBroadcastRecipients = pgTable(
  'email_broadcast_recipients',
  {
    id: uuid('id').primaryKey(),
    broadcastId: uuid('broadcast_id').notNull(),
    subscriberId: uuid('subscriber_id').notNull(),
    status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped'>().notNull(),
    /** The CAS column. Two drains both read `attempts = n`, both try
     * `SET attempts = n + 1 WHERE attempts = n`, and exactly one matches — the
     * property a lease column is usually added for, from a column that had to
     * exist anyway (`server/shop/orders/repo/emails.ts` has the long version). */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: epochMs('sent_at'),
  },
  (t) => [
    uniqueIndex('email_broadcast_recipients_dedupe_uq').on(t.broadcastId, t.subscriberId),
    check(
      'email_broadcast_recipients_status_ck',
      sql`${t.status} IN ('pending','sent','failed','skipped')`,
    ),
    check('email_broadcast_recipients_attempts_ck', sql`${t.attempts} >= 0`),
    /*
     * NOTE: `email_broadcast_recipients_drain_idx` is PARTIAL
     * (`WHERE status = 'pending'`) and drizzle-kit cannot express it, exactly like
     * `shop_reservations_sweep_idx`. It lives only in migration 0008, and
     * `schema.test.ts` asserts it is applied — after a large send succeeds the
     * pending rows are a vanishing fraction of the table, and a full index would
     * carry every delivered row forever for a predicate that never selects one.
     */
  ],
);

/**
 * The addresses a `picked` broadcast was aimed at (migration 1000).
 *
 * EMAIL AND NOT `subscriber_id` — see the migration header. At pick time most of
 * these people have no subscriber row; one is created at SEND time, by
 * `addSubscriber`, which is what mints their unsubscribe token.
 */
export const emailBroadcastAudience = pgTable(
  'email_broadcast_audience',
  {
    broadcastId: uuid('broadcast_id').notNull(),
    email: text('email').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.broadcastId, t.email] }),
    check(
      'email_broadcast_audience_email_ck',
      sql`${t.email} <> '' AND ${t.email} = lower(${t.email})`,
    ),
  ],
);

export type DbEmailTemplate = typeof emailTemplates.$inferSelect;
export type DbEmailSubscriber = typeof emailSubscribers.$inferSelect;
export type DbEmailBroadcast = typeof emailBroadcasts.$inferSelect;
export type DbEmailBroadcastRecipient = typeof emailBroadcastRecipients.$inferSelect;
export type DbEmailBroadcastAudience = typeof emailBroadcastAudience.$inferSelect;
