import {
  db,
  type CachedListPost,
  type CachedPost,
  type CachedRevision,
} from './db';
import { isValidDoc } from './doc';
import type { ListPost, Post, PostPatch, Revision } from './types';

/**
 * The read-through cache of what the server holds.
 *
 * Everything here writes to `posts`, `postList` and `revisions` and to nothing
 * else. It does not know `localPosts`, `localRevisions`, `images` or `assetMap`
 * exist, and that ignorance is the design: those four stores hold data that
 * exists nowhere else, and a cache that could reach them is one bug away from
 * deleting the writer's library.
 *
 * IT MUST IMPORT THE `db` SINGLETON. `dexie-react-hooks`' `useLiveQuery`
 * re-emits for writes made from a non-React module only when both sides hold
 * the same `Dexie` instance — a second `new StudioDB()` here would leave the
 * frozen editor showing a row this module has already replaced. Measured
 * against this repo's own dexie/dexie-react-hooks during plan review (§2.1).
 */

// ------------------------------------------------------------- invariants

/**
 * I1 — revision monotonicity, pending-aware.
 *
 * Lower ignored, equal merges, higher replaces. Without the first arm a slow
 * list response resolving after a fast detail fetch rewinds the cached
 * revision, the editor mounts with a `baseRevision` the server has already
 * passed, and the very first autosave 409s — the editor conflicting with
 * itself. That bug happened in this project once and cost a writer their work.
 *
 * The refinement is the second arm's exemption: a row carrying `pendingAt`
 * holds words that exist nowhere else yet, so an EQUAL revision may not touch
 * it. A background revalidation returning the unchanged server row is exactly
 * that case, and merging it would erase the recovered text with data the writer
 * has already seen replaced on screen.
 *
 * Returns the row to write, or `undefined` when the incoming row must be
 * dropped. Generic over both cached shapes; `CachedListPost` simply never
 * carries `pendingAt`, so the exemption is inert there.
 */
function reconcile<T extends { revision: number; pendingAt?: number | null }>(
  existing: T | undefined,
  incoming: T,
): T | undefined {
  if (!existing) return incoming;
  if (incoming.revision < existing.revision) return undefined;
  if (incoming.revision === existing.revision) {
    if (existing.pendingAt != null) return undefined;
    // Merge rather than replace: at equal revision the two rows describe the
    // same version of the post, so a field the incoming row happens not to
    // carry is kept instead of being dropped to `undefined`.
    return { ...existing, ...incoming };
  }
  return incoming;
}

/**
 * `db.posts` and `db.revisions` hold complete documents ONLY.
 *
 * This throws rather than dropping the write because a caller reaching here
 * with a bodyless row means the API contract broke, and the quiet alternative —
 * skip the write, report success — leaves the cache permanently behind the
 * server with nothing anywhere to say so. It mirrors `posts.ts`'s existing
 * "Refusing to persist an invalid document".
 */
function assertFullPost(post: Post): void {
  if (!isValidDoc(post?.content)) {
    throw new Error(
      `Refusing to cache post ${post?.id} without a document: the editor hydrates once per id and would paint an empty document over it`,
    );
  }
}

function assertFullRevision(rev: Revision): void {
  if (!isValidDoc(rev?.content)) {
    throw new Error(
      `Refusing to cache revision ${rev?.id} without a document: RevisionPanel auto-selects the newest and renders its content`,
    );
  }
}

/**
 * The projection, and the reason `cacheList` cannot reach the editor's store
 * even if a future list route starts returning bodies: `content` is destructured
 * away here, not merely absent from the type.
 */
function toListRow(post: ListPost | Post, userId: string): CachedListPost {
  const { content: _dropped, ...rest } = post as Post;
  return { ...rest, ownerUserId: userId };
}

// ------------------------------------------------------------------ writes

/**
 * Cache one full post: the editor's row AND the derived list row, so the
 * dashboard never lags a detail fetch. The two rows are reconciled
 * independently because `cacheList` advances `postList` alone and they can
 * legitimately sit at different revisions.
 */
