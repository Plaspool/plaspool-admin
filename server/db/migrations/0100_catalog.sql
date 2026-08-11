-- 0100 — Catalog: products, variants, prices, inventory (contract §4, brief 01 §2).
--
-- HAND-WRITTEN IN FULL, AND THAT IS IN-RULE RATHER THAN A SHORTCUT.
-- `drizzle.config.ts` sets one condition on hand-written migrations: they may
-- only touch objects drizzle-kit cannot model. Every table below is declared in
-- `server/db/commerce-schema.ts`, which is deliberately NOT in the `schema` path
-- of `drizzle.config.ts` — so drizzle-kit has never seen these objects, cannot
-- diff them against a snapshot, and cannot emit DDL to undo them.
--
-- The alternative was measured rather than assumed. Pointing the config at
-- `commerce-schema.ts` and running `drizzle-kit generate` against a copy of this
-- folder produced a migration numbered from the JOURNAL'S LENGTH, i.e. `0005`
-- — not `0100`. Contract §8 allocates `0100`–`0119` to Catalog, `0120`–`0139`
-- to Cart and so on precisely so four concurrent agents do not collide in the
-- journal, and generation cannot honour that allocation.
--
-- Nothing typechecks this file, so `server/shop/catalog/schema-parity.test.ts`
-- reads the shape back out of `information_schema`, `pg_constraint`,
-- `pg_indexes` and `pg_trigger` and reconciles it against the declarations in
-- `commerce-schema.ts`. Contract §8 requires a test that the DDL is APPLIED,
-- not merely present here.
--
-- Four things drizzle-kit could not express even if it were pointed at these
-- tables, listed so a later reader knows they are deliberate:
--   * the `BEFORE UPDATE` trigger maintaining `shop_products.lifecycle_generation`
--   * the partial unique index `shop_prices_current_uq … WHERE effective_to IS NULL`
--   * the partial index `commerce_events_pending_idx … WHERE processed_at IS NULL`
--   * every `CHECK` below, because `.$type<>()` is compile-time only (contract §4)

CREATE TABLE shop_products (
	"id" text PRIMARY KEY NOT NULL,
	-- Nullable AND unique, exactly as `posts.slug` is: a UNIQUE column cannot
	-- hold twenty empty strings but Postgres permits many NULLs, so drafts hold
	-- NULL until titled or published.
	"slug" text,
	"title" text NOT NULL,
	"description" jsonb NOT NULL,
	"description_text" text NOT NULL,
	"status" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"cover_image_id" text,
	"image_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"published_at" bigint,
	"deleted_at" bigint,
	"author_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"lifecycle_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shop_products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "shop_products_status_ck" CHECK ("status" IN ('draft', 'active', 'archived')),
	CONSTRAINT "shop_products_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "shop_products_author_id_users_id_fk" FOREIGN KEY ("author_id")
		REFERENCES users("id")
);
--> statement-breakpoint
CREATE INDEX "shop_products_status_updated_idx" ON shop_products ("status","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "shop_products_deleted_idx" ON shop_products ("deleted_at");--> statement-breakpoint
CREATE INDEX "shop_products_category_idx" ON shop_products ("category");--> statement-breakpoint
CREATE INDEX "shop_products_author_idx" ON shop_products ("author_id");--> statement-breakpoint

-- THE LIFECYCLE GENERATION TRIGGER.
--
-- GAUNTLET II Part 2b finding #1 is the single most important thing in this
-- repository's history, and this is the mechanism that answers it. A lifecycle
-- op re-reads and re-bases on every retry; a precondition over CURRENT STATE
-- ALONE cannot distinguish "never left draft" from "was archived and restored
-- to draft", so a concurrent INVERSE op returns the row to a state the
-- precondition accepts and the retry silently re-applies an intent a human had
-- deliberately undone. Measured on `posts`: a `trash` that lost to a concurrent
-- trash-then-restore re-trashed the post, `emptyTrash` then hard-deleted it, and
-- `ON DELETE CASCADE` took every revision. Post destroyed, revisions 0.
--
-- WHY A TRIGGER AND NOT `lifecycle_generation = lifecycle_generation + 1` IN THE
-- REPOSITORY. A counter the application increments is only honest about writes
-- that went through the application, and a CAS predicate must not depend on
-- that: an import, a backfill, a stock reconciliation script or a hand-run
-- UPDATE moves `deleted_at` without going anywhere near
-- `server/shop/catalog/products.ts`. Here the database owns the column outright
-- — it is recomputed from OLD on every UPDATE, so it cannot be set, skipped or
-- faked by any writer. The prescribed fix in Part 2b was an application counter;
-- the builder proved it did not pass the brief's own reproduction and replaced
-- it with this. Copied rather than re-derived, for that reason.
--
-- WHAT MOVES IT: `status`, `published_at`, `deleted_at`. Those three and no
-- others, so an ordinary content edit — which sets none of them, deliberately,
-- so a PATCH body cannot smuggle a status change past the lifecycle rules —
-- leaves the generation alone and a lifecycle retry racing a content save still
-- wins and re-derives.
CREATE OR REPLACE FUNCTION shop_products_bump_lifecycle_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status, NEW.published_at, NEW.deleted_at)
     IS DISTINCT FROM (OLD.status, OLD.published_at, OLD.deleted_at) THEN
    NEW.lifecycle_generation := OLD.lifecycle_generation + 1;
  ELSE
    NEW.lifecycle_generation := OLD.lifecycle_generation;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_products_lifecycle_generation ON shop_products;--> statement-breakpoint
