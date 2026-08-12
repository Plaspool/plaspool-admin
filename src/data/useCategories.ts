/**
 * ONE category list, for every surface that shows one.
 *
 * Until now there were two derivations of the same thing and they were not the
 * same code: the dashboard filter took `[...new Set(...)]` over the cached list
 * MINUS the trashed rows (`Dashboard.tsx`), and the editor's Details panel took
 * the same set INCLUDING them (`MetaPanel.tsx`). So a category carried only by
 * a post in the trash was offered in the editor and absent from the filter, and
 * neither file said which answer was meant to be right. Settings is about to
 * grow a third list. This module is the one answer all three read.
 *
 * THE CACHE IS MODULE-SCOPED, NOT COMPONENT-SCOPED, and that is the point of it
 * rather than an optimisation. Opening a post unmounts the dashboard, so a
 * per-component fetch would re-ask on every trip back — and the dashboard, the
 * Details panel and the Settings section can all be mounted within a second of
 * each other, which without the in-flight dedupe below is three identical GETs
 * for one screen.
 *
 * DEGRADING IS PART OF THE CONTRACT. `GET /api/categories` is landing in a
 * parallel workstream, so on any build where it 404s — or on any device that is
 * simply offline — this falls back to the Dexie-derived list rather than
 * showing an empty picker, which would read as "this blog has no categories"
 * rather than as "we could not ask". Same distinction the dashboard's search
 * empty state spends a paragraph on.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { cachedList } from './cache';
import { categoriesApi, type CategorySummary } from './api-categories';

/** Where the list a component is holding actually came from. */
export type CategorySource = 'server' | 'cache';

export type CategoriesStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface CategoriesSnapshot {
  status: CategoriesStatus;
  /** The route's answer. Empty in every state except `ready`. */
  categories: CategorySummary[];
  /**
   * Names created through a "New category…" affordance this session.
   *
   * Held apart from `categories` because they have to show up in every picker
   * whichever list is being displayed — including the fallback one, where the
   * name is not on any cached post yet and so cannot be derived. A server list
   * that arrives already knowing a name drops it from here.
   */
  pinned: CategorySummary[];
  /**
   * Whose blog these belong to (invariant I2).
   *
   * `logout()` calls `clearCache()`, which empties Dexie and cannot reach a
   * module variable — so without this, signing out and back in as someone else
   * on a shared machine leaves the previous account's category names in every
   * dropdown. A change of id empties the store instead.
   */
  userId: string;
}

const EMPTY: CategoriesSnapshot = { status: 'idle', categories: [], pinned: [], userId: '' };

let snapshot: CategoriesSnapshot = EMPTY;
let inFlight: Promise<void> | null = null;
/** Which load is the current one, so an overtaken one cannot clear its handle. */
let loadSeq = 0;
const listeners = new Set<() => void>();

/** The current store value. Stable identity between publishes, as the hook needs. */
export function categoriesSnapshot(): CategoriesSnapshot {
  return snapshot;
}

export function subscribeCategories(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(next: CategoriesSnapshot): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

const key = (name: string): string => name.trim().toLocaleLowerCase();

/**
 * Alphabetical by name, through `localeCompare` rather than the default sort.
 *
 * The two derivations this module replaces both used a bare `.sort()`, which
 * orders by UTF-16 code unit — so "Émigré" sorted after "Zoology" and every
 * accented category ended up in a clump at the bottom of the list.
 */
const byName = (a: CategorySummary, b: CategorySummary): number =>
  a.name.localeCompare(b.name);

/**
 * `extra` merged into `base`, one row per name, `base` winning a collision.
 *
 * Case-insensitively, because that is how the managed table's uniqueness is
 * defined — "Fiction" and "fiction" are one category on the server and must not
 * be two rows in a picker. `base` wins because it is the row carrying a real
 * `id` and a real count; the pinned copy has neither.
 */
function unionByName(base: CategorySummary[], extra: CategorySummary[]): CategorySummary[] {
  if (extra.length === 0) return base;
  const seen = new Set(base.map((c) => key(c.name)));
  const merged = [...base];
  for (const c of extra) {
    if (seen.has(key(c.name))) continue;
    seen.add(key(c.name));
    merged.push(c);
  }
  return merged.sort(byName);
}

/**
 * The fallback list, derived from this device's cached rows.
 *
 * TRASHED POSTS ARE EXCLUDED, which is the dashboard's old rule rather than the
 * Details panel's. A category that exists only on a post in the trash is one
 * nobody chose — offering it invites a writer to file new work under a name
 * that vanishes the moment the trash is emptied.
 *
 * `''` is dropped: it is what `posts.category` holds for uncategorised, not a
 * category anyone can pick.
 *
 * Exported because it is the whole of the old behaviour in one function, and
 * the two rules above are the ones that used to disagree between the two
 * screens — a claim worth a test of its own rather than one inferred from what
 * a dropdown rendered.
 */
export function categoriesFromCache(
  rows: { category: string; deletedAt: number | null }[],
): CategorySummary[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.deletedAt != null || !row.category) continue;
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ id: null, name, count, managed: false }))
    .sort(byName);
}

