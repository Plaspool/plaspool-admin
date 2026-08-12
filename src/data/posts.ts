import { api } from './api';
import {
  cachePost,
  cachedList,
  cachedPost,
  cachedPosts,
  evictPost,
  writeOverlay,
} from './cache';
import { newId } from './db';
import { countWords, docToText, isValidDoc, readingTime } from './doc';
import { isBlankDoc } from './docguards';
import { ApiError, StaleWriteError } from './errors';
import { clearPendingAfterSave, pendingSeq, queuePending } from './pending';
import {
  EMPTY_DOC,
  type ListPost,
  type Post,
  type PostPatch,
  type Query,
  type SaveOptions,
} from './types';

/**
 * The type aliases moved to `shared/types.ts` so `server/` shares them. They
 * are re-exported here so `src/data/posts.ts` keeps its exact public surface.
 */
export type { PostPatch, SaveOptions, Query, StatusFilter, SortKey } from '../../shared/types';

/**
 * WHAT THIS MODULE IS AFTER THE CUTOVER.
 *
 * Every function below used to be a Dexie transaction. Each is now one request
 * plus one cache write, and the signatures are unchanged because three files
 * that call them are frozen (plan §0 F1) — `useAutosave.ts`, `Editor.tsx` and
 * `RevisionPanel.tsx`. Nothing here derives a slug, an excerpt, a word count or
 * a revision number any more: the server does, and a second derivation on this
 * side would be a second answer to a question that has one.
 *
 * What IS still this module's job is the part the server cannot do — making a
 * failed write survive the failure. That is `savePost`'s catch block, and it is
 * the reason this part of the app is meant to beat Ghost 5.x rather than match
 * it: Ghost drops the paragraph you typed while the network was down.
 */

/**
 * Fallback identity for a post shaped locally rather than fetched.
 *
 * Only `createDraftShape` reads these now, and its remaining callers are
 * `src/data/backup.ts`'s import path and the pre-backend `localPosts` corpus —
 * documents that genuinely have no user to name, because they predate accounts.
 * Anything that comes back from the server carries the real author.
 */
const LOCAL_AUTHOR_ID = 'local';
const LOCAL_AUTHOR_NAME = 'You';

// ------------------------------------------------------------- active user

/**
 * WHO THE CACHE ROWS BELONG TO, AND WHY IT IS AMBIENT RATHER THAN A PARAMETER.
 *
 * `cache.ts` and `pending.ts` take a user id on every call, deliberately (I2,
 * I4). This module cannot: `useAutosave.ts:85` calls `savePost(postId, patch,
 * opts)` and `Editor.tsx:379` calls `discardIfBlank(id)`, both frozen, so there
 * is no argument to put a user in. The id therefore has to reach this module
 * out of band, and `session.ts` sets it once `/auth/me` has answered.
 *
 * The default is the empty string rather than a throw. Every caller of this
 * module renders under `RequireAuth`, which does not release until the session
 * is known, so an unset id means a boot-order bug rather than an ordinary
 * state — and the empty string fails toward rows that no user-scoped reader in
 * `cache.ts` will show, which is the same direction `db.ts` chose for legacy
 * rows. Failing the other way — writing under a guessed id — is what v2 of the
 * plan did, and it made an ordinary logout delete the writer's library.
 */
let activeUserId = '';

export function setActiveUser(id: string | null | undefined): void {
  activeUserId = id ?? '';
}

export function activeUser(): string {
  return activeUserId;
}

// ------------------------------------------------------------ pure helpers

/**
 * The shape of a draft, with nothing persisted and nothing requested.
 *
 * STILL PURE, AND STILL EXPORTED. `backup.ts` rebuilds every imported post
 * through it, so a field missing here is a field silently dropped from every
 * bundle — which is why `template` is `?? null` rather than `|| null`.
 */
export function createDraftShape(partial: Partial<Post> = {}): Post {
  const now = Date.now();
  const content = isValidDoc(partial.content) ? partial.content : EMPTY_DOC;
  const text = docToText(content);
  const words = countWords(text);
  return {
    id: partial.id ?? newId('p_'),
    title: partial.title ?? '',
    subtitle: partial.subtitle ?? '',
    slug: partial.slug ?? null,
    excerpt: partial.excerpt ?? '',
    excerptSource: partial.excerptSource ?? (partial.excerpt ? 'author' : 'derived'),
    content,
    coverImage: partial.coverImage ?? null,
    category: partial.category ?? '',
    tags: partial.tags ?? [],
    // `?? null`, not `|| null`: a post that pins a layout must keep it through
    // an export/import round trip, and `backup.ts` rebuilds every imported post
    // through this function. A field missing here is a field silently dropped.
    template: partial.template ?? null,
    status: partial.status ?? 'draft',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    publishedAt: partial.publishedAt ?? null,
    deletedAt: partial.deletedAt ?? null,
    wordCount: partial.wordCount ?? words,
    readingTime: partial.readingTime ?? readingTime(words),
    authorId: partial.authorId ?? LOCAL_AUTHOR_ID,
    authorName: partial.authorName ?? LOCAL_AUTHOR_NAME,
    revision: partial.revision ?? 1,
  };
}

