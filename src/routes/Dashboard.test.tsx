import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

/**
 * The dashboard after the cutover (plan §4, §5).
 *
 * Five of the things asserted below were, before this slice, wrong in a way a
 * screenshot would not have shown:
 *
 *  - the grid read `db.posts`, which now holds only the posts whose BODIES have
 *    been fetched — so a library of two hundred rendered as the three the
 *    writer had opened;
 *  - `db.postList` answers `[]` in a millisecond, so the "A blank page, on
 *    purpose" empty state painted over a library that was still arriving;
 *  - search filtered a cache with `String.includes` while the blog matched a
 *    `tsvector`, so the same query gave different answers on the two surfaces;
 *  - "Empty trash" and "Delete forever" were rendered to writers, for whom both
 *    routes are `requireOwner()` — a confirmation dialog in front of a 403;
 *  - the mount-time blank-draft sweep ran unconditionally, and the server's
 *    sweep hard-deletes a post that is blank ON THE SERVER while every word of
 *    it sits in an unsent `pending` patch.
 *
 * `../data/api` is mocked whole — it is the only thing between this screen and
 * a network — while Dexie, `cache.ts`, `pending.ts`, `sync.ts` and `posts.ts`
 * are real. Several of these tests are about which rows reach the grid and
 * which requests are made at all, and stubbing the layers in between would have
 * asserted the stubs.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: { id: 'u_writer', email: 'w@test.local', displayName: 'A Writer', role: 'writer' },
  } as {
    status: string;
    user: { id: string; email: string; displayName: string; role: 'owner' | 'writer' } | null;
  },
  replayed: Promise.resolve(),
}));

vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: {
    listPosts: vi.fn(),
    getPost: vi.fn(),
    createPost: vi.fn(),
    sweepBlankDrafts: vi.fn(async () => 0),
    emptyTrash: vi.fn(async () => 0),
    destroyPost: vi.fn(),
    duplicatePost: vi.fn(),
    publishPost: vi.fn(),
    unpublishPost: vi.fn(),
    archivePost: vi.fn(),
    unarchivePost: vi.fn(),
    trashPost: vi.fn(),
    restorePost: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    exportAll: vi.fn(),
    importBundle: vi.fn(),
    savePost: vi.fn(),
  },
}));

/**
 * Mocked separately from `../data/api` even though it is the same request
 * function underneath: `api-categories.ts` is a module of its own precisely so
 * four concurrent writers cannot lose each other's blocks in `api.ts`, and a
 * mock that reached through it would have to be kept in step with both.
 */
vi.mock('../data/api-categories', () => ({
  categoriesApi: {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => undefined,
  whenReplayed: () => fixture.replayed,
  initSession: vi.fn(),
  logout: vi.fn(async () => ({ status: 'done' })),
}));

vi.mock('../data/migrate', () => ({
  surveyLocalPosts: vi.fn(async () => ({
    pending: [],
    migrated: [],
    excluded: [],
    imageCount: 0,
    revisionCount: 0,
  })),
  // `backup.ts` imports these two; nothing in this file exercises them.
  imageIdsOf: vi.fn(() => []),
  importForeignBundle: vi.fn(),
}));

import { api } from '../data/api';
import { categoriesApi } from '../data/api-categories';
import { db, type CachedListPost, type LocalPost, type PendingWrite } from '../data/db';
import { surveyLocalPosts } from '../data/migrate';
import { setActiveUser } from '../data/posts';
import { resetCategories } from '../data/useCategories';
import { TooltipProvider } from '../components/ui/Switch';
import { brand } from '../brand';
import Dashboard from './Dashboard';
import { Sidebar, SidebarCounts } from '../components/Sidebar';
import type { ListPost, Post } from '../data/types';

const USER = 'u_writer';

/**
 * jsdom has none of these. `ThemeToggle` reads `matchMedia` on mount and Radix
 * needs the other three the moment a menu opens, so without them this file
 * fails on the render rather than on anything it is about.
 */
function stubBrowserGaps(): void {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

let seq = 0;

function listRow(over: Partial<ListPost> = {}): CachedListPost {
  seq += 1;
  return {
    id: `p_${seq}`,
    title: `Post ${seq}`,
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: seq,
    updatedAt: seq,
    publishedAt: null,
    deletedAt: null,
    wordCount: 10,
    readingTime: 1,
    authorId: USER,
    authorName: 'A Writer',
    revision: 1,
    ownerUserId: USER,
    ...over,
  };
}

/** An empty page for both status views, which is what most tests want. */
function emptyList(): void {
  vi.mocked(api.listPosts).mockResolvedValue({ items: [], nextCursor: null });
}

/** `main.tsx` mounts both of these above every route; Radix throws without. */
function draw() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Dashboard />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/**
 * The URL, and the browser's own Back button, on every route.
 *
 * `draw()` renders the dashboard alone, which is enough for everything above
 * but cannot express a round trip: the filters live in the search params now,
 * so the assertions that matter are about where the address bar ends up after
 * a navigation and about which navigations are on the history stack at all.
 */
function Chrome() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="here">{pathname + search}</div>
      <button data-testid="go-back" onClick={() => navigate(-1)}>
        Browser back
      </button>
    </div>
  );
}

