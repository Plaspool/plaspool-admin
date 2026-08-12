import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * `PostGate`, and mostly about the ORDER its questions are asked in.
 *
 * The arms run against the real Dexie stores and the real `sync.ts`; only the
 * wire and the session are mocked. That matters: three of the cases below are
 * about what happens when a fetch is or is not made at all, and a test that
 * stubbed `syncPost` would have asserted its own stub.
 *
 * The child is a stand-in for `Editor.tsx`, which is frozen and renders "This
 * post no longer exists. It may have been permanently deleted from this
 * browser." whenever its live query finds no row. Several cases here are
 * entirely about that sentence never reaching a writer who has not lost
 * anything, so the stub says it too.
 */
const fixture = vi.hoisted(() => ({
  session: { status: 'authed', user: { id: '', email: '', displayName: '', role: 'writer' } } as {
    status: string;
    user: { id: string; email: string; displayName: string; role: 'owner' | 'writer' } | null;
  },
  replay: Promise.resolve(),
}));

vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: {
    getPost: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    listPosts: vi.fn(),
    savePost: vi.fn(),
  },
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => undefined,
  whenReplayed: () => fixture.replay,
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { api } from '../data/api';
import { cachePost, writeOverlay } from '../data/cache';
import { db } from '../data/db';
import { NotFoundError, OfflineError } from '../data/errors';
import { listPending, markPending, queuePending } from '../data/pending';
import { PostGate } from './PostGate';
import type { AuthUser, DocNode, Post } from '../data/types';

const WRITER: AuthUser = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer',
};
const COLLEAGUE: AuthUser = {
  id: 'u_colleague',
  email: 'colleague@test.local',
  displayName: 'Someone Else',
  role: 'writer',
};

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let n = 0;
function makePost(over: Partial<Post> = {}): Post {
  n += 1;
  return {
    id: `p_${n}`,
    title: `Post ${n}`,
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    content: para('the server version'),
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 2,
    publishedAt: null,
    deletedAt: null,
    wordCount: 3,
    readingTime: 1,
    authorId: WRITER.id,
    authorName: WRITER.displayName,
    revision: 4,
    ...over,
  };
}

/** Stands in for the frozen editor, deletion sentence and all. */
function FrozenEditorStub() {
  return (
    <div>
      <p>THE EDITOR</p>
      <p>This post no longer exists</p>
    </div>
  );
}

function open(id: string, mode: 'edit' | 'read' = 'edit') {
  return render(
    <MemoryRouter initialEntries={[`/${mode}/${id}`]}>
      <Routes>
        <Route
          path={`/${mode}/:id`}
          element={
            <PostGate mode={mode}>
              <FrozenEditorStub />
            </PostGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  /*
   * Explicit, because this project has no `globals: true` — so
   * @testing-library/react never registers its automatic `afterEach`, and
   * without this every case queries a DOM still holding the previous case's
   * render. That reads as "found multiple elements", but it can just as easily
   * read as a pass.
   */
  cleanup();
  vi.resetAllMocks();
  fixture.session = { status: 'authed', user: WRITER };
  fixture.replay = Promise.resolve();
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.pending.clear();
  await db.localPosts.clear();
  vi.mocked(api.listRevisions).mockResolvedValue({ items: [], nextCursor: null });
});

describe('store membership is decided before any network verdict', () => {
  it('an un-migrated local post shows "on this device only" and asks the server nothing', async () => {
    const local = makePost();
    await db.localPosts.put({ ...local, migratedAt: null });
    /*
     * The server has never been given this id, so it 404s — which `syncPost`
     * turns into `gone`. If that arm ran first, the frozen editor would render
     * the deletion tombstone over the writer's ENTIRE pre-backend library. A
     * 404 for an id the server was never given is not evidence anything was
     * destroyed.
     */
    vi.mocked(api.getPost).mockRejectedValue(new NotFoundError(local.id));

    open(local.id);

    expect(await screen.findByText(/on this device only/i)).toBeTruthy();
    expect(api.getPost).not.toHaveBeenCalled();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });

  it('a local post that HAS been migrated is an ordinary cached post', async () => {
    const post = makePost();
    await db.localPosts.put({ ...post, migratedAt: Date.now() });
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    expect(api.getPost).toHaveBeenCalledWith(post.id);
  });
});

describe('a pending row only a human can end', () => {
  async function seedTerminalRow(postId: string, userId: string, state: 'unresolved' | 'blocked') {
    await queuePending({
      postId,
      userId,
      patch: { content: para('my unsent paragraph') },
      baseRevision: 3,
    });
    await markPending(postId, userId, { state, detail: 'content.text too long' });
  }

  it('renders the resolution screen for this user', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await seedTerminalRow(post.id, WRITER.id, 'unresolved');
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText(/two versions of this post exist/i)).toBeTruthy();
    expect(await screen.findByText('my unsent paragraph')).toBeTruthy();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
  });

  it("does NOT render another user's unsent draft to whoever opens the post next", async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    // A colleague left an unresolved row on this shared machine. The store's
    // primary key is [postId+ownerUserId] so their words are still here — and
    // an id-only lookup in the gate would put them on this writer's screen.
    await seedTerminalRow(post.id, COLLEAGUE.id, 'unresolved');
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    expect(screen.queryByText('my unsent paragraph')).toBeNull();
    expect(screen.queryByText(/two versions of this post exist/i)).toBeNull();
    // And it is still there for its owner to deal with on #/recover.
    expect(await listPending(COLLEAGUE.id)).toHaveLength(1);
  });

  it('a `blocked` row shows the server reason and offers an export', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await seedTerminalRow(post.id, WRITER.id, 'blocked');
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText(/could not be saved/i)).toBeTruthy();
    expect(screen.getByText(/content\.text too long/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /export mine to a file/i })).toBeTruthy();
  });

  it('a merely `queued` row is not a question for a human — the editor opens', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await queuePending({
      postId: post.id,
      userId: WRITER.id,
      patch: { content: para('waiting for the network') },
      baseRevision: 3,
    });
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });
});

