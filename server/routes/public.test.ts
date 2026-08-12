/**
 * The public reading API over HTTP (plan Parts 2 and 4).
 *
 * WHAT IS NEW HERE, AND WHY THE REPO SUITES DO NOT COVER IT. `server/repo/
 * public.test.ts` proves the predicate and `server/repo/public-images.test.ts`
 * proves the reference check. Everything below is reachable ONLY through the
 * seam: the strict query schema (there must be no way to spell `status`), the
 * opaque validators and their `304`, the CORS header on the ERROR paths, the
 * rate limiter's placement, and the XML.
 *
 * THE ASSERTIONS ARE AGAINST THE RAW SERIALIZED BODY, not the parsed object,
 * wherever a leak is what is being ruled out. `expect(body).not.toHaveProperty`
 * passes happily for a field nested three levels down; a substring check over
 * the bytes that actually leave the process does not.
 *
 * R2 IS STUBBED AND ONLY R2, exactly as `server/routes/images.test.ts` does it:
 * the database, the router, the error handler and the whole public repo are
 * real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { SaxesParser } from 'saxes';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { TEST_ORIGIN, httpClient, json, type HttpClient } from '../test/http';
import {
  CACHE,
  PUBLIC_LIMIT,
  PUBLIC_LIMIT_WINDOW_MS,
  ifModifiedSinceHits,
  ifNoneMatchHits,
  xmlEscape,
  xmlSafe,
} from './public';
import { decodeCursor } from '../repo/cursor';
import { FIELD_DISPOSITION } from '../repo/public-projection';
import { archivePost, createPost, publishPost, trashPost } from '../repo/posts';
import type { AuthUser, DocNode, Post, PublicPost, PublicPostDetail } from '../../shared/types';

vi.mock('../storage/r2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/r2')>()),
  presignGet: vi.fn(async (key: string) => `https://r2.test/${key}?get`),
}));

let ctx: TestCtx;
let anon: HttpClient;

const NUL = String.fromCharCode(0);

const doc = (text: string): DocNode =>
  ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) as DocNode;

const docWithImage = (id: string): DocNode =>
  ({
    type: 'doc',
    content: [{ type: 'image', attrs: { src: `asset:${id}` } }],
  }) as DocNode;

const cover = (blobId: string) => ({
  blobId,
  alt: 'a cover',
  focalPoint: '50% 50%',
  width: 10,
  height: 10,
});

const owner = (): AuthUser => ctx.users.owner;

/** A committed image row, placed directly so the test controls every column. */
async function seedImage(id: string, committed = true): Promise<void> {
  const user = owner();
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at, unreferenced_since)
    VALUES (${id}, ${user.id}::uuid, ${`images/${user.id}/${id}`}, 'image/png',
            NULL, NULL, 1000, NULL, ${now}, ${committed ? now : null}, NULL)`);
}

async function seedRevision(postId: string, content: DocNode): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO revisions (id, post_id, revision, created_at, author_id, title,
                           subtitle, content, word_count, kind)
    VALUES (${`r_${postId}`}, ${postId}, 99, ${Date.now()}, ${owner().id}::uuid,
            'Live', '', ${JSON.stringify(content)}::jsonb, 3, 'manual')`);
}

/**
 * THE ADVERSARIAL CORPUS, seeded once and reached only over HTTP.
 *
 * Six rows exist purely to be absent from every response: a draft, an archived
 * post, a trashed-but-still-`status='published'` post, a published post with a
 * null slug, a published post with a null `published_at` (which `status` does
 * NOT imply — see `PUBLIC_POST_CONJUNCTS`), and three images reachable only from
 * something unpublished.
 */
const corpus: Record<string, Post> = {};