CREATE TRIGGER shop_products_lifecycle_generation
  BEFORE UPDATE ON shop_products
  FOR EACH ROW EXECUTE FUNCTION shop_products_bump_lifecycle_generation();--> statement-breakpoint

CREATE TABLE shop_product_revisions (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"author_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" jsonb NOT NULL,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	CONSTRAINT "shop_product_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "shop_product_revisions_kind_ck" CHECK ("kind" IN ('edit', 'status')),
	CONSTRAINT "shop_product_revisions_product_id_fk" FOREIGN KEY ("product_id")
		REFERENCES shop_products("id") ON DELETE CASCADE,
	CONSTRAINT "shop_product_revisions_author_id_fk" FOREIGN KEY ("author_id")
		REFERENCES users("id")
);
--> statement-breakpoint
-- THE PRODUCTION BACKSTOP FOR THE CAS WRITE PATH. Unreachable through the CAS as
-- written — the revision row is inserted by `SELECT … FROM upd`, so a losing CAS
-- inserts nothing at all — but PGlite has one connection and proves nothing
-- about real parallelism, where two writers can reach the same revision number
-- even though the row-level CAS decided one of them lost. That IS a lost CAS,
-- whichever layer notices it, so the repository maps this violation onto the
-- same 409 rather than letting it escape as a 500.
CREATE UNIQUE INDEX "shop_product_revisions_uq" ON shop_product_revisions ("product_id","revision");--> statement-breakpoint

