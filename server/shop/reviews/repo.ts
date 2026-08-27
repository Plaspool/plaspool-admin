import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { NotFoundError } from '../../repo/errors';
import { shopReviews } from './schema';
import type { DbShopReview } from './schema';
import { analyseSentiment } from './sentiment';

/**
 * Reviews — the repository. Every query about a review lives here; the
 * routes shape and guard, they do not compose SQL.
 *
 * TWO PROJECTIONS, AND THE DIFFERENCE IS THE POINT. `AdminReview` is the
 * whole row — moderation needs the email, the score, who approved what and
 * when. `PublicReview` is what a storefront may render, and `author_email`
 * is structurally absent from it rather than filtered out at the call site:
 * a projection that never selects the column cannot leak it in a refactor.
 */

export type ReviewStatus = DbShopReview['status'];
export type SentimentLabel = DbShopReview['sentimentLabel'];

/** The whole row, for the admin surface. */
export type AdminReview = DbShopReview;

/** What the public read returns. No email, no moderator, no order ID. */
export interface PublicReview {
  id: string;
  productSlug: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  sentiment: SentimentLabel;
  createdAt: number;
  /**
   * WHETHER AN ORDER PROVED THIS PURCHASE — the badge (brief §5).
   *
   * A BOOLEAN DERIVED FROM `order_id`, NOT THE ID ITSELF. Which order somebody
   * placed is nobody else's business, and this is the cacheable public read: the
   * projection returns the ANSWER to "was this verified" and never the evidence,
   * exactly as it returns `author_name` and never `author_email`.
   *
   * FALSE ON EVERY REVIEW WRITTEN BEFORE THE GATE SHIPPED, which is honest —
   * those were never checked against an order. The storefront renders the badge
   * only when true and renders NOTHING when false; an explicit "unverified"
   * label would be a punishment for having reviewed early.
   */
  verifiedPurchase: boolean;
}

export interface ProductAggregate {
  productSlug: string;
  count: number;
  /** Mean rating × 100, as an integer — `433` is 4.33 stars. Integers travel
   *  better than floats through JSON and render without surprise digits. */
  averageRating: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
  sentiment: { positive: number; neutral: number; negative: number };
}

/** The same id shape the rest of the codebase mints — time prefix then 16
 *  hex. Copied rather than imported, per the precedent `shop/orders/ids.ts`
 *  documents: the existing declarations are private to files this subsystem
 *  does not own. The time prefix is what lets `id` double as the pagination
 *  cursor below. */
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const PUBLIC_COLUMNS = {
  id: shopReviews.id,
  productSlug: shopReviews.productSlug,
  rating: shopReviews.rating,
  title: shopReviews.title,
  body: shopReviews.body,
  authorName: shopReviews.authorName,
  sentiment: shopReviews.sentimentLabel,
  createdAt: shopReviews.createdAt,
  /* Derived in the statement rather than mapped afterwards, so the column
     itself never leaves the database and cannot be forgotten into a response
     by a later refactor of the mapping code. */
  verifiedPurchase: sql<boolean>`${shopReviews.orderId} IS NOT NULL`,
} as const;

export interface CreateReviewInput {
  productSlug: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorEmail: string;
  /** Set when the submitter held a live customer session. Null for guests. */
  customerId?: string | null;
  /**
   * The order that proved the purchase (brief §2). Required in practice now
   * that the intake gates on one, but still OPTIONAL here: the admin's own
   * fixtures and every test that predates the gate construct reviews without
   * one, and making it mandatory would be a type error in forty places to
   * express a rule the ROUTE already enforces.
   */
  orderId?: string | null;
  now: number;
}

/**
 * Every review enters `pending`, and sentiment is attached HERE — on the
 * write path, not in a job — so a review and its sentiment are one row from
 * the first moment they exist. There is no review-without-sentiment state
 * anywhere in the system, which is what issue #4's "attached automatically
 * on submission" means taken literally.
 */
