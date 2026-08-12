import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './db';
import { api } from './api';
import { ApiError } from './errors';
import {
  ImageError,
  acquireImageURL,
  prepareForUpload,
  releaseImageURL,
  storeImageFile,
} from './images';
import { imageIdFromSrc } from './doc';
import { isStorableImageSrc } from '../../shared/validate';
import {
  batchPosts,
  canRetireLocalCopies,
  checkUploadable,
  imageIdsOf,
  importForeignBundle,
  migrateLocalPosts,
  retireLocalCopies,
  rewriteDoc,
  surveyLocalPosts,
  toBundlePost,
} from './migrate';
import { BundlePost } from '../../shared/bundle';
import type { LocalPost } from './db';
import type { Bundle, DocNode, Post, Revision, StoredImage } from './types';

/**
 * Migration (plan §6.4), and the image path it depends on.
 *
 * NOTHING HERE TALKS TO A SERVER. Every `api.*` call is a spy on the real
 * exported object and the one raw `fetch` — the presigned PUT to object
 * storage — is stubbed. R2 credentials were not supplied for this work, so a
 * real upload is unverifiable and is not claimed: what these tests pin is the
 * ORDER of the calls, the exact bytes and headers handed to each one, and what
 * the local stores look like afterwards.
 *
 * WHY THE IMAGE FIXTURES ARE ALL GIFs. `prepareForUpload` re-encodes every
 * non-GIF through a canvas, and neither node nor jsdom has a canvas encoder, so
 * the re-encode itself cannot run in any environment this repo tests in — it is
 * a browser-only path and is recorded as unverified rather than faked. GIF is
 * the one type the function deliberately passes through untouched (a canvas
 * holds one frame, so re-encoding destroys the animation), which means a GIF
 * fixture exercises the REAL function rather than a stubbed one. The refusal
 * arm — a non-GIF in an environment that cannot re-encode must fail rather than
 * upload EXIF-bearing bytes — is asserted directly below.
 *
 * `src/data/images.ts` has no suite of its own in this slice, so the three
 * assertions that belong to it are at the bottom of this file.
 */

const USER = 'u_alice';

const doc = (...nodes: DocNode[]): DocNode => ({
  type: 'doc',
  content: nodes.length ? nodes : [{ type: 'paragraph', content: [{ type: 'text', text: 'words' }] }],
});

const image = (src: string): DocNode => ({ type: 'image', attrs: { src, alt: '', title: '' } });

function post(over: Partial<Post> = {}): Post {
  return {
    id: 'p_1',
    title: 'A post',
    subtitle: '',
    slug: null,
    excerpt: 'an excerpt',
    excerptSource: 'derived',
    content: doc(),
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 2,
    publishedAt: null,
    deletedAt: null,
    wordCount: 1,
    readingTime: 1,
    authorId: '',
    authorName: '',
    revision: 3,
    ...over,
  };
}

const local = (over: Partial<Post> = {}, migratedAt: number | null = null): LocalPost => ({
  ...post(over),
  migratedAt,
});

/** A one-byte "GIF". The bytes never reach a decoder — see the header note. */
function gif(id: string): StoredImage {
  return {
    id,
    blob: new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: 'image/gif' }),
    width: 10,
    height: 8,
    type: 'image/gif',
    createdAt: 1,
  };
}

/** The server post `GET /posts/:id` answers with after an import. */
const serverPost = (id: string): Post =>
  post({ id, authorId: USER, authorName: 'Alice', revision: 1, content: doc() });

