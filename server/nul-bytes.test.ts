/**
 * A NUL byte is a 400 EVERYWHERE, not just in the four query parameters that
 * happened to call `rejectNul`.
 *
 * U+0000 cannot be stored in a Postgres `text` (SQLSTATE 22021) or in a `jsonb`
 * string (22P05). Left to reach the driver it is scrubbed to a `DbError` and
 * answered `{"error":"internal"}` — and spec §8's client retries a 5xx five
 * times over ~30 seconds before failing anyway, for input that can never be
 * accepted. Spec §8 names a NUL byte as the example that must be 400.
 *
 * Measured before the fix: 14 of 14 probes were a 500, one of them
 * (`POST /api/auth/login`) with no session at all. The control, proving the
 * boundary check existed but was applied in four places only, was
 * `GET /api/posts?search=%00` → 400.
 *
 * NAMED `nul-bytes`, NOT `nul`. `nul.test.ts` is the Windows reserved DOS
 * device name NUL with an extension bolted on: vitest ran the file happily
 * through the POSIX layer while native git could not open it at all
 * (`fatal: could not open ... No such file or directory`), so the suite would
 * have run locally and never been committed.
 *
 * THIS SUITE WALKS `app.routes` RATHER THAN A LIST WRITTEN BY HAND. A route
 * added later inherits `pathParam()` and `str()` or fails here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from './test/harness';
import { httpClient, json, type HttpClient } from './test/http';
import type { AuthUser } from '../shared/types';

const NUL = String.fromCharCode(0);

let ctx: TestCtx;
let owner: HttpClient;

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
  // The OWNER, so a route guarded by `requireOwner()` is reached rather than
  // answered 403 before the boundary check it is here to exercise.
  owner = await login(ctx.users.owner);
});

/**
 * A body every route accepts, so the probe is refused for the reason under
 * test rather than for a missing field.
 *
 * `{}` is the default — `readJsonOrEmpty` takes it and the strict schemas that
 * have no required key take it too.
 */
const BODIES: Record<string, Record<string, unknown>> = {
  'POST /api/auth/login': { email: 'someone@example.com', password: 'whatever123' },
  'POST /api/auth/accept-invite': {
    token: 'a-token',
    password: 'whatever123',
    displayName: 'Someone',
  },
  'POST /api/invites': { email: 'someone@example.com', role: 'writer' },
  'PATCH /api/posts/:id': { patch: { title: 'Title', subtitle: 'Sub', category: 'c' } },
  'POST /api/posts': { title: 'Title', subtitle: 'Sub', category: 'c', tags: ['t'] },
  'POST /api/posts/sweep-blank': { exceptId: 'p_something' },
  'POST /api/import': {
    format: 'blog-admin-bundle-v1',
    posts: [{ id: 'p_1', title: 'T', subtitle: 'S', content: { type: 'doc', content: [] } }],
  },
};

const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT']);
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

/** Every route the app has registered, deduplicated, middleware entries dropped. */
function registeredRoutes(c: HttpClient): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of c.app.routes) {
    if (!METHODS.has(route.method)) continue;
    if (!route.path.startsWith('/api/')) continue;
    seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  }
  return [...seen.values()];
}

async function send(
  c: HttpClient,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (method === 'GET') return c.get(path);
  if (method === 'DELETE') {
    return c.request(path, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  return c.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a NUL byte in a path segment', () => {
  it('finds routes to check', () => {
    const withParams = registeredRoutes(owner).filter((r) => r.path.includes(':'));
    // A guard on the guard: if the walk stops seeing routes, this suite would
    // pass by testing nothing at all.
    expect(withParams.length).toBeGreaterThanOrEqual(11);
  });

  it('is a 400 on every route that has one, never a 5xx', async () => {
    const routes = registeredRoutes(owner).filter((r) => r.path.includes(':'));
    const results: [string, number][] = [];

    for (const { method, path } of routes) {
      const probe = path.replace(/:[A-Za-z0-9_]+/g, encodeURIComponent(NUL));
      const key = `${method} ${path}`;
      const res = await send(owner, method, probe, BODIES[key] ?? {});
      results.push([key, res.status]);
    }

    expect(results.filter(([, status]) => status !== 400)).toEqual([]);
  });
});

/** Every string leaf of `value`, as a body with a NUL appended to just that one. */
function nulVariants(value: unknown, label = ''): [string, unknown][] {
  if (typeof value === 'string') return [[label, `${value}${NUL}`]];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) =>
      nulVariants(item, `${label}[${i}]`).map(
        ([l, v]) => [l, value.map((o, j) => (j === i ? v : o))] as [string, unknown],
      ),
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      nulVariants(item, label ? `${label}.${key}` : key).map(
        ([l, v]) => [l, { ...value, [key]: v }] as [string, unknown],
      ),
    );
  }
  return [];
}

describe('a NUL byte in a string body field', () => {
  it('is a 400 on every route that takes one, never a 5xx', async () => {
    const routes = registeredRoutes(owner).filter((r) => BODY_METHODS.has(r.method));
    const failures: [string, number][] = [];
    let probes = 0;

    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      const body = BODIES[key];
      if (!body) continue;
      // A concrete id, so a NUL in the BODY is what the route refuses rather
      // than a 404 on a path that never existed.
      const created = await json<{ post: { id: string } }>(
        await owner.post('/api/posts', { title: 'Probe' }),
      );
      const probePath = path.replace(/:[A-Za-z0-9_]+/g, created.post.id);

      for (const [field, variant] of nulVariants(body)) {
        probes += 1;
        const res = await send(owner, method, probePath, variant as Record<string, unknown>);
        if (res.status !== 400) failures.push([`${key} ${field}`, res.status]);
      }
    }

    expect(probes).toBeGreaterThanOrEqual(14);
    expect(failures).toEqual([]);
  });

  it('is a 400 with no session at all — the unauthenticated one', async () => {
    /*
     * The sharpest of the fourteen: `POST /api/auth/login` parsed and bound the
     * email before anything authenticated the caller, so any stranger could
     * make the process 500 on demand.
     */
    const anon = httpClient(ctx.db);
    const res = await anon.post('/api/auth/login', {
      email: `a${NUL}b@example.com`,
      password: 'whatever123',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request' });
  });

  it('the control: a query parameter was already 400 and still is', async () => {
    const res = await owner.get('/api/posts?search=%00');
    expect(res.status).toBe(400);
  });
});
