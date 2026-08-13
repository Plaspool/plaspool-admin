-- MARKETING (spec `docs/superpowers/specs/2026-08-13-marketing-design.md` §Database):
-- renameable rewards programs, the return lifecycle they award from, an
-- append-only points ledger with an O(1) balance counter, the notification
-- outbox, website banners and the discount-code model.
--
-- HAND-WRITTEN IN FULL, AND THAT IS IN-RULE RATHER THAN LAZY. `drizzle.config.ts`
-- declares `schema: './server/db/schema.ts'` and nothing else; these nine tables
-- are declared in `server/marketing/schema.ts`, which drizzle-kit has never seen
-- and never will. That is exactly the condition `server/db/migrations.test.ts`
-- states for a hand-written migration — it may only touch objects drizzle-kit
-- cannot model — and `0007_managed_categories.sql`, `0008_email_marketing.sql`
-- and `0160_orders_fulfillment.sql` are the same shape for the same reason.
-- `meta/0011_snapshot.json` deliberately does not exist.
--
-- WHY THE TABLES ARE NOT IN `server/db/schema.ts` WITH THE BLOG'S OWN. That file
-- is the ONE input to `db:generate`, and on the day this was written it was
-- carrying the concurrent shop session's uncommitted work — so adding nine tables
-- to it would have meant a generated migration plus a snapshot written into a
-- file already held by somebody else. `server/db/commerce-schema.ts` lost two
-- subsystems' blocks in a single afternoon to exactly that, which is why every
-- subsystem since has owned its own declaration file.
--
-- The price of sitting outside the model is that NOTHING TYPECHECKS THE SQL
-- below, which is why `server/marketing/schema.test.ts` reads every column,
-- constraint and index back out of `information_schema`, `pg_constraint` and
-- `pg_indexes` on a migrated database rather than trusting that this file ran.
--
-- TWO RULES FROM `server/db/schema.ts` HOLD THROUGHOUT AND ARE NOT OPTIONAL.
-- Timestamps are `bigint` epoch-milliseconds, never `timestamptz`: a
-- `timestamptz` reads back as a Date from PGlite and as a string from Neon, and
-- `toEpochMs`, the function that closes that divergence, works on neither. And
-- every enum-ish column carries a CHECK, because `.$type<>()` in the declaration
-- file is compile-time only and buys exactly nothing at runtime.
--
-- CROSS-DOMAIN IDS ARE `text` WITH NO FOREIGN KEY. `customer_id` and `order_id`
-- belong to the shop; `actor_id` belongs to `users`. Marketing stores them and
-- never joins on them (spec §Global, and the same argument
-- `shop_cart_lines.variant_id` makes): an FK across the boundary turns somebody
-- else's cleanup into a failure here, and would make this subsystem's writes
-- depend on a table it has no ownership of.

/*
 * A rewards program: WHAT IS AWARDED, WHAT IT IS CALLED, AND WHAT THE RULE IS.
 *
 * NOTHING ABOUT THE NAMING IS FIXED, AND THAT IS THE POINT OF THE WHOLE TABLE.
 * The brief asked for a returns programme in one particular product's words; the
 * design (spec D2) makes every one of those words a column, seeds the programme
 * as a PRESET, and lets the shop rename it on day one. Four mechanisms keep a
 * rename safe, and two of them live here:
 *
 *   (a) `key` IS THE ONLY STABLE HANDLE — unique, lowercase-shaped, and
 *       structurally un-editable: the PATCH schema in `programs/routes.ts` simply
 *       has no `key` field, so `.strict()` refuses any attempt with a 400. This
 *       CHECK is what stops a hand-written statement from installing the
 *       mixed-case twin the unique index cannot see.
 *   (d) `seeded` SAYS "THIS ROW CAME FROM A MIGRATION" — it is the ONLY thing the
 *       "Seeded preset" chip may derive from. Matching the preset's key or name
 *       in application code is precisely what `no-hardcoded-labels.test.ts`
 *       greps for and forbids; a boolean column costs one byte and removes the
 *       temptation entirely.
 *
 * `conditions` IS THE RESERVED EXTENSION POINT AND IT IS DELIBERATELY EMPTY. v1's
 * zod schema pins it to `{}`; a future condition (expiry, multipliers, per-tier
 * rates) lands as a widened schema plus an interpreter function and NO migration.
 * A jsonb column nobody writes to costs nothing; adding one to a table with rows
 * in it is a migration, and this is a table that will have rows in it.
 *
 * THE KIND COUPLING IS ONE CHECK RATHER THAN FOUR NULLABLE COLUMNS ON TRUST. A
 * `unit_return` program with no `points_per_unit` is a program the inspect
 * statement cannot price — it would compute `qty * NULL` and write NULL points
 * against a customer who was promised a number. An `adhoc` program carrying a
 * `min_units_per_return` is a rule nothing will ever read, which is worse than
 * absent because somebody will eventually believe it.
 */