CREATE TABLE shop_variants (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"sku" text NOT NULL,
	"option_values" jsonb NOT NULL,
	"position" integer NOT NULL,
	"weight_grams" integer,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shop_variants_sku_unique" UNIQUE("sku"),
	CONSTRAINT "shop_variants_status_ck" CHECK ("status" IN ('active', 'discontinued')),
	CONSTRAINT "shop_variants_position_ck" CHECK ("position" >= 0),
	CONSTRAINT "shop_variants_weight_ck" CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0),
	CONSTRAINT "shop_variants_product_id_fk" FOREIGN KEY ("product_id")
		REFERENCES shop_products("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "shop_variants_product_idx" ON shop_variants ("product_id","position");--> statement-breakpoint

CREATE TABLE shop_prices (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	-- MINOR UNITS. `integer`, never `numeric` and never a float: contract §10
	-- says integer minor units plus a currency code, and a `numeric` column would
	-- invite a fractional penny that `shared/commerce/money.ts` cannot represent.
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"effective_from" bigint NOT NULL,
	"effective_to" bigint,
	"created_at" bigint NOT NULL,
	-- A price may be zero (a free sample) but never negative. `Money` permits a
	-- negative amount because a refund IS one; a catalogue price is not.
	CONSTRAINT "shop_prices_amount_ck" CHECK ("amount" >= 0),
	CONSTRAINT "shop_prices_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "shop_prices_window_ck" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
	CONSTRAINT "shop_prices_variant_id_fk" FOREIGN KEY ("variant_id")
		REFERENCES shop_variants("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "shop_prices_variant_idx" ON shop_prices ("variant_id","effective_from" DESC);--> statement-breakpoint
-- AT MOST ONE CURRENT PRICE PER VARIANT, AS A DATABASE PROPERTY.
--
-- `effective_to IS NULL` means current. Without this, two concurrent price
-- changes both close the old row, both insert a new one, and `quote()` starts
-- depending on which row the planner happened to return — a variant with two
-- current prices is a shop that charges different customers differently for
-- reasons nobody can reconstruct. Partial, so superseded rows are unconstrained
-- and the price history stays unbounded, which is the entire point of
-- effective-dating (brief §2).
CREATE UNIQUE INDEX "shop_prices_current_uq" ON shop_prices ("variant_id") WHERE "effective_to" IS NULL;--> statement-breakpoint

CREATE TABLE shop_inventory (
	"variant_id" text PRIMARY KEY NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer NOT NULL,
	"backorderable" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	-- The backstop, not the mechanism: `reserve` refuses in its own conditional
	-- statement. These exist so a backfill, an import or a hand-run UPDATE cannot
	-- leave a negative count that every read afterwards quietly believes.
	--
	-- NOTE `reserved` MAY EXCEED `on_hand` AND THAT IS NOT AN ERROR: a
	-- backorderable variant is deliberately sold past zero available, so a check
	-- demanding `reserved <= on_hand` would refuse the feature.
	CONSTRAINT "shop_inventory_on_hand_ck" CHECK ("on_hand" >= 0),
	CONSTRAINT "shop_inventory_reserved_ck" CHECK ("reserved" >= 0),
	CONSTRAINT "shop_inventory_variant_id_fk" FOREIGN KEY ("variant_id")
		REFERENCES shop_variants("id") ON DELETE CASCADE
);
--> statement-breakpoint

-- CATALOG'S OWN RECORD OF A HOLD — see amendment A-CAT-002. Contract §4 has no
-- row for this table, and brief §5 requires two things that jointly demand one:
-- `reservationId` is the idempotency key and must be enforced "with a unique
-- row, not with a JS check on a prior read", and release/commit must be
-- idempotent and safe in either order after expiry. The only row carrying that
-- otherwise is `shop_reservations`, which R3 makes Cart's alone.
--
-- NOT a second `shop_reservations`: no cart, no customer, no expiry policy and
-- no sweeper. The count is Catalog's and the clock is Cart's.
CREATE TABLE shop_inventory_holds (
	-- CALLER-SUPPLIED, and the primary key IS the idempotency enforcement.
	"reservation_id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"qty" integer NOT NULL,
	"state" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shop_inventory_holds_state_ck" CHECK ("state" IN ('held', 'released', 'committed')),
	CONSTRAINT "shop_inventory_holds_qty_ck" CHECK ("qty" > 0),
	CONSTRAINT "shop_inventory_holds_variant_id_fk" FOREIGN KEY ("variant_id")
		REFERENCES shop_variants("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "shop_inventory_holds_variant_idx" ON shop_inventory_holds ("variant_id","state");--> statement-breakpoint

-- THE SHARED OUTBOX (contract §6). Created here only so `0100` is self-
-- sufficient: `0120_cart_checkout.sql` and `0140_payments.sql` also create it,
-- every one of them with `IF NOT EXISTS`, because four subsystems are built
-- concurrently and all four need the table.
--
-- ⚠️  ONLY THE FIRST MIGRATION'S DDL SURVIVES, AND IT SURVIVES SILENTLY.
--     Measured in PGlite (amendment A-CAT-003):
--
--       * `CREATE INDEX IF NOT EXISTS commerce_events_subject_idx ON (subject_id)`
--         against an existing index of that NAME on `(subject_id, occurred_at)`
--         keeps the existing one and reports nothing at all;
--       * `CREATE TABLE IF NOT EXISTS … CONSTRAINT commerce_events_attempts_ck
--         CHECK (attempts >= 0)` against the existing table creates NO CHECK —
--         `pg_constraint` came back empty.
--
--     So a difference between two agents' copies of this block is resolved in
--     favour of whichever migration ran first, which on a fresh database is
--     decided by journal order and on an existing one by deployment history.
--     Catalog therefore contributes the COLUMN LIST (identical in all three) and
--     exactly one index under a name no other subsystem uses. It deliberately
--     does NOT re-issue `commerce_events_pending_idx` or
--     `commerce_events_subject_idx`: those names are already claimed with
--     definitions that differ between 0120 and `commerce-schema.ts`, and adding
--     a third variant would make the outcome depend on ordering in one more
--     place without fixing any of them.
CREATE TABLE IF NOT EXISTS commerce_events (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" bigint NOT NULL,
	"processed_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_events_type_idx" ON commerce_events ("type");
