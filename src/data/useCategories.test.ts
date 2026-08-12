import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared category store, without React.
 *
 * The hook is a thin `useSyncExternalStore` wrapper over the four functions
 * below, and everything that can actually go wrong is in them: the dedupe, the
 * cache, the account scoping and — the reason this module exists at all — what
 * happens when `GET /api/categories` does not answer. Rendering a component to
 * ask those questions would put a dropdown between the assertion and the claim;
 * the wiring is asserted where it lives, in `Dashboard.test.tsx` and
 * `MetaPanel.test.tsx`.
 *
 * `./api-categories` is mocked because it is the only thing between this module
 * and a network. Nothing else is.
 */

vi.mock('./api-categories', () => ({
  categoriesApi: {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}));

import { categoriesApi, type CategorySummary } from './api-categories';
import {
  adoptCategory,
  categoriesFromCache,
  categoriesSnapshot,
  loadCategories,
  resetCategories,
  subscribeCategories,
} from './useCategories';

const USER = 'u_writer';

const row = (name: string, over: Partial<CategorySummary> = {}): CategorySummary => ({
  id: `c_${name}`,
  name,
  count: 1,
  managed: true,
  ...over,
});

/** A promise plus the handles to settle it, for holding a request open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The store is a module variable, so it outlives a test the way it outlives
  // a component. Every case starts from empty or they leak into each other.
  resetCategories();
});

// ------------------------------------------------------------------ the fetch

describe('one request, however many callers', () => {
  it('folds concurrent loads into a single GET', async () => {
    const gate = deferred<CategorySummary[]>();
    vi.mocked(categoriesApi.list).mockReturnValue(gate.promise);

    // The dashboard filter, the Details panel and the Settings section can all
    // mount inside the same second. Three components, one request.
    const a = loadCategories(USER);
    const b = loadCategories(USER);
    const c = loadCategories(USER);
    gate.resolve([row('Fiction')]);
    await Promise.all([a, b, c]);

    expect(categoriesApi.list).toHaveBeenCalledTimes(1);
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Fiction']);
  });

  it('does not re-ask once it has an answer, and does when forced', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([row('Fiction')]);

    await loadCategories(USER);
    // Every remount of the dashboard calls this. Re-fetching on each one would
    // put a request behind every trip out of the editor.
    await loadCategories(USER);
    expect(categoriesApi.list).toHaveBeenCalledTimes(1);

    vi.mocked(categoriesApi.list).mockResolvedValue([row('Fiction'), row('Essays')]);
    await loadCategories(USER, { force: true });
    expect(categoriesApi.list).toHaveBeenCalledTimes(2);
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Essays', 'Fiction']);
  });

  it('sorts by name the way a person reads a list', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([
      row('Zoology'),
      row('Émigré'),
      row('Art'),
    ]);

    await loadCategories(USER);

    // A bare `.sort()` orders by UTF-16 code unit, which is what both of the
    // derivations this module replaces did — and it put every accented category
    // in a clump underneath Z.
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual([
      'Art',
      'Émigré',
      'Zoology',
    ]);
  });

  it('tells subscribers, so a mounted picker does not need to poll', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([row('Fiction')]);
    const seen: number[] = [];
    const off = subscribeCategories(() => seen.push(categoriesSnapshot().categories.length));

    await loadCategories(USER);
    off();

    // At least the `loading` publish and the `ready` one; the last is what the
    // picker renders.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toBe(1);
  });
});

// ------------------------------------------------------- degrading honestly

describe('when the route does not answer', () => {
  it('reports `unavailable` rather than an empty list', async () => {
    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('404 gone'));

    await loadCategories(USER);

    /*
     * The distinction the fallback hangs on. `ready` with zero rows is "this
     * blog has no categories"; `unavailable` is "we could not ask" — and the
     * hook sends the second one to the Dexie-derived list rather than showing
     * a picker that claims the first.
     */
    expect(categoriesSnapshot().status).toBe('unavailable');
    expect(categoriesSnapshot().categories).toEqual([]);
  });

  it('keeps a list it already had when a later refresh fails', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([row('Fiction')]);
    await loadCategories(USER);

    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('offline'));
    await loadCategories(USER, { force: true });

    // A dropped connection has told us nothing about which categories exist,
    // so emptying a working picture of them would be inventing an answer.
    expect(categoriesSnapshot().status).toBe('ready');
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Fiction']);
  });
});

