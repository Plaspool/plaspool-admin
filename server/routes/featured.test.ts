/**
 * Curation over HTTP — the admin half and the public half.
 *
 * WHAT THE REPO SUITE DOES NOT COVER, which is the whole reason this file
 * exists: route ORDER (a literal path behind a `:slug` wildcard is unreachable
 * and nothing in the repo can see that), the error TABLE (a 422 that arrives as
 * a 500 is retried five times by the client for a condition that never
 * changes), the AUTH boundary, and the cache headers the rail is served with.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { CACHE } from './public';
import { createPost, publishPost, unpublishPost } from '../repo/posts';
import { MAX_FEATURED } from '../repo/featured';
import type { AuthUser, DocNode, FeaturedItem, Post, PublicPost } from '../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let anon: HttpClient;

const doc = (text: string): DocNode =>
  ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }) as DocNode;

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  await c.signIn(user);
  return c;
}

async function live(title: string, slug?: string): Promise<Post> {
  const post = await createPost(ctx.db, ctx.users.owner, {
    title,
    subtitle: '',
    slug: slug ?? null,
    category: 'Essays',
    content: doc(`${title} has words.`),
  });
  return publishPost(ctx.db, post.id, ctx.users.owner);
}

async function draft(title: string): Promise<Post> {
  return createPost(ctx.db, ctx.users.owner, {
    title,
    subtitle: '',
    category: 'Essays',
    content: doc(`${title} is a draft.`),
  });
}

/** Feature through the API, so the route is what put it there. */
async function feature(id: string, body?: unknown): Promise<Response> {
  return owner.post(`/api/posts/${id}/feature`, body ?? {});
}

