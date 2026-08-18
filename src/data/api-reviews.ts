/**
 * Customer reviews — the admin's half of the API (issue #4).
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the reason
 * `api-shop.ts` and `api-categories.ts` both give above the same decision:
 * `api.ts` is a file several writers append to, and a file several writers
 * append to is a file that loses a block. Nothing here is a different
 * convention — `apiFetch` is `api.ts`'s own request function, so
 * `credentials: 'include'`, the error envelope and the status table are the
 * shared ones and reviews cannot grow their own dialect of them.
 *
 * NO DEXIE, following the shop's rule for the same reason: the offline cache
 * exists so a writer can keep writing on a train. Nobody moderates offline,
 * and a cached queue is a queue that shows a colleague's decision as still
 * pending. Every read here is a plain fetch into component state.
 */
import { apiFetch } from './api';

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'flagged';
export type SentimentLabel = 'positive' | 'neutral' | 'negative';

/** The staff projection — the whole row, email and moderation trail included. */
export interface AdminReview {
  id: string;
  productSlug: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorEmail: string;
  customerId: string | null;
  orderId: string | null;
  status: ReviewStatus;
  sentimentLabel: SentimentLabel;
  /** Signed lexicon score. Diagnostic — the label is what the UI sorts on. */
  sentimentScore: number;
  createdAt: number;
  updatedAt: number;
  moderatedAt: number | null;
  moderatedBy: string | null;
}

export interface ReviewPage {
  items: AdminReview[];
  nextCursor: string | null;
}

export interface ListReviewsQuery {
  status?: ReviewStatus;
  /** Product slug — the API filters on an exact match. */
  product?: string;
  sentiment?: SentimentLabel;
  cursor?: string;
  limit?: number;
}

export function listReviews(query: ListReviewsQuery = {}): Promise<ReviewPage> {
  return apiFetch<ReviewPage>('/shop/reviews', { query: { ...query } });
}

export async function getReview(id: string): Promise<AdminReview> {
  const { review } = await apiFetch<{ review: AdminReview }>(
    `/shop/reviews/${encodeURIComponent(id)}`,
  );
  return review;
}

/**
 * The only write moderation has. It moves a status and records who did it;
 * the rating, the text and the sentiment are the customer's and are never
 * edited here — an admin surface that could rewrite a review would make every
 * review on the site unciteable.
 */
export async function moderateReview(id: string, status: ReviewStatus): Promise<AdminReview> {
  const { review } = await apiFetch<{ review: AdminReview }>(
    `/shop/reviews/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { status } },
  );
  return review;
}

/** Owner-only at the server; the UI hides it from everyone else. */
export function destroyReview(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/shop/reviews/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