let slotSeq = 0;
let putCalls: { url: string; headers: unknown; body: unknown }[] = [];

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.localPosts.clear(),
    db.localRevisions.clear(),
    db.images.clear(),
    db.assetMap.clear(),
    db.posts.clear(),
    db.postList.clear(),
    db.revisions.clear(),
  ]);
  slotSeq = 0;
  putCalls = [];

  // A decoder that reports a size and nothing else. `prepareForUpload` closes
  // it; the GIF arm never draws from it.
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 10, height: 8, close: () => {} })),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      putCalls.push({ url, headers: init?.headers, body: init?.body });
      return { ok: true, status: 200 } as Response;
    }),
  );

  vi.spyOn(api, 'createImageSlot').mockImplementation(async () => {
    slotSeq += 1;
    return {
      id: `img_server${slotSeq}`,
      uploadUrl: `https://r2.example.com/put/${slotSeq}?sig=abc`,
      headers: { 'content-type': 'image/gif', 'content-length': '3' },
      expiresIn: 300,
    };
  });
  vi.spyOn(api, 'commitImage').mockImplementation(async (id: string) => ({
    id,
    contentType: 'image/gif',
    width: 10,
    height: 8,
    byteSize: 3,
    createdAt: 1,
    committedAt: 2,
  }));
  vi.spyOn(api, 'importBundle').mockResolvedValue({
    imported: 1,
    skipped: 0,
    ignored: { revisions: 0, images: 0 },
  });
  vi.spyOn(api, 'getPost').mockImplementation(async (id: string) => serverPost(id));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The `posts` array of the nth `POST /import` body. */
function sentPosts(call = 0): Record<string, unknown>[] {
  const body = vi.mocked(api.importBundle).mock.calls[call]?.[0] as { posts: unknown[] };
  return (body?.posts ?? []) as Record<string, unknown>[];
}

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({ status, code, body: {}, ...extra });

/**
 * The `src` of the image node at `index`. A helper rather than a chain of casts
 * at every call site: `(doc.content?.[0].attrs as { src: string }).src` throws a
 * TypeError when the shape is wrong, which reports as a crash a long way from
 * the assertion that meant to catch it.
 */
function srcAt(node: DocNode | undefined, index: number): string {
  const child = node?.content?.[index];
  const attrs = child?.attrs as { src?: unknown } | undefined;
  return typeof attrs?.src === 'string' ? attrs.src : `<no src at [${index}]>`;
}

// ============================================================ step 0

