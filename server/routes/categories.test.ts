/**
 * Managed categories end to end (HANDOFF §2 A3).
 *
 * Everything goes through `app.request()` with real cookies and bodies, because
 * the seam is what this task adds: the union of two half-lists, a guard that
 * differs per method, and three refusals that have to arrive as the 409 the
 * client was written against.
 *
 * THE RESPONSE SHAPES ARE ASSERTED FIELD BY FIELD ON PURPOSE. `src/data/api-
 * categories.ts` was written before this route existed, and three frontend
 * surfaces are being built against it in parallel — so `{ categories }`,
 * `{ category }`, `{ category, movedPosts }` and `{ movedPosts }` are a contract,
 * not an implementation detail, and a rename of one field here is a compile-clean
 * break of three screens.
 *
 * ONE PROPERTY IS WORTH MORE THAN THE REST and is the last test in this file: a
 * rename must not move `posts.revision` or `posts.updated_at`. Both are easy to
 * bump by accident with a `SET updated_at = ...` that looks like housekeeping,
 * and either would be invisible in every other assertion here while 409-ing every
 * open editor in the building and reordering the whole dashboard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { MAX_CATEGORY_BYTES } from '../../shared/validate';
import type { CategorySummary } from '../repo/categories';
import type { AuthUser, Post } from '../../shared/types';

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
let anon: HttpClient;

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
  await ctx.db.execute(sql`DELETE FROM categories`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  anon = httpClient(ctx.db);
});

// --------------------------------------------------------------- the helpers

/** A post carrying `category`, as the owner. */
async function draft(category: string, title = 'A post'): Promise<Post> {
  const res = await owner.post('/api/posts', { title, category });
  expect(res.status).toBe(201);
  return (await json<{ post: Post }>(res)).post;
}

async function list(c: HttpClient = owner): Promise<CategorySummary[]> {
  const res = await c.get('/api/categories');
  expect(res.status).toBe(200);
  return (await json<{ categories: CategorySummary[] }>(res)).categories;
}

async function manage(name: string, c: HttpClient = owner): Promise<CategorySummary> {
  const res = await c.post('/api/categories', { name });
  expect(res.status).toBe(201);
  return (await json<{ category: CategorySummary }>(res)).category;
}

interface Refusal {
  error: string;
  operation: string;
  category: CategorySummary;
  requestId: string;
}

// ----------------------------------------------------------------- auth wall

