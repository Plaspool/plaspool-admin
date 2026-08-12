import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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
import { db, type CachedListPost, type LocalPost, type PendingWrite } from '../data/db';
import { surveyLocalPosts } from '../data/migrate';
import { setActiveUser } from '../data/posts';
import { TooltipProvider } from '../components/ui/Switch';
import Dashboard from './Dashboard';
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

/** A few macrotask turns, for asserting that something did NOT happen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  stubBrowserGaps();
  vi.clearAllMocks();
  emptyList();
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

  async function openTrashTab(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: /^Trash/ }));
  }

  it('are hidden from a writer, and their absence is explained', async () => {
    await db.postList.put(trashed());
    draw();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Trash/ })).toBeTruthy());
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
    draw();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Trash/ })).toBeTruthy());
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
  it('is reachable from the masthead menu', async () => {
    draw();
    await waitFor(() => expect(screen.getByLabelText('Library actions')).toBeTruthy());

    await userEvent.click(screen.getByLabelText('Library actions'));

    // Before this it existed only inside the re-auth prompt, which a signed-in
    // writer never sees — so the app had no way to sign out at all, which on a
    // shared machine is the whole of its access control.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy());
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
