import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type CachedPost } from './db';
import {
  cacheList,
  cachePost,
  cacheRevisions,
  cachedList,
  cachedPost,
  cachedPosts,
  cachedRevisionIds,
  clearCache,
  evictPost,
  writeOverlay,
} from './cache';
import { docToText } from './doc';
import type { DocNode, ListPost, Post, Revision } from './types';

const A = 'u_alice';
const B = 'u_bob';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * Built here rather than through `createDraftShape` so this suite does not move
 * when Task 19 repoints `posts.ts` at the API.
 */
function post(over: Partial<Post> = {}): Post {
  return {
    id: 'p_1',
    title: 'Title',
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    content: doc('server words'),
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 1,
    publishedAt: null,
    deletedAt: null,
    wordCount: 2,
    readingTime: 1,
    authorId: A,
    authorName: 'Alice',
    revision: 1,
    ...over,
  };
}

function listRow(over: Partial<Post> = {}): ListPost {
  const { content: _dropped, ...rest } = post(over);
  return rest;
}

function revision(over: Partial<Revision> = {}): Revision {
  return {
    id: 'r_1',
    postId: 'p_1',
    revision: 1,
    createdAt: 1,
    title: 'Title',
    subtitle: '',
    content: doc('snapshot'),
    wordCount: 1,
    kind: 'autosave',
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([
    db.posts.clear(),
    db.postList.clear(),
    db.revisions.clear(),
    db.pending.clear(),
    db.localPosts.clear(),
    db.localRevisions.clear(),
    db.images.clear(),
    db.assetMap.clear(),
  ]);
});

describe('I1 — revision monotonicity', () => {
  it('ignores a write carrying an older revision', async () => {
    await cachePost(A, post({ revision: 5, title: 'newer' }));
    await cachePost(A, post({ revision: 4, title: 'older' }));

    const row = await db.posts.get('p_1');
    expect(row?.revision).toBe(5);
    expect(row?.title).toBe('newer');
    expect((await db.postList.get('p_1'))?.revision).toBe(5);
  });

  it('merges a write at the same revision instead of replacing the row', async () => {
    // A field the incoming server row does not carry. If the equal-revision arm
    // replaced rather than merged, this would be gone.
    await db.posts.put({
      ...post({ revision: 5, title: 'first' }),
      ownerUserId: A,
      pendingAt: null,
      keptByMerge: 'yes',
    } as CachedPost);

    await cachePost(A, post({ revision: 5, title: 'second' }));

    const row = (await db.posts.get('p_1')) as CachedPost & { keptByMerge?: string };
    expect(row.title).toBe('second');
    expect(row.keptByMerge).toBe('yes');
  });

  it('replaces on a strictly higher revision', async () => {
    await cachePost(A, post({ revision: 5, title: 'old' }));
    await cachePost(A, post({ revision: 6, title: 'new' }));

    const row = await db.posts.get('p_1');
    expect(row?.revision).toBe(6);
    expect(row?.title).toBe('new');
  });

  it('does not let an equal-revision server row overwrite unsent words', async () => {
    await cachePost(A, post({ revision: 5 }));
    await writeOverlay(A, 'p_1', { content: doc('unsent words') });

    // Exactly what a background revalidation returns: the same revision, the
    // same text the server has always had.
    await cachePost(A, post({ revision: 5 }));

    const row = await db.posts.get('p_1');
    expect(docToText(row!.content)).toBe('unsent words');
    expect(row?.pendingAt).not.toBeNull();
  });

  it('does replace an overlay when the server revision is strictly higher', async () => {
    await cachePost(A, post({ revision: 5 }));
    await writeOverlay(A, 'p_1', { content: doc('unsent words') });

    await cachePost(A, post({ revision: 6, content: doc('their words') }));

    const row = await db.posts.get('p_1');
    expect(docToText(row!.content)).toBe('their words');
    // The overlay is gone from the editor's store; the words it held are in the
    // `pending` row, which `clearPendingAfterSave` protects from the next save.
    expect(row?.pendingAt).toBeNull();
  });
});

describe("the editor's store holds full posts only", () => {
  it('never lets a list response reach db.posts', async () => {
    await cacheList(A, [listRow({ revision: 3 })]);

    expect(await db.posts.get('p_1')).toBeUndefined();
    expect((await db.postList.get('p_1'))?.revision).toBe(3);
  });

  it('strips content from a list payload that carries one', async () => {
    await cacheList(A, [post({ revision: 3 }) as ListPost]);

    const row = await db.postList.get('p_1');
    expect('content' in row!).toBe(false);
    expect(await db.posts.get('p_1')).toBeUndefined();
  });

  it('writes both stores for a full post', async () => {
    await cachePost(A, post({ revision: 2 }));

    expect((await db.posts.get('p_1'))?.content).toBeDefined();
    expect('content' in (await db.postList.get('p_1'))!).toBe(false);
  });

  it('refuses a post with no document', async () => {
    await expect(
      cachePost(A, { ...post(), content: undefined as unknown as DocNode }),
    ).rejects.toThrow(/without a document/);
    expect(await db.posts.count()).toBe(0);
  });

  it('refuses a revision with no document', async () => {
    await expect(
      cacheRevisions(A, [{ ...revision(), content: undefined as unknown as DocNode }]),
    ).rejects.toThrow(/without a document/);
    expect(await db.revisions.count()).toBe(0);
  });
});