describe('step 0 — validating with the server’s own schema before uploading', () => {
  it('excludes a document the server would refuse, and uploads none of its images', async () => {
    /*
     * THE BAD POST CARRIES A REAL LOCAL IMAGE OF ITS OWN, and that is what
     * makes this test about step 0 rather than about exclusion in general.
     * With only the hostile src on it there is nothing of the bad post to
     * upload, so deleting the step-0 check entirely left every assertion here
     * green — the rewrite-time re-check caught the post a moment later and the
     * report looked identical. Verified by mutation: remove the check in the
     * step-0 loop and `img_bad` is uploaded before anyone notices, which is a
     * burned `IMAGE_SLOT_LIMIT` slot and a committed object for a post that can
     * never be sent.
     */
    await db.images.bulkPut([gif('img_good'), gif('img_bad')]);
    await db.localPosts.bulkPut([
      local({
        id: 'p_bad',
        title: 'Bad',
        updatedAt: 20,
        content: doc(image('idb:img_bad'), image('javascript:alert(1)')),
      }),
      local({ id: 'p_ok', title: 'Good', updatedAt: 10, content: doc(image('idb:img_good')) }),
    ]);

    const report = await migrateLocalPosts(USER);

    expect(report.excluded).toEqual([
      { id: 'p_bad', title: 'Bad', reason: 'bad_protocol', path: 'content[1]' },
    ]);
    expect(report.confirmed).toEqual(['p_ok']);
    // The bad post's document never reached a batch, so the batch did not die
    // with it — `server/routes/backup.ts` throws on the first offender.
    expect(sentPosts().map((p) => p.id)).toEqual(['p_ok']);
    // One slot, and it is the good post's. `img_bad` was never uploaded and
    // `assetMap` never learned about it.
    expect(vi.mocked(api.createImageSlot)).toHaveBeenCalledTimes(1);
    expect(await db.assetMap.get('img_bad')).toBeUndefined();
    expect(await db.assetMap.get('img_good')).toBeTruthy();
  });

  it('excludes a post whose title is past the tsvector ceiling', async () => {
    await db.localPosts.put(local({ id: 'p_big', title: 'x'.repeat(3000) }));

    const report = await migrateLocalPosts(USER);

    expect(report.excluded[0]).toMatchObject({ id: 'p_big', reason: 'too_large', path: 'title' });
    expect(vi.mocked(api.importBundle)).not.toHaveBeenCalled();
  });

  it('builds the body from an allow-list, so migratedAt never reaches the wire', async () => {
    /*
     * THE MEASURED 400. A `localPosts` row is a `Post` plus `migratedAt`,
     * `BundlePost` is `.strict()`, and spreading the row produced
     * `unrecognized_keys: ['migratedAt']` — a 400 that burns one of the five
     * import slots the hour allows, because `limit()` runs before `readJson`.
     * This asserts both halves: that the schema really does refuse the spread
     * row, and that what this module builds is not it.
     */
    const row = local({ id: 'p_1' });
    expect(BundlePost.safeParse({ ...row }).success).toBe(false);

    await db.localPosts.put(row);
    await migrateLocalPosts(USER);

    const sent = sentPosts()[0];
    expect(sent).not.toHaveProperty('migratedAt');
    expect(BundlePost.safeParse(sent).success).toBe(true);
    // The five fields the route declares and deliberately ignores are not sent
    // either — payload against the 1.5 MB bound in exchange for nothing.
    for (const field of ['authorId', 'authorName', 'revision', 'wordCount', 'readingTime']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });

  it('excludes a duplicated id rather than letting it 400 the batch', async () => {
    const bundle: Bundle = {
      format: 'publishing-studio/v2',
      exportedAt: '',
      posts: [post({ id: 'p_dup' }), post({ id: 'p_dup', title: 'Second' })],
      revisions: [],
      images: [],
    };

    const report = await importForeignBundle(USER, bundle);

    expect(report.excluded).toEqual([{ id: 'p_dup', title: 'Second', reason: 'duplicate_id' }]);
    expect(sentPosts().map((p) => p.id)).toEqual(['p_dup']);
  });

  it('checkUploadable answers null for a post the server would take', () => {
    const p = post({ content: doc(image('asset:img_meyc0k9x8f2a1b3c'), image('http://x/y.png')) });
    expect(checkUploadable(p, p.content)).toBeNull();
  });
});

// ============================================================ images

describe('images — one upload per blob, and never twice', () => {
  it('uploads each referenced blob once and records localId→assetId', async () => {
    await db.images.bulkPut([gif('img_a'), gif('img_b')]);
    await db.localPosts.put(
      local({
        id: 'p_1',
        content: doc(image('idb:img_a'), image('idb:img_a'), image('idb:img_b')),
      }),
    );

    const report = await migrateLocalPosts(USER);

    expect(report.images).toEqual({ uploaded: 2, reused: 0, missing: 0, failed: 0 });
    expect(await db.assetMap.get('img_a')).toEqual({ localId: 'img_a', assetId: 'img_server1' });
    // Slot → PUT → commit, in that order, once per distinct blob.
    expect(vi.mocked(api.createImageSlot)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.commitImage)).toHaveBeenCalledTimes(2);
    expect(putCalls).toHaveLength(2);
  });

  it('skips an image already in assetMap, so a resumed run burns no slot', async () => {
    /*
     * `IMAGE_SLOT_LIMIT` is 120 per hour. Without this skip a library that
     * takes three runs re-uploads every picture three times and never gets
     * past the limiter — which is why the mapping is written the moment the
     * commit succeeds rather than at the end of the run.
     */
    await db.images.put(gif('img_a'));
    await db.assetMap.put({ localId: 'img_a', assetId: 'img_alreadythere' });
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_a')) }));

    const report = await migrateLocalPosts(USER);

    expect(vi.mocked(api.createImageSlot)).not.toHaveBeenCalled();
    expect(putCalls).toHaveLength(0);
    expect(report.images).toEqual({ uploaded: 0, reused: 1, missing: 0, failed: 0 });
    // And the rewrite used the remembered id, not a fresh one.
    expect(srcAt(sentPosts()[0].content as DocNode, 0)).toBe('asset:img_alreadythere');
  });

  it('leaves a src alone when the blob is gone, rather than dropping the picture', async () => {
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_vanished')) }));

    const report = await migrateLocalPosts(USER);

    expect(report.images.missing).toBe(1);
    expect(report.confirmed).toEqual(['p_1']);
    expect(srcAt(sentPosts()[0].content as DocNode, 0)).toBe('idb:img_vanished');
  });

  it('rewrites the cover’s blobId in place, with no scheme on it', async () => {
    await db.images.put(gif('img_cover'));
    await db.localPosts.put(
      local({
        id: 'p_1',
        coverImage: { blobId: 'img_cover', alt: 'a', focalPoint: '50% 50%', width: 4, height: 3 },
      }),
    );

    await migrateLocalPosts(USER);

    // Bare, because the server's orphan sweep reads `cover_image->>'blobId'`
    // and `acquireImageURL` takes a bare id.
    expect(sentPosts()[0].coverImage).toEqual({
      blobId: 'img_server1',
      alt: 'a',
      focalPoint: '50% 50%',
      width: 4,
      height: 3,
    });
  });

  it('stops the whole run on an image 429 and reports retryAfter', async () => {
    await db.images.put(gif('img_a'));
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_a')) }));
    vi.mocked(api.createImageSlot).mockRejectedValue(
      apiError(429, 'rate_limited', { retryAfter: 1800 }),
    );

    const report = await migrateLocalPosts(USER);

    expect(report.stoppedBy).toEqual({
      reason: 'rate_limited',
      retryAfter: 1800,
      detail: expect.any(String),
    });
    expect(report.confirmed).toEqual([]);
    expect(vi.mocked(api.importBundle)).not.toHaveBeenCalled();
  });

  it('sends the posts whose pictures already landed before an image 429', async () => {
    await db.images.bulkPut([gif('img_a'), gif('img_b')]);
    await db.localPosts.bulkPut([
      local({ id: 'p_first', updatedAt: 20, content: doc(image('idb:img_a')) }),
      local({ id: 'p_second', updatedAt: 10, content: doc(image('idb:img_b')) }),
    ]);
    vi.mocked(api.createImageSlot).mockImplementationOnce(async () => ({
      id: 'img_server1',
      uploadUrl: 'https://r2.example.com/put/1',
      headers: {},
      expiresIn: 300,
    }));
    vi.mocked(api.createImageSlot).mockRejectedValue(apiError(429, 'rate_limited'));

    const report = await migrateLocalPosts(USER);

    // One import slot buys up to twenty-five posts; throwing away the ones
    // already prepared would make a rate-limited run pure loss.
    expect(report.confirmed).toEqual(['p_first']);
    expect(report.stoppedBy?.reason).toBe('rate_limited');
    expect((await db.localPosts.get('p_second'))?.migratedAt).toBeNull();
  });
});

