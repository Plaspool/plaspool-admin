/**
 * Runtime cover for the two spec-mandated changes to `Post` (spec §3.4) that
 * `tsc` cannot see.
 *
 * WHERE HALF OF THIS FILE WENT. Slug assignment and the system-field re-apply
 * were `savePost`'s job when `savePost` was a Dexie transaction. They are the
 * server's now and are tested against a real database in
 * `server/repo/posts.test.ts` — "normalises an empty slug to NULL so two
 * untitled drafts can coexist", "assigns a slug on the first save that has a
 * title", "leaves an untitled draft unslugged" and "never lets a patch smuggle
 * in system fields" — plus `server/routes/posts.test.ts`'s "refuses a system
 * field rather than ignoring it" and `server/repo/lifecycle.test.ts`'s
 * "copies content and metadata into a fresh unpublished draft", which pins the
 * duplicate's NULL slug.
 *
 * What is left is the two things that are still decided in this browser:
 * `createDraftShape`, which `backup.ts` rebuilds every imported post through,
 * and the allow-list that decides what a `Partial<Post>` may put on the wire.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: { createPost: vi.fn(), savePost: vi.fn() },
}));

import { api } from './api';
import { db } from './db';
import { createDraftShape, createPost, setActiveUser } from './posts';
import type { DocNode, Post } from './types';

const USER = 'u_writer';

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

beforeEach(async () => {
  vi.resetAllMocks();
  setActiveUser(USER);
  vi.mocked(api.createPost).mockImplementation(async (patch) =>
    createDraftShape({ id: 'p_server', authorId: USER, authorName: 'A Writer', ...patch }),
  );
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('slug is NULL, never the empty string', () => {
  it('createDraftShape leaves an unset slug NULL', () => {
    // Why it matters: `slug` is a UNIQUE column server-side. A UNIQUE column
    // cannot hold twenty empty strings, but Postgres permits many NULLs — so
    // `''` here means the second untitled draft a writer creates is rejected by
    // the database. That is the whole reason spec §3.4 made the column
    // nullable, and `backup.ts` rebuilds every imported post through this
    // function, so `''` would arrive on the server one import later.
    const draft = createDraftShape();
    expect(draft.slug).toBeNull();
    expect(draft.slug).not.toBe('');
  });

  it('a draft rebuilt from a bundle keeps every field it was given', () => {
    const source: Partial<Post> = {
      title: 'Imported',
      subtitle: 'sub',
      category: 'essays',
      tags: ['a'],
      template: 'technical',
      excerpt: 'written by hand',
      content: para('body'),
    };
    const rebuilt = createDraftShape(source);
    expect(rebuilt).toMatchObject(source);
    // An author-written excerpt has to stay author-written, or the first save
    // after an import silently replaces it with a derivation.
    expect(rebuilt.excerptSource).toBe('author');
  });
});

describe('what a Partial<Post> may put on the wire', () => {
  /**
   * The allow-list exists because `{ ...partial }` lets any key through, and
   * `POST /api/posts` validates its body with a `.strict()` Zod schema: an
   * unknown key is a **400**, not an ignored field. `Editor.tsx:517`'s "Save as
   * a new post" hands a `Partial<Post>`, and a row from the pre-backend
   * `localPosts` store carries `migratedAt` on top of that — the measured
   * `unrecognized_keys` case in plan §6.4 step 0.
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
    migratedAt: null,
  } as unknown as Partial<Post>;

  it('sends the patchable keys and nothing else', async () => {
    await createPost({ ...smuggle, title: 'Mine', content: para('rescued') });

    expect(vi.mocked(api.createPost)).toHaveBeenCalledWith({
      title: 'Mine',
      content: para('rescued'),
    });
    const [[body]] = vi.mocked(api.createPost).mock.calls;
    for (const key of Object.keys(smuggle)) {
      expect(Object.hasOwn(body!, key)).toBe(false);
    }
  });

  it('an explicit null still crosses — absent and null are different states', async () => {
    await createPost({ coverImage: null, template: null, tags: [] });
    expect(vi.mocked(api.createPost)).toHaveBeenCalledWith({
      coverImage: null,
      template: null,
      tags: [],
    });
  });

  it('caches what the server answered, not what was asked for', async () => {
    const created = await createPost({ title: 'Mine' });
    // The server owns authorship, the revision and the id; the cached row has
    // to be its answer or the editor hydrates from a document nobody stored.
    expect(created.authorId).toBe(USER);
    expect((await db.posts.get('p_server'))?.authorId).toBe(USER);
  });
});
