/**
 * ONE curated rail, for every surface that shows one.
 *
 * Three views read the same four rows: the editor's "Feature this post" toggle,
 * the "n of 4" counter beside it, and the featured manager. They must never
 * disagree — a counter reading "3 of 4" next to a toggle that has just been
 * refused is worse than either being absent — and two of them can be mounted a
 * second apart, so a fetch per component would also be two identical GETs for
 * one screen. This module is the one answer all three read.
 *
 * ═══ THE STORE IS MODULE-SCOPED, LIKE `useCategories` ═══
 * Opening a post unmounts the manager, so a component-scoped cache would re-ask
 * on every trip back. The `inFlight` dedupe is a PROMISE rather than a boolean
 * so a second caller lands on the same answer instead of being told someone
 * else is asking and having to guess when to look again.
 *
 * ═══ NOTHING HERE IS CACHED IN DEXIE, AND NOTHING IS QUEUED OFFLINE ═══
 * Every other write in this app leaves a `pending` row when the network refuses
 * (`src/data/pending.ts`). Curation deliberately does not: the four-slot cap is
 * a global server invariant that cannot be evaluated against a local mirror, so
 * two tabs offline would each queue a feature and both believe they fit, and
 * the 409 would surface hours later with no editor open to resolve it.
 *
 * The same reasoning rules out a Dexie fallback for the READ. `useCategories`
 * degrades to a list derived from cached posts because an approximate category
 * list is better than an empty picker. There is no way to derive which four
 * posts are curated, and guessing would put a post on screen as "featured" that
 * is not — so an unreachable rail says `unavailable` and the UI says so too.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import { FeaturedConflictError } from './errors';
import { MAX_FEATURED, type FeaturedItem } from './types';

export type FeaturedStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface FeaturedSnapshot {
  status: FeaturedStatus;
  /** The rail in rank order. Empty in every state except `ready`. */
  items: FeaturedItem[];
  /**
   * Whose blog this rail belongs to.
   *
   * `logout()` calls `clearCache()`, which empties Dexie and cannot reach a
   * module variable — so without this, signing out and back in as someone else
   * on a shared machine leaves the previous account's rail on screen. Invariant
   * I2, the same one `useCategories` states.
   */
  userId: string;
}

const EMPTY: FeaturedSnapshot = { status: 'idle', items: [], userId: '' };

let snapshot: FeaturedSnapshot = EMPTY;
let inFlight: Promise<void> | null = null;
/** Which load is the current one, so an overtaken one cannot clear its handle. */
let loadSeq = 0;
const listeners = new Set<() => void>();

/** The current store value. Stable identity between publishes, as the hook needs. */
export function featuredSnapshot(): FeaturedSnapshot {
  return snapshot;
}

