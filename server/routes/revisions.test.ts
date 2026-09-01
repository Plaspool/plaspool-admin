/**
 * Revision history and the backup routes, end to end (spec §5.3, §5.5).
 *
 * The two properties worth the most here: a revision LIST never carries a
 * document body, and a restore writes FORWARD — the version you were on before
 * the restore is still in the list afterwards, because the one operation a
 * writer reaches for when they are afraid of losing work must not be the
 * operation that loses it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { BACKUP_LIMIT } from '../repo/ratelimit';
import { BUNDLE_FORMAT } from '../../shared/types';
import { MAX_TITLE_BYTES } from '../../shared/validate';
import type { AuthUser, Bundle, DocNode, Post, RevisionMeta } from '../../shared/types';

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
  await c.signIn(user);
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

async function create(c: HttpClient, patch: Record<string, unknown> = {}): Promise<Post> {
  const res = await c.post('/api/posts', patch);
  expect(res.status).toBe(201);
  return (await json<{ post: Post }>(res)).post;
}

/** A post with `n` saved versions after its create snapshot. */
async function withHistory(c: HttpClient, n: number, title = 'Historic'): Promise<Post> {
  let post = await create(c, { title, content: doc('version zero') });
  for (let i = 1; i <= n; i += 1) {
    const res = await c.patch(`/api/posts/${post.id}`, {
      patch: { content: doc(`version ${i}`) },
      baseRevision: post.revision,
      kind: 'manual',
    });
    expect(res.status).toBe(200);
    post = (await json<{ post: Post }>(res)).post;
  }
  return post;
}

// ---------------------------------------------------------------- auth wall

describe('the revision routes are all authenticated', () => {
  it('every one of them is 401 without a session', async () => {
    const post = await create(owner, { title: 'Guarded' });
    expect((await anon.get(`/api/posts/${post.id}/revisions`)).status).toBe(401);
    expect((await anon.get('/api/revisions/r_whatever')).status).toBe(401);
    expect(
      (await anon.post(`/api/posts/${post.id}/revisions/r_whatever/restore`)).status,
    ).toBe(401);
    expect((await anon.get('/api/export')).status).toBe(401);
    expect((await anon.post('/api/import', { format: BUNDLE_FORMAT, posts: [] })).status).toBe(
      401,
    );
  });

  it('an absent post or revision is 404 gone', async () => {
    expect((await owner.get('/api/posts/p_missing/revisions')).status).toBe(404);
    expect((await owner.get('/api/revisions/r_missing')).status).toBe(404);
    const res = await owner.post('/api/posts/p_missing/revisions/r_missing/restore');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('gone');
  });
});

// ------------------------------------------------------------------ listing

