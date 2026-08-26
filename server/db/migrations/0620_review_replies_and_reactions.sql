-- REVIEW REPLIES AND REACTIONS (range 0620-0639; owner's queue, 2026-08-27).
--
-- HAND-WRITTEN IN FULL — `drizzle.config.ts` declares only `server/db/schema.ts`,
-- so drizzle-kit has never seen `server/shop/reviews/schema.ts`. The DDL is
-- asserted to be APPLIED, not merely present here, by `schema.test.ts`.

-- ═══════════════════════════════════════════════════════════════════════════
-- REPLIES. Two levels and no more: a reply to a review, and a reply to that.
--
-- DEPTH IS STORED, NOT WALKED. Deriving it by following `parent_id` upward
-- costs a recursive CTE on every read and, worse, makes "is this too deep"
-- a question the application asks instead of one the database refuses. The
-- column plus the pairing check below makes an over-deep row unstorable.
--
-- THE PAIRING IS THE POINT: depth 0 means top level and therefore no parent;
-- depth 1 means a parent exists. Either column alone is satisfiable by a row
-- that makes no sense — a depth-0 row with a parent, a depth-1 orphan — and
-- both of those render as a broken thread rather than as an error.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "shop_review_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	-- NULL is a top-level reply. Self-referential, so deleting a reply takes
	-- the replies to it with it rather than orphaning them.
	"parent_id" text,
	"depth" integer NOT NULL,
	"body" text NOT NULL,
	/* `owner` is the shop speaking; `customer` is a shopper. The distinction is
	   a COLUMN and not something inferred from which id is set, because the
	   storefront renders the two differently (the owner gets the logomark) and
	   a renderer should read a field, not reverse-engineer a rule. */
	"author_kind" text NOT NULL,
	/* What the public sees. For an owner reply this is the shop's name, never
	   the staff member's — see `staff_user_id`. */
	"author_name" text NOT NULL,
	/* Set for a customer reply. NULL for an owner reply. */
	"customer_id" text,
	/* WHO ACTUALLY TYPED AN OWNER REPLY. Admin-only, never on the public wire:
	   publicly the shop replies as the shop, but "which of us answered this
	   angry review" is a question the owner will eventually ask. */
	"staff_user_id" uuid,
	/* Customer replies land `pending` and are invisible until approved, exactly
	   as reviews are. Owner replies are inserted `approved` — queueing staff
	   writing for staff approval is theatre, and the route enforces it. */
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"moderated_at" bigint,
	"moderated_by" text,
	CONSTRAINT "shop_review_replies_review_fk" FOREIGN KEY ("review_id")
		REFERENCES "shop_reviews"("id") ON DELETE CASCADE,
	CONSTRAINT "shop_review_replies_parent_fk" FOREIGN KEY ("parent_id")
		REFERENCES "shop_review_replies"("id") ON DELETE CASCADE,
	CONSTRAINT "shop_review_replies_customer_fk" FOREIGN KEY ("customer_id")
		REFERENCES "shop_customers"("id") ON DELETE SET NULL,
	CONSTRAINT "shop_review_replies_staff_fk" FOREIGN KEY ("staff_user_id")
		REFERENCES "users"("id"),
	CONSTRAINT "shop_review_replies_status_ck"
		CHECK ("status" IN ('pending', 'approved', 'rejected', 'flagged')),
	CONSTRAINT "shop_review_replies_kind_ck"
		CHECK ("author_kind" IN ('owner', 'customer')),
	-- Two levels. A reply to a depth-1 reply is refused by the route with a 400
	-- that says so; this is the backstop that makes it unstorable regardless.
	CONSTRAINT "shop_review_replies_depth_ck" CHECK ("depth" IN (0, 1)),
	CONSTRAINT "shop_review_replies_depth_parent_ck" CHECK (
		("depth" = 0 AND "parent_id" IS NULL) OR
		("depth" = 1 AND "parent_id" IS NOT NULL)
	),
	/* An owner reply is attributable to a staff member and to no customer; a
	   customer reply is the reverse. `customer_id` is ON DELETE SET NULL, so a
	   deleted customer leaves the reply standing with its byline — hence
	   `IS NOT NULL` is NOT asserted for the customer arm. */
	CONSTRAINT "shop_review_replies_author_ck" CHECK (
		("author_kind" = 'owner' AND "staff_user_id" IS NOT NULL AND "customer_id" IS NULL) OR
		("author_kind" = 'customer' AND "staff_user_id" IS NULL)
	)
);--> statement-breakpoint

-- The thread read: every reply to one review, in order. `status` is in the
-- index because the public read filters on it and the admin read does not.
CREATE INDEX "shop_review_replies_review_idx"
	ON "shop_review_replies" ("review_id", "status", "id");--> statement-breakpoint

-- The moderation queue, across every product.
CREATE INDEX "shop_review_replies_status_idx"
	ON "shop_review_replies" ("status", "id");--> statement-breakpoint

CREATE INDEX "shop_review_replies_parent_idx"
	ON "shop_review_replies" ("parent_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- REACTIONS.
--
-- THE PRIMARY KEY IS THE WHOLE RULE. "One vote per customer per review" is
-- enforced by `(review_id, customer_id)` being the key, not by a route that
-- remembers to check first — a check-then-insert is a race, and the race here
-- is two tabs turning one person into two votes.
--
-- CHANGING A VOTE IS AN UPSERT AND CLEARING IT IS A DELETE. There is no
-- `kind = 'none'` state: a row that records no opinion is a row that has to be
-- filtered out of every count forever.
--
-- NO DENORMALISED COUNTER ANYWHERE. `shop_reviews` gains no `helpful_count`
-- column, and there is no trigger. The counts are aggregated on read, so they
-- cannot drift from the rows they describe — the failure mode a cached counter
-- has, and the one nobody notices until the numbers are visibly wrong. At this
-- shop's volume the aggregate is free; if it ever stops being free, the fix is
-- an optimisation with a correct baseline to check itself against.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "shop_review_reactions" (
	"review_id" text NOT NULL,
	"customer_id" text NOT NULL,
	/* `helpful` is public as a count. `unhelpful` is recorded and shown in the
	   admin ONLY — a public dislike tally is a scoreboard for brigading, and
	   the owner still wants the signal. The split is enforced by the public
	   projection's column allow-list, not by callers remembering. */
	"kind" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "shop_review_reactions_pk" PRIMARY KEY ("review_id", "customer_id"),
	CONSTRAINT "shop_review_reactions_review_fk" FOREIGN KEY ("review_id")
		REFERENCES "shop_reviews"("id") ON DELETE CASCADE,
	CONSTRAINT "shop_review_reactions_customer_fk" FOREIGN KEY ("customer_id")
		REFERENCES "shop_customers"("id") ON DELETE CASCADE,
	CONSTRAINT "shop_review_reactions_kind_ck" CHECK ("kind" IN ('helpful', 'unhelpful'))
);--> statement-breakpoint

-- Counting one review's reactions, and answering "did THIS customer react" in
-- the same read. The PK already serves the second; this serves the first.
CREATE INDEX "shop_review_reactions_review_kind_idx"
	ON "shop_review_reactions" ("review_id", "kind");
