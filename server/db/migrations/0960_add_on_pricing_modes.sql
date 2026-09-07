-- ADD-ON PRICING MODES (range 0960-0979; owner's answers 2026-09-07).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is: drizzle-kit
-- has never seen these tables and can neither generate nor undo this DDL.
--
-- 0940 shipped add-ons that could only ADD money, once per order. Two things
-- were asked for on top:
--
--   1. A CHARGE PER ITEM, not only per order. "A box costs 500" means 500 for
--      each item in the cart, not 500 for the cart. That is a rule-level basis
--      -- order or item -- in the jsonb, so no column here; what IS here is the
--      order snapshot's copy of it, so a packing slip can print "4 x 500".
--
--   2. TAKING SOMETHING OUT OF A PRICE THAT ALREADY CARRIES IT. The box is
--      inside the filament's price already. A shopper who does not want four
--      boxes removes them and SAVES 4 x 500 -- so an add-on's amount can now be
--      NEGATIVE, and three CHECK constraints written when it could not are
--      relaxed below. That is the whole reason this migration exists.
--
-- STILL NOT TAXED, in either direction (owner, 2026-09-07). A removal takes
-- exactly its face value off the bill and does not reduce the taxable base, the
-- same rule 0940 set for a charge. The alternative -- refunding the 7.5% the
-- shopper paid on the box as part of the goods -- means allocating a cart-level
-- amount across differently-taxed lines with remainder handling, which is the
-- machinery CLAUDE.md section 6 reserves for a real cart-wide coupon. It is not
-- bought here for 150 naira on a 2,000 naira saving.
--
-- NOTHING IS BACKFILLED AND NOTHING NEEDS TO BE. Every existing rule means
-- basis = order, and an absent key in jsonb already reads that way in
-- shared/commerce/add-ons.ts (basisFor). The three new columns take defaults
-- that say the same thing about every order already placed.

-- Was >= 0. An order whose add-ons net out negative is a shopper who took more
-- packaging out than they put in, which is now an ordinary outcome.
ALTER TABLE "shop_orders" DROP CONSTRAINT "shop_orders_add_on_total_ck";

--> statement-breakpoint
-- Was amount >= 0 AND list_price >= 0. list_price KEEPS its floor: it is what
-- one of the thing is worth, and nothing is worth less than nothing. Only the
-- charged amount may go below zero.
ALTER TABLE "shop_order_add_ons" DROP CONSTRAINT "shop_order_add_ons_amount_ck";

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD CONSTRAINT "shop_order_add_ons_list_price_ck"
  CHECK ("list_price" >= 0);

--> statement-breakpoint
-- 'removed' joins 'chosen' and 'included': the shopper took it out of a price
-- that already had it in. It is the ONLY mode whose amount may be negative, and
-- the pairing is checked rather than left to the writer -- a 'chosen' add-on
-- with a negative amount would be money leaving the shop for no stated reason.
ALTER TABLE "shop_order_add_ons" DROP CONSTRAINT "shop_order_add_ons_mode_ck";

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD CONSTRAINT "shop_order_add_ons_mode_ck"
  CHECK ("mode" IN ('chosen','included','removed'));

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD CONSTRAINT "shop_order_add_ons_amount_sign_ck"
  CHECK ("amount" >= 0 OR "mode" = 'removed');

--> statement-breakpoint
-- THE SNAPSHOT'S ARITHMETIC, so "why is this minus 2,000?" is answerable a year
-- later from the row itself rather than from a rules document nobody kept. Same
-- reason FrozenTotals carries its own derivation.
--
-- Signed, so amount = unit_amount * units holds on the face of it. DEFAULT 0 is
-- wrong for no existing row: every order placed before today has exactly one
-- unit of each add-on, and the backfill below sets unit_amount to the amount
-- that was charged, which for units = 1 is the same number.
ALTER TABLE "shop_order_add_ons" ADD COLUMN "unit_amount" integer NOT NULL DEFAULT 0;

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD COLUMN "units" integer NOT NULL DEFAULT 1;

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD COLUMN "basis" text NOT NULL DEFAULT 'order';

--> statement-breakpoint
-- Every row that exists was charged once for the whole order.
UPDATE "shop_order_add_ons" SET "unit_amount" = "amount" WHERE "unit_amount" = 0;

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD CONSTRAINT "shop_order_add_ons_units_ck"
  CHECK ("units" >= 0);

--> statement-breakpoint
ALTER TABLE "shop_order_add_ons" ADD CONSTRAINT "shop_order_add_ons_basis_ck"
  CHECK ("basis" IN ('order','item'));