/**
 * The patchable fields, taken one at a time rather than spread.
 *
 * `createPost` accepts a `Partial<Post>` because `Editor.tsx:517` hands it one,
 * but `POST /api/posts` validates its body with a `.strict()` Zod schema and
 * answers **400** for any key outside `PostPatch` — `status`, `revision`,
 * `authorId`, and `migratedAt` on a row from the pre-backend store. A spread
 * would turn "save this as a new post" into a hard 400 the writer cannot act
 * on, so the allow-list is what crosses the wire. It is also what stops a
 * caller reassigning authorship, which the server refuses anyway; two refusals
 * is the right number for that one.
 */
function toPatch(partial: Partial<Post>): PostPatch {
  const patch: PostPatch = {};
  if (partial.title !== undefined) patch.title = partial.title;
  if (partial.subtitle !== undefined) patch.subtitle = partial.subtitle;
  if (partial.content !== undefined) patch.content = partial.content;
  if (partial.coverImage !== undefined) patch.coverImage = partial.coverImage;
  if (partial.category !== undefined) patch.category = partial.category;
  if (partial.tags !== undefined) patch.tags = partial.tags;
  if (partial.excerpt !== undefined) patch.excerpt = partial.excerpt;
  if (partial.template !== undefined) patch.template = partial.template;
  return patch;
}

// ------------------------------------------------------------------ writes

export async function createPost(partial: Partial<Post> = {}): Promise<Post> {
  const post = await api.createPost(toPatch(partial));
  await cachePost(activeUser(), post);
  return post;
}

/**
 * Declared in `./errors` and re-exported here, so this stays the import path
 * every existing call site already uses.
 *
 * IT MUST BE THE SAME CLASS OBJECT, not a copy. `useAutosave.ts:98` — a frozen
 * file — halts into the conflict banner on `err instanceof StaleWriteError`,
 * and a second declaration would make that check quietly false: the conflict
 * would fall through to the generic arm and be retried five times against a
 * revision it can never win. It moved because `api.ts` raises it too, and a
 * class living here would close the cycle `posts.ts` → `api.ts` → `posts.ts`.
 */
export { StaleWriteError };

/**
 * The single mutation path for post content/metadata.
 *
 * The success path is unremarkable. The FAILURE path is the whole of plan
 * §2.3, and every line of it is a defect someone found by reading:
 *
 * - **The pending row is written before the error is rethrown.** `useAutosave`
 *   keeps the patch in memory and retries five times, and that is all that used
 *   to stand between a dropped connection and a lost paragraph. Memory does not
 *   survive a reload; this row does.
 * - **A 409 also caches the server's post.** Without it the frozen conflict
 *   banner lies twice: "Load theirs" (`Editor.tsx:176`) re-reads `db.posts` and
 *   paints the STALE text while saying "Loaded the newer version", and "Keep
 *   mine" (`:190`) rebases onto the same stale revision, so the next save 409s
 *   against the same number, forever.
 * - **Every other failure writes the overlay.** `Editor.tsx:48` hydrates from
 *   `db.posts.get(id)` and nothing else can reach the editor's buffer, so the
 *   overlay is the only thing that can put the writer's words back on screen
 *   after a reload.
 * - **403 and 404 write nothing.** See `recordFailedSave`.
 */
export async function savePost(
  id: string,
  patch: PostPatch,
  opts: SaveOptions = {},
): Promise<Post> {
  const userId = activeUser();
  /*
   * Read BEFORE the request, compared after it. A save that began when nothing
   * was pending must never delete a row that a later failed save wrote while
   * this one was in flight — that row holds text this save never carried.
   */
  const carriedSeq = await pendingSeq(id, userId);
  let saved: Post;
  try {
    saved = await api.savePost(id, patch, opts);
  } catch (err) {
    await recordFailedSave(userId, id, patch, opts, err);
    throw err;
  }
  await cachePost(userId, saved);
  await clearPendingAfterSave(id, userId, carriedSeq);
  return saved;
}

