-- 0120 — Cart + Checkout (commerce contract §4, brief 02 §2–§5).
--
-- HAND-WRITTEN IN FULL, and that is in-rule rather than a shortcut.
-- `drizzle.config.ts` sets one condition on hand-written migrations: they may
-- only touch objects drizzle-kit cannot model. Every table below lives in
-- `server/db/commerce-schema.ts`, which is NOT in the `schema` path of
-- `drizzle.config.ts` — so drizzle-kit has never seen these objects, cannot
-- diff them, and cannot emit DDL to undo them. Wiring commerce into the config
-- instead would put four concurrently-generating agents into one snapshot
-- chain that already skips 0001 (see the config's second warning), which is a
-- much worse failure than writing the DDL out by hand.
--
-- Because nothing typechecks this file, `server/shop/cart/schema.test.ts` reads
-- the shape back out of `information_schema` and `pg_constraint` and compares
-- it against the declarations in `commerce-schema.ts`. Contract §8 requires a
-- test that the DDL is APPLIED, not merely present here.
--
-- Three things drizzle-kit could not express even if it were pointed at these
-- tables, listed so a later reader knows they are deliberate:
--   * the partial index `shop_reservations_sweep_idx ... WHERE state = 'held'`
--   * the partial index `commerce_events_pending_idx ... WHERE processed_at IS NULL`
--   * every `CHECK` below, because `.$type<>()` is compile-time only (contract §4)

CREATE TABLE shop_customers (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" bigint NOT NULL,
	-- Postgres permits many NULLs in a UNIQUE column but exactly ONE empty
	-- string, so `''` would make the SECOND guest-turned-account row fail with a
	-- raw 23505 nobody expects. `posts.slug` has the identical trap and
	-- `normaliseSlug` handles it in TypeScript; here it is also refused by the
	-- database, so no future caller can reintroduce it.
	CONSTRAINT "shop_customers_email_ck" CHECK ("email" IS NULL OR "email" <> ''),
	CONSTRAINT "shop_customers_email_uq" UNIQUE ("email")
);
--> statement-breakpoint
-- The stored id is an HMAC-SHA-256 of the token under SESSION_SECRET, hex, never
-- the raw token — the same construction `server/repo/users.ts` uses and for the
-- same reason: a bare digest is offline-computable, so a stolen database dump
-- could be attacked with a precomputed table and the winning row replayed.
CREATE TABLE shop_customer_sessions (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	CONSTRAINT "shop_customer_sessions_customer_fk" FOREIGN KEY ("customer_id")
		REFERENCES shop_customers("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "shop_customer_sessions_customer_idx" ON shop_customer_sessions ("customer_id");
--> statement-breakpoint
CREATE TABLE shop_carts (
	"id" text PRIMARY KEY NOT NULL,
	-- NULLABLE, and contract §7 makes that load-bearing: a cart exists before any
	-- identity does. SET NULL rather than CASCADE — deleting a customer must not
	-- destroy the cart rows an order was built from.
	"customer_id" text,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	-- Guest contact. Snapshotted into `checkout.completed` so Orders never has to
	-- call back into Cart for it (brief §7).
	"email" text,
	"shipping_option_id" text,
	"tax_zone" text,
	-- THE FROZEN TOTALS, STORED. `CheckoutPort.totals()` reads this column and
	-- never recomputes (brief §5): a totals function re-run at capture time is a
	-- system that can charge a number the customer never saw.
	"frozen_totals" jsonb,
	-- The GOODS, frozen at the same instant as the money. `frozen_totals.lines`
	-- is money-only by design (the totals engine is pure and must not need a
	-- product title to do its arithmetic), but an order line needs a SKU, a
	-- title and an option tuple — and Catalog may rename or discontinue the
	-- variant tomorrow. Captured here from the same `CatalogPort.quote()` calls
	-- that produced the prices, so the two can never disagree.
	"frozen_lines" jsonb,
	"frozen_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "shop_carts_customer_fk" FOREIGN KEY ("customer_id")
		REFERENCES shop_customers("id") ON DELETE SET NULL,
	CONSTRAINT "shop_carts_status_ck" CHECK ("status" IN ('open','converting','converted','abandoned')),
	CONSTRAINT "shop_carts_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "shop_carts_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
	-- Frozen totals and the instant they were frozen arrive together or not at
	-- all. Half of a freeze is a cart that claims a price with no record of when
	-- it was struck, or a timestamp with no price.
	CONSTRAINT "shop_carts_frozen_ck" CHECK (
		("frozen_totals" IS NULL AND "frozen_lines" IS NULL AND "frozen_at" IS NULL)
		OR ("frozen_totals" IS NOT NULL AND "frozen_lines" IS NOT NULL
		    AND "frozen_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "shop_carts_customer_idx" ON shop_carts ("customer_id");
--> statement-breakpoint
CREATE TABLE shop_cart_lines (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	-- DELIBERATELY NOT A FOREIGN KEY (contract §2 R3, brief §3). `shop_variants`
	-- belongs to Catalog; a cross-subsystem FK turns a catalog cleanup into a
	-- cart failure, and ON DELETE CASCADE across the boundary would let Catalog
	-- silently empty somebody's basket. Variants resolve through
	-- `CatalogPort.quote()` at read time and an unresolvable line renders as "no
	-- longer available" rather than vanishing.
	"variant_id" text NOT NULL,
	"qty" integer NOT NULL,
	"added_at" bigint NOT NULL,
	-- NO PRICE COLUMN, ON PURPOSE. A cart shows live prices; only an order
	-- snapshots them. There is a test that fails if one is ever added.
	CONSTRAINT "shop_cart_lines_cart_fk" FOREIGN KEY ("cart_id")
		REFERENCES shop_carts("id") ON DELETE CASCADE,
	CONSTRAINT "shop_cart_lines_qty_ck" CHECK ("qty" > 0),
	CONSTRAINT "shop_cart_lines_cart_variant_uq" UNIQUE ("cart_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE shop_reservations (
	-- The id IS the idempotency key Catalog keys on (brief §4).
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"qty" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "shop_reservations_cart_fk" FOREIGN KEY ("cart_id")
		REFERENCES shop_carts("id") ON DELETE CASCADE,
	CONSTRAINT "shop_reservations_qty_ck" CHECK ("qty" > 0),
	CONSTRAINT "shop_reservations_state_ck" CHECK ("state" IN ('held','released','committed','expired'))
);
--> statement-breakpoint
-- PARTIAL, on the only rows the sweeper ever looks at. A plain index on
-- `expires_at` would carry every settled reservation forever; this one holds
-- only the live holds, which is a set bounded by the checkout TTL.
CREATE INDEX "shop_reservations_sweep_idx" ON shop_reservations ("expires_at") WHERE "state" = 'held';
--> statement-breakpoint
CREATE INDEX "shop_reservations_cart_idx" ON shop_reservations ("cart_id");
--> statement-breakpoint
CREATE TABLE shop_addresses (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text,
	"country_code" text NOT NULL,
	"phone" text,
	CONSTRAINT "shop_addresses_cart_fk" FOREIGN KEY ("cart_id")
		REFERENCES shop_carts("id") ON DELETE CASCADE,
	CONSTRAINT "shop_addresses_kind_ck" CHECK ("kind" IN ('shipping','billing')),
	-- ISO-3166-1 alpha-2. The shipping zone and therefore the tax rate are
	-- derived from this, so a lowercase or three-letter code would silently pick
	-- the fallback zone and charge the wrong tax.
	CONSTRAINT "shop_addresses_country_ck" CHECK ("country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "shop_addresses_cart_kind_uq" UNIQUE ("cart_id","kind")
);
--> statement-breakpoint
-- THE SHARED OUTBOX (contract §6). `IF NOT EXISTS` because four subsystems are
-- built concurrently and every one of them needs this table: whichever
-- migration lands first creates it and the rest are no-ops. That is the only
-- honest way to express "shared, append-only, owned by nobody" in a numbered
-- migration sequence — see AMENDMENTS A-002.
CREATE TABLE IF NOT EXISTS commerce_events (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" bigint NOT NULL,
	-- NULL until a consumer has handled it. A failed consumer marks `last_error`
	-- and leaves this NULL; it does not delete and does not retry in a tight loop
	-- (contract §6 rule 3, GAUNTLET I Round 1 #2).
	"processed_at" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_events_pending_idx" ON commerce_events ("occurred_at") WHERE "processed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commerce_events_subject_idx" ON commerce_events ("subject_id","occurred_at");