// ============================================================ the rewrite

describe('the rewrite happens in memory', () => {
  it('never rewrites localPosts: the stored row still points at the local blob', async () => {
    /*
     * THE RULE THIS SUITE EXISTS FOR. `localPosts` is the only copy of a
     * pre-backend post. If migration rewrote it to `asset:` ids and then
     * anything after that failed — the batch, the confirmation, the tab
     * closing — the only copy would point at bytes that were never committed,
     * and the pictures would be unreachable from either side.
     */
    await db.images.put(gif('img_a'));
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_a')) }));

    await migrateLocalPosts(USER);

    const stored = await db.localPosts.get('p_1');
    expect(srcAt(stored?.content, 0)).toBe('idb:img_a');
    // The blob is still here too — migration deletes nothing.
    expect(await db.images.get('img_a')).toBeTruthy();
    // What went to the server is the rewritten copy.
    expect(srcAt(sentPosts()[0].content as DocNode, 0)).toBe('asset:img_server1');
    // …and only now is the row stamped.
    expect(stored?.migratedAt).toEqual(expect.any(Number));
  });

  it('does not stamp a post the confirmation read cannot find', async () => {
    await db.localPosts.put(local({ id: 'p_1' }));
    vi.mocked(api.getPost).mockRejectedValue(apiError(404, 'gone'));

    const report = await migrateLocalPosts(USER);

    expect(report.confirmed).toEqual([]);
    expect(report.failed).toEqual([
      { id: 'p_1', title: 'A post', detail: expect.stringContaining('not there') },
    ]);
    expect((await db.localPosts.get('p_1'))?.migratedAt).toBeNull();
  });

  it('caches the confirmed post where the frozen editor reads it', async () => {
    await db.localPosts.put(local({ id: 'p_1' }));
    await migrateLocalPosts(USER);
    const cached = await db.posts.get('p_1');
    expect(cached?.ownerUserId).toBe(USER);
    expect(cached?.content).toBeTruthy();
  });

  it('rewriteDoc leaves an unmapped id and every other node untouched', () => {
    const before = doc(image('idb:img_a'), image('idb:img_b'), {
      type: 'paragraph',
      content: [{ type: 'text', text: 'kept' }],
    });
    const after = rewriteDoc(before, new Map([['img_a', 'img_server1']]));

    expect(srcAt(after, 0)).toBe('asset:img_server1');
    expect(srcAt(after, 1)).toBe('idb:img_b');
    expect(after.content?.[2]).toEqual(before.content?.[2]);
    // The input is not mutated — the store row and the wire copy are separate
    // objects, which is the whole point.
    expect(srcAt(before, 0)).toBe('idb:img_a');
  });

  it('imageIdsOf finds both schemes and the cover, and de-duplicates', () => {
    const p = post({
      content: doc(image('idb:img_a'), image('asset:img_b'), image('https://x/y.png'), image('idb:img_a')),
      coverImage: { blobId: 'img_c', alt: '', focalPoint: '', width: 1, height: 1 },
    });
    expect(imageIdsOf(p)).toEqual(['img_a', 'img_b', 'img_c']);
  });
});