// ------------------------------------------------------------ account scoping

describe('the store belongs to one account', () => {
  it('empties and re-asks when a different user signs in', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([row('Fiction')]);
    await loadCategories(USER);

    vi.mocked(categoriesApi.list).mockResolvedValue([row('Recipes')]);
    await loadCategories('u_someone_else');

    // `logout()` calls `clearCache()`, which empties Dexie and cannot reach a
    // module variable — so on a shared machine this is the only thing standing
    // between two accounts' category names.
    expect(categoriesApi.list).toHaveBeenCalledTimes(2);
    expect(categoriesSnapshot().userId).toBe('u_someone_else');
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Recipes']);
  });

  it('drops an answer that arrives after the account changed', async () => {
    const slow = deferred<CategorySummary[]>();
    vi.mocked(categoriesApi.list).mockReturnValueOnce(slow.promise);
    const first = loadCategories(USER);

    vi.mocked(categoriesApi.list).mockResolvedValue([row('Recipes')]);
    await loadCategories('u_someone_else');

    slow.resolve([row('Fiction')]);
    await first;

    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Recipes']);
  });
});

// -------------------------------------------------------------- the new name

describe('adopting a name', () => {
  it('pins it so every picker can see it immediately', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([]);
    await loadCategories(USER);
    vi.mocked(categoriesApi.create).mockResolvedValue(row('Essays'));

    const created = await adoptCategory(USER, '  Essays  ');

    expect(categoriesApi.create).toHaveBeenCalledWith('Essays');
    expect(created.managed).toBe(true);
    // The dashboard filter has to be able to offer it without a second GET —
    // the writer just used it, and it is not on any cached post yet.
    expect(categoriesSnapshot().pinned.map((x) => x.name)).toEqual(['Essays']);
  });

  it('still selects the name when the route refuses it', async () => {
    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('404 gone'));
    await loadCategories(USER);
    vi.mocked(categoriesApi.create).mockRejectedValue(new Error('404 gone'));

    const created = await adoptCategory(USER, 'Essays');

    /*
     * What the writer asked for is that this post be filed under this name, and
     * `posts.category` is still the denormalised text column that carries it.
     * The managed row is the part that can be missing without them losing
     * anything they asked for — so this resolves rather than rejecting, and
     * says plainly that the name is not managed yet.
     */
    expect(created).toEqual({ id: null, name: 'Essays', count: 0, managed: false });
    expect(categoriesSnapshot().pinned.map((x) => x.name)).toEqual(['Essays']);
  });

  it('lets the server row replace the pinned one once the list knows it', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([]);
    await loadCategories(USER);
    vi.mocked(categoriesApi.create).mockResolvedValue(row('Essays'));
    await adoptCategory(USER, 'Essays');

    vi.mocked(categoriesApi.list).mockResolvedValue([row('Essays')]);
    await loadCategories(USER, { force: true });

    // Otherwise the name is in the store twice, and a picker built from both
    // lists shows it twice.
    expect(categoriesSnapshot().pinned).toEqual([]);
    expect(categoriesSnapshot().categories.map((x) => x.name)).toEqual(['Essays']);
  });
});

// ------------------------------------------------------------- the fallback

describe('the list derived from the cache', () => {
  const post = (category: string, deletedAt: number | null = null) => ({ category, deletedAt });

  it('leaves out categories that survive only in the trash', () => {
    const derived = categoriesFromCache([
      post('Fiction'),
      post('Fiction'),
      post('Abandoned', 1234),
    ]);

    /*
     * THE DISAGREEMENT THIS MODULE EXISTS TO SETTLE. The dashboard filter
     * excluded trashed rows and the editor's Details panel did not, so a
     * category carried only by a binned post was offered in one place and
     * absent from the other. Excluded is the answer: filing new work under a
     * name that disappears when the trash is emptied is a trap.
     */
    expect(derived.map((c) => c.name)).toEqual(['Fiction']);
    expect(derived[0].count).toBe(2);
    expect(derived[0].managed).toBe(false);
    expect(derived[0].id).toBeNull();
  });

  it('drops the empty string, which is uncategorised rather than a category', () => {
    expect(categoriesFromCache([post(''), post('Fiction')]).map((c) => c.name)).toEqual([
      'Fiction',
    ]);
  });
});