/**
 * STANDING IN FOR THE EDITOR, and only for its exit.
 *
 * `Editor.tsx` mounts TipTap, the autosave loop and the drag handle; rendering
 * all of that to assert one navigation would be a test of ProseMirror. What
 * this copies is the line the editor's "Posts" button runs when there IS an
 * in-app entry behind it — `navigate(-1)` — which is the half of the round trip
 * this file can prove. The `location.key === 'default'` fallback for a pasted
 * `/#/edit/:id` lives in `Editor.tsx` and is not exercised here.
 */
function StubEditor() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>Back to posts</button>;
}

/**
 * THE RAIL IS PART OF THIS HARNESS NOW, and it has to be.
 *
 * The five status filters used to be a tab strip inside `Dashboard`; they are
 * the Posts pages of the sidebar since the navigation was unified. The URL
 * behaviour they drive — push on a status change, replace on a search,
 * defaults deleted rather than written — is unchanged and still worth
 * pinning, but the links that exercise it are no longer rendered by the
 * component under test.
 *
 * `SidebarCounts` wraps both, exactly as `AppShell` does: the dashboard
 * publishes the counts and the rail reads them, so a provider around only one
 * of them would put the two on opposite sides of the boundary.
 */
function drawRouted(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries}>
      <TooltipProvider>
        <SidebarCounts>
          <Chrome />
          <Sidebar user={null} signOut={null} />
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/edit/:id" element={<StubEditor />} />
            <Route path="/elsewhere" element={<p>Somewhere else entirely</p>} />
          </Routes>
        </SidebarCounts>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** A few macrotask turns, for asserting that something did NOT happen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  stubBrowserGaps();
  vi.clearAllMocks();
  emptyList();
  // The category list is a module-scoped store — it outlives an unmount on
  // purpose, so it outlives a test too unless it is emptied between them.
  resetCategories();
  vi.mocked(categoriesApi.list).mockResolvedValue([]);
  vi.mocked(surveyLocalPosts).mockResolvedValue({
    pending: [],
    migrated: [],
    excluded: [],
    imageCount: 0,
    revisionCount: 0,
  });
  fixture.session = {
    status: 'authed',
    user: { id: USER, email: 'w@test.local', displayName: 'A Writer', role: 'writer' },
  };
  setActiveUser(USER);
  await db.open();
  await Promise.all([
    db.posts.clear(),
    db.postList.clear(),
    db.revisions.clear(),
    db.pending.clear(),
    db.localPosts.clear(),
  ]);
});

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------------- the grid

describe('the grid reads the list store', () => {
  it('renders every cached list row, not only the posts whose bodies were fetched', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_a', title: 'Alpha' }),
      listRow({ id: 'p_b', title: 'Beta' }),
      listRow({ id: 'p_c', title: 'Gamma' }),
    ]);
    // One of the three has a body cached — the shape `db.posts` has after the
    // cutover, and the reason reading it here rendered a near-empty grid.
    await db.posts.put({
      ...(listRow({ id: 'p_a', title: 'Alpha' }) as unknown as Post),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      ownerUserId: USER,
    });

    draw();

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('hides another account’s cached rows', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_mine', title: 'Mine' }),
      { ...listRow({ id: 'p_theirs', title: 'Theirs' }), ownerUserId: 'u_someone_else' },
    ]);

    draw();

    await waitFor(() => expect(screen.getByText('Mine')).toBeTruthy());
    expect(screen.queryByText('Theirs')).toBeNull();
  });
});

// ------------------------------------------------------------------ listSynced

