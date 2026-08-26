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

// ------------------------------------------------- replies + reactions (0620)

export type ReplyAuthorKind = 'owner' | 'customer';

/**
 * One reply as the ADMIN sees it — the public shape plus the moderation state
 * and the attribution the public never gets.
 *
 * `staffUserId` is why this is a different type from what the storefront
 * receives: publicly the shop replies as the shop, but "which of us answered
 * this angry review" is a question the owner will eventually ask.
 */
export interface AdminReply {
  id: string;
  parentId: string | null;
  /** 0 replies to the review; 1 replies to a reply. There is no 2. */
  depth: number;
  body: string;
  authorKind: ReplyAuthorKind;
  /** For an owner reply this is the SHOP's name, never the staff member's. */
  authorName: string;
  status: ReviewStatus;
  customerId: string | null;
  staffUserId: string | null;
  createdAt: number;
  updatedAt: number;
  moderatedAt: number | null;
  moderatedBy: string | null;
}

/** Counts for one review. `unhelpful` exists ONLY here — never on the public
 *  wire, where a dislike tally would be a scoreboard for brigading. */
export interface ReactionCounts {
  helpful: number;
  unhelpful: number;
}

export interface ReviewThread {
  replies: AdminReply[];
  reactions: ReactionCounts;
}

/**
 * The whole moderation panel in ONE read: every reply whatever its status, and
 * both reaction counts. Two requests here would mean two loading states for
 * one panel.
 */
export function loadThread(reviewId: string): Promise<ReviewThread> {
  return apiFetch<ReviewThread>(`/shop/reviews/${encodeURIComponent(reviewId)}/replies`);
}

/**
 * Post the shop's reply. It is `approved` the moment it lands — the server
 * decides that, not this call, because queueing staff writing for staff
 * approval is theatre.
 *
 * There is no `authorName` parameter on purpose: the byline is the shop's and
 * is set server-side, so an admin cannot accidentally sign a reply with their
 * own name on a stranger's screen.
 */
export async function replyAsOwner(
  reviewId: string,
  body: string,
  parentId: string | null = null,
): Promise<AdminReply> {
  const { reply } = await apiFetch<{ reply: AdminReply }>(
    `/shop/reviews/${encodeURIComponent(reviewId)}/staff-replies`,
    { method: 'POST', body: { body, parentId } },
  );
  return reply;
}

export async function moderateReply(id: string, status: ReviewStatus): Promise<AdminReply> {
  const { reply } = await apiFetch<{ reply: AdminReply }>(
    `/shop/replies/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { status } },
  );
  return reply;
}

/** Owner-only at the server; the UI hides it from everyone else. */
export function destroyReply(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/shop/replies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