export async function cachePost(userId: string, post: Post): Promise<void> {
  assertFullPost(post);
  await db.transaction('rw', db.posts, db.postList, async () => {
    // `pendingAt: null` is explicit: a strictly higher server revision means the
    // server has moved past the overlay, so the overlay stops being what the
    // editor paints. The words it held are still in the `pending` row, and
    // `clearPendingAfterSave` is what stops the next save deleting them.
    const incoming: CachedPost = { ...post, ownerUserId: userId, pendingAt: null };
    const next = reconcile(await db.posts.get(post.id), incoming);
    if (next) await db.posts.put(next);

    const nextList = reconcile(await db.postList.get(post.id), toListRow(post, userId));
    if (nextList) await db.postList.put(nextList);
  });
}

/**
 * Cache list projections, and ONLY list projections.
 *
 * `db.posts` is deliberately outside this transaction's scope. Measured here: a
 * write to a table a transaction did not declare throws `NotFoundError` and
 * commits nothing, so "a list response cannot reach the editor's store" is
 * enforced by the runtime rather than by a guard a later edit could weaken.
 * v1 of this plan was killed by exactly that write.
 */
export async function cacheList(userId: string, rows: ListPost[]): Promise<void> {
  if (!rows.length) return;
  await db.transaction('rw', db.postList, async () => {
    for (const row of rows) {
      const next = reconcile(await db.postList.get(row.id), toListRow(row, userId));
      if (next) await db.postList.put(next);
    }
  });
}

/**
 * Cache revision bodies. Revisions are immutable, so there is no monotonicity
 * question here — only the completeness one, which the frozen panel makes
 * sharp.
 *
 * The `ownerUserId` stamped here is for `cachedRevisionIds` and for anything
 * written later; `RevisionPanel.tsx:32` is frozen and queries by `postId`
 * alone. Nothing leaks by it, because the store never holds two users' rows at
 * once — I3 clears it before a different user's session can paint.
 */
export async function cacheRevisions(
  userId: string,
  revisions: Revision[],
): Promise<void> {
  if (!revisions.length) return;
  for (const rev of revisions) assertFullRevision(rev);
  await db.revisions.bulkPut(
    revisions.map((rev): CachedRevision => ({ ...rev, ownerUserId: userId })),
  );
}

/**
 * The overlay: the writer's unsent words, put back where the editor reads them.
 *
 * A failed save writes this at the SAME revision it was based on, so the post
 * on screen after a reload is the one the writer was looking at when the
 * network went away — `Editor.tsx` hydrates from `db.posts` and nothing else
 * can reach it. It deliberately does not go through `reconcile`: this is not a
 * server row, and it must win over the cached one it is overlaying.
 *
 * `pendingAt` is what protects it afterwards — see `reconcile`.
 */
export async function writeOverlay(
  userId: string,
  postId: string,
  patch: PostPatch,
): Promise<CachedPost | undefined> {
  return db.transaction('rw', db.posts, db.postList, async () => {
    const current = await db.posts.get(postId);
    // No cached full post means there is nothing to overlay onto, and inventing
    // one would put a row the server never sent where the editor treats it as
    // truth. The patch is still durable — it is in `pending`.
    if (!current || current.ownerUserId !== userId) return undefined;
    // A patch key holding `undefined` is not the same as an absent one, and
    // spreading `patch` whole would conflate them: `Editor.tsx:193`'s "Keep
    // mine" passes `content: editor?.getJSON()`, which is `undefined` whenever
    // the editor is not mounted, and that would leave `db.posts` holding a row
    // with no document — the one thing this store may not contain.
    const defined: PostPatch = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) Object.assign(defined, { [key]: value });
    }
    const next: CachedPost = {
      ...current,
      ...defined,
      // Not `revision + 1`. The server never accepted this write, so claiming a
      // revision it did not issue would make the next save's CAS check compare
      // against a number that exists only in this browser.
      revision: current.revision,
      pendingAt: Date.now(),
      updatedAt: Date.now(),
    };
    assertFullPost(next);
    await db.posts.put(next);
    // The list row goes through `reconcile` because `syncList` may have already
    // moved it past this revision; the editor's row is the one that must show
    // the writer's text.
    const nextList = reconcile(await db.postList.get(postId), toListRow(next, userId));
    if (nextList) await db.postList.put(nextList);
    return next;
  });
}

