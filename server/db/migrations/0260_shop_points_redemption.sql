-- SPOOLPOINTS REDEMPTION, CARRIED FROM THE FREEZE TO THE CAPTURE (range
-- 0260-0279, admin#2).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen these tables and can neither generate nor undo this DDL.
--
-- WHY THESE FOUR COLUMNS EXIST AT ALL.
--
-- Spending points at checkout produces an `Adjustment` — `{ code, label,
-- amount }` — which is all `FrozenTotals` and the `checkout.completed` payload
-- can carry, because both are frozen shapes that the browser bundle also
-- compiles. `PointsRedemptionPort.redeem()` needs the integer POINT COUNT, and
-- there is nowhere in those shapes to put it.
--
-- The count also has to survive a long trip. It is decided at the freeze, and
-- it is spent at the capture — freeze → payment → webhook → outbox → sweep →
-- order — and the first moment an `orderId` exists is at the far end of it.
-- Re-deriving the count from the discount amount would mean inverting the
-- conversion rate at redeem time, against a `marketing_settings` row an
-- operator may have edited in between. What was quoted is what must be spent,
-- so the number is stored rather than recomputed — the same argument
-- `frozen_totals` itself makes.
--
-- WHY IT IS ON BOTH TABLES AND NOT JOINED. `shop_carts` is where the freeze
-- writes it, in the same statement that writes `frozen_totals`, so a discount
-- and its point count cannot disagree. `shop_orders` is where the capture reads
-- it. Orders may not read Cart's tables (contract §2), and an event payload is
-- required to be self-sufficient (`shared/commerce/events.ts`), so the value is
-- copied across on `checkout.completed` exactly as the frozen lines are.
--
-- NULL IS THE ORDINARY CASE and means "no points were spent on this checkout" —
-- a guest, a signed-out shopper, redemption switched off, or a balance that
-- bought nothing. It is not a defaulted zero: zero points would be a redemption
-- of nothing, and the CHECK below refuses it so the two states cannot blur.
--
-- THE EMAIL IS STORED BESIDE THE COUNT rather than read from the order at
-- redeem time. Balances are email-keyed, and `shop_orders.email` is the address
-- the RECEIPT goes to — today they are the same address, but nothing enforces
-- that and a customer changing their contact email between the freeze and the
-- capture would otherwise have the points taken from a different wallet than
-- the one that was quoted.

ALTER TABLE "shop_carts"
  /* Integer point count quoted at the freeze. NULL means no redemption. */
  ADD COLUMN "redemption_points" integer,
  /* Lowercase; the wallet the quote was taken against. */
  ADD COLUMN "redemption_email" text;

--> statement-breakpoint
ALTER TABLE "shop_orders"
  ADD COLUMN "redemption_points" integer,
  ADD COLUMN "redemption_email" text;

--> statement-breakpoint
/*
 * BOTH COLUMNS OR NEITHER, and a positive count when present.
 *
 * A point count with no wallet cannot be redeemed and a wallet with no count
 * cannot be either; both halves are written by one statement, so a row holding
 * one of them is a bug rather than a state. Stated as a CHECK because the
 * alternative is every reader re-testing the pair and one of them eventually
 * not.
 *
 * `> 0` rather than `>= 0` for the reason in the header: `quote()` already
 * answers null rather than zero when a balance buys nothing, so a stored zero
 * could only come from a caller that ignored it.
 */
ALTER TABLE "shop_carts"
  ADD CONSTRAINT "shop_carts_redemption_ck" CHECK (
    ("redemption_points" IS NULL AND "redemption_email" IS NULL)
    OR ("redemption_points" > 0 AND "redemption_email" <> '')
  );

--> statement-breakpoint
ALTER TABLE "shop_orders"
  ADD CONSTRAINT "shop_orders_redemption_ck" CHECK (
    ("redemption_points" IS NULL AND "redemption_email" IS NULL)
    OR ("redemption_points" > 0 AND "redemption_email" <> '')
  );

--> statement-breakpoint
/*
 * THE RECONCILIATION INDEX, and it is the D9 decision made findable.
 *
 * A quote does not RESERVE (spec D9), so a balance can fall between the freeze
 * and the capture. When it does, the order is created and paid at the total the
 * customer agreed to and the shop absorbs the discount — recorded, not silently
 * dropped. Finding those orders afterwards means asking "which paid orders
 * carry a point count", which without this index is a sequential scan of every
 * order the shop has ever taken.
 *
 * PARTIAL, because the ordinary order spends no points and indexing its NULL
 * would be indexing the whole table to find the exceptions.
 */
CREATE INDEX "shop_orders_redemption_idx"
  ON "shop_orders" ("redemption_email")
  WHERE "redemption_points" IS NOT NULL;