// ============================================================ batching

describe('batching and the split', () => {
  it('batches at 25 posts', async () => {
    await db.localPosts.bulkPut(
      Array.from({ length: 26 }, (_, i) => local({ id: `p_${i}`, updatedAt: 100 - i })),
    );

    await migrateLocalPosts(USER);

    expect(vi.mocked(api.importBundle)).toHaveBeenCalledTimes(2);
    expect(sentPosts(0)).toHaveLength(25);
    expect(sentPosts(1)).toHaveLength(1);
  });

  it('batchPosts closes a batch on the byte bound before the count bound', () => {
    // 800 KB each: two fit under 1.5 MB, three do not.
    const big = (id: string) => toBundlePost(post({ id, excerpt: 'x'.repeat(800_000) }), doc());
    expect(batchPosts([big('a'), big('b'), big('c')]).map((b) => b.length)).toEqual([1, 1, 1]);
    // A single post over the bound still goes, alone — `MAX_DOC_BYTES` is 2 MB
    // and refusing it here would invent a limit the server does not have.
    expect(batchPosts([big('a')])).toHaveLength(1);
  });

  it('splits the batch down to the one post a 422 belongs to', async () => {
    /*
     * A 422 here is by definition something step 0 did not predict, and the
     * route throws on the FIRST offender — so without the split one surprise
     * takes the other twenty-four posts with it. The cost is rate-limit slots,
     * because `limit()` runs before `readJson` and a refused body still burns
     * one (F8), which is why this is the fallback and step 0 is the mechanism.
     */
    await db.localPosts.bulkPut([
      local({ id: 'p_1', updatedAt: 40 }),
      local({ id: 'p_2', updatedAt: 30 }),
      local({ id: 'p_3', updatedAt: 20 }),
      local({ id: 'p_poison', title: 'Poison', updatedAt: 10 }),
    ]);
    vi.mocked(api.importBundle).mockImplementation(async (body: unknown) => {
      const ids = ((body as { posts: { id: string }[] }).posts ?? []).map((p) => p.id);
      if (ids.includes('p_poison')) throw apiError(422, 'invalid_document', { detail: 'content[7]' });
      return { imported: ids.length, skipped: 0, ignored: { revisions: 0, images: 0 } };
    });

    const report = await migrateLocalPosts(USER);

    expect(report.confirmed).toEqual(['p_1', 'p_2', 'p_3']);
    expect(report.failed).toEqual([{ id: 'p_poison', title: 'Poison', detail: 'content[7]' }]);
    // [1,2,3,poison] → [1,2] → [3,poison] → [3] → [poison]: five requests, and
    // the four that were refused each cost a slot.
    expect(vi.mocked(api.importBundle)).toHaveBeenCalledTimes(5);
    expect((await db.localPosts.get('p_poison'))?.migratedAt).toBeNull();
    expect((await db.localPosts.get('p_1'))?.migratedAt).toEqual(expect.any(Number));
  });

  it('splits on a 400 as well as a 422', async () => {
    await db.localPosts.bulkPut([
      local({ id: 'p_1', updatedAt: 20 }),
      local({ id: 'p_bad', title: 'B', updatedAt: 10 }),
    ]);
    vi.mocked(api.importBundle).mockImplementation(async (body: unknown) => {
      const ids = ((body as { posts: { id: string }[] }).posts ?? []).map((p) => p.id);
      if (ids.includes('p_bad')) throw apiError(400, 'bad_request', { detail: 'posts.id' });
      return { imported: ids.length, skipped: 0, ignored: { revisions: 0, images: 0 } };
    });

    const report = await migrateLocalPosts(USER);

    expect(report.confirmed).toEqual(['p_1']);
    expect(report.failed).toEqual([{ id: 'p_bad', title: 'B', detail: 'posts.id' }]);
  });

  it('stops on an import 429 without splitting, and keeps the retryAfter', async () => {
    await db.localPosts.bulkPut([local({ id: 'p_1', updatedAt: 20 }), local({ id: 'p_2', updatedAt: 10 })]);
    vi.mocked(api.importBundle).mockRejectedValue(apiError(429, 'rate_limited', { retryAfter: 900 }));

    const report = await migrateLocalPosts(USER);

    expect(report.stoppedBy).toMatchObject({ reason: 'rate_limited', retryAfter: 900 });
    // One request, not three: splitting a rate-limited batch spends the rest of
    // the budget proving the same thing.
    expect(vi.mocked(api.importBundle)).toHaveBeenCalledTimes(1);
    expect(report.confirmed).toEqual([]);
  });

  it('stops and reports offline when the request never got an answer', async () => {
    await db.localPosts.put(local({ id: 'p_1' }));
    vi.mocked(api.importBundle).mockRejectedValue(apiError(0, 'offline'));

    const report = await migrateLocalPosts(USER);
    expect(report.stoppedBy?.reason).toBe('offline');
  });

  it('a second run skips what is already stamped', async () => {
    await db.localPosts.bulkPut([
      local({ id: 'p_done', updatedAt: 20 }, 111),
      local({ id: 'p_todo', updatedAt: 10 }),
    ]);

    const report = await migrateLocalPosts(USER);

    expect(report.confirmed).toEqual(['p_todo']);
    expect(sentPosts().map((p) => p.id)).toEqual(['p_todo']);
    expect((await db.localPosts.get('p_done'))?.migratedAt).toBe(111);
  });
});

