/**
 * Lifecycle, destroy and the maintenance sweeps, end to end (spec §4.2, §5.2,
 * §5.4).
 *
 * The property that matters most here is the one spec §4.2 spends a page on: a
 * refused transition and a lost race are DIFFERENT 409s. `precondition_failed`
 * means "the post is already published"; `stale_write` means "someone else got
 * there first, here is theirs". Reported as one, the refusal arrives with
 * `expected === actual`, which no conflict banner can render.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import type { AuthUser, DocNode, Post } from '../../shared/types';

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

async function create(c: HttpClient, patch: Record<string, unknown> = {}): Promise<Post> {
  const res = await c.post('/api/posts', patch);
  expect(res.status).toBe(201);
  return (await json<{ post: Post }>(res)).post;
}

/** Run a lifecycle route and return the post it hands back. */
async function transition(c: HttpClient, id: string, op: string): Promise<Post> {
  const res = await c.post(`/api/posts/${id}/${op}`);
  expect(res.status, `${op} -> ${res.status}`).toBe(200);
  return (await json<{ post: Post }>(res)).post;
}

const OPS = [
  'publish',
  'unpublish',
  'archive',
  'unarchive',
  'trash',
  'restore',
] as const;

// ---------------------------------------------------------------- auth wall

describe('the lifecycle and maintenance routes are all authenticated', () => {
  it('every one of them is 401 without a session', async () => {
    const post = await create(owner, { title: 'Guarded' });
    const paths = [
      ...OPS.map((op) => `/api/posts/${post.id}/${op}`),
      `/api/posts/${post.id}/duplicate`,
      '/api/posts/sweep-blank',
      '/api/trash/empty',
    ];
    for (const path of paths) {
      const res = await anon.post(path, {});
      expect(res.status, path).toBe(401);
      expect((await json(res)).error, path).toBe('unauthenticated');
    }
    const destroy = await anon.del(`/api/posts/${post.id}`);
    expect(destroy.status).toBe(401);
  });

  it('every one of them is 403 with a foreign Origin', async () => {
    const post = await create(owner, { title: 'CSRF' });
    const res = await owner.request(`/api/posts/${post.id}/publish`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    });
    expect(res.status).toBe(403);
    // And nothing happened.
    const after = await owner.get(`/api/posts/${post.id}`);
    expect((await json<{ post: Post }>(after)).post.status).toBe('draft');
  });

  it('an absent post is 404 on every lifecycle route', async () => {
    for (const op of [...OPS, 'duplicate']) {
      const res = await owner.post(`/api/posts/p_missing/${op}`);
      expect(res.status, op).toBe(404);
      expect((await json(res)).error, op).toBe('gone');
    }
  });
});

// ------------------------------------------------------------ the six moves

describe('the six transitions', () => {
  it('each returns the new post so the editor can adopt the revision', async () => {
    const post = await create(owner, { title: 'Moves', content: doc('some words') });

    const published = await transition(owner, post.id, 'publish');
    expect(published.status).toBe('published');
    expect(published.revision).toBe(post.revision + 1);
    // Publish is the only transition that mints an address.
    expect(published.slug).toBe('moves');
    expect(published.publishedAt).toBeTruthy();

    const unpublished = await transition(owner, post.id, 'unpublish');
    expect(unpublished.status).toBe('draft');
    expect(unpublished.revision).toBe(published.revision + 1);

    const archived = await transition(owner, post.id, 'archive');
    expect(archived.status).toBe('archived');

    const unarchived = await transition(owner, post.id, 'unarchive');
    expect(unarchived.status).toBe('draft');

    const trashed = await transition(owner, post.id, 'trash');
    expect(trashed.deletedAt).toBeTruthy();

    const restored = await transition(owner, post.id, 'restore');
    expect(restored.deletedAt).toBeNull();
    expect(restored.revision).toBe(post.revision + 6);
  });

  it('writes a status snapshot per move, so history has no unexplained gaps', async () => {
    const post = await create(owner, { title: 'Trail' });
    await transition(owner, post.id, 'publish');
    await transition(owner, post.id, 'unpublish');

    const rows = await ctx.db.execute(
      sql`SELECT revision, kind, note FROM revisions WHERE post_id = ${post.id}
           ORDER BY revision`,
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['manual', 'publish', 'status']);
    expect(rows.rows[2].note).toBe('Moved back to drafts');
  });

  it('publish also untrashes, so a published post is never left for emptyTrash', async () => {
    const post = await create(owner, { title: 'Rescued' });
    await transition(owner, post.id, 'trash');
    const published = await transition(owner, post.id, 'publish');
    expect(published.status).toBe('published');
    expect(published.deletedAt).toBeNull();
  });

  it('a writer cannot move another writer’s post; the owner can', async () => {
    const ownersPost = await create(owner, { title: 'Not yours' });
    const refused = await writer.post(`/api/posts/${ownersPost.id}/publish`);
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toBe('forbidden');

    const writersPost = await create(writer, { title: 'Theirs' });
    const allowed = await owner.post(`/api/posts/${writersPost.id}/publish`);
    expect(allowed.status).toBe(200);
  });

  it('a writer can move their own post', async () => {
    const mine = await create(writer, { title: 'Mine' });
    expect((await transition(writer, mine.id, 'publish')).status).toBe('published');
  });
});

