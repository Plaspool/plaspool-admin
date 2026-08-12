import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `session.ts`, and almost entirely about ONE question: when may the cache be
 * thrown away.
 *
 * Every assertion about "nothing was cleared" is written against
 * `db.posts.get(id)` rather than against a cache helper, deliberately. That
 * exact query is `Editor.tsx:48`, which is frozen; if it stops returning a row
 * the writer is shown "This post no longer exists. It may have been
 * permanently deleted from this browser." over the document they are typing
 * into. Asserting through `cachedPost()` would pass just as happily while the
 * store underneath was empty for a reason the helper filtered out.
 */
vi.mock('./api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: {
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    savePost: vi.fn(),
  },
}));

import { api } from './api';
import { cachePost, writeOverlay } from './cache';
import { db } from './db';
import { AuthExpiredError, ApiError, OfflineError } from './errors';
import { listPending, queuePending } from './pending';
import { activeUser, setActiveUser } from './posts';
import {
  adoptUser,
  getSession,
  initSession,
  logout,
  noteAuthExpired,
  whenReplayed,
} from './session';
import { EMPTY_DOC, type AuthUser, type DocNode, type Post } from './types';

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

const REMEMBERED_KEY = 'blog-admin:session-user';

/**
 * A real `localStorage`, because the remembered-user path is the whole of the
 * offline arm and a stub that swallowed writes would let it pass while the
 * plane case stayed broken. The client project runs under node, which has
 * none.
 */
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

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
    authorId: WRITER.id,
    authorName: WRITER.displayName,
    revision: 3,
    ...over,
  };
}

beforeEach(async () => {
  // `resetAllMocks` and not `clearAllMocks`: the latter keeps implementations,
  // so a `mockResolvedValue` from an earlier case would still be answering here
  // — which silently made one of these tests replay successfully and assert
  // nothing it claimed to.
  vi.resetAllMocks();
  store.clear();
  setActiveUser('');
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.pending.clear();
  await db.localPosts.clear();
  // Every test starts from a settled `anonymous`, so no case inherits another's
  // in-flight boot or leftover user.
  vi.mocked(api.me).mockRejectedValue(new AuthExpiredError());
  vi.mocked(api.logout).mockResolvedValue(undefined);
  await initSession();
  vi.clearAllMocks();
  store.clear();
});

/** A cached post plus the writer's unsent words on top of it. */
async function seedWorkInProgress(): Promise<Post> {
  const post = makePost();
  await cachePost(WRITER.id, post);
  await queuePending({
    postId: post.id,
    userId: WRITER.id,
    patch: { content: para('nine hundred words') },
    baseRevision: post.revision,
  });
  await writeOverlay(WRITER.id, post.id, { content: para('nine hundred words') });
  return post;
}

describe('the offline boot is not an anonymous boot', () => {
  it('an unanswered /auth/me is `offline`, and clears nothing', async () => {
    const post = await seedWorkInProgress();
    store.set(REMEMBERED_KEY, JSON.stringify(WRITER));
    vi.mocked(api.me).mockRejectedValue(new OfflineError());

    const state = await initSession();

    expect(state.status).toBe('offline');
    // The frozen editor's own query. A row here is the difference between the
    // writer seeing their document and being told it was deleted.
    expect(await db.posts.get(post.id)).toBeDefined();
    expect((await db.posts.get(post.id))?.pendingAt).toBeTypeOf('number');
    expect(await db.postList.count()).toBe(1);
    expect(await listPending(WRITER.id)).toHaveLength(1);
  });

  it('paints as the remembered user, so the user-scoped cache is readable', async () => {
    store.set(REMEMBERED_KEY, JSON.stringify(WRITER));
    vi.mocked(api.me).mockRejectedValue(new OfflineError());

    const state = await initSession();

    expect(state).toMatchObject({ status: 'offline', user: { id: WRITER.id } });
    // I2: `cache.ts` filters every read on `ownerUserId`, so an offline boot
    // that forgot the id would paint nothing at all.
    expect(activeUser()).toBe(WRITER.id);
  });

  it('a 500 and a 429 are offline too — neither knows who you are', async () => {
    const post = await seedWorkInProgress();
    for (const status of [500, 429]) {
      vi.mocked(api.me).mockRejectedValue(
        new ApiError({ status, code: status === 429 ? 'rate_limited' : 'internal' }),
      );
      const state = await initSession();
      expect(state.status).toBe('offline');
      expect(await db.posts.get(post.id)).toBeDefined();
    }
  });

  it('with no remembered user there is nothing to paint, and still nothing cleared', async () => {
    const post = await seedWorkInProgress();
    vi.mocked(api.me).mockRejectedValue(new OfflineError());

    const state = await initSession();

    expect(state).toMatchObject({ status: 'offline', user: null });
    expect(await db.posts.get(post.id)).toBeDefined();
  });
});

