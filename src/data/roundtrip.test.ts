/**
 * Regression tests for the integration-gauntlet findings.
 *
 * WHAT MOVED TO THE SERVER AT THE CUTOVER. The excerpt rules, the
 * revision-per-lifecycle-change history and the blank-draft grace window were
 * all asserted here against Dexie transactions that no longer exist. Their
 * server-side equivalents run against a real database:
 * `server/repo/posts.test.ts`'s "keeps the excerpt rule: author text survives,
 * a derived one tracks the post", `server/repo/lifecycle.test.ts`'s "derives
 * the excerpt on publish but leaves an author-written one alone", "every
 * lifecycle change leaves a revision with no numbering gap", "destroys a blank
 * draft that is past the grace window" and "never sweeps a draft inside the
 * grace window, or the one being edited".
 *
 * The export/import round trip has now moved too. It stayed here through Task
 * 19 because `src/data/backup.ts` was still a Dexie reader/writer; Task 22
 * (plan §8.1) makes export a server route and import an upload, so the three
 * tests are re-pointed in `src/data/backup.test.ts` — see the note below for
 * which became what.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: {
    createPost: vi.fn(),
    savePost: vi.fn(),
    publishPost: vi.fn(),
  },
}));

import { api } from './api';
import { cachePost } from './cache';
import { db } from './db';
import { createDraftShape, publishPost, savePost, setActiveUser } from './posts';
import { docToText } from './doc';
import type { DocNode, Post } from './types';

const USER = 'u_writer';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let n = 0;
const post = (over: Partial<Post> = {}): Post =>
  createDraftShape({ id: `p_${(n += 1)}`, authorId: USER, ...over });

/** A post as the server would have handed it back, already in the cache. */
async function cached(over: Partial<Post> = {}): Promise<Post> {
  const p = post(over);
  await cachePost(USER, p);
  return p;
}

beforeEach(async () => {
  vi.resetAllMocks();
  setActiveUser(USER);
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('publishing does not strand the editor (blocking #1)', () => {
  it('the revision publish returns is the one the next save carries', async () => {
    const p = await cached({ title: 'T', content: doc('before') });
    vi.mocked(api.publishPost).mockResolvedValue({
      ...p,
      status: 'published',
      revision: p.revision + 1,
    });
    vi.mocked(api.savePost).mockImplementation(async (_id, patch, opts) => ({
      ...p,
      ...patch,
      revision: (opts?.baseRevision ?? 0) + 1,
    }));

    const published = await publishPost(p.id);
    // The lifecycle response was cached, so the live query behind the editor
    // is not a revision behind the write it is about to base itself on.
    expect((await db.posts.get(p.id))?.revision).toBe(published.revision);

    // Exactly what `Editor.tsx:285`'s `adopt` does with the return value.
    const next = await savePost(
      p.id,
      { content: doc('typed after publishing') },
      { baseRevision: published.revision },
    );

    expect(vi.mocked(api.savePost)).toHaveBeenCalledWith(
      p.id,
      { content: doc('typed after publishing') },
      { baseRevision: 2 },
    );
    expect(docToText(next.content)).toBe('typed after publishing');
    expect((await db.posts.get(p.id))?.revision).toBe(3);
  });
});

/**
 * WHERE THE EXPORT/IMPORT TESTS WENT, AND WHY THEY COULD NOT STAY HERE.
 *
 * Three tests lived at this point — "carries posts, revisions and image bytes,
 * and can be read back", "import is additive — it never overwrites existing
 * work", and "rejects files that are not Studio bundles" — and all three
 * asserted on Dexie because `src/data/backup.ts` read and wrote Dexie. Task 22
 * (plan §8.1) is the slice that changes that: export now comes from
 * `GET /api/export` or is rebuilt from `GET /posts`, and import goes through
 * `src/data/migrate.ts`'s upload pipeline rather than `bulkAdd`.
 *
 * They are re-pointed rather than deleted, in `src/data/backup.test.ts`:
 *
 * - the round trip → "carries the posts, their history and the image bytes"
 *   (the local corpus, which is the only bundle that still carries bytes) plus
 *   "rebuilds the same bundle from routes every writer already has";
 * - "import is additive" → "uploads the bundle instead of writing it into the
 *   cache". The additive rule moved to the server with the write:
 *   `server/routes/backup.ts` skips an id it already holds and reports it in
 *   `skipped`, so the client no longer decides it and can no longer test it;
 * - "rejects files that are not Studio bundles" → the `parseBundle` block, plus
 *   "rejects a file that is not a bundle before any request is made", which is
 *   the sharper version: a refused body still burns one of five hourly
 *   rate-limit slots (F8), so the refusal has to happen before the request.
 *
 * What stays here is what this file was always about: the write path, and the
 * fields that fall out of it.
 */

/**
 * A new `Post` field has to land in four places — `shared/types.ts`,
 * `PostPatch`, `createDraftShape`, and the `backup.ts` import path — or it is
 * silently dropped. The last of those is asserted in `backup.test.ts`'s
 * "carries a per-post template override onto the wire", which drives the same
 * `createDraftShape` through the new import.
 */
describe('per-post template override', () => {
  it('defaults to null — no opinion, follow the blog', () => {
    expect(createDraftShape({ title: 'Plain' }).template).toBeNull();
  });

  it('a cleared override goes on the wire as null rather than being dropped', async () => {
    const p = await cached({ title: 'Essay', template: 'editorial' });
    vi.mocked(api.savePost).mockResolvedValue({ ...p, template: null, revision: 2 });

    await savePost(p.id, { template: null });

    // `undefined` and `null` are different states on this field: one means "no
    // change", the other "follow the blog again". A patch that dropped the key
    // would leave the post pinned to Editorial forever.
    expect(vi.mocked(api.savePost)).toHaveBeenCalledWith(p.id, { template: null }, {});
    expect((await db.posts.get(p.id))?.template).toBeNull();
  });

  it('a pinned layout survives being cached and read back', async () => {
    await cached({ title: 'Full bleed', template: 'editorial' });
    await cached({ title: 'Ordinary' });

    const rows = await db.posts.toArray();
    const byTitle = (t: string) => rows.find((p) => p.title === t)!;
    // The override is the thing at risk; `null` staying `null` matters just as
    // much, because `undefined` would read as "no opinion" and then serialise
    // out of the next bundle entirely.
    expect(byTitle('Full bleed').template).toBe('editorial');
    expect(byTitle('Ordinary').template).toBeNull();
    expect(Object.hasOwn(byTitle('Ordinary'), 'template')).toBe(true);
  });
});
