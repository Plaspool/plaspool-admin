/**
 * Runtime cover for the two spec-mandated changes to `Post` (spec §3.4) that
 * `tsc` cannot see and that the existing 52 tests do not touch.
 *
 * Both were verified unpinned before this file existed: reverting
 * `slug: partial.slug ?? null` to `?? ''`, or deleting `authorId:
 * current.authorId` from `savePost`'s system-field re-apply, each left every
 * one of the 52 green. `slug: string | null` accepts `''`, so the compiler is
 * no help either.
 *
 * These live in their own file rather than in `posts.test.ts` so that suite —
 * the ported gauntlet regression set — stays byte-identical to its baseline.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { createDraftShape, createPost, duplicatePost, publishPost, savePost } from './posts';
import type { Post } from './types';

beforeEach(async () => {
  await db.posts.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('slug is NULL, never the empty string', () => {
  it('createDraftShape leaves an unset slug NULL', () => {
    // Why it matters: `slug` is a UNIQUE column server-side. A UNIQUE column
    // cannot hold twenty empty strings, but Postgres permits many NULLs — so
    // `''` here means the second untitled draft a writer creates is rejected by
    // the database. That is the whole reason spec §3.4 made the column
    // nullable.
    const draft = createDraftShape();
    expect(draft.slug).toBeNull();
    expect(draft.slug).not.toBe('');
  });

  it('two untitled drafts can coexist, both with a NULL slug', async () => {
    const a = await createPost();
    const b = await createPost();
    expect(a.slug).toBeNull();
    expect(b.slug).toBeNull();

    const stored = await db.posts.toArray();
    expect(stored).toHaveLength(2);
    for (const p of stored) {
      expect(p.slug).toBeNull();
      // The empty-string convention is what the nullable column replaced.
      expect(p.slug).not.toBe('');
    }
  });

  it('duplicatePost gives the copy a NULL slug, not its source’s', async () => {
    const src = await createPost({ title: 'Original' });
    const published = await publishPost(src.id);
    expect(published.slug).toBe('original');

    const copy = await duplicatePost(src.id);
    expect(copy.slug).toBeNull();
  });

  it('a slug is assigned on the first save with a title, and only then', async () => {
    const post = await createPost();
    const untouched = await savePost(post.id, { subtitle: 'still untitled' });
    expect(untouched.slug).toBeNull();

    const titled = await savePost(post.id, { title: 'Hello World' });
    expect(titled.slug).toBe('hello-world');
  });
});

describe('savePost re-applies every system field', () => {
  /**
   * The re-apply block exists because `{ ...current, ...patch }` lets any key
   * present on the patch object through. `PostPatch` does not declare these
   * keys, but the patch arrives as a JSON body on the server and as an
   * unchecked object here — the type is not the guard, the re-apply is.
   */
  const smuggle = {
    id: 'p_attacker',
    createdAt: 1,
    status: 'published',
    publishedAt: 1,
    deletedAt: 1,
    authorId: 'someone-else',
    authorName: 'Someone Else',
    revision: 999,
  } as unknown as Partial<Post>;

  it('authorId survives a patch that tries to change it', async () => {
    const post = await createPost({ title: 'Mine' });
    const saved = await savePost(post.id, { ...smuggle, title: 'Still mine' } as never);

    // Reassigning authorship is how a writer takes over another writer's post
    // once `author_id` decides who may edit it (spec §6, author-or-owner).
    expect(saved.authorId).toBe(post.authorId);
    expect(saved.authorId).not.toBe('someone-else');
    expect((await db.posts.get(post.id))!.authorId).toBe(post.authorId);
  });

  it('the rest of the system fields survive too', async () => {
    const post = await createPost({ title: 'Mine' });
    const saved = await savePost(post.id, { ...smuggle, title: 'Still mine' } as never);

    expect(saved.id).toBe(post.id);
    expect(saved.createdAt).toBe(post.createdAt);
    expect(saved.status).toBe(post.status);
    expect(saved.publishedAt).toBe(post.publishedAt);
    expect(saved.deletedAt).toBe(post.deletedAt);
    expect(saved.authorName).toBe(post.authorName);
    // Revision is derived from the stored row, never taken from the patch.
    expect(saved.revision).toBe(post.revision + 1);
    // The patched field did land — the re-apply is targeted, not a rejection.
    expect(saved.title).toBe('Still mine');
  });
});