describe('a boot that is authoritatively refused', () => {
  it('a 401 at boot clears the cache before anything paints', async () => {
    await seedWorkInProgress();
    store.set(REMEMBERED_KEY, JSON.stringify(WRITER));
    vi.mocked(api.me).mockRejectedValue(new AuthExpiredError());

    const state = await initSession();

    expect(state).toMatchObject({ status: 'anonymous', reason: 'boot' });
    expect(await db.posts.count()).toBe(0);
    expect(await db.postList.count()).toBe(0);
    expect(activeUser()).toBe('');
    // The device forgets who it was, so the next offline boot cannot paint the
    // previous person's rows for whoever is sitting there.
    expect(store.get(REMEMBERED_KEY)).toBeUndefined();
  });

  it('keeps `pending`, because only an explicit logout may destroy unsent words', async () => {
    await seedWorkInProgress();
    vi.mocked(api.me).mockRejectedValue(new AuthExpiredError());

    await initSession();

    // Keyed by [postId+ownerUserId], so the arriving user can neither read nor
    // replay these (I4) — and they are the only copy of words no server has.
    expect(await listPending(WRITER.id)).toHaveLength(1);
  });

  it('a confirmed DIFFERENT user clears the cache', async () => {
    const post = await seedWorkInProgress();
    store.set(REMEMBERED_KEY, JSON.stringify(WRITER));
    vi.mocked(api.me).mockResolvedValue(COLLEAGUE);

    const state = await initSession();

    expect(state).toMatchObject({ status: 'authed', user: { id: COLLEAGUE.id } });
    expect(await db.posts.get(post.id)).toBeUndefined();
    expect(await listPending(WRITER.id)).toHaveLength(1);
    expect(activeUser()).toBe(COLLEAGUE.id);
  });

  it('the SAME user clears nothing and replays what is queued', async () => {
    const post = await seedWorkInProgress();
    store.set(REMEMBERED_KEY, JSON.stringify(WRITER));
    vi.mocked(api.me).mockResolvedValue(WRITER);
    vi.mocked(api.savePost).mockResolvedValue(makePost({ id: post.id, revision: 9 }));

    const state = await initSession();
    await whenReplayed();

    expect(state).toMatchObject({ status: 'authed' });
    expect(api.savePost).toHaveBeenCalledOnce();
    expect(await listPending(WRITER.id)).toHaveLength(0);
    expect(await db.posts.get(post.id)).toBeDefined();
  });

  it('`whenReplayed` settles even when the replay itself fails', async () => {
    await seedWorkInProgress();
    vi.mocked(api.me).mockResolvedValue(WRITER);
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());

    await initSession();

    // A rejection here would leave `PostGate` waiting forever on a promise
    // nothing catches, i.e. a permanently blank editor.
    await expect(whenReplayed()).resolves.toBeUndefined();
  });
});

describe('a 401 that arrives mid-session', () => {
  it('clears NOTHING and leaves the row the frozen editor reads', async () => {
    const post = await seedWorkInProgress();
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();
    await whenReplayed();
    await writeOverlay(WRITER.id, post.id, { content: para('nine hundred words') });

    noteAuthExpired();

    expect(getSession()).toMatchObject({
      status: 'anonymous',
      reason: 'expired',
      user: { id: WRITER.id },
    });
    // Editor.tsx:48. `clearCache` here would delete this row and the frozen
    // `if (!post)` branch would replace the open document with a deletion
    // notice — strictly worse than the modal Ghost shows.
    const row = await db.posts.get(post.id);
    expect(row).toBeDefined();
    expect(row?.content).toEqual(para('nine hundred words'));
    expect(await db.postList.count()).toBe(1);
  });

  it('leaves the ambient user id alone, so a failed save still queues under its author', async () => {
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();

    noteAuthExpired();

    // `savePost` has no user parameter — the frozen `useAutosave` passes none —
    // so resetting this to '' would file the writer's next paragraph under
    // nobody, and no screen would ever list it again.
    expect(activeUser()).toBe(WRITER.id);
  });

  it('does not rewrite a boot-anonymous state, because a wrong password also 401s', async () => {
    vi.mocked(api.me).mockRejectedValue(new AuthExpiredError());
    await initSession();

    // `api.ts` announces `auth-expired` for EVERY 401 it sees, including the
    // one from a failed login attempt on the screen this state is rendering.
    noteAuthExpired();

    expect(getSession()).toMatchObject({ status: 'anonymous', reason: 'boot' });
  });

  it('re-authenticating as the same user keeps the cache and replays', async () => {
    const post = await seedWorkInProgress();
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();
    await whenReplayed();
    vi.clearAllMocks();
    noteAuthExpired();
    vi.mocked(api.savePost).mockResolvedValue(makePost({ id: post.id, revision: 9 }));
    await queuePending({
      postId: post.id,
      userId: WRITER.id,
      patch: { content: para('typed while signed out') },
      baseRevision: 3,
    });

    await adoptUser(WRITER);
    await whenReplayed();

    expect(getSession()).toMatchObject({ status: 'authed' });
    expect(await db.posts.get(post.id)).toBeDefined();
    // The words typed against the expired session are what replay is for.
    expect(api.savePost).toHaveBeenCalledWith(
      post.id,
      { content: para('typed while signed out') },
      expect.anything(),
    );
  });

  it('re-authenticating as a different user clears the cache', async () => {
    const post = await seedWorkInProgress();
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();
    await whenReplayed();
    noteAuthExpired();

    await adoptUser(COLLEAGUE);

    expect(await db.posts.get(post.id)).toBeUndefined();
  });
});

