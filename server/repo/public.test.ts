/**
 * The public read surface (plan Part 1), against a real Postgres.
 *
 * WHAT THIS FILE IS FOR, IN ONE LINE: proving that no row outside
 * `PUBLIC_POST_PREDICATE` and no field outside `FIELD_DISPOSITION`'s `'public'`
 * set can leave the building.
 *
 * THE MUTATION TESTS ARE THE POINT. The project's ledger records a round where
 * every CAS guard in the write path could be replaced with `true` and 254 tests
 * stayed green — a suite that asserts the happy path is not evidence that a
 * guard does anything. So for each of the four conjuncts there is a test that
 * (a) runs the SAME query with that conjunct dropped, from the SAME record the
 * production predicate is built from, and proves a NAMED row appears, then
 * (b) proves the real function does not return it. Delete the conjunct from
 * `PUBLIC_POST_CONJUNCTS` and (b) goes red; weaken the corpus so the row no
 * longer exercises it and (a) goes red. Neither half is sufficient alone, which
 * is why both are in every one of them.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { freshDb, type TestCtx } from '../test/harness';
import { archivePost, createPost, publishPost, trashPost } from './posts';
import { BadRequestError } from './errors';
import {
  FIELD_DISPOSITION,
  PUBLIC_LIST_OMITS,
  normalizeBlobId,
  publicImageUrl,
  rowToPublicPost,
} from './public-projection';
import {
  PUBLIC_CONJUNCT_ORDER,
  PUBLIC_POST_CONJUNCTS,
  PUBLIC_POST_PREDICATE,
  getPublicPostBySlug,
  listPublicPosts,
  predicateWithout,
  publicCategories,
  publicFeedPosts,
  publicSitemapEntries,
  publicTags,
  type PublicConjunct,
  type PublicSortKey,
} from './public';
import type { Post } from '../../shared/types';

let ctx: TestCtx;

/** The adversarial corpus. Every field that decides visibility is pinned. */
const corpus: Record<string, Post> = {};

/** A document with some words in it, so `search` and `wordCount` are real. */
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

beforeAll(async () => {
  ctx = await freshDb();
  const { db } = ctx;
  const owner = ctx.users.owner;

  // 1. A normal published post, with a PREFIXED cover blobId.
  corpus.live1 = await createPost(db, owner, {
    title: 'Alpha Lighthouse',
    subtitle: 'on keeping a light',
    slug: 'alpha-lighthouse',
    category: 'Essays',
    tags: ['ocean', 'light'],
    publishedAt: 3000,
    content: doc('the lamp turns through the fog every seven seconds'),
    coverImage: {
      blobId: 'asset:img_cover1',
      alt: 'a lamp',
      focalPoint: '40% 60%',
      width: 800,
      height: 600,
    },
  });
  corpus.live1 = await publishPost(db, corpus.live1.id, owner);

  // 2. A second published post, with a BARE cover blobId.
  corpus.live2 = await createPost(db, owner, {
    title: 'Beta Harbour',
    slug: 'beta-harbour',
    category: 'Notes',
    tags: ['ocean'],
    publishedAt: 2000,
    content: doc('the harbour empties at low tide'),
    coverImage: {
      blobId: 'img_cover2',
      alt: 'a harbour',
      focalPoint: '50% 50%',
      width: 100,
      height: 100,
    },
  });
  corpus.live2 = await publishPost(db, corpus.live2.id, owner);

  // 3. A draft, carrying a DISTINCTIVE category and tag — the vocabulary that
  //    must never reach the taxonomy routes.
  corpus.draft = await createPost(db, owner, {
    title: 'Draft Secret',
    slug: 'draft-secret',
    category: 'SecretCategory',
    tags: ['secret-tag'],
    content: doc('unannounced project'),
  });

  // 4. Archived: published once, so it keeps its slug and its date, and only
  //    `status` excludes it.
  corpus.archived = await createPost(db, owner, {
    title: 'Archived One',
    slug: 'archived-one',
    category: 'ArchiveCategory',
    tags: ['archive-tag'],
    publishedAt: 1500,
    content: doc('shelved for now'),
  });
  corpus.archived = await publishPost(db, corpus.archived.id, owner);
  corpus.archived = await archivePost(db, corpus.archived.id, owner);

  // 5. Trashed BUT STILL `status = 'published'` — trash is a view, not a status.
  corpus.trashed = await createPost(db, owner, {
    title: 'Trashed One',
    slug: 'trashed-one',
    category: 'TrashCategory',
    tags: ['trash-tag'],
    publishedAt: 1400,
    content: doc('binned but still published'),
  });
  corpus.trashed = await publishPost(db, corpus.trashed.id, owner);
  corpus.trashed = await trashPost(db, corpus.trashed.id, owner);

  // 6. Published with a NULL slug — no title-derived slug, because `createPost`
  //    only slugifies a SUPPLIED slug.
  corpus.noSlug = await createPost(db, owner, {
    title: 'No Slug',
    status: 'published',
    publishedAt: 1300,
    category: 'SluglessCategory',
    tags: ['slugless-tag'],
    content: doc('published with no address'),
  });

  // 7. Published with a NULL `published_at` — exactly how `POST /api/import`
  //    creates one: `status` and `publishedAt` are bound independently.
  corpus.noDate = await createPost(db, owner, {
    title: 'No Date',
    slug: 'no-date',
    status: 'published',
    publishedAt: null,
    category: 'DatelessCategory',
    tags: ['dateless-tag'],
    content: doc('imported without a date'),
  });
});

