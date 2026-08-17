-- REVIEWS (issue #4, range 0180–0199).
--
-- HAND-WRITTEN IN FULL, for the same two reasons every commerce migration is:
-- `drizzle.config.ts` declares only `server/db/schema.ts`, so drizzle-kit has
-- never seen `server/shop/reviews/schema.ts` and can neither generate these
-- statements nor emit DDL to undo them; and the 0180–0199 range is allocated,
-- while `generate` numbers sequentially from the journal. `0180_snapshot`
-- deliberately does not exist. The DDL is asserted to be APPLIED — not merely
-- present in this file — by `server/shop/reviews/schema.test.ts`, which reads
-- it back out of the catalog on a migrated database.
--
-- SHAPE DECISIONS ARE DOCUMENTED IN `server/shop/reviews/schema.ts` — the slug
-- key instead of a product FK, the nullable customer/order linkage, and the
-- sentiment columns. This file is only the executable form.

CREATE TABLE "shop_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "product_slug" text NOT NULL,
  "rating" integer NOT NULL,
  "title" text,
  "body" text NOT NULL,
  "author_name" text NOT NULL,
  "author_email" text NOT NULL,
  "customer_id" text,
  "order_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "sentiment_label" text NOT NULL,
  "sentiment_score" integer NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "moderated_at" bigint,
  "moderated_by" text,
  CONSTRAINT "shop_reviews_rating_ck" CHECK ("rating" BETWEEN 1 AND 5),
  CONSTRAINT "shop_reviews_status_ck" CHECK ("status" IN ('pending', 'approved', 'rejected', 'flagged')),
  CONSTRAINT "shop_reviews_sentiment_ck" CHECK ("sentiment_label" IN ('positive', 'neutral', 'negative'))
);
--> statement-breakpoint
CREATE INDEX "shop_reviews_product_status_idx" ON "shop_reviews" ("product_slug", "status", "id");
--> statement-breakpoint
CREATE INDEX "shop_reviews_status_idx" ON "shop_reviews" ("status", "id");
