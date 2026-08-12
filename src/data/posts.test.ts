import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `posts.ts` after the cutover, against a mocked `api.ts`.
 *
 * WHAT THIS SUITE STOPPED BEING. Until Task 19 every case here drove a Dexie
 * transaction and asserted on the row it left: revision numbers, slug
 * uniqueness, excerpt derivation, autosave pruning, orphan collection. All of
 * that is the server's now and is tested against a real database in
 * `server/repo/posts.test.ts`, `server/repo/lifecycle.test.ts` and
 * `server/repo/revisions.test.ts` — re-asserting it against a mock would only
 * pin what the mock was told to return.
 *
 * What is left is the part that is genuinely this module's: which route it
 * calls, what it caches, and — the whole reason this part of the app exists —
 * what a FAILED save leaves behind. Those cases assert on `db.posts` and
 * `db.pending` directly, because `Editor.tsx:48` and `PostGate` read exactly
 * those and both are frozen.
 */
vi.mock('./api', () => ({
  api: {
    createPost: vi.fn(),
    savePost: vi.fn(),
    publishPost: vi.fn(),
    unpublishPost: vi.fn(),
    archivePost: vi.fn(),
    unarchivePost: vi.fn(),
    trashPost: vi.fn(),
    restorePost: vi.fn(),
    duplicatePost: vi.fn(),
    destroyPost: vi.fn(),
    emptyTrash: vi.fn(),
    sweepBlankDrafts: vi.fn(),
    collectOrphanImages: vi.fn(),
  },
}));

import { api } from './api';
import { cachePost } from './cache';
import { db } from './db';
import { ApiError, ForbiddenError, NotFoundError, OfflineError } from './errors';
import {
  StaleWriteError,
  archivePost,
  createDraftShape,
  createPost,
  destroyPost,
  duplicatePost,
  emptyTrash,
  filterAndSort,
  publishPost,
  restorePost,
  savePost,
  setActiveUser,
  sweepBlankDrafts,
  trashPost,
  unarchivePost,
  unpublishPost,
  type Query,
} from './posts';
import { countWords, deriveExcerpt, docToText, isValidDoc, readingTime, slugify } from './doc';
import type { DocNode, ListPost, Post } from './types';

const USER = 'u_writer';

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let n = 0;
const serverPost = (over: Partial<Post> = {}): Post =>
  createDraftShape({
    id: `p_${(n += 1)}`,
    authorId: USER,
    authorName: 'A Writer',
    content: para('server content'),
    ...over,
  });

beforeEach(async () => {
  vi.resetAllMocks();
  setActiveUser(USER);
  await db.posts.clear();
  await db.postList.clear();
  await db.revisions.clear();
  await db.pending.clear();
  await db.images.clear();
});

// ------------------------------------------------------------- pure helpers

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

// ------------------------------------------------------------------ create

describe('createPost', () => {
  it('caches the server’s post so the editor can hydrate from it', async () => {
    const created = serverPost({ content: para('a fresh draft') });
    vi.mocked(api.createPost).mockResolvedValue(created);

    const p = await createPost({ title: 'Hello' });

    expect(p).toEqual(created);
    expect((await db.posts.get(created.id))?.content).toEqual(para('a fresh draft'));
    expect(await db.postList.get(created.id)).toBeDefined();
  });

  it('sends the patchable fields only, so a system key cannot 400 the request', async () => {
    vi.mocked(api.createPost).mockResolvedValue(serverPost());

    await createPost({
      title: 'Revived',
      content: para('rescued words'),
      // `Editor.tsx:517` hands a Partial<Post>, and a `localPosts` row carries
      // `migratedAt` on top of that. The route's body schema is `.strict()`, so
      // a spread would be a 400 the writer can do nothing about.
      status: 'published',
      revision: 99,
      authorId: 'someone-else',
      migratedAt: null,
    } as Partial<Post>);

    expect(vi.mocked(api.createPost)).toHaveBeenCalledWith({
      title: 'Revived',
      content: para('rescued words'),
    });
  });
});

// -------------------------------------------------------------------- save

