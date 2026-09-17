/**
 * The app spine: the §8 error contract, the `Origin` allow-list, the request
 * id, and the Postgres-backed rate limiter.
 *
 * TWO LEVELS ON PURPOSE. `toResponse` is a pure function of `(error,
 * requestId)`, so the whole of spec §8 can be pinned here — including the rows
 * whose routes arrive in later tasks — and the middleware is driven through a
 * real `createApp()` with real headers, because the seam between "the handler
 * threw" and "the caller saw" is the thing being tested.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, type RawCtx } from '../test/harness';
import { createApp } from '../index';
import { toResponse, zodDetail } from './errors';
import {
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
} from './errors';
import { configuredOrigins } from './origin';
import { storefrontOrigin } from '../shop/storefront-url';
import { clientIp } from './ratelimit';
import { SESSION_COOKIE } from './session';
import { createSession } from '../repo/users';
import {
  BadRequestError,
  InvalidDocumentError,
  NotFoundError,
  PreconditionFailedError,
  StaleWriteError,
} from '../repo/errors';
import { DuplicateEmailError, UserInputError } from '../repo/users';
import { ATTEMPT_RETENTION_MS, forget, hit } from '../repo/ratelimit';
import { DbError } from '../db/client';
import { RefundFailedError } from '../shop/payments/refund-failure';
import type { Post } from '../../shared/types';

let ctx: RawCtx;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

afterEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  vi.restoreAllMocks();
});

const RID = 'req-fixed-for-assertions';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const stubPost = { id: 'p_1', revision: 17 } as unknown as Post;

// --------------------------------------------------------------- spec §8

describe('the spec §8 error table', () => {
  const rows: [string, unknown, number, string][] = [
    ['not authenticated', new UnauthenticatedError(), 401, 'unauthenticated'],
    ['authenticated, not permitted', new ForbiddenError(), 403, 'forbidden'],
    ['post absent or destroyed', new NotFoundError('p_1'), 404, 'gone'],
    ['malformed request', new BadRequestError('limit'), 400, 'bad_request'],
    [
      'document fails validation',
      new InvalidDocumentError({ path: 'content[2]', reason: 'bad_protocol' }),
      422,
      'invalid_document',
    ],
    ['CAS lost', new StaleWriteError(14, 17, stubPost), 409, 'stale_write'],
    [
      'lifecycle op refused, no race involved',
      new PreconditionFailedError('publish', stubPost),
      409,
      'precondition_failed',
    ],
    ['rate limited', new RateLimitedError(42), 429, 'rate_limited'],
    [
      'a refund the gateway did not carry out',
      new RefundFailedError({ provider: 'flutterwave', outcome: 'refused', code: 'invalid_request' }),
      422,
      'refund_failed',
    ],
    ['unhandled', new TypeError('undefined is not a function'), 500, 'internal'],
  ];

  for (const [condition, err, status, error] of rows) {
    it(`maps "${condition}" to ${status} ${error}`, async () => {
      // The unhandled row logs; silence it so the suite output stays readable.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = toResponse(err, RID);
      expect(res.status).toBe(status);
      expect((await bodyOf(res)).error).toBe(error);
    });
  }

  it('carries expected, actual and the server post on a stale write', async () => {
    const body = await bodyOf(toResponse(new StaleWriteError(14, 17, stubPost), RID));
    // Spec §4.3 — "Load theirs" must render with no second round trip.
    expect(body).toMatchObject({ error: 'stale_write', expected: 14, actual: 17 });
    expect((body.post as Post).id).toBe('p_1');
  });

  it('carries the operation and the refusing state on a precondition failure', async () => {
    const body = await bodyOf(
      toResponse(new PreconditionFailedError('publish', stubPost), RID),
    );
    expect(body).toMatchObject({ error: 'precondition_failed', operation: 'publish' });
    expect((body.post as Post).id).toBe('p_1');
    // The defect this error exists for: reported as a stale write it arrived
    // with expected === actual, which no conflict banner can render.
    expect(body.expected).toBeUndefined();
  });

  it('names the offending path on an invalid document', async () => {
    const body = await bodyOf(
      toResponse(
        new InvalidDocumentError({ path: 'content[2].content[0]', reason: 'too_deep' }),
        RID,
      ),
    );
    expect(body.path).toBe('content[2].content[0]');
    expect(body.reason).toBe('too_deep');
  });

  it('names the gateway and what is known on a failed refund, as a 4xx that is never retried', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = toResponse(
      new RefundFailedError({ provider: 'flutterwave', outcome: 'unconfirmed', code: 'provider_unavailable' }),
      RID,
    );
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({
      error: 'refund_failed',
      provider: 'flutterwave',
      outcome: 'unconfirmed',
      code: 'provider_unavailable',
      requestId: RID,
    });
    // A mapped row is an answer, not a crash: the 500 log stays for crashes.
    expect(log).not.toHaveBeenCalled();
  });

  it('sends Retry-After beside the 429 body', async () => {
    const res = toResponse(new RateLimitedError(42), RID);
    expect(res.headers.get('retry-after')).toBe('42');
    expect((await bodyOf(res)).retryAfter).toBe(42);
  });

  it('answers the repo user errors 400, naming the field and never the value', async () => {
    const cases: [unknown, string][] = [
      /* `InviteError` had a row here until Clerk became the only auth: nothing
         throws it now, so the class and its mapping went together. */
      [new UserInputError('displayName', 'display name must not be empty'), 'displayName'],
      [new DuplicateEmailError(), 'email'],
    ];
    for (const [err, detail] of cases) {
      const res = toResponse(err, RID);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toMatchObject({ error: 'bad_request', detail });
    }
  });

  it('a 500 never leaks a stack trace to the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('secret internal detail');
    const res = toResponse(boom, RID);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('secret internal detail');
    expect(text).not.toContain('at ');
    expect(JSON.parse(text)).toEqual({ error: 'internal', requestId: RID });
  });

  it('a driver error is a 500 that describes nothing about the statement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = toResponse(
      new DbError({ code: '23505', constraint: 'users_email_unique', table: 'users' }),
      RID,
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    // Not even the SQLSTATE: a DbError is already scrubbed of values, but the
    // relation and constraint names are schema intelligence a caller has no
    // business receiving.
    expect(text).not.toContain('23505');
    expect(text).not.toContain('users_email_unique');
  });

  it('a logged Postgres error has detail and parameters stripped', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    /*
     * The shape `guardDb` exists to prevent: a DrizzleQueryError whose own
     * message interpolates every bound parameter, and whose `cause` is the pg
     * error carrying `detail`. Even handed one unscrubbed, the log line is
     * built from named fields and never from the error object, so a `params` or
     * a `query` property cannot ride along.
     */
    const driver = Object.assign(new Error('Failed query: insert into "users"'), {
      query: 'insert into "users" (email, password_hash) values ($1, $2)',
      params: ['alice@example.com', 'scrypt$32768$8$1$c2FsdA==$aGFzaA=='],
      cause: { code: '23505', detail: 'Key (email)=(alice@example.com) already exists.' },
    });

    toResponse(driver, RID);

    expect(logged).toHaveLength(1);
    const line = logged[0];
    expect(line).toContain(RID);
    expect(line).not.toContain('alice@example.com');
    expect(line).not.toContain('scrypt$');
    expect(line).not.toContain('already exists');
    expect(line).not.toContain('password_hash');
  });
});