afterAll(async () => {
  await ctx.close();
});

/** The ids the public set legitimately contains — everything else is a leak. */
const legitimate = () => [corpus.live1.id, corpus.live2.id].sort();

async function idsMatching(predicate: SQL): Promise<string[]> {
  const res = await ctx.db.execute(sql`
    SELECT p.id FROM posts p WHERE ${predicate} ORDER BY p.id`);
  return res.rows.map((row) => String(row.id));
}

describe('the corpus itself', () => {
  it('really contains each adversarial shape', () => {
    expect(corpus.draft.status).toBe('draft');
    expect(corpus.archived.status).toBe('archived');
    // The one a status-only filter misses.
    expect(corpus.trashed.status).toBe('published');
    expect(corpus.trashed.deletedAt).not.toBeNull();
    expect(corpus.noSlug.status).toBe('published');
    expect(corpus.noSlug.slug).toBeNull();
    expect(corpus.noSlug.publishedAt).toBe(1300);
    expect(corpus.noDate.status).toBe('published');
    expect(corpus.noDate.slug).toBe('no-date');
    expect(corpus.noDate.publishedAt).toBeNull();
    expect(corpus.live1.publishedAt).toBe(3000);
    expect(corpus.live2.publishedAt).toBe(2000);
  });
});

describe('every public query returns only the published set', () => {
  it('listPublicPosts', async () => {
    const { items } = await listPublicPosts(ctx.db);
    expect(items.map((p) => p.id).sort()).toEqual(legitimate());
  });

  it('listPublicPosts, under every offered sort', async () => {
    for (const sort of ['published', 'oldest', 'alphabetical'] as PublicSortKey[]) {
      const { items } = await listPublicPosts(ctx.db, { sort });
      expect(items.map((p) => p.id).sort(), sort).toEqual(legitimate());
    }
  });

  it('getPublicPostBySlug — the legitimate slugs, and only those', async () => {
    expect((await getPublicPostBySlug(ctx.db, 'alpha-lighthouse'))?.id).toBe(corpus.live1.id);
    expect(await getPublicPostBySlug(ctx.db, 'draft-secret')).toBeNull();
    expect(await getPublicPostBySlug(ctx.db, 'archived-one')).toBeNull();
    expect(await getPublicPostBySlug(ctx.db, 'trashed-one')).toBeNull();
    expect(await getPublicPostBySlug(ctx.db, 'no-date')).toBeNull();
    // Absent and unpublished are the same answer, from the same code path (T7).
    expect(await getPublicPostBySlug(ctx.db, 'never-existed')).toBeNull();
  });

  it('publicFeedPosts', async () => {
    const feed = await publicFeedPosts(ctx.db);
    expect(feed.map((p) => p.id).sort()).toEqual(legitimate());
    // Newest first — and both dates are non-null, which is what the fourth
    // conjunct buys the RSS `pubDate`.
    expect(feed.map((p) => p.publishedAt)).toEqual([3000, 2000]);
  });

  it('publicSitemapEntries', async () => {
    const entries = await publicSitemapEntries(ctx.db);
    expect(entries.map((e) => e.slug).sort()).toEqual(['alpha-lighthouse', 'beta-harbour']);
    for (const entry of entries) {
      expect(typeof entry.publishedAt).toBe('number');
      expect(entry.publishedAt).not.toBeNaN();
    }
  });

  it('publicCategories', async () => {
    expect(await publicCategories(ctx.db)).toEqual([
      { value: 'Essays', count: 1 },
      { value: 'Notes', count: 1 },
    ]);
  });

  it('publicTags', async () => {
    expect(await publicTags(ctx.db)).toEqual([
      { value: 'ocean', count: 2 },
      { value: 'light', count: 1 },
    ]);
  });
});

