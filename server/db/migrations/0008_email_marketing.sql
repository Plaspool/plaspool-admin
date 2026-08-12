-- EMAIL MARKETING (HANDOFF §2 A6): templates, subscribers, broadcasts and the
-- per-recipient queue the broadcast drain claims rows out of.
--
-- HAND-WRITTEN IN FULL, AND THAT IS IN-RULE RATHER THAN LAZY. `drizzle.config.ts`
-- declares `schema: './server/db/schema.ts'` and nothing else; these four tables
-- are declared in `server/email/schema.ts`, which drizzle-kit has never seen and
-- never will. That is exactly the condition `server/db/migrations.test.ts` states
-- for a hand-written migration — it may only touch objects drizzle-kit cannot
-- model — and `0007_managed_categories.sql` and `0160_orders_fulfillment.sql` are
-- the same shape for the same reason. `meta/0008_snapshot.json` deliberately does
-- not exist.
--
-- WHY THE TABLES ARE NOT IN `server/db/schema.ts` WITH THE BLOG'S OWN. That file
-- is the ONE input to `db:generate`, and on the day this was written it was
-- carrying another session's uncommitted work — so adding four tables to it would
-- have meant a generated migration plus a snapshot written into a file already
-- held by somebody else. `server/db/commerce-schema.ts` lost two subsystems'
-- blocks in a single afternoon to exactly that, which is why every subsystem since
-- has owned its own declaration file.
--
-- The price of sitting outside the model is that NOTHING TYPECHECKS THE SQL below,
-- which is why `server/email/schema.test.ts` reads every column, constraint and
-- index back out of `information_schema`, `pg_constraint` and `pg_indexes` on a
-- migrated database rather than trusting that this file ran.

/*
 * The editable message store the composer writes into.
 *
 * BOTH BODIES ARE NOT NULL AND NEITHER MAY BE EMPTY. `server/mail/port.ts` states
 * the rule this enforces at rest: "`text` and `html` are both required: no client
 * sees only one." A template with an empty text part renders as a blank message in
 * every plain-text client and in every preview pane that refuses HTML, and the
 * sender never sees it because their own client renders the HTML fine.
 *
 * `text` IS A LEGAL COLUMN NAME and is used verbatim rather than renamed to
 * `text_body`, because the API field, the TypeScript field and the column are then
 * one word in all three places. It reads as a type name in a bare CHECK
 * expression, so it is quoted below wherever it appears in one.
 */
CREATE TABLE email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text text NOT NULL,
  /* epoch-ms, never `timestamptz` — the rule `server/db/schema.ts` states. A
   * `timestamptz` reads back as a Date from PGlite and as a string from Neon, and
   * `toEpochMs`, the function that closes that divergence, works on neither. */
  updated_at bigint NOT NULL,
  /*
   * NULLABLE, AND `ON DELETE SET NULL` RATHER THAN CASCADE. A template is the
   * shop's property, not the author's: deleting the writer who last edited it must
   * not delete the message the business sends to five thousand people. The column
   * answers "who touched this last", and losing that answer is the correct cost of
   * removing an account.
   */
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT email_templates_name_ck CHECK (name <> '' AND name = btrim(name)),
  CONSTRAINT email_templates_subject_ck CHECK (subject <> ''),
  CONSTRAINT email_templates_bodies_ck CHECK (html <> '' AND "text" <> '')
);--> statement-breakpoint
/*
 * UNIQUE, CASE-INSENSITIVELY, AS A FUNCTIONAL INDEX — the same construction and
 * the same reasoning as `categories_name_lower_uq` in 0007. A plain `UNIQUE (name)`
 * would let 'Welcome' and 'welcome' both exist, which is two indistinguishable
 * entries in the composer's template picker and a fifty-fifty chance of editing
 * the one that is not being sent.
 *
 * Postgres has no case-insensitive text type in core (`citext` is an extension
 * Neon would have to have enabled), so it is an index over `lower(name)` and is
 * therefore an object drizzle-kit cannot express. It lives only in this file.
 */
CREATE UNIQUE INDEX email_templates_name_lower_uq ON email_templates (lower(name));--> statement-breakpoint

