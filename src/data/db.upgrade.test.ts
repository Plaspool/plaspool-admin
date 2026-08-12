import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from './db';
import { cachedPosts, clearCache } from './cache';
import { docToText } from './doc';
import type { DocNode, Post, Revision } from './types';

/**
 * The v1 → v2 upgrade, run against a database that really is at v1.
 *
 * NOTHING IN THIS FILE MAY TOUCH `db` BEFORE `beforeAll` HAS SEEDED v1. Dexie
 * opens lazily on the first table operation, so importing the singleton above
 * is safe — but a single `db.posts.get()` before the seed would create the
 * database at v2 and the upgrade under test would run against nothing and
 * still pass.
 *
 * The tests deliberately share state: there is one upgrade event here and each
 * test asserts a different consequence of it.
 */

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function v1Post(id: string, title: string, text: string): Post {
  return {
    id,
    title,
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    content: doc(text),
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 2,
    publishedAt: null,
    deletedAt: null,
    wordCount: 2,
    readingTime: 1,
    // Pre-backend rows predate accounts entirely — this is what `posts.ts`
    // writes today, and the reason nothing may claim them for an account.
    authorId: 'local',
    authorName: 'You',
    revision: 3,
  };
}

function v1Revision(id: string, postId: string): Revision {
  return {
    id,
    postId,
    revision: 1,
    createdAt: 1,
    title: 'Snapshot',
    subtitle: '',
    content: doc('history'),
    wordCount: 1,
    kind: 'manual',
  };
}

beforeAll(async () => {
  const v1 = new Dexie('publishing-studio');
  v1.version(1).stores({
    posts: 'id, status, updatedAt, publishedAt, deletedAt, category, slug',
    revisions: 'id, postId, [postId+revision], createdAt',
    images: 'id, createdAt',
  });
  await v1.open();
  await v1
    .table<Post>('posts')
    .bulkPut([
      v1Post('p_novel', 'The novel', 'never uploaded anywhere'),
      v1Post('p_essay', 'The essay', 'also only here'),
    ]);
  await v1
    .table<Revision>('revisions')
    .bulkPut([v1Revision('r_1', 'p_novel'), v1Revision('r_2', 'p_essay')]);
  await v1.table('images').put({
    id: 'img_1',
    blob: new Blob(['bytes']),
    width: 1,
    height: 1,
    type: 'image/png',
    createdAt: 1,
  });
  // The upgrade cannot start while another connection holds v1 open.
  v1.close();
});

describe('the v1 → v2 upgrade', () => {
  it('moves the pre-backend library into localPosts and empties the cache store', async () => {
    await db.open();

    expect(await db.posts.count()).toBe(0);
    const local = await db.localPosts.orderBy('id').toArray();
    expect(local.map((p) => p.id)).toEqual(['p_essay', 'p_novel']);
    // Only copy in existence: the document has to arrive intact.
    expect(docToText(local[1].content)).toBe('never uploaded anywhere');
    expect(local.every((p) => p.migratedAt === null)).toBe(true);
  });

  it('moves the history into localRevisions and empties the cache store', async () => {
    expect(await db.revisions.count()).toBe(0);
    const revs = await db.localRevisions.orderBy('id').toArray();
    expect(revs.map((r) => r.id)).toEqual(['r_1', 'r_2']);
    expect(docToText(revs[0].content)).toBe('history');
  });

  it('leaves the image bytes where they are', async () => {
    expect(await db.images.count()).toBe(1);
  });

  it('is invisible to the user-scoped cache readers', async () => {
    // The moved rows carry no `ownerUserId` and no account may claim them —
    // v2 of this plan did claim them, and an ordinary logout then deleted the
    // writer's entire library.
    expect(await cachedPosts('u_alice')).toEqual([]);
    expect(await cachedPosts('local')).toEqual([]);
  });

  it('survives a logout, because clearCache cannot reach those stores', async () => {
    await clearCache();

    expect(await db.localPosts.count()).toBe(2);
    expect(await db.localRevisions.count()).toBe(2);
    expect(await db.images.count()).toBe(1);
  });

  it('does not run again, and does not duplicate, on a later open', async () => {
    db.close();
    await db.open();

    expect(await db.localPosts.count()).toBe(2);
    expect(await db.localRevisions.count()).toBe(2);
    expect(await db.posts.count()).toBe(0);
  });
});
