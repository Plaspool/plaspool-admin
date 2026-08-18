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

/** What the public read returns. No email, no moderator, no order. */
export interface PublicReview {
  id: string;
  productSlug: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  sentiment: SentimentLabel;
  createdAt: number;
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
} as const;

export interface CreateReviewInput {
  productSlug: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorEmail: string;
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