describe('the empty state waits for the first list walk', () => {
  it('does not claim a blank library while the walk is still in flight', async () => {
    // One gate for every call, because `syncList` walks BOTH status views —
    // holding only the first request open would let the second sail through.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(api.listPosts).mockImplementation(async () => {
      await gate;
      return { items: [], nextCursor: null };
    });

    draw();
    await settle();

    // `db.postList` answered `[]` several turns ago. Without the flag this is
    // where "A blank page, on purpose" paints over an arriving library.
    expect(screen.queryByText('A blank page, on purpose')).toBeNull();

    release();
    await waitFor(() => expect(screen.getByText('A blank page, on purpose')).toBeTruthy());
  });

  it('skips the walk entirely when the cache can already answer', async () => {
    await db.postList.put(listRow({ title: 'Already here' }));

    draw();

    await waitFor(() => expect(screen.getByText('Already here')).toBeTruthy());
    // `AppShell` revalidates `/` on every navigation. Repeating it here on
    // every visit would double the page walk for a question the cache has
    // already answered.
    expect(api.listPosts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------- search

describe('search is answered by the blog', () => {
  it('shows exactly the ids the server returned, not a substring match over the cache', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_alpha', title: 'Alpha' }),
      listRow({ id: 'p_beta', title: 'Beta' }),
      listRow({ id: 'p_gamma', title: 'Gamma' }),
    ]);
    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    /*
     * The query is "alpha" and the server answers with GAMMA. That is not a
     * contrived answer — it is what a `tsvector` match does that
     * `String.includes` cannot: stemming, and the whole reason the two surfaces
     * had to stop disagreeing. It also makes this test unfoolable by a
     * client-side substring filter, which would have returned Alpha.
     */
    vi.mocked(api.listPosts).mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [] : [listRow({ id: 'p_gamma', title: 'Gamma' })],
      nextCursor: null,
    }));

    await userEvent.type(screen.getByLabelText('Search posts'), 'alpha');

    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());
    expect(screen.getByText('Gamma')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    // Sent to the server, with the search on the query rather than applied here.
    expect(vi.mocked(api.listPosts).mock.calls[0][0]?.search).toBe('alpha');
  });

  it('drops every row when the server matched nothing', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_a', title: 'Alpha' }),
      listRow({ id: 'p_b', title: 'Beta' }),
    ]);
    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    vi.mocked(api.listPosts).mockResolvedValue({ items: [], nextCursor: null });
    await userEvent.type(screen.getByLabelText('Search posts'), 'the');

    await waitFor(() => expect(screen.getByText('Nothing matches')).toBeTruthy());
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
    // The two regressions `server/repo/query.ts` documents, said where a writer
    // meets them: whole-word matching, and a stopword-only query matching zero
    // rows however many posts contain those letters.
    const body = screen.getByText(/whole words/i).textContent ?? '';
    expect(body).toContain('ost');
    expect(body).toContain('the');
  });

  it('says it could not ask rather than that nothing matched', async () => {
    await db.postList.put(listRow({ title: 'Alpha' }));
    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    vi.mocked(api.listPosts).mockRejectedValue(new Error('offline'));
    await userEvent.type(screen.getByLabelText('Search posts'), 'alpha');

    await waitFor(() => expect(screen.getByText('Couldn’t search the blog')).toBeTruthy());
    // "Nothing matches" would be a claim about the library made on the strength
    // of a request that never arrived.
    expect(screen.queryByText('Nothing matches')).toBeNull();
  });

  it('restores the whole library when the search is cleared', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_a', title: 'Alpha' }),
      listRow({ id: 'p_b', title: 'Beta' }),
    ]);
    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    vi.mocked(api.listPosts).mockResolvedValue({ items: [], nextCursor: null });
    const box = screen.getByLabelText('Search posts');
    await userEvent.type(box, 'zzz');
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());

    await userEvent.clear(box);

    // `null` and the empty set are different states: collapsing them would
    // leave the grid empty with no search active.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
  });
});

// ----------------------------------------------------------------- the sweep

