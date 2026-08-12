import { api } from './api';
import {
  cacheList,
  cachePost,
  cacheRevisions,
  cachedRevisionIds,
  evictPost,
} from './cache';
import { db } from './db';
import { ApiError, StaleWriteError } from './errors';
import {
  clearPendingAfterSave,
  listPending,
  markPending,
} from './pending';
import type { ListPost, Revision, RevisionMeta, StatusFilter } from './types';

/**
 * THE SEAM (plan §3).
 *
 * Nothing in `src/` fetched before this file existed, and the three files that
 * most need fresh data — `Editor.tsx`, `RevisionPanel.tsx`, `useAutosave.ts` —
 * are frozen and read Dexie. So the shape of the whole cutover is: this module
 * pulls, `cache.ts` writes what it pulled into the stores those files already
 * live-query, and they never learn that a server exists (F2).
 *
 * Everything here takes an explicit `userId`. The cache is user-scoped (I2) and
 * `pending` is user-keyed (I4); a sync that guessed would be the disclosure
 * those two invariants exist to prevent.
 */

/** `MAX_PAGE_LIMIT` in `server/repo/cursor.ts`. A larger value is a 400. */
const PAGE_LIMIT = 100;

/**
 * A cursor that never advances would page forever. The server's cursor is a
 * signed keyset over `(sort key, id)` so this cannot happen today; the bound is
 * here because "cannot happen" and "cannot hang the boot" are different claims,
 * and this loop runs before `PostGate` releases.
 */
const MAX_PAGES = 200;

/**
 * BOTH STATUS VIEWS, AND THAT IS NOT AN OPTIMISATION SLIP.
 *
 * `server/repo/query.ts` pushes `deleted_at IS NULL` for every status except
 * `trash`, so `status=all` genuinely means "everything not in the trash". One
 * pass would leave the Trash tab permanently empty while the dashboard's own
 * counts claimed otherwise.
 */
const LIST_VIEWS: StatusFilter[] = ['all', 'trash'];

/**
 * Every page of both views into `postList`.
 *
 * Full-set sync is deliberate and is recorded as a scaling limit rather than
 * defended: the dashboard's tab counts, category options, tag filter and five
 * sorts are all computed over the whole set, and every one of them lies against
 * a partial page — "3 drafts" beside a grid of seven is worse than a slow load.
 *
 * Returns how many rows were cached, which is what a caller needs to tell
 * "synced, and there is nothing" from "never synced".
 */
export async function syncList(userId: string): Promise<number> {
  let cached = 0;
  for (const status of LIST_VIEWS) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await api.listPosts({ status, cursor, limit: PAGE_LIMIT });
      // Written page by page rather than accumulated: a run that dies on page
      // four leaves three pages of dashboard rather than none.
      await cacheList(userId, res.items as ListPost[]);
      cached += res.items.length;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  }
  return cached;
}

/**
 * What `PostGate` branches on. Cases 4, 5 and 6 of plan §3 in one return type.
 */
export type SyncPostResult = 'ok' | 'gone' | 'offline';

/**
 * One full post into `db.posts` — the store the frozen editor hydrates from.
 *
 * **A 404 EVICTS.** The row has to go, and this is the one place that may
 * remove it: the server was asked about an id it had once issued and answered
 * that the post is destroyed. Leaving the cached row behind renders a complete,
 * editable post that no longer exists anywhere — the writer keeps typing into
 * it, every save 404s, and the deletion screen `Editor.tsx:355` exists to show
 * can never appear because the live query keeps returning a row.
 *
 * That is the opposite of `savePost`'s 404, which deliberately keeps the row so
 * the words stay on screen under the "Save as a new post" banner. The
 * difference is what the writer is doing at the time, and it is why the two
 * paths do not share this decision.
 */
export async function syncPost(userId: string, id: string): Promise<SyncPostResult> {
  try {
    const post = await api.getPost(id);
    await cachePost(userId, post);
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await evictPost(id);
      return 'gone';
    }
    /*
     * `transient` is status 0, 429 and 5xx — every answer that might be
     * different in a minute. `PostGate` turns this into "Can't load this post —
     * you're offline", never the deletion message.
     *
     * A 401 or 403 is deliberately rethrown rather than folded in here.
     * Telling a writer to check their connection for a session that expired, or
     * for a post they may not read, is advice that cannot work: `session.ts`
     * owns the first and plan §3 case 3 owns the second.
     */
    if (err instanceof ApiError && err.transient) return 'offline';
    throw err;
  }
}