// ------------------------------------------------------------------- reads

/**
 * I2 — nothing paints from cache until `/auth/me` has confirmed a user, so
 * every read takes one. A legacy row with no `ownerUserId` (written by
 * `posts.ts` before Task 19 repoints it) matches nobody, which is the safe
 * direction to fail.
 */
export async function cachedPost(
  userId: string,
  id: string,
): Promise<CachedPost | undefined> {
  const row = await db.posts.get(id);
  return row?.ownerUserId === userId ? row : undefined;
}

export function cachedPosts(userId: string): Promise<CachedPost[]> {
  return db.posts.where('ownerUserId').equals(userId).toArray();
}

export function cachedList(userId: string): Promise<CachedListPost[]> {
  return db.postList.where('ownerUserId').equals(userId).toArray();
}

/**
 * Which revision bodies this device already has. Revisions are immutable, so
 * `syncRevisions` fetches only the ids missing from here — ~30 small GETs on
 * the first open of a heavily autosaved post, and none at all thereafter.
 */
export async function cachedRevisionIds(
  userId: string,
  postId: string,
): Promise<Set<string>> {
  const rows = await db.revisions.where('postId').equals(postId).toArray();
  return new Set(rows.filter((r) => r.ownerUserId === userId).map((r) => r.id));
}

// ---------------------------------------------------------------- eviction

/**
 * Forget one post entirely. Driven by a 404 for an id the server had once
 * issued, so it is keyed by id alone rather than by user: a row still here
 * under another user's id after the server has said the post is gone is the
 * last thing we want to keep.
 *
 * Note what this does NOT touch: the `pending` row, if there is one. A 404
 * never mints one (plan §2.3), but if an older one exists its words are still
 * the only copy and `#/recover` is where they are dealt with.
 */
export async function evictPost(id: string): Promise<void> {
  await db.transaction('rw', db.posts, db.postList, db.revisions, async () => {
    await db.posts.delete(id);
    await db.postList.delete(id);
    await db.revisions.where('postId').equals(id).delete();
  });
}

/**
 * I3 — clearing the cache. Called on exactly three events, and no others:
 * a boot where `/auth/me` AUTHORITATIVELY answers 401, `/auth/me` confirming a
 * different user id than the cache holds, and explicit logout. A network
 * failure is not one of them; a mid-session 401 is not one of them either,
 * because `clearCache` deletes the row `Editor.tsx:48` is live-querying and the
 * frozen `if (!post)` branch then replaces the writer's 900 words with "This
 * post no longer exists. It may have been permanently deleted from this
 * browser."
 *
 * The four stores it must never touch are not listed as exclusions — they are
 * simply not named below, and never enumerate `db.tables` here. `localPosts`
 * and `localRevisions` are the pre-backend library, `images` holds bytes no
 * server has, and `assetMap` is what keeps a resumed migration from
 * re-uploading and burning the image slot budget twice.
 *
 * `pending` is cleared only on explicit logout — hence `keepPending` for the
 * other two callers. With it set, `pending` is not even in the transaction's
 * scope, so a write to it here would throw rather than quietly delete unsent
 * words.
 */
export async function clearCache({ keepPending = false } = {}): Promise<void> {
  const tables = keepPending
    ? [db.posts, db.postList, db.revisions]
    : [db.posts, db.postList, db.revisions, db.pending];
  await db.transaction('rw', tables, async () => {
    await db.posts.clear();
    await db.postList.clear();
    await db.revisions.clear();
    if (!keepPending) await db.pending.clear();
  });
}