beforeAll(async () => {
  ctx = await freshDb();
  const { db } = ctx;
  const user = owner();

  await seedImage('img_cover');
  await seedImage('img_inline');
  await seedImage('img_draft');
  await seedImage('img_revision');
  await seedImage('img_uncommitted', false);

  corpus.live1 = await createPost(db, user, {
    title: 'Alpha Lighthouse',
    subtitle: 'on keeping a light',
    slug: 'alpha-lighthouse',
    excerpt: 'fog & light <lamps>',
    category: 'Essays',
    tags: ['ocean', 'light'],
    publishedAt: 3000,
    content: docWithImage('img_inline'),
    coverImage: cover('asset:img_cover'),
  });
  corpus.live1 = await publishPost(db, corpus.live1.id, user);

  corpus.live2 = await createPost(db, user, {
    title: 'Beta Harbour',
    slug: 'beta-harbour',
    category: 'Notes',
    tags: ['ocean'],
    publishedAt: 2000,
    content: doc('the harbour empties at low tide'),
  });
  corpus.live2 = await publishPost(db, corpus.live2.id, user);
  // An image that WAS in the published post and has since been cut: history
  // keeps the bytes, publication does not.
  await seedRevision(corpus.live2.id, docWithImage('img_revision'));

  // A published post whose inline image was never committed — the magic-byte
  // check has not run, so the bytes are whatever the uploader called a PNG.
  corpus.live3 = await createPost(db, user, {
    title: 'Gamma Jetty',
    slug: 'gamma-jetty',
    category: 'Notes',
    tags: ['ocean'],
    publishedAt: 1000,
    content: docWithImage('img_uncommitted'),
  });
  corpus.live3 = await publishPost(db, corpus.live3.id, user);

  corpus.draft = await createPost(db, user, {
    title: 'Draft Secret',
    slug: 'draft-secret',
    category: 'SecretCategory',
    tags: ['secret-tag'],
    content: docWithImage('img_draft'),
  });

  corpus.archived = await createPost(db, user, {
    title: 'Archived One',
    slug: 'archived-one',
    category: 'ArchiveCategory',
    tags: ['archive-tag'],
    publishedAt: 1500,
    content: doc('shelved for now'),
  });
  corpus.archived = await publishPost(db, corpus.archived.id, user);
  corpus.archived = await archivePost(db, corpus.archived.id, user);

  corpus.trashed = await createPost(db, user, {
    title: 'Trashed One',
    slug: 'trashed-one',
    category: 'TrashCategory',
    tags: ['trash-tag'],
    publishedAt: 1400,
    content: doc('binned but still published'),
  });
  corpus.trashed = await publishPost(db, corpus.trashed.id, user);
  corpus.trashed = await trashPost(db, corpus.trashed.id, user);

  // Published with NO slug: listable and unopenable, so the list and the detail
  // route would disagree about what exists.
  corpus.noSlug = await createPost(db, user, {
    title: 'No Slug At All',
    category: 'NoSlugCategory',
    tags: ['no-slug-tag'],
    publishedAt: 1300,
    status: 'published',
    content: doc('nowhere to point at'),
  });
  await ctx.db.execute(sql`UPDATE posts SET slug = NULL WHERE id = ${corpus.noSlug.id}`);

  // Published with a NULL date, which `status = 'published'` does not imply:
  // `POST /api/import` forwards both fields straight from a bundle.
  corpus.noDate = await createPost(db, user, {
    title: 'No Date',
    slug: 'no-date',
    category: 'NoDateCategory',
    tags: ['no-date-tag'],
    status: 'published',
    content: doc('imported without a date'),
  });
  await ctx.db.execute(sql`UPDATE posts SET published_at = NULL WHERE id = ${corpus.noDate.id}`);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  anon = httpClient(ctx.db);
});

/** The three slugs that legitimately exist on this surface. */
const LIVE_SLUGS = ['alpha-lighthouse', 'beta-harbour', 'gamma-jetty'];

/** Slugs, categories and tags that must never appear in any public response. */
const FORBIDDEN_VOCABULARY = [
  'draft-secret',
  'archived-one',
  'trashed-one',
  'no-date',
  'No Slug At All',
  'SecretCategory',
  'ArchiveCategory',
  'TrashCategory',
  'NoSlugCategory',
  'NoDateCategory',
  'secret-tag',
  'archive-tag',
  'trash-tag',
  'no-slug-tag',
  'no-date-tag',
];

const PUBLIC_ROUTES = [
  '/api/public/posts',
  '/api/public/posts/alpha-lighthouse',
  '/api/public/feed.xml',
  '/api/public/sitemap.xml',
  '/api/public/categories',
  '/api/public/tags',
];

// ------------------------------------------------------- the corpus, per route

describe('every public route exposes only the published rows', () => {
  it('the list carries the three live posts and nothing else', async () => {
    const res = await anon.get('/api/public/posts');
    expect(res.status).toBe(200);
    const body = await json<{ items: PublicPost[]; nextCursor: string | null }>(res);
    expect(body.items.map((p) => p.slug).sort()).toEqual([...LIVE_SLUGS].sort());
  });

  it('no route leaks any unpublished slug, category or tag', async () => {
    for (const path of PUBLIC_ROUTES) {
      const text = await (await anon.get(path)).text();
      for (const term of FORBIDDEN_VOCABULARY) {
        expect(`${path} :: ${term} :: ${text.includes(term)}`).toBe(`${path} :: ${term} :: false`);
      }
    }
  });

  it('the feed carries only published posts, newest first', async () => {
    const xml = await (await anon.get('/api/public/feed.xml')).text();
    const titles = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Alpha Lighthouse', 'Beta Harbour', 'Gamma Jetty']);
  });

  it('the sitemap carries only published slugs', async () => {
    const xml = await (await anon.get('/api/public/sitemap.xml')).text();
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    // Built from the origin the APP was constructed with, not from the process
    // environment — see "the feed builds links from the app's own origins".
    expect(locs).toEqual(LIVE_SLUGS.map((s) => `${TEST_ORIGIN}/posts/${s}`));
  });

  it('the taxonomies exclude draft and trashed vocabulary', async () => {
    const cats = await json<{ items: { name: string; count: number }[] }>(
      await anon.get('/api/public/categories'),
    );
    expect(cats.items.map((t) => t.name).sort()).toEqual(['Essays', 'Notes']);
    expect(cats.items.find((t) => t.name === 'Notes')?.count).toBe(2);

    const tags = await json<{ items: { name: string; count: number }[] }>(
      await anon.get('/api/public/tags'),
    );
    expect(tags.items.map((t) => t.name).sort()).toEqual(['light', 'ocean']);
    expect(tags.items.find((t) => t.name === 'ocean')?.count).toBe(3);
  });
});

// -------------------------------------------------------------- field leakage