describe("someone else's post", () => {
  it('opens read-only in the editor route rather than an editor that 403s', async () => {
    const post = makePost({ authorId: COLLEAGUE.id, authorName: COLLEAGUE.displayName });
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id, 'edit');

    expect(await screen.findByText(/wrote this one/i)).toBeTruthy();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
  });

  it('still opens in the reader, because reads are universal', async () => {
    const post = makePost({ authorId: COLLEAGUE.id });
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id, 'read');

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });

  it('opens normally for an owner', async () => {
    fixture.session = { status: 'authed', user: { ...WRITER, role: 'owner' } };
    const post = makePost({ authorId: COLLEAGUE.id });
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id, 'edit');

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });
});

describe('the three outcomes of asking the server', () => {
  it('a full cached row renders the child', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    vi.mocked(api.getPost).mockResolvedValue(post);

    open(post.id);

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });

  it('`gone` lets the child render its own deletion screen', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    vi.mocked(api.getPost).mockRejectedValue(new NotFoundError(post.id));

    open(post.id);

    // The server was asked about an id it had once issued, and answered. This
    // is the one arm where the deletion sentence is the truth.
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    expect(await db.posts.get(post.id)).toBeUndefined();
  });

  it('offline with nothing cached says so, and never says the post was deleted', async () => {
    fixture.session = { status: 'offline', user: WRITER };

    open('p_never_seen');

    // `.` rather than an apostrophe: the copy uses a typographic one.
    expect(await screen.findByText(/can.t load this post/i)).toBeTruthy();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
    // `session.ts` already established there is no route to the server; a
    // second fetch would only add a timeout to the wait.
    expect(api.getPost).not.toHaveBeenCalled();
  });

  it('offline WITH a cached row renders it, rather than a screen about the network', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await writeOverlay(WRITER.id, post.id, { content: para('typed on a plane') });
    fixture.session = { status: 'offline', user: WRITER };

    open(post.id);

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });

  it('an unreachable server mid-navigation is not a deletion either', async () => {
    vi.mocked(api.getPost).mockRejectedValue(new OfflineError());

    open('p_unreachable');

    expect(await screen.findByText(/can.t load this post/i)).toBeTruthy();
  });
});

describe('the replay gate', () => {
  it('does not release the child until replayPending has settled', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    vi.mocked(api.getPost).mockResolvedValue(post);
    let release = () => undefined as void;
    fixture.replay = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    open(post.id);

    // Releasing early opens the editor on the server's version while the
    // writer's newer, unsent words are still sitting in a `pending` row nothing
    // has looked at — and the first autosave writes the old text over the new.
    await Promise.resolve();
    expect(screen.queryByText('THE EDITOR')).toBeNull();

    release();
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });
});
