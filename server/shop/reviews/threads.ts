import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';

/**
 * Review replies and reactions (migration 0620).
 *
 * A SEPARATE FILE FROM `repo.ts`, which owns the review row itself. These are
 * two entities with their own moderation lifecycle hanging off a third, and
 * folding them into the review repo would put four tables' worth of statements
 * in one module for no shared logic.
 *
 * EVERY STATEMENT HERE IS HAND-WRITTEN SQL rather than Drizzle's builder, for
 * the reason the rest of commerce is: the reads need correlated aggregates and
 * a self-join that the builder expresses worse than SQL does, and mixing the
 * two dialects inside one file is the thing that makes a repo unreadable.
 */

export type ReplyAuthorKind = 'owner' | 'customer';
export type ReplyStatus = 'pending' | 'approved' | 'rejected' | 'flagged';
export type ReactionKind = 'helpful' | 'unhelpful';

/** The shop's public byline on an owner reply. Never a staff member's name. */
export const OWNER_BYLINE = 'PlaSpool';

/** How deep a thread may go. 0 is a reply to the review, 1 a reply to that. */
export const MAX_DEPTH = 1;

export interface PublicReply {
  id: string;
  parentId: string | null;
  depth: number;
  body: string;
  authorKind: ReplyAuthorKind;
  authorName: string;
  createdAt: number;
}

export interface AdminReply extends PublicReply {
  status: ReplyStatus;
  customerId: string | null;
  staffUserId: string | null;
  updatedAt: number;
  moderatedAt: number | null;
  moderatedBy: string | null;
}

/** `rev_`-style ids, same shape as everything else on the wire. */
function newId(prefix: 'rpl_'): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function rowToPublicReply(row: Record<string, unknown>): PublicReply {
  return {
    id: String(row.id),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    depth: Number(row.depth),
    body: String(row.body),
    authorKind: row.author_kind as ReplyAuthorKind,
    authorName: String(row.author_name),
    createdAt: toEpochMs(row.created_at),
  };
}

function rowToAdminReply(row: Record<string, unknown>): AdminReply {
  return {
    ...rowToPublicReply(row),
    status: row.status as ReplyStatus,
    customerId: row.customer_id == null ? null : String(row.customer_id),
    staffUserId: row.staff_user_id == null ? null : String(row.staff_user_id),
    updatedAt: toEpochMs(row.updated_at),
    moderatedAt: toEpochMsOrNull(row.moderated_at),
    moderatedBy: row.moderated_by == null ? null : String(row.moderated_by),
  };
}

// ------------------------------------------------------------------- replies

export interface CreateReplyInput {
  reviewId: string;
  /** NULL for a top-level reply; a reply id to answer that reply. */
  parentId: string | null;
  body: string;
  authorKind: ReplyAuthorKind;
  authorName: string;
  customerId: string | null;
  staffUserId: string | null;
  now: number;
}

/** Why a reply could not be written. Each is something the caller must SAY. */
export type CreateReplyResult =
  | { ok: true; reply: AdminReply }
  | { ok: false; reason: 'review_missing' }
  /** The review exists but is not approved — there is nothing public to reply to. */
  | { ok: false; reason: 'review_not_approved' }
  | { ok: false; reason: 'parent_missing' }
  /** Replying to a depth-1 reply. Two levels is the whole design. */
  | { ok: false; reason: 'too_deep' }
  /** The parent belongs to a different review — a client bug or a probe. */
  | { ok: false; reason: 'parent_mismatch' };

/**
 * Write one reply, or say precisely why not.
 *
 * A RESULT AND NOT A THROW, matching `ReservationResult` and the totals engine:
 * every failure below is something the customer has to be told with specifics,
 * and an exception has nowhere to put the distinction between "that review is
 * gone" and "you cannot reply that deep".
 *
 * DEPTH AND PARENTAGE ARE RESOLVED IN ONE READ, BEFORE THE INSERT. The
 * alternative — insert and let the CHECK constraint refuse — produces a 23514
 * naming a constraint the caller has never heard of, and cannot distinguish
 * `too_deep` from `parent_mismatch` at all.
 *
 * OWNER REPLIES ARE INSERTED `approved`; customer replies keep the column
 * default of `pending`. The rule lives here rather than at the route so that
 * every caller gets it, including a future one.
 */