describe('the blank-draft sweep', () => {
  it('is skipped while anything is still unsent, and runs once the queue is clear', async () => {
    const unsent: PendingWrite = {
      postId: 'p_offline',
      ownerUserId: USER,
      patch: { content: { type: 'doc', content: [{ type: 'paragraph' }] } },
      baseRevision: 1,
      seq: 1,
      state: 'queued',
      updatedAt: Date.now(),
    };
    await db.pending.put(unsent);
    await db.postList.put(listRow({ title: 'Something' }));

    draw();
    await waitFor(() => expect(screen.getByText('Something')).toBeTruthy());
    await settle();

    /*
     * `POST /api/posts/sweep-blank` hard-deletes every draft that is blank ON
     * THE SERVER and past the 60 s grace. A post created online and then
     * written into entirely offline is exactly that, and every word of it is in
     * the row above. Ordering the sweep after replay is not enough — a replay
     * that FAILED is also "after replay".
     */
    expect(api.sweepBlankDrafts).not.toHaveBeenCalled();

    /*
     * The same fixture with the queue drained. This half is what proves the
     * assertion above is about the guard rather than about the sweep being
     * unreachable in this harness at all.
     */
    cleanup();
    await db.pending.clear();
    draw();
    await waitFor(() => expect(api.sweepBlankDrafts).toHaveBeenCalled());
  });

  it('waits for replay before deciding, rather than racing it', async () => {
    let replayDone: (() => void) | null = null;
    fixture.replayed = new Promise<void>((resolve) => {
      replayDone = resolve;
    });
    await db.postList.put(listRow({ title: 'Something' }));

    draw();
    await waitFor(() => expect(screen.getByText('Something')).toBeTruthy());
    await settle();

    // Replay is what turns a failed write into a `pending` row worth checking,
    // so reading the queue before it settles reads a queue that is still empty.
    expect(api.sweepBlankDrafts).not.toHaveBeenCalled();

    replayDone!();
    await waitFor(() => expect(api.sweepBlankDrafts).toHaveBeenCalled());
    fixture.replayed = Promise.resolve();
  });
});

// ------------------------------------------------------------- owner-only bits

describe('controls that would 403', () => {
  const trashed = () =>
    listRow({ id: 'p_binned', title: 'Binned', deletedAt: Date.now(), status: 'draft' });

  /**
   * `link`, not `button`: the status tabs became `<Link>`s when the filters
   * moved into the URL, so that middle-click and ⌘-click open a tab in a new
   * browser tab the way a row of tabs implies. The role is the only thing about
   * them these tests care about.
   */
  async function openTrashTab(): Promise<void> {
    // BY URL, because the status filters moved into the sidebar and `draw()`
    // renders the dashboard alone. `?status=trash` is the same interface the
    // rail link uses — these tests are about who may empty the bin, not about
    // how the bin is reached.
    drawRouted(['/?status=trash']);
  }

  it('are hidden from a writer, and their absence is explained', async () => {
    await db.postList.put(trashed());
    await openTrashTab();

    await waitFor(() => expect(screen.getByText('Binned')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete forever' })).toBeNull();
    // A missing button with no explanation reads as a broken screen.
    expect(screen.getByText(/Only the blog owner can empty it/)).toBeTruthy();
  });

  it('are offered to an owner', async () => {
    fixture.session = {
      status: 'authed',
      user: { id: USER, email: 'o@test.local', displayName: 'The Owner', role: 'owner' },
    };
    await db.postList.put(trashed());
    await openTrashTab();

    await waitFor(() => expect(screen.getByText('Binned')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Empty trash' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete forever' })).toBeTruthy();
  });
});

// --------------------------------------------------------- the local corpus

describe('the pre-backend library', () => {
  it('is announced, because nothing else on this screen can show it', async () => {
    const local = { ...(listRow({ title: 'Written offline' }) as unknown as LocalPost) };
    vi.mocked(surveyLocalPosts).mockResolvedValue({
      pending: [local],
      migrated: [],
      excluded: [],
      imageCount: 0,
      revisionCount: 0,
    });

    draw();

    await waitFor(() =>
      expect(screen.getByText(/still only on this device/)).toBeTruthy(),
    );
    // The way out is the migration screen, and it has to be one click away —
    // those posts moved into `localPosts` at the v1→v2 upgrade and are in no
    // grid, on no server, and in no backup.
    const link = screen.getByRole('link', { name: 'Move to the blog' });
    expect(link.getAttribute('href')).toContain('/migrate');
  });

  it('says nothing when there is nothing left on this device', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('A blank page, on purpose')).toBeTruthy());
    expect(screen.queryByText(/still only on this device/)).toBeNull();
  });
});

// ------------------------------------------------------------------ sign out

