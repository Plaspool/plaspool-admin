/**
 * Reviews — the schema (issue #4, migration range 0180–0199).
 *
 * A new subsystem, following the commerce conventions to the letter:
 * timestamps are `bigint` epoch-milliseconds, never `timestamptz`; every
 * enum-ish column carries a `check()`, because `.$type<>()` is compile-time
 * only; and the DDL lives in a hand-written migration (`0180_reviews.sql`)
 * because this file is invisible to drizzle-kit — see the warning in
 * `drizzle.config.ts`. `server/shop/reviews/schema.test.ts` asserts the shape
 * against a migrated database, not against this file.
 *
 * TWO DELIBERATE SHAPE DECISIONS:
 *
 * **Reviews key on `product_slug`, not on a foreign key into
 * `shop_products`.** The storefront's catalogue is a fixture today
 * (plaspool-storefront issue #2 tracks replacing it), so the products a
 * customer reviews do not exist as rows anywhere — the slug is the one
 * identifier both sides of the seam agree on, today under fixtures and later
 * under the live catalogue, where `shop_products.slug` is the public name of
 * a product for exactly this reason. An FK would make reviews wait for the
 * live-data migration; a slug makes them independent of it.
 *
 * **`customer_id` and `order_id` are nullable and unenforced.** Customer
 * accounts do not exist yet (the auth bundle is sequenced after this), so
 * every review today is anonymous-with-an-email. The columns exist so that
 * when auth lands, linking a review to its verified customer — and to a
 * "verified purchase" order — is an UPDATE, not a migration.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, integer } from 'drizzle-orm/pg-core';

export const shopReviews = pgTable(
  'shop_reviews',
  {
    /** `rev_` + time prefix + 16 hex — the codebase's ULID-ish shape, so ids
     *  sort by creation time and can serve as a keyset cursor. */
    id: text('id').primaryKey(),
    productSlug: text('product_slug').notNull(),
    /** 1–5 whole stars. The check is the contract; the type is a convenience. */
    rating: integer('rating').notNull(),
    title: text('title'),
    body: text('body').notNull(),
    authorName: text('author_name').notNull(),
    /** Kept for moderation and future account linking. NEVER exposed on the
     *  public read surface — the projection in `repo.ts` owns that rule. */
    authorEmail: text('author_email').notNull(),
    customerId: text('customer_id'),
    orderId: text('order_id'),
    /**
     * The moderation lifecycle. Everything enters `pending` and only
     * `approved` is ever visible publicly; `flagged` is "approved-but-look
     * -again" in intent but is deliberately NOT public — erring on the side
     * of hiding while a human looks.
     */
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected' | 'flagged'>()
      .notNull()
      .default('pending'),
    /**
     * Sentiment, attached at submission time by `sentiment.ts` and refreshed
     * by nothing — the analysed text cannot change, because reviews have no
     * public edit path until customer auth exists.
     *
     * `score` is a signed integer (lexicon hits, negation-adjusted), kept
     * alongside the label so a future re-analysis can be compared against
     * what the v1 lexicon said. The label is what the UIs consume.
     */
    sentimentLabel: text('sentiment_label')
      .$type<'positive' | 'neutral' | 'negative'>()
      .notNull(),
    sentimentScore: integer('sentiment_score').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    /** Who moved it out of `pending`, and when. Null while untouched. */
    moderatedAt: bigint('moderated_at', { mode: 'number' }),
    moderatedBy: text('moderated_by'),
  },
  (t) => [
    /** The public read: approved reviews for one product, newest first. */
    index('shop_reviews_product_status_idx').on(t.productSlug, t.status, t.id),
    /** The moderation queue: everything in one status, newest first. */
    index('shop_reviews_status_idx').on(t.status, t.id),
    check('shop_reviews_rating_ck', sql`${t.rating} BETWEEN 1 AND 5`),
    check(
      'shop_reviews_status_ck',
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'flagged')`,
    ),
    check(
      'shop_reviews_sentiment_ck',
      sql`${t.sentimentLabel} IN ('positive', 'neutral', 'negative')`,
    ),
  ],
);

export type DbShopReview = typeof shopReviews.$inferSelect;
