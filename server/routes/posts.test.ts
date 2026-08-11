/**
 * Post read, create and the 409 contract, end to end (spec §5.2, §4.3).
 *
 * Everything goes through `app.request()` with real cookies and bodies. The
 * repository is already proven by `server/repo/posts.test.ts`; what is new here
 * is the seam — routing, authorization, the `.strict()` bodies, and whether the
 * error a repo throws becomes the response spec §8 promises.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { authorize } from '../authorize';
import { AUTOSAVE_KEEP } from '../repo/revisions';
import { MAX_TITLE_BYTES } from '../../shared/validate';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../repo/cursor';
import type { AuthUser, DocNode, ListPost, Post } from '../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let anon: HttpClient;

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  const res = await c.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return c;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM posts`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  anon = httpClient(ctx.db);
});

/** Create a post as `c` and return it. */
async function create(c: HttpClient, patch: Record<string, unknown> = {}): Promise<Post> {
  const res = await c.post('/api/posts', patch);
  expect(res.status).toBe(201);
  return (await json<{ post: Post }>(res)).post;
}

// ---------------------------------------------------------------- auth wall

describe('every post route is 401 without a session', () => {
  it('refuses reads, creates and patches alike', async () => {
    const post = await create(owner, { title: 'Private' });
    const cases: [string, () => Promise<Response>][] = [
      ['GET /api/posts', () => anon.get('/api/posts')],
      ['GET /api/posts/:id', () => anon.get(`/api/posts/${post.id}`)],
      ['POST /api/posts', () => anon.post('/api/posts', {})],
      [
        'PATCH /api/posts/:id',
        () => anon.patch(`/api/posts/${post.id}`, { patch: { title: 'x' } }),
      ],
    ];
    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(401);
      expect((await json(res)).error, name).toBe('unauthenticated');
    }
  });

  it('a mutation with a foreign Origin is 403 even with a valid session', async () => {
    const res = await owner.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

// ------------------------------------------------------------- authorization

describe('authorize()', () => {
  it('is the whole table, in one function', () => {
    const post = { authorId: ctx.users.writer.id };
    const { writer: w, owner: o } = ctx.users;
    const other: AuthUser = { ...w, id: 'someone-else' };

    // Everyone authenticated reads everything — one shared blog.
    expect(authorize(post, w, 'read')).toBe(true);
    expect(authorize(post, other, 'read')).toBe(true);

    // Mutations need author-or-owner.
    expect(authorize(post, w, 'write')).toBe(true);
    expect(authorize(post, o, 'write')).toBe(true);
    expect(authorize(post, other, 'write')).toBe(false);

    // Destroy is owner-only (spec §6; see the note in server/authorize.ts
    // about §5.2 saying otherwise).
    expect(authorize(post, w, 'destroy')).toBe(false);
    expect(authorize(post, o, 'destroy')).toBe(true);
  });
});

describe('PATCH authorization', () => {
  it("a writer cannot PATCH another writer's post (403); the owner can", async () => {
    const ownersPost = await create(owner, { title: 'Owner draft' });

    const refused = await writer.patch(`/api/posts/${ownersPost.id}`, {
      patch: { title: 'Hijacked' },
      baseRevision: ownersPost.revision,
    });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toBe('forbidden');

    const writersPost = await create(writer, { title: 'Writer draft' });
    const allowed = await owner.patch(`/api/posts/${writersPost.id}`, {
      patch: { title: 'Owner edited it' },
      baseRevision: writersPost.revision,
    });
    expect(allowed.status).toBe(200);
    const body = await json<{ post: Post }>(allowed);
    expect(body.post.title).toBe('Owner edited it');
    // The byline follows the POST's author, not the actor: an owner fixing a
    // typo must not rename the piece to themselves.
    expect(body.post.authorId).toBe(ctx.users.writer.id);
    expect(body.post.authorName).toBe(ctx.users.writer.displayName);
  });

  it('a writer can edit their own post', async () => {
    const mine = await create(writer, { title: 'Mine' });
    const res = await writer.patch(`/api/posts/${mine.id}`, {
      patch: { title: 'Still mine' },
      baseRevision: mine.revision,
    });
    expect(res.status).toBe(200);
    expect((await json<{ post: Post }>(res)).post.title).toBe('Still mine');
  });
});

// -------------------------------------------------------------------- reads

describe('GET /api/posts', () => {
  it('omits content; GET /api/posts/:id includes it', async () => {
    const post = await create(owner, { title: 'Body', content: doc('the words') });

    const list = await owner.get('/api/posts');
    expect(list.status).toBe(200);
    const listed = (await json<{ items: ListPost[] }>(list)).items;
    expect(listed).toHaveLength(1);
    expect('content' in listed[0]).toBe(false);
    // And nothing else server-side rides along either.
    expect('content_text' in listed[0]).toBe(false);
    expect('search' in listed[0]).toBe(false);
    expect(listed[0]).toMatchObject({ id: post.id, title: 'Body' });

    const one = await owner.get(`/api/posts/${post.id}`);
    expect((await json<{ post: Post }>(one)).post.content).toEqual(doc('the words'));
  });

  it('a writer sees every author’s posts — one shared blog', async () => {
    await create(owner, { title: 'From the owner' });
    await create(writer, { title: 'From the writer' });
    const res = await writer.get('/api/posts');
    const titles = (await json<{ items: ListPost[] }>(res)).items.map((p) => p.title);
    expect(titles.sort()).toEqual(['From the owner', 'From the writer']);
  });

  it('filters, sorts and paginates through the cursor', async () => {
    for (let i = 0; i < 5; i += 1) await create(owner, { title: `Post ${i}` });

    const first = await owner.get('/api/posts?sort=alphabetical&limit=2');
    const a = await json<{ items: ListPost[]; nextCursor: string | null }>(first);
    expect(a.items.map((p) => p.title)).toEqual(['Post 0', 'Post 1']);
    expect(a.nextCursor).toBeTruthy();

    const second = await owner.get(
      `/api/posts?sort=alphabetical&limit=2&cursor=${encodeURIComponent(a.nextCursor!)}`,
    );
    const b = await json<{ items: ListPost[] }>(second);
    expect(b.items.map((p) => p.title)).toEqual(['Post 2', 'Post 3']);
  });

  it('a cursor spent under another sort is a 400, not a wrong page', async () => {
    for (let i = 0; i < 3; i += 1) await create(owner, { title: `P${i}` });
    const first = await owner.get('/api/posts?sort=alphabetical&limit=1');
    const cursor = (await json<{ nextCursor: string }>(first)).nextCursor;

    const res = await owner.get(
      `/api/posts?sort=updated&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'cursor' });
  });

  it('a NUL byte in a text filter is a 400, not a 500 the client retries', async () => {
    for (const param of ['search', 'category', 'tag']) {
      const res = await owner.get(`/api/posts?${param}=%00`);
      expect(res.status, param).toBe(400);
      expect((await json(res)).detail, param).toBe(param);
    }
  });

  it('an out-of-range or non-numeric limit is a 400', async () => {
    for (const value of ['0', String(MAX_PAGE_LIMIT + 1), 'abc', '1.5']) {
      const res = await owner.get(`/api/posts?limit=${value}`);
      expect(res.status, value).toBe(400);
      expect((await json(res)).detail, value).toBe('limit');
    }
    const fine = await owner.get(`/api/posts?limit=${MAX_PAGE_LIMIT}`);
    expect(fine.status).toBe(200);
  });

  it('an unknown query parameter is a 400, so a mistyped filter cannot be silent', async () => {
    // `?statuss=draft` would otherwise return every post in the blog, trash
    // included, and look like a bug in the dashboard.
    const res = await owner.get('/api/posts?statuss=draft');
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('statuss');
  });

  it('an unknown sort or status is a 400 rather than a silent default', async () => {
    expect((await owner.get('/api/posts?sort=whatever')).status).toBe(400);
    expect((await owner.get('/api/posts?status=deleted')).status).toBe(400);
  });

  it('defaults to every post, newest first, 24 to a page', async () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(24);
    for (let i = 0; i < 26; i += 1) await create(owner, { title: `Bulk ${i}` });
    const res = await owner.get('/api/posts');
    const body = await json<{ items: ListPost[]; nextCursor: string | null }>(res);
    expect(body.items).toHaveLength(24);
    expect(body.nextCursor).toBeTruthy();
  });
});

describe('GET /api/posts/:id', () => {
  it('a destroyed post returns 404 with error "gone"', async () => {
    const post = await create(owner, { title: 'Doomed' });
    await ctx.db.execute(sql`DELETE FROM posts WHERE id = ${post.id}`);
    const res = await owner.get(`/api/posts/${post.id}`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('gone');
  });

  it('an id that never existed is the same 404 — absent and destroyed do not differ', async () => {
    const res = await owner.get('/api/posts/p_never_existed');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('gone');
  });
});

// ------------------------------------------------------------------- create

describe('POST /api/posts', () => {
  it('creates a draft with no body at all', async () => {
    const res = await owner.request('/api/posts', { method: 'POST' });
    expect(res.status).toBe(201);
    const post = (await json<{ post: Post }>(res)).post;
    expect(post).toMatchObject({ status: 'draft', revision: 1, title: '' });
    // The author is the session, never the body.
    expect(post.authorId).toBe(ctx.users.owner.id);
    expect(post.authorName).toBe(ctx.users.owner.displayName);
    // An untitled draft holds no slug: a UNIQUE column cannot hold twenty ''s.
    expect(post.slug).toBeNull();
  });

  it('writes a first revision, so the post has history from birth', async () => {
    const post = await create(owner, { title: 'Genesis' });
    const rows = await ctx.db.execute(
      sql`SELECT revision, kind FROM revisions WHERE post_id = ${post.id}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ revision: 1, kind: 'manual' });
  });

  it('refuses a system field rather than ignoring it', async () => {
    for (const [key, value] of Object.entries({
      id: 'p_chosen_by_the_client',
      status: 'published',
      authorId: 'somebody-else',
      revision: 99,
      createdAt: 0,
      slug: 'chosen-address',
    })) {
      const res = await owner.post('/api/posts', { [key]: value });
      expect(res.status, key).toBe(400);
      expect((await json(res)).detail, key).toBe(key);
    }
  });

  it('an invalid document is a 422 naming the path, and nothing is stored', async () => {
    const res = await owner.post('/api/posts', {
      content: { type: 'doc', content: [{ type: 'script', content: [] }] },
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      error: 'invalid_document',
      path: 'content[0]',
    });
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// -------------------------------------------------------------------- patch

describe('PATCH /api/posts/:id', () => {
  it('saves, bumps the revision and appends a snapshot', async () => {
    const post = await create(owner, { title: 'Draft' });
    const res = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'Draft v2', content: doc('some words here') },
      baseRevision: post.revision,
      kind: 'manual',
    });
    expect(res.status).toBe(200);
    const saved = (await json<{ post: Post }>(res)).post;
    expect(saved.revision).toBe(post.revision + 1);
    expect(saved.wordCount).toBe(3);
    // Derivation is the server's (spec §4.4) — the slug appears on first title.
    expect(saved.slug).toBe('draft-v2');

    const rows = await ctx.db.execute(
      sql`SELECT revision, kind FROM revisions WHERE post_id = ${post.id}
           ORDER BY revision`,
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['manual', 'manual']);
  });

  it('with a stale baseRevision returns 409 carrying expected, actual and the server post', async () => {
    const post = await create(owner, { title: 'Contested' });
    const first = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'Theirs' },
      baseRevision: post.revision,
    });
    expect(first.status).toBe(200);

    const second = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'Mine' },
      baseRevision: post.revision,
    });
    expect(second.status).toBe(409);
    const body = await json<{ error: string; expected: number; actual: number; post: Post }>(
      second,
    );
    expect(body.error).toBe('stale_write');
    expect(body.expected).toBe(post.revision);
    expect(body.actual).toBe(post.revision + 1);
    // Spec §4.3 — "Load theirs" renders with no second round trip, so the post
    // must be the WHOLE post, document included.
    expect(body.post.id).toBe(post.id);
    expect(body.post.title).toBe('Theirs');
    expect(body.post.content).toBeTruthy();

    // And the loser wrote nothing: no bumped revision, no orphan snapshot.
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${post.id}`,
    );
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('with an invalid document returns 422 naming the path', async () => {
    const post = await create(owner, { title: 'Doc' });
    const res = await owner.patch(`/api/posts/${post.id}`, {
      patch: {
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph' },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
              ],
            },
          ],
        },
      },
      baseRevision: post.revision,
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toBe('invalid_document');
    expect(String(body.path)).toContain('content[1]');
  });

  it('with an unknown body key is 400, so a system field cannot be attempted', async () => {
    const post = await create(owner, { title: 'Sealed' });
    const outer = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'x' },
      baseRevision: post.revision,
      force: true,
    });
    expect(outer.status).toBe(400);
    expect((await json(outer)).detail).toBe('force');

    for (const key of ['status', 'authorId', 'revision', 'deletedAt', 'publishedAt']) {
      const res = await owner.patch(`/api/posts/${post.id}`, {
        patch: { [key]: 'anything' },
        baseRevision: post.revision,
      });
      expect(res.status, key).toBe(400);
      expect((await json(res)).detail, key).toBe(`patch.${key}`);
    }
  });

  it('with a slug key is 400 — slugs are server-authoritative', async () => {
    const created = await create(owner, { title: 'Addressed' });
    /*
     * The address is minted by the first SAVE that has a title, not by create:
     * `createPost` only normalises a slug it was handed, so `duplicatePost` and
     * import do not claim an address a copy has not earned. Spec §4.5's "first
     * save with a non-empty title" is `savePost`, and this is what pins that
     * reading.
     */
    expect(created.slug).toBeNull();
    const saved = await owner.patch(`/api/posts/${created.id}`, {
      patch: { title: 'Addressed' },
      baseRevision: created.revision,
    });
    const post = (await json<{ post: Post }>(saved)).post;
    expect(post.slug).toBe('addressed');

    const res = await owner.patch(`/api/posts/${post.id}`, {
      patch: { slug: 'my-chosen-address' },
      baseRevision: post.revision,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'patch.slug' });

    // And it really was refused rather than accepted-and-discarded.
    const after = await owner.get(`/api/posts/${post.id}`);
    expect((await json<{ post: Post }>(after)).post.slug).toBe('addressed');
  });

  it('a client-chosen revision kind is refused', async () => {
    const post = await create(owner, { title: 'Kinds' });
    for (const kind of ['publish', 'status', 'whatever']) {
      const res = await owner.patch(`/api/posts/${post.id}`, {
        patch: { title: 'x' },
        baseRevision: post.revision,
        kind,
      });
      expect(res.status, kind).toBe(400);
      expect((await json(res)).detail, kind).toBe('kind');
    }
  });

  it('an over-long title is a 422 naming the field, not a 500', async () => {
    const post = await create(owner, { title: 'Short' });
    const res = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'x'.repeat(MAX_TITLE_BYTES + 1) },
      baseRevision: post.revision,
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ error: 'invalid_document', path: 'title' });
  });

  it('patching an absent post is a 404 before any permission decision', async () => {
    const res = await writer.patch('/api/posts/p_nope', {
      patch: { title: 'x' },
      baseRevision: 1,
    });
    expect(res.status).toBe(404);
  });

  it('an omitted baseRevision saves against whatever is stored', async () => {
    // The lifecycle routes and restore-forward rely on this; the editor always
    // sends one, which is what makes a second tab a 409 rather than a clobber.
    const post = await create(owner, { title: 'Baseless' });
    const res = await owner.patch(`/api/posts/${post.id}`, { patch: { title: 'Moved on' } });
    expect(res.status).toBe(200);
    expect((await json<{ post: Post }>(res)).post.revision).toBe(post.revision + 1);
  });

  it('coverImage: null clears it, absent keeps it', async () => {
    const cover = {
      blobId: 'img_1',
      alt: 'a picture',
      focalPoint: '50% 50%',
      width: 800,
      height: 600,
    };
    const post = await create(owner, { title: 'Covered', coverImage: cover });
    expect(post.coverImage).toEqual(cover);

    const kept = await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'Still covered' },
      baseRevision: post.revision,
    });
    const keptPost = (await json<{ post: Post }>(kept)).post;
    expect(keptPost.coverImage).toEqual(cover);

    const cleared = await owner.patch(`/api/posts/${post.id}`, {
      patch: { coverImage: null },
      baseRevision: keptPost.revision,
    });
    expect((await json<{ post: Post }>(cleared)).post.coverImage).toBeNull();
  });

  it('a malformed coverImage is a 400 naming the field', async () => {
    const post = await create(owner, { title: 'Cover' });
    const res = await owner.patch(`/api/posts/${post.id}`, {
      patch: { coverImage: { blobId: 'img_1', alt: 'a', focalPoint: 'x', width: 'wide' } },
      baseRevision: post.revision,
    });
    expect(res.status).toBe(400);
    expect(String((await json(res)).detail)).toContain('patch.coverImage');
  });
});

// ------------------------------------------------------------ autosave prune

describe('autosave pruning', () => {
  it('is wired to the autosave path and bounds history', async () => {
    const post = await create(owner, { title: 'Long session' });
    let revision = post.revision;
    // Enough autosaves to cross AUTOSAVE_KEEP and land on a prune trigger.
    for (let i = 0; i < 45; i += 1) {
      const res = await owner.patch(`/api/posts/${post.id}`, {
        patch: { content: doc(`draft number ${i}`) },
        baseRevision: revision,
      });
      expect(res.status).toBe(200);
      revision = (await json<{ post: Post }>(res)).post.revision;
    }

    const rows = await ctx.db.execute(
      sql`SELECT kind, count(*)::int AS n FROM revisions WHERE post_id = ${post.id}
           GROUP BY kind`,
    );
    const byKind = new Map(rows.rows.map((r) => [String(r.kind), Number(r.n)]));
    // The create's 'manual' snapshot is never pruned, whatever else happens.
    expect(byKind.get('manual')).toBe(1);
    const autosaves = byKind.get('autosave') ?? 0;
    expect(autosaves).toBeGreaterThan(0);
    expect(autosaves).toBeLessThanOrEqual(AUTOSAVE_KEEP + 10);
    // Unpruned it would be 45.
    expect(autosaves).toBeLessThan(45);
  });

  it('a manual save is never pruned', async () => {
    const post = await create(owner, { title: 'Checkpoints' });
    let revision = post.revision;
    for (let i = 0; i < 45; i += 1) {
      const res = await owner.patch(`/api/posts/${post.id}`, {
        patch: { content: doc(`step ${i}`) },
        baseRevision: revision,
        kind: i % 15 === 0 ? 'manual' : 'autosave',
      });
      revision = (await json<{ post: Post }>(res)).post.revision;
    }
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM revisions
           WHERE post_id = ${post.id} AND kind = 'manual'`,
    );
    // 1 from create + 3 manual saves.
    expect(Number(rows.rows[0].n)).toBe(4);
  });
});