/**
 * Make a failed save durable, then let it propagate unchanged.
 *
 * This function must not throw. Whatever it does with the patch, the caller's
 * error is the one `useAutosave` has to see: swapping a 409 for a Dexie quota
 * error would send the conflict down the generic retry arm, which is the exact
 * failure the `StaleWriteError` re-export exists to prevent.
 */
async function recordFailedSave(
  userId: string,
  id: string,
  patch: PostPatch,
  opts: SaveOptions,
  err: unknown,
): Promise<void> {
  const status = err instanceof ApiError ? err.status : -1;

  /*
   * 403 AND 404 MINT NOTHING (plan §2.3).
   *
   * A 403 means this post is not this writer's to edit (F14) and a 404 means it
   * is gone. A pending row for either is retried on every boot for the life of
   * the browser profile and can never succeed — it would sit on `#/recover`
   * forever offering to replay a write the server will never take.
   *
   * A 404 deliberately does NOT evict the cached row either, even though
   * `syncPost` does. `useAutosave.ts:103` turns this error into `state: 'gone'`
   * and `Editor.tsx:506` renders "This post was deleted elsewhere / Save as a
   * new post" — a banner ABOVE the writer's text. Evicting here would empty the
   * live query behind it and the frozen `if (!post)` branch would replace the
   * whole surface with a tombstone, taking the words the banner just promised
   * were still on screen.
   */
  if (status === 403 || status === 404) return;

  try {
    /*
     * `queued` even for a 409 and even for a 422. The three terminal states are
     * set by REPLAY (plan §2.3's table), which is the only thing that knows a
     * failure repeated. Marking a 409 `unresolved` here would be worse than
     * useless: the conflict banner is already on screen, and its "Keep mine"
     * button is a save whose success must be allowed to clear this row —
     * `clearPendingAfterSave` refuses to delete anything that is not `queued`,
     * so the row would outlive the conflict a human just resolved and
     * `PostGate` would re-open the resolution screen on the next visit.
     */
    await queuePending({
      postId: id,
      userId,
      patch,
      baseRevision: opts.baseRevision ?? null,
    });

    if (err instanceof StaleWriteError) {
      /*
       * The 409 carries the server's CURRENT post, content and all
       * (`server/repo/posts.ts` passes `getPost`'s result), so caching it is
       * what makes both halves of the frozen banner tell the truth. It also
       * clears `pendingAt`, which is correct: the server has moved past the
       * overlay, and the writer's words are in the row queued above.
       */
      if (err.post) await cachePost(userId, err.post);
      return;
    }

    /*
     * Everything else — offline, 5xx, 429, 401, 422, 400 — leaves the writer
     * looking at text that exists in no store. The overlay is what a reload
     * finds. It is written at the SAME revision, so the next save's CAS check
     * still compares against a number the server issued.
     */
    await writeOverlay(userId, id, patch);
  } catch {
    /*
     * Swallowed on purpose. If IndexedDB itself is unwritable there is nothing
     * left to try, and `useAutosave`'s error banner ("copy it somewhere safe
     * before closing this tab") is a better outcome than replacing the server's
     * error with a storage one the writer can do nothing about.
     */
  }
}

// -------------------------------------------------------------- lifecycle

/**
 * The six lifecycle routes.
 *
 * Each answers with the NEW post, and caching it is not just tidiness:
 * `Editor.tsx:285`'s `adopt` sets `baseRevision` from the returned post, and
 * the live query behind it reads `db.posts`. A lifecycle call that bumped the
 * revision server-side without caching the result would leave the dashboard a
 * revision behind and the next background `syncPost` would look like a change
 * the writer did not make.
 */
export async function publishPost(id: string): Promise<Post> {
  return adopt(await api.publishPost(id));
}
export async function unpublishPost(id: string): Promise<Post> {
  return adopt(await api.unpublishPost(id));
}
export async function archivePost(id: string): Promise<Post> {
  return adopt(await api.archivePost(id));
}
export async function unarchivePost(id: string): Promise<Post> {
  return adopt(await api.unarchivePost(id));
}
/** Soft delete. The row and every revision stay intact, server-side. */
export async function trashPost(id: string): Promise<Post> {
  return adopt(await api.trashPost(id));
}
export async function restorePost(id: string): Promise<Post> {
  return adopt(await api.restorePost(id));
}

async function adopt(post: Post): Promise<Post> {
  await cachePost(activeUser(), post);
  return post;
}