describe('taxonomy leaks the vocabulary of unpublished work', () => {
  it('no draft, archived, trashed, slugless or dateless CATEGORY appears', async () => {
    const values = (await publicCategories(ctx.db)).map((t) => t.value);
    for (const hidden of [
      'SecretCategory',
      'ArchiveCategory',
      'TrashCategory',
      'SluglessCategory',
      'DatelessCategory',
    ]) {
      expect(values, hidden).not.toContain(hidden);
    }
  });

  it('no draft, archived, trashed, slugless or dateless TAG appears', async () => {
    const values = (await publicTags(ctx.db)).map((t) => t.value);
    for (const hidden of [
      'secret-tag',
      'archive-tag',
      'trash-tag',
      'slugless-tag',
      'dateless-tag',
    ]) {
      expect(values, hidden).not.toContain(hidden);
    }
  });

  it('the counts are over published rows only', async () => {
    // `ocean` is on live1, live2 — and nothing else. A count of 2 rather than a
    // count over the whole table is the assertion.
    const ocean = (await publicTags(ctx.db)).find((t) => t.value === 'ocean');
    expect(ocean).toEqual({ value: 'ocean', count: 2 });
  });
});

/**
 * One test per conjunct. Each proves the conjunct is load-bearing by running the
 * production predicate MINUS that conjunct and naming the row it lets through.
 */