// ============================================================ the survey

describe('surveyLocalPosts — what the screen shows before the button', () => {
  it('separates pending, migrated and excluded, and counts images and revisions', async () => {
    await db.images.put(gif('img_a'));
    await db.localPosts.bulkPut([
      local({ id: 'p_1', updatedAt: 30, content: doc(image('idb:img_a')) }),
      local({ id: 'p_2', updatedAt: 20 }, 999),
      local({ id: 'p_bad', updatedAt: 10, content: doc(image('data:image/png;base64,AA')) }),
    ]);
    await db.localRevisions.bulkPut([
      { id: 'r_1', postId: 'p_1', revision: 1, createdAt: 1, content: doc(), kind: 'autosave' },
      { id: 'r_2', postId: 'p_1', revision: 2, createdAt: 2, content: doc(), kind: 'autosave' },
    ] as Revision[]);

    const survey = await surveyLocalPosts();

    expect(survey.pending.map((p) => p.id)).toEqual(['p_1']);
    expect(survey.migrated.map((p) => p.id)).toEqual(['p_2']);
    expect(survey.excluded.map((p) => p.id)).toEqual(['p_bad']);
    expect(survey.imageCount).toBe(1);
    // F4: history is not carried, and the number is shown rather than implied.
    expect(survey.revisionCount).toBe(2);
  });

  it('makes no request at all', async () => {
    await db.localPosts.put(local({ id: 'p_1' }));
    await surveyLocalPosts();
    expect(vi.mocked(api.importBundle)).not.toHaveBeenCalled();
    expect(vi.mocked(api.createImageSlot)).not.toHaveBeenCalled();
  });
});

// ============================================================ foreign bundles