describe('savePost — the success path', () => {
  it('forwards the patch, the base revision and the kind, then caches the result', async () => {
    const saved = serverPost({ revision: 8, content: para('what the server stored') });
    vi.mocked(api.savePost).mockResolvedValue(saved);

    const out = await savePost(saved.id, { title: 'Typed' }, { baseRevision: 7, kind: 'manual' });

    expect(vi.mocked(api.savePost)).toHaveBeenCalledWith(
      saved.id,
      { title: 'Typed' },
      { baseRevision: 7, kind: 'manual' },
    );
    expect(out.revision).toBe(8);
    expect((await db.posts.get(saved.id))?.content).toEqual(para('what the server stored'));
  });

  it('clears its own queued row, and never one a human has to end', async () => {
    const p = serverPost({ revision: 3 });
    vi.mocked(api.savePost).mockRejectedValueOnce(new OfflineError());
    await cachePost(USER, p);
    await savePost(p.id, { title: 'offline' }, { baseRevision: 3 }).catch(() => {});
    expect(await db.pending.get([p.id, USER])).toBeDefined();

    vi.mocked(api.savePost).mockResolvedValue({ ...p, revision: 4 });
    await savePost(p.id, { title: 'back online' }, { baseRevision: 3 });
    expect(await db.pending.get([p.id, USER])).toBeUndefined();

    // Now the same thing with a row replay has already escalated. The writer's
    // 500 offline words are in it and no conflict banner is on screen, so the
    // next keystroke's successful save must NOT be what deletes them.
    vi.mocked(api.savePost).mockRejectedValueOnce(new OfflineError());
    await savePost(p.id, { title: 'offline again' }, { baseRevision: 4 }).catch(() => {});
    const row = await db.pending.get([p.id, USER]);
    await db.pending.put({ ...row!, state: 'unresolved' });

    vi.mocked(api.savePost).mockResolvedValue({ ...p, revision: 5 });
    await savePost(p.id, { title: 'one keystroke later' }, { baseRevision: 4 });
    expect((await db.pending.get([p.id, USER]))?.state).toBe('unresolved');
  });
});