describe('every category route needs a session', () => {
  it('is 401 for reads, creates, renames and deletes alike', async () => {
    const design = await manage('Design');
    const cases: [string, () => Promise<Response>][] = [
      ['GET /api/categories', () => anon.get('/api/categories')],
      ['POST /api/categories', () => anon.post('/api/categories', { name: 'X' })],
      [
        'PATCH /api/categories/:id',
        () => anon.patch(`/api/categories/${design.id}`, { name: 'X' }),
      ],
      ['DELETE /api/categories/:id', () => anon.del(`/api/categories/${design.id}`)],
    ];
    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status, name).toBe(401);
      expect((await json(res)).error, name).toBe('unauthenticated');
    }
  });

  it('a mutation with a foreign Origin is 403 even with a valid session', async () => {
    const res = await owner.request('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ name: 'Design' }),
    });
    expect(res.status).toBe(403);
  });

  it('a writer may create and rename; only the owner may delete', async () => {
    /*
     * The split is deliberate (HANDOFF §2 A3). A writer inventing a category is
     * the ordinary act this feature exists to make survivable — refusing it just
     * pushes them back to typing one into the post, which is where the typo
     * categories came from. DELETE is the one operation that rewrites
     * `posts.category` in bulk on posts the caller did not write.
     */
    const created = await manage('Writing', writer);
    const renamed = await writer.patch(`/api/categories/${created.id}`, { name: 'Prose' });
    expect(renamed.status).toBe(200);

    const refused = await writer.del(`/api/categories/${created.id}`);
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toBe('forbidden');

    expect((await owner.del(`/api/categories/${created.id}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------- the union

describe('GET /api/categories is the union of managed rows and values in use', () => {
  it('reports a legacy free-text value with a null id and managed: false', async () => {
    await draft('Ops');
    expect(await list()).toEqual([{ id: null, name: 'Ops', count: 1, managed: false }]);
  });

  it('reports a managed row nobody has used yet, with count 0', async () => {
    const writing = await manage('Writing');
    expect(await list()).toEqual([
      { id: writing.id, name: 'Writing', count: 0, managed: true },
    ]);
  });

  it('folds both sides together, ordered case-insensitively by name', async () => {
    await draft('Ops');
    await draft('design');
    await draft('Design');
    const writing = await manage('Writing');

    expect(await list()).toEqual([
      // The two casings are ONE entry: `min(category)` picks the stable spelling
      // when no managed row exists to supply the canonical one.
      { id: null, name: 'Design', count: 2, managed: false },
      { id: null, name: 'Ops', count: 1, managed: false },
      { id: writing.id, name: 'Writing', count: 0, managed: true },
    ]);
  });

  it('adopts the managed spelling over whatever the posts happen to say', async () => {
    await draft('design');
    await draft('DESIGN');
    const design = await manage('Design');

    expect(await list()).toEqual([
      { id: design.id, name: 'Design', count: 2, managed: true },
    ]);
  });

  it('counts drafts, published, archived and trashed posts alike', async () => {
    /*
     * The count is the row set a rename will actually move. Anything narrower —
     * published only, like `GET /api/public/categories`, or non-trashed only —
     * makes the UI's "N posts will move" a number the server does not keep.
     */
    const published = await draft('Design', 'One');
    const archived = await draft('Design', 'Two');
    const trashed = await draft('Design', 'Three');
    await draft('Design', 'Four');

    expect((await owner.post(`/api/posts/${published.id}/publish`)).status).toBe(200);
    expect((await owner.post(`/api/posts/${archived.id}/archive`)).status).toBe(200);
    expect((await owner.post(`/api/posts/${trashed.id}/trash`)).status).toBe(200);

    expect(await list()).toEqual([{ id: null, name: 'Design', count: 4, managed: false }]);
  });

  it("never reports '' — the absence of a category is not a category", async () => {
    await draft('');
    await draft('Ops');
    expect(await list()).toEqual([{ id: null, name: 'Ops', count: 1, managed: false }]);
  });
});

// ---------------------------------------------------------------- creating

describe('POST /api/categories', () => {
  it('creates a managed row and answers { category }', async () => {
    const res = await owner.post('/api/categories', { name: 'Design' });
    expect(res.status).toBe(201);
    const { category } = await json<{ category: CategorySummary }>(res);
    expect(category).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Design',
      count: 0,
      managed: true,
    });
  });

  it('adopts a value already in use, counting the posts that carry it', async () => {
    // The ordinary call, not an edge case: "manage the category I have been
    // typing for six months" is the same request as "create a new one", and the
    // client cannot tell them apart without asking.
    await draft('design');
    await draft('DESIGN');
    expect((await manage('Design')).count).toBe(2);
  });

  it('trims the name before storing it', async () => {
    expect((await manage('  Design  ')).name).toBe('Design');
  });

  it('refuses a duplicate in any casing with a 409 carrying the row that won', async () => {
    const design = await manage('Design');
    await draft('Design');

    const res = await owner.post('/api/categories', { name: 'dEsIgN' });
    expect(res.status).toBe(409);
    const body = await json<Refusal>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('create');
    // The payload is why the local `onError` exists: the picker can select the
    // existing row instead of making a second request to find out what it is.
    expect(body.category).toEqual({ id: design.id, name: 'Design', count: 1, managed: true });
    expect(body.requestId).toEqual(expect.any(String));
  });

  it('refuses a blank name, an oversized one, and an unknown key', async () => {
    const cases: [string, unknown, string][] = [
      ['empty', { name: '' }, 'name'],
      ['whitespace only', { name: '   ' }, 'name'],
      // Bytes, not characters: 200 four-byte characters is 400 JS `length` units
      // and 800 bytes, so a character-counting bound would let it through and the
      // rename would then fail 54000 inside a bulk UPDATE of `posts.category`.
      ['over MAX_CATEGORY_BYTES in bytes', { name: '𝍄'.repeat(200) }, 'name'],
      ['unknown key', { name: 'Design', colour: 'red' }, 'colour'],
    ];
    for (const [label, body, detail] of cases) {
      const res = await owner.post('/api/categories', body);
      expect(res.status, label).toBe(400);
      const answered = await json<{ error: string; detail: string }>(res);
      expect(answered.error, label).toBe('bad_request');
      // `detail` is a field NAME and never a value (spec §8).
      expect(answered.detail, label).toBe(detail);
    }
  });

  it('accepts a name of exactly MAX_CATEGORY_BYTES', async () => {
    const name = 'a'.repeat(MAX_CATEGORY_BYTES);
    expect((await manage(name)).name).toBe(name);
  });
});

// ----------------------------------------------------------------- renaming

describe('PATCH /api/categories/:id', () => {
  it('renames the row and moves every post carrying the old value', async () => {
    await draft('Design', 'One');
    await draft('design', 'Two');
    await draft('Ops', 'Three');
    const design = await manage('Design');

    const res = await owner.patch(`/api/categories/${design.id}`, { name: 'Product Design' });
    expect(res.status).toBe(200);
    const body = await json<{ category: CategorySummary; movedPosts: number }>(res);
    expect(body.movedPosts).toBe(2);
    expect(body.category).toEqual({
      id: design.id,
      name: 'Product Design',
      count: 2,
      managed: true,
    });

    expect(await list()).toEqual([
      { id: null, name: 'Ops', count: 1, managed: false },
      { id: design.id, name: 'Product Design', count: 2, managed: true },
    ]);
  });

  it('a case-only rename counts each post once, not twice', async () => {
    /*
     * THE REGRESSION THIS TEST EXISTS FOR. The returned `count` is assembled from
     * two sets the one statement measured — posts moved off the old name, plus
     * posts that already carried the new one. On a case-only rename those two
     * sets are the SAME posts, so a naive sum reports double and the UI tells the
     * writer a category has twice the posts it has.
     */
    await draft('design', 'One');
    await draft('design', 'Two');
    const design = await manage('design');

    const res = await owner.patch(`/api/categories/${design.id}`, { name: 'Design' });
    const body = await json<{ category: CategorySummary; movedPosts: number }>(res);
    expect(body.movedPosts).toBe(2);
    expect(body.category.count).toBe(2);
    expect(body.category.name).toBe('Design');
  });

  it('renaming onto an unmanaged value MERGES it, and the count says so', async () => {
    await draft('Design', 'One');
    await draft('Ideas', 'Two');
    await draft('Ideas', 'Three');
    const design = await manage('Design');

    const res = await owner.patch(`/api/categories/${design.id}`, { name: 'Ideas' });
    const body = await json<{ category: CategorySummary; movedPosts: number }>(res);
    // One post MOVED; three now carry the name. Both numbers are true and they
    // are different numbers, which is why the response carries both.
    expect(body.movedPosts).toBe(1);
    expect(body.category.count).toBe(3);
    expect(await list()).toEqual([{ id: design.id, name: 'Ideas', count: 3, managed: true }]);
  });

  it('refuses renaming onto another MANAGED name, and moves nothing', async () => {
    // Merging two managed rows is a different operation with a different
    // confirmation. Done silently it destroys one of them.
    const design = await manage('Design');
    const ideas = await manage('Ideas');
    await draft('Design');

    const res = await owner.patch(`/api/categories/${design.id}`, { name: 'ideas' });
    expect(res.status).toBe(409);
    const body = await json<Refusal>(res);
    expect(body.operation).toBe('rename');
    expect(body.category).toEqual({ id: ideas.id, name: 'Ideas', count: 0, managed: true });

    // The whole statement rolled back: the post still carries the old value.
    expect(await list()).toEqual([
      { id: design.id, name: 'Design', count: 1, managed: true },
      { id: ideas.id, name: 'Ideas', count: 0, managed: true },
    ]);
  });

  it('is 404 for an unknown id and 400 for one that is not a uuid', async () => {
    const unknown = '11111111-2222-3333-4444-555555555555';
    const gone = await owner.patch(`/api/categories/${unknown}`, { name: 'X' });
    expect(gone.status).toBe(404);
    expect((await json(gone)).error).toBe('gone');

    // `categories.id` is a `uuid` column, so an unchecked segment reaches the
    // driver as 22P02 and becomes a 500 the client retries five times.
    const malformed = await owner.patch('/api/categories/not-a-uuid', { name: 'X' });
    expect(malformed.status).toBe(400);
    expect((await json<{ detail: string }>(malformed)).detail).toBe('id');
  });
});

// ----------------------------------------------------------------- deleting

describe('DELETE /api/categories/:id', () => {
  it('deletes an unused category and answers { movedPosts: 0 }', async () => {
    const writing = await manage('Writing');
    const res = await owner.del(`/api/categories/${writing.id}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ movedPosts: 0 });
    expect(await list()).toEqual([]);
  });

  it('refuses while posts still use it, naming the count, and deletes nothing', async () => {
    const design = await manage('Design');
    await draft('Design', 'One');
    await draft('design', 'Two');

    const res = await owner.del(`/api/categories/${design.id}`);
    expect(res.status).toBe(409);
    const body = await json<Refusal>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('delete');
    // The count is what the reassign dialog opens with, so it rides along.
    expect(body.category).toEqual({ id: design.id, name: 'Design', count: 2, managed: true });

    expect(await list()).toEqual([
      { id: design.id, name: 'Design', count: 2, managed: true },
    ]);
  });

  it('?reassign=<name> moves the posts first and reports how many', async () => {
    const design = await manage('Design');
    await draft('Design', 'One');
    await draft('DESIGN', 'Two');

    const res = await owner.del(`/api/categories/${design.id}?reassign=${encodeURIComponent('Ops')}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ movedPosts: 2 });

    // 'Ops' is not a managed row and does not have to be: `posts.category` is
    // free text, so the target simply becomes an in-use unmanaged value.
    expect(await list()).toEqual([{ id: null, name: 'Ops', count: 2, managed: false }]);
  });

  it("?reassign=- uncategorises them, which is a real choice and not a no-op", async () => {
    const design = await manage('Design');
    await draft('Design', 'One');

    const res = await owner.del(`/api/categories/${design.id}?reassign=-`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ movedPosts: 1 });
    // Uncategorised posts are absent from the list entirely — `''` is the absence
    // of a category, not a category named the empty string.
    expect(await list()).toEqual([]);
  });

  it('is 404 for an unknown id, 400 for a non-uuid, 400 for an unknown parameter', async () => {
    const writing = await manage('Writing');

    const gone = await owner.del('/api/categories/11111111-2222-3333-4444-555555555555');
    expect(gone.status).toBe(404);
    expect((await json(gone)).error).toBe('gone');

    const malformed = await owner.del('/api/categories/nope');
    expect(malformed.status).toBe(400);
    expect((await json<{ detail: string }>(malformed)).detail).toBe('id');

    /*
     * STRICT QUERY PARSING, and this is the case that pays for it:
     * `?reassing=Ops` silently ignored would delete the category and report
     * success, leaving the posts pointing at a name nothing manages.
     */
    const mistyped = await owner.del(`/api/categories/${writing.id}?reassing=Ops`);
    expect(mistyped.status).toBe(400);
    expect((await json<{ detail: string }>(mistyped)).detail).toBe('reassing');
  });
});

// --------------------------------------------------- what a rename must not do

describe('a rename is not an edit of anybody`s post', () => {
  it('leaves revision, updatedAt and the lifecycle generation alone', async () => {
    /*
     * Bumping `revision` would 409 every open editor in the building for a typo
     * fix in a category name, and bumping `updated_at` would reorder the whole
     * dashboard, which sorts by it. Neither would fail any other assertion in
     * this file — which is exactly why this one exists.
     */
    const before = await draft('Design');
    const design = await manage('Design');

    expect(
      (await owner.patch(`/api/categories/${design.id}`, { name: 'Product Design' })).status,
    ).toBe(200);

    const after = await json<{ post: Post }>(await owner.get(`/api/posts/${before.id}`));
    expect(after.post.category).toBe('Product Design');
    expect(after.post.revision).toBe(before.revision);
    expect(after.post.updatedAt).toBe(before.updatedAt);

    // And the lifecycle CAS token the publish/trash retries pin: the trigger
    // watches `status`, `published_at` and `deleted_at`, so a rename must leave a
    // concurrent publish able to win rather than 409-ing it.
    const generation = await ctx.db.execute(
      sql`SELECT lifecycle_generation FROM posts WHERE id = ${before.id}`,
    );
    expect(Number(generation.rows[0].lifecycle_generation)).toBe(0);
  });
});
