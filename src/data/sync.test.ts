import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `sync.ts` against a mocked `api.ts`.
 *
 * The seam is the point: `api.ts` has its own suite for what goes on the wire,
 * so everything here is about what lands in Dexie afterwards — because the
 * three files that read those stores are frozen and cannot be tested any other
 * way. Assertions are therefore written against `db.posts`, `db.postList` and
 * `db.revisions` by the same queries `Editor.tsx:48`, `Dashboard` and
 * `RevisionPanel.tsx:32` use, not against the cache helpers that wrote them.
 */
vi.mock('./api', () => ({
  api: {
    listPosts: vi.fn(),
    getPost: vi.fn(),
    listRevisions: vi.fn(),
    getRevision: vi.fn(),
    savePost: vi.fn(),
  },
}));

import { api } from './api';
import { cachePost, cacheRevisions } from './cache';
import { db } from './db';
import { ApiError, ForbiddenError, NotFoundError, OfflineError, StaleWriteError } from './errors';
import { listPending, queuePending } from './pending';
import { replayPending, revalidate, syncList, syncPost, syncRevisions } from './sync';
import { EMPTY_DOC, type DocNode, type ListPost, type Post, type Revision } from './types';

const USER = 'u_writer';
const OTHER = 'u_colleague';

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
    excerpt: 'from the server',
    excerptSource: 'derived',
    content: EMPTY_DOC,
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 2,
    publishedAt: null,
    deletedAt: null,
    wordCount: 0,
    readingTime: 0,
    authorId: USER,
    authorName: 'A Writer',
    revision: 1,
    ...over,
  };
}

function listRow(post: Post): ListPost {
  const { content: _dropped, ...rest } = post;
  return rest;
}

function makeRevision(postId: string, revision: number, over: Partial<Revision> = {}): Revision {
  return {
    id: `r_${postId}_${revision}`,
    postId,
    revision,
    createdAt: revision,
    title: 't',
    subtitle: '',
    content: para(`body ${revision}`),
    wordCount: 2,
    kind: 'autosave',
    ...over,
  };
}

const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

beforeEach(async () => {
  vi.resetAllMocks();
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.pending.clear();
});

// --------------------------------------------------------------- syncList

describe('syncList', () => {
  it('walks every page of BOTH status views', async () => {
    const live = makePost({ title: 'Live' });
    const more = makePost({ title: 'Also live' });
    const gone = makePost({ title: 'Trashed', deletedAt: 99 });
    vi.mocked(api.listPosts).mockImplementation(async (q = {}) => {
      if (q.status === 'trash') return page([listRow(gone)]);
      return q.cursor ? page([listRow(more)]) : page([listRow(live)], 'cursor-2');
    });

    expect(await syncList(USER)).toBe(3);

    const statuses = vi.mocked(api.listPosts).mock.calls.map(([q]) => q?.status);
    expect(statuses).toContain('all');
    expect(statuses).toContain('trash');
    // `status=all` pushes `deleted_at IS NULL` server-side, so without the
    // second view the Trash tab is permanently empty.
    expect(await db.postList.get(gone.id)).toBeDefined();
    expect(await db.postList.get(more.id)).toBeDefined();
  });

  it('stops paging when the cursor runs out rather than trusting the page size', async () => {
    vi.mocked(api.listPosts).mockResolvedValue(page([listRow(makePost())]));
    await syncList(USER);
    // One call per view and no more: a full page with no cursor is the end.
    expect(vi.mocked(api.listPosts)).toHaveBeenCalledTimes(2);
  });

  it('keeps the pages it already wrote when a later one fails', async () => {
    const first = makePost({ title: 'Page one' });
    vi.mocked(api.listPosts).mockImplementation(async (q = {}) => {
      if (q.cursor) throw new OfflineError();
      return page([listRow(first)], 'cursor-2');
    });

    await expect(syncList(USER)).rejects.toBeInstanceOf(OfflineError);
    expect(await db.postList.get(first.id)).toBeDefined();
  });

  it('cannot put a bodyless row into the editor’s store', async () => {
    const p = makePost();
    vi.mocked(api.listPosts).mockResolvedValue(page([listRow(p)]));
    await syncList(USER);
    // The v1 defect: a list projection reaching `db.posts` paints an empty
    // document over a real post on the editor's one-shot hydration.
    expect(await db.posts.get(p.id)).toBeUndefined();
  });
});

// --------------------------------------------------------------- syncPost