describe('GET /api/posts/:id/revisions', () => {
  it('paginates and omits bodies', async () => {
    const post = await withHistory(owner, 5);

    const first = await owner.get(`/api/posts/${post.id}/revisions?limit=3`);
    expect(first.status).toBe(200);
    const a = await json<{ items: RevisionMeta[]; nextCursor: string | null }>(first);
    expect(a.items).toHaveLength(3);
    // Newest first.
    expect(a.items.map((r) => r.revision)).toEqual([6, 5, 4]);
    // NEVER a document: history is unbounded in rows and each row holds a whole
    // one, so a list carrying bodies ships the store to draw a sidebar.
    for (const item of a.items) expect('content' in item).toBe(false);
    expect(JSON.stringify(a)).not.toContain('version 5');
    expect(a.nextCursor).toBeTruthy();

    const second = await owner.get(
      `/api/posts/${post.id}/revisions?limit=3&cursor=${encodeURIComponent(a.nextCursor!)}`,
    );
    const b = await json<{ items: RevisionMeta[]; nextCursor: string | null }>(second);
    expect(b.items.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(b.nextCursor).toBeNull();
  });

  it('a full walk returns each revision exactly once', async () => {
    const post = await withHistory(owner, 7);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const body = await json<{ items: RevisionMeta[]; nextCursor: string | null }>(
        await owner.get(`/api/posts/${post.id}/revisions?limit=2${query}`),
      );
      seen.push(...body.items.map((r: RevisionMeta) => r.revision));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a cursor from the post list cannot be spent here', async () => {
    // One codec, one binding rule: a cursor names the sort that minted it.
    await create(owner, { title: 'A' });
    await create(owner, { title: 'B' });
    const post = await withHistory(owner, 2);
    const listCursor = (
      await json<{ nextCursor: string }>(await owner.get('/api/posts?limit=1'))
    ).nextCursor;

    const res = await owner.get(
      `/api/posts/${post.id}/revisions?cursor=${encodeURIComponent(listCursor)}`,
    );
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('cursor');
  });

  it('an out-of-range limit is a 400', async () => {
    const post = await create(owner, { title: 'Limits' });
    const res = await owner.get(`/api/posts/${post.id}/revisions?limit=101`);
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('limit');
  });

  it('a writer can read another writer’s history — one shared blog', async () => {
    const post = await withHistory(owner, 2);
    const res = await writer.get(`/api/posts/${post.id}/revisions`);
    expect(res.status).toBe(200);
    expect((await json<{ items: RevisionMeta[] }>(res)).items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------- get

describe('GET /api/revisions/:revId', () => {
  it('returns one full snapshot, document and all', async () => {
    const post = await withHistory(owner, 2);
    const list = await json<{ items: RevisionMeta[] }>(
      await owner.get(`/api/posts/${post.id}/revisions`),
    );
    const target = list.items.find((r) => r.revision === 2)!;

    const res = await owner.get(`/api/revisions/${target.id}`);
    expect(res.status).toBe(200);
    const body = await json<{ revision: { content: DocNode; revision: number } }>(res);
    expect(body.revision.revision).toBe(2);
    expect(body.revision.content).toEqual(doc('version 1'));
  });
});

// ------------------------------------------------------------------ restore

describe('POST /api/posts/:id/revisions/:revId/restore', () => {
  it('writes a new revision rather than rewinding', async () => {
    const post = await withHistory(owner, 3);
    const list = await json<{ items: RevisionMeta[] }>(
      await owner.get(`/api/posts/${post.id}/revisions`),
    );
    const old = list.items.find((r) => r.revision === 2)!;

    const res = await owner.post(`/api/posts/${post.id}/revisions/${old.id}/restore`);
    expect(res.status).toBe(200);
    const restored = (await json<{ post: Post }>(res)).post;

    // Forward, never back.
    expect(restored.revision).toBe(post.revision + 1);
    expect(restored.content).toEqual(doc('version 1'));

    const after = await json<{ items: RevisionMeta[] }>(
      await owner.get(`/api/posts/${post.id}/revisions`),
    );
    // The version we were on before the restore is still there.
    expect(after.items.map((r) => r.revision)).toEqual([5, 4, 3, 2, 1]);
    const newest = after.items[0];
    expect(newest.note).toBe('Restored revision 2');
    // 'manual', so a restore checkpoint is never reclaimed by pruning.
    expect(newest.kind).toBe('manual');
  });

  it('a revision belonging to another post cannot be pulled in', async () => {
    /*
     * `revId` arrives from a URL. Looked up without `post_id`, anyone who can
     * write to one post could pull the title and body of any revision of any
     * other post into it.
     */
    const mine = await create(owner, { title: 'Mine', content: doc('my words') });
    const theirs = await withHistory(writer, 2, 'Theirs');
    const theirRevisions = await json<{ items: RevisionMeta[] }>(
      await writer.get(`/api/posts/${theirs.id}/revisions`),
    );

    const res = await owner.post(
      `/api/posts/${mine.id}/revisions/${theirRevisions.items[0].id}/restore`,
    );
    expect(res.status).toBe(404);
    const after = await owner.get(`/api/posts/${mine.id}`);
    expect((await json<{ post: Post }>(after)).post.content).toEqual(doc('my words'));
  });

  it("a writer cannot restore into another writer's post; the owner can", async () => {
    const ownersPost = await withHistory(owner, 2, 'Owned');
    const revisions = await json<{ items: RevisionMeta[] }>(
      await owner.get(`/api/posts/${ownersPost.id}/revisions`),
    );
    const target = revisions.items[1];

    const refused = await writer.post(
      `/api/posts/${ownersPost.id}/revisions/${target.id}/restore`,
    );
    expect(refused.status).toBe(403);

    const allowed = await owner.post(
      `/api/posts/${ownersPost.id}/revisions/${target.id}/restore`,
    );
    expect(allowed.status).toBe(200);
  });
});

// ------------------------------------------------------------------- export

describe('GET /api/export', () => {
  it('is owner-only', async () => {
    const res = await writer.get('/api/export');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('forbidden');
  });

  it('is rate limited', async () => {
    for (let i = 0; i < BACKUP_LIMIT; i += 1) {
      expect((await owner.get('/api/export')).status).toBe(200);
    }
    const res = await owner.get('/api/export');
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('returns the Bundle shape with every post and its history', async () => {
    const a = await withHistory(owner, 2, 'First');
    const b = await create(writer, { title: 'Second', content: doc('other words') });

    const res = await owner.get('/api/export');
    expect(res.status).toBe(200);
    const bundle = await json<Bundle>(res);

    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(new Date(bundle.exportedAt).toString()).not.toBe('Invalid Date');
    expect(bundle.posts.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    // Documents are in the export — this is the escape hatch, not a list.
    expect(bundle.posts.find((p) => p.id === b.id)!.content).toEqual(doc('other words'));
    expect(bundle.revisions.filter((r) => r.postId === a.id)).toHaveLength(3);
    // No image store until Project B, and the key is present rather than
    // absent so an existing consumer can still parse it.
    expect(bundle.images).toEqual([]);
  });

  it('never carries content_text or the search vector', async () => {
    await create(owner, { title: 'Indexed', content: doc('lexemes and positions') });
    const text = await (await owner.get('/api/export')).text();
    expect(text).not.toContain('content_text');
    expect(text).not.toContain('contentText');
    expect(text).not.toContain('"search"');
    expect(text).not.toContain('lifecycle_generation');
  });
});

// ------------------------------------------------------------------- import

describe('POST /api/import', () => {
  const bundle = (posts: Record<string, unknown>[]): Record<string, unknown> => ({
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    posts,
    revisions: [],
    images: [],
  });

  const post = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Imported ${id}`,
    subtitle: '',
    content: doc('imported words'),
    ...over,
  });

  it('PRESERVES incoming post ids', async () => {
    /*
     * spec §5.5 — ARCHITECTURE.md §3 promises these ids are stable. Minting new
     * ones leaves local rows pointing at posts the server never heard of, so
     * every later save 404s and the writer types into an unsavable post.
     */
    const res = await owner.post('/api/import', bundle([post('p_from_the_client')]));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ imported: 1, skipped: 0 });

    const fetched = await owner.get('/api/posts/p_from_the_client');
    expect(fetched.status).toBe(200);
    expect((await json<{ post: Post }>(fetched)).post.id).toBe('p_from_the_client');
  });

  it('importing the same bundle twice skips rather than duplicating', async () => {
    const body = bundle([post('p_one'), post('p_two')]);
    expect(await json(await owner.post('/api/import', body))).toMatchObject({
      imported: 2,
      skipped: 0,
    });
    expect(await json(await owner.post('/api/import', body))).toMatchObject({
      imported: 0,
      skipped: 2,
    });

    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('rejects a bundle containing an invalid document, writing nothing', async () => {
    // Import is the one path carrying content the requester did not author —
    // exactly what validateDoc exists for.
    const res = await owner.post(
      '/api/import',
      bundle([
        post('p_good'),
        post('p_bad', { content: { type: 'doc', content: [{ type: 'script' }] } }),
        post('p_also_good'),
      ]),
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error).toBe('invalid_document');
    // The index as well as the position, or "invalid document" over a 400-post
    // bundle is not something anyone can act on.
    expect(body.path).toBe('posts[1].content[0]');

    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('rejects over-long metadata the same way, before writing', async () => {
    const res = await owner.post(
      '/api/import',
      bundle([post('p_shouty', { title: 'x'.repeat(MAX_TITLE_BYTES + 1) })]),
    );
    expect(res.status).toBe(422);
    expect((await json(res)).path).toBe('posts[0].title');
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('assigns author_id to the importing user', async () => {
    await writer.post('/api/import', bundle([post('p_mine', { authorId: 'some-other-uuid' })]));
    const fetched = await json<{ post: Post }>(await writer.get('/api/posts/p_mine'));
    // Never the bundle's: a foreign users.id would fail the key, and a real
    // local one would let anyone attribute writing to a colleague.
    expect(fetched.post.authorId).toBe(ctx.users.writer.id);
    expect(fetched.post.authorName).toBe(ctx.users.writer.displayName);
  });

  it('a bundle authorId naming a REAL other user is still not honoured', async () => {
    /*
     * THE MUTANT THIS PINS: adding `authorId: post.authorId` to `toPartial`
     * left all 459 server tests green, because the only existing probe used a
     * string that was not a real users.id. With a real one it is impersonation
     * — the writer imports a bundle and the post is attributed to the owner —
     * and it is also self-denial-of-service: `authorize` keys on
     * `post.authorId`, so the importer could not write to their own import.
     */
    const res = await writer.post(
      '/api/import',
      bundle([post('p_forged', { authorId: ctx.users.owner.id, authorName: 'The Owner' })]),
    );
    expect(res.status).toBe(200);

    const fetched = await json<{ post: Post }>(await writer.get('/api/posts/p_forged'));
    expect(fetched.post.authorId).toBe(ctx.users.writer.id);
    expect(fetched.post.authorId).not.toBe(ctx.users.owner.id);
    expect(fetched.post.authorName).toBe(ctx.users.writer.displayName);

    // And therefore the importer can still write to what they imported.
    const saved = await writer.patch('/api/posts/p_forged', { patch: { title: 'Mine' } });
    expect(saved.status).toBe(200);
  });

  it('an unknown TOP-LEVEL bundle key is a 400 — ImportBody is strict too', async () => {
    /*
     * `.strict()` on `ImportBody` was a surviving mutant: every existing probe
     * put its unknown key inside `posts[0]`, which `BundlePost.strict()`
     * catches, so dropping the outer one changed nothing.
     */
    const res = await owner.post('/api/import', {
      ...bundle([post('p_ok')]),
      settings: { theme: 'dark' },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('settings');
  });

  it('restores status and timestamps but never revision or the counts', async () => {
    const created = Date.now() - 90_000_000;
    await owner.post(
      '/api/import',
      bundle([
        post('p_state', {
          status: 'published',
          createdAt: created,
          publishedAt: created + 1000,
          category: 'essays',
          tags: ['a', 'b'],
          template: 'minimal',
          revision: 47,
          wordCount: 9999,
        }),
      ]),
    );
    const body = await json<{ post: Post }>(await owner.get('/api/posts/p_state'));
    expect(body.post).toMatchObject({
      status: 'published',
      createdAt: created,
      publishedAt: created + 1000,
      category: 'essays',
      template: 'minimal',
    });
    expect(body.post.tags).toEqual(['a', 'b']);
    // Server-owned derivation (spec §4.4): re-derived, never adopted.
    expect(body.post.revision).toBe(1);
    expect(body.post.wordCount).toBe(2);
  });

  it('reports what it did not restore rather than dropping it silently', async () => {
    const res = await owner.post('/api/import', {
      format: BUNDLE_FORMAT,
      posts: [post('p_reported')],
      revisions: [{ id: 'r_1' }, { id: 'r_2' }],
      images: [{ id: 'img_1' }],
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      imported: 1,
      ignored: { revisions: 2, images: 1 },
    });
  });

  it('a hostile slug is slugified, not stored verbatim', async () => {
    await owner.post('/api/import', bundle([post('p_slug', { slug: '../../admin' })]));
    const body = await json<{ post: Post }>(await owner.get('/api/posts/p_slug'));
    expect(body.post.slug).toBe('admin');
  });

  it('two bundle posts claiming one slug both import', async () => {
    const res = await owner.post(
      '/api/import',
      bundle([post('p_a', { slug: 'shared' }), post('p_b', { slug: 'shared' })]),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).imported).toBe(2);
    const slugs = await ctx.db.execute(sql`SELECT slug FROM posts ORDER BY slug`);
    expect(slugs.rows.map((r) => r.slug)).toEqual(['shared', 'shared-2']);
  });

  it('an unknown key or a foreign format is a 400', async () => {
    const unknown = await owner.post(
      '/api/import',
      bundle([post('p_x', { somethingElse: true })]),
    );
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).detail).toBe('posts.0.somethingElse');

    const foreign = await owner.post('/api/import', {
      format: 'someone-elses-app/v1',
      posts: [],
    });
    expect(foreign.status).toBe(400);
    expect((await json(foreign)).detail).toBe('format');
  });

  it('a bundle repeating one id inside itself is a 400', async () => {
    const res = await owner.post('/api/import', bundle([post('p_dup'), post('p_dup')]));
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('posts.id');
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('is available to a writer and rate limited', async () => {
    for (let i = 0; i < BACKUP_LIMIT; i += 1) {
      const res = await writer.post('/api/import', bundle([post(`p_rl_${i}`)]));
      expect(res.status).toBe(200);
    }
    const res = await writer.post('/api/import', bundle([post('p_rl_last')]));
    expect(res.status).toBe(429);
  });

  it('round-trips through export: the words come back', async () => {
    const original = await create(owner, {
      title: 'Round trip',
      content: doc('the words that matter'),
    });
    const exported = await json<Bundle>(await owner.get('/api/export'));
    await ctx.db.execute(sql`DELETE FROM posts`);

    const res = await owner.post('/api/import', {
      format: exported.format,
      exportedAt: exported.exportedAt,
      posts: exported.posts,
      revisions: exported.revisions,
      images: exported.images,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.imported).toBe(1);
    // History is NOT restored, and the response says so rather than implying a
    // complete round trip. See the note in server/routes/backup.ts.
    expect((body.ignored as { revisions: number }).revisions).toBe(1);

    const back = await json<{ post: Post }>(await owner.get(`/api/posts/${original.id}`));
    expect(back.post.content).toEqual(doc('the words that matter'));
    expect(back.post.title).toBe('Round trip');
  });
});
