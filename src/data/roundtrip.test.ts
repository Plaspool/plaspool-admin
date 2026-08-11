/**
 * Regression tests for the integration-gauntlet findings.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, newId } from './db';
import {
  archivePost,
  createPost,
  duplicatePost,
  publishPost,
  savePost,
  sweepBlankDrafts,
  unpublishPost,
} from './posts';
import { exportBundle, importBundle, ImportError, BUNDLE_FORMAT } from './backup';
import { IDB_SCHEME, docToText, deriveExcerpt } from './doc';
import type { DocNode, StoredImage } from './types';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const withImage = (blobId: string, text: string): DocNode => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    { type: 'image', attrs: { src: `${IDB_SCHEME}${blobId}`, alt: 'pic' } },
  ],
});

async function seedImage(): Promise<string> {
  const rec: StoredImage = {
    id: newId('img_'),
    blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' }),
    width: 4,
    height: 4,
    type: 'image/png',
    createdAt: Date.now(),
  };
  await db.images.add(rec);
  return rec.id;
}

/** Dexie's typed `update` can't express a patch on a recursive doc type. */
async function age(id: string, ms: number) {
  const p = await db.posts.get(id);
  await db.posts.put({ ...p!, updatedAt: Date.now() - ms });
}

beforeEach(async () => {
  await db.posts.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('publishing does not strand the editor (blocking #1)', () => {
  it('a save based on the revision publish returned is accepted', async () => {
    const p = await createPost({ title: 'T', content: doc('before') });
    const published = await publishPost(p.id);
    // This is exactly what the editor does after adopting the new revision.
    const next = await savePost(
      p.id,
      { content: doc('typed after publishing') },
      { baseRevision: published.revision },
    );
    expect(docToText(next.content)).toBe('typed after publishing');
  });

  it('the same holds for unpublish and archive', async () => {
    const p = await createPost({ title: 'T', content: doc('x') });
    const un = await unpublishPost((await publishPost(p.id)).id);
    await expect(
      savePost(p.id, { content: doc('after unpublish') }, { baseRevision: un.revision }),
    ).resolves.toBeDefined();

    const ar = await archivePost(p.id);
    await expect(
      savePost(p.id, { content: doc('after archive') }, { baseRevision: ar.revision }),
    ).resolves.toBeDefined();
  });
});

describe('excerpts track the post (blocking #2)', () => {
  it('a derived excerpt follows the content instead of freezing', async () => {
    const p = await createPost();
    await savePost(p.id, { content: doc('the original opening lines') });
    expect((await db.posts.get(p.id))!.excerpt).toContain('original opening');

    await savePost(p.id, { content: doc('completely different prose now') });
    const after = (await db.posts.get(p.id))!;
    expect(after.excerpt).toContain('completely different');
    expect(after.excerpt).not.toContain('original opening');
  });

  it('an author-written excerpt is never overwritten', async () => {
    const p = await createPost();
    await savePost(p.id, { content: doc('first') });
    await savePost(p.id, { excerpt: 'My own summary' });
    await savePost(p.id, { content: doc('second, totally new') });
    const after = (await db.posts.get(p.id))!;
    expect(after.excerpt).toBe('My own summary');
    expect(after.excerptSource).toBe('author');
  });

  it('clearing the excerpt returns it to tracking the content', async () => {
    const p = await createPost({ content: doc('body words here') });
    await savePost(p.id, { excerpt: 'Mine' });
    const cleared = await savePost(p.id, { excerpt: '   ' });
    expect(cleared.excerptSource).toBe('derived');
    expect(cleared.excerpt).toBe(deriveExcerpt(cleared.content));
  });

  it('publishing does not resurrect a stale derived excerpt', async () => {
    const p = await createPost();
    await savePost(p.id, { content: doc('old opening') });
    await savePost(p.id, { content: doc('new opening entirely') });
    const pub = await publishPost(p.id);
    expect(pub.excerpt).toContain('new opening');
  });
});

describe('export/import is a complete round trip (blocking #3)', () => {
  it('carries posts, revisions and image bytes, and can be read back', async () => {
    const img = await seedImage();
    const p = await createPost({
      title: 'Round trip',
      content: withImage(img, 'body text'),
      coverImage: { blobId: img, alt: 'cover', focalPoint: '50% 25%', width: 4, height: 4 },
      tags: ['a', 'b'],
      category: 'Tech',
    });
    await savePost(p.id, { title: 'Round trip v2' });

    const bundle = await exportBundle();
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.images).toHaveLength(1);
    expect(bundle.revisions.length).toBeGreaterThan(1);

    // Simulate a different browser: wipe everything, then import.
    await db.posts.clear();
    await db.revisions.clear();
    await db.images.clear();

    const result = await importBundle(JSON.stringify(bundle));
    expect(result.posts).toBe(1);
    expect(result.images).toBe(1);

    const restored = (await db.posts.toArray())[0];
    expect(restored.title).toBe('Round trip v2');
    expect(restored.tags).toEqual(['a', 'b']);
    expect(restored.category).toBe('Tech');

    // The cover and the inline reference both point at a blob that exists.
    expect(await db.images.get(restored.coverImage!.blobId)).toBeDefined();
    const refs = JSON.stringify(restored.content).match(/idb:[a-z0-9_]+/gi) ?? [];
    expect(refs).toHaveLength(1);
    for (const ref of refs) {
      const rec = await db.images.get(ref.slice(IDB_SCHEME.length));
      expect(rec).toBeDefined();
      expect(rec!.blob.size).toBe(5);
    }
    expect(restored.coverImage!.alt).toBe('cover');
    expect(restored.coverImage!.focalPoint).toBe('50% 25%');
    // History came with it.
    expect(await db.revisions.where('postId').equals(restored.id).count()).toBeGreaterThan(1);
  });

  it('import is additive — it never overwrites existing work', async () => {
    const mine = await createPost({ title: 'Written since the export' });
    const bundle = await exportBundle();
    await importBundle(JSON.stringify(bundle));
    const all = await db.posts.toArray();
    expect(all).toHaveLength(2);
    expect(await db.posts.get(mine.id)).toBeDefined();
  });

  it('rejects files that are not Studio bundles', async () => {
    await expect(importBundle('not json at all')).rejects.toBeInstanceOf(ImportError);
    await expect(importBundle('{"format":"something/else"}')).rejects.toBeInstanceOf(
      ImportError,
    );
  });
});

describe('blank-draft sweep respects a grace period', () => {
  it('leaves a freshly created draft alone', async () => {
    const p = await createPost();
    expect(await sweepBlankDrafts()).toBe(0);
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('collects a blank draft that was abandoned long enough ago', async () => {
    const p = await createPost();
    await age(p.id, 120_000);
    expect(await sweepBlankDrafts()).toBe(1);
    expect(await db.posts.get(p.id)).toBeUndefined();
  });

  it('never collects the post currently open, however old', async () => {
    const p = await createPost();
    await age(p.id, 120_000);
    expect(await sweepBlankDrafts(p.id)).toBe(0);
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('never collects an old draft that has words in it', async () => {
    const p = await createPost({ content: doc('has content') });
    await age(p.id, 120_000);
    expect(await sweepBlankDrafts()).toBe(0);
  });
});

describe('lifecycle changes leave a history entry', () => {
  it('records publish, unpublish and archive with no revision gaps', async () => {
    const p = await createPost({ title: 'T', content: doc('x') });
    await publishPost(p.id);
    await unpublishPost(p.id);
    await archivePost(p.id);

    const revs = (await db.revisions.where('postId').equals(p.id).toArray()).sort(
      (a, b) => a.revision - b.revision,
    );
    const numbers = revs.map((r) => r.revision);
    // Every revision number the post passed through is accounted for.
    expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    expect(numbers[numbers.length - 1]).toBe((await db.posts.get(p.id))!.revision);
    expect(revs.filter((r) => r.kind === 'status').map((r) => r.note)).toEqual([
      'Moved back to drafts',
      'Archived',
    ]);
  });
});

/**
 * A new `Post` field has to land in four places — `shared/types.ts`,
 * `PostPatch`, `createDraftShape`, and the `backup.ts` import path — or it is
 * silently dropped. Import rebuilds every post through `createDraftShape`, so
 * that function is the one that actually decides, and this is the test that
 * notices.
 */
describe('per-post template override', () => {
  it('defaults to null — no opinion, follow the blog', async () => {
    const p = await createPost({ title: 'Plain' });
    expect(p.template).toBeNull();
  });

  it('is patchable through savePost, and clearable back to the default', async () => {
    const p = await createPost({ title: 'Essay' });
    const pinned = await savePost(p.id, { template: 'editorial' });
    expect(pinned.template).toBe('editorial');
    const cleared = await savePost(p.id, { template: null });
    expect(cleared.template).toBeNull();
  });

  it('survives an export → wipe → import round trip', async () => {
    const pinned = await createPost({ title: 'Full bleed', template: 'editorial' });
    const plain = await createPost({ title: 'Ordinary' });
    const bundle = JSON.stringify(await exportBundle());

    await db.posts.clear();
    await db.revisions.clear();
    await importBundle(bundle);

    const restored = await db.posts.toArray();
    const byTitle = (t: string) => restored.find((p) => p.title === t)!;
    // The override is the thing at risk; `null` staying `null` matters just as
    // much, because `undefined` would read as "no opinion" and then serialise
    // out of the next bundle entirely.
    expect(byTitle('Full bleed').template).toBe('editorial');
    expect(byTitle('Ordinary').template).toBeNull();
    expect(Object.hasOwn(byTitle('Ordinary'), 'template')).toBe(true);
    expect(pinned.template).toBe('editorial');
    expect(plain.template).toBeNull();
  });

  it('carries over when a post is duplicated', async () => {
    const p = await createPost({ title: 'Source', template: 'technical' });
    const copy = await duplicatePost(p.id);
    expect(copy.template).toBe('technical');
  });
});