describe('sign out', () => {
  it('has left this menu for the sidebar footer, and left nothing else behind', async () => {
    draw();
    await waitFor(() => expect(screen.getByLabelText('Library actions')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Library actions'));
    await waitFor(() => expect(screen.getByText('Keyboard shortcuts')).toBeTruthy());

    /*
     * It lived here while this menu was the only chrome the app had. The shell
     * has a sidebar now and sign-out belongs next to the identity it signs out,
     * where it is reachable from the editor and from Settings too — see
     * `Sidebar.test.tsx`. Two copies would be strictly worse than either: the
     * unsent-work confirmation lives in `SignOutButton`, and two buttons asking
     * that question are two chances to answer it wrongly.
     */
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();

    // Everything else in the menu stayed exactly where it was. Removing a
    // separator's worth of markup is the kind of edit that takes a neighbour
    // with it and is never noticed.
    expect(screen.getByText('Import a backup')).toBeTruthy();
    expect(screen.getByText('Export everything')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------- copy

describe('copy that stopped being true at the cutover', () => {
  it('no longer says the library is stored on this device', async () => {
    await db.postList.put(listRow({ title: 'Alpha' }));
    draw();

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText(/stored on this device/)).toBeNull();
    expect(screen.getByText(/saved to the blog/)).toBeTruthy();
  });

  it('no longer claims there is no account and no server', async () => {
    draw();

    await waitFor(() => expect(screen.getByText('A blank page, on purpose')).toBeTruthy());
    expect(screen.queryByText(/no account, no server/)).toBeNull();
    expect(screen.getByText(/goes to the blog as you type/)).toBeTruthy();
  });
});

// -------------------------------------------------------- the category filter

/**
 * The options came from `db.postList` until now (HANDOFF §4 C3), which made the
 * control describe THIS BROWSER'S CACHE rather than the blog: a machine that
 * had synced a different slice of the library offered a different set of
 * categories, and a fresh one offered none at all. `GET /api/categories`
 * answers with the managed list unioned with everything in use, drafts
 * included — the same list the editor's Details panel now picks from.
 */
describe('the category filter comes from the blog', () => {
  const trigger = () => screen.getByLabelText('Filter by category');

  it('offers a category that no cached post carries', async () => {
    await db.postList.put(listRow({ title: 'Alpha', category: '' }));
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: 'c_fiction', name: 'Fiction', count: 3, managed: true },
    ]);

    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    // Under the old derivation this fixture produced no control at all: a blog
    // with three posts under Fiction, and a browser that had cached none of
    // them, showed a writer a library with no categories in it.
    await waitFor(() => expect(trigger()).toBeTruthy());
    await userEvent.click(trigger());

    // `(0)` rather than the server's `3`: the number answers "how many would
    // this grid show", which the tag, status and search filters also decide.
    await waitFor(() => expect(screen.getByText('Fiction (0)')).toBeTruthy());
  });

  it('falls back to this device’s posts when the route does not answer', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_essay', title: 'Alpha', category: 'Essays' }),
      listRow({ id: 'p_plain', title: 'Beta', category: '' }),
    ]);
    /*
     * `GET /api/categories` is landing in a parallel workstream and 404s until
     * it does — and any device can be offline at any time. An empty picker here
     * would be the app claiming this blog has no categories on the strength of
     * a request that never got an answer, which is the same class of lie as the
     * search empty state's "nothing matches".
     */
    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('gone'));

    draw();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    await waitFor(() => expect(trigger()).toBeTruthy());
    await userEvent.click(trigger());
    await waitFor(() => expect(screen.getByText('Essays (1)')).toBeTruthy());
  });
});

// -------------------------------------------------------- the filters in the URL

/**
 * All five filters became search params (HANDOFF §4 C1). Before this they were
 * five `useState`s and opening a post unmounts this screen, so the trip into
 * the editor and back reset the tab, the query, the sort, the category and the
 * tag every single time — silently, and with no way for a writer to get any of
 * them back except by redoing all five.
 */