// ------------------------------------------------------------ preconditions

describe('a lifecycle op whose precondition no longer holds', () => {
  it('returns 409 precondition_failed, not 200 and not stale_write', async () => {
    const post = await create(owner, { title: 'Twice' });
    const first = await transition(owner, post.id, 'publish');

    const second = await owner.post(`/api/posts/${post.id}/publish`);
    expect(second.status).toBe(409);
    const body = await json<{ error: string; operation: string; post: Post }>(second);
    expect(body.error).toBe('precondition_failed');
    expect(body.operation).toBe('publish');
    // The state that refused it rides along, so a client reconciles without a
    // second round trip.
    expect(body.post.id).toBe(post.id);
    expect(body.post.revision).toBe(first.revision);
    expect(body.post.status).toBe('published');
    // And it is NOT the conflict shape: an equal expected/actual pair is what
    // this error exists to stop being reported.
    expect((body as unknown as Record<string, unknown>).expected).toBeUndefined();
    expect((body as unknown as Record<string, unknown>).actual).toBeUndefined();
  });

  it('holds for every refusable move, and nothing is written', async () => {
    const post = await create(owner, { title: 'Refusals' });
    const cases: [string, string][] = [
      ['unpublish', 'unpublish'], // never published
      ['unarchive', 'unarchive'], // never archived
      ['restore', 'restore'], // never trashed
    ];
    for (const [op, operation] of cases) {
      const before = await owner.get(`/api/posts/${post.id}`);
      const beforePost = (await json<{ post: Post }>(before)).post;

      const res = await owner.post(`/api/posts/${post.id}/${op}`);
      expect(res.status, op).toBe(409);
      const body = await json(res);
      expect(body.error, op).toBe('precondition_failed');
      expect(body.operation, op).toBe(operation);

      const after = await owner.get(`/api/posts/${post.id}`);
      expect((await json<{ post: Post }>(after)).post.revision, op).toBe(
        beforePost.revision,
      );
    }
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${post.id}`,
    );
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it('a content edit racing a publish does not refuse it — the retry re-derives', async () => {
    // A concurrent autosave moves `revision` but not `lifecycle_generation`, so
    // the publish re-bases and wins, and derives its slug from the NEWER title.
    const post = await create(owner, { title: 'Old title' });
    await owner.patch(`/api/posts/${post.id}`, {
      patch: { title: 'New title' },
      baseRevision: post.revision,
    });
    const published = await transition(owner, post.id, 'publish');
    expect(published.slug).toBe('new-title');
  });

  it('a generation that merely moved in the PAST is not a conflict', async () => {
    // The transition pins the generation it reads, not zero. A post that has
    // been archived and unarchived last week must still be publishable.
    const post = await create(owner, { title: '历史' });
    await transition(owner, post.id, 'archive');
    await transition(owner, post.id, 'unarchive');
    const res = await owner.post(`/api/posts/${post.id}/publish`);
    expect(res.status).toBe(200);
  });

  it('a lifecycle op that LOSES a race is a stale_write, with expected ≠ actual', async () => {
    /*
     * The other 409, and the route must not present it as a refusal.
     *
     * Forced with a handle that runs a concurrent lifecycle change immediately
     * before every CAS — the same technique `server/repo/lifecycle.test.ts`
     * uses, because PGlite is single-connection and cannot interleave two real
     * sessions. `deleted_at` is flipped rather than `lifecycle_generation`
     * being set directly: the column is trigger-owned, so an UPDATE naming it
     * is overwritten (pinned by `lifecycle.test.ts`). Flipping the trash flag
     * moves the generation the way a real racing writer would, bumps `revision`
     * alongside it, and leaves `status` alone so `archive`'s precondition still
     * holds — which is what makes this a LOST RACE rather than a refusal.
     */
    const post = await create(owner, { title: 'Contended' });
    const raced = racingLifecycle(ctx.db, post.id);
    const client = httpClient(raced);
    await client.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });

    const res = await client.post(`/api/posts/${post.id}/archive`);
    expect(res.status).toBe(409);
    const body = await json<{ error: string; expected: number; actual: number; post: Post }>(
      res,
    );
    expect(body.error).toBe('stale_write');
    // The distinction the two errors exist for: a real conflict has two
    // different revisions, which is what a conflict banner renders.
    expect(body.expected).toBe(post.revision);
    expect(body.actual).toBeGreaterThan(body.expected);
    expect(body.post.id).toBe(post.id);
    // And it lost: nothing was archived.
    expect(body.post.status).toBe('draft');
  });
});

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string } };
}

/**
 * A `Db` that performs a concurrent lifecycle change just before every
 * lifecycle CAS, so the pinned generation can never match.
 *
 * Matches on the rendered predicate rather than on a call count, so it fires on
 * exactly the statement it means to and passes reads through untouched.
 */
function racingLifecycle(db: TestCtx['db'], id: string): TestCtx['db'] {
  let inside = false;
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        const built = (target as unknown as Dialecty).dialect.sqlToQuery(args[0]);
        if (inside || !/lifecycle_generation = \$\d+/.test(built.sql)) {
          return execute.apply(target, args);
        }
        inside = true;
        try {
          await execute.apply(target, [
            sql`UPDATE posts
                   SET revision = revision + 1,
                       deleted_at = CASE WHEN deleted_at IS NULL
                                         THEN ${Date.now()}::bigint ELSE NULL END
                 WHERE id = ${id}`,
          ]);
        } finally {
          inside = false;
        }
        return execute.apply(target, args);
      };
    },
  });
}

// ---------------------------------------------------------------- duplicate

describe('POST /api/posts/:id/duplicate', () => {
  it('copies the words and resets everything system-owned', async () => {
    const source = await create(owner, { title: 'Original', content: doc('the words') });
    await transition(owner, source.id, 'publish');

    const res = await owner.post(`/api/posts/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = (await json<{ post: Post }>(res)).post;

    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe('Original (copy)');
    expect(copy.content).toEqual(doc('the words'));
    // A copy is a new draft, not a second published post at the same address.
    expect(copy.status).toBe('draft');
    expect(copy.slug).toBeNull();
    expect(copy.publishedAt).toBeNull();
    expect(copy.revision).toBe(1);
  });

  it('a writer may duplicate someone else’s post, and owns the copy', async () => {
    // Everyone authenticated already reads everything (spec §6), so this is
    // what a writer would otherwise do by selecting the text.
    const ownersPost = await create(owner, { title: 'Theirs' });
    const res = await writer.post(`/api/posts/${ownersPost.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = (await json<{ post: Post }>(res)).post;
    expect(copy.authorId).toBe(ctx.users.writer.id);
    expect(copy.authorName).toBe(ctx.users.writer.displayName);
  });
});

// ------------------------------------------------------------------ destroy

describe('DELETE /api/posts/:id', () => {
  it("a writer cannot DELETE another writer's post; the owner can", async () => {
    const ownersPost = await create(owner, { title: 'Owner post' });
    const refused = await writer.del(`/api/posts/${ownersPost.id}`);
    expect(refused.status).toBe(403);

    const allowed = await owner.del(`/api/posts/${ownersPost.id}`);
    expect(allowed.status).toBe(200);
    expect((await json(allowed)).ok).toBe(true);
    expect((await owner.get(`/api/posts/${ownersPost.id}`)).status).toBe(404);
  });

  it('is owner-only even for a writer’s OWN post (spec §6 over §5.2)', async () => {
    /*
     * The one place the spec disagrees with itself: §5.2's table annotates this
     * route "author or owner", §6 says destroy is owner-only. §6 wins — see
     * server/authorize.ts. `destroyPost` is irreversible and CASCADEs away
     * every revision; trash is the reversible door a writer already has.
     */
    const mine = await create(writer, { title: 'My own' });
    const res = await writer.del(`/api/posts/${mine.id}`);
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('forbidden');
    expect((await writer.get(`/api/posts/${mine.id}`)).status).toBe(200);
  });

  it('takes the revisions with it, in one statement', async () => {
    const post = await create(owner, { title: 'History' });
    await transition(owner, post.id, 'publish');
    await owner.del(`/api/posts/${post.id}`);
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${post.id}`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('destroying twice is a 404, not a 500', async () => {
    const post = await create(owner, { title: 'Gone' });
    expect((await owner.del(`/api/posts/${post.id}`)).status).toBe(200);
    const again = await owner.del(`/api/posts/${post.id}`);
    expect(again.status).toBe(404);
    expect((await json(again)).error).toBe('gone');
  });
});

// -------------------------------------------------------------- empty trash

describe('POST /api/trash/empty', () => {
  it('is owner-only', async () => {
    const res = await writer.post('/api/trash/empty');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('forbidden');
  });

  it('destroys every trashed post and reports the count', async () => {
    const kept = await create(owner, { title: 'Kept' });
    const a = await create(owner, { title: 'Bin A' });
    const b = await create(writer, { title: 'Bin B' });
    await transition(owner, a.id, 'trash');
    await transition(writer, b.id, 'trash');

    const res = await owner.post('/api/trash/empty');
    expect(res.status).toBe(200);
    expect((await json(res)).emptied).toBe(2);

    expect((await owner.get(`/api/posts/${a.id}`)).status).toBe(404);
    expect((await owner.get(`/api/posts/${b.id}`)).status).toBe(404);
    expect((await owner.get(`/api/posts/${kept.id}`)).status).toBe(200);
  });

  it('an empty bin is 0, not an error', async () => {
    const res = await owner.post('/api/trash/empty');
    expect(res.status).toBe(200);
    expect((await json(res)).emptied).toBe(0);
  });
});

// -------------------------------------------------------------- sweep blank

describe('POST /api/posts/sweep-blank', () => {
  /** Age a draft past the 60-second grace period. */
  const age = (id: string) =>
    ctx.db.execute(sql`UPDATE posts SET updated_at = ${Date.now() - 120_000} WHERE id = ${id}`);

  it('returns the count and respects exceptId', async () => {
    const a = await create(owner);
    const b = await create(owner);
    const editing = await create(owner);
    await age(a.id);
    await age(b.id);
    await age(editing.id);

    const res = await owner.post('/api/posts/sweep-blank', { exceptId: editing.id });
    expect(res.status).toBe(200);
    expect((await json(res)).swept).toBe(2);

    expect((await owner.get(`/api/posts/${editing.id}`)).status).toBe(200);
    expect((await owner.get(`/api/posts/${a.id}`)).status).toBe(404);
  });

  it('works with no body at all', async () => {
    const blank = await create(owner);
    await age(blank.id);
    const res = await owner.request('/api/posts/sweep-blank', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await json(res)).swept).toBe(1);
  });

  it('never sweeps a draft with content, however few words it has', async () => {
    // The frontend gauntlet's sharpest finding: word_count = 0 is not emptiness.
    const imageOnly = await create(owner, {
      content: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'https://example.test/a.png' } }],
      },
    });
    const withWords = await create(owner, { content: doc('a few words') });
    await age(imageOnly.id);
    await age(withWords.id);

    const res = await owner.post('/api/posts/sweep-blank', {});
    expect((await json(res)).swept).toBe(0);
    expect((await owner.get(`/api/posts/${imageOnly.id}`)).status).toBe(200);
    expect((await owner.get(`/api/posts/${withWords.id}`)).status).toBe(200);
  });

  it('respects the grace period, so a draft in another tab survives', async () => {
    await create(owner);
    const res = await owner.post('/api/posts/sweep-blank', {});
    expect((await json(res)).swept).toBe(0);
  });

  it('is available to a writer — spec §5.4 marks only collect-orphans owner-only', async () => {
    const blank = await create(writer);
    await age(blank.id);
    const res = await writer.post('/api/posts/sweep-blank', {});
    expect(res.status).toBe(200);
    expect((await json(res)).swept).toBe(1);
  });

  it('an unknown body key is a 400', async () => {
    const res = await owner.post('/api/posts/sweep-blank', { exceptIds: ['a'] });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('exceptIds');
  });

  it('NEVER touches another writer’s draft', async () => {
    /*
     * REPRODUCED BEFORE THE FIX. The sweep was scoped to nothing but the blank
     * predicate, so any authenticated caller swept the whole deployment: the
     * owner leaves an untitled draft, it ages past the grace window, the writer
     * mounts their dashboard and calls sweep-blank with their own exceptId, and
     * the owner's row is HARD DELETED. No words are lost — the document walk
     * held — but a draft vanishes under its author and the tab they still have
     * open 404s on its next autosave.
     *
     * Scoped rather than made owner-only: spec §5.4's table marks
     * /images/collect-orphans owner-only and leaves this one unmarked, and an
     * owner-only sweep would simply never run for a writer.
     */
    const theirs = await create(owner);
    const mine = await create(writer);
    const editing = await create(writer);
    await age(theirs.id);
    await age(mine.id);
    await age(editing.id);

    const res = await writer.post('/api/posts/sweep-blank', { exceptId: editing.id });
    expect(res.status).toBe(200);
    expect((await json(res)).swept).toBe(1);

    expect((await owner.get(`/api/posts/${theirs.id}`)).status).toBe(200);
    expect((await owner.get(`/api/posts/${editing.id}`)).status).toBe(200);
    expect((await owner.get(`/api/posts/${mine.id}`)).status).toBe(404);
  });
});
