-- DISCOUNT CODES, CARRIED FROM THE CART TO THE CAPTURE (range 0820-0839,
-- admin#100 Part B, storefront#113).
--
-- HAND-WRITTEN IN FULL, for the reason every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen these tables and can neither generate nor undo this DDL.
--
-- WHAT WAS ALREADY HERE. `marketing_discount_codes` has existed since range
-- 0000 with the model and staff CRUD only; its own repo header says so — "the
-- MODEL, ahead of the surface that will redeem them" — and `redeemed_count` has
-- been 0 on every row because nothing could write it. This migration is that
-- surface's storage.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THE CODE IS ON BOTH TABLES AND NOT JOINED — the same three-line argument
-- 0260 makes for the point count, and it has not changed.
--
-- `shop_carts` is where the shopper applies it and where the freeze re-reads it
-- in the same statement that writes `frozen_totals`, so a total and the code
-- that produced it cannot disagree. `shop_orders` is where the capture reads
-- it: Orders may not read Cart's tables (contract §2), and an event payload is
-- required to be self-sufficient (`shared/commerce/events.ts`), so the value is
-- copied across on `checkout.completed` exactly as the frozen lines are.
--
-- NO FOREIGN KEY TO `marketing_discount_codes`, deliberately, and 0260 set this
-- precedent too: the shop stores FACTS, not references across the marketing
-- seam. A code is unique by `marketing_discount_codes_code_uq`, so the text is
-- a sufficient key — and storing the text means a receipt can still name what
-- was applied even if the campaign row is one day archived.
--
-- NULL IS THE ORDINARY CASE and means no code was applied. Not a defaulted
-- empty string: '' would be a code nobody typed, and the CHECK below refuses it
-- so the two states cannot blur.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "shop_carts"
  /* Uppercase at rest, matching `marketing_discount_codes.code`. NULL means no
     code is applied to this cart. */
  ADD COLUMN "discount_code" text;

--> statement-breakpoint
ALTER TABLE "shop_orders"
  ADD COLUMN "discount_code" text,
  /*
   * WHAT THE CODE ACTUALLY TOOK OFF, in POSITIVE minor units, after the clamp.
   *
   * ON THE ORDER AND NOT LOOKED UP, and contract §2 is the whole reason. The
   * capture counts the use at `payment.captured`, which is a different event
   * from the one that created the order — so the consumer has no checkout
   * payload in hand at that moment, and Orders may not read `shop_carts` to go
   * and find one. The number travels on the event and lands here, exactly as
   * `redemption_points` does one migration range over.
   *
   * It is also not derivable from `grand_total`: shipping, tax, the bulk ladder
   * and a points adjustment are all in that figure too.
   */
  ADD COLUMN "discount_amount_minor" integer;

--> statement-breakpoint
/*
 * A CODE THAT IS PRESENT IS A CODE SOMEBODY TYPED.
 *
 * '' is refused rather than treated as absent: two spellings of "no code" would
 * mean every reader testing for both, and one of them eventually not. Length is
 * bounded at the same 64 the model's own column is, so a cart cannot hold a
 * string no discount row could ever match.
 */
ALTER TABLE "shop_carts"
  ADD CONSTRAINT "shop_carts_discount_code_ck" CHECK (
    "discount_code" IS NULL OR ("discount_code" <> '' AND length("discount_code") <= 64)
  );

--> statement-breakpoint
/*
 * BOTH COLUMNS OR NEITHER, and a non-negative amount when present — the shape
 * `shop_carts_redemption_ck` uses for the point count and its wallet.
 *
 * Zero IS allowed here, unlike the point count: a percent code on a cart of
 * free items really does take nothing off, and that is a use of the code rather
 * than an absent one. What must not exist is an amount with no code to explain
 * it, or a code with no record of what it cost.
 */
ALTER TABLE "shop_orders"
  ADD CONSTRAINT "shop_orders_discount_code_ck" CHECK (
    ("discount_code" IS NULL AND "discount_amount_minor" IS NULL)
    OR ("discount_code" <> '' AND length("discount_code") <= 64
        AND "discount_amount_minor" >= 0)
  );

--> statement-breakpoint
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROW PER ORDER THAT SPENT A CODE — AND THE WHOLE REASON IT EXISTS IS THAT
 * `redeemed_count` IS A BARE COUNTER.
 *
 * The owner's decision (2026-09-02) is that a code counts as redeemed when the
 * money arrives, not when it is typed: an abandoned checkout must not
 * permanently burn one use of a limited code. So the increment runs in the
 * orders consumer on `payment.captured`, beside `spendPoints`.
 *
 * That path REPLAYS. Paystack redelivers, webhooks retry, and the sweep drains
 * to a fixed point — so `UPDATE ... SET redeemed_count = redeemed_count + 1`
 * would count one order twice and eventually refuse a code that had uses left.
 * A counter cannot be made idempotent by a route that checks first, because two
 * passes can both check before either writes.
 *
 * This table makes it idempotent BY INDEX instead, which is the shape
 * `marketing_ledger_redemption_uq` already uses one subsystem over: the insert
 * carries the increment, a replay violates the primary key, and the second pass
 * is a no-op with every guard in the consumer deleted.
 *
 * THE PRIMARY KEY IS `(order_id)` ALONE, not `(discount_id, order_id)`. An
 * order has at most one code by construction — `shop_orders.discount_code` is a
 * single column — so a composite key would permit a second row naming a
 * different discount for the same order, which is precisely the state that
 * must be unrepresentable. `discount_id` is carried for the join and indexed
 * separately for "how many times has SUMMER been used".
 * ═══════════════════════════════════════════════════════════════════════════
 */
CREATE TABLE "marketing_discount_redemptions" (
	-- The order that spent it. THE IDEMPOTENCY KEY — see the header.
	"order_id" text PRIMARY KEY NOT NULL,
	-- `marketing_discount_codes.id`. Text rather than a FK, for the same reason
	-- the columns above carry no FK: this table is written by the shop's
	-- consumer and read by marketing, and neither owns the other's rows.
	"discount_id" text NOT NULL,
	-- What was typed, frozen. The code is immutable by construction
	-- (`patchDiscount` has no SET clause for it), but the ROW can be archived,
	-- and a reconciliation that could not name the code would be useless.
	"code" text NOT NULL,
	-- The customer's order number (`2026-000009-D`), so a human reconciling a
	-- campaign reads the reference the shopper was given rather than an internal
	-- id. The same split `0740_ledger_reason_order_number.sql` made.
	"order_number" text NOT NULL,
	-- Minor units, POSITIVE — what the code actually took off this order, after
	-- the clamp. Stored because it is what a campaign's cost is measured in, and
	-- re-deriving it would mean re-running the allocation against a cart that no
	-- longer exists.
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	-- Epoch ms, never timestamptz.
	"redeemed_at" bigint NOT NULL,
	CONSTRAINT "marketing_discount_redemptions_amount_ck" CHECK ("amount_minor" >= 0),
	CONSTRAINT "marketing_discount_redemptions_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "marketing_discount_redemptions_code_ck" CHECK ("code" <> ''),
	CONSTRAINT "marketing_discount_redemptions_order_number_ck" CHECK ("order_number" <> '')
);

--> statement-breakpoint
/*
 * "HOW MANY TIMES HAS THIS CODE BEEN USED", without a sequential scan of every
 * redemption the shop has ever made. Also the index the cap check reads: a
 * `max_redemptions` that cost a full scan would be a limit nobody could afford
 * to enforce on the checkout's hottest path.
 */
CREATE INDEX "marketing_discount_redemptions_discount_idx"
  ON "marketing_discount_redemptions" ("discount_id");