describe('I2 — user scoping', () => {
  it('hides another user’s cached post', async () => {
    await cachePost(A, post({ id: 'p_a' }));
    await cachePost(B, post({ id: 'p_b' }));

    expect((await cachedPosts(A)).map((p) => p.id)).toEqual(['p_a']);
    expect(await cachedPost(B, 'p_a')).toBeUndefined();
    expect((await cachedPost(A, 'p_a'))?.id).toBe('p_a');
  });

  it('scopes the list and the cached revision ids', async () => {
    await cacheList(A, [listRow({ id: 'p_a' })]);
    await cacheList(B, [listRow({ id: 'p_b' })]);
    await cacheRevisions(A, [revision({ id: 'r_a', postId: 'p_a' })]);

    expect((await cachedList(B)).map((p) => p.id)).toEqual(['p_b']);
    expect([...(await cachedRevisionIds(A, 'p_a'))]).toEqual(['r_a']);
    expect((await cachedRevisionIds(B, 'p_a')).size).toBe(0);
  });
});

describe('I3 — clearing the cache', () => {
  beforeEach(async () => {
    await cachePost(A, post({ revision: 2 }));
    await cacheList(A, [listRow({ id: 'p_2', revision: 1 })]);
    await cacheRevisions(A, [revision()]);
    await db.pending.put({
      postId: 'p_1',
      ownerUserId: A,
      patch: { title: 'unsent' },
      baseRevision: 2,
      seq: 1,
      state: 'queued',
      updatedAt: 1,
    });
    // The four stores that hold the only copy of something.
    await db.localPosts.put({ ...post({ id: 'p_local' }), migratedAt: null });
    await db.localRevisions.put(revision({ id: 'r_local', postId: 'p_local' }));
    await db.images.put({
      id: 'img_1',
      blob: new Blob(['bytes']),
      width: 1,
      height: 1,
      type: 'image/png',
      createdAt: 1,
    });
    await db.assetMap.put({ localId: 'img_1', assetId: 'as_1' });
  });

  it('never touches the pre-backend library, the images or the asset map', async () => {
    await clearCache({ keepPending: true });

    expect(await db.posts.count()).toBe(0);
    expect(await db.postList.count()).toBe(0);
    expect(await db.revisions.count()).toBe(0);

    expect((await db.localPosts.get('p_local'))?.id).toBe('p_local');
    expect(await db.localRevisions.count()).toBe(1);
    expect(await db.images.count()).toBe(1);
    expect(await db.assetMap.count()).toBe(1);
  });

  it('keeps unsent writes unless the writer explicitly logs out', async () => {
    await clearCache({ keepPending: true });
    expect(await db.pending.count()).toBe(1);

    await clearCache();
    expect(await db.pending.count()).toBe(0);
    // Still never the local corpus, even on the logout path.
    expect(await db.localPosts.count()).toBe(1);
  });
});

describe('the overlay', () => {
  it('survives a reload and hydrates the frozen editor with the unsent words', async () => {
    await cachePost(A, post({ revision: 4 }));
    await writeOverlay(A, 'p_1', { title: 'half a sentence', content: doc('500 words') });

    db.close();
    await db.open();

    // db.posts.get(id) is literally what Editor.tsx:48 live-queries.
    const row = await db.posts.get('p_1');
    expect(row?.title).toBe('half a sentence');
    expect(docToText(row!.content)).toBe('500 words');
    // The revision is untouched: the server never accepted this write.
    expect(row?.revision).toBe(4);
  });

  it('does not invent a row when nothing is cached for this user', async () => {
    await cachePost(B, post({ revision: 1 }));

    expect(await writeOverlay(A, 'p_1', { title: 'mine' })).toBeUndefined();
    expect((await db.posts.get('p_1'))?.title).toBe('Title');
  });

  it('ignores an undefined patch value rather than emptying the document', async () => {
    await cachePost(A, post({ revision: 1 }));

    // Editor.tsx:193 passes `content: editor?.getJSON()`, which is undefined
    // whenever the editor is not mounted.
    await writeOverlay(A, 'p_1', {
      title: 'kept',
      content: undefined as unknown as DocNode,
    });

    const row = await db.posts.get('p_1');
    expect(row?.title).toBe('kept');
    expect(docToText(row!.content)).toBe('server words');
  });
});

describe('eviction', () => {
  it('forgets one post from every cache store and leaves the others', async () => {
    await cachePost(A, post({ id: 'p_1' }));
    await cachePost(A, post({ id: 'p_2' }));
    await cacheRevisions(A, [
      revision({ id: 'r_1', postId: 'p_1' }),
      revision({ id: 'r_2', postId: 'p_2' }),
    ]);

    await evictPost('p_1');

    expect(await db.posts.get('p_1')).toBeUndefined();
    expect(await db.postList.get('p_1')).toBeUndefined();
    expect(await db.revisions.get('r_1')).toBeUndefined();
    expect(await db.posts.get('p_2')).toBeDefined();
    expect(await db.revisions.get('r_2')).toBeDefined();
  });
});