/** Bodies are fetched in parallel, but four at a time — see `syncRevisions`. */
const REVISION_CONCURRENCY = 4;

/**
 * The frozen `RevisionPanel` lists `db.revisions` by `postId`, auto-selects
 * `[0]` and renders `selected.content`, so history has to be in Dexie complete
 * before the panel can open. That means metadata first, then a body per
 * revision this device does not already hold.
 *
 * **Only the missing ones.** Revisions are immutable, so this is one-time per
 * revision per device: ~30 small GETs the first time a heavily autosaved post
 * is opened, and none at all after that. The server route that would collapse
 * it into one request is named in the ledger, not built.
 *
 * **Newest first**, because `RevisionPanel` auto-selects the newest and a
 * writer who opens History and closes it again has usually only needed that one.
 *
 * **And it prunes.** The server keeps the newest 30 autosaves
 * (`server/routes/posts.ts:219`) and nothing ever evicted the cached copies, so
 * the panel would go on offering revisions the server deleted — and restoring
 * one would write a document from a snapshot that no longer exists in history.
 * The prune is bounded to the revision range the fetched page actually covers,
 * so paginating backwards through history cannot delete the half of it this
 * call never asked about.
 *
 * Returns how many bodies were fetched.
 */
export async function syncRevisions(userId: string, postId: string): Promise<number> {
  const page = await api.listRevisions(postId, undefined, PAGE_LIMIT);
  const metas = page.items;
  if (!metas.length) return 0;

  await pruneCachedRevisions(postId, metas);

  const have = await cachedRevisionIds(userId, postId);
  const missing = metas
    .filter((m) => !have.has(m.id))
    .sort((a, b) => b.revision - a.revision)
    .map((m) => m.id);
  if (!missing.length) return 0;

  const fetched = await fetchRevisionBodies(missing);
  await cacheRevisions(userId, fetched);
  return fetched.length;
}

/**
 * A fixed-size pool rather than `Promise.all` over everything: thirty parallel
 * GETs against one origin queue in the browser anyway and, on the server side,
 * are thirty connections held for a panel the writer may not even open.
 *
 * One 404 skips that revision — the server prunes autosaves, so a body can
 * genuinely disappear between the listing and the fetch. Anything else stops
 * the pool: an expired session or a dropped link fails every remaining request
 * identically, and twenty-nine more attempts to prove it is not what the writer
 * is waiting for.
 */
async function fetchRevisionBodies(ids: string[]): Promise<Revision[]> {
  const out: Revision[] = [];
  let next = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const i = next++;
      if (i >= ids.length) return;
      try {
        out.push(await api.getRevision(ids[i]));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) continue;
        stop = true;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REVISION_CONCURRENCY, ids.length) }, worker),
  );
  return out;
}

/**
 * Drop cached revisions the fetched page no longer lists, within the range that
 * page covers.
 *
 * Reaching into `db.revisions` from here rather than from `cache.ts` is a
 * deliberate exception to that module's ownership: the bound is the fetched
 * page, so the delete and the fetch that justifies it belong in one place. It
 * is keyed by `postId` and by revision number, never by user — the store never
 * holds two users' rows at once (I3 clears it before another user can paint),
 * and a row left behind after the server has deleted its subject is the thing
 * this exists to remove.
 */
async function pruneCachedRevisions(postId: string, metas: RevisionMeta[]): Promise<void> {
  const listed = new Set(metas.map((m) => m.id));
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of metas) {
    if (m.revision < lo) lo = m.revision;
    if (m.revision > hi) hi = m.revision;
  }
  const stale = (await db.revisions.where('postId').equals(postId).toArray()).filter(
    (r) => r.revision >= lo && r.revision <= hi && !listed.has(r.id),
  );
  if (stale.length) await db.revisions.bulkDelete(stale.map((r) => r.id));
}

// ------------------------------------------------------------------ replay

export interface ReplayReport {
  /** Rows that landed and were cleared. */
  sent: number;
  /** Rows that hit a 409 and now need a human (plan §2.3). */
  unresolved: number;
  /** Rows the server will never accept. Listed on `#/recover` with the reason. */
  blocked: number;
  /** Rows still worth another boot. */
  queued: number;
}