/**
 * Fetch the list, at most once at a time.
 *
 * The dedupe is the `inFlight` promise itself rather than a boolean, so a
 * second caller gets something it can await and lands on the same answer as the
 * first instead of being told "someone else is asking" and having to guess when
 * to look again.
 */
export function loadCategories(
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
      const rows = await categoriesApi.list();
      // A late answer for an account that has since been replaced is not this
      // account's data. Dropping it is the only thing that can be done with it.
      if (snapshot.userId !== userId) return;
      const known = new Set(rows.map((c) => key(c.name)));
      publish({
        status: 'ready',
        categories: [...rows].sort(byName),
        pinned: snapshot.pinned.filter((c) => !known.has(key(c.name))),
        userId,
      });
    } catch {
      if (snapshot.userId !== userId) return;
      /*
       * A REFRESH THAT FAILS MUST NOT EMPTY A PICKER THAT WAS WORKING. The
       * first failure — nothing fetched yet — is the honest `unavailable` that
       * sends every consumer to the Dexie fallback; a failure after a good
       * answer keeps the good answer, because a dropped connection has told us
       * nothing about which categories exist.
       */
      publish({
        ...snapshot,
        status: snapshot.categories.length > 0 ? 'ready' : 'unavailable',
      });
    } finally {
      // Only the NEWEST load clears the handle. A sign-in as a second account
      // starts a second load while this one is still open, and without the
      // sequence check the slower of the two would clear the faster one's
      // handle on its way out — leaving `inFlight` null with a request still
      // running, which is the dedupe silently switched off.
      if (seq === loadSeq) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Promote a typed name to a category, and make sure every picker can see it.
 *
 * A FAILED POST IS NOT A FAILED ACTION HERE, and that is deliberate. What the
 * writer asked for is that this post be filed under this name, and `category`
 * travels to the server as text on the post itself (`posts.category` is still
 * the denormalised column — HANDOFF §2 A3) — so the managed row is the part
 * that can be missing without the writer losing anything they asked for. A 409
 * for a duplicate name is the same story from the other end: the category
 * already exists, which is not a reason to refuse to select it.
 *
 * Returns the row now in the store: `managed: true` when the route accepted it,
 * `managed: false` when the name is only free text so far.
 */
export async function adoptCategory(userId: string, name: string): Promise<CategorySummary> {
  const trimmed = name.trim();
  let created: CategorySummary;
  try {
    created = await categoriesApi.create(trimmed);
  } catch {
    created = { id: null, name: trimmed, count: 0, managed: false };
  }
  if (snapshot.userId === userId) {
    publish({
      ...snapshot,
      pinned: unionByName(
        snapshot.pinned.filter((c) => key(c.name) !== key(created.name)),
        [created],
      ),
    });
  }
  return created;
}

/** Drop everything. Exported for tests, which must not share a module cache. */
export function resetCategories(): void {
  inFlight = null;
  publish(EMPTY);
}

export interface UseCategories {
  /** Every selectable category, from whichever source could answer. */
  categories: CategorySummary[];
  /** The same list as bare names, which is all either picker needs. */
  names: string[];
  /** `cache` means the route did not answer and these came from Dexie. */
  source: CategorySource;
  /** A first fetch is in flight and there is nothing from the server yet. */
  loading: boolean;
  /** Create `name` on the server and pin it into every picker. Never rejects. */
  create: (name: string) => Promise<CategorySummary>;
  reload: () => void;
}

/**
 * The list, for one component.
 *
 * `userId` scopes the fallback read and the store, the way every other cache
 * read in this app is scoped (I2): a row left behind by another account on a
 * shared machine must not put their category names into this writer's pickers.
 */
export function useCategories(userId: string): UseCategories {
  const snap = useSyncExternalStore(
    subscribeCategories,
    categoriesSnapshot,
    categoriesSnapshot,
  );

  useEffect(() => {
    if (!userId) return;
    void loadCategories(userId);
  }, [userId]);

  /*
   * Read unconditionally rather than only while the server list is missing.
   * Skipping it once the route answers would save one indexed read of a table
   * both callers are already subscribed to, at the cost of the fallback being
   * a frame behind on the render where the route fails — which is precisely the
   * render where an empty picker is most alarming.
   */
  const cached = useLiveQuery(() => cachedList(userId), [userId]);

  /** The store is only this component's if it is holding this account's data. */
  const mine = snap.userId === userId;
  const served = mine && snap.status === 'ready';

  const categories = useMemo(
    () =>
      unionByName(
        served ? snap.categories : categoriesFromCache(cached ?? []),
        mine ? snap.pinned : [],
      ),
    [served, mine, snap, cached],
  );

  const names = useMemo(() => categories.map((c) => c.name), [categories]);

  const create = useCallback((name: string) => adoptCategory(userId, name), [userId]);
  const reload = useCallback(() => {
    void loadCategories(userId, { force: true });
  }, [userId]);

  return {
    categories,
    names,
    source: served ? 'server' : 'cache',
    loading: mine && snap.status === 'loading' && !served,
    create,
    reload,
  };
}
