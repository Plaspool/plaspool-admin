/**
 * Regression tests for every issue a gauntlet critic found.
 * Each `it` names the failure it prevents from coming back.
 *
 * WHAT MOVED TO THE SERVER AT THE CUTOVER. This file used to own image
 * lifecycle (mark-and-sweep over `db.images`), publish atomicity and the
 * all-or-nothing empty-trash transaction. All three are server behaviour now
 * and are tested against a real database — `server/repo/images.test.ts`'s "the
 * reference walk" and "the two-phase quarantine" suites,
 * `server/repo/lifecycle.test.ts`'s `publishPost` and `emptyTrash` suites, and
 * `server/repo/revisions.test.ts`'s `pruneAutosaves`. Re-asserting any of them
 * against a mocked `api` would pin the mock, not the behaviour.
 *
 * What stays is the client-side half nothing on the server can cover: the two
 * guards on `discardIfBlank`, which is awaited inside a frozen file on the way
 * out of the editor.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: {
    createPost: vi.fn(),
    savePost: vi.fn(),
    destroyPost: vi.fn(),
    emptyTrash: vi.fn(),
    sweepBlankDrafts: vi.fn(),
    collectOrphanImages: vi.fn(),
  },
}));

import { api } from './api';
import { cachePost } from './cache';
import { db } from './db';
import { ApiError, ForbiddenError, OfflineError } from './errors';
import { createDraftShape, discardIfBlank, isBlankDraft, setActiveUser } from './posts';
import type { DocNode, Post } from './types';

const USER = 'u_writer';
const OTHER = 'u_colleague';

let n = 0;
const draft = (over: Partial<Post> = {}): Post =>
  createDraftShape({ id: `p_${(n += 1)}`, authorId: USER, ...over });

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

beforeEach(async () => {
  vi.resetAllMocks();
  setActiveUser(USER);
  vi.mocked(api.destroyPost).mockResolvedValue(undefined);
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.images.clear();
});

describe('blank drafts do not accumulate (critic UX note)', () => {
  it('discards a post opened and abandoned without any content', async () => {
    const p = draft();
    await cachePost(USER, p);

    expect(await discardIfBlank(p.id)).toBe(true);
    expect(vi.mocked(api.destroyPost)).toHaveBeenCalledWith(p.id);
    expect(await db.posts.get(p.id)).toBeUndefined();
  });

  it('never discards a draft that has anything in it', async () => {
    const rows = [
      draft({ title: 'A' }),
      draft({ content: para('hi') }),
      draft({ tags: ['x'] }),
      draft({ coverImage: { blobId: 'img_x', alt: '', focalPoint: '50% 50%', width: 1, height: 1 } }),
    ];
    for (const p of rows) await cachePost(USER, p);

    for (const p of rows) {
      expect(await discardIfBlank(p.id)).toBe(false);
      expect(await db.posts.get(p.id)).toBeDefined();
    }
    expect(vi.mocked(api.destroyPost)).not.toHaveBeenCalled();
  });

  it('never discards a published or archived post, even if empty', async () => {
    const pub = draft({ status: 'published', title: '' });
    const arch = draft({ status: 'archived', title: '' });
    await cachePost(USER, pub);
    await cachePost(USER, arch);

    expect(await discardIfBlank(pub.id)).toBe(false);
    expect(await discardIfBlank(arch.id)).toBe(false);
  });
});

/**
 * F7 and F10. `Editor.tsx:375–381` is frozen and reads
 * `await flush(); await discardIfBlank(id); navigate('/')`, so anything this
 * function throws is an unhandled rejection between the writer and the only
 * exit from the editor screen.
 */
describe('discardIfBlank can never strand the writer, and never guesses', () => {
  it('swallows the owner-only 403 and returns false', async () => {
    const p = draft();
    await cachePost(USER, p);
    // `DELETE /api/posts/:id` is `requireOwner()` (F7), so this is what EVERY
    // writer gets for EVERY blank draft they abandon.
    vi.mocked(api.destroyPost).mockRejectedValue(new ForbiddenError());

    await expect(discardIfBlank(p.id)).resolves.toBe(false);
    // The request was genuinely attempted — the fixture reaches the catch
    // rather than being turned away by an earlier guard.
    expect(vi.mocked(api.destroyPost)).toHaveBeenCalledWith(p.id);
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('swallows every other failure too — offline, 5xx, a 404 race', async () => {
    const failures = [
      new OfflineError(),
      new ApiError({ status: 503, code: 'unavailable' }),
      new ApiError({ status: 404, code: 'gone' }),
    ];
    for (const err of failures) {
      const p = draft();
      await cachePost(USER, p);
      vi.mocked(api.destroyPost).mockRejectedValueOnce(err);
      await expect(discardIfBlank(p.id)).resolves.toBe(false);
    }
    expect(vi.mocked(api.destroyPost)).toHaveBeenCalledTimes(failures.length);
  });

  it('REFUSES to act on a row whose document did not arrive (F10)', async () => {
    /*
     * `isBlankDoc(undefined)` is `true` — measured. So a cached row missing its
     * `content` reads as a blank draft on every other criterion and would be
     * destroyed: the post AND its whole server-side revision history, because
     * this device failed to hold a field. Writing the row past `cachePost`,
     * which refuses bodyless posts, is the only way to produce one — which is
     * exactly how a legacy or half-written row gets there.
     */
    const p = draft({ title: '', wordCount: 0 });
    await db.posts.put({ ...p, content: undefined as unknown as DocNode, ownerUserId: USER });

    await expect(discardIfBlank(p.id)).resolves.toBe(false);
    expect(vi.mocked(api.destroyPost)).not.toHaveBeenCalled();
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('refuses when there is no cached full row at all', async () => {
    // The editor can be opened offline against a `postList` row alone. "I could
    // not read this post" must not become "destroy this post".
    const p = draft();
    await db.postList.put({ ...p, ownerUserId: USER });

    await expect(discardIfBlank(p.id)).resolves.toBe(false);
    expect(vi.mocked(api.destroyPost)).not.toHaveBeenCalled();
  });

  it('refuses a row cached for a different user (I2)', async () => {
    const p = draft();
    await cachePost(OTHER, p);

    await expect(discardIfBlank(p.id)).resolves.toBe(false);
    expect(vi.mocked(api.destroyPost)).not.toHaveBeenCalled();
  });
});

describe('isBlankDraft carries the same refusal', () => {
  it('an unparseable document counts as content, not as emptiness', () => {
    const p = draft({ title: '', wordCount: 0 });
    expect(isBlankDraft(p)).toBe(true);
    expect(isBlankDraft({ ...p, content: undefined as unknown as DocNode })).toBe(false);
    expect(isBlankDraft({ ...p, content: '<p>hi</p>' as unknown as DocNode })).toBe(false);
  });

  it('an image-only or divider-only draft still has content despite zero words', () => {
    const imageOnly = draft({
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'asset:img_1' } }] },
      wordCount: 0,
    });
    expect(imageOnly.wordCount).toBe(0);
    expect(isBlankDraft(imageOnly)).toBe(false);
  });
});
