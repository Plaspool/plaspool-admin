import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  StaleWriteError,
  archivePost,
  createPost,
  destroyPost,
  duplicatePost,
  emptyTrash,
  filterAndSort,
  publishPost,
  restorePost,
  savePost,
  trashPost,
  unpublishPost,
  type Query,
} from './posts';
import { countWords, deriveExcerpt, docToText, isValidDoc, readingTime, slugify } from './doc';
import type { DocNode } from './types';

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

beforeEach(async () => {
  await db.posts.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('text derivation', () => {
  it('does not glue adjacent blocks together', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
      ],
    };
    expect(docToText(doc)).toBe('alpha beta');
    expect(countWords(docToText(doc))).toBe(2);
  });

  it('never reports a 0 minute read for non-empty posts', () => {
    expect(readingTime(1)).toBe(1);
    expect(readingTime(0)).toBe(0);
  });

  it('truncates excerpts on a word boundary', () => {
    const long = deriveExcerpt(para('word '.repeat(120)), 60);
    expect(long.length).toBeLessThanOrEqual(62);
    expect(long.endsWith('…')).toBe(true);
  });

  it('produces safe slugs from hostile titles', () => {
    expect(slugify('  Hello,   World!! ')).toBe('hello-world');
    expect(slugify('—///—')).toBe('untitled');
    expect(slugify('')).toBe('untitled');
    expect(slugify('a'.repeat(300)).length).toBeLessThanOrEqual(72);
  });

  it('rejects documents that are not real docs', () => {
    expect(isValidDoc(null)).toBe(false);
    expect(isValidDoc('<p>hi</p>')).toBe(false);
    expect(isValidDoc({ type: 'doc' })).toBe(false);
    expect(isValidDoc({ type: 'doc', content: [] })).toBe(true);
  });
});

describe('create and save', () => {
  it('creates an empty draft with sane defaults', async () => {
    const p = await createPost();
    expect(p.status).toBe('draft');
    expect(p.revision).toBe(1);
    expect(p.deletedAt).toBeNull();
    expect(isValidDoc(p.content)).toBe(true);
  });

  it('bumps revision and derives stats on every save', async () => {
    const p = await createPost();
    const a = await savePost(p.id, { content: para('one two three') });
    expect(a.revision).toBe(2);
    expect(a.wordCount).toBe(3);
    const b = await savePost(p.id, { title: 'Hello' });
    expect(b.revision).toBe(3);
    expect(b.slug).toBe('hello');
  });

  it('refuses an invalid document and keeps the last good content', async () => {
    const p = await createPost({ content: para('safe words') });
    await savePost(p.id, { content: 'not a doc' as unknown as DocNode });
    const after = await db.posts.get(p.id);
    expect(docToText(after!.content)).toBe('safe words');
  });

  it('never lets a patch smuggle in system fields', async () => {
    const p = await createPost();
    const bad = { title: 'x', status: 'published', id: 'hacked' } as never;
    const next = await savePost(p.id, bad);
    expect(next.id).toBe(p.id);
    expect(next.status).toBe('draft');
  });

  it('rejects a stale write instead of clobbering', async () => {
    const p = await createPost();
    await savePost(p.id, { title: 'first' });
    await expect(
      savePost(p.id, { title: 'second' }, { baseRevision: 1 }),
    ).rejects.toBeInstanceOf(StaleWriteError);
    const after = await db.posts.get(p.id);
    expect(after!.title).toBe('first');
  });

  it('survives rapid consecutive saves without losing the last one', async () => {
    const p = await createPost();
    for (let i = 0; i < 25; i++) await savePost(p.id, { title: `t${i}` });
    const after = await db.posts.get(p.id);
    expect(after!.title).toBe('t24');
    expect(after!.revision).toBe(26);
  });

  it('handles a very large document', async () => {
    const p = await createPost();
    const big: DocNode = {
      type: 'doc',
      content: Array.from({ length: 2000 }, () => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'lorem ipsum dolor sit amet' }],
      })),
    };
    const next = await savePost(p.id, { content: big });
    expect(next.wordCount).toBe(10000);
    expect(next.readingTime).toBeGreaterThan(1);
  });

  it('gives colliding titles distinct slugs', async () => {
    const a = await createPost();
    const b = await createPost();
    await savePost(a.id, { title: 'Same Name' });
    await savePost(b.id, { title: 'Same Name' });
    const [ra, rb] = [await db.posts.get(a.id), await db.posts.get(b.id)];
    expect(ra!.slug).toBe('same-name');
    expect(rb!.slug).toBe('same-name-2');
  });

  it('keeps an author-written excerpt instead of re-deriving it', async () => {
    const p = await createPost();
    await savePost(p.id, { excerpt: 'Mine' });
    const next = await savePost(p.id, { content: para('completely different text') });
    expect(next.excerpt).toBe('Mine');
  });
});