export async function duplicatePost(id: string): Promise<Post> {
  const copy = await api.duplicatePost(id);
  await cachePost(activeUser(), copy);
  return copy;
}

/**
 * The only destructive operation in the app. Owner-only server-side (F7).
 *
 * NO `collectOrphanImages` HERE ANY MORE, and that is a decision rather than an
 * omission: `POST /api/images/collect-orphans` is owner-only too, so for a
 * writer the old best-effort sweep is a guaranteed 403 attached to every
 * delete. It was already `.catch(() => {})`, so nothing would have broken — but
 * a request that is known to fail is not "best effort", it is noise in the
 * network tab and one more thing to explain. The server sweeps orphans on its
 * own schedule and the two-phase quarantine (`server/repo/images.ts`) is what
 * makes that safe.
 */
export async function destroyPost(id: string): Promise<void> {
  await api.destroyPost(id);
  await evictPost(id);
}

/** All-or-nothing, server-side. Owner-only. */
export async function emptyTrash(): Promise<number> {
  const emptied = await api.emptyTrash();
  /*
   * Evict from the cache what the server has just destroyed. The route answers
   * with a count rather than a list of ids, so the ids come from this device's
   * own view of the trash — which is what the writer was looking at when they
   * clicked. A row this device has not seen yet is simply never cached, and a
   * row the server did not have is one `syncList` restores.
   */
  const trashed = new Set<string>();
  for (const p of await cachedPosts(activeUser())) {
    if (p.deletedAt != null) trashed.add(p.id);
  }
  for (const p of await cachedList(activeUser())) {
    if (p.deletedAt != null) trashed.add(p.id);
  }
  for (const id of trashed) await evictPost(id);
  return emptied;
}

/**
 * Owner-only mark-and-sweep over object storage.
 *
 * Kept as a named export because it is a route and because `Settings` may
 * surface it; nothing in the delete path calls it any more — see `destroyPost`.
 */
export async function collectOrphanImages(): Promise<number> {
  const { collected } = await api.collectOrphanImages();
  return collected;
}

// ------------------------------------------------------------ blank drafts

/**
 * A draft with no title, no words, no cover and no metadata.
 *
 * THE FIRST LINE IS F10 AND IT IS NOT DEFENSIVE PROGRAMMING. `isBlankDoc`
 * answers `true` for `undefined` — measured — because an absent document is
 * genuinely blank for the sweep the server runs. But a *cached* row can be
 * incomplete for reasons that have nothing to do with the writer: a legacy row
 * from before the cutover, a partially-written one. Reading "no content" as
 * "blank" there means destroying a real post, and its whole server-side
 * revision history with it, on the strength of a field that failed to arrive.
 * An unparseable document counts as content — the same direction the server's
 * own blank predicate takes.
 */
export function isBlankDraft(p: Post): boolean {
  if (!isValidDoc(p?.content)) return false;
  return (
    // Scalar checks first: `sweepBlankDrafts` runs on every dashboard mount, so
    // the document walk must only happen for drafts that are blank on the cheap
    // criteria. Round 1 already caught one "cost scales with document length".
    p.status === 'draft' &&
    p.deletedAt == null &&
    p.title.trim() === '' &&
    p.subtitle.trim() === '' &&
    p.wordCount === 0 &&
    !p.coverImage &&
    p.tags.length === 0 &&
    p.category === '' &&
    // `wordCount === 0` is not emptiness. An image-only or divider-only draft
    // has no words and was being destroyed — with its image bytes — the instant
    // the writer left the editor. See isBlankDoc.
    isBlankDoc(p.content)
  );
}

/**
 * "New post" then immediately leaving used to leave a permanent Untitled row
 * in the dashboard. Discard it on the way out.
 *
 * THIS FUNCTION MAY NOT REJECT, EVER (F7). `Editor.tsx:375–381` is frozen and
 * reads:
 *
 *     await flush();
 *     await discardIfBlank(id);
 *     navigate('/');
 *
 * `DELETE /api/posts/:id` is owner-only (`authorize.ts:48`), so for a writer
 * this is a 403 on every blank draft they abandon — and an unhandled rejection
 * between `await` and `navigate` never reaches the navigate. The writer clicks
 * "Posts" and nothing happens. Again. There is no error boundary on that path
 * and no way out of the screen but the browser's own back button.
 *
 * Swallowing costs nothing: the server's writer-scoped `sweep-blank` reaps the
 * draft on the next dashboard mount anyway, which is where this behaviour
 * actually lives now.
 */