describe('a foreign bundle’s images', () => {
  it('decodes base64, uploads it, and rewrites the document to the asset id', async () => {
    /*
     * `POST /import` restores no image bytes — it counts them in `ignored` —
     * so handing a bundle straight to the route drops every picture in it.
     */
    const bundle: Bundle = {
      format: 'publishing-studio/v2',
      exportedAt: '',
      posts: [post({ id: 'p_1', content: doc(image('idb:img_foreign')) })],
      revisions: [],
      images: [{ id: 'img_foreign', type: 'image/gif', width: 10, height: 8, data: 'R0lG' }],
    };

    const report = await importForeignBundle(USER, bundle);

    expect(report.images.uploaded).toBe(1);
    expect(srcAt(sentPosts()[0].content as DocNode, 0)).toBe('asset:img_server1');
    // Nothing local to stamp, and nothing local was invented.
    expect(await db.localPosts.count()).toBe(0);
  });

  it('loses one picture, not the bundle, when the base64 is corrupt', async () => {
    const bundle: Bundle = {
      format: 'publishing-studio/v2',
      exportedAt: '',
      posts: [post({ id: 'p_1', content: doc(image('idb:img_foreign')) })],
      revisions: [],
      images: [{ id: 'img_foreign', type: 'image/gif', width: 1, height: 1, data: '!!!not base64' }],
    };

    const report = await importForeignBundle(USER, bundle);

    expect(report.images.missing).toBe(1);
    expect(report.confirmed).toEqual(['p_1']);
  });
});

// ============================================================ retiring

describe('removing the local copies', () => {
  it('is refused while anything is un-migrated', async () => {
    await db.localPosts.bulkPut([local({ id: 'p_1' }, 1), local({ id: 'p_2' })]);
    expect(await canRetireLocalCopies()).toBe(false);
    await expect(retireLocalCopies()).rejects.toThrow(/not every post/i);
    expect(await db.localPosts.count()).toBe(2);
  });

  it('is refused when there is nothing there at all', async () => {
    expect(await canRetireLocalCopies()).toBe(false);
  });

  it('removes the rows and only the blobs assetMap proves were uploaded', async () => {
    await db.images.bulkPut([gif('img_up'), gif('img_never')]);
    await db.assetMap.put({ localId: 'img_up', assetId: 'img_server1' });
    await db.localPosts.put(
      local({ id: 'p_1', content: doc(image('idb:img_up'), image('idb:img_never')) }, 5),
    );
    await db.localRevisions.put({
      id: 'r_1',
      postId: 'p_1',
      revision: 1,
      createdAt: 1,
      content: doc(),
      kind: 'autosave',
    } as Revision);

    expect(await canRetireLocalCopies()).toBe(true);
    const removed = await retireLocalCopies();

    expect(removed).toEqual({ posts: 1, revisions: 1, images: 1 });
    expect(await db.localPosts.count()).toBe(0);
    expect(await db.localRevisions.count()).toBe(0);
    // The blob nothing ever uploaded stays. Deleting bytes with no copy
    // anywhere is the one thing this action must never do.
    expect(await db.images.get('img_never')).toBeTruthy();
    expect(await db.images.get('img_up')).toBeUndefined();
    // The mapping is kept: two short strings that keep a re-import idempotent.
    expect(await db.assetMap.get('img_up')).toBeTruthy();
  });
});

// ============================================================ images.ts

