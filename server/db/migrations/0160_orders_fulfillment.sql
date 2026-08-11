-- ORDERS + FULFILLMENT (contract §8 range 0160–0179, brief `04` §2).
--
-- HAND-WRITTEN IN FULL, AND THAT IS SANCTIONED RATHER THAN LAZY. Two facts make
-- it the only option:
--
--  1. `drizzle.config.ts` declares `schema: './server/db/schema.ts'` and nothing
--     else, so `server/db/commerce-schema.ts` is invisible to drizzle-kit. It
--     cannot generate these tables, and — the half that matters — it will never
--     emit DDL to undo them either, which is exactly the rule
--     `server/db/migrations.test.ts` states: a hand-written migration may only
--     touch objects drizzle-kit cannot model.
--  2. Contract §8 allocates this subsystem the tags `0160`–`0179`. `drizzle-kit
--     generate` numbers sequentially from the journal (the next one it would mint
--     is `0005`), so an allocated range and a generated file cannot both happen.
--
-- Everything below is therefore hand-appended by definition, and `0160_snapshot`
-- deliberately does not exist. The DDL is asserted to be APPLIED — not merely
-- present in this file — by `server/shop/orders/schema.test.ts`, which reads it
-- back out of `pg_catalog` on a migrated database (contract §8's last sentence).

-- ------------------------------------------------------------ commerce_events
--
-- SHARED, APPEND-ONLY, AND CREATED `IF NOT EXISTS` ON PURPOSE.
--
-- Contract §4 names `commerce_events` "shared" and gives it no owning
-- subsystem, while §8 allocates a private migration range to each of the four
-- agents. Those two together have no consistent reading: whichever of the four
-- migrations runs first has to create the table and the other three must not
-- fail trying. `IF NOT EXISTS` is what makes the DDL commutative, so the four
-- migrations can land in any order.
--
-- The columns are §6's, exactly. If another subsystem's migration creates a
-- DIFFERENT shape first, this statement silently does nothing — which is why
-- `schema.test.ts` asserts every column and type back out of the catalog rather
-- than trusting that this file ran. A divergence must be loud, and an
-- `IF NOT EXISTS` on its own is the quietest possible failure.
CREATE TABLE IF NOT EXISTS commerce_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at bigint NOT NULL,
  processed_at bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);--> statement-breakpoint
/*
 * NOT PARTIAL ON `processed_at IS NULL`, and that is not an oversight —
 * `0120_cart_checkout` already creates exactly that index. This consumer's
 * candidate set is "events with no row in `shop_order_event_consumptions` for
 * consumer `orders`" (§6 rule 2), so a partial index keyed on the shared
 * `processed_at` column cannot serve it. What the sweeper needs is the total
 * order it walks in, which is this.
 */
CREATE INDEX IF NOT EXISTS commerce_events_occurred_idx
  ON commerce_events (occurred_at, id);--> statement-breakpoint

-- ------------------------------------------------------- order number sequence
--
-- A POSTGRES SEQUENCE, NEVER `MAX(order_number) + 1` (brief §3).
--
-- The `MAX(…)+1` shape is the same race GAUNTLET II Part 2a measured on slugs:
-- every concurrent writer reads the same taken set and picks the same next
-- candidate. At N=25 that produced 22 failures. `nextval` is atomic, never
-- returns a value twice, and — the property that makes it usable here — does not
-- roll back, so a lost insert burns a number rather than handing it to somebody
-- else. Gaps in an invoice sequence are ordinary; a duplicate is not.
CREATE SEQUENCE IF NOT EXISTS shop_order_number_seq AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint

-- ------------------------------------------------------------------ shop_orders
--
-- THE FROZEN TOTALS ARE COPIED, NEVER DERIVED (brief §2). `subtotal`,
-- `shipping_total`, `tax_total` and `grand_total` arrive on `checkout.completed`
-- and are written verbatim. There is deliberately no
-- `CHECK (grand_total = subtotal + shipping_total + tax_total)`: this subsystem
-- does not own the totals engine, and a constraint asserting somebody else's
-- arithmetic turns a legitimate future adjustment line into "a paid checkout
-- that cannot become an order" — the worst failure available here.
--
-- `customer_id` AND `checkout_id` ARE NOT FOREIGN KEYS. Contract §2 R3: no
-- cross-subsystem foreign keys. `shop_customers` belongs to Cart, and an FK to
-- it would make Orders undeployable until Cart's migration had run and would let
-- a Cart-side delete decide whether a financial record may exist.
CREATE TABLE shop_orders (
  id text PRIMARY KEY,
  /* Customer-facing (brief §3). `2026-000042-K`. */
  order_number text NOT NULL,
  /* NULL for a guest order, which is the default path (contract §7). */
  customer_id text,
  /* Always present, guest or not: it is where the confirmation goes. */
  email text NOT NULL,
  currency text NOT NULL,
  subtotal integer NOT NULL,
  shipping_total integer NOT NULL,
  tax_total integer NOT NULL,
  grand_total integer NOT NULL,
  /*
   * Cumulative refunded amount in minor units, accumulated from
   * `payment.refunded`. It exists because the `refunded` / `partially_refunded`
   * decision (brief §4) is "per amount", and the amounts live in `shop_refunds`
   * — Payments' table, which R3 forbids this subsystem from reading. The only
   * honest source is the events actually received, so they are added up here.
   */
  refunded_total integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  /* SNAPSHOTS, not references (brief §2). A customer editing their saved
   * address must not retroactively change where a shipped order went. */
  shipping_address jsonb NOT NULL,
  billing_address jsonb NOT NULL,
  placed_at bigint NOT NULL,
  paid_at bigint,
  fulfilled_at bigint,
  cancelled_at bigint,
  /* The CAS token, as on `posts`. */
  revision integer NOT NULL,
  /* The LIFECYCLE CAS token. Owned by the trigger below; see its comment. */
  lifecycle_generation integer NOT NULL DEFAULT 0,
  /*
   * The `checkout.completed` that made this order, and the checkout it was
   * about. BOTH are UNIQUE and both are load-bearing, because they stop
   * different things:
   *
   *  - `source_event_id` stops the SAME event row being applied twice
   *    (brief §4's named backstop).
   *  - `checkout_id` stops TWO DIFFERENT events for one checkout — a provider
   *    or an operator re-emitting `checkout.completed` under a fresh id, which
   *    `source_event_id` cannot see at all.
   *
   * Enforced by the constraints below and never by a prior read: a read decides
   * against a snapshot that a concurrent writer has already invalidated, which
   * is the whole of GAUNTLET II Part 2b's finding.
   */
  source_event_id text NOT NULL,
  checkout_id text NOT NULL,
  /*
   * The payment intent, remembered from the first `payment.*` event seen.
   *
   * IT EXISTS ONLY SO `PaymentPort.status(db, intentId)` CAN BE CALLED. Brief `04`'s
   * header says Orders consumes that port "read-only, for display", and the port is
   * keyed on an intent id — which no `shop_orders` column held, so the dependency was
   * unreachable. Not an FK (R3: `shop_payment_intents` is Payments'), not in the
   * lifecycle trigger's watched set (it is not a state), and written with
   * `COALESCE(payment_intent_id, …)` so the FIRST intent seen wins: a retried payment
   * under a second intent must not silently re-point an order at a different charge.
   */
  payment_intent_id text,
  CONSTRAINT shop_orders_order_number_uq UNIQUE (order_number),
  CONSTRAINT shop_orders_source_event_uq UNIQUE (source_event_id),
  CONSTRAINT shop_orders_checkout_uq UNIQUE (checkout_id),
  /* Every enum-ish column carries a check: `.$type<>()` is compile-time only. */
  CONSTRAINT shop_orders_status_ck CHECK (
    status IN ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded', 'partially_refunded')
  ),
  /* ISO-4217 as a SHAPE, matching `shared/commerce/money.ts`: it is what stops
   * 'gbp' and 'GBP ' becoming two currencies that never add up. */
  CONSTRAINT shop_orders_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT shop_orders_revision_ck CHECK (revision > 0),
  CONSTRAINT shop_orders_refunded_ck CHECK (refunded_total >= 0),
  CONSTRAINT shop_orders_email_ck CHECK (length(email) > 0)
);--> statement-breakpoint
CREATE INDEX shop_orders_customer_idx ON shop_orders (customer_id, placed_at DESC, id);--> statement-breakpoint
CREATE INDEX shop_orders_status_idx ON shop_orders (status, placed_at DESC, id);--> statement-breakpoint
/* The guest lookup is scoped by `lower(email)` IN THE SQL (brief §6), so the
 * index has to be on the same expression or that scoping is a sequential scan. */
