-- CHECKOUT ADD-ONS (range 0940-0959; spec 2026-09-06, owner's answers the same day).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is: drizzle-kit
-- has never seen these tables and can neither generate nor undo this DDL.
--
-- An add-on is an extra offered at checkout -- a gift box, packaging -- with a
-- picture, a name, a sentence, a price and RULES that decide per cart whether
-- the shopper is asked, or the add-on is included automatically, or nothing is
-- offered. The rules are jsonb, validated by the admin route's Zod against a
-- registry in shared/commerce/add-ons.ts; the database checks only the shape.
--
-- THREE OWNERS, THREE PIECES, ONE FILE. Catalog owns the model (shop_add_ons);
-- Cart owns the shopper's answers (shop_carts.add_on_choices, on the cart row
-- for the reason 0820 put the discount code there -- the freeze reads it beside
-- the lines it prices); Orders owns the snapshot (shop_orders.add_on_total and
-- shop_order_add_ons, a table and not a jsonb column because packers read it,
-- the email lists it, and "how many took the gift box" is a count).
--
-- NOT TAXED, so there is no tax column anywhere here (owner's decision).

CREATE TABLE "shop_add_ons" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	-- Short plain text. NULL is none; '' is refused below so two spellings of
	-- "no description" cannot exist.
	"description" text,
	-- images.id. NO FK, exactly as shop_products.cover_image_id: the images
	-- table is the blog's. server/repo/images.ts#REFERENCE_SET unions this
	-- column so the orphan sweep keeps the picture.
	"image_id" text,
	-- Minor units. 0 is legal ("free, want it?").
	"price_minor" integer NOT NULL,
	"currency" text NOT NULL,
	-- draft = being written, never offered; active = offered; archived = withdrawn, kept for its orders.
	"status" text NOT NULL,
	-- Ordered AddOnRule[]. The first rule that fits decides.
	"rules" jsonb NOT NULL,
	-- The order add-ons are offered in.
	"position" integer NOT NULL DEFAULT 0,
	-- CAS, as products.
	"revision" integer NOT NULL DEFAULT 1,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shop_add_ons_title_ck" CHECK ("title" <> ''),
	CONSTRAINT "shop_add_ons_description_ck" CHECK ("description" IS NULL OR "description" <> ''),
	CONSTRAINT "shop_add_ons_price_ck" CHECK ("price_minor" >= 0),
	CONSTRAINT "shop_add_ons_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "shop_add_ons_status_ck" CHECK ("status" IN ('draft','active','archived')),
	CONSTRAINT "shop_add_ons_rules_ck" CHECK (jsonb_typeof("rules") = 'array'),
	CONSTRAINT "shop_add_ons_revision_ck" CHECK ("revision" > 0)
);

--> statement-breakpoint
CREATE INDEX "shop_add_ons_active_idx" ON "shop_add_ons" ("position") WHERE "status" = 'active';

--> statement-breakpoint
-- THE SHOPPER'S ANSWERS: { "<addOnId>": "accepted" | "declined" }. NULL is the
-- ordinary cart. Declines are stored too: the storefront must not ask twice.
ALTER TABLE "shop_carts" ADD COLUMN "add_on_choices" jsonb;

--> statement-breakpoint
ALTER TABLE "shop_carts" ADD CONSTRAINT "shop_carts_add_on_choices_ck"
  CHECK ("add_on_choices" IS NULL OR jsonb_typeof("add_on_choices") = 'object');

--> statement-breakpoint
-- Completes the identity the order columns state:
-- grand = subtotal - discount + adjustments + add_ons + shipping + tax.
-- DEFAULT 0 is what every existing order meant.
ALTER TABLE "shop_orders" ADD COLUMN "add_on_total" integer NOT NULL DEFAULT 0;

--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_add_on_total_ck" CHECK ("add_on_total" >= 0);

--> statement-breakpoint
CREATE TABLE "shop_order_add_ons" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL REFERENCES "shop_orders"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	-- The snapshot key. NO FK: the add-on may be archived later and the order must still say what it carried.
	"add_on_id" text NOT NULL,
	"title" text NOT NULL,
	-- chosen = the shopper said yes; included = a rule put it on.
	"mode" text NOT NULL,
	-- What was charged; 0 when the rule made it free.
	"amount" integer NOT NULL,
	-- The add-on's price at the time.
	"list_price" integer NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "shop_order_add_ons_mode_ck" CHECK ("mode" IN ('chosen','included')),
	CONSTRAINT "shop_order_add_ons_amount_ck" CHECK ("amount" >= 0 AND "list_price" >= 0),
	CONSTRAINT "shop_order_add_ons_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "shop_order_add_ons_position_uq" UNIQUE ("order_id", "position")
);

--> statement-breakpoint
CREATE INDEX "shop_order_add_ons_add_on_idx" ON "shop_order_add_ons" ("add_on_id");