export async function createReview(db: Db, input: CreateReviewInput): Promise<AdminReview> {
  const sentiment = analyseSentiment(`${input.title ?? ''} ${input.body}`);
  const [row] = await db
    .insert(shopReviews)
    .values({
      id: newId('rev_'),
      productSlug: input.productSlug,
      rating: input.rating,
      title: input.title,
      body: input.body,
      authorName: input.authorName,
      authorEmail: input.authorEmail,
      customerId: input.customerId ?? null,
      orderId: input.orderId ?? null,
      status: 'pending',
      sentimentLabel: sentiment.label,
      sentimentScore: sentiment.score,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  return row!;
}

export interface AdminListParams {
  status?: ReviewStatus;
  productSlug?: string;
  sentiment?: SentimentLabel;
  cursor?: string;
  limit: number;
}

/**
 * Keyset pagination on `id` alone. The ids are time-prefixed, so descending
 * id order IS reverse-chronological order — one column serves as both sort
 * key and cursor, and there is no (timestamp, id) tiebreak to get wrong.
 */
export async function listReviewsAdmin(
  db: Db,
  params: AdminListParams,
): Promise<{ items: AdminReview[]; nextCursor: string | null }> {
  const conditions = [
    params.status ? eq(shopReviews.status, params.status) : undefined,
    params.productSlug ? eq(shopReviews.productSlug, params.productSlug) : undefined,
    params.sentiment ? eq(shopReviews.sentimentLabel, params.sentiment) : undefined,
    params.cursor ? lt(shopReviews.id, params.cursor) : undefined,
  ].filter((c) => c !== undefined);

  const rows = await db
    .select()
    .from(shopReviews)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(shopReviews.id))
    .limit(params.limit + 1);

  const items = rows.slice(0, params.limit);
  return {
    items,
    nextCursor: rows.length > params.limit ? items[items.length - 1]!.id : null,
  };
}

/**
 * The storefront's read: approved only, one product, newest first. The
 * status is fixed inside the function rather than being a parameter — there
 * is no caller that may ask this projection for anything else.
 */
export async function listReviewsPublic(
  db: Db,
  productSlug: string,
  params: { cursor?: string; limit: number },
): Promise<{ items: PublicReview[]; nextCursor: string | null }> {
  const conditions = [
    eq(shopReviews.productSlug, productSlug),
    eq(shopReviews.status, 'approved' as const),
    params.cursor ? lt(shopReviews.id, params.cursor) : undefined,
  ].filter((c) => c !== undefined);

  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(shopReviews)
    .where(and(...conditions))
    .orderBy(desc(shopReviews.id))
    .limit(params.limit + 1);

  const items = rows.slice(0, params.limit);
  return {
    items,
    nextCursor: rows.length > params.limit ? items[items.length - 1]!.id : null,
  };
}

export async function getReview(db: Db, id: string): Promise<AdminReview | null> {
  const [row] = await db.select().from(shopReviews).where(eq(shopReviews.id, id));
  return row ?? null;
}

/**
 * Moderation is a status move and an attribution, nothing else — the text,
 * the rating and the sentiment are the customer's and stay exactly as
 * submitted. Setting a review BACK to `pending` clears the attribution,
 * because "pending" means "no decision", not "somebody decided pending".
 */
export async function moderateReview(
  db: Db,
  id: string,
  status: ReviewStatus,
  moderatorId: string,
  now: number,
): Promise<AdminReview> {
  const [row] = await db
    .update(shopReviews)
    .set({
      status,
      updatedAt: now,
      moderatedAt: status === 'pending' ? null : now,
      moderatedBy: status === 'pending' ? null : moderatorId,
    })
    .where(eq(shopReviews.id, id))
    .returning();
  if (!row) throw new NotFoundError(id);
  return row;
}

export async function destroyReview(db: Db, id: string): Promise<void> {
  const [row] = await db
    .delete(shopReviews)
    .where(eq(shopReviews.id, id))
    .returning({ id: shopReviews.id });
  if (!row) throw new NotFoundError(id);
}

/**
 * One row, one pass: `FILTER` folds the distribution and the sentiment
 * breakdown into the same aggregate scan the count and mean come from.
 * Approved only — the public aggregate must agree with the public list, or
 * a product shows "12 reviews" above a list of 9.
 */
export async function productAggregate(db: Db, productSlug: string): Promise<ProductAggregate> {
  const approved = and(
    eq(shopReviews.productSlug, productSlug),
    eq(shopReviews.status, 'approved' as const),
  );

  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      averageRating: sql<number>`coalesce(round(avg(${shopReviews.rating}) * 100)::int, 0)`,
      r1: sql<number>`count(*) filter (where ${shopReviews.rating} = 1)::int`,
      r2: sql<number>`count(*) filter (where ${shopReviews.rating} = 2)::int`,
      r3: sql<number>`count(*) filter (where ${shopReviews.rating} = 3)::int`,
      r4: sql<number>`count(*) filter (where ${shopReviews.rating} = 4)::int`,
      r5: sql<number>`count(*) filter (where ${shopReviews.rating} = 5)::int`,
      positive: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'positive')::int`,
      neutral: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'neutral')::int`,
      negative: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'negative')::int`,
    })
    .from(shopReviews)
    .where(approved);

  const a = row!;
  return {
    productSlug,
    count: a.count,
    averageRating: a.averageRating,
    distribution: { 1: a.r1, 2: a.r2, 3: a.r3, 4: a.r4, 5: a.r5 },
    sentiment: { positive: a.positive, neutral: a.neutral, negative: a.negative },
  };
}

/** An aggregate with nothing in it. The shape a product with no approved
 *  reviews answers with — never an omission, so no caller has to branch on
 *  "missing" before it can read a count. */
export function emptyAggregate(productSlug: string): ProductAggregate {
  return {
    productSlug,
    count: 0,
    averageRating: 0,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    sentiment: { positive: 0, neutral: 0, negative: 0 },
  };
}

/**
 * The same aggregate, for MANY products in ONE statement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A LISTING NEEDS A RATING FOR EVERY CARD ON IT.
 *
 * `productAggregate` answers for one slug, so a sixteen-card grid needed
 * sixteen requests. The consumer is Next.js on Cloudflare Workers, where a
 * request has a 50-subrequest cap on the free plan and a CPU budget that
 * plaspool-storefront#9 (Error 1102) was only just brought inside — so
 * per-card aggregation was not slow, it was a grid-size ceiling.
 *
 * The cost of not having it was visible: `SHOW_FIXTURE_REVIEWS = false` in the
 * storefront switches OFF the rating line on `ProductCard` and the "Best rated"
 * sort, because the only alternative was putting invented numbers in front of
 * customers. This is what turns them back on with real ones.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EVERY REQUESTED SLUG COMES BACK, including the ones with no approved reviews.
 * A `GROUP BY` only produces rows for slugs that HAVE reviews, so the zero
 * aggregates are filled in here rather than left to the caller — otherwise every
 * consumer writes the same "missing means empty" branch, and the one that
 * forgets renders a blank where a card should say "no reviews yet".
 *
 * APPROVED ONLY, matching `productAggregate` and the public list. The three must
 * agree or a card says "12 reviews" over a page showing nine.
 */
export async function productAggregates(
  db: Db,
  productSlugs: readonly string[],
): Promise<Map<string, ProductAggregate>> {
  const out = new Map<string, ProductAggregate>();
  /* Deduplicated before the query rather than after: a caller repeating a slug
     should cost one row, not two identical ones to reconcile. */
  const wanted = [...new Set(productSlugs)];
  for (const slug of wanted) out.set(slug, emptyAggregate(slug));
  // No slugs means no statement. `= ANY('{}')` is valid but a pointless round trip.
  if (wanted.length === 0) return out;

  const rows = await db
    .select({
      productSlug: shopReviews.productSlug,
      count: sql<number>`count(*)::int`,
      averageRating: sql<number>`coalesce(round(avg(${shopReviews.rating}) * 100)::int, 0)`,
      r1: sql<number>`count(*) filter (where ${shopReviews.rating} = 1)::int`,
      r2: sql<number>`count(*) filter (where ${shopReviews.rating} = 2)::int`,
      r3: sql<number>`count(*) filter (where ${shopReviews.rating} = 3)::int`,
      r4: sql<number>`count(*) filter (where ${shopReviews.rating} = 4)::int`,
      r5: sql<number>`count(*) filter (where ${shopReviews.rating} = 5)::int`,
      positive: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'positive')::int`,
      neutral: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'neutral')::int`,
      negative: sql<number>`count(*) filter (where ${shopReviews.sentimentLabel} = 'negative')::int`,
    })
    .from(shopReviews)
    .where(
      and(
        /* `sql.param(...)::text[]` is the array-bind idiom this codebase uses
           (`committedImageIds`, `server/repo/backup.ts`). Passing the array
           bare reaches the driver as text and is a 22P02. */
        sql`${shopReviews.productSlug} = ANY(${sql.param(wanted)}::text[])`,
        eq(shopReviews.status, 'approved' as const),
      ),
    )
    .groupBy(shopReviews.productSlug);

  for (const a of rows) {
    out.set(a.productSlug, {
      productSlug: a.productSlug,
      count: a.count,
      averageRating: a.averageRating,
      distribution: { 1: a.r1, 2: a.r2, 3: a.r3, 4: a.r4, 5: a.r5 },
      sentiment: { positive: a.positive, neutral: a.neutral, negative: a.negative },
    });
  }
  return out;
}