describe('the serialized body never carries an internal field', () => {
  const BANNED = ['authorId', 'deletedAt', 'revision', 'excerptSource', 'createdAt', 'status'];

  it('not on any route, checked over the raw bytes', async () => {
    for (const path of PUBLIC_ROUTES) {
      const text = await (await anon.get(path)).text();
      for (const field of BANNED) {
        expect(`${path} :: ${field} :: ${text.includes(field)}`).toBe(
          `${path} :: ${field} :: false`,
        );
      }
      expect(text.includes('@test.local')).toBe(false);
      expect(text.includes(owner().id)).toBe(false);
    }
  });

  it('the byline is a name and nothing else', async () => {
    const { post } = await json<{ post: PublicPostDetail }>(
      await anon.get('/api/public/posts/alpha-lighthouse'),
    );
    expect(post.author).toEqual({ name: 'Owner' });
  });
});

// --------------------------------------------------------------- query schema

describe('the list query is strict and cannot name a status', () => {
  it('refuses `status`', async () => {
    const res = await anon.get('/api/public/posts?status=draft');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'status' });
  });

  it('refuses any other unknown key', async () => {
    expect((await anon.get('/api/public/posts?statuss=draft')).status).toBe(400);
    expect((await anon.get('/api/public/posts?deleted=1')).status).toBe(400);
  });

  it('refuses a sort this surface does not offer', async () => {
    expect((await anon.get('/api/public/posts?sort=updated')).status).toBe(400);
    expect((await anon.get('/api/public/posts?sort=drafts-first')).status).toBe(400);
  });

  it('accepts the six keys it does offer', async () => {
    const res = await anon.get('/api/public/posts?category=Notes&tag=ocean&limit=1&sort=oldest');
    expect(res.status).toBe(200);
    const body = await json<{ items: PublicPost[]; nextCursor: string | null }>(res);
    // Two posts match `category=Notes` AND `tag=ocean`; `limit=1` returns one of
    // them and mints a cursor for the other.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].category).toBe('Notes');
    expect(body.items[0].tags).toContain('ocean');
    expect(body.nextCursor).not.toBeNull();
  });

  it('each offered sort orders by the column it names', async () => {
    const slugs = async (sort: string) =>
      (
        await json<{ items: PublicPost[] }>(await anon.get(`/api/public/posts?sort=${sort}`))
      ).items.map((p) => p.slug);

    // `published` is `published_at DESC` — 3000, 2000, 1000.
    expect(await slugs('published')).toEqual(['alpha-lighthouse', 'beta-harbour', 'gamma-jetty']);
    /*
     * `oldest` is `published_at ASC` on THIS surface (see `PUBLIC_SORTS_PARTS`)
     * — 1000, 2000, 3000, i.e. the reverse of `published`, and deliberately NOT
     * the shared `SORTS.oldest`, whose `created_at` is `'private'` and leaked
     * through the cursor. Creation order here is alpha, beta, gamma, so the two
     * orderings are distinguishable and this assertion pins which one runs.
     */
    expect(await slugs('oldest')).toEqual(['gamma-jetty', 'beta-harbour', 'alpha-lighthouse']);
    expect(await slugs('alphabetical')).toEqual([
      'alpha-lighthouse',
      'beta-harbour',
      'gamma-jetty',
    ]);
    // The default is `published`.
    expect(await slugs('published')).toEqual(
      (await json<{ items: PublicPost[] }>(await anon.get('/api/public/posts'))).items.map(
        (p) => p.slug,
      ),
    );
  });

  it('a bad limit is a 400, not a 500', async () => {
    expect((await anon.get('/api/public/posts?limit=abc')).status).toBe(400);
    expect((await anon.get('/api/public/posts?limit=1000')).status).toBe(400);
  });
});

// ---------------------------------------------------------------- enumeration

describe('an unpublished slug is indistinguishable from an absent one', () => {
  /** Everything except the per-request id, which differs by definition. */
  async function shape(path: string): Promise<Record<string, unknown>> {
    const res = await anon.get(path);
    const body = (await res.json()) as Record<string, unknown>;
    delete body.requestId;
    const headers = [...res.headers.entries()]
      .filter(([name]) => name !== 'x-request-id')
      .sort(([a], [b]) => a.localeCompare(b));
    return { status: res.status, body, headers };
  }

  it('a draft, an archived, a trashed and an unknown slug are one response', async () => {
    const unknown = await shape('/api/public/posts/nothing-here-at-all');
    expect(unknown).toMatchObject({ status: 404, body: { error: 'gone' } });
    for (const slug of ['draft-secret', 'archived-one', 'trashed-one', 'no-date']) {
      expect(await shape(`/api/public/posts/${slug}`)).toEqual(unknown);
    }
  });

  it('the 404 carries the short positive TTL rather than no-store', async () => {
    const res = await anon.get('/api/public/posts/nothing-here-at-all');
    expect(res.headers.get('cache-control')).toBe(CACHE.notFound);
  });
});

// -------------------------------------------------------------------- caching

