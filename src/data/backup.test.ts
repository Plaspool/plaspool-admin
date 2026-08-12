import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { db, type LocalPost } from './db';
import { ApiError } from './errors';
import {
  ImportError,
  bundleImageCount,
  exportBundle,
  exportLocalBundle,
  importBundle,
  parseBundle,
} from './backup';
import { BUNDLE_FORMAT } from './types';
import type {
  AuthUser,
  Bundle,
  DocNode,
  ListPost,
  Post,
  Revision,
  RevisionMeta,
  StoredImage,
} from './types';

/**
 * The escape hatch after the cutover (plan §8.1, F12).
 *
 * Three properties are worth more than everything else here, because each one
 * used to be false in a way nothing on screen would have shown:
 *
 * 1. **A writer can still get their words out.** `GET /api/export` is
 *    `requireOwner()`, so an export that only used it would have taken the
 *    backup path away from every non-owner — silently, since a 403 arrives as
 *    a failed download rather than as an explanation.
 * 2. **The export is complete, not "whatever was cached".** The old one read
 *    `db.posts`, which after the cutover holds only the posts whose bodies have
 *    been fetched. It would have produced a file with three posts in it under a
 *    toast reading "Exported 3 posts with images and history" — a true number
 *    and a false claim.
 * 3. **Import uploads.** `bulkAdd` into a cache store produces rows with no
 *    owner and no `postList` projection: invisible in the grid, deleted by the
 *    next `clearCache`, and never sent anywhere.
 *
 * Nothing here talks to a real server. `api.*` are spies on the real exported
 * object and the one raw `fetch` — the presigned PUT — is stubbed, exactly as
 * in `migrate.test.ts`, and for the same reason: R2 credentials were not
 * supplied for this work, so a real upload is unverifiable and is not claimed.
 *
 * The image fixtures are GIFs because `prepareForUpload` re-encodes every other
 * type through a canvas that neither node nor jsdom has — see the note at the
 * top of `migrate.test.ts`.
 */

const OWNER: AuthUser = {
  id: 'u_owner',
  email: 'owner@test.local',
  displayName: 'The Owner',
  role: 'owner',
};
const WRITER: AuthUser = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer',
};

const doc = (text = 'words'): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
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
    authorId: WRITER.id,
    authorName: WRITER.displayName,
    revision: 3,
    ...over,
  };
}

const listRow = (p: Post): ListPost => {
  const { content: _dropped, ...rest } = p;
  return rest;
};

const revision = (postId: string, rev: number): Revision => ({
  id: `r_${postId}_${rev}`,
  postId,
  revision: rev,
  createdAt: rev,
  title: 'A post',
  subtitle: '',
  content: doc(`version ${rev}`),
  wordCount: 2,
  kind: rev === 1 ? 'manual' : 'autosave',
});

const meta = (rev: Revision): RevisionMeta => {
  const { content: _dropped, ...rest } = rev;
  return rest;
};

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