CREATE INDEX shop_orders_email_idx ON shop_orders (lower(email));--> statement-breakpoint

-- ------------------------------------------------------------- shop_order_lines
--
-- `ON DELETE RESTRICT`, NOT `CASCADE` (brief §2, and it is the single most
-- important word in this file).
--
-- Cascade is right everywhere else in this codebase — `revisions` cascade from
-- `posts`, `sessions` from `users`. Here it is wrong, and GAUNTLET II Part 2b's
-- worst finding is why: a re-applied `trash` reached `emptyTrash`, which
-- hard-deleted the post, and `ON DELETE CASCADE` took every revision with it.
-- Post destroyed, revisions 0. An order is a financial record; `RESTRICT` means
-- a `DELETE FROM shop_orders` fails with 23503 for as long as one line exists,
-- i.e. forever. Cancellation is a status, never a row removal.
--
-- EVERY FIELD HERE IS A SNAPSHOT. `sku`, `title`, `option_values`,
-- `unit_amount`, `line_total`. Rendering an order by joining `shop_variants`
-- silently rewrites history the first time somebody renames a product, and it
-- does it without an error anywhere.
CREATE TABLE shop_order_lines (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
  /* Stable display order, and a stable handle for a fulfilment request. */
  line_no integer NOT NULL,
  /* Not an FK: `shop_variants` is Catalog's (contract §2 R3). */
  variant_id text NOT NULL,
  sku text NOT NULL,
  title text NOT NULL,
  option_values jsonb NOT NULL,
  qty integer NOT NULL,
  unit_amount integer NOT NULL,
  line_total integer NOT NULL,
  /*
   * THE OVER-FULFILMENT BOUND, MATERIALISED SO IT CAN BE DECLARATIVE.
   *
   * Brief §2 requires "sum per orderLine can never exceed the line's qty.
   * Enforce in SQL." A `CHECK` cannot aggregate across rows and a trigger that
   * runs `SELECT sum(qty) …` cannot either: under READ COMMITTED two concurrent
   * inserts each read a set that does not yet contain the other's row, both
   * pass, and the line ships twice.
   *
   * Kept as a counter on THIS row instead, maintained by
   * `shop_fulfillment_lines_apply_qty` below. The trigger's
   * `UPDATE … SET fulfilled_qty = fulfilled_qty + NEW.qty` takes a row lock, so
   * a second concurrent fulfilment BLOCKS, then re-evaluates against the
   * committed value and violates the CHECK. The bound is decided by a
   * constraint, on a value nobody can read stale.
   */
  fulfilled_qty integer NOT NULL DEFAULT 0,
  CONSTRAINT shop_order_lines_order_line_uq UNIQUE (order_id, line_no),
  CONSTRAINT shop_order_lines_qty_ck CHECK (qty > 0),
  CONSTRAINT shop_order_lines_line_no_ck CHECK (line_no >= 0),
  CONSTRAINT shop_order_lines_fulfilled_ck CHECK (fulfilled_qty >= 0 AND fulfilled_qty <= qty)
);--> statement-breakpoint
CREATE INDEX shop_order_lines_order_idx ON shop_order_lines (order_id, line_no);--> statement-breakpoint