describe('caching and conditional requests', () => {
  it('each route carries the Cache-Control the plan specifies', async () => {
    const cc = async (path: string) => (await anon.get(path)).headers.get('cache-control');
    expect(await cc('/api/public/posts')).toBe(CACHE.list);
    expect(await cc('/api/public/posts?search=harbour')).toBe(CACHE.search);
    expect(await cc('/api/public/posts/alpha-lighthouse')).toBe(CACHE.detail);
    expect(await cc('/api/public/feed.xml')).toBe(CACHE.feed);
    expect(await cc('/api/public/sitemap.xml')).toBe(CACHE.feed);
  });

  it('the detail carries Last-Modified', async () => {
    const res = await anon.get('/api/public/posts/alpha-lighthouse');
    const lastModified = res.headers.get('last-modified');
    expect(lastModified).toBeTruthy();
    expect(Number.isNaN(Date.parse(lastModified as string))).toBe(false);
  });

  it('the ETag is opaque — not the revision, not a timestamp', async () => {
    const res = await anon.get('/api/public/posts/alpha-lighthouse');
    const etag = res.headers.get('etag') as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    /*
     * v1 of the plan proposed `"<revision>-<updatedAt>"`, which an anonymous
     * `curl -I` could poll every 30 seconds to watch an author type. Neither
     * value appears, and the shape cannot express them.
     */
    expect(etag).not.toMatch(/^"\d+-\d+"$/);
    expect(etag).not.toContain(String(corpus.live1.updatedAt));
  });

  it('round trips a 304 with no body, on every cacheable route', async () => {
    for (const path of PUBLIC_ROUTES) {
      const first = await anon.get(path);
      const etag = first.headers.get('etag') as string;
      expect(etag).toBeTruthy();

      const second = await anon.get(path, { headers: { 'if-none-match': etag } });
      expect(`${path}:${second.status}`).toBe(`${path}:304`);
      expect(second.headers.get('etag')).toBe(etag);
      expect(await second.text()).toBe('');
    }
  });

  it('matches a W/-prefixed and a multi-value If-None-Match, and `*`', async () => {
    const path = '/api/public/posts/alpha-lighthouse';
    const etag = (await anon.get(path)).headers.get('etag') as string;

    const weak = await anon.get(path, { headers: { 'if-none-match': `W/${etag}` } });
    expect(weak.status).toBe(304);

    const many = await anon.get(path, {
      headers: { 'if-none-match': `"0000", W/"1111", ${etag}` },
    });
    expect(many.status).toBe(304);

    const star = await anon.get(path, { headers: { 'if-none-match': '*' } });
    expect(star.status).toBe(304);

    const miss = await anon.get(path, { headers: { 'if-none-match': '"0000", W/"1111"' } });
    expect(miss.status).toBe(200);
  });

  it('the parser itself, at the unit level', () => {
    expect(ifNoneMatchHits(undefined, '"a"')).toBe(false);
    expect(ifNoneMatchHits('"a"', '"a"')).toBe(true);
    expect(ifNoneMatchHits('W/"a"', '"a"')).toBe(true);
    expect(ifNoneMatchHits(' "x" , W/"a" ', '"a"')).toBe(true);
    expect(ifNoneMatchHits('*', '"a"')).toBe(true);
    expect(ifNoneMatchHits('"ab"', '"a"')).toBe(false);
  });
});

// ----------------------------------------------------------------------- CORS