export function subscribeFeatured(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(next: FeaturedSnapshot): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

/**
 * Adopt a rail an endpoint just handed back, if it is still this account's.
 *
 * Every mutation answers with the WHOLE rail, so this is the only write path
 * the store needs — there is no second GET after a feature, and therefore no
 * window in which the counter and the toggle disagree.
 */
function adopt(userId: string, items: FeaturedItem[]): void {
  // A late answer for an account that has since been replaced is not this
  // account's data. Dropping it is the only thing that can be done with it.
  if (snapshot.userId !== userId) return;
  publish({ status: 'ready', items, userId });
}

/** Fetch the rail, at most once at a time. */
export function loadFeatured(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const switched = userId !== snapshot.userId;
  if (switched) {
    inFlight = null;
    publish({ ...EMPTY, userId });
  } else if (inFlight) {
    return inFlight;
  } else if (snapshot.status === 'ready' && !opts.force) {
    return Promise.resolve();
  }

  publish({ ...snapshot, status: 'loading' });
  const seq = ++loadSeq;
  const run = (async () => {
    try {
      adopt(userId, await api.listFeatured());
    } catch {
      if (snapshot.userId !== userId) return;
      /*
       * A REFRESH THAT FAILS MUST NOT EMPTY A MANAGER THAT WAS WORKING. The
       * first failure — nothing fetched yet — is the honest `unavailable`; a
       * failure after a good answer keeps the good answer, because a dropped
       * connection has told us nothing about what is featured.
       */
      publish({
        ...snapshot,
        status: snapshot.items.length > 0 ? 'ready' : 'unavailable',
      });
    } finally {
      // Only the NEWEST load clears the handle: a sign-in as a second account
      // starts a second load while this one is open, and without the sequence
      // check the slower would clear the faster one's handle on its way out.
      if (seq === loadSeq) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Run a mutation and adopt whatever rail comes back — INCLUDING FROM A 409.
 *
 * The server sends the current rail with every `featured_full` and
 * `featured_stale` precisely so the admin can offer a swap or re-render, so a
 * refusal is also an answer: adopting it means the manager and the counter are
 * correct the moment the error is raised, rather than showing the stale list
 * the request was built from until somebody reloads.
 *
 * A 422 `not_featurable` carries no rail and is left alone. "This post is a
 * draft" is a fact about the POST, and reading it as a statement about the four
 * would empty a manager for a reason that has nothing to do with it.
 */
async function mutate(
  userId: string,
  run: () => Promise<FeaturedItem[]>,
): Promise<FeaturedItem[]> {
  try {
    const items = await run();
    adopt(userId, items);
    return items;
  } catch (err) {
    if (err instanceof FeaturedConflictError) adopt(userId, err.items);
    throw err;
  }
}

/** Put a post on the rail, optionally taking `replace`'s slot and its rank. */
export function featureOne(
  userId: string,
  id: string,
  replace?: string,
): Promise<FeaturedItem[]> {
  return mutate(userId, () => api.featurePost(id, replace));
}

export function unfeatureOne(userId: string, id: string): Promise<FeaturedItem[]> {
  return mutate(userId, () => api.unfeaturePost(id));
}

/** The WHOLE order, never one row — invariant 4 of the storefront's contract. */
export function reorderRail(userId: string, ids: string[]): Promise<FeaturedItem[]> {
  return mutate(userId, () => api.reorderFeatured(ids));
}

/** Drop everything. Exported for tests, which must not share a module cache. */
export function resetFeatured(): void {
  inFlight = null;
  loadSeq += 1;
  publish(EMPTY);
}

export interface UseFeatured {
  /** The rail in rank order. */
  items: FeaturedItem[];
  /** How many are featured, and out of how many. Drawn as "n of 4". */
  count: number;
  limit: number;
  full: boolean;
  /** A first fetch is in flight and there is nothing to show yet. */
  loading: boolean;
  /**
   * The rail could not be read. NOT the same as an empty one — see the note at
   * the top of this file about why there is no fallback.
   */
  unavailable: boolean;
  isFeatured: (id: string) => boolean;
  reload: () => void;
}

export function useFeatured(userId: string): UseFeatured {
  const snap = useSyncExternalStore(subscribeFeatured, featuredSnapshot, featuredSnapshot);

  useEffect(() => {
    if (!userId) return;
    void loadFeatured(userId);
  }, [userId]);

  /** The store is only this component's if it is holding this account's data. */
  const mine = snap.userId === userId;
  const items = useMemo(() => (mine ? snap.items : []), [mine, snap.items]);

  const isFeatured = useCallback(
    (id: string) => items.some((item) => item.id === id),
    [items],
  );
  const reload = useCallback(() => {
    void loadFeatured(userId, { force: true });
  }, [userId]);

  return {
    items,
    count: items.length,
    limit: MAX_FEATURED,
    full: items.length >= MAX_FEATURED,
    loading: mine && snap.status === 'loading' && items.length === 0,
    unavailable: mine && snap.status === 'unavailable',
    isFeatured,
    reload,
  };
}