describe('logout', () => {
  it('asks first when unsent work would be destroyed, and names the count', async () => {
    const post = await seedWorkInProgress();
    await queuePending({
      postId: 'p_other',
      userId: WRITER.id,
      patch: { title: 'second' },
      baseRevision: 1,
    });
    vi.mocked(api.me).mockResolvedValue(WRITER);
    // Still unsent after the boot's replay, which is the state this guard is
    // about: the rows exist precisely because the network would not take them.
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());
    await initSession();
    await whenReplayed();

    const outcome = await logout();

    expect(outcome).toEqual({ status: 'needs-confirm', pending: 2 });
    // Nothing may happen before the human answers — not the cookie, not the
    // cache, not the rows.
    expect(api.logout).not.toHaveBeenCalled();
    expect(await db.posts.get(post.id)).toBeDefined();
    expect(await listPending(WRITER.id)).toHaveLength(2);
    expect(getSession()).toMatchObject({ status: 'authed' });
  });

  it('confirmed, it destroys the cache AND the pending rows', async () => {
    const post = await seedWorkInProgress();
    vi.mocked(api.me).mockResolvedValue(WRITER);
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());
    await initSession();
    await whenReplayed();

    const outcome = await logout({ confirmed: true });

    expect(outcome).toEqual({ status: 'done' });
    expect(api.logout).toHaveBeenCalledOnce();
    expect(await db.posts.get(post.id)).toBeUndefined();
    expect(await listPending(WRITER.id)).toHaveLength(0);
    expect(activeUser()).toBe('');
    expect(getSession()).toMatchObject({ status: 'anonymous', reason: 'boot' });
  });

  it('with nothing pending it does not ask', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();

    expect(await logout()).toEqual({ status: 'done' });
    expect(await db.posts.get(post.id)).toBeUndefined();
  });

  it('still clears this device when the server cannot be reached', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();
    vi.mocked(api.logout).mockRejectedValue(new OfflineError());

    // Half a logout — cookie gone, library still here, or the reverse — is
    // worse than either whole. The person asked for their work off this
    // machine.
    expect(await logout()).toEqual({ status: 'done' });
    expect(await db.posts.get(post.id)).toBeUndefined();
    expect(store.get(REMEMBERED_KEY)).toBeUndefined();
  });
});

describe('the remembered user', () => {
  it('is written on a confirmed identity and read back on the next boot', async () => {
    vi.mocked(api.me).mockResolvedValue(WRITER);
    await initSession();
    expect(JSON.parse(store.get(REMEMBERED_KEY)!)).toMatchObject({ id: WRITER.id });

    vi.mocked(api.me).mockRejectedValue(new OfflineError());
    expect(await initSession()).toMatchObject({ status: 'offline', user: { id: WRITER.id } });
  });

  it('a half-written value is no user at all', async () => {
    store.set(REMEMBERED_KEY, '{"email":"writer@test.local"}');
    vi.mocked(api.me).mockRejectedValue(new OfflineError());

    // An id-less record must not become the empty-string id, which every
    // user-scoped reader in `cache.ts` would then match against legacy rows.
    expect(await initSession()).toMatchObject({ status: 'offline', user: null });
    expect(activeUser()).toBe('');
  });

  it('concurrent boots share one /auth/me', async () => {
    vi.mocked(api.me).mockResolvedValue(WRITER);

    const [a, b] = await Promise.all([initSession(), initSession()]);

    // Two in-flight boots could settle in either order, and an `offline` state
    // landing after an `authed` one would blank a signed-in app.
    expect(api.me).toHaveBeenCalledOnce();
    expect(a).toEqual(b);
  });
});