-- ----------------------------------------------------------- shop_fulfillments
--
-- PARTIAL FULFILMENT IS REAL (brief §2): an order can have several, and each
-- covers some quantity of some lines.
CREATE TABLE shop_fulfillments (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
  status text NOT NULL,
  carrier text,
  tracking_number text,
  shipped_at bigint,
  delivered_at bigint,
  created_at bigint NOT NULL,
  revision integer NOT NULL,
  /* Its own lifecycle CAS token: a re-applied `ship` is a double shipment. */
  lifecycle_generation integer NOT NULL DEFAULT 0,
  CONSTRAINT shop_fulfillments_status_ck CHECK (
    status IN ('pending', 'shipped', 'delivered', 'cancelled')
  ),
  CONSTRAINT shop_fulfillments_revision_ck CHECK (revision > 0)
);--> statement-breakpoint
CREATE INDEX shop_fulfillments_order_idx ON shop_fulfillments (order_id, created_at);--> statement-breakpoint

CREATE TABLE shop_fulfillment_lines (
  id text PRIMARY KEY,
  fulfillment_id text NOT NULL REFERENCES shop_fulfillments(id) ON DELETE RESTRICT,
  order_line_id text NOT NULL REFERENCES shop_order_lines(id) ON DELETE RESTRICT,
  qty integer NOT NULL,
  /* One row per (fulfilment, line): two rows for the same pair would be a
   * second bite at the same quantity that reads as two separate lines. */
  CONSTRAINT shop_fulfillment_lines_pair_uq UNIQUE (fulfillment_id, order_line_id),
  CONSTRAINT shop_fulfillment_lines_qty_ck CHECK (qty > 0)
);--> statement-breakpoint
CREATE INDEX shop_fulfillment_lines_line_idx ON shop_fulfillment_lines (order_line_id);--> statement-breakpoint

-- ----------------------------------------------------------- shop_order_events
--
-- Customer-visible history. `actor_id` is TEXT WITH NO FOREIGN KEY to `users`
-- deliberately: contract §3 lists `users` as read-only and never modified, and
-- an FK is a constraint added to that table. It would also make an order's
-- history unwritable — and the order undeletable in a way nobody intended — the
-- day an account is removed.
CREATE TABLE shop_order_events (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
  type text NOT NULL,
  message text NOT NULL,
  occurred_at bigint NOT NULL,
  actor_id text,
  CONSTRAINT shop_order_events_type_ck CHECK (
    type IN ('placed', 'payment_authorized', 'payment_failed', 'paid',
             'fulfillment_created', 'shipped', 'delivered',
             'fulfillment_cancelled', 'cancelled', 'refunded')
  )
);--> statement-breakpoint
CREATE INDEX shop_order_events_order_idx ON shop_order_events (order_id, occurred_at, id);--> statement-breakpoint

-- ---------------------------------------------------- shop_order_email_intents
--
-- THE EMAIL OUTBOX (brief §5). The intent is written in the SAME STATEMENT as
-- the state change that caused it, and delivery happens later from a sweeper.
--
-- Sending inline is the failure this exists to prevent: a paid order must not
-- depend on an email provider being up, and a send failure must not roll back a
-- capture that genuinely happened. `sent_at`/`attempts`/`last_error` are the
-- same three columns `commerce_events` uses, for the same reason.
CREATE TABLE shop_order_email_intents (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at bigint NOT NULL,
  sent_at bigint,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  /*
   * "One confirmation per order", "one shipment mail per fulfilment", as a
   * CONSTRAINT. `confirmation:ord_…`, `shipment:ful_…`, `cancellation:ord_…`,
   * `refund:ord_…:evt_…`. A redelivered event that somehow reached the write
   * path twice writes one row, not two mails to a customer.
   */
  dedupe_key text NOT NULL,
  CONSTRAINT shop_order_email_intents_dedupe_uq UNIQUE (dedupe_key),
  CONSTRAINT shop_order_email_intents_kind_ck CHECK (
    kind IN ('confirmation', 'shipment', 'cancellation', 'refund')
  )
);--> statement-breakpoint
/* The sweeper's driving predicate, and nothing else reads this table in bulk. */
CREATE INDEX shop_order_email_intents_pending_idx
  ON shop_order_email_intents (created_at, id) WHERE sent_at IS NULL;--> statement-breakpoint