export async function discardIfBlank(id: string): Promise<boolean> {
  try {
    const p = await cachedPost(activeUser(), id);
    /*
     * REFUSE TO ACT ON INCOMPLETE INFORMATION (F10).
     *
     * The `!p` half is the one that decides on its own: there may be no cached
     * full post for this id at all — the editor can be reached with only a
     * `postList` row, or with a row cached for a different user — and
     * `isBlankDraft` would then be asked about nothing.
     *
     * The `isValidDoc` half is a SECOND COPY of the guard `isBlankDraft` opens
     * with, and measured by mutation it is redundant: removing it alone leaves
     * every test green, because the predicate refuses first. It is kept as
     * defence in depth on the one call that ends in `destroyPost`, and it is
     * labelled here so nobody reads its survival as proof that it is load-
     * bearing. The guard that actually decides is in `isBlankDraft`.
     */
    if (!p || !isValidDoc(p.content)) return false;
    if (!isBlankDraft(p)) return false;
    await destroyPost(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The grace window the server enforces, mirrored here for ONE purpose: picking
 * which cached rows to evict after a sweep. It is not a second decision — the
 * route decides — and if the two ever disagree the only consequence is a stale
 * card until the next `syncList`.
 */
const BLANK_DRAFT_GRACE_MS = 60_000;

/**
 * Sweep blank drafts left behind by any exit route the editor cannot see —
 * browser Back, a closed tab, a crash. Writer-scoped server-side.
 *
 * `POST /api/posts/sweep-blank` answers with a count, not with ids, so the
 * eviction below is over this device's own candidates and only runs when the
 * server says it actually swept something. Evicting nothing when it swept one
 * leaves a card that `syncList` clears; evicting one it kept would take a row
 * out from under an open editor, so the candidate set is deliberately the
 * narrow one — same predicate, same grace window, never `exceptId`.
 */
export async function sweepBlankDrafts(exceptId?: string): Promise<number> {
  const userId = activeUser();
  const now = Date.now();
  const candidates = (await cachedPosts(userId)).filter(
    (p) =>
      p.id !== exceptId &&
      isBlankDraft(p) &&
      now - p.updatedAt > BLANK_DRAFT_GRACE_MS,
  );
  const swept = await api.sweepBlankDrafts(exceptId);
  if (swept > 0) {
    for (const p of candidates) await evictPost(p.id);
  }
  return swept;
}

// ---------------------------------------------------------------- queries

/**
 * Generic over the row shape, because the dashboard now sorts `ListPost`
 * projections from `db.postList` while the editor's own store still holds full
 * posts (F13, plan §4). Returning `T[]` rather than `ListPost[]` is what lets
 * `Dashboard` keep passing whatever it read straight into `PostCard`.
 *
 * The `content` branch is guarded by `'content' in p` rather than by a cast.
 * `docToText` is null-safe — measured: it answers `''` for `undefined` — so the
 * guard is not what stops a crash. It is what keeps the narrowing honest: `T`
 * has no `content` by its constraint, so the alternative is a cast that claims
 * every row is a full `Post`, and the next reader has no way to tell that the
 * body is searched for editor rows and absent for list rows. Search over list
 * rows is title/subtitle/excerpt/category/tags, and §5 sends a non-empty query
 * to the server for exactly that reason.
 */
export function filterAndSort<T extends ListPost>(posts: T[], q: Query): T[] {
  const needle = q.search.trim().toLowerCase();
  const out = posts.filter((p) => {
    if (q.status === 'trash') {
      if (p.deletedAt == null) return false;
    } else {
      if (p.deletedAt != null) return false;
      if (q.status !== 'all' && p.status !== q.status) return false;
    }
    if (q.category && p.category !== q.category) return false;
    if (q.tag && !p.tags.includes(q.tag)) return false;
    if (needle) {
      const hay = [
        p.title,
        p.subtitle,
        p.excerpt,
        p.category,
        p.tags.join(' '),
        'content' in p ? docToText((p as unknown as Post).content).slice(0, 4000) : '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const byTitle = (a: T, b: T) =>
    (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, {
      sensitivity: 'base',
    });

  switch (q.sort) {
    case 'updated':
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'published':
      return out.sort(
        (a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity),
      );
    case 'oldest':
      return out.sort((a, b) => a.createdAt - b.createdAt);
    case 'alphabetical':
      return out.sort(byTitle);
    case 'drafts-first':
      return out.sort((a, b) => {
        const rank = (p: T) => (p.status === 'draft' ? 0 : p.status === 'published' ? 1 : 2);
        return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
      });
    default:
      return out;
  }
}