describe('mutation: each conjunct of PUBLIC_POST_PREDICATE is load-bearing', () => {
  const cases: { conjunct: PublicConjunct; leaks: string; why: string }[] = [
    { conjunct: 'status', leaks: 'archived', why: 'an archived post keeps its slug and its date' },
    { conjunct: 'deleted_at', leaks: 'trashed', why: 'a trashed post keeps status published' },
    { conjunct: 'slug', leaks: 'noSlug', why: 'a published post can have no slug' },
    { conjunct: 'published_at', leaks: 'noDate', why: 'an import can publish with no date' },
  ];

  it('there are exactly four, and they are the four named', () => {
    expect(Object.keys(PUBLIC_POST_CONJUNCTS).sort()).toEqual(
      ['deleted_at', 'published_at', 'slug', 'status'].sort(),
    );
    expect([...PUBLIC_CONJUNCT_ORDER].sort()).toEqual(
      Object.keys(PUBLIC_POST_CONJUNCTS).sort(),
    );
    expect(cases.map((c) => c.conjunct).sort()).toEqual(
      [...PUBLIC_CONJUNCT_ORDER].sort(),
    );
  });

  for (const { conjunct, leaks, why } of cases) {
    it(`removing "${conjunct}" leaks ${leaks} — ${why}`, async () => {
      const full = await idsMatching(PUBLIC_POST_PREDICATE);
      const weakened = await idsMatching(predicateWithout(conjunct));
      const leaked = corpus[leaks].id;

      // (a) the corpus really exercises this conjunct: without it, and ONLY
      //     without it, this specific row is visible.
      expect(weakened).toContain(leaked);
      expect(weakened.filter((id) => !full.includes(id))).toEqual([leaked]);

      // (b) with the conjunct in place, no public function returns it. This is
      //     the half that goes red if someone deletes the conjunct.
      expect(full).not.toContain(leaked);
      const { items } = await listPublicPosts(ctx.db);
      expect(items.map((p) => p.id)).not.toContain(leaked);
      expect((await publicFeedPosts(ctx.db)).map((p) => p.id)).not.toContain(leaked);
      const slug = corpus[leaks].slug;
      if (slug) expect(await getPublicPostBySlug(ctx.db, slug)).toBeNull();
      expect((await publicSitemapEntries(ctx.db)).map((e) => e.slug)).not.toContain(slug);
    });
  }

  it('the migration index predicate matches PUBLIC_POST_PREDICATE conjunct for conjunct', () => {
    // Derived from the same record the runtime uses rather than transcribed —
    // a second copy of the predicate is the drift this asserts against.
    const runtime = new PgDialect()
      .sqlToQuery(PUBLIC_POST_PREDICATE)
      .sql.replace(/\bp\./g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const migration = readFileSync(
      'server/db/migrations/0005_public_reading.sql',
      'utf8',
    )
      .replace(/^--.*$/gm, '')
      .replace(/\s+/g, ' ');
    expect(migration).toContain(`WHERE ${runtime}`);
  });
});

describe('the projection is an allow-list, not a filtered Post', () => {
  const publicFields = (Object.keys(FIELD_DISPOSITION) as (keyof Post)[]).filter(
    (key) => FIELD_DISPOSITION[key] === 'public',
  );

  /**
   * `authorName` is a RESHAPE, not a passthrough: the map classifies the
   * underlying `Post` field and the mapper renames it to `author: { name }`.
   * Spelled out here so the rename is asserted rather than assumed.
   */
  const RESHAPED: Partial<Record<keyof Post, string>> = { authorName: 'author' };
  const expectedListKeys = publicFields
    .filter((key) => !PUBLIC_LIST_OMITS.includes(key))
    .map((key) => RESHAPED[key] ?? key)
    .sort();

  it('every field of Post is classified', () => {
    // The compile-time control is `Record<keyof Post, …>`; this is its runtime
    // shadow, and it catches a `Post` field deleted rather than added.
    expect(Object.keys(FIELD_DISPOSITION).length).toBe(21);
    for (const disposition of Object.values(FIELD_DISPOSITION)) {
      expect(['public', 'private']).toContain(disposition);
    }
  });

  it('a built PublicPost has EXACTLY the public fields, minus content', async () => {
    const { items } = await listPublicPosts(ctx.db);
    expect(Object.keys(items[0]).sort()).toEqual(expectedListKeys);
  });

  it('a built PublicPostDetail is that plus content, and nothing else', async () => {
    const detail = await getPublicPostBySlug(ctx.db, 'alpha-lighthouse');
    expect(Object.keys(detail!).sort()).toEqual([...expectedListKeys, 'content'].sort());
  });

  it('the private fields are absent from EVERY public shape', async () => {
    const priv = ['authorId', 'deletedAt', 'revision', 'status', 'excerptSource', 'createdAt'];
    const { items } = await listPublicPosts(ctx.db);
    const detail = await getPublicPostBySlug(ctx.db, 'alpha-lighthouse');
    const feed = await publicFeedPosts(ctx.db);
    for (const shape of [...items, detail as object, ...feed]) {
      for (const key of priv) {
        expect(Object.keys(shape), key).not.toContain(key);
      }
      // And nothing that even looks like the author's identity.
      expect(JSON.stringify(shape)).not.toContain('owner@test.local');
    }
  });

  it('the byline is a name and only a name', async () => {
    const { items } = await listPublicPosts(ctx.db);
    expect(items[0].author).toEqual({ name: 'Owner' });
    expect(Object.keys(items[0].author)).toEqual(['name']);
  });

  it('the mapper reads the row, so an extra column cannot ride along', async () => {
    const res = await ctx.db.execute(sql`
      SELECT p.*, u.display_name AS author_name
        FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ${corpus.live1.id}`);
    // `SELECT *` hands the mapper `content_text`, `search`, `author_id`,
    // `lifecycle_generation` and every other column. None of them survives.
    const built = rowToPublicPost(res.rows[0], 'Owner');
    expect(Object.keys(built).sort()).toEqual(expectedListKeys);
  });
});

describe('cover images', () => {
  it('a prefixed blobId is normalized before the URL is built', async () => {
    const post = await getPublicPostBySlug(ctx.db, 'alpha-lighthouse');
    expect(post!.coverImage).toEqual({
      url: '/api/public/images/img_cover1',
      alt: 'a lamp',
      focalPoint: '40% 60%',
      width: 800,
      height: 600,
    });
  });

  it('a bare blobId resolves to the same shape of URL', async () => {
    const post = await getPublicPostBySlug(ctx.db, 'beta-harbour');
    expect(post!.coverImage?.url).toBe('/api/public/images/img_cover2');
  });

  it('normalizeBlobId strips only the two historical prefixes', () => {
    expect(normalizeBlobId('asset:img_a')).toBe('img_a');
    expect(normalizeBlobId('idb:img_a')).toBe('img_a');
    expect(normalizeBlobId('img_a')).toBe('img_a');
    expect(normalizeBlobId('other:img_a')).toBe('other:img_a');
  });

  it('publicImageUrl is the one definition of the public image URL', () => {
    expect(publicImageUrl('img_x')).toBe('/api/public/images/img_x');
  });

  it('no cover is null, not a URL to nothing', async () => {
    const res = await ctx.db.execute(sql`
      SELECT p.*, u.display_name AS author_name
        FROM posts p JOIN users u ON u.id = p.author_id
       WHERE p.id = ${corpus.draft.id}`);
    expect(rowToPublicPost(res.rows[0], 'Owner').coverImage).toBeNull();
  });
});

describe('the list query surface', () => {
  it('sorts newest-published first by default', async () => {
    const { items } = await listPublicPosts(ctx.db);
    expect(items.map((p) => p.slug)).toEqual(['alpha-lighthouse', 'beta-harbour']);
  });

  it('paginates by cursor without skipping or repeating', async () => {
    const first = await listPublicPosts(ctx.db, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPublicPosts(ctx.db, { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([first.items[0].id, second.items[0].id].sort()).toEqual(legitimate());
  });

  it('filters by category and by tag, still inside the predicate', async () => {
    expect((await listPublicPosts(ctx.db, { category: 'Essays' })).items).toHaveLength(1);
    // The draft's category matches nothing, because the draft is not in the set.
    expect((await listPublicPosts(ctx.db, { category: 'SecretCategory' })).items).toEqual([]);
    expect((await listPublicPosts(ctx.db, { tag: 'ocean' })).items).toHaveLength(2);
    expect((await listPublicPosts(ctx.db, { tag: 'secret-tag' })).items).toEqual([]);
  });

  it('searches, and cannot reach an unpublished document', async () => {
    expect((await listPublicPosts(ctx.db, { search: 'lamp' })).items).toHaveLength(1);
    expect((await listPublicPosts(ctx.db, { search: 'unannounced' })).items).toEqual([]);
  });

  it('refuses a sort it does not offer', async () => {
    for (const sort of ['updated', 'drafts-first', 'nonsense']) {
      await expect(
        listPublicPosts(ctx.db, { sort: sort as PublicSortKey }),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
  });

  it('refuses a limit out of range rather than clamping it', async () => {
    await expect(listPublicPosts(ctx.db, { limit: 0 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(listPublicPosts(ctx.db, { limit: 101 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a NUL in any text filter rather than 500ing at the driver', async () => {
    const nul = String.fromCharCode(0);
    await expect(listPublicPosts(ctx.db, { search: nul })).rejects.toBeInstanceOf(BadRequestError);
    await expect(listPublicPosts(ctx.db, { category: nul })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(listPublicPosts(ctx.db, { tag: nul })).rejects.toBeInstanceOf(BadRequestError);
    await expect(getPublicPostBySlug(ctx.db, nul)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a cursor minted under another sort', async () => {
    const { nextCursor } = await listPublicPosts(ctx.db, { limit: 1, sort: 'published' });
    await expect(
      listPublicPosts(ctx.db, { limit: 1, sort: 'oldest', cursor: nextCursor! }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('bounds the sitemap at the protocol ceiling rather than truncating silently', async () => {
    await expect(publicSitemapEntries(ctx.db, 50_001)).rejects.toBeInstanceOf(BadRequestError);
    await expect(publicFeedPosts(ctx.db, 0)).rejects.toBeInstanceOf(BadRequestError);
  });
});