-- ---------------------------------------------- shop_order_event_consumptions
--
-- IDEMPOTENCY, KEYED ON `(consumer, event_id)` — contract §6 rule 2, as a
-- PRIMARY KEY rather than as a convention.
--
-- WHY THIS AND NOT `commerce_events.processed_at`. That column is one column on
-- a shared table, so it cannot represent "consumer A is done and consumer B is
-- not" — and §6 rule 2 explicitly anticipates more than one consumer. This
-- table is the authority for THIS consumer; `processed_at` is maintained
-- alongside it as the shared, advisory signal §6 describes.
--
-- It is also what makes the dispatch statement idempotent BY CONSTRAINT: the
-- claim is `INSERT … ON CONFLICT DO NOTHING RETURNING event_id`, and every
-- downstream CTE selects FROM that claim. A redelivery inserts nothing, so the
-- claim returns no rows, so the state change has nothing to act on and does not
-- happen. No prior read is involved anywhere.
CREATE TABLE shop_order_event_consumptions (
  consumer text NOT NULL,
  event_id text NOT NULL,
  handled_at bigint NOT NULL,
  outcome text NOT NULL,
  detail text,
  CONSTRAINT shop_order_event_consumptions_pk PRIMARY KEY (consumer, event_id),
  CONSTRAINT shop_order_event_consumptions_outcome_ck CHECK (
    /*
     * - applied   — the state changed.
     * - ignored   — an event type this consumer does not handle (§6 rule 4), or
     *               a payload it can never apply. Recorded so it is never
     *               re-examined.
     * - abandoned — parked too many times. See `PARK_ATTEMPT_LIMIT`.
     *
     * A PARKED event has NO ROW HERE AT ALL, which is what makes it retryable:
     * the sweeper's candidate set is "events with no consumption row".
     */
    outcome IN ('applied', 'ignored', 'abandoned')
  )
);--> statement-breakpoint

-- ============================================================ TRIGGERS
--
-- Everything below is a trigger, i.e. an object drizzle-kit cannot model at all.
-- Migration 0003 established the precedent and the reasoning; the failure mode
-- prevented here is strictly worse than it was for posts.

-- ---------------------------------------- shop_orders.lifecycle_generation
--
-- THE ANSWER GAUNTLET II PART 2b BOUGHT, TRANSPLANTED (brief §1).
--
-- A predicate over CURRENT STATE alone cannot distinguish "never left `paid`"
-- from "was cancelled and put back to `paid`" — the row looks identical. So a
-- lifecycle retry whose precondition is `status = 'paid'` re-applies an intent
-- the caller had already lost. For posts that ended in a destroyed row with zero
-- surviving revisions. Here:
--
--   * a re-applied CANCEL, after an operator deliberately reinstated the order,
--     is a PAID ORDER THAT NEVER SHIPS;
--   * a re-applied FULFIL is a DOUBLE SHIPMENT.
--
-- WHY A TRIGGER AND NOT A COUNTER THE REPOSITORY INCREMENTS. Part 2b records
-- that the prescribed application-maintained version DID NOT PASS THE BRIEF'S
-- OWN REPRODUCTION, because raw `UPDATE` statements never go through the
-- transition function. That is not a corner case here: reinstating a
-- wrongly-cancelled order, correcting a status after a provider dispute, and
-- importing historical orders are all hand-run SQL, and every one of them must
-- move this column or the pin is pinned to a lie. The database owns it outright
-- — it is recomputed from OLD on every UPDATE, so it cannot be set, skipped or
-- faked by any writer, including this repository.
--
-- WHAT MOVES IT: `status`, `paid_at`, `fulfilled_at`, `cancelled_at`,
-- `refunded_total`. Those and no others — so a change to a shipping address
-- snapshot or a `revision` bump from some future non-lifecycle write leaves it
-- alone and a lifecycle retry racing one still wins.
CREATE OR REPLACE FUNCTION shop_orders_bump_lifecycle_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.paid_at, NEW.fulfilled_at, NEW.cancelled_at, NEW.refunded_total)
     IS DISTINCT FROM
     (OLD.status, OLD.paid_at, OLD.fulfilled_at, OLD.cancelled_at, OLD.refunded_total) THEN
    NEW.lifecycle_generation := OLD.lifecycle_generation + 1;
  ELSE
    NEW.lifecycle_generation := OLD.lifecycle_generation;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_orders_lifecycle_generation ON shop_orders;--> statement-breakpoint