export async function createReply(
  db: Db,
  input: CreateReplyInput,
): Promise<CreateReplyResult> {
  const review = await db.execute(sql`
    SELECT status FROM shop_reviews WHERE id = ${input.reviewId}`);
  const reviewRow = review.rows[0];
  if (!reviewRow) return { ok: false, reason: 'review_missing' };
  /* An unapproved review is invisible publicly, so a reply to it would be a
     reply to nothing — and letting one be written is a way to probe which
     pending reviews exist. */
  if (reviewRow.status !== 'approved') return { ok: false, reason: 'review_not_approved' };

  let depth = 0;
  if (input.parentId !== null) {
    const parent = await db.execute(sql`
      SELECT depth, review_id FROM shop_review_replies WHERE id = ${input.parentId}`);
    const parentRow = parent.rows[0];
    if (!parentRow) return { ok: false, reason: 'parent_missing' };
    if (String(parentRow.review_id) !== input.reviewId) {
      return { ok: false, reason: 'parent_mismatch' };
    }
    depth = Number(parentRow.depth) + 1;
    if (depth > MAX_DEPTH) return { ok: false, reason: 'too_deep' };
  }

  const status: ReplyStatus = input.authorKind === 'owner' ? 'approved' : 'pending';
  const id = newId('rpl_');

  const res = await db.execute(sql`
    INSERT INTO shop_review_replies
      (id, review_id, parent_id, depth, body, author_kind, author_name,
       customer_id, staff_user_id, status, created_at, updated_at,
       moderated_at, moderated_by)
    VALUES (${id}, ${input.reviewId}, ${input.parentId}::text, ${depth},
            ${input.body}, ${input.authorKind}, ${input.authorName},
            ${input.customerId}::text, ${input.staffUserId}::uuid, ${status},
            ${input.now}, ${input.now},
            /* An owner reply is approved at birth, so it is moderated by its
               own author at its own creation time — recording NULL there would
               make the audit trail read as "nobody approved this". */
            ${input.authorKind === 'owner' ? input.now : null}::bigint,
            ${input.authorKind === 'owner' ? input.staffUserId : null}::text)
    RETURNING id, review_id, parent_id, depth, body, author_kind, author_name,
              customer_id, staff_user_id, status, created_at, updated_at,
              moderated_at, moderated_by`);

  return { ok: true, reply: rowToAdminReply(res.rows[0]!) };
}

/**
 * Every APPROVED reply on a set of reviews, keyed by review id.
 *
 * BATCHED ACROSS REVIEWS, not one query per review: the public list renders a
 * page of reviews and a reply query per row is the N+1 that
 * `listVariantsForProducts` exists to avoid on the catalogue side.
 *
 * ORDERED BY `id`, WHICH IS TIME-ORDERED. The ids carry a base-36 timestamp
 * prefix, so ascending id is ascending creation and a thread reads top to
 * bottom without a second sort key.
 */
