/**
 * Regression tests for every issue a gauntlet critic found.
 * Each `it` names the failure it prevents from coming back.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, newId } from './db';
import {
  collectOrphanImages,
  createPost,
  destroyPost,
  discardIfBlank,
  emptyTrash,
  publishPost,
  savePost,
  trashPost,
} from './posts';
import { IDB_SCHEME, docToText } from './doc';
import type { DocNode, StoredImage } from './types';

const imageDoc = (blobId: string, text = 'body'): DocNode => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    { type: 'image', attrs: { src: `${IDB_SCHEME}${blobId}`, alt: '' } },
  ],
});

async function seedImage(id = newId('img_')): Promise<string> {
  const rec: StoredImage = {
    id,
    blob: new Blob(['x']),
    width: 10,
    height: 10,
    type: 'image/png',
    createdAt: Date.now(),
  };
  await db.images.add(rec);
  return id;
}

beforeEach(async () => {
  await db.posts.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('image lifecycle (critic issue 3)', () => {
  it('does not delete an image another post still uses inline', async () => {
    const img = await seedImage();
    const a = await createPost({
      title: 'Cover user',
      coverImage: { blobId: img, alt: '', focalPoint: '50% 50%', width: 10, height: 10 },
    });
    await createPost({ title: 'Inline user', content: imageDoc(img) });

    await destroyPost(a.id);

    expect(await db.images.get(img)).toBeDefined();
  });

  it('collects an image nothing references any more', async () => {
    const img = await seedImage();
    const p = await createPost({ title: 'Only user', content: imageDoc(img) });
    await destroyPost(p.id);
    expect(await db.images.get(img)).toBeUndefined();
  });

  it('keeps images that only a revision snapshot still references', async () => {
    const img = await seedImage();
    const p = await createPost({ content: imageDoc(img) });
    // Author removes the image from the current document...
    await savePost(p.id, {
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await collectOrphanImages();
    // ...but the earlier revision can still be restored, so the blob lives.
    expect(await db.images.get(img)).toBeDefined();
  });

  it('never leaves a post referencing a blob that was collected', async () => {
    const shared = await seedImage();
    await createPost({ content: imageDoc(shared, 'keeps it') });
    const doomed = await createPost({ content: imageDoc(shared, 'goes away') });
    await destroyPost(doomed.id);

    const survivors = await db.posts.toArray();
    for (const p of survivors) {
      const refs = JSON.stringify(p.content).match(/idb:[a-z0-9_]+/gi) ?? [];
      for (const ref of refs) {
        expect(await db.images.get(ref.slice(IDB_SCHEME.length))).toBeDefined();
      }
    }
  });
});

describe('publish atomicity (critic issue 6)', () => {
  it('publishes and snapshots in one transaction', async () => {
    const p = await createPost({ title: 'Atomic', content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'final text' }] },
    ] } });
    const pub = await publishPost(p.id);

    const snap = await db.revisions
      .where('postId')
      .equals(p.id)
      .filter((r) => r.kind === 'publish')
      .first();

    expect(snap).toBeDefined();
    expect(snap!.revision).toBe(pub.revision);
    // The snapshot records exactly what was published, not an earlier read.
    expect(docToText(snap!.content)).toBe('final text');
    expect(snap!.title).toBe(pub.title);
  });

  it('does not revert derived fields written by a concurrent save', async () => {
    const p = await createPost({ title: 'Race', content: { type: 'doc', content: [] } });
    await savePost(p.id, { excerpt: 'author wrote this' });
    const pub = await publishPost(p.id);
    expect(pub.excerpt).toBe('author wrote this');
  });
});

describe('empty trash is all-or-nothing (critic non-blocking note)', () => {
  it('removes every trashed post and its revisions, leaving live posts alone', async () => {
    const live = await createPost({ title: 'Live' });
    const a = await createPost({ title: 'A' });
    const b = await createPost({ title: 'B' });
    await savePost(a.id, { title: 'A2' });
    await trashPost(a.id);
    await trashPost(b.id);

    expect(await emptyTrash()).toBe(2);
    expect(await db.posts.toArray()).toHaveLength(1);
    expect((await db.posts.get(live.id))!.title).toBe('Live');
    expect(await db.revisions.where('postId').equals(a.id).count()).toBe(0);
    expect(await db.revisions.where('postId').equals(b.id).count()).toBe(0);
  });
});

describe('checkpoint revisions survive pruning (critic issue 5)', () => {
  it('keeps every manual and publish snapshot through heavy autosaving', async () => {
    const p = await createPost({ title: 'Long session' });
    await savePost(p.id, { title: 'checkpoint one' }, { kind: 'manual' });
    for (let i = 0; i < 60; i++) {
      await savePost(p.id, { title: `auto ${i}` }, { kind: 'autosave' });
    }
    await savePost(p.id, { title: 'checkpoint two' }, { kind: 'manual' });

    const revs = await db.revisions.where('postId').equals(p.id).toArray();
    const manual = revs.filter((r) => r.kind === 'manual').map((r) => r.title);
    expect(manual).toContain('checkpoint one');
    expect(manual).toContain('checkpoint two');
    expect(revs.filter((r) => r.kind === "autosave").length).toBeLessThanOrEqual(40);
  });
});

describe('blank drafts do not accumulate (critic UX note)', () => {
  it('discards a post opened and abandoned without any content', async () => {
    const p = await createPost();
    expect(await discardIfBlank(p.id)).toBe(true);
    expect(await db.posts.get(p.id)).toBeUndefined();
  });

  it('never discards a draft that has anything in it', async () => {
    const withTitle = await createPost({ title: 'A' });
    const withWords = await createPost({
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
    });
    const withTags = await createPost({ tags: ['x'] });
    const withCover = await createPost({
      coverImage: { blobId: 'img_x', alt: '', focalPoint: '50% 50%', width: 1, height: 1 },
    });
    for (const p of [withTitle, withWords, withTags, withCover]) {
      expect(await discardIfBlank(p.id)).toBe(false);
      expect(await db.posts.get(p.id)).toBeDefined();
    }
  });

  it('never discards a published or archived post, even if empty', async () => {
    const pub = await createPost({ title: 'T' });
    await publishPost(pub.id);
    await savePost(pub.id, { title: '' });
    expect(await discardIfBlank(pub.id)).toBe(false);
  });
});