CREATE TABLE marketing_programs (
  id text PRIMARY KEY,
  key text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  points_label_singular text NOT NULL,
  points_label_plural text NOT NULL,
  /* NULL for `adhoc`: points granted by hand are not counted in anything. */
  unit_label_singular text,
  unit_label_plural text,
  min_units_per_return integer,
  points_per_unit integer,
  status text NOT NULL DEFAULT 'active',
  conditions jsonb NOT NULL DEFAULT '{}',
  seeded boolean NOT NULL DEFAULT false,
  /* CAS, same as `posts.revision` and `shop_carts.revision`. Every write moves
   * it, which is what makes an A→B→A edit visible to a stale editor. */
  revision integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  /* `ON DELETE SET NULL`, the rule `email_templates.updated_by` states: a
   * program is the shop's property, not the author's, and removing an account
   * must not remove the rules the business awards points under. */
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT marketing_programs_key_uq UNIQUE (key),
  CONSTRAINT marketing_programs_key_ck
    CHECK (key <> '' AND key = lower(key) AND key ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT marketing_programs_kind_ck CHECK (kind IN ('unit_return', 'adhoc')),
  CONSTRAINT marketing_programs_name_ck CHECK (name <> '' AND name = btrim(name)),
  CONSTRAINT marketing_programs_points_labels_ck
    CHECK (points_label_singular <> '' AND points_label_plural <> ''),
  CONSTRAINT marketing_programs_min_units_ck
    CHECK (min_units_per_return IS NULL OR min_units_per_return > 0),
  CONSTRAINT marketing_programs_points_per_unit_ck
    CHECK (points_per_unit IS NULL OR points_per_unit > 0),
  CONSTRAINT marketing_programs_kind_fields_ck
    CHECK ((kind = 'unit_return') = (unit_label_singular IS NOT NULL
                                     AND unit_label_plural IS NOT NULL
                                     AND min_units_per_return IS NOT NULL
                                     AND points_per_unit IS NOT NULL)),
  CONSTRAINT marketing_programs_status_ck CHECK (status IN ('active', 'paused')),
  CONSTRAINT marketing_programs_revision_ck CHECK (revision > 0)
);--> statement-breakpoint

/*
 * THE SETTINGS SINGLETON — the cross-program layer.
 *
 * `CHECK (id = 'main')` IS THE SINGLETON, AS A CONSTRAINT RATHER THAN AS A
 * CONVENTION. Two settings rows would be two answers to "what is a point worth",
 * and the loser would be whichever one the reader's ORDER BY happened to miss.
 * Same construction, same reason, as a one-row configuration table anywhere.
 *
 * REDEMPTION ECONOMICS ARE AN INTEGER RATIONAL, NEVER A FLOAT.
 * `redemption_rate_points` points are worth `redemption_rate_minor` minor units
 * of `redemption_currency`, and `shared/commerce/money.ts` `scale()` does the
 * conversion half-up. A float rate is the classic way to make two systems
 * disagree by one kobo on a number a customer can see.
 *
 * `CHECK (NOT redemption_enabled OR redemption_rate_minor > 0)` IS THE ONE THAT
 * PROTECTS MONEY. The seed below ships redemption DISABLED at a rate of zero,
 * because the numbers in it are placeholders the owner has been asked to review.
 * With this CHECK, switching redemption on before somebody sets a real rate is
 * refused by the database; without it, every cart silently discounts to whatever
 * `points * 0` is worth. A forgotten review then costs copy, never money.
 *
 * `max_redeem_bps` IS A CEILING IN BASIS POINTS ON THE SHARE OF A CART POINTS MAY
 * PAY FOR — 10000 (all of it) by default, because a shop that wants a cap will
 * say so and a shop that does not must not be surprised by one.
 */
CREATE TABLE marketing_settings (
  id text PRIMARY KEY,
  /* The labels for surfaces that span programs — the balance tile, the checkout
   * adjustment. Per-PROGRAM labels live on the program row; these are the words
   * used where no single program is in scope. */
  points_label_singular text NOT NULL,
  points_label_plural text NOT NULL,
  redemption_enabled boolean NOT NULL DEFAULT false,
  redemption_rate_points integer NOT NULL,
  redemption_rate_minor integer NOT NULL,
  redemption_currency text NOT NULL,
  min_redeem_points integer NOT NULL DEFAULT 0,
  max_redeem_bps integer NOT NULL DEFAULT 10000,
  /*
   * `ON DELETE SET NULL` rather than RESTRICT. Nothing deletes a program today
   * (the UI pauses them), but if one ever is, a dangling pointer here would be a
   * 500 on every admin intake — whereas NULL is a state the intake route already
   * has a defined answer for: `409 program_paused`, which the UI renders as a
   * banner linking to the programs list.
   */
  default_return_program_id text REFERENCES marketing_programs(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at bigint NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT marketing_settings_id_ck CHECK (id = 'main'),
  CONSTRAINT marketing_settings_points_labels_ck
    CHECK (points_label_singular <> '' AND points_label_plural <> ''),
  /* A rate of "0 points are worth N" is a division by zero in `quote()`. */
  CONSTRAINT marketing_settings_rate_points_ck CHECK (redemption_rate_points > 0),
  CONSTRAINT marketing_settings_rate_minor_ck CHECK (redemption_rate_minor >= 0),
  CONSTRAINT marketing_settings_enabled_rate_ck
    CHECK (NOT redemption_enabled OR redemption_rate_minor > 0),
  /* ISO-4217, uppercase — the same shape `shop_carts.currency` insists on,
   * because the same `scale()` reads both. */
  CONSTRAINT marketing_settings_currency_ck CHECK (redemption_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT marketing_settings_min_redeem_ck CHECK (min_redeem_points >= 0),
  CONSTRAINT marketing_settings_max_bps_ck CHECK (max_redeem_bps BETWEEN 1 AND 10000),
  CONSTRAINT marketing_settings_revision_ck CHECK (revision > 0)
);--> statement-breakpoint

/*
 * A RETURN REQUEST — the row the whole lifecycle moves through.
 *
 * `points_per_unit_snapshot` IS COPIED FROM THE PROGRAM AT CREATION AND IS NEVER
 * READ THROUGH THE FK AGAIN. A customer who was told "ten a unit" on Monday is
 * awarded ten a unit on Friday, even if the shop repriced on Wednesday. That is
 * an honest-promise rule, not an optimisation: admins reprice by cancelling and
 * recreating, and the timeline records both halves.
 *
 * RECEIVED MAY DIFFER FROM DECLARED, DELIBERATELY. There is NO
 * `qty_accepted + qty_rejected = qty_declared` constraint: the customer says six,
 * the driver comes back with five, and a database that refuses to record that
 * forces staff to lie to it. What IS pinned is the arithmetic that decides what a
 * customer is paid — see `marketing_return_requests_award_ck` below.
 *
 * `status` MOVES `requested → scheduled → collected → received → awarded`, with
 * `rejected` reachable pre-receipt or from an inspection that accepted nothing,
 * and `cancelled` reachable up to and including `collected` — collected is
 * cancellable on purpose, as the lost-in-transit escape; `received` is not,
 * because once the goods are in hand somebody must inspect them.
 */
CREATE TABLE marketing_return_requests (
  id text PRIMARY KEY,
  /* RESTRICT, not CASCADE: a program with returns against it must not be
   * deletable out from under them, and the request's own snapshot means it
   * would not need the row anyway. */
  program_id text NOT NULL REFERENCES marketing_programs(id) ON DELETE RESTRICT,
  /* The shop's id when there is one. Guest checkout is the DEFAULT path, so this
   * is nullable and `customer_email` is the key everything actually joins on
   * (spec D10). Carried so a later account-merge backfill has something to work
   * from; no FK, because it is another subsystem's id. */
  customer_id text,
  customer_email text NOT NULL,
  customer_name text,
  customer_phone text,
  pickup_address text,
  qty_declared integer NOT NULL,
  qty_accepted integer,
  qty_rejected integer,
  points_per_unit_snapshot integer NOT NULL,
  points_awarded integer,
  rejected_reason text,
  cancel_reason text,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  pickup_scheduled_at bigint,
  driver_name text,
  driver_phone text,
  scheduled_at bigint,
  collected_at bigint,
  received_at bigint,
  closed_at bigint,
  revision integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  /* Lowercase at rest, so the balance, the ledger and the open-return index
   * below all agree about who a person is. `Dara@x` and `dara@x` would otherwise
   * be two wallets and two open returns for one customer. */
  CONSTRAINT marketing_return_requests_email_ck
    CHECK (customer_email <> '' AND customer_email = lower(customer_email)),
  CONSTRAINT marketing_return_requests_qty_declared_ck CHECK (qty_declared > 0),
  CONSTRAINT marketing_return_requests_qty_counts_ck
    CHECK ((qty_accepted IS NULL OR qty_accepted >= 0)
           AND (qty_rejected IS NULL OR qty_rejected >= 0)),
  CONSTRAINT marketing_return_requests_points_snapshot_ck CHECK (points_per_unit_snapshot > 0),
  CONSTRAINT marketing_return_requests_points_awarded_ck
    CHECK (points_awarded IS NULL OR points_awarded >= 0),
  CONSTRAINT marketing_return_requests_source_ck CHECK (source IN ('customer', 'admin')),
  CONSTRAINT marketing_return_requests_status_ck
    CHECK (status IN ('requested', 'scheduled', 'collected', 'received',
                      'awarded', 'rejected', 'cancelled')),
  /*
   * THE AWARD ARITHMETIC, IN THE DATABASE.
   *
   * The inspect statement computes `points_awarded` as
   * `qty_accepted * points_per_unit_snapshot` in one CTE chain. This is what
   * makes a later edit to that statement — or a hand-run UPDATE during an
   * incident — unable to award a number nobody can reconstruct from the row. It
   * also states the other half of the rule: `awarded` requires at least one unit
   * accepted, so an inspection that accepted nothing lands in `rejected` and
   * writes no ledger row at all.
   */
  CONSTRAINT marketing_return_requests_award_ck
    CHECK (status <> 'awarded'
           OR (qty_accepted >= 1 AND qty_rejected IS NOT NULL
               AND points_awarded = qty_accepted * points_per_unit_snapshot)),
  CONSTRAINT marketing_return_requests_revision_ck CHECK (revision > 0)
);--> statement-breakpoint
/* The queue's keyset: `WHERE status = ANY(...) ORDER BY created_at DESC, id DESC`
 * is an index scan against this and a sort of the whole table without it. */
CREATE INDEX marketing_return_requests_keyset_idx
  ON marketing_return_requests (status, created_at DESC, id DESC);--> statement-breakpoint
/*
 * ONE OPEN RETURN PER CUSTOMER, AS A PARTIAL UNIQUE INDEX.
 *
 * A business rule, and it is flagged as one: a second in-flight return for one
 * address is two drivers sent to one doorstep and two awards against one pile of
 * goods. If the shop ever wants concurrent returns, DROPPING THIS INDEX is the
 * whole change — nothing in the application depends on it holding, only on the
 * 23505 it raises, which `returns/repo.ts` turns into
 * `409 return_already_open {existingId, status}` so the admin UI links to the
 * request that already exists instead of dead-ending.
 *
 * PARTIAL is what makes the rule survivable: a customer who returned last month
 * must be able to return again, and two CLOSED returns for one address must not
 * collide with each other either. drizzle-kit cannot express the predicate, so
 * this index lives only here — exactly like `shop_reservations_sweep_idx`.
 */
CREATE UNIQUE INDEX marketing_return_requests_open_uq
  ON marketing_return_requests (customer_email)
  WHERE status IN ('requested', 'scheduled', 'collected', 'received');--> statement-breakpoint

/*
 * THE TIMELINE. Append-only, and the customer-visible history of a return.
 *
 * `data` IS jsonb AND IT IS WHERE THE LABEL SNAPSHOT LIVES. The `inspected` event
 * carries `{qtyAccepted, qtyRejected, pointsAwarded, outcome}` PLUS the four
 * label values exactly as they read at that instant (spec D2d). A rename then
 * changes the future and never the history — open a return from March and it
 * still says what the customer was told in March.
 *
 * `actor_id` IS TEXT WITH NO FOREIGN KEY to `users`, the same choice
 * `shop_order_events` made and for the same two reasons: an FK is a constraint
 * added to a table this subsystem only reads, and it would make a return's
 * history unwritable — and the return undeletable in a way nobody intended — the
 * day an account is removed.
 */
CREATE TABLE marketing_return_events (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES marketing_return_requests(id) ON DELETE RESTRICT,
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id text,
  note text,
  data jsonb,
  occurred_at bigint NOT NULL,
  CONSTRAINT marketing_return_events_type_ck
    CHECK (type IN ('requested', 'scheduled', 'collected', 'received',
                    'inspected', 'rejected', 'cancelled', 'note')),
  CONSTRAINT marketing_return_events_actor_ck
    CHECK (actor_type IN ('admin', 'customer', 'system'))
);--> statement-breakpoint
/* The detail panel's only query, as one index over the whole ORDER BY. */
CREATE INDEX marketing_return_events_request_idx
  ON marketing_return_events (request_id, occurred_at, id);--> statement-breakpoint

/*
 * THE LEDGER — append-only, and the only explanation of any balance.
 *
 * `balance_after` IS RECORDED ON EVERY ROW because the statement that writes it
 * already knows it: the balance CTE returns the new value, and the ledger INSERT
 * selects from that CTE. Without it the UI's "120 → 180" needs a window function
 * over a customer's whole history on every page of the ledger.
 *
 * IDEMPOTENCY LIVES IN THE PARTIAL UNIQUES BELOW, NOT IN CODE. Every guard in
 * `returns/repo.ts` could be deleted and awarding one return twice would still be
 * a 23505. That is the difference between "we are careful" and "it cannot
 * happen", on the one operation in this subsystem that costs the business money
 * and cannot be taken back.
 *
 * THE FIVE COUPLING CHECKS SAY WHAT EACH KIND MEANS. An award with no return is
 * an award nobody can audit; a redemption with no order is a debit nobody can
 * refund; an award that subtracts, or a redemption that adds, is a bug that reads
 * as a legitimate row forever afterwards.
 */
CREATE TABLE marketing_ledger (
  id text PRIMARY KEY,
  customer_email text NOT NULL,
  customer_id text,
  /* Nullable — a manual adjustment belongs to no program. RESTRICT for the same
   * reason as the request's: a program with history must not vanish. */
  program_id text REFERENCES marketing_programs(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  delta integer NOT NULL,
  balance_after integer NOT NULL,
  /*
   * RENDER-FINAL AT WRITE TIME, never a template resolved later (spec D2d). The
   * reason a customer is shown for a March award must still read as it did in
   * March after the shop renames the programme in June.
   */
  reason text NOT NULL,
  return_request_id text REFERENCES marketing_return_requests(id) ON DELETE RESTRICT,
  /* The shop's order id, no FK — see the file header. */
  order_id text,
  actor_type text NOT NULL,
  actor_id text,
  created_at bigint NOT NULL,
  CONSTRAINT marketing_ledger_email_ck
    CHECK (customer_email <> '' AND customer_email = lower(customer_email)),
  CONSTRAINT marketing_ledger_kind_ck
    CHECK (kind IN ('return_award', 'manual', 'redemption', 'redemption_release')),
  /* A zero-delta entry changes nothing and still has to be explained to somebody
   * reading their own history. */
  CONSTRAINT marketing_ledger_delta_ck CHECK (delta <> 0),
  CONSTRAINT marketing_ledger_balance_after_ck CHECK (balance_after >= 0),
  CONSTRAINT marketing_ledger_reason_ck CHECK (reason <> ''),
  CONSTRAINT marketing_ledger_actor_ck CHECK (actor_type IN ('admin', 'customer', 'system')),
  CONSTRAINT marketing_ledger_award_link_ck
    CHECK ((kind = 'return_award') = (return_request_id IS NOT NULL)),
  CONSTRAINT marketing_ledger_order_link_ck
    CHECK (kind NOT IN ('redemption', 'redemption_release') OR order_id IS NOT NULL),
  CONSTRAINT marketing_ledger_award_sign_ck
    CHECK (kind <> 'return_award' OR (delta > 0 AND program_id IS NOT NULL)),
  CONSTRAINT marketing_ledger_redemption_sign_ck CHECK (kind <> 'redemption' OR delta < 0),
  CONSTRAINT marketing_ledger_release_sign_ck
    CHECK (kind <> 'redemption_release' OR delta > 0)
);--> statement-breakpoint
/*
 * AWARDING A RETURN TWICE IS A 23505.
 *
 * PARTIAL, on `return_award` only: a manual adjustment made while looking at a
 * return may legitimately mention it, and a plain `UNIQUE (return_request_id)`
 * would forbid that. `returns/repo.ts` reads the violation back as
 * `409 already_awarded {entryId}`, which the client treats as SUCCESS — a
 * replayed inspect is a network retry, not an error.
 */
CREATE UNIQUE INDEX marketing_ledger_award_uq
  ON marketing_ledger (return_request_id) WHERE kind = 'return_award';--> statement-breakpoint
/*
 * ONE DEBIT PER ORDER, AND ONE COMPENSATING CREDIT PER ORDER — two indexes, not
 * one. A cancelled order that was paid for with points has BOTH: the redemption
 * and its release. A single `UNIQUE (order_id)` would make the release collide
 * with the debit it exists to undo.
 */
CREATE UNIQUE INDEX marketing_ledger_redemption_uq
  ON marketing_ledger (order_id) WHERE kind = 'redemption';--> statement-breakpoint
CREATE UNIQUE INDEX marketing_ledger_release_uq
  ON marketing_ledger (order_id) WHERE kind = 'redemption_release';--> statement-breakpoint
/* One customer's history, in the order the page reads it. */
CREATE INDEX marketing_ledger_customer_idx
  ON marketing_ledger (customer_email, created_at DESC, id DESC);--> statement-breakpoint

/*
 * THE BALANCE COUNTER — O(1), and maintained in the SAME STATEMENT as every
 * ledger insert.
 *
 * `SUM(delta)` over the ledger would be correct and would get slower forever, and
 * — the half that matters — it cannot be made safe against concurrent debits: two
 * requests both read a sum of 100, both decide 60 is affordable, both insert. The
 * debit here is instead
 * `UPDATE … SET balance = balance - $x WHERE customer_email = $e AND balance >= $x`
 * with the ledger INSERT selecting FROM that CTE, so the second one updates zero
 * rows and inserts nothing. The race is closed by construction rather than by a
 * lock.
 *
 * `CHECK (balance >= 0)` IS THE BACKSTOP UNDER THAT GUARD. It is what makes a
 * FUTURE debit written without the `balance >= $x` predicate fail loudly instead
 * of handing a customer a negative wallet.
 *
 * `lifetime_earned` IS NOT DERIVABLE FROM `balance` and is maintained alongside
 * it: it counts credits only, so a customer who earned 500 and spent 500 reads as
 * a loyal customer with an empty wallet rather than as a stranger.
 */
CREATE TABLE marketing_balances (
  customer_email text PRIMARY KEY,
  customer_id text,
  balance integer NOT NULL,
  lifetime_earned integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL,
  CONSTRAINT marketing_balances_email_ck
    CHECK (customer_email <> '' AND customer_email = lower(customer_email)),
  CONSTRAINT marketing_balances_balance_ck CHECK (balance >= 0),
  CONSTRAINT marketing_balances_lifetime_ck CHECK (lifetime_earned >= 0)
);--> statement-breakpoint

/*
 * THE NOTIFICATION OUTBOX, copied end to end from `shop_order_email_intents`.
 *
 * The intent is written in the SAME STATEMENT as the transition that owes it, and
 * delivery happens later from a sweeper. Sending inline is the failure this
 * exists to prevent: an inspection that genuinely happened must not be rolled
 * back because a mail provider was down, and warehouse staff must not wait on
 * SMTP with a customer in front of them.
 *
 * `subject`, `text` AND `html` ARE PRE-RENDERED AT WRITE TIME from the labels as
 * they read at that instant — the same snapshot rule as `email_broadcasts`, for
 * the reason `server/shop/orders/mailer.ts` states about order lines: an email is
 * where rendering from live data is most visible and least recoverable, because
 * the recipient keeps the message forever. Rename the programme afterwards and
 * the mail already queued still says what it promised.
 *
 * `text` IS A LEGAL COLUMN NAME and is used verbatim rather than renamed to
 * `text_body`, so the API field, the TypeScript field and the column are one word
 * in all three places — `email_templates` made the same call. It reads as a type
 * name inside a bare CHECK expression, so it is quoted where it appears in one.
 *
 * `dedupe_key` IS `'<kind>:<request_id>'` AND IT IS UNIQUE. The insert is
 * `ON CONFLICT (dedupe_key) DO NOTHING`, so a replayed inspect writes no second
 * row — one mail per outcome per return, as a constraint rather than as care.
 */
CREATE TABLE marketing_email_intents (
  id text PRIMARY KEY,
  kind text NOT NULL,
  return_request_id text NOT NULL REFERENCES marketing_return_requests(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  text text NOT NULL,
  html text NOT NULL,
  /* The CAS column. Two sweeps both read `attempts = n`, both try
   * `SET attempts = n + 1 WHERE attempts = n`, and exactly one matches — the
   * property a lease column is usually added for, from a column that had to
   * exist anyway (`server/shop/orders/repo/emails.ts` has the long version). */
  attempts integer NOT NULL DEFAULT 0,
  /* A provider's prose about the refusal, capped by the writer. NEVER the error
   * object: `server/db/client.ts` explains what those carry. */
  last_error text,
  sent_at bigint,
  created_at bigint NOT NULL,
  CONSTRAINT marketing_email_intents_dedupe_uq UNIQUE (dedupe_key),
  CONSTRAINT marketing_email_intents_kind_ck
    CHECK (kind IN ('return_awarded', 'return_rejected')),
  /* `server/mail/port.ts` states the rule this enforces at rest: "text and html
   * are both required: no client sees only one." */
  CONSTRAINT marketing_email_intents_bodies_ck
    CHECK (to_email <> '' AND subject <> '' AND "text" <> '' AND html <> ''),
  CONSTRAINT marketing_email_intents_attempts_ck CHECK (attempts >= 0)
);--> statement-breakpoint
/* The sweeper's driving predicate, and nothing else reads this table in bulk.
 * PARTIAL, because after a year of awards the unsent rows are a vanishing
 * fraction and a full index would carry every delivered row forever. */
CREATE INDEX marketing_email_intents_pending_idx
  ON marketing_email_intents (created_at, id) WHERE sent_at IS NULL;--> statement-breakpoint

/*
 * BANNERS — the only thing in this subsystem the public internet reads.
 *
 * SCHEDULING IS A WHERE CLAUSE AT READ TIME, NOT A JOB. `status = 'live' AND
 * (starts_at IS NULL OR starts_at <= now) AND (ends_at IS NULL OR ends_at > now)`
 * — so a banner starts and stops on the second it was told to with no cron
 * involved, which matters because both of the Hobby plan's daily cron slots are
 * already spent. The window CHECK exists because an inverted window can never
 * satisfy that predicate, and a banner that can never show is indistinguishable
 * from one that has not started yet.
 *
 * `cta_url ~ '^(https?://|/)'` IS A SECURITY CONSTRAINT, not tidiness. This table
 * is served by a cookieless public endpoint and rendered on the storefront; a
 * `javascript:` destination here is stored XSS with a publish button in front of
 * it. The pair CHECK is the smaller sibling: a label with no destination renders
 * as a dead button, and a destination with no label renders as nothing at all.
 *
 * THERE IS NO DELETE, ANYWHERE — `archived` is the third status, and the UI's
 * "Archive banner…" confirm is a status PATCH. A banner that ran is a record of
 * what the shop said in public.
 */
CREATE TABLE marketing_banners (
  id text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  cta_text text,
  cta_url text,
  placement text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  starts_at bigint,
  ends_at bigint,
  priority integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT marketing_banners_title_ck CHECK (title <> '' AND title = btrim(title)),
  CONSTRAINT marketing_banners_cta_url_ck
    CHECK (cta_url IS NULL OR cta_url ~ '^(https?://|/)'),
  CONSTRAINT marketing_banners_cta_pair_ck CHECK ((cta_text IS NULL) = (cta_url IS NULL)),
  CONSTRAINT marketing_banners_placement_ck
    CHECK (placement IN ('top_bar', 'popup', 'section')),
  CONSTRAINT marketing_banners_status_ck CHECK (status IN ('draft', 'live', 'archived')),
  CONSTRAINT marketing_banners_window_ck
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT marketing_banners_revision_ck CHECK (revision > 0)
);--> statement-breakpoint
/* The public route's whole query: the live rows for one placement, best first. */
CREATE INDEX marketing_banners_live_idx
  ON marketing_banners (status, placement, priority DESC);--> statement-breakpoint

/*
 * DISCOUNT CODES — the MODEL, ahead of the surface that will redeem them.
 *
 * v1 ships CRUD and nothing else: the Discounts screen is an honest placeholder
 * and `computeTotals` never sees these rows yet. The table exists now because the
 * shape is knowable now and because adding columns to a table with rows in it is
 * a migration, while an unused table costs nothing.
 *
 * `code = upper(code)` AT REST, with the route uppercasing before it validates.
 * 'SUMMER' and 'summer' as two rows is a customer typing one of them and being
 * told it does not exist. The 3..32 length and the character class are what make
 * a code speakable over a phone.
 */
CREATE TABLE marketing_discount_codes (
  id text PRIMARY KEY,
  code text NOT NULL,
  kind text NOT NULL,
  percent_bps integer,
  amount_minor integer,
  currency text,
  status text NOT NULL DEFAULT 'active',
  starts_at bigint,
  ends_at bigint,
  max_redemptions integer,
  redeemed_count integer NOT NULL DEFAULT 0,
  note text,
  revision integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT marketing_discount_codes_code_uq UNIQUE (code),
  CONSTRAINT marketing_discount_codes_code_ck
    CHECK (code = upper(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT marketing_discount_codes_kind_ck CHECK (kind IN ('percent', 'fixed_amount')),
  CONSTRAINT marketing_discount_codes_percent_ck
    CHECK (percent_bps IS NULL OR percent_bps BETWEEN 1 AND 10000),
  CONSTRAINT marketing_discount_codes_amount_ck CHECK (amount_minor IS NULL OR amount_minor > 0),
  CONSTRAINT marketing_discount_codes_currency_ck
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  /* Each kind is priced from its own columns and only its own: a percent
   * discount carrying an amount is two answers to "how much off". */
  CONSTRAINT marketing_discount_codes_kind_fields_ck
    CHECK (((kind = 'percent') = (percent_bps IS NOT NULL))
           AND ((kind = 'fixed_amount') = (amount_minor IS NOT NULL AND currency IS NOT NULL))),
  CONSTRAINT marketing_discount_codes_status_ck CHECK (status IN ('active', 'disabled')),
  CONSTRAINT marketing_discount_codes_window_ck
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT marketing_discount_codes_max_redemptions_ck
    CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  CONSTRAINT marketing_discount_codes_redeemed_count_ck CHECK (redeemed_count >= 0),
  CONSTRAINT marketing_discount_codes_revision_ck CHECK (revision > 0)
);--> statement-breakpoint

/*
 * THE SEEDS. Both are `ON CONFLICT … DO NOTHING`, and that clause is the whole
 * rename-safety story (spec D2b): `db:migrate` is run BY HAND against a live
 * database — nothing applies migrations on deploy — and a healed or replayed
 * ledger can re-issue a file that already ran. `DO NOTHING` makes the second run
 * a no-op; `DO UPDATE` would resurrect the preset's original wording over a
 * rename the shop made months ago, which is the exact failure the design spends
 * four mechanisms preventing.
 *
 * ⚠️  THE BUSINESS NUMBERS BELOW ARE PLACEHOLDERS AWAITING THE OWNER'S REVIEW:
 *     five units minimum per request, ten points per accepted unit, and a
 *     redemption rate of "100 points are worth 0 kobo". All four are editable in
 *     the UI on day one, and the Overview's first-run checklist points at them.
 *     Redemption ships DISABLED with a zero money rate deliberately — the
 *     `marketing_settings_enabled_rate_ck` above then makes it impossible to turn
 *     on until somebody sets a real rate, so a forgotten review costs copy rather
 *     than money.
 *
 * The timestamps are FIXED AUTHORING-TIME CONSTANTS rather than a clock read. A
 * seed stamped `now()` makes two databases disagree about when the shop opened,
 * and makes this file's output depend on when it ran.
 *
 * `revision = 1` is load-bearing: the Overview checklist reads "the preset has
 * never been edited" as `revision === 1`, so the seed must start there and the
 * first PATCH must move it.
 */
INSERT INTO marketing_programs
  (id, key, kind, name, points_label_singular, points_label_plural,
   unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
   status, conditions, seeded, revision, created_at, updated_at)
VALUES ('prg_seed_unit_returns', 'spool-return', 'unit_return', 'Spool Returns',
        'Spool Point', 'Spool Points', 'spool', 'spools', 5, 10,
        'active', '{}', true, 1, 1786600001000, 1786600001000)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint
/*
 * `default_return_program_id` resolves through a SCALAR SUBQUERY ON `key`, not
 * through the literal id above. If the program insert was skipped because a row
 * with that key already existed — the whole point of `DO NOTHING` — the pointer
 * must land on the row that IS there, whatever id and whatever name it now
 * carries.
 */
INSERT INTO marketing_settings
  (id, points_label_singular, points_label_plural, redemption_enabled,
   redemption_rate_points, redemption_rate_minor, redemption_currency,
   min_redeem_points, max_redeem_bps, default_return_program_id, revision, updated_at)
VALUES ('main', 'Spool Point', 'Spool Points', false,
        100, 0, 'NGN',
        0, 10000, (SELECT id FROM marketing_programs WHERE key = 'spool-return'),
        1, 1786600001000)
ON CONFLICT (id) DO NOTHING;