let slotSeq = 0;

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.posts.clear(),
    db.postList.clear(),
    db.revisions.clear(),
    db.localPosts.clear(),
    db.localRevisions.clear(),
    db.images.clear(),
    db.assetMap.clear(),
  ]);
  slotSeq = 0;

  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 10, height: 8, close: () => {} })),
  );
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));
  vi.spyOn(api, 'createImageSlot').mockImplementation(async () => {
    slotSeq += 1;
    return {
      id: `img_server${slotSeq}`,
      uploadUrl: `https://r2.example.com/put/${slotSeq}`,
      headers: { 'content-type': 'image/gif' },
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------- owner export

describe('export as owner', () => {
  it('takes the server route and makes no per-post request', async () => {
    const server: Bundle = {
      format: BUNDLE_FORMAT,
      exportedAt: '2026-08-11T00:00:00.000Z',
      posts: [post({ id: 'p_a' }), post({ id: 'p_b' })],
      revisions: [revision('p_a', 1)],
      images: [],
    };
    vi.spyOn(api, 'exportAll').mockResolvedValue(server);
    const listPosts = vi.spyOn(api, 'listPosts');

    const bundle = await exportBundle(OWNER);

    expect(bundle).toBe(server);
    // The whole point of the owner path: one request, assembled server-side.
    expect(listPosts).not.toHaveBeenCalled();
  });

  it('falls back to the writer rebuild when the server says the role is stale', async () => {
    vi.spyOn(api, 'exportAll').mockRejectedValue(
      new ApiError({ status: 403, code: 'forbidden', body: {} }),
    );
    vi.spyOn(api, 'listPosts').mockResolvedValue({
      items: [listRow(post({ id: 'p_a' }))],
      nextCursor: null,
    });
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id }));
    vi.spyOn(api, 'listRevisions').mockResolvedValue({ items: [], nextCursor: null });

    const bundle = await exportBundle(OWNER);

    // A cached role that has gone stale must not be the thing that stops
    // somebody taking a backup.
    expect(bundle.posts.map((p) => p.id)).toEqual(['p_a']);
  });

  it('does not turn a rate limit into hundreds of requests', async () => {
    vi.spyOn(api, 'exportAll').mockRejectedValue(
      new ApiError({ status: 429, code: 'rate_limited', body: {} }),
    );
    const listPosts = vi.spyOn(api, 'listPosts');

    await expect(exportBundle(OWNER)).rejects.toBeInstanceOf(ApiError);
    // `GET /export` is 5/hour and the fallback is one request per post. "Wait
    // twelve minutes" must not become a stampede inside an error handler.
    expect(listPosts).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------- writer export

describe('export as writer', () => {
  it('rebuilds the same bundle from routes every writer already has', async () => {
    const live = post({ id: 'p_live', title: 'Still here' });
    const trashed = post({ id: 'p_trash', title: 'Thrown away', deletedAt: 99 });
    const revs = [revision('p_live', 1), revision('p_live', 2)];

    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [listRow(trashed)] : [listRow(live)],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getPost').mockImplementation(async (id) =>
      id === 'p_live' ? live : trashed,
    );
    vi.spyOn(api, 'listRevisions').mockImplementation(async (id) => ({
      items: id === 'p_live' ? revs.map(meta) : [],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getRevision').mockImplementation(
      async (revId) => revs.find((r) => r.id === revId)!,
    );

    const bundle = await exportBundle(WRITER);

    expect(bundle.format).toBe(BUNDLE_FORMAT);
    // BOTH status views. `server/repo/query.ts` pushes `deleted_at IS NULL` for
    // every status but `trash`, so one pass silently omits the bin — the one
    // place a writer looks for something they deleted by accident.
    expect(bundle.posts.map((p) => p.id).sort()).toEqual(['p_live', 'p_trash']);
    // Bodies, not the list projections — a bundle of rows with no `content`
    // restores a library of empty posts.
    expect(bundle.posts.every((p) => p.content !== undefined)).toBe(true);
    expect(bundle.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(bundle.revisions.every((r) => r.content !== undefined)).toBe(true);
  });

  it('walks every page rather than stopping at the first cursor', async () => {
    const page1 = [post({ id: 'p_1' }), post({ id: 'p_2' })].map(listRow);
    const page2 = [post({ id: 'p_3' })].map(listRow);

    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => {
      if (q?.status === 'trash') return { items: [], nextCursor: null };
      return q?.cursor
        ? { items: page2, nextCursor: null }
        : { items: page1, nextCursor: 'c1' };
    });
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id }));
    vi.spyOn(api, 'listRevisions').mockResolvedValue({ items: [], nextCursor: null });

    const bundle = await exportBundle(WRITER);

    expect(bundle.posts.map((p) => p.id)).toEqual(['p_1', 'p_2', 'p_3']);
  });

  it('carries the whole of a long history rather than one page of it', async () => {
    const older = [revision('p_1', 1)];
    const newer = [revision('p_1', 2)];
    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [] : [listRow(post({ id: 'p_1' }))],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id }));
    vi.spyOn(api, 'listRevisions').mockImplementation(async (_id, cursor) =>
      cursor
        ? { items: older.map(meta), nextCursor: null }
        : { items: newer.map(meta), nextCursor: 'r1' },
    );
    vi.spyOn(api, 'getRevision').mockImplementation(
      async (revId) => [...older, ...newer].find((r) => r.id === revId)!,
    );

    const bundle = await exportBundle(WRITER);

    // A backup that quietly stops at a page boundary loses history nobody
    // knows is missing. `syncRevisions` may take one page; this may not.
    expect(bundle.revisions.map((r) => r.revision).sort()).toEqual([1, 2]);
  });

  it('survives a post destroyed between the listing and the fetch', async () => {
    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => ({
      items:
        q?.status === 'trash'
          ? []
          : [listRow(post({ id: 'p_gone' })), listRow(post({ id: 'p_here' }))],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => {
      if (id === 'p_gone') throw new ApiError({ status: 404, code: 'not_found', body: {} });
      return post({ id });
    });
    vi.spyOn(api, 'listRevisions').mockResolvedValue({ items: [], nextCursor: null });

    const bundle = await exportBundle(WRITER);

    // A library with any churn in it must still be backup-able. One vanished
    // row is not a reason to refuse the other ninety-nine.
    expect(bundle.posts.map((p) => p.id)).toEqual(['p_here']);
  });

  it('survives a revision body the server pruned mid-export', async () => {
    const kept = revision('p_1', 30);
    const pruned = revision('p_1', 1);
    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [] : [listRow(post({ id: 'p_1' }))],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id }));
    vi.spyOn(api, 'listRevisions').mockResolvedValue({
      items: [meta(pruned), meta(kept)],
      nextCursor: null,
    });
    vi.spyOn(api, 'getRevision').mockImplementation(async (revId) => {
      if (revId === pruned.id) throw new ApiError({ status: 404, code: 'not_found', body: {} });
      return kept;
    });

    const bundle = await exportBundle(WRITER);

    expect(bundle.revisions.map((r) => r.revision)).toEqual([30]);
  });

  it('reports progress, because the writer path is one request per post', async () => {
    vi.spyOn(api, 'listPosts').mockImplementation(async (q) => ({
      items: q?.status === 'trash' ? [] : [listRow(post({ id: 'p_1' })), listRow(post({ id: 'p_2' }))],
      nextCursor: null,
    }));
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id }));
    vi.spyOn(api, 'listRevisions').mockResolvedValue({ items: [], nextCursor: null });

    const seen: string[] = [];
    await exportBundle(WRITER, (p) => seen.push(`${p.posts}/${p.total}`));

    expect(seen).toEqual(['0/2', '1/2', '2/2']);
  });
});