beforeAll(async () => {
  ctx = await freshDb();
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM posts`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
});

// ------------------------------------------------------------------- public

describe('GET /api/public/posts/featured', () => {
  it('is reachable, and is not swallowed by the by-slug route', async () => {
    // THE ROUTE-ORDER TEST. Hono matches in registration order, so registering
    // this after `/public/posts/:slug` makes every request for it a lookup for
    // a post slugged "featured" — a 404 that looks exactly like the endpoint
    // not existing, which is the state the storefront is already coping with.
    const res = await anon.get('/api/public/posts/featured');
    expect(res.status).toBe(200);
    expect(await json<{ items: PublicPost[] }>(res)).toEqual({ items: [] });
  });

  it('still answers the rail when a post is actually slugged "featured"', async () => {
    const post = await live('Featured', 'featured');
    await feature(post.id);

    // The literal wins, and that is the accepted cost of the path the
    // storefront already calls: this post is unreachable at its own public URL.
    const res = await anon.get('/api/public/posts/featured');
    const body = await json<{ items: PublicPost[] }>(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe('featured');
  });

  it('serves the curated order', async () => {
    const a = await live('A');
    const b = await live('B');
    await feature(b.id);
    await feature(a.id);

    const body = await json<{ items: PublicPost[] }>(
      await anon.get('/api/public/posts/featured'),
    );
    expect(body.items.map((i) => i.title)).toEqual(['B', 'A']);
  });

  it('emits exactly the fields the storefront declares, no more and no fewer', async () => {
    const post = await live('Contract');
    await feature(post.id);
    const [item] = (
      await json<{ items: PublicPost[] }>(await anon.get('/api/public/posts/featured'))
    ).items;

    /*
     * TRANSCRIBED FROM THE CONSUMER, NOT FROM THE PRODUCER.
     *
     * This is `PublicPost` in `packages/blog/src/data/types.ts` of the
     * STOREFRONT repo — a different repository, with no compiler between the
     * two. The contract says the rail carries "the SAME shape /posts returns.
     * No extra fields", so both directions matter: a missing field is a rail
     * that renders blanks, and an extra one is a shape that has quietly stopped
     * being `PublicPost` and will diverge from the grid beside it.
     */
    expect(Object.keys(item).sort()).toEqual(
      [
        'author',
        'category',
        'coverImage',
        'excerpt',
        'id',
        'publishedAt',
        'readingTime',
        'slug',
        'subtitle',
        'tags',
        'template',
        'title',
        'updatedAt',
        'wordCount',
      ].sort(),
    );
  });

  it('ships no private field, checked against the bytes', async () => {
    const post = await live('Private');
    await feature(post.id);
    const text = await (await anon.get('/api/public/posts/featured')).text();

    // Against the SERIALIZED body, not the parsed object: `not.toHaveProperty`
    // passes happily for a field nested three levels down.
    for (const field of ['featured', 'featured_rank', 'featuredRank', 'authorId', 'status']) {
      expect(text).not.toContain(field);
    }
    expect(text).not.toContain(ctx.users.owner.id);
  });

  it('is cacheable, cross-origin readable and carries an ETag', async () => {
    const res = await anon.get('/api/public/posts/featured');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe(CACHE.featured);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  it('sends NO Last-Modified, because curation does not move updated_at', async () => {
    const post = await live('Dated');
    await feature(post.id);
    const res = await anon.get('/api/public/posts/featured');

    /*
     * The newest `updated_at` among the four does not say when the CURATION
     * changed — featuring deliberately leaves that column alone. Emitting it
     * would hand a client that sends only `If-Modified-Since` a 304 for a body
     * that had been reordered, because `send()` consults the date only when
     * `If-None-Match` is absent. Same reasoning the taxonomy routes state.
     */
    expect(res.headers.get('last-modified')).toBeNull();
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const post = await live('Revalidated');
    await feature(post.id);
    const first = await anon.get('/api/public/posts/featured');
    const etag = first.headers.get('etag') as string;

    const second = await anon.get('/api/public/posts/featured', {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('cache-control')).toBe(CACHE.featured);
  });

  it('changes its ETag when the rail is reordered', async () => {
    const a = await live('A');
    const b = await live('B');
    await feature(a.id);
    await feature(b.id);
    const before = (await anon.get('/api/public/posts/featured')).headers.get('etag');

    await owner.put('/api/featured', { ids: [b.id, a.id] });

    // The ONLY validator this route has. If it did not move on a reorder, a
    // revalidating cache would serve the old order until the TTL expired.
    const after = (await anon.get('/api/public/posts/featured')).headers.get('etag');
    expect(after).not.toBe(before);
  });

  it('needs no session, and offers no way to ask for one', async () => {
    // Mounted above `sessionMiddleware` like the rest of the public router, so
    // a `Cache-Control: public` response is incapable of varying by reader.
    expect((await anon.get('/api/public/posts/featured')).status).toBe(200);
  });
});

// -------------------------------------------------------------------- admin

describe('GET /api/featured', () => {
  it('is 401 without a session', async () => {
    expect((await anon.get('/api/featured')).status).toBe(401);
  });

  it('is readable by a writer, because everyone authenticated reads everything', async () => {
    // The editor's toggle state and its "n of 4" counter come from here, and a
    // writer has to see both to be told why the toggle is disabled.
    expect((await writer.get('/api/featured')).status).toBe(200);
  });

  it('returns the rail in rank order, with no document in it', async () => {
    const a = await live('A');
    await feature(a.id);
    const body = await json<{ items: FeaturedItem[] }>(await owner.get('/api/featured'));
    expect(body.items.map((i) => i.title)).toEqual(['A']);
    expect(body.items[0]).not.toHaveProperty('content');
  });
});

describe('POST /api/posts/:id/feature', () => {
  it('is 401 without a session', async () => {
    const post = await live('A');
    expect((await anon.post(`/api/posts/${post.id}/feature`, {})).status).toBe(401);
  });

  it('is 403 for a writer, even on their own post', async () => {
    const post = await createPost(ctx.db, ctx.users.writer, {
      title: 'Mine',
      subtitle: '',
      category: 'Essays',
      content: doc('mine'),
    });
    await publishPost(ctx.db, post.id, ctx.users.writer);

    /*
     * CURATION IS SITE-WIDE, SO IT IS OWNER-ONLY — spec §6's rule for
     * `emptyTrash` and invites, applied to the surface it most obviously fits.
     * The rail is the front of the blog, and `authorize(post, user, 'write')`
     * would let any writer put their own post on it: self-promotion to the
     * homepage, on an invite-only writer list whose whole point is that an
     * editor decides what leads.
     */
    expect((await writer.post(`/api/posts/${post.id}/feature`, {})).status).toBe(403);
  });

  it('answers with the whole new rail', async () => {
    const post = await live('A');
    const body = await json<{ items: FeaturedItem[] }>(await feature(post.id));
    // The whole rail, so the manager and the counter re-render with no second
    // round trip — the same reason the lifecycle routes return the new post.
    expect(body.items.map((i) => i.id)).toEqual([post.id]);
    expect(body.items[0].rank).toBe(1);
  });

  it('is 422 not_featurable for a draft, naming the reason', async () => {
    const post = await draft('Unfinished');
    const res = await feature(post.id);
    expect(res.status).toBe(422);
    // A 4xx and never a 5xx: spec §8's client retries a 5xx five times over ~30
    // seconds, and a draft does not become published in that window.
    expect(await json(res)).toMatchObject({ error: 'not_featurable', reason: 'draft' });
  });

  it('is 409 featured_full on the fifth, and names the current four', async () => {
    const rail: Post[] = [];
    for (let i = 1; i <= MAX_FEATURED; i += 1) {
      const post = await live(`Rail ${i}`);
      await feature(post.id);
      rail.push(post);
    }
    const res = await feature((await live('Fifth')).id);
    expect(res.status).toBe(409);

    const body = await json<{ error: string; limit: number; items: FeaturedItem[] }>(res);
    expect(body.error).toBe('featured_full');
    expect(body.limit).toBe(MAX_FEATURED);
    // Without the list the admin can only show a dead error. With it, it can
    // offer the swap the contract asks for.
    expect(body.items.map((i) => i.id)).toEqual(rail.map((p) => p.id));
  });

  it('swaps in place when told which post to replace', async () => {
    const rail: Post[] = [];
    for (let i = 1; i <= MAX_FEATURED; i += 1) {
      const post = await live(`Rail ${i}`);
      await feature(post.id);
      rail.push(post);
    }
    const newcomer = await live('Newcomer');

    const body = await json<{ items: FeaturedItem[] }>(
      await feature(newcomer.id, { replace: rail[2].id }),
    );
    expect(body.items.map((i) => i.title)).toEqual([
      'Rail 1',
      'Rail 2',
      'Newcomer',
      'Rail 4',
    ]);
  });

  it('is 404 for an id that does not exist', async () => {
    expect((await feature('p_nothing')).status).toBe(404);
  });

  it('refuses an unknown body key rather than ignoring it', async () => {
    const post = await live('Strict');
    // Every body in this app is parsed with a `.strict()` schema, so a caller
    // cannot attempt to set a system field and be told it worked.
    const res = await owner.post(`/api/posts/${post.id}/feature`, { rank: 1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/posts/:id/unfeature', () => {
  it('is owner-only', async () => {
    const post = await live('A');
    await feature(post.id);
    expect((await writer.post(`/api/posts/${post.id}/unfeature`, {})).status).toBe(403);
  });

  it('takes the post off the rail', async () => {
    const post = await live('A');
    await feature(post.id);
    const body = await json<{ items: FeaturedItem[] }>(
      await owner.post(`/api/posts/${post.id}/unfeature`, {}),
    );
    expect(body.items).toEqual([]);
  });
});

describe('PUT /api/featured', () => {
  async function railOf(n: number): Promise<Post[]> {
    const posts: Post[] = [];
    for (let i = 1; i <= n; i += 1) {
      const post = await live(`R${i}`);
      await feature(post.id);
      posts.push(post);
    }
    return posts;
  }

  it('is owner-only', async () => {
    expect((await writer.put('/api/featured', { ids: [] })).status).toBe(403);
  });

  it('reorders the whole rail', async () => {
    const rail = await railOf(3);
    const ids = [rail[2].id, rail[0].id, rail[1].id];
    const body = await json<{ items: FeaturedItem[] }>(
      await owner.put('/api/featured', { ids }),
    );
    expect(body.items.map((i) => i.id)).toEqual(ids);
    expect(body.items.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it('is 409 featured_stale for a list that is not the current rail', async () => {
    const rail = await railOf(2);
    const res = await owner.put('/api/featured', { ids: [rail[0].id] });
    expect(res.status).toBe(409);

    const body = await json<{ error: string; items: FeaturedItem[] }>(res);
    expect(body.error).toBe('featured_stale');
    // Carries the truth, so the manager re-renders from the refusal rather than
    // asking again and hoping.
    expect(body.items.map((i) => i.id)).toEqual(rail.map((p) => p.id));
  });

  it('is 400 for a body that is not a list of ids', async () => {
    for (const body of [{}, { ids: 'nope' }, { ids: [1, 2] }, { ids: [], extra: 1 }]) {
      expect((await owner.put('/api/featured', body)).status).toBe(400);
    }
  });

  it('caps the list at the rail width rather than reading an unbounded array', async () => {
    // The cap is a constraint, so a longer list can only ever be refused — but
    // it is refused at the schema rather than after building a statement over
    // however many ids a caller chose to send.
    const ids = Array.from({ length: MAX_FEATURED + 1 }, (_, i) => `p_${i}`);
    expect((await owner.put('/api/featured', { ids })).status).toBe(400);
  });
});

describe('invariant 3, over HTTP', () => {
  it('unpublishing through the lifecycle route takes the post off the public rail', async () => {
    const post = await live('Retired');
    await feature(post.id);
    expect(
      (await json<{ items: PublicPost[] }>(await anon.get('/api/public/posts/featured')))
        .items,
    ).toHaveLength(1);

    const res = await owner.post(`/api/posts/${post.id}/unpublish`, {});
    expect(res.status).toBe(200);

    // The rail the READER sees, not just the flag: this is the surface the
    // invariant exists to protect.
    expect(
      (await json<{ items: PublicPost[] }>(await anon.get('/api/public/posts/featured')))
        .items,
    ).toEqual([]);
  });

  it('holds when the post is unpublished by the repository directly', async () => {
    const post = await live('Retired');
    await feature(post.id);
    await unpublishPost(ctx.db, post.id, ctx.users.owner);
    const body = await json<{ items: FeaturedItem[] }>(await owner.get('/api/featured'));
    expect(body.items).toEqual([]);
  });
});