/*
 * The audience.
 *
 * `id` HAS NO DEFAULT, DELIBERATELY, AND THAT IS THE ONE THING IN THIS FILE MOST
 * LIKELY TO BE "TIDIED" BACK. `token` is an HMAC OF `id` (see
 * `server/email/repo.ts`), so the id has to exist in the process before the row
 * does. With `DEFAULT gen_random_uuid()` the insert would have to read the id back
 * and issue a second UPDATE to fill the token — a window, however short, in which
 * a subscriber exists with no unsubscribe link, on a table whose entire purpose is
 * to be mailed. `categories.id` defaults for the opposite reason: nothing about a
 * category is derived from its id.
 *
 * `email` IS STORED LOWERCASE AND THE CHECK SAYS SO. The unique index below is
 * over the column verbatim, so 'Reader@example.com' and 'reader@example.com' would
 * otherwise be two subscribers, two copies of every broadcast, and two unsubscribe
 * links of which one keeps working. Normalisation happens in `server/email/repo.ts`;
 * this is the constraint that makes a route which forgets to call it fail loudly
 * rather than quietly duplicate somebody.
 */
CREATE TABLE email_subscribers (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  /* Nullable: an import or a checkout hands over an address and often nothing
   * else. `{{name}}` falls back to the local part when this is null — see
   * `server/email/render.ts` for why that beats inventing a greeting. */
  name text,
  source text NOT NULL,
  /*
   * NULLABLE, AND ITS ABSENCE IS NOT THE SAME AS SUPPRESSION. `consent_at` records
   * WHEN someone opted in; `unsubscribed_at` records that they opted out. A row
   * with neither is an address the operator added by hand and has to stand behind
   * — which is a different thing from an address that asked to stop, and the two
   * must not collapse into one nullable boolean.
   */
  consent_at bigint,
  unsubscribed_at bigint,
  /* HMAC-SHA-256 of `id` under `SESSION_SECRET`, hex. Unguessable without the
   * secret, so it is the whole authority of the unsubscribe route; stored rather
   * than recomputed per request so the lookup is one indexed equality. */
  token text NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT email_subscribers_email_ck CHECK (email <> '' AND email = lower(email)),
  /* The enum, in the database. `.$type<>()` in the declaration file is
   * compile-time only and buys exactly nothing at runtime. */
  CONSTRAINT email_subscribers_source_ck CHECK (source IN ('customer', 'manual', 'import')),
  CONSTRAINT email_subscribers_token_ck CHECK (token <> '')
);--> statement-breakpoint
CREATE UNIQUE INDEX email_subscribers_email_uq ON email_subscribers (email);--> statement-breakpoint
/*
 * UNIQUE ON THE TOKEN, and it is not decoration: `GET /api/public/unsubscribe`
 * resolves a person from this column alone, with no session and no other input. A
 * duplicate would make one click ambiguous, and a sequential scan would make an
 * unauthenticated endpoint a table scan anyone can trigger at will.
 */
CREATE UNIQUE INDEX email_subscribers_token_uq ON email_subscribers (token);--> statement-breakpoint
/*
 * The keyset order the list route pages on, as one index over the whole tuple.
 * `ORDER BY created_at DESC, id DESC` with a `(created_at, id) < (…, …)` predicate
 * is an index scan against this and a sort of the entire table without it.
 */
CREATE INDEX email_subscribers_keyset_idx ON email_subscribers (created_at DESC, id DESC);--> statement-breakpoint

/*
 * One send.
 *
 * `subject`, `html` AND `text` ARE SNAPSHOTS, NOT A JOIN TO THE TEMPLATE, and the
 * reason is the one `server/shop/orders/mailer.ts` states about order lines: an
 * email is the place where rendering from live data is most visible and least
 * recoverable, because the recipient keeps the message forever. Editing a template
 * after a broadcast has gone out must not change what the history says was sent,
 * and a broadcast half-drained when somebody saves the template must not send two
 * different messages to two halves of one audience.
 *
 * `template_id` therefore carries NO authority — it is provenance, and
 * `ON DELETE SET NULL` says so: deleting the template a broadcast was built from
 * leaves the broadcast intact and complete, because everything it needs is already
 * in these three columns.
 */