CREATE TRIGGER shop_orders_lifecycle_generation
  BEFORE UPDATE ON shop_orders
  FOR EACH ROW EXECUTE FUNCTION shop_orders_bump_lifecycle_generation();--> statement-breakpoint

-- ------------------------------------ shop_fulfillments.lifecycle_generation
--
-- The same mechanism on the fulfilment, because the fulfilment has its own
-- A→B→A: `pending → shipped → (operator corrects it back to) pending`. A `ship`
-- that lost that race and retried against `status = 'pending'` would send a
-- second tracking email and mark a second shipment against the same lines.
CREATE OR REPLACE FUNCTION shop_fulfillments_bump_lifecycle_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.shipped_at, NEW.delivered_at)
     IS DISTINCT FROM (OLD.status, OLD.shipped_at, OLD.delivered_at) THEN
    NEW.lifecycle_generation := OLD.lifecycle_generation + 1;
  ELSE
    NEW.lifecycle_generation := OLD.lifecycle_generation;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_fulfillments_lifecycle_generation ON shop_fulfillments;--> statement-breakpoint
CREATE TRIGGER shop_fulfillments_lifecycle_generation
  BEFORE UPDATE ON shop_fulfillments
  FOR EACH ROW EXECUTE FUNCTION shop_fulfillments_bump_lifecycle_generation();--> statement-breakpoint

-- ------------------------------------------------ the order line is immutable
--
-- ENFORCED IN THE DATABASE, BECAUSE "IMMUTABLE" IN A COMMENT IS NOT A
-- CONSTRAINT. `ON DELETE RESTRICT` stops the order being deleted out from under
-- its lines; nothing else stopped a line being edited in place, and an edited
-- `unit_amount` is a rewritten invoice.
--
-- `fulfilled_qty` IS THE ONE COLUMN THAT MAY MOVE, and it is deliberately on
-- this row rather than in a side table: the over-fulfilment bound has to be a
-- `CHECK` against `qty`, and a CHECK can only see its own row. So the guard
-- compares the SNAPSHOT TUPLE and ignores the counter.
CREATE OR REPLACE FUNCTION shop_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shop_order_lines is append-only: an order is a financial record'
      USING ERRCODE = 'ORD01';
  END IF;
  IF (NEW.id, NEW.order_id, NEW.line_no, NEW.variant_id, NEW.sku, NEW.title,
      NEW.option_values, NEW.qty, NEW.unit_amount, NEW.line_total)
     IS DISTINCT FROM
     (OLD.id, OLD.order_id, OLD.line_no, OLD.variant_id, OLD.sku, OLD.title,
      OLD.option_values, OLD.qty, OLD.unit_amount, OLD.line_total) THEN
    RAISE EXCEPTION 'an order line snapshot is immutable; only fulfilled_qty may change'
      USING ERRCODE = 'ORD01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_order_lines_immutable ON shop_order_lines;--> statement-breakpoint