describe('syncPost', () => {
  it('caches the full post the editor hydrates from', async () => {
    const p = makePost({ content: para('the whole document') });
    vi.mocked(api.getPost).mockResolvedValue(p);

    expect(await syncPost(USER, p.id)).toBe('ok');
    const row = await db.posts.get(p.id);
    expect(row?.content).toEqual(para('the whole document'));
    expect(row?.ownerUserId).toBe(USER);
  });

  it('EVICTS the cached row on a 404, so the deletion screen can appear', async () => {
    const p = makePost({ content: para('this post is destroyed') });
    await cachePost(USER, p);
    await cacheRevisions(USER, [makeRevision(p.id, 1)]);
    // The guard is only reachable with something cached to evict.
    expect(await db.posts.get(p.id)).toBeDefined();
    expect(await db.postList.get(p.id)).toBeDefined();

    vi.mocked(api.getPost).mockRejectedValue(new NotFoundError(p.id));

    expect(await syncPost(USER, p.id)).toBe('gone');
    expect(await db.posts.get(p.id)).toBeUndefined();
    expect(await db.postList.get(p.id)).toBeUndefined();
    expect(await db.revisions.where('postId').equals(p.id).count()).toBe(0);
  });

  it('a dropped connection is “offline” and keeps every cached row', async () => {
    const p = makePost({ content: para('still mine') });
    await cachePost(USER, p);
    vi.mocked(api.getPost).mockRejectedValue(new OfflineError());

    expect(await syncPost(USER, p.id)).toBe('offline');
    // The distinction the whole result type exists for: no answer is not an
    // answer of "destroyed".
    expect((await db.posts.get(p.id))?.content).toEqual(para('still mine'));
  });

  it('a 5xx is offline too, and a 403 is neither', async () => {
    const p = makePost();
    await cachePost(USER, p);

    vi.mocked(api.getPost).mockRejectedValue(
      new ApiError({ status: 503, code: 'unavailable' }),
    );
    expect(await syncPost(USER, p.id)).toBe('offline');

    vi.mocked(api.getPost).mockRejectedValue(new ForbiddenError());
    // "Check your connection" is advice a reconnect cannot satisfy.
    await expect(syncPost(USER, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.posts.get(p.id)).toBeDefined();
  });
});

// ----------------------------------------------------------- syncRevisions

describe('syncRevisions', () => {
  const metaOf = (r: Revision) => {
    const { content: _dropped, ...rest } = r;
    return rest;
  };

  it('fetches only the bodies this device is missing, newest first', async () => {
    const postId = 'p_hist';
    const revs = [3, 2, 1].map((i) => makeRevision(postId, i));
    await cacheRevisions(USER, [revs[2]]); // revision 1 is already here
    vi.mocked(api.listRevisions).mockResolvedValue(page(revs.map(metaOf)));
    vi.mocked(api.getRevision).mockImplementation(
      async (id) => revs.find((r) => r.id === id)!,
    );

    expect(await syncRevisions(USER, postId)).toBe(2);
    const asked = vi.mocked(api.getRevision).mock.calls.map(([id]) => id);
    expect(asked).toEqual([revs[0].id, revs[1].id]);
    expect(await db.revisions.where('postId').equals(postId).count()).toBe(3);
  });

  it('asks for nothing at all once every body is cached', async () => {
    const postId = 'p_done';
    const revs = [2, 1].map((i) => makeRevision(postId, i));
    await cacheRevisions(USER, revs);
    vi.mocked(api.listRevisions).mockResolvedValue(page(revs.map(metaOf)));

    expect(await syncRevisions(USER, postId)).toBe(0);
    expect(vi.mocked(api.getRevision)).not.toHaveBeenCalled();
  });

  it('prunes cached revisions the page no longer lists — and only inside its range', async () => {
    const postId = 'p_pruned';
    const server = [6, 5, 4].map((i) => makeRevision(postId, i));
    // Revision 5's body is cached under an id the server has since pruned, and
    // revision 1 is history this page never covered.
    const supersededInRange = makeRevision(postId, 5, { id: 'r_stale_5' });
    const olderThanThePage = makeRevision(postId, 1);
    await cacheRevisions(USER, [supersededInRange, olderThanThePage]);
    vi.mocked(api.listRevisions).mockResolvedValue(page(server.map(metaOf)));
    vi.mocked(api.getRevision).mockImplementation(
      async (id) => server.find((r) => r.id === id)!,
    );

    await syncRevisions(USER, postId);

    // The frozen panel auto-selects `[0]` and renders it, so offering a
    // revision the server has deleted is a restore of a snapshot that is gone.
    expect(await db.revisions.get('r_stale_5')).toBeUndefined();
    // ...but pagination must not delete the history it simply did not ask for.
    expect(await db.revisions.get(olderThanThePage.id)).toBeDefined();
  });

  it('a body that vanished between the listing and the fetch skips, and the rest land', async () => {
    const postId = 'p_race';
    const revs = [2, 1].map((i) => makeRevision(postId, i));
    vi.mocked(api.listRevisions).mockResolvedValue(page(revs.map(metaOf)));
    vi.mocked(api.getRevision).mockImplementation(async (id) => {
      if (id === revs[0].id) throw new NotFoundError(id, 'Revision');
      return revs[1];
    });

    expect(await syncRevisions(USER, postId)).toBe(1);
    expect(await db.revisions.get(revs[1].id)).toBeDefined();
  });

  it('stops the pool on an expired session instead of re-earning the 401 thirty times', async () => {
    const postId = 'p_401';
    const revs = Array.from({ length: 12 }, (_, i) => makeRevision(postId, 12 - i));
    vi.mocked(api.listRevisions).mockResolvedValue(page(revs.map(metaOf)));
    vi.mocked(api.getRevision).mockRejectedValue(
      new ApiError({ status: 401, code: 'unauthenticated' }),
    );

    expect(await syncRevisions(USER, postId)).toBe(0);
    // Four workers, each of which gives up on its first failure.
    expect(vi.mocked(api.getRevision).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('is a no-op for a post with no history rather than a failure', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue(page([]));
    expect(await syncRevisions(USER, 'p_new')).toBe(0);
  });
});

// ------------------------------------------------------------ replayPending

describe('replayPending', () => {
  it('sends a queued patch, caches the result and clears the row', async () => {
    const p = makePost({ content: para('offline words'), revision: 4 });
    await queuePending({
      postId: p.id,
      userId: USER,
      patch: { content: para('offline words') },
      baseRevision: 3,
    });
    vi.mocked(api.savePost).mockResolvedValue(p);

    const report = await replayPending(USER);

    expect(report.sent).toBe(1);
    expect(vi.mocked(api.savePost)).toHaveBeenCalledWith(
      p.id,
      { content: para('offline words') },
      { baseRevision: 3, kind: 'autosave' },
    );
    expect(await db.pending.get([p.id, USER])).toBeUndefined();
    expect((await db.posts.get(p.id))?.revision).toBe(4);
  });

  it('a 409 marks the row unresolved AND caches the server’s post', async () => {
    const stale = makePost({ content: para('what I had'), revision: 2 });
    await cachePost(USER, stale);
    await queuePending({
      postId: stale.id,
      userId: USER,
      patch: { content: para('my unsent words') },
      baseRevision: 2,
    });
    const theirs = { ...stale, content: para('what they wrote'), revision: 7 };
    vi.mocked(api.savePost).mockRejectedValue(new StaleWriteError(2, 7, theirs));

    const report = await replayPending(USER);

    expect(report.unresolved).toBe(1);
    expect((await db.pending.get([stale.id, USER]))?.state).toBe('unresolved');
    // Both halves of the resolution screen read from here.
    expect((await db.posts.get(stale.id))?.content).toEqual(para('what they wrote'));
  });

  it('a permanent 422 blocks the row and keeps the server’s reason', async () => {
    const p = makePost();
    await queuePending({ postId: p.id, userId: USER, patch: { title: 'x' }, baseRevision: 1 });
    vi.mocked(api.savePost).mockRejectedValue(
      new ApiError({ status: 422, code: 'invalid_document', detail: 'content.1.attrs.src' }),
    );

    const report = await replayPending(USER);

    expect(report.blocked).toBe(1);
    const row = await db.pending.get([p.id, USER]);
    expect(row?.state).toBe('blocked');
    // Without the reason `#/recover` can list the row but cannot say why.
    expect(row?.detail).toBe('content.1.attrs.src');
  });

  it('an expired session leaves the row QUEUED, not blocked', async () => {
    const p = makePost();
    await queuePending({ postId: p.id, userId: USER, patch: { title: 'x' }, baseRevision: 1 });
    vi.mocked(api.savePost).mockRejectedValue(
      new ApiError({ status: 401, code: 'unauthenticated' }),
    );

    const report = await replayPending(USER);

    // 401 is not transient by status, but re-authenticating makes the same
    // request succeed — blocking it would strand a writer behind a recovery
    // screen for a cookie that expired overnight.
    expect(report.queued).toBe(1);
    expect((await db.pending.get([p.id, USER]))?.state).toBe('queued');
  });

  it('offline leaves the row and its overlay exactly as they were', async () => {
    const p = makePost({ content: para('server text') });
    await cachePost(USER, p);
    await queuePending({ postId: p.id, userId: USER, patch: { title: 'mine' }, baseRevision: 1 });
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());

    const report = await replayPending(USER);

    expect(report.queued).toBe(1);
    expect((await db.pending.get([p.id, USER]))?.state).toBe('queued');
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('never re-sends a row a human has to end', async () => {
    const a = makePost();
    const b = makePost();
    await queuePending({ postId: a.id, userId: USER, patch: { title: 'a' }, baseRevision: 1 });
    await queuePending({ postId: b.id, userId: USER, patch: { title: 'b' }, baseRevision: 1 });
    await db.pending.put({ ...(await db.pending.get([a.id, USER]))!, state: 'unresolved' });
    await db.pending.put({ ...(await db.pending.get([b.id, USER]))!, state: 'blocked' });

    const report = await replayPending(USER);

    expect(vi.mocked(api.savePost)).not.toHaveBeenCalled();
    expect(report).toMatchObject({ unresolved: 1, blocked: 1, sent: 0 });
  });

  it('does not delete a newer row written while the replay was in flight', async () => {
    const p = makePost();
    await queuePending({
      postId: p.id,
      userId: USER,
      patch: { title: 'the first attempt' },
      baseRevision: 1,
    });
    vi.mocked(api.savePost).mockImplementation(async () => {
      // A keystroke fails while this request is on the wire: seq goes to 2 and
      // the row now holds text this replay never carried.
      await queuePending({
        postId: p.id,
        userId: USER,
        patch: { title: 'typed while the replay was in flight' },
        baseRevision: 1,
      });
      return p;
    });

    await replayPending(USER);

    const row = await db.pending.get([p.id, USER]);
    expect(row?.seq).toBe(2);
    expect(row?.patch.title).toBe('typed while the replay was in flight');
  });

  it('is user-scoped: it never replays another user’s patch (I4)', async () => {
    const p = makePost();
    await queuePending({
      postId: p.id,
      userId: OTHER,
      patch: { title: 'a colleague’s draft' },
      baseRevision: 1,
    });

    const report = await replayPending(USER);

    expect(vi.mocked(api.savePost)).not.toHaveBeenCalled();
    expect(report.sent).toBe(0);
    // Replaying it would be both a disclosure of their words and a write in
    // this user's name.
    expect(await listPending(OTHER)).toHaveLength(1);
  });
});

// -------------------------------------------------------------- revalidate

describe('revalidate', () => {
  it('syncs the whole list on any route that is not a post', async () => {
    vi.mocked(api.listPosts).mockResolvedValue(page([]));
    await revalidate(USER, '/');
    expect(vi.mocked(api.listPosts)).toHaveBeenCalled();
    expect(vi.mocked(api.getPost)).not.toHaveBeenCalled();
  });

  it('syncs the post and its history for /edit/:id', async () => {
    const p = makePost();
    vi.mocked(api.getPost).mockResolvedValue(p);
    vi.mocked(api.listRevisions).mockResolvedValue(page([]));

    await revalidate(USER, `/edit/${p.id}`);

    expect(vi.mocked(api.getPost)).toHaveBeenCalledWith(p.id);
    expect(vi.mocked(api.listRevisions)).toHaveBeenCalled();
    expect(vi.mocked(api.listPosts)).not.toHaveBeenCalled();
  });

  it('skips history for /read/:id, which has no History panel', async () => {
    const p = makePost();
    vi.mocked(api.getPost).mockResolvedValue(p);
    await revalidate(USER, `/read/${p.id}`);
    expect(vi.mocked(api.getPost)).toHaveBeenCalled();
    expect(vi.mocked(api.listRevisions)).not.toHaveBeenCalled();
  });

  it('asks for no history for a post the server says is gone', async () => {
    vi.mocked(api.getPost).mockRejectedValue(new NotFoundError('p_gone'));
    await revalidate(USER, '/edit/p_gone');
    expect(vi.mocked(api.listRevisions)).not.toHaveBeenCalled();
  });

  it('swallows a failure rather than giving a background refresh an error surface', async () => {
    vi.mocked(api.listPosts).mockRejectedValue(new OfflineError());
    await expect(revalidate(USER, '/')).resolves.toBeUndefined();
  });
});