// ---------------------------------------------------------- the live app

describe('the assembled app', () => {
  const ORIGIN = 'https://myapp.vercel.app';
  const app = () => createApp({ db: ctx.db, origins: [ORIGIN] });

  it('every response carries a requestId', async () => {
    const ok = await app().request('/api/health');
    expect(ok.status).toBe(200);
    const id = ok.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await app().request('/api/nothing-here');
    expect(missing.status).toBe(404);
    const body = await bodyOf(missing);
    expect(body.error).toBe('gone');
    expect(typeof body.requestId).toBe('string');
    expect(missing.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('mints a fresh requestId per request and never echoes the caller’s', async () => {
    const a = await app().request('/api/health');
    const b = await app().request('/api/health', {
      headers: { 'x-request-id': 'attacker-supplied' },
    });
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));
    expect(b.headers.get('x-request-id')).not.toBe('attacker-supplied');
  });

  it('a mutation with a foreign Origin is rejected 403', async () => {
    const res = await app().request('/api/posts', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe('forbidden');
  });

  it('a mutation with no Origin header is rejected 403', async () => {
    // Absence is not permission: a `SameSite=Lax` cookie rides along on a
    // top-level form POST, which is exactly the request that carries no Origin
    // in some clients.
    const res = await app().request('/api/posts', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toBe('forbidden');
  });

  it('GET with a foreign Origin is allowed', async () => {
    const res = await app().request('/api/health', {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(res.status).toBe(200);
  });

  it('an Origin that merely ends with an allowed origin is rejected', async () => {
    // 'https://evil-myapp.vercel.app' must not pass a check for
    // 'https://myapp.vercel.app'. Anyone can deploy to that domain.
    for (const forged of [
      'https://evil-myapp.vercel.app',
      'https://myapp.vercel.app.attacker.example',
      'http://myapp.vercel.app',
      'https://myapp.vercel.app/',
      'https://MYAPP.vercel.app',
    ]) {
      const res = await app().request('/api/posts', {
        method: 'POST',
        headers: { Origin: forged },
      });
      expect(res.status, forged).toBe(403);
    }
  });

  it('an allowed Origin passes the guard and reaches routing', async () => {
    // 404, not 403: the guard let it through and there is simply no such route
    // yet. Proves the refusals above are the guard and not a missing handler.
    const res = await app().request('/api/nothing-here', {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
  });

  it('with no injected list, the allow-list is APP_ORIGINS plus the storefront', async () => {
    /*
     * vitest.config.ts sets APP_ORIGINS=http://localhost:5173, and the
     * storefront's own origin is appended unconditionally — see
     * `configuredOrigins`. THAT SECOND ENTRY IS THE POINT: leaving the site
     * this API serves out of `APP_ORIGINS` is never a decision, it is an
     * omission, and it fails as a silent CORS refusal that logs a success on
     * this side. Pinned as an exact list rather than a `toContain`, so adding a
     * third implicit origin has to be a deliberate edit here.
     */
    expect(configuredOrigins()).toEqual(['http://localhost:5173', storefrontOrigin()]);
    const real = createApp({ db: ctx.db });
    const allowed = await real.request('/api/nothing-here', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(404);
    const refused = await real.request('/api/nothing-here', {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(refused.status).toBe(403);
  });

  it('a request that needs no database never builds one', async () => {
    /*
     * MEASURED AGAINST A BOOTED DEV SERVER, and it is why the handle is lazy.
     * With the database resolved eagerly by a middleware, `getDb()` runs for
     * every `/api/*` request — so on a deployment whose `DATABASE_URL` is
     * wrong, three different answers all became 500: an unrouted path instead
     * of 404, an anonymous request instead of 401, and a forged cross-origin
     * POST instead of 403. The last one is the serious one: a CSRF refusal
     * must not depend on a dependency being available.
     */
    let resolved = 0;
    const noDb = createApp({
      db: () => {
        resolved += 1;
        throw new Error('the database must not be resolved for this request');
      },
      origins: [ORIGIN],
    });

    const health = await noDb.request('/api/health');
    expect(health.status).toBe(200);
    expect(await bodyOf(health)).toEqual({ ok: true });

    expect((await noDb.request('/api/nothing-here')).status).toBe(404);
    expect((await noDb.request('/api/auth/me')).status).toBe(401);
    expect(
      (await noDb.request('/api/posts', { method: 'POST' })).status,
    ).toBe(403);
    expect(
      (
        await noDb.request('/api/posts', {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);

    expect(resolved).toBe(0);
  });

  it('resolves the handle at most once per request', async () => {
    let resolved = 0;
    const counting = createApp({
      db: () => {
        resolved += 1;
        return ctx.db;
      },
      origins: [ORIGIN],
    });
    /*
     * A SESSION RESOLVE plus the `last_seen_at` write it always performs:
     * two statements on one request, so a client opened per statement shows
     * up as `resolved === 2`.
     *
     * This used to drive `POST /api/auth/login` — two rate-limit buckets and
     * a user lookup — which is gone with the password routes (Clerk is the
     * only door now). What replaces it has to be a route that touches the
     * database MORE THAN ONCE, or the assertion passes whether or not the
     * handle is memoised; that is why it is not simply the nearest surviving
     * 401.
     */
    const seeded = await ctx.db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at)
      VALUES ('memo@test.local', 'x', 'Memo', 'owner', ${Date.now()})
      RETURNING id`);
    const { token } = await createSession(ctx.db, String(seeded.rows[0].id), 'vitest');
    resolved = 0;

    const res = await counting.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(200);
    expect(resolved).toBe(1);
  });

  it('an error thrown inside a route becomes the §8 response, not a raw 500', async () => {
    const thrower = createApp({ db: ctx.db, origins: [ORIGIN] });
    thrower.get('/api/boom', () => {
      throw new BadRequestError('deliberate');
    });
    const res = await thrower.request('/api/boom');
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({ error: 'bad_request', detail: 'deliberate' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
});

// ------------------------------------------------------------ rate limiter

describe('the Postgres rate limiter', () => {
  const WINDOW = 60_000;

  it('counts attempts and refuses past the limit, with a retryAfter', async () => {
    const key = 'login:1.2.3.4|a@b.test';
    const verdicts = [];
    for (let i = 0; i < 6; i += 1) verdicts.push(await hit(ctx.db, key, 5, WINDOW));
    expect(verdicts.slice(0, 5).every((v) => v.ok)).toBe(true);
    expect(verdicts[5].ok).toBe(false);
    expect(verdicts[5].retryAfter).toBeGreaterThan(0);
    expect(verdicts[5].retryAfter).toBeLessThanOrEqual(WINDOW / 1000);
  });

  it('resets when the window rolls over', async () => {
    const key = 'login:roll';
    for (let i = 0; i < 6; i += 1) await hit(ctx.db, key, 5, WINDOW);
    expect((await hit(ctx.db, key, 5, WINDOW)).ok).toBe(false);

    // Drag the stored window back past the boundary rather than sleeping a
    // minute — the reset is a comparison against `window_start`, so moving it
    // is the same event the clock would produce.
    await ctx.db.execute(sql`UPDATE auth_attempts SET window_start = 0 WHERE key = ${key}`);
    expect((await hit(ctx.db, key, 5, WINDOW)).ok).toBe(true);
  });

  it('forget() clears one key and leaves the others counting', async () => {
    await hit(ctx.db, 'a', 5, WINDOW);
    await hit(ctx.db, 'a', 5, WINDOW);
    await hit(ctx.db, 'b', 5, WINDOW);
    await forget(ctx.db, 'a');
    const res = await ctx.db.execute(sql`SELECT key, count FROM auth_attempts ORDER BY key`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ key: 'b' });
  });

  it('sweeps windows older than the retention floor, never the live one', async () => {
    await hit(ctx.db, 'stale', 5, WINDOW);
    await ctx.db.execute(
      sql`UPDATE auth_attempts SET window_start = ${Date.now() - ATTEMPT_RETENTION_MS - 1}
           WHERE key = 'stale'`,
    );
    // Keys are partly attacker-chosen ('login:<ip>|<email>'), so without this
    // the limiter is a storage-exhaustion primitive against its own database.
    await hit(ctx.db, 'live', 5, WINDOW);
    const res = await ctx.db.execute(sql`SELECT key FROM auth_attempts`);
    expect(res.rows.map((r) => r.key)).toEqual(['live']);
  });

  it('the rate limiter bounds the deployment, not one instance', async () => {
    /*
     * Two independently-constructed app instances sharing one db must share the
     * count. Serverless instances do not share memory, so an in-process counter
     * bounds one warm instance and nothing else.
     */
    const a = createApp({ db: ctx.db });
    const b = createApp({ db: ctx.db });
    expect(a).not.toBe(b);

    const key = 'login:shared';
    for (let i = 0; i < 3; i += 1) await hit(ctx.db, key, 5, WINDOW);

    // A genuinely fresh copy of the module — new module scope, no shared
    // closure — still sees the count, because the count is a row.
    vi.resetModules();
    const fresh = (await import('../repo/ratelimit')) as typeof import('../repo/ratelimit');
    expect(fresh.hit).not.toBe(hit);
    const verdicts = [
      await fresh.hit(ctx.db, key, 5, WINDOW),
      await fresh.hit(ctx.db, key, 5, WINDOW),
      await fresh.hit(ctx.db, key, 5, WINDOW),
    ];
    expect(verdicts[2].ok).toBe(false);
  });
});

// -------------------------------------------------------------- small parts

describe('the parts the routes lean on', () => {
  it('clientIp prefers x-real-ip and takes the leftmost forwarded entry', async () => {
    const seen: string[] = [];
    const probe = createApp({ db: ctx.db });
    probe.get('/api/ip', (c) => {
      seen.push(clientIp(c));
      return c.json({ ok: true });
    });

    await probe.request('/api/ip', { headers: { 'x-real-ip': '9.9.9.9' } });
    await probe.request('/api/ip', {
      // A client-supplied value arrives with the real address appended after
      // it, so the proxy's single-valued header wins.
      headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': 'spoofed, 9.9.9.9' },
    });
    await probe.request('/api/ip', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } });
    await probe.request('/api/ip');

    expect(seen).toEqual(['9.9.9.9', '9.9.9.9', '1.1.1.1', 'unknown']);
  });

  it('zodDetail names the path and the unexpected key, never a value', async () => {
    const { z } = await import('zod');
    const schema = z.object({ email: z.string(), password: z.string() }).strict();

    const unknownKey = schema.safeParse({ email: 'a@b.test', password: 'x', role: 'owner' });
    expect(unknownKey.success).toBe(false);
    if (!unknownKey.success) expect(zodDetail(unknownKey.error)).toBe('role');

    const wrongType = schema.safeParse({ email: 'a@b.test', password: 12345 });
    expect(wrongType.success).toBe(false);
    if (!wrongType.success) {
      const detail = zodDetail(wrongType.error);
      expect(detail).toBe('password');
      expect(detail).not.toContain('12345');
    }
  });
});