export async function repliesFor(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, PublicReply[]>> {
  const out = new Map<string, PublicReply[]>();
  for (const id of reviewIds) out.set(id, []);
  if (reviewIds.length === 0) return out;

  const res = await db.execute(sql`
    SELECT id, review_id, parent_id, depth, body, author_kind, author_name, created_at
      FROM shop_review_replies
     WHERE review_id = ANY(${sql.param(reviewIds as string[])}::text[])
       AND status = 'approved'
     ORDER BY id ASC`);

  for (const row of res.rows) {
    const bucket = out.get(String(row.review_id));
    if (bucket) bucket.push(rowToPublicReply(row));
  }
  return out;
}

/** Every reply on one review regardless of status — the moderation view. */
export async function repliesForAdmin(db: Db, reviewId: string): Promise<AdminReply[]> {
  const res = await db.execute(sql`
    SELECT id, review_id, parent_id, depth, body, author_kind, author_name,
           customer_id, staff_user_id, status, created_at, updated_at,
           moderated_at, moderated_by
      FROM shop_review_replies
     WHERE review_id = ${reviewId}
     ORDER BY id ASC`);
  return res.rows.map(rowToAdminReply);
}

export async function getReply(db: Db, id: string): Promise<AdminReply | null> {
  const res = await db.execute(sql`
    SELECT id, review_id, parent_id, depth, body, author_kind, author_name,
           customer_id, staff_user_id, status, created_at, updated_at,
           moderated_at, moderated_by
      FROM shop_review_replies WHERE id = ${id}`);
  const row = res.rows[0];
  return row ? rowToAdminReply(row) : null;
}

/**
 * Move a reply's status, recording who and when.
 *
 * Setting it BACK to `pending` CLEARS the attribution, exactly as
 * `moderateReview` does: "pending" means "no decision", not "somebody decided
 * pending", and leaving a stale approver on it would make the audit lie.
 */
export async function moderateReply(
  db: Db,
  id: string,
  status: ReplyStatus,
  actor: { id: string },
  now: number,
): Promise<AdminReply | null> {
  const clearing = status === 'pending';
  const res = await db.execute(sql`
    UPDATE shop_review_replies
       SET status = ${status},
           moderated_at = ${clearing ? null : now}::bigint,
           moderated_by = ${clearing ? null : actor.id}::text,
           updated_at = ${now}
     WHERE id = ${id}
    RETURNING id, review_id, parent_id, depth, body, author_kind, author_name,
              customer_id, staff_user_id, status, created_at, updated_at,
              moderated_at, moderated_by`);
  const row = res.rows[0];
  return row ? rowToAdminReply(row) : null;
}

/** Delete a reply. Its own replies go with it — the FK cascades. */
export async function destroyReply(db: Db, id: string): Promise<boolean> {
  const res = await db.execute(sql`
    DELETE FROM shop_review_replies WHERE id = ${id} RETURNING id`);
  return res.rows.length > 0;
}

// ----------------------------------------------------------------- reactions

export interface ReactionCounts {
  helpful: number;
  /** ADMIN ONLY. The public projection never selects this — see 0620's header. */
  unhelpful: number;
}

/**
 * Set a customer's reaction, or clear it.
 *
 * TOGGLING IS THE CALLER'S JOB AND THE ROUTE DOES IT, because "clicking helpful
 * twice clears it" is a UI affordance rather than a storage rule — and a repo
 * that flipped state based on what it found would make two concurrent clicks
 * from two tabs land on whichever order they arrived in.
 *
 * ONE STATEMENT, `ON CONFLICT` ON THE PRIMARY KEY. The key is `(review_id,
 * customer_id)`, so "one vote per person" is enforced by the insert itself
 * rather than by a read-then-write that races.
 */
export async function setReaction(
  db: Db,
  reviewId: string,
  customerId: string,
  kind: ReactionKind,
  now: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO shop_review_reactions (review_id, customer_id, kind, created_at, updated_at)
    VALUES (${reviewId}, ${customerId}, ${kind}, ${now}, ${now})
    ON CONFLICT (review_id, customer_id) DO UPDATE
      SET kind = EXCLUDED.kind, updated_at = EXCLUDED.updated_at`);
}

export async function clearReaction(
  db: Db,
  reviewId: string,
  customerId: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM shop_review_reactions
     WHERE review_id = ${reviewId} AND customer_id = ${customerId}`);
}

/** This customer's reaction to one review, or null. */
export async function reactionOf(
  db: Db,
  reviewId: string,
  customerId: string,
): Promise<ReactionKind | null> {
  const res = await db.execute(sql`
    SELECT kind FROM shop_review_reactions
     WHERE review_id = ${reviewId} AND customer_id = ${customerId}`);
  const row = res.rows[0];
  return row ? (row.kind as ReactionKind) : null;
}

/**
 * Reaction counts for a set of reviews, aggregated ON READ.
 *
 * NO STORED COUNTER, and 0620's header sets out why: a cached count drifts
 * from the rows it describes, and nobody notices until the number is visibly
 * wrong. `FILTER` rather than two queries or a CASE sum, because it says what
 * it means and Postgres computes both in one pass.
 *
 * Every requested id is in the map with a zero pair, so no caller has to write
 * the "missing means none" branch.
 */
export async function reactionCounts(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, ReactionCounts>> {
  const out = new Map<string, ReactionCounts>();
  for (const id of reviewIds) out.set(id, { helpful: 0, unhelpful: 0 });
  if (reviewIds.length === 0) return out;

  const res = await db.execute(sql`
    SELECT review_id,
           count(*) FILTER (WHERE kind = 'helpful')::int   AS helpful,
           count(*) FILTER (WHERE kind = 'unhelpful')::int AS unhelpful
      FROM shop_review_reactions
     WHERE review_id = ANY(${sql.param(reviewIds as string[])}::text[])
     GROUP BY review_id`);

  for (const row of res.rows) {
    const bucket = out.get(String(row.review_id));
    if (bucket) {
      bucket.helpful = Number(row.helpful);
      bucket.unhelpful = Number(row.unhelpful);
    }
  }
  return out;
}

/** Which of these reviews this customer has reacted to, and how. */
export async function reactionsOf(
  db: Db,
  reviewIds: readonly string[],
  customerId: string,
): Promise<Map<string, ReactionKind>> {
  const out = new Map<string, ReactionKind>();
  if (reviewIds.length === 0) return out;
  const res = await db.execute(sql`
    SELECT review_id, kind FROM shop_review_reactions
     WHERE customer_id = ${customerId}
       AND review_id = ANY(${sql.param(reviewIds as string[])}::text[])`);
  for (const row of res.rows) out.set(String(row.review_id), row.kind as ReactionKind);
  return out;
}