describe('lifecycle', () => {
  it('publishes, unpublishes and preserves the original publish date', async () => {
    const p = await createPost({ title: 'T', content: para('hello') });
    const pub = await publishPost(p.id);
    expect(pub.status).toBe('published');
    expect(pub.publishedAt).toBeTypeOf('number');
    const un = await unpublishPost(p.id);
    expect(un.status).toBe('draft');
    const re = await publishPost(p.id);
    expect(re.publishedAt).toBe(pub.publishedAt);
  });

  it('gives an untitled post a usable slug at publish time', async () => {
    const p = await createPost({ content: para('body only') });
    const pub = await publishPost(p.id);
    expect(pub.slug).toBeTruthy();
    expect(pub.excerpt).toBeTruthy();
  });

  it('trashes softly and restores fully', async () => {
    const p = await createPost({ title: 'Keep me', content: para('precious words') });
    await trashPost(p.id);
    const trashed = await db.posts.get(p.id);
    expect(trashed!.deletedAt).toBeTypeOf('number');
    expect(docToText(trashed!.content)).toBe('precious words');
    await restorePost(p.id);
    expect((await db.posts.get(p.id))!.deletedAt).toBeNull();
  });

  it('publishing a trashed post brings it back out of the trash', async () => {
    const p = await createPost({ title: 'T', content: para('x') });
    await trashPost(p.id);
    const pub = await publishPost(p.id);
    expect(pub.deletedAt).toBeNull();
  });

  it('destroy removes the post and its revisions', async () => {
    const p = await createPost({ title: 'Bye' });
    await savePost(p.id, { title: 'Bye 2' });
    await destroyPost(p.id);
    expect(await db.posts.get(p.id)).toBeUndefined();
    expect(await db.revisions.where('postId').equals(p.id).count()).toBe(0);
  });

  it('empties the trash without touching live posts', async () => {
    const live = await createPost({ title: 'Live' });
    const dead = await createPost({ title: 'Dead' });
    await trashPost(dead.id);
    const n = await emptyTrash();
    expect(n).toBe(1);
    expect(await db.posts.get(live.id)).toBeDefined();
    expect(await db.posts.get(dead.id)).toBeUndefined();
  });

  it('duplicates as an independent draft', async () => {
    const p = await createPost({ title: 'Orig', content: para('shared text') });
    await publishPost(p.id);
    const copy = await duplicatePost(p.id);
    expect(copy.id).not.toBe(p.id);
    expect(copy.status).toBe('draft');
    expect(copy.publishedAt).toBeNull();
    await savePost(copy.id, { content: para('changed') });
    expect(docToText((await db.posts.get(p.id))!.content)).toBe('shared text');
  });
});

describe('revision history', () => {
  it('records a snapshot per save and prunes only autosaves', async () => {
    const p = await createPost({ title: 'R' });
    for (let i = 0; i < 40; i++) await savePost(p.id, { title: `v${i}` }, { kind: 'autosave' });
    await savePost(p.id, { title: 'milestone' }, { kind: 'manual' });
    const revs = await db.revisions.where('postId').equals(p.id).toArray();
    expect(revs.filter((r) => r.kind === "autosave").length).toBeLessThanOrEqual(40);
    expect(revs.filter((r) => r.kind === 'manual').length).toBe(2); // create + milestone
  });
});

describe('filter and sort', () => {
  const base: Query = {
    status: 'all',
    search: '',
    category: null,
    tag: null,
    sort: 'updated',
  };

  it('hides trashed posts from every non-trash view', async () => {
    const a = await createPost({ title: 'Visible' });
    const b = await createPost({ title: 'Gone' });
    await trashPost(b.id);
    const all = await db.posts.toArray();
    expect(filterAndSort(all, base).map((p) => p.id)).toEqual([a.id]);
    expect(filterAndSort(all, { ...base, status: 'trash' }).map((p) => p.id)).toEqual([
      b.id,
    ]);
  });

  it('searches title, tags and body', async () => {
    const p = await createPost({ title: 'Alpha', tags: ['gardening'] });
    await savePost(p.id, { content: para('a needle in the haystack') });
    const all = await db.posts.toArray();
    for (const term of ['alpha', 'GARDENING', 'needle']) {
      expect(filterAndSort(all, { ...base, search: term })).toHaveLength(1);
    }
    expect(filterAndSort(all, { ...base, search: 'nonsense' })).toHaveLength(0);
  });

  it('sorts alphabetically with untitled posts included', async () => {
    await createPost({ title: 'Zebra' });
    await createPost({ title: '' });
    await createPost({ title: 'apple' });
    const all = await db.posts.toArray();
    const titles = filterAndSort(all, { ...base, sort: 'alphabetical' }).map(
      (p) => p.title || 'Untitled',
    );
    expect(titles).toEqual(['apple', 'Untitled', 'Zebra']);
  });

  it('puts drafts before published under drafts-first', async () => {
    const pub = await createPost({ title: 'Pub', content: para('x') });
    await publishPost(pub.id);
    const draft = await createPost({ title: 'Draft' });
    const arch = await createPost({ title: 'Arch' });
    await archivePost(arch.id);
    const all = await db.posts.toArray();
    const order = filterAndSort(all, { ...base, sort: 'drafts-first' }).map((p) => p.id);
    expect(order).toEqual([draft.id, pub.id, arch.id]);
  });

  it('sorts posts that were never published without crashing', async () => {
    await createPost({ title: 'A' });
    const b = await createPost({ title: 'B', content: para('x') });
    await publishPost(b.id);
    const all = await db.posts.toArray();
    expect(filterAndSort(all, { ...base, sort: 'published' })[0].id).toBe(b.id);
  });
});