CREATE TRIGGER shop_order_lines_immutable
  BEFORE UPDATE OR DELETE ON shop_order_lines
  FOR EACH ROW EXECUTE FUNCTION shop_order_lines_guard();--> statement-breakpoint

/* The same, with no exception at all: a fulfilment line is written once. A
 * correction is a new fulfilment, or a cancelled one — both of which leave the
 * record of what was attempted intact. */
CREATE OR REPLACE FUNCTION shop_fulfillment_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shop_fulfillment_lines is append-only: cancel the fulfillment instead'
    USING ERRCODE = 'ORD02';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_fulfillment_lines_immutable ON shop_fulfillment_lines;--> statement-breakpoint
CREATE TRIGGER shop_fulfillment_lines_immutable
  BEFORE UPDATE OR DELETE ON shop_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION shop_fulfillment_lines_guard();--> statement-breakpoint

-- -------------------------------------------- the over-fulfilment bound, applied
--
-- Two invariants, both in the database, because both are cross-row and neither
-- can be a CHECK on its own:
--
--  1. **The bound.** `fulfilled_qty + NEW.qty` is written to the order line, so
--     `shop_order_lines_fulfilled_ck` decides whether it fits. The UPDATE takes
--     a row lock, so concurrent fulfilments of one line serialise and the second
--     re-evaluates against the first's committed value rather than against a
--     snapshot taken before it existed.
--  2. **A fulfilment cannot reach across orders.** Nothing in the two foreign
--     keys says the order line belongs to the fulfilment's own order, so a bug
--     in the admin route could ship customer A's item against customer B's
--     order — and both FKs would be satisfied. Checked here because it is a
--     relationship between three rows, which is not expressible as a CHECK.
CREATE OR REPLACE FUNCTION shop_fulfillment_lines_apply_qty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM shop_fulfillments f
      JOIN shop_order_lines ol ON ol.order_id = f.order_id
     WHERE f.id = NEW.fulfillment_id AND ol.id = NEW.order_line_id
  ) THEN
    RAISE EXCEPTION 'fulfillment line references an order line from a different order'
      USING ERRCODE = 'ORD04';
  END IF;

  UPDATE shop_order_lines
     SET fulfilled_qty = fulfilled_qty + NEW.qty
   WHERE id = NEW.order_line_id;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_fulfillment_lines_apply ON shop_fulfillment_lines;--> statement-breakpoint
CREATE TRIGGER shop_fulfillment_lines_apply
  AFTER INSERT ON shop_fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION shop_fulfillment_lines_apply_qty();--> statement-breakpoint

-- ------------------------------------------- cancelling a fulfilment gives it back
--
-- A cancelled fulfilment releases the quantity it was holding, or the lines it
-- covered could never be fulfilled again — a mis-keyed carrier would strand the
-- goods permanently.
--
-- AND A CANCELLED FULFILMENT IS TERMINAL. Un-cancelling would have to re-take
-- the quantity, and by then another fulfilment may hold it; the honest answer to
-- "I cancelled the wrong one" is a new fulfilment, which leaves both records
-- intact. Refused here rather than in the repository, so an import cannot do it
-- either.
CREATE OR REPLACE FUNCTION shop_fulfillments_release_qty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled fulfillment is terminal: create a new one instead'
      USING ERRCODE = 'ORD05';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE shop_order_lines ol
       SET fulfilled_qty = ol.fulfilled_qty - fl.qty
      FROM shop_fulfillment_lines fl
     WHERE fl.fulfillment_id = NEW.id AND ol.id = fl.order_line_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_fulfillments_release ON shop_fulfillments;--> statement-breakpoint
CREATE TRIGGER shop_fulfillments_release
  AFTER UPDATE ON shop_fulfillments
  FOR EACH ROW EXECUTE FUNCTION shop_fulfillments_release_qty();