/**
 * Replay every unsent write for this user, once, on an authenticated boot.
 *
 * Runs before `PostGate` releases, because the alternative is an editor that
 * opens on the server's version of a post while the writer's newer words sit in
 * a row nothing has looked at yet.
 *
 * The three arms are plan §2.3's table and each one is a different way of
 * refusing to lose the patch:
 *
 * - success → delete, but through `clearPendingAfterSave`, which refuses to
 *   delete a row newer than the `seq` this replay carried. A failed save landing
 *   while the replay was in flight writes a higher `seq`, and that row holds
 *   text this request never sent.
 * - **409 → `unresolved` plus the server's post.** Two versions now exist; the
 *   resolution screen shows both. Caching the server's post is what lets it.
 * - permanent 4xx → `blocked`, carrying the server's reason. Without this arm a
 *   422 — and `MAX_CONTENT_TEXT_BYTES` is a live source of them (§9) — is
 *   retried on every boot, never marked, therefore listed nowhere, while the
 *   editor simply never saves and says nothing about why.
 * - retryable → left `queued`, overlay untouched.
 *
 * A 401 is NOT permanent here, whatever its status code says: re-authenticating
 * makes the same request succeed. Marking it `blocked` would strand a writer
 * whose cookie expired overnight behind a recovery screen they never needed.
 */
export async function replayPending(userId: string): Promise<ReplayReport> {
  const report: ReplayReport = { sent: 0, unresolved: 0, blocked: 0, queued: 0 };
  const rows = await listPending(userId);

  for (const row of rows) {
    /*
     * `unresolved` and `blocked` are terminal by definition — a human ends
     * them. Re-sending a `blocked` row would re-earn the same 422 on every
     * boot, and re-sending an `unresolved` one would overwrite the server post
     * the resolution screen is showing beside the writer's version.
     */
    if (row.state !== 'queued') {
      if (row.state === 'unresolved') report.unresolved++;
      else report.blocked++;
      continue;
    }

    try {
      const saved = await api.savePost(row.postId, row.patch, {
        baseRevision: row.baseRevision ?? undefined,
        kind: 'autosave',
      });
      await cachePost(userId, saved);
      await clearPendingAfterSave(row.postId, userId, row.seq);
      report.sent++;
    } catch (err) {
      if (err instanceof StaleWriteError) {
        await markPending(row.postId, userId, {
          state: 'unresolved',
          detail: `Someone saved revision ${err.actual} while this was unsent`,
        });
        // The 409 body carries the server's post complete with its document
        // (`server/repo/posts.ts`), so the resolution screen can render both
        // versions without a second request — and "Load theirs" reads the
        // newer one rather than the row this patch was based on.
        if (err.post) await cachePost(userId, err.post);
        report.unresolved++;
        continue;
      }
      if (err instanceof ApiError && !err.transient && err.status !== 401) {
        await markPending(row.postId, userId, {
          state: 'blocked',
          detail: err.detail ?? err.message,
          path: typeof err.detail === 'string' ? err.detail : undefined,
        });
        report.blocked++;
        continue;
      }
      // Offline, 5xx, 429, or a session to renew. The row and its overlay stay
      // exactly as they are.
      report.queued++;
    }
  }

  return report;
}

// -------------------------------------------------------------- revalidate

/** `/edit/p_x` and `/read/p_x` under the hash router's in-hash pathname. */
const POST_ROUTE = /^\/(edit|read)\/([^/]+)$/;

/**
 * What the app shell calls on every navigation.
 *
 * Deliberately total: it swallows everything. A revalidation is a background
 * refresh of data the screen already has, so an offline boot must paint from
 * cache rather than surface an error, and `api.ts` has already dispatched
 * `auth-expired` for a 401 by the time the rejection gets here.
 *
 * The route decides what to pull, because the alternative — always syncing
 * everything — puts a full two-view list walk in front of every keystroke-sized
 * navigation. Revisions are fetched only for `/edit/:id`: `/read/:id` has no
 * History panel, and paying ~30 GETs to render a preview would be the cost
 * without the feature.
 */
export async function revalidate(userId: string, pathname: string): Promise<void> {
  try {
    const match = POST_ROUTE.exec(pathname);
    if (!match) {
      await syncList(userId);
      return;
    }
    const [, mode, id] = match;
    const result = await syncPost(userId, decodeURIComponent(id));
    // No history for a post the server says is gone, and none to fetch while
    // offline — both would be requests whose answer is already known.
    if (result === 'ok' && mode === 'edit') await syncRevisions(userId, decodeURIComponent(id));
  } catch {
    /* see above — a background refresh has no error surface of its own */
  }
}