describe('the filters live in the URL', () => {
  const url = () => screen.getByTestId('here').textContent;
  const box = () => screen.getByLabelText('Search posts') as HTMLInputElement;

  it('comes back from the editor on the tab and in the search the writer left', async () => {
    const live = () => listRow({ id: 'p_live', title: 'Live one', status: 'published' });
    await db.postList.put(live());
    // The query in the box is re-run against the blog on the way back in, so
    // the server has to keep answering "foo" with the same row.
    vi.mocked(api.listPosts).mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [] : [live()],
      nextCursor: null,
    }));

    drawRouted(['/?status=published&q=foo']);

    await waitFor(() => expect(screen.getByText('Live one')).toBeTruthy());
    expect(box().value).toBe('foo');

    await userEvent.click(screen.getByRole('button', { name: 'Edit Live one' }));
    await waitFor(() => expect(screen.getByText('Back to posts')).toBeTruthy());
    await userEvent.click(screen.getByText('Back to posts'));

    /*
     * THE ACCEPTANCE TEST, and the whole reason for the change. What used to
     * happen here is that the dashboard remounted with five fresh `useState`s
     * and the writer landed on All with an empty box — having lost the tab and
     * the query by clicking one of their own results.
     */
    await waitFor(() => expect(box()).toBeTruthy());
    expect(box().value).toBe('foo');
    expect(screen.getByRole('link', { name: /^Published/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(url()).toBe('/?status=published&q=foo');
  });

  it('keeps `/` clean, writing only the filters that are not at their default', async () => {
    await db.postList.put(listRow({ title: 'Alpha' }));
    drawRouted(['/']);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(url()).toBe('/');

    await userEvent.click(screen.getByRole('link', { name: /^Drafts/ }));
    await waitFor(() => expect(url()).toBe('/?status=draft'));

    // And back off again: a default is DELETED rather than written, or one
    // click on a tab would leave `?status=all&sort=updated` in the address bar
    // and in every link the writer copied out of it thereafter.
    await userEvent.click(screen.getByRole('link', { name: /^All/ }));
    await waitFor(() => expect(url()).toBe('/'));
  });

  it('pushes a tab change and replaces a search', async () => {
    await db.postList.put(listRow({ title: 'Alpha' }));
    drawRouted(['/elsewhere', '/']);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    await userEvent.click(screen.getByRole('link', { name: /^Drafts/ }));
    await waitFor(() => expect(url()).toBe('/?status=draft'));

    // Pushed: Back walks the tab history, which is what a tab strip implies.
    await userEvent.click(screen.getByTestId('go-back'));
    await waitFor(() => expect(url()).toBe('/'));

    await userEvent.type(box(), 'alpha');
    await waitFor(() => expect(url()).toBe('/?q=alpha'));

    /*
     * Replaced: Back leaves the dashboard entirely rather than unwinding the
     * word one pause at a time. Five history entries for "alpha" would make the
     * browser's Back button useless on the one screen a writer lives on.
     */
    await userEvent.click(screen.getByTestId('go-back'));
    await waitFor(() => expect(url()).toBe('/elsewhere'));
  });

  it('falls back silently when the URL was typed by hand', async () => {
    await db.postList.put(listRow({ title: 'Alpha', status: 'draft' }));
    drawRouted(['/?status=publised&sort=chronological']);

    // Neither an error screen nor an empty grid: two typos in somebody's
    // address bar are not something the app should make a fuss about.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    /*
     * NOTHING in the rail is lit, and that is correct rather than a gap: the
     * five items match on the `status` param, `publised` is none of them, and
     * `All` is specifically the EMPTY status. The dashboard falls back to
     * showing everything — which is what the assertion above already proves —
     * without the rail claiming the URL says something it does not.
     */
    expect(screen.getByRole('link', { name: /^All/ }).getAttribute('aria-current')).toBeNull();
    // Left as typed rather than rewritten underneath them — a URL that edits
    // itself the instant it loads is its own small horror.
    expect(url()).toBe('/?status=publised&sort=chronological');
  });

  it('reads the tag chip out of the URL, and clearing it drops the param', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_tagged', title: 'Alpha', tags: ['ideas'] }),
      listRow({ id: 'p_plain', title: 'Beta', tags: [] }),
    ]);
    drawRouted(['/?tag=ideas']);

    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Beta')).toBeNull();

    await userEvent.click(screen.getByLabelText('Clear tag filter'));

    await waitFor(() => expect(url()).toBe('/'));
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('puts the tab in the window title and hands it back on the way out', async () => {
    const before = document.title;
    await db.postList.put(listRow({ title: 'Alpha', status: 'draft' }));
    drawRouted(['/?status=draft']);

    // Two dashboards open in two browser tabs are two different URLs now, so
    // they can stop being two identical entries in the window switcher.
    await waitFor(() => expect(document.title).toBe(`Drafts · ${brand.name}`));

    // `brand.ts` owns the title everywhere else, so this hands it back rather
    // than reconstructing that string and drifting from it.
    cleanup();
    expect(document.title).toBe(before);
  });
});