describe('savePost — the failure sequence (plan §2.3)', () => {
  it('makes the patch durable BEFORE the error reaches the caller', async () => {
    const p = serverPost({ revision: 2, content: para('what the server has') });
    await cachePost(USER, p);
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());

    await expect(
      savePost(p.id, { title: 'A title', content: para('nine hundred words') }, { baseRevision: 2 }),
    ).rejects.toBeInstanceOf(OfflineError);

    // `useAutosave` keeps the patch in memory and retries five times; memory
    // does not survive a reload and this row does.
    const row = await db.pending.get([p.id, USER]);
    expect(row?.patch.title).toBe('A title');
    expect(row?.baseRevision).toBe(2);
    expect(row?.state).toBe('queued');
  });

  it('writes the OVERLAY, so a reload puts the words back on screen', async () => {
    const p = serverPost({ revision: 2, content: para('what the server has') });
    await cachePost(USER, p);
    vi.mocked(api.savePost).mockRejectedValue(new OfflineError());

    await savePost(p.id, { content: para('nine hundred words') }, { baseRevision: 2 }).catch(
      () => {},
    );

    // Asserted through `db.posts.get(id)` because that is literally the query
    // the frozen editor hydrates from, and nothing else can reach its buffer.
    const row = await db.posts.get(p.id);
    expect(docToText(row!.content)).toBe('nine hundred words');
    // NOT revision + 1: the server never accepted this write, so claiming a
    // number it did not issue would break the next save's CAS check.
    expect(row!.revision).toBe(2);
    expect(row!.pendingAt).toBeTypeOf('number');
  });

  it('a 409 rethrows the conflict AND caches the server’s post', async () => {
    const mine = serverPost({ revision: 4, content: para('the version I am editing') });
    await cachePost(USER, mine);
    const theirs: Post = { ...mine, revision: 9, content: para('the newer version') };
    vi.mocked(api.savePost).mockRejectedValue(new StaleWriteError(4, 9, theirs));

    await expect(
      savePost(mine.id, { content: para('my keystroke') }, { baseRevision: 4 }),
    ).rejects.toBeInstanceOf(StaleWriteError);

    /*
     * Without this, both halves of the frozen conflict banner lie: "Load
     * theirs" (`Editor.tsx:176`) re-reads `db.posts` and paints the STALE text
     * while announcing "Loaded the newer version", and "Keep mine" (`:190`)
     * rebases onto revision 4 again, so the next save 409s against the same
     * number forever.
     */
    const row = await db.posts.get(mine.id);
    expect(docToText(row!.content)).toBe('the newer version');
    expect(row!.revision).toBe(9);
    // And the writer's own words are still recoverable.
    expect(await db.pending.get([mine.id, USER])).toBeDefined();
  });

  it('a 403 mints no pending row — it could never succeed', async () => {
    const p = serverPost({ revision: 2 });
    await cachePost(USER, p);
    vi.mocked(api.savePost).mockRejectedValue(new ForbiddenError());

    await expect(savePost(p.id, { title: 'not mine' }, { baseRevision: 2 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // A writer editing a colleague's post (F14). A row here is replayed on
    // every boot for the life of the profile and is refused every time.
    expect(await db.pending.get([p.id, USER])).toBeUndefined();
    expect(docToText((await db.posts.get(p.id))!.content)).toBe('server content');
  });

  it('a 404 mints no pending row and does NOT evict the row under the banner', async () => {
    const p = serverPost({ revision: 2, content: para('still on screen') });
    await cachePost(USER, p);
    vi.mocked(api.savePost).mockRejectedValue(new NotFoundError(p.id));

    await expect(savePost(p.id, { title: 'gone' }, { baseRevision: 2 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(await db.pending.get([p.id, USER])).toBeUndefined();
    /*
     * `useAutosave.ts:103` turns this into `state: 'gone'` and `Editor.tsx:506`
     * renders "Save as a new post" ABOVE the writer's text. Evicting here would
     * empty the live query behind that banner and the frozen `if (!post)` arm
     * would replace the whole surface with a tombstone — taking the words the
     * banner just promised were still there. `syncPost` is where a 404 evicts.
     */
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('a 422 queues like any other failure — replay is what marks it blocked', async () => {
    const p = serverPost({ revision: 2 });
    await cachePost(USER, p);
    vi.mocked(api.savePost).mockRejectedValue(
      new ApiError({ status: 422, code: 'invalid_document', detail: 'content.0' }),
    );

    await savePost(p.id, { content: para('too big') }, { baseRevision: 2 }).catch(() => {});

    expect((await db.pending.get([p.id, USER]))?.state).toBe('queued');
  });
});

// --------------------------------------------------------------- lifecycle

describe('lifecycle', () => {
  const ops = [
    ['publishPost', publishPost, api.publishPost],
    ['unpublishPost', unpublishPost, api.unpublishPost],
    ['archivePost', archivePost, api.archivePost],
    ['unarchivePost', unarchivePost, api.unarchivePost],
    ['trashPost', trashPost, api.trashPost],
    ['restorePost', restorePost, api.restorePost],
  ] as const;

  it.each(ops)('%s returns the server post and caches it', async (_name, run, route) => {
    const next = serverPost({ revision: 12, content: para('after the transition') });
    vi.mocked(route).mockResolvedValue(next);

    const out = await run(next.id);

    // `Editor.tsx:285`'s `adopt` sets baseRevision from this return value; the
    // live query behind it reads the row cached here. A lifecycle call that
    // bumped the revision without caching leaves the next autosave conflicting
    // with a change the writer made themselves.
    expect(out.revision).toBe(12);
    expect((await db.posts.get(next.id))?.revision).toBe(12);
  });

  it('duplicatePost caches the copy the server minted', async () => {
    const copy = serverPost({ title: 'Orig (copy)', content: para('shared text') });
    vi.mocked(api.duplicatePost).mockResolvedValue(copy);

    const out = await duplicatePost('p_source');

    expect(vi.mocked(api.duplicatePost)).toHaveBeenCalledWith('p_source');
    expect(out.id).toBe(copy.id);
    expect(await db.posts.get(copy.id)).toBeDefined();
  });
});

describe('destroy and empty trash', () => {
  it('destroyPost evicts both stores and asks for no orphan sweep', async () => {
    const p = serverPost();
    await cachePost(USER, p);
    vi.mocked(api.destroyPost).mockResolvedValue(undefined);

    await destroyPost(p.id);

    expect(await db.posts.get(p.id)).toBeUndefined();
    expect(await db.postList.get(p.id)).toBeUndefined();
    /*
     * `POST /api/images/collect-orphans` is owner-only, so for a writer the old
     * best-effort sweep is a guaranteed 403 hung off every delete. A writer's
     * destroy must not carry housekeeping it never asked for.
     */
    expect(vi.mocked(api.collectOrphanImages)).not.toHaveBeenCalled();
  });

  it('a failed destroy leaves the cached row alone', async () => {
    const p = serverPost();
    await cachePost(USER, p);
    vi.mocked(api.destroyPost).mockRejectedValue(new ForbiddenError());

    await expect(destroyPost(p.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.posts.get(p.id)).toBeDefined();
  });

  it('emptyTrash returns the server’s count, evicts only trashed rows, sweeps nothing', async () => {
    const live = serverPost({ title: 'Live' });
    const dead = serverPost({ title: 'Dead', deletedAt: Date.now() });
    await cachePost(USER, live);
    await cachePost(USER, dead);
    vi.mocked(api.emptyTrash).mockResolvedValue(1);

    expect(await emptyTrash()).toBe(1);

    expect(await db.posts.get(live.id)).toBeDefined();
    expect(await db.posts.get(dead.id)).toBeUndefined();
    expect(await db.postList.get(dead.id)).toBeUndefined();
    expect(vi.mocked(api.collectOrphanImages)).not.toHaveBeenCalled();
  });
});

describe('sweepBlankDrafts', () => {
  /** Blank on every criterion `isBlankDraft` checks, and past the grace window. */
  const aged = (over: Partial<Post> = {}) =>
    serverPost({
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      updatedAt: Date.now() - 120_000,
      ...over,
    });

  it('delegates to the writer-scoped route and evicts what it says it swept', async () => {
    const blank = aged();
    await cachePost(USER, blank);
    vi.mocked(api.sweepBlankDrafts).mockResolvedValue(1);

    expect(await sweepBlankDrafts('p_open')).toBe(1);

    expect(vi.mocked(api.sweepBlankDrafts)).toHaveBeenCalledWith('p_open');
    expect(await db.posts.get(blank.id)).toBeUndefined();
  });

  it('evicts nothing when the server swept nothing', async () => {
    const blank = aged();
    await cachePost(USER, blank);
    vi.mocked(api.sweepBlankDrafts).mockResolvedValue(0);

    expect(await sweepBlankDrafts()).toBe(0);
    expect(await db.posts.get(blank.id)).toBeDefined();
  });

  it('never evicts the post being edited, whatever the count says', async () => {
    const open = aged();
    await cachePost(USER, open);
    vi.mocked(api.sweepBlankDrafts).mockResolvedValue(1);

    await sweepBlankDrafts(open.id);
    // Taking this row would replace an open editor with the deletion tombstone.
    expect(await db.posts.get(open.id)).toBeDefined();
  });
});

// -------------------------------------------------------- filter and sort

describe('filter and sort', () => {
  const base: Query = {
    status: 'all',
    search: '',
    category: null,
    tag: null,
    sort: 'updated',
  };

  const row = (over: Partial<Post>): Post => createDraftShape({ id: `x_${(n += 1)}`, ...over });
  const listRow = (p: Post): ListPost => {
    const { content: _dropped, ...rest } = p;
    return rest;
  };

  it('hides trashed posts from every non-trash view', () => {
    const visible = row({ title: 'Visible' });
    const gone = row({ title: 'Gone', deletedAt: Date.now() });
    const all = [visible, gone];
    expect(filterAndSort(all, base).map((p) => p.id)).toEqual([visible.id]);
    expect(filterAndSort(all, { ...base, status: 'trash' }).map((p) => p.id)).toEqual([gone.id]);
  });

  it('searches title, tags and body', () => {
    const all = [
      row({ title: 'Alpha', tags: ['gardening'], content: para('a needle in the haystack') }),
      row({ title: 'Beta' }),
    ];
    for (const term of ['alpha', 'GARDENING', 'needle']) {
      expect(filterAndSort(all, { ...base, search: term })).toHaveLength(1);
    }
    expect(filterAndSort(all, { ...base, search: 'nonsense' })).toHaveLength(0);
  });

  it('searches a body when the row has one, and the metadata when it does not', () => {
    /*
     * F13/§4: the dashboard's rows come from `db.postList` and `ListPost` is
     * `Omit<Post, 'content'>`, while the editor's store still holds full posts.
     * Both shapes go through this function, and the difference is visible: a
     * word that exists only in the document is findable in one and not in the
     * other. That is why §5 sends a non-empty search to the server rather than
     * answering it from whatever happens to be cached.
     */
    const withBody = row({ title: 'Findable', content: para('a needle in the haystack') });
    const asListRow: ListPost[] = [listRow(withBody)];

    expect(filterAndSort([withBody], { ...base, search: 'needle' })).toHaveLength(1);
    expect(filterAndSort(asListRow, { ...base, search: 'needle' })).toHaveLength(0);
    expect(filterAndSort(asListRow, { ...base, search: 'findable' })).toHaveLength(1);
  });

  it('sorts alphabetically with untitled posts included', () => {
    const all = [row({ title: 'Zebra' }), row({ title: '' }), row({ title: 'apple' })];
    const titles = filterAndSort(all, { ...base, sort: 'alphabetical' }).map(
      (p) => p.title || 'Untitled',
    );
    expect(titles).toEqual(['apple', 'Untitled', 'Zebra']);
  });

  it('puts drafts before published under drafts-first', () => {
    const pub = row({ title: 'Pub', status: 'published' });
    const draft = row({ title: 'Draft' });
    const arch = row({ title: 'Arch', status: 'archived' });
    const order = filterAndSort([pub, draft, arch], { ...base, sort: 'drafts-first' }).map(
      (p) => p.id,
    );
    expect(order).toEqual([draft.id, pub.id, arch.id]);
  });

  it('sorts posts that were never published without crashing', () => {
    const never = row({ title: 'A' });
    const published = row({ title: 'B', status: 'published', publishedAt: Date.now() });
    expect(filterAndSort([never, published], { ...base, sort: 'published' })[0].id).toBe(
      published.id,
    );
  });
});
