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
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  integer,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../../db/schema';
import { shopCustomers } from '../cart/schema';

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

/**
 * REPLIES (migration 0620). Two levels: a reply to a review, and a reply to
 * that. Anything deeper is unstorable, not merely discouraged.
 *
 * `depth` IS STORED RATHER THAN WALKED. Deriving it from the `parent_id` chain
 * costs a recursive CTE on every read and makes "is this too deep" a question
 * the application asks instead of one the database refuses.
 *
 * `authorKind` IS A COLUMN, NOT AN INFERENCE. The storefront renders an owner
 * reply differently — the shop's logomark instead of an initial — and a
 * renderer should read a field rather than reverse-engineer the rule from
 * which id happens to be null.
 */
export const shopReviewReplies = pgTable(
  'shop_review_replies',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => shopReviews.id, { onDelete: 'cascade' }),
    /** NULL is top level. Self-referential, so deleting a reply takes the
     *  replies to it rather than orphaning them. */
    parentId: text('parent_id'),
    depth: integer('depth').notNull(),
    body: text('body').notNull(),
    authorKind: text('author_kind').$type<'owner' | 'customer'>().notNull(),
    /** What the public sees. For an owner reply this is the SHOP's name, never
     *  the staff member's — that lives in `staffUserId` and stays admin-only. */
    authorName: text('author_name').notNull(),
    customerId: text('customer_id').references(() => shopCustomers.id, {
      onDelete: 'set null',
    }),
    /** Who actually typed an owner reply. Never on the public wire. */
    staffUserId: uuid('staff_user_id').references(() => users.id),
    /** Customer replies land `pending`; owner replies are inserted `approved`,
     *  because queueing staff writing for staff approval is theatre. */
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected' | 'flagged'>()
      .notNull()
      .default('pending'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    moderatedAt: bigint('moderated_at', { mode: 'number' }),
    moderatedBy: text('moderated_by'),
  },
  (t) => [
    index('shop_review_replies_review_idx').on(t.reviewId, t.status, t.id),
    index('shop_review_replies_status_idx').on(t.status, t.id),
    index('shop_review_replies_parent_idx').on(t.parentId),
    check(
      'shop_review_replies_status_ck',
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'flagged')`,
    ),
    check('shop_review_replies_kind_ck', sql`${t.authorKind} IN ('owner', 'customer')`),
    check('shop_review_replies_depth_ck', sql`${t.depth} IN (0, 1)`),
    /* THE PAIRING IS THE POINT. Either column alone is satisfiable by a row
       that makes no sense — a depth-0 row with a parent, a depth-1 orphan — and
       both render as a broken thread rather than as an error. */
    check(
      'shop_review_replies_depth_parent_ck',
      sql`(${t.depth} = 0 AND ${t.parentId} IS NULL) OR (${t.depth} = 1 AND ${t.parentId} IS NOT NULL)`,
    ),
    /* `customerId` is ON DELETE SET NULL, so a deleted customer leaves the
       reply standing with its byline — which is why the customer arm does not
       assert `IS NOT NULL`. */
    check(
      'shop_review_replies_author_ck',
      sql`(${t.authorKind} = 'owner' AND ${t.staffUserId} IS NOT NULL AND ${t.customerId} IS NULL) OR (${t.authorKind} = 'customer' AND ${t.staffUserId} IS NULL)`,
    ),
  ],
);

/**
 * REACTIONS (migration 0620).
 *
 * THE PRIMARY KEY IS THE WHOLE RULE. "One vote per customer per review" is
 * enforced by the composite key, not by a route that checks first — a
 * check-then-insert is a race, and the race is two tabs turning one person
 * into two votes.
 *
 * There is no `kind = 'none'`: clearing a vote DELETES the row, because a row
 * recording no opinion is a row every count has to filter out forever.
 *
 * NO DENORMALISED COUNTER. `shopReviews` gains no `helpfulCount`, and there is
 * no trigger — the counts are aggregated on read and therefore cannot drift
 * from the rows they describe.
 */
export const shopReviewReactions = pgTable(
  'shop_review_reactions',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => shopReviews.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => shopCustomers.id, { onDelete: 'cascade' }),
    /** `helpful` is public as a count; `unhelpful` is admin-only. A public
     *  dislike tally is a scoreboard for brigading, and the owner still wants
     *  the signal. Enforced by the public projection's allow-list. */
    kind: text('kind').$type<'helpful' | 'unhelpful'>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'shop_review_reactions_pk', columns: [t.reviewId, t.customerId] }),
    index('shop_review_reactions_review_kind_idx').on(t.reviewId, t.kind),
    check('shop_review_reactions_kind_ck', sql`${t.kind} IN ('helpful', 'unhelpful')`),
  ],
);

export type DbShopReviewReply = typeof shopReviewReplies.$inferSelect;
export type DbShopReviewReaction = typeof shopReviewReactions.$inferSelect;

/**
 * PHOTOS ON A REVIEW (migration 1280).
 *
 * Uploaded BEFORE the review exists, so `reviewId` is null until the submit
 * attaches it. `uploaderKey` is who may attach it — `cus:<customer id>` or
 * `ord:<order id>` for a review link — and a photo nobody attaches is never
 * served.
 *
 * NO `status` OF ITS OWN. A photo is public exactly while its review is
 * approved, decided at serve time, so moderation has one switch and not two.
 */
export const shopReviewPhotos = pgTable(
  'shop_review_photos',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id').references(() => shopReviews.id, { onDelete: 'cascade' }),
    uploaderKey: text('uploader_key').notNull(),
    storageKey: text('storage_key').notNull().unique('shop_review_photos_storage_key_uq'),
    contentType: text('content_type')
      .$type<'image/jpeg' | 'image/png' | 'image/webp'>()
      .notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width'),
    height: integer('height'),
    position: integer('position').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('shop_review_photos_review_idx').on(t.reviewId, t.position),
    index('shop_review_photos_uploader_idx').on(t.uploaderKey, t.createdAt),
    check(
      'shop_review_photos_type_ck',
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('shop_review_photos_size_ck', sql`${t.byteSize} > 0`),
    check('shop_review_photos_position_ck', sql`${t.position} BETWEEN 0 AND 3`),
    check('shop_review_photos_uploader_ck', sql`${t.uploaderKey} ~ '^(cus|ord):.+$'`),
  ],
);

export type DbShopReviewPhoto = typeof shopReviewPhotos.$inferSelect;