// --------------------------------------------------------------- local export

describe('export of the pre-backend corpus', () => {
  it('carries the posts, their history and the image bytes', async () => {
    const img = gif('img_local');
    await db.images.add(img);
    const row: LocalPost = {
      ...post({ id: 'p_local', title: 'Written before the blog', content: doc('offline words') }),
      migratedAt: null,
    };
    await db.localPosts.add(row);
    await db.localRevisions.add(revision('p_local', 1));

    const bundle = await exportLocalBundle();

    expect(bundle.posts.map((p) => p.title)).toEqual(['Written before the blog']);
    expect(bundle.revisions).toHaveLength(1);
    // The bytes, base64'd. This corpus is the only one whose pictures exist
    // nowhere but in this browser profile.
    expect(bundle.images).toHaveLength(1);
    expect(bundle.images[0].id).toBe('img_local');
    expect(bundle.images[0].data.length).toBeGreaterThan(0);
  });

  it('leaves migratedAt behind, because a strict schema refuses the whole batch for it', async () => {
    await db.localPosts.add({ ...post({ id: 'p_done' }), migratedAt: 1234 });

    const bundle = await exportLocalBundle();

    // `BundlePost` is `.strict()` and `limit()` runs before `readJson`, so a
    // bundle carrying this field is a 400 that burns one of five hourly slots
    // before the body is even read (F8).
    expect(Object.hasOwn(bundle.posts[0], 'migratedAt')).toBe(false);
  });
});

