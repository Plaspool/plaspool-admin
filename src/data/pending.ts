import { db, type PendingState, type PendingWrite } from './db';
import type { PostPatch } from './types';

/**
 * Durable unsent writes.
 *
 * Before the cutover the document itself lived in IndexedDB, so a save that
 * "failed" still left the words on disk. After it, the server is the store —
 * and holding a failed write only in memory would make durability strictly
 * worse than what it replaced. A `pending` row is what stops a network drop, a
 * 5xx or a session expiry costing a writer their paragraph, and it is the
 * whole of this app's claim to beat Ghost 5.x on offline durability.
 *
 * EVERY function here takes a user id, and the store's primary key is the
 * compound `[postId+ownerUserId]` (see `db.ts`). With `postId` alone, two users
 * saving the same post on one machine collapse to one row and the first
 * writer's words vanish with no error — measured, not reasoned.
 *
 * The rows are never deleted on a guess. Three things end one: a successful
 * save that provably carried this patch (`clearPendingAfterSave`), a human
 * choosing in the resolution screen (`resolvePending`), and an explicit logout
 * (`clearCache()` with pending in scope).
 */

/** What a failed save hands over. `seq` and `state` are this module's to set. */
export interface QueueInput {
  postId: string;
  userId: string;
  patch: PostPatch;
  baseRevision: number | null;
}

// ------------------------------------------------------------------- reads

/**
 * The seq a save must carry so its success can be judged later. Read at the
 * START of the save, compared in `clearPendingAfterSave` at the end of it.
 * `0` when there is no row — lower than any seq this module ever writes, so a
 * save that began with nothing pending can never delete a row that appeared
 * while it was in flight.
 */
export async function pendingSeq(postId: string, userId: string): Promise<number> {
  const row = await db.pending.get([postId, userId]);
  return row?.seq ?? 0;
}

/**
 * I4 — one post's pending write, for one user, and nothing for any other user.
 *
 * Reading another user's row would be both a disclosure of their draft and,
 * once replayed, a wrong write in this user's name. It does NOT remove the row
 * despite the name the plan gives it: replay can fail, the tab can close
 * mid-request, and a read that consumed the patch would be a way to lose it
 * that no error path could recover from.
 */
export function takePending(
  postId: string,
  userId: string,
): Promise<PendingWrite | undefined> {
  return db.pending.get([postId, userId]);
}

export function listPending(userId: string): Promise<PendingWrite[]> {
  return db.pending.where('ownerUserId').equals(userId).toArray();
}

/**
 * The rows only a human can end — what `#/recover` lists and what `PostGate`
 * checks before it renders the editor for an id.
 */
export async function listPendingForReview(userId: string): Promise<PendingWrite[]> {
  const rows = await listPending(userId);
  return rows.filter((r) => r.state === 'unresolved' || r.state === 'blocked');
}

/**
 * Used by `Dashboard`'s mount-time blank-draft sweep, which must not run while
 * anything is unsent: the server's writer-scoped sweep hard-deletes a post that
 * is blank on the server, and a post written entirely offline is exactly that
 * while its words sit here.
 */
export function countPending(userId: string): Promise<number> {
  return db.pending.where('ownerUserId').equals(userId).count();
}

// ------------------------------------------------------------------ writes

/**
 * Record a retryable failure — offline, 5xx, 429. Called by `savePost` BEFORE
 * it rethrows, so the words are durable before anything can report an error.
 *
 * `seq` comes from the row itself rather than from a module-level counter, so
 * it survives a reload with the row it belongs to. Re-queueing replaces the
 * patch: the newest failed save carries the newest text, and the older patch it
 * supersedes was for the same post at the same base revision.
 */
export async function queuePending(input: QueueInput): Promise<PendingWrite> {
  return db.transaction('rw', db.pending, async () => {
    const existing = await db.pending.get([input.postId, input.userId]);
    const row: PendingWrite = {
      postId: input.postId,
      ownerUserId: input.userId,
      patch: input.patch,
      baseRevision: input.baseRevision,
      seq: (existing?.seq ?? 0) + 1,
      state: 'queued',
      updatedAt: Date.now(),
    };
    await db.pending.put(row);
    return row;
  });
}

/**
 * Move a row to a terminal state after replay. `seq` and `patch` are untouched:
 * the write did not change, only what happened to it.
 *
 * A 409 becomes `unresolved` (two versions exist and a human picks); a
 * permanent 4xx becomes `blocked` and carries the server's reason, without
 * which a 422 is retried on every boot forever and appears on no screen.
 */
export async function markPending(
  postId: string,
  userId: string,
  next: { state: PendingState; detail?: string; path?: string },
): Promise<PendingWrite | undefined> {
  return db.transaction('rw', db.pending, async () => {
    const row = await db.pending.get([postId, userId]);
    if (!row) return undefined;
    const updated: PendingWrite = {
      ...row,
      state: next.state,
      detail: next.detail,
      path: next.path,
      updatedAt: Date.now(),
    };
    await db.pending.put(updated);
    return updated;
  });
}

/**
 * THE CLEAR RULE, and the one round 2 found missing.
 *
 * A save's success path may delete a pending row only if its state is `queued`
 * AND its `seq` is no newer than the one that save carried. Both halves are
 * load-bearing:
 *
 * - **state.** A writer types 500 words offline, then edits the same post from
 *   a phone. Replay 409s, so the row is `unresolved` and the overlay has been
 *   replaced by the higher server revision. `useAutosave` never saw an error,
 *   so no conflict banner appears — and without this check the first keystroke's
 *   successful save deletes the row holding the 500 words. They then exist
 *   nowhere.
 * - **seq.** A save that began when the row was at seq 3 must not delete the
 *   seq 4 row a later failed save wrote while it was in flight. That row holds
 *   text this save never carried.
 *
 * Returns whether the row was deleted, so a caller can tell "cleared" from
 * "left for a human".
 */
export async function clearPendingAfterSave(
  postId: string,
  userId: string,
  carriedSeq: number,
): Promise<boolean> {
  return db.transaction('rw', db.pending, async () => {
    const row = await db.pending.get([postId, userId]);
    if (!row) return false;
    if (row.state !== 'queued') return false;
    if (row.seq > carriedSeq) return false;
    await db.pending.delete([postId, userId]);
    return true;
  });
}

/**
 * The human's explicit choice — "Keep mine" or "Load theirs" in the resolution
 * screen, or an action on `#/recover`. The only unconditional delete in this
 * module, and it is unconditional precisely because someone was shown both
 * versions and decided.
 */
export async function resolvePending(postId: string, userId: string): Promise<void> {
  await db.pending.delete([postId, userId]);
}