describe('images.ts — the resolver and the upload path', () => {
  it('storeImageFile returns an id usable under EITHER scheme', async () => {
    /*
     * NOT `expect(src).toBe('asset:' + id)`, and the parent plan's wording
     * cannot hold while `src/routes/Editor.tsx` is frozen.
     *
     * `Editor.tsx:262` writes `` `idb:${rec.id}` `` for a newly inserted image
     * and is frozen by this plan's own `git diff --exit-code` gate. After the
     * cutover the id it interpolates is a SERVER id, so the `idb:` prefix stops
     * meaning "in this browser" (plan §6.3). It still works on every surface —
     * `imageIdFromSrc` strips either prefix, `isStorableImageSrc` accepts
     * either, the server's orphan-sweep extractor reads both, and
     * `acquireImageURL` misses the local store and goes to the API — so what
     * the contract can honestly assert is that the id is usable under either
     * scheme. That is what this checks, on all four of them.
     *
     * A GIF, because it is the one type `prepareForUpload` passes through
     * without a canvas — see the header note.
     */
    const file = new File([new Uint8Array([0x47, 0x49, 0x46])], 'photo.gif', {
      type: 'image/gif',
    });

    const rec = await storeImageFile(file);

    expect(rec.id).toBe('img_server1');
    for (const scheme of ['idb:', 'asset:']) {
      expect(imageIdFromSrc(`${scheme}${rec.id}`), scheme).toBe(rec.id);
      expect(isStorableImageSrc(`${scheme}${rec.id}`), scheme).toBe(true);
    }
    expect(await acquireImageURL(rec.id)).toBe(`/api/images/${rec.id}`);
    // And nothing went into `db.images`: that store now means "the pre-backend
    // library", which is exactly the set migration walks.
    expect(await db.images.get(rec.id)).toBeUndefined();
    expect(await db.images.count()).toBe(0);
  });

  it('refuses a file type the server would not accept, before any request', async () => {
    const file = new File([new Uint8Array([1])], 'x.bmp', { type: 'image/bmp' });
    await expect(storeImageFile(file)).rejects.toBeInstanceOf(ImageError);
    expect(vi.mocked(api.createImageSlot)).not.toHaveBeenCalled();
  });

  it('resolves a local blob to a refcounted object URL', async () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:local-1',
      revokeObjectURL: (u: string) => revoked.push(u),
    });
    await db.images.put(gif('img_a'));

    expect(await acquireImageURL('img_a')).toBe('blob:local-1');
    expect(await acquireImageURL('img_a')).toBe('blob:local-1');
    releaseImageURL('img_a');
    // Still held by the second acquire — revoking here is what used to break a
    // cover shown in two places at once.
    expect(revoked).toEqual([]);
    releaseImageURL('img_a');
    expect(revoked).toEqual(['blob:local-1']);
  });

  it('falls back to /api/images/<id> for an id the local store does not have', async () => {
    // This is what lets a bare `coverImage.blobId` resolve on both sides of the
    // cutover with no change to the `CoverImage` type.
    expect(await acquireImageURL('img_server9')).toBe('/api/images/img_server9');
    // A release for a server-backed id is a no-op rather than a crash.
    expect(() => releaseImageURL('img_server9')).not.toThrow();
  });

  it('treats an empty id as a miss rather than requesting /api/images/', async () => {
    expect(await acquireImageURL('')).toBeNull();
  });

  it('PUTs the exact url and headers the slot returned, and no credentials', async () => {
    await db.images.put(gif('img_a'));
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_a')) }));

    await migrateLocalPosts(USER);

    // Both are inputs to R2's signature: change either and the PUT is a 403.
    expect(putCalls[0].url).toBe('https://r2.example.com/put/1?sig=abc');
    expect(putCalls[0].headers).toEqual({ 'content-type': 'image/gif', 'content-length': '3' });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    // The session cookie has no business at the storage host.
    expect(init.credentials).toBe('omit');
  });

  it('refuses a non-GIF it cannot re-encode rather than shipping EXIF-bearing bytes', async () => {
    /*
     * The re-encode is what makes the EXIF claim true for PNG and WebP, where
     * the server's own check is JPEG-only. If it cannot run, uploading the
     * original bytes would be a silent downgrade of that guarantee — for a PNG
     * nothing anywhere would refuse it and the writer's GPS coordinates would
     * be published. There is no canvas encoder in node, so this is also the
     * environment the assertion runs in.
     */
    const png = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });
    await expect(prepareForUpload(png)).rejects.toBeInstanceOf(ImageError);
    expect(putCalls).toHaveLength(0);
  });

  it('marks the image failed and keeps the post when a commit is refused', async () => {
    await db.images.put(gif('img_a'));
    await db.localPosts.put(local({ id: 'p_1', content: doc(image('idb:img_a')) }));
    vi.mocked(api.commitImage).mockRejectedValue(apiError(400, 'bad_request', { detail: 'exif' }));

    const report = await migrateLocalPosts(USER);

    expect(report.images.failed).toBe(1);
    expect(report.confirmed).toEqual(['p_1']);
    // Nothing was mapped, so a later run tries again rather than believing a
    // commit that never happened.
    expect(await db.assetMap.get('img_a')).toBeUndefined();
  });
});