CREATE TABLE email_broadcasts (
  id uuid PRIMARY KEY,
  template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text text NOT NULL,
  status text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL,
  /* Reserved for a scheduled send. Written by nothing yet and read by nothing
   * yet; the column exists because HANDOFF §2 A6 names it and because adding a
   * column to a table with rows in it is a migration, while leaving a nullable one
   * unused costs nothing. */
  scheduled_at bigint,
  started_at bigint,
  finished_at bigint,
  /*
   * COUNTERS ON THE BROADCAST AS WELL AS ROWS IN THE QUEUE, and the duplication is
   * deliberate. The progress view polls this row every second or two while a send
   * is running; `SELECT count(*) … GROUP BY status` over the recipient queue would
   * be an aggregate over the whole audience on every poll. These two are
   * maintained by the drain in the same statement that resolves a recipient.
   */
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  CONSTRAINT email_broadcasts_status_ck
    CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  CONSTRAINT email_broadcasts_subject_ck CHECK (subject <> ''),
  CONSTRAINT email_broadcasts_bodies_ck CHECK (html <> '' AND "text" <> ''),
  CONSTRAINT email_broadcasts_counts_ck CHECK (sent_count >= 0 AND failed_count >= 0)
);--> statement-breakpoint
/* The drain asks one question of this table — "which broadcasts are still
 * sending" — and the cron asks it with nobody watching. */
CREATE INDEX email_broadcasts_status_idx ON email_broadcasts (status, created_at DESC);--> statement-breakpoint

/*
 * The per-recipient queue, built in the image of `shop_order_email_intents`
 * (`server/shop/orders/repo/emails.ts`): a claim that is a CAS on `attempts`, a
 * bounded number of tries, and a sweeper that records a failure on the row instead
 * of throwing.
 *
 * NO `to_email` SNAPSHOT, WHICH IS THE ONE PLACE THIS DELIBERATELY DIVERGES FROM
 * THE ORDER OUTBOX. An order intent is a message that was OWED at the instant the
 * order was paid, so it snapshots everything. A broadcast recipient is a promise to
 * mail somebody who is still a subscriber WHEN THE MESSAGE GOES OUT — and the whole
 * of suppression is that somebody who unsubscribes between "send" and the batch
 * that would have reached them is not mailed. Reading the address (and
 * `unsubscribed_at` beside it) through the join at claim time is what makes that
 * true; a snapshot taken at enqueue time would send to an audience frozen before
 * the opt-outs.
 */
CREATE TABLE email_broadcast_recipients (
  id uuid PRIMARY KEY,
  broadcast_id uuid NOT NULL REFERENCES email_broadcasts(id) ON DELETE CASCADE,
  /* CASCADE, unlike everything else in this file. A subscriber row IS the person;
   * deleting one has to take the record of what was queued for them with it, or
   * the queue outlives the consent it was built from. */
  subscriber_id uuid NOT NULL REFERENCES email_subscribers(id) ON DELETE CASCADE,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  /* A provider's prose about the refusal, capped by the writer. Never the error
   * object: `server/middleware/errors.ts` and the order sweeper both make the same
   * choice, because an error object can carry the request that held the address. */
  last_error text,
  sent_at bigint,
  CONSTRAINT email_broadcast_recipients_status_ck
    CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT email_broadcast_recipients_attempts_ck CHECK (attempts >= 0)
);--> statement-breakpoint
/*
 * THE DEDUPE, AS A CONSTRAINT RATHER THAN AS A CAREFUL INSERT.
 *
 * Enqueue is `INSERT … SELECT … ON CONFLICT DO NOTHING`, so pressing "send" twice —
 * or a cron delivery that Vercel documents as possibly duplicated — enqueues the
 * audience once. Without this the second press is a second copy of the message to
 * every subscriber, which is the single most expensive mistake this surface can
 * make and the only one that cannot be taken back.
 */
CREATE UNIQUE INDEX email_broadcast_recipients_dedupe_uq
  ON email_broadcast_recipients (broadcast_id, subscriber_id);--> statement-breakpoint
/*
 * PARTIAL, ON `pending` ONLY — an object drizzle-kit cannot express, exactly like
 * `shop_reservations_sweep_idx`. The drain's only query is "the next N pending
 * recipients of this broadcast", and after a large send succeeds the pending rows
 * are a vanishing fraction of the table; a full index would carry every delivered
 * row forever for a predicate that never selects one.
 */
CREATE INDEX email_broadcast_recipients_drain_idx
  ON email_broadcast_recipients (broadcast_id, id)
  WHERE status = 'pending';