describe('CORS is on every public response, including the errors', () => {
  it('on a 200', async () => {
    for (const path of PUBLIC_ROUTES) {
      const res = await anon.get(path);
      expect(`${path}:${res.headers.get('access-control-allow-origin')}`).toBe(`${path}:*`);
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('on a 304', async () => {
    const path = '/api/public/posts';
    const etag = (await anon.get(path)).headers.get('etag') as string;
    const res = await anon.get(path, { headers: { 'if-none-match': etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  /*
   * The conditional-request work is the stated win over Ghost's Content API, and
   * without these two a browser cannot use ANY of it: cross-origin JavaScript
   * cannot read `ETag` unless it is exposed, and cannot SEND `If-None-Match`
   * without a preflight to permit it. Both were missing and both are pinned
   * here, on every route rather than a sample.
   */
  it('exposes the validators so cross-origin JS can actually read them', async () => {
    for (const path of PUBLIC_ROUTES) {
      const exposed = (await anon.get(path)).headers.get('access-control-expose-headers') ?? '';
      const names = exposed.toLowerCase();
      expect(`${path}:etag`).toBe(`${path}:${names.includes('etag') ? 'etag' : 'MISSING'}`);
      expect(`${path}:last-modified`).toBe(
        `${path}:${names.includes('last-modified') ? 'last-modified' : 'MISSING'}`,
      );
    }
  });

  it('answers the preflight that If-None-Match provokes', async () => {
    for (const path of PUBLIC_ROUTES) {
      const res = await anon.request(path, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://reader.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'if-none-match',
        },
      });
      expect(`${path}:${res.status}`).toBe(`${path}:204`);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
        'if-none-match',
      );
      // The same refusal a GET gives: never credentialed.
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('on a detail 404 and on an image 404', async () => {
    const detail = await anon.get('/api/public/posts/nothing-here-at-all');
    expect(detail.status).toBe(404);
    expect(detail.headers.get('access-control-allow-origin')).toBe('*');

    const image = await anon.get('/api/public/images/img_draft');
    expect(image.status).toBe(404);
    expect(image.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('on a 400', async () => {
    const res = await anon.get('/api/public/posts?status=draft');
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('on a 429 — the one a browser would otherwise see as an opaque failure', async () => {
    await exhaustLimiter();
    const res = await anon.get('/api/public/images/img_inline');
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await json(res)).toMatchObject({ error: 'rate_limited' });
  });

  it('never on the authenticated API', async () => {
    const res = await anon.get('/api/posts');
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// --------------------------------------------------------------- rate limiting

/** Fill the shared `public:<ip>` bucket, so the NEXT limited call is refused. */
async function exhaustLimiter(): Promise<void> {
  const windowStart = Math.floor(Date.now() / PUBLIC_LIMIT_WINDOW_MS) * PUBLIC_LIMIT_WINDOW_MS;
  await ctx.db.execute(sql`
    INSERT INTO auth_attempts (key, window_start, count)
    VALUES ('public:unknown', ${windowStart}, ${PUBLIC_LIMIT})`);
}

describe('the limiter is on the expensive routes only', () => {
  it('limits a search list and the image route', async () => {
    await exhaustLimiter();
    expect((await anon.get('/api/public/posts?search=harbour')).status).toBe(429);
    expect((await anon.get('/api/public/images/img_inline')).status).toBe(429);
  });

  it('does not limit plain list, detail, feed, sitemap or the taxonomies', async () => {
    await exhaustLimiter();
    for (const path of PUBLIC_ROUTES) {
      const res = await anon.get(path);
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
    }
  });

  it('writes no limiter row for an unlimited route', async () => {
    await anon.get('/api/public/posts');
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM auth_attempts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------- image route

describe('the image route serves only live published references', () => {
  it('302s to a presigned URL for an inline reference in a published post', async () => {
    const res = await anon.get('/api/public/images/img_inline');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('img_inline');
    expect(res.headers.get('cache-control')).toBe(CACHE.image);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('302s for a live cover, including the asset:-prefixed blobId form', async () => {
    const res = await anon.get('/api/public/images/img_cover');
    expect(res.status).toBe(302);
  });

  it('404s for an image referenced only by a draft', async () => {
    expect((await anon.get('/api/public/images/img_draft')).status).toBe(404);
  });

  it('404s for an image referenced only by a revision', async () => {
    expect((await anon.get('/api/public/images/img_revision')).status).toBe(404);
  });

  it('404s for an uncommitted image, even in a published post', async () => {
    expect((await anon.get('/api/public/images/img_uncommitted')).status).toBe(404);
  });

  it('404s for an unknown id, the same as all of the above', async () => {
    expect((await anon.get('/api/public/images/img_nothing')).status).toBe(404);
  });

  it('the cover URL the projection emits is the URL that serves', async () => {
    const { post } = await json<{ post: PublicPostDetail }>(
      await anon.get('/api/public/posts/alpha-lighthouse'),
    );
    expect(post.coverImage?.url).toBe('/api/public/images/img_cover');
    expect((await anon.get(`/api${post.coverImage?.url.slice(4)}`)).status).toBe(302);
  });
});

// ------------------------------------------------------------------ NUL bytes

describe('a NUL in a path parameter is a 400, not a 404 and not a 500', () => {
  it('in :slug', async () => {
    const res = await anon.get(`/api/public/posts/${encodeURIComponent(NUL)}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'slug' });
  });

  it('in :id', async () => {
    const res = await anon.get(`/api/public/images/${encodeURIComponent(NUL)}`);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'id' });
  });

  it('in a query parameter', async () => {
    expect((await anon.get('/api/public/posts?search=%00')).status).toBe(400);
  });
});

// ------------------------------------------------------------------------ XML

describe('the feed and the sitemap are well-formed and escaped', () => {
  it('escapes the five predefined entities in an excerpt', async () => {
    const xml = await (await anon.get('/api/public/feed.xml')).text();
    // The excerpt is literally `fog & light <lamps>`.
    expect(xml).toContain('fog &amp; light &lt;lamps&gt;');
    expect(xml).not.toContain('<lamps>');
  });

  it('emits absolute URLs built from the configured origin', async () => {
    const xml = await (await anon.get('/api/public/feed.xml')).text();
    expect(xml).toContain(`<link>${TEST_ORIGIN}/posts/alpha-lighthouse</link>`);
    expect(xml).toContain(`${TEST_ORIGIN}</link>`);
  });

  it('has no raw & anywhere outside an entity, in either document', async () => {
    for (const path of ['/api/public/feed.xml', '/api/public/sitemap.xml']) {
      const xml = await (await anon.get(path)).text();
      expect(xml.match(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g)).toBeNull();
    }
  });

  it('carries the right content types', async () => {
    expect((await anon.get('/api/public/feed.xml')).headers.get('content-type')).toContain(
      'application/rss+xml',
    );
    expect((await anon.get('/api/public/sitemap.xml')).headers.get('content-type')).toContain(
      'application/xml',
    );
  });

  it('every pubDate is a real date, never null', async () => {
    const xml = await (await anon.get('/api/public/feed.xml')).text();
    const dates = [...xml.matchAll(/<pubDate>(.*?)<\/pubDate>/g)].map((m) => m[1]);
    expect(dates).toHaveLength(3);
    for (const date of dates) expect(Number.isNaN(Date.parse(date))).toBe(false);
  });
});

// ------------------------------------------------------------------ no session

describe('the public router cannot see a session', () => {
  it('a cookie changes nothing about the response', async () => {
    const withCookie = await anon.get('/api/public/posts', {
      headers: { cookie: 'session=whatever-a-reader-happens-to-hold' },
    });
    const without = await anon.get('/api/public/posts');
    expect(withCookie.status).toBe(200);
    expect(await withCookie.text()).toBe(await without.text());
  });

  /**
   * FIX 5 — THE STRUCTURAL GUARANTEE, PINNED.
   *
   * `Cache-Control: public` with no `Vary: Cookie` is only safe because the
   * response CANNOT vary by cookie: the router is mounted above
   * `sessionMiddleware`, so no handler here can resolve a session. Nothing
   * previously held that property in place, and the test above only proves it
   * for a GARBAGE cookie — which a session-reading route would ignore anyway.
   *
   * This sends a REAL, ACCEPTED `__Host-studio_session` and demands the bytes be
   * identical. `Vary: Cookie` is deliberately NOT added as the fix: the header
   * would assert that the response can vary, which is exactly what must never
   * become true, and it would fragment every edge cache entry by cookie for no
   * benefit.
   */
  it('a VALID session cookie changes nothing, byte for byte, on every route', async () => {
    const authed = httpClient(ctx.db);
    const login = await authed.post('/api/auth/login', {
      email: owner().email,
      password: SEED_PASSWORD,
    });
    expect(login.status).toBe(200);
    // The jar now holds the real cookie, and it is the production one.
    expect([...authed.cookies().keys()]).toContain('__Host-studio_session');

    /** Everything except the per-request id, which differs by definition. */
    const shape = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()]
        .filter(([name]) => name !== 'x-request-id')
        .sort(([a], [b]) => a.localeCompare(b)),
    });

    for (const path of [...PUBLIC_ROUTES, '/api/public/images/img_inline']) {
      const anonymous = await shape(await anon.get(path));
      const withSession = await shape(await authed.get(path));
      expect(`${path} :: ${JSON.stringify(withSession)}`).toBe(
        `${path} :: ${JSON.stringify(anonymous)}`,
      );
    }
  });

  it('and no public response claims it can vary', async () => {
    for (const path of PUBLIC_ROUTES) {
      const res = await anon.get(path);
      expect(`${path} :: ${res.headers.get('vary')}`).toBe(`${path} :: null`);
    }
  });
});

// ---------------------------------------------------- Last-Modified / 304 (FIX 2)

describe('If-Modified-Since is honoured on every cacheable route', () => {
  /** The routes that name a newest row; the taxonomies deliberately do not. */
  const DATED_ROUTES = [
    '/api/public/posts',
    '/api/public/posts/alpha-lighthouse',
    '/api/public/feed.xml',
    '/api/public/sitemap.xml',
  ];

  it('list, detail, feed and sitemap all carry Last-Modified', async () => {
    for (const path of DATED_ROUTES) {
      const res = await anon.get(path);
      const value = res.headers.get('last-modified');
      expect(`${path} :: ${value !== null && !Number.isNaN(Date.parse(value))}`).toBe(
        `${path} :: true`,
      );
    }
  });

  it('an empty result set omits it rather than inventing a date', async () => {
    const res = await anon.get('/api/public/posts?category=NoSuchCategoryAnywhere');
    expect(res.status).toBe(200);
    expect((await json<{ items: unknown[] }>(res)).items).toEqual([]);
    expect(res.headers.get('last-modified')).toBeNull();
  });

  it('answers 304 to the exact Last-Modified it just emitted', async () => {
    for (const path of DATED_ROUTES) {
      const first = await anon.get(path);
      const lastModified = first.headers.get('last-modified') as string;
      const second = await anon.get(path, {
        headers: { 'if-modified-since': lastModified },
      });
      expect(`${path} :: ${second.status}`).toBe(`${path} :: 304`);
      expect(await second.text()).toBe('');
      expect(second.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  /**
   * THE SUB-SECOND TRAP. `updated_at` is epoch MILLISECONDS and an HTTP-date
   * carries whole seconds, so echoing back the emitted header compares
   * `1786519567813` against `1786519567000`. Compared raw, that is "modified
   * since" and every revalidation is a spurious 200 — the failure the header
   * exists to prevent. The test above only catches it when the millisecond
   * remainder happens to be zero, so this one asserts the remainder is NOT.
   */
  it('truncates to whole seconds on both sides', async () => {
    const res = await anon.get('/api/public/posts/alpha-lighthouse');
    const updatedAt = (await json<{ post: PublicPostDetail }>(res)).post.updatedAt;
    expect(updatedAt % 1000).not.toBe(0);

    const conditional = await anon.get('/api/public/posts/alpha-lighthouse', {
      headers: { 'if-modified-since': new Date(updatedAt).toUTCString() },
    });
    expect(conditional.status).toBe(304);
  });

  it('an older date still gets the bytes', async () => {
    const res = await anon.get('/api/public/feed.xml', {
      headers: { 'if-modified-since': new Date(0).toUTCString() },
    });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it('an unparseable If-Modified-Since is IGNORED, not an error (RFC 9110)', async () => {
    for (const bad of ['not-a-date', '', 'Thu, 99 Xxx 2026 99:99:99 GMT']) {
      const res = await anon.get('/api/public/feed.xml', {
        headers: { 'if-modified-since': bad },
      });
      expect(`${bad} :: ${res.status}`).toBe(`${bad} :: 200`);
    }
  });

  /**
   * RFC 9110 §13.1.3: `If-None-Match` takes precedence and the date is then
   * ignored entirely. A stale tag plus a fresh date must be a 200, not a 304.
   */
  it('If-None-Match wins when both are present', async () => {
    const path = '/api/public/posts';
    const first = await anon.get(path);
    const etag = first.headers.get('etag') as string;
    const lastModified = first.headers.get('last-modified') as string;

    const staleTag = await anon.get(path, {
      headers: { 'if-none-match': '"0000"', 'if-modified-since': lastModified },
    });
    expect(staleTag.status).toBe(200);

    const freshTag = await anon.get(path, {
      headers: { 'if-none-match': etag, 'if-modified-since': new Date(0).toUTCString() },
    });
    expect(freshTag.status).toBe(304);
  });

  it('the parser itself, at the unit level', () => {
    const t = Date.parse('Wed, 12 Aug 2026 10:00:00 GMT');
    expect(ifModifiedSinceHits(undefined, t)).toBe(false);
    expect(ifModifiedSinceHits('Wed, 12 Aug 2026 10:00:00 GMT', undefined)).toBe(false);
    expect(ifModifiedSinceHits('Wed, 12 Aug 2026 10:00:00 GMT', t)).toBe(true);
    // Sub-second remainder truncated away on the resource side.
    expect(ifModifiedSinceHits('Wed, 12 Aug 2026 10:00:00 GMT', t + 999)).toBe(true);
    expect(ifModifiedSinceHits('Wed, 12 Aug 2026 10:00:00 GMT', t + 1000)).toBe(false);
    expect(ifModifiedSinceHits('Wed, 12 Aug 2026 09:59:59 GMT', t)).toBe(false);
    // Unparseable is ignored, which is `false` — "not fresh", so send the bytes.
    expect(ifModifiedSinceHits('rubbish', t)).toBe(false);
  });
});

// ------------------------------------------------------- the cursor (FIX 3)

describe('the pagination cursor carries no private field', () => {
  /**
   * EVERY CURSOR THE PUBLIC LIST CAN MINT, decoded and checked against
   * `FIELD_DISPOSITION` itself rather than against a transcribed list — so a
   * field reclassified as `'private'` later is covered without editing this.
   *
   * The defect this pins: `sort=oldest` ordered by `created_at`, which the
   * projection marks `'private'`, and the keyset cursor is minted FROM the sort
   * key — so `nextCursor` base64url-decoded to the last row's `created_at`,
   * outside the projection entirely.
   */
  it('no decoded component equals a private column of any published row', async () => {
    const privateFields = (Object.keys(FIELD_DISPOSITION) as (keyof typeof FIELD_DISPOSITION)[])
      .filter((field) => FIELD_DISPOSITION[field] === 'private');
    expect(privateFields).toContain('createdAt');

    // The private values of the three rows the public list can reach. `null` and
    // `''` are dropped: they are not identifying, and a cursor `null` component
    // is an ordinary NULLS-LAST marker rather than a leak.
    const forbidden = new Set<string>();
    for (const post of [corpus.live1, corpus.live2, corpus.live3]) {
      for (const field of privateFields) {
        const value = (post as unknown as Record<string, unknown>)[field];
        if (value === null || value === undefined || value === '') continue;
        forbidden.add(String(value));
      }
    }
    expect(forbidden.size).toBeGreaterThan(0);

    const seen: string[] = [];
    for (const sort of ['published', 'oldest', 'alphabetical']) {
      // `limit=1` mints a cursor at every row boundary, so this walks all of them.
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const url: string =
          `/api/public/posts?sort=${sort}&limit=1` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const body: { items: PublicPost[]; nextCursor: string | null } = await json(
          await anon.get(url),
        );
        cursor = body.nextCursor;
        if (!cursor) break;

        const decoded = decodeCursor(cursor);
        expect(decoded).not.toBeNull();
        for (const value of decoded!.sortValues) {
          if (value === null) continue;
          seen.push(`${sort}:${String(value)}`);
          expect(`${sort} :: ${String(value)} :: ${forbidden.has(String(value))}`).toBe(
            `${sort} :: ${String(value)} :: false`,
          );
        }
      }
    }
    // Proof the walk actually minted cursors rather than passing vacuously.
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('an `oldest` cursor still paginates without skipping or repeating', async () => {
    const slugs: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string =
        '/api/public/posts?sort=oldest&limit=1' +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const body: { items: PublicPost[]; nextCursor: string | null } = await json(
        await anon.get(url),
      );
      slugs.push(...body.items.map((p) => p.slug));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(slugs).toEqual(['gamma-jetty', 'beta-harbour', 'alpha-lighthouse']);
  });
});

// ------------------------------------------------- the origin the app has (FIX 4)

describe('the feed builds links from the app the request reached', () => {
  it('uses `deps.origins`, not the process environment', async () => {
    const client = httpClient(ctx.db, { origins: ['https://reader.example/'] });
    const xml = await (await client.get('/api/public/feed.xml')).text();
    // The trailing slash is trimmed, and localhost — the APP_ORIGINS value the
    // test environment carries — appears nowhere.
    expect(xml).toContain('<link>https://reader.example/posts/alpha-lighthouse</link>');
    expect(xml).not.toContain('localhost');

    const sitemap = await (await client.get('/api/public/sitemap.xml')).text();
    expect(sitemap).toContain('<loc>https://reader.example/posts/alpha-lighthouse</loc>');
    expect(sitemap).not.toContain('localhost');
  });

  it('an unconfigured allow-list is a 4xx naming it, never a 500 and never relative', async () => {
    const client = httpClient(ctx.db, { origins: [] });
    for (const path of ['/api/public/feed.xml', '/api/public/sitemap.xml']) {
      const res = await client.get(path);
      expect(`${path} :: ${res.status}`).toBe(`${path} :: 400`);
      expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'origins' });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });
});

// ------------------------------------------ XML well-formedness, parsed (FIX 1)

/**
 * ACTUALLY PARSED, not regexed. A regex over the bytes cannot tell you a
 * document is well-formed — and the defect here is precisely one a regex misses:
 * `<title>PastedTitle</title>` looks like clean markup and is a fatal
 * error, because XML 1.0's `Char` production admits no C0 control except tab,
 * newline and carriage return, and a numeric reference to one is equally
 * illegal. One such character anywhere makes the WHOLE document unparseable, so
 * every published post disappears from every feed reader at once.
 */
function assertWellFormed(xml: string, label: string): void {
  const parser = new SaxesParser();
  const errors: string[] = [];
  parser.on('error', (err) => errors.push(err.message));
  parser.write(xml).close();
  expect(`${label} :: ${errors.join(' | ')}`).toBe(`${label} :: `);
}

describe('the feed and sitemap survive control characters in every field', () => {
  /** Its OWN database, so the corpus above keeps its exact three rows. */
  let dirty: TestCtx;
  let reader: HttpClient;

  const VT = String.fromCharCode(0x0b);
  const BS = String.fromCharCode(0x08);
  const FF = String.fromCharCode(0x0c);
  const US = String.fromCharCode(0x1f);
  /** A LONE high surrogate — not a character, and not encodable as UTF-8. */
  const LONE = '\uD800';
  /** A noncharacter `Char` excludes by name. */
  const NONCHAR = '￿';

  beforeAll(async () => {
    dirty = await freshDb();
    let post = await createPost(dirty.db, dirty.users.owner, {
      title: `Pasted${VT}Title${LONE}${NONCHAR}`,
      subtitle: '',
      slug: `pasted${US}slug`,
      excerpt: `Ex${BS}cerpt from a ${VT}PDF`,
      category: `Cat${FF}egory`,
      tags: [`ta${US}g`, `oth${VT}er`],
      publishedAt: 5000,
      content: doc('pasted out of a terminal'),
    });
    post = await publishPost(dirty.db, post.id, dirty.users.owner);
    expect(post.title).toContain(VT);
    reader = httpClient(dirty.db);
  });

  afterAll(async () => {
    await dirty.close();
  });

  it('the feed parses cleanly', async () => {
    const xml = await (await reader.get('/api/public/feed.xml')).text();
    // The characters really were in the row and really are gone from the wire.
    for (const bad of [VT, BS, FF, US, LONE, NONCHAR]) expect(xml).not.toContain(bad);
    expect(xml).toContain('PastedTitle');
    expect(xml).toContain('<category>tag</category>');
    expect(xml).toContain('<description>Excerpt from a PDF</description>');
    assertWellFormed(xml, 'feed.xml');
  });

  it('the sitemap parses cleanly', async () => {
    const xml = await (await reader.get('/api/public/sitemap.xml')).text();
    for (const bad of [VT, BS, FF, US, LONE, NONCHAR]) expect(xml).not.toContain(bad);
    assertWellFormed(xml, 'sitemap.xml');
  });

  /**
   * THE SURROGATE AND NONCHARACTER CASES ARE UNIT-LEVEL, and deliberately so:
   * they cannot be driven through the database. Postgres `text` is UTF-8 and
   * neither a lone surrogate nor U+FFFF survives the round trip — PGlite hands
   * both back as U+FFFD, which is a legal `Char`. They CAN still arrive on this
   * function from anywhere that does not round-trip (a future in-memory feed, a
   * bundle import rendered before it is stored), and a lone surrogate is fatal
   * in exactly the same way a vertical tab is, so the handling stays and is
   * pinned here.
   */
  it('strips lone surrogates and the BMP noncharacters, at the unit level', () => {
    expect(xmlSafe(`a${LONE}b`)).toBe('ab');
    expect(xmlSafe('a\uDC00b')).toBe('ab');
    expect(xmlSafe(`a${NONCHAR}b￾c`)).toBe('abc');
    // A VALID pair is one code point and must survive intact.
    expect(xmlSafe('a😀b')).toBe('a😀b');
    expect(xmlSafe(`x${VT}${BS}${FF}${US}y`)).toBe('xy');
    expect(xmlSafe('keep\t\n\r')).toBe('keep\t\n\r');
    // And the escaping still happens on top of the strip.
    expect(xmlEscape(`a${VT}&b`)).toBe('a&amp;b');
    assertWellFormed(`<t>${xmlEscape(`bad${VT}${LONE}`)}</t>`, 'escaped fragment');
  });

  it('the ordinary corpus parses too, so the assertion is not vacuous', async () => {
    assertWellFormed(await (await anon.get('/api/public/feed.xml')).text(), 'clean feed');
    assertWellFormed(await (await anon.get('/api/public/sitemap.xml')).text(), 'clean sitemap');
  });

  it('legal whitespace is preserved — tab, newline and carriage return', async () => {
    const post = await createPost(dirty.db, dirty.users.owner, {
      title: 'Tabbed\tand\nwrapped',
      slug: 'whitespace-is-fine',
      excerpt: 'kept\tas\tis',
      category: 'Notes',
      tags: ['ws'],
      publishedAt: 6000,
      content: doc('whitespace'),
    });
    await publishPost(dirty.db, post.id, dirty.users.owner);

    const xml = await (await reader.get('/api/public/feed.xml')).text();
    expect(xml).toContain('Tabbed\tand\nwrapped');
    assertWellFormed(xml, 'feed.xml with legal whitespace');
  });
});