// --------------------------------------------------------------------- parse

describe('parseBundle', () => {
  it('refuses a file that is not JSON', () => {
    expect(() => parseBundle('not json at all')).toThrow(ImportError);
  });

  it('refuses a JSON file that is not one of ours', () => {
    expect(() => parseBundle('{"format":"something/else","posts":[]}')).toThrow(ImportError);
  });

  it('accepts an older bundle of ours by its prefix', () => {
    const bundle = parseBundle('{"format":"publishing-studio/v1","posts":[]}');
    expect(bundle.format).toBe('publishing-studio/v1');
    // The absent keys become empty arrays rather than `undefined`, so every
    // reader downstream can iterate without a guard of its own.
    expect(bundle.revisions).toEqual([]);
    expect(bundle.images).toEqual([]);
  });
});

// -------------------------------------------------------------------- import

describe('import', () => {
  function acceptImport() {
    return vi.spyOn(api, 'importBundle').mockResolvedValue({
      imported: 1,
      skipped: 0,
      ignored: { revisions: 0, images: 0 },
    });
  }

  it('uploads the bundle instead of writing it into the cache', async () => {
    const sent = acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) =>
      post({ id, authorId: WRITER.id, revision: 1 }),
    );
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      exportedAt: '2026-08-11T00:00:00.000Z',
      posts: [post({ id: 'p_import', title: 'From a file' })],
      revisions: [],
      images: [],
    };

    const report = await importBundle(WRITER.id, JSON.stringify(bundle));

    expect(sent).toHaveBeenCalledTimes(1);
    expect(report.confirmed).toEqual(['p_import']);
    /*
     * The row in `db.posts` is there because `migrate` cached what `GET
     * /posts/:id` returned — i.e. because the SERVER has it. The old import
     * wrote rows the server had never seen, with no owner and no `postList`
     * projection: invisible in the grid it claimed to have filled.
     */
    expect((await db.posts.get('p_import'))?.ownerUserId).toBe(WRITER.id);
    expect((await db.postList.get('p_import'))?.ownerUserId).toBe(WRITER.id);
  });

  it('uploads a foreign bundle’s base64 pictures and rewrites the document', async () => {
    const sent = acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id, revision: 1 }));
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      exportedAt: '2026-08-11T00:00:00.000Z',
      posts: [
        post({
          id: 'p_pics',
          content: { type: 'doc', content: [image('idb:img_from_file')] },
        }),
      ],
      revisions: [],
      images: [{ id: 'img_from_file', type: 'image/gif', width: 10, height: 8, data: btoa('GIF') }],
    };

    const report = await importBundle(WRITER.id, JSON.stringify(bundle));

    expect(report.images.uploaded).toBe(1);
    const body = sent.mock.calls[0][0] as { posts: { content: DocNode }[] };
    const src = body.posts[0].content.content?.[0].attrs?.src;
    /*
     * Without the base64 arm every picture in an imported bundle is dropped:
     * the route restores no images at all (it counts them in `ignored`), and
     * the `idb:` id names a blob that exists in no browser this file will ever
     * be opened in.
     */
    expect(src).toBe('asset:img_server1');
  });

  it('fills in what an older or hand-written bundle left out', async () => {
    const sent = acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id, revision: 1 }));
    // Everything `BundlePost` requires and this file does not carry —
    // `excerptSource`, `template`, `tags`, the timestamps. Sent raw it is a
    // Zod issue reported to the writer as a developer's sentence.
    const bundle = {
      format: BUNDLE_FORMAT,
      posts: [{ id: 'p_thin', title: 'Sparse', content: doc('body') }],
    };

    const report = await importBundle(WRITER.id, JSON.stringify(bundle));

    expect(report.excluded).toEqual([]);
    expect(report.confirmed).toEqual(['p_thin']);
    const body = sent.mock.calls[0][0] as { posts: Record<string, unknown>[] };
    expect(body.posts[0].excerptSource).toBeDefined();
    expect(body.posts[0].template).toBeNull();
  });

  it('carries a per-post template override onto the wire', async () => {
    const sent = acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id, revision: 1 }));
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      exportedAt: '',
      posts: [
        post({ id: 'p_pinned', template: 'editorial' }),
        post({ id: 'p_plain', template: null }),
      ],
      revisions: [],
      images: [],
    };

    await importBundle(WRITER.id, JSON.stringify(bundle));

    // A new `Post` field has to land in `shared/types.ts`, `PostPatch`,
    // `createDraftShape` and this path or it is silently dropped from every
    // bundle. `normalise` rebuilds through `createDraftShape`, so that function
    // is the one that decides and this is what notices.
    const body = sent.mock.calls[0][0] as { posts: { id: string; template: unknown }[] };
    expect(body.posts.find((p) => p.id === 'p_pinned')?.template).toBe('editorial');
    expect(body.posts.find((p) => p.id === 'p_plain')?.template).toBeNull();
  });

  it('excludes a post the blog would refuse rather than sending it', async () => {
    const sent = acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id, revision: 1 }));
    const bundle = {
      format: BUNDLE_FORMAT,
      posts: [
        { ...post({ id: 'p_bad' }), content: { type: 'doc', content: [image('javascript:alert(1)')] } },
        post({ id: 'p_good' }),
      ],
    };

    const report = await importBundle(WRITER.id, JSON.stringify(bundle));

    // `POST /import` throws on the FIRST offending post, so an unfiltered batch
    // of 25 dies for one of them — and the request still burns a rate-limit
    // slot because `limit()` runs before `readJson`.
    expect(report.excluded.map((e) => e.id)).toEqual(['p_bad']);
    const body = sent.mock.calls[0][0] as { posts: { id: string }[] };
    expect(body.posts.map((p) => p.id)).toEqual(['p_good']);
  });

  it('does not silently empty a post whose document is unreadable', async () => {
    acceptImport();
    vi.spyOn(api, 'getPost').mockImplementation(async (id) => post({ id, revision: 1 }));
    const bundle = {
      format: BUNDLE_FORMAT,
      posts: [{ ...post({ id: 'p_broken' }), content: 'this is not a document' }],
    };

    const report = await importBundle(WRITER.id, JSON.stringify(bundle));

    /*
     * `createDraftShape` substitutes an empty document for anything it cannot
     * parse, which would turn "this post cannot be imported" into "this post
     * imported, empty" — under a success toast. It is listed instead.
     */
    expect(report.confirmed).toEqual([]);
    expect(report.excluded.map((e) => e.id)).toEqual(['p_broken']);
  });

  it('rejects a file that is not a bundle before any request is made', async () => {
    const sent = acceptImport();
    await expect(importBundle(WRITER.id, 'nonsense')).rejects.toBeInstanceOf(ImportError);
    expect(sent).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------- counting

describe('bundleImageCount', () => {
  it('counts the pictures a bundle can actually restore', () => {
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      exportedAt: '',
      posts: [
        post({ id: 'p_1', content: { type: 'doc', content: [image('idb:img_a')] } }),
        post({ id: 'p_2', content: { type: 'doc', content: [image('asset:img_missing')] } }),
      ],
      revisions: [],
      images: [
        { id: 'img_a', type: 'image/gif', width: 1, height: 1, data: '' },
        { id: 'img_unused', type: 'image/gif', width: 1, height: 1, data: '' },
      ],
    };

    // Not `bundle.images.length`: the question a writer is asking is "how many
    // of my pictures come with it", and a bundle can carry blobs nothing
    // references while naming ids it does not carry.
    expect(bundleImageCount(bundle)).toBe(1);
  });
});
