/**
 * The auth surface, driven end to end through the real app (spec §5.1, §6).
 *
 * Every case here goes through `app.request()` with real cookies, headers and
 * bodies. The seam this task adds is the one between `server/repo/users.ts` —
 * already covered by its own suite — and HTTP, so testing anything short of a
 * request would test the half that is already proven.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { TEST_ORIGIN, httpClient, json } from '../test/http';
import { SESSION_COOKIE } from '../middleware/session';
import { DUMMY_PASSWORD_HASH, INVITE_PATH } from './auth';
import { LOGIN_IP_LIMIT, LOGIN_LIMIT } from '../repo/ratelimit';
import { hashPassword } from '../repo/password';
import { MIN_PASSWORD_LENGTH, createInvite } from '../repo/users';
import type { AuthUser } from '../../shared/types';
import type { AppDeps } from '../index';
import type { Mailer } from '../mail/port';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  // Every suite shares one 'unknown' IP bucket through `app.request()`, so a
  // test that spends attempts would otherwise 429 the next one.
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM invites`);
});

afterEach(async () => {
  // Users created by accept-invite tests, so a re-run does not hit
  // `users_email_unique`.
  await ctx.db.execute(
    sql`DELETE FROM users WHERE email NOT IN ('owner@test.local', 'writer@test.local')`,
  );
});

/**
 * `deps` is threaded through because `POST /api/invites` now mails the link,
 * and the transport is injected exactly as the reset flow's is — a route that
 * delivers a credential must not be testable by having it hand the credential
 * back (`server/mail/port.ts` has the long version). Every case that does not
 * care about mail leaves it defaulted, which lands on `resendMailer()` with no
 * key configured and therefore sends nothing.
 */
const client = (ip = '203.0.113.1', deps: Partial<AppDeps> = {}) => {
  const base = httpClient(ctx.db, deps);
  const withIp = (init: RequestInit = {}): RequestInit => {
    const headers = new Headers(init.headers);
    headers.set('x-real-ip', ip);
    return { ...init, headers };
  };
  return {
    ...base,
    get: (p: string, i: RequestInit = {}) => base.get(p, withIp(i)),
    post: (p: string, b?: unknown, i: RequestInit = {}) => base.post(p, b, withIp(i)),
    del: (p: string, i: RequestInit = {}) => base.del(p, withIp(i)),
    request: (p: string, i: RequestInit = {}) => base.request(p, withIp(i)),
  };
};

/** Log in as a seeded user and return the still-authenticated client. */
async function loggedIn(user: AuthUser, ip = '203.0.113.9', deps: Partial<AppDeps> = {}) {
  const c = client(ip, deps);
  const res = await c.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return c;
}

// ------------------------------------------------------------------- login

describe('POST /api/auth/login', () => {
  it('logs a seeded user in and returns the user, never a hash', async () => {
    const c = client();
    const res = await c.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = await json<{ user: AuthUser }>(res);
    expect(body.user).toEqual(ctx.users.writer);
    expect(JSON.stringify(body)).not.toContain('scrypt$');
  });

  it('sets an HttpOnly Secure SameSite=Lax __Host- cookie with no Domain', async () => {
    const c = client();
    const res = await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    const setCookie = res.headers.getSetCookie().find((h) => h.startsWith(SESSION_COOKIE));
    expect(setCookie).toBeTruthy();
    const header = setCookie!;
    expect(SESSION_COOKIE).toBe('__Host-studio_session');
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//i);
    // The `__Host-` prefix is enforced by the browser only when there is NO
    // Domain attribute — with one, a subdomain can set the session cookie.
    expect(header).not.toMatch(/Domain=/i);
  });

  it('stores the session keyed by an HMAC, never the raw token', async () => {
    const c = client();
    await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });
    const token = c.cookies().get(SESSION_COOKIE)!;
    expect(token).toBeTruthy();
    const rows = await ctx.db.execute(sql`SELECT id FROM sessions`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).not.toBe(token);
    expect(String(rows.rows[0].id)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('login with an unknown email and with a wrong password are indistinguishable', async () => {
    const unknown = await client().post('/api/auth/login', {
      email: 'nobody@test.local',
      password: 'whatever-it-is',
    });
    const wrong = await client('203.0.113.2').post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: 'not-the-seed-password',
    });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const a = await json(unknown);
    const b = await json(wrong);
    expect(a.error).toBe('unauthenticated');
    // Identical but for the requestId, which is per-request by construction.
    expect({ ...a, requestId: null }).toEqual({ ...b, requestId: null });
    expect(unknown.headers.getSetCookie()).toHaveLength(0);
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
  });

  it('login always performs a hash, so timing does not distinguish the two', async () => {
    /*
     * TWO ASSERTIONS, BECAUSE ONE OF THEM CANNOT BE MADE HONESTLY.
     *
     * The exact one: the dummy hash carries the SAME scrypt parameters a real
     * one does, so the unknown-email branch does the same work by construction
     * rather than by measurement.
     *
     * The loose one: both paths take at least 25 ms. A scrypt at N=2^15 is
     * 100–250 ms, so this can only fail if no derivation ran at all. A tighter
     * bound — "within 20% of each other" — would be a flake on any shared
     * machine and would be asserting the scheduler, not the code.
     */
    const real = await hashPassword('a-real-production-cost-hash');
    expect(DUMMY_PASSWORD_HASH.split('$').slice(0, 4)).toEqual(real.split('$').slice(0, 4));

    // A user whose stored hash is at production cost, unlike the cheap seeds.
    const email = `timing.${Date.now()}@test.local`;
    await ctx.db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at)
      VALUES (${email}, ${real}, 'Timing', 'writer', ${Date.now()})`);

    const timed = async (address: string): Promise<number> => {
      const started = performance.now();
      const res = await client('203.0.113.3').post('/api/auth/login', {
        email: address,
        password: 'definitely-not-the-password',
      });
      expect(res.status).toBe(401);
      return performance.now() - started;
    };

    expect(await timed(email)).toBeGreaterThan(25);
    expect(await timed(`nobody.${email}`)).toBeGreaterThan(25);
  });

  it('a disabled user cannot log in, and gets the same refusal', async () => {
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${ctx.users.writer.id}`,
    );
    const res = await client('203.0.113.4').post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = NULL WHERE id = ${ctx.users.writer.id}`,
    );

    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('unauthenticated');
    // No cookie: a login that "succeeds" and then 401s on every request reads
    // as a broken app rather than as a revocation.
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('rejects an unknown body key and a missing field with 400', async () => {
    const extra = await client().post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
      role: 'owner',
    });
    expect(extra.status).toBe(400);
    expect(await json(extra)).toMatchObject({ error: 'bad_request', detail: 'role' });

    const missing = await client('203.0.113.5').post('/api/auth/login', {
      email: ctx.users.owner.email,
    });
    expect(missing.status).toBe(400);
    expect((await json(missing)).detail).toBe('password');
  });

  it('a 400 never echoes the submitted password', async () => {
    const res = await client().post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: 12345,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('12345');
  });

  it('a body that is not JSON is a 400, not a 500', async () => {
    const res = await client().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('body');
  });

  it('is refused without an Origin, like every other mutation', async () => {
    const res = await httpClient(ctx.db).request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ email: ctx.users.owner.email, password: SEED_PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toBe('forbidden');
  });
});

// ------------------------------------------------------------ rate limiting

describe('login rate limiting', () => {
  it('six failed logins from one ip+email are rate limited with retryAfter', async () => {
    const c = client('198.51.100.7');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await c.post('/api/auth/login', {
        email: ctx.users.writer.email,
        password: 'wrong',
      });
      statuses.push(res.status);
      if (i === 5) {
        const body = await json(res);
        expect(body.error).toBe('rate_limited');
        expect(body.retryAfter).toBeGreaterThan(0);
        expect(res.headers.get('retry-after')).toBe(String(body.retryAfter));
      }
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(LOGIN_LIMIT).toBe(5);
  });

  it('the ip bucket is consulted BEFORE the body is parsed', async () => {
    /*
     * The limiter cannot bound work it runs after itself. With `readJson` first,
     * a caller that had already been refused twenty times still made the process
     * parse a body up to the platform limit on every further request — the one
     * thing an unauthenticated caller could make the server do without limit.
     *
     * Observable as the ORDER of two refusals: once the bucket is spent, a body
     * that is not even JSON is answered 429 rather than 400, which is only
     * possible if the limiter ran before the parse.
     */
    const ip = '198.51.100.21';
    const c = client(ip);
    for (let i = 0; i < LOGIN_IP_LIMIT; i += 1) {
      await c.post('/api/auth/login', { email: `pre-${i}@test.local`, password: 'wrong' });
    }

    const res = await c.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json at all',
    });
    expect(res.status).toBe(429);
    expect((await json(res)).error).toBe('rate_limited');
  });

  it('both buckets fire: per email+ip and per ip alone', async () => {
    /*
     * The defect the second bucket exists for: five attempts against each of a
     * dozen addresses never trips a per-email limiter, so one host can walk the
     * whole user list of an invite-only instance.
     */
    const ip = '198.51.100.8';
    const c = client(ip);
    let refusals = 0;
    // Four attempts each against six DISTINCT addresses: no email+ip bucket
    // ever reaches 5, so anything refused here is the per-ip bucket.
    for (let n = 0; n < 6; n += 1) {
      for (let i = 0; i < 4; i += 1) {
        const res = await c.post('/api/auth/login', {
          email: `spray-${n}@test.local`,
          password: 'wrong',
        });
        if (res.status === 429) refusals += 1;
      }
    }
    expect(LOGIN_IP_LIMIT).toBe(20);
    expect(refusals).toBe(24 - LOGIN_IP_LIMIT);

    // The narrow bucket is real too: a different IP, same address, five tries.
    const other = client('198.51.100.9');
    const narrow: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await other.post('/api/auth/login', {
        email: 'spray-0@test.local',
        password: 'wrong',
      });
      narrow.push(res.status);
    }
    expect(narrow.filter((s) => s === 429)).toHaveLength(1);

    const keys = await ctx.db.execute(sql`SELECT key FROM auth_attempts ORDER BY key`);
    const names = keys.rows.map((r) => String(r.key));
    expect(names).toContain(`login:${ip}`);
    expect(names).toContain(`login:${ip}|spray-0@test.local`);
  });

  it('the counter is a row, so it is not reset by a second app instance', async () => {
    const ip = '198.51.100.10';
    for (let i = 0; i < 5; i += 1) {
      await client(ip).post('/api/auth/login', {
        email: ctx.users.writer.email,
        password: 'wrong',
      });
    }
    // A brand-new app object, i.e. a cold serverless instance.
    const cold = client(ip);
    const res = await cold.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: 'wrong',
    });
    expect(res.status).toBe(429);
  });

  it('a successful login clears the narrow bucket but not the per-ip one', async () => {
    const ip = '198.51.100.11';
    const c = client(ip);
    for (let i = 0; i < 3; i += 1) {
      await c.post('/api/auth/login', { email: ctx.users.owner.email, password: 'wrong' });
    }
    await c.post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: SEED_PASSWORD,
    });

    const rows = await ctx.db.execute(sql`SELECT key, count FROM auth_attempts ORDER BY key`);
    const byKey = new Map(rows.rows.map((r) => [String(r.key), Number(r.count)]));
    expect(byKey.has(`login:${ip}|${ctx.users.owner.email}`)).toBe(false);
    // Kept, deliberately: clearing it would hand anyone holding one valid
    // account a reset button for the spray limiter.
    expect(byKey.get(`login:${ip}`)).toBe(4);
  });
});

// ------------------------------------------------------------ me and logout

describe('GET /api/auth/me and POST /api/auth/logout', () => {
  it('me is 401 without a cookie and returns the user with one', async () => {
    const anon = await client().get('/api/auth/me');
    expect(anon.status).toBe(401);
    expect((await json(anon)).error).toBe('unauthenticated');

    const c = await loggedIn(ctx.users.writer);
    const res = await c.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect((await json<{ user: AuthUser }>(res)).user).toEqual(ctx.users.writer);
  });

  it('me is 401 for a garbage cookie rather than a 500', async () => {
    const res = await client().get('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=not-a-real-token` },
    });
    expect(res.status).toBe(401);
  });

  it('logout deletes the session row and clears the cookie', async () => {
    const c = await loggedIn(ctx.users.owner);
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
    expect(Number(before.rows[0].n)).toBe(1);

    const res = await c.post('/api/auth/logout');
    expect(res.status).toBe(200);
    const after = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
    expect(Number(after.rows[0].n)).toBe(0);
    // The jar drops it because the Set-Cookie carries Max-Age=0.
    expect(c.cookies().has(SESSION_COOKIE)).toBe(false);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('logout succeeds without a session, so an expired cookie can still be cleared', async () => {
    const res = await client().post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
  });

  it('an expired session is refused and swept', async () => {
    const c = await loggedIn(ctx.users.writer);
    await ctx.db.execute(sql`UPDATE sessions SET expires_at = ${Date.now() - 1}`);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// ----------------------------------------------------------- accept invite

describe('POST /api/auth/accept-invite', () => {
  const invite = async (email: string, role: 'owner' | 'writer' = 'writer') =>
    createInvite(ctx.db, { email, role, invitedBy: ctx.users.owner.id });

  it('creates the user, spends the invite and logs in', async () => {
    const email = 'invitee@test.local';
    const { id, token } = await invite(email);
    const c = client('192.0.2.10');

    const res = await c.post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'Invitee',
    });
    expect(res.status).toBe(201);
    const body = await json<{ user: AuthUser }>(res);
    expect(body.user).toMatchObject({ email, displayName: 'Invitee', role: 'writer' });

    // Logged in: the cookie the response set is one the app accepts.
    expect(c.cookies().has(SESSION_COOKIE)).toBe(true);
    const me = await c.get('/api/auth/me');
    expect((await json<{ user: AuthUser }>(me)).user.email).toBe(email);

    const spent = await ctx.db.execute(sql`SELECT accepted_at FROM invites WHERE id = ${id}`);
    expect(spent.rows[0].accepted_at).not.toBeNull();
  });

  it('the invite, not the body, decides the role', async () => {
    const { token } = await invite('writer-only@test.local', 'writer');
    const res = await client('192.0.2.11').post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'Sneaky',
      role: 'owner',
    });
    // `.strict()` refuses the key outright, so escalation is not even attempted.
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('role');
  });

  it('a spent or expired invite cannot be used', async () => {
    const { token } = await invite('once@test.local');
    const first = await client('192.0.2.12').post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'First',
    });
    expect(first.status).toBe(201);

    const second = await client('192.0.2.13').post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'Second',
    });
    expect(second.status).toBe(400);
    expect(await json(second)).toMatchObject({ error: 'bad_request', detail: 'invite' });

    const stale = await invite('stale@test.local');
    await ctx.db.execute(
      sql`UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${stale.id}`,
    );
    const expired = await client('192.0.2.14').post('/api/auth/accept-invite', {
      token: stale.token,
      password: 'a-long-enough-password',
      displayName: 'Late',
    });
    expect(expired.status).toBe(400);
    expect((await json(expired)).detail).toBe('invite');
  });

  it('an unknown token is a 400 and creates nothing', async () => {
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users`);
    const res = await client('192.0.2.15').post('/api/auth/accept-invite', {
      token: 'not-a-token-anyone-minted',
      password: 'a-long-enough-password',
      displayName: 'Nobody',
    });
    expect(res.status).toBe(400);
    const after = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users`);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  it('a short password is a 400 naming the field, and the invite survives', async () => {
    const { id, token } = await invite('shortpw@test.local');
    const res = await client('192.0.2.16').post('/api/auth/accept-invite', {
      token,
      password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1),
      displayName: 'Short',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'password' });

    // Unspent: a rejected password must not burn the invite.
    const row = await ctx.db.execute(sql`SELECT accepted_at FROM invites WHERE id = ${id}`);
    expect(row.rows[0].accepted_at).toBeNull();
  });
});

// ----------------------------------------------------------------- invites

describe('the invite routes', () => {
  it('POST /api/invites is 403 for a writer and 201 for the owner', async () => {
    const writer = await loggedIn(ctx.users.writer, '192.0.2.20');
    const refused = await writer.post('/api/invites', { email: 'new@test.local' });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toBe('forbidden');

    const owner = await loggedIn(ctx.users.owner, '192.0.2.21');
    const res = await owner.post('/api/invites', { email: 'New@Test.Local' });
    expect(res.status).toBe(201);
    const body = await json<{ invite: Record<string, unknown> }>(res);
    expect(body.invite).toMatchObject({ email: 'new@test.local', role: 'writer' });
    // The URL is built from the configured origin, never from a Host header.
    expect(String(body.invite.url).startsWith(`${TEST_ORIGIN}${INVITE_PATH}?token=`)).toBe(
      true,
    );
  });

  it('puts the token where a hash router can actually read it', async () => {
    /*
     * The assertion above passes for ANY value of `INVITE_PATH`, which is how
     * this shipped broken: the client is served under `createHashRouter`
     * (`src/main.tsx`), so a token in `location.search` reaches no route at all
     * and every invite was dead on arrival.
     *
     * So this case does not compare against the constant. It parses the minted
     * URL the way react-router's `createHashLocation` does — `parsePath` over
     * `location.hash.substring(1)` — and asserts the token comes out the other
     * end. It fails against the old `/accept-invite`.
     */
    const owner = await loggedIn(ctx.users.owner, '192.0.2.31');
    const res = await owner.post('/api/invites', { email: 'hash-router@test.local' });
    expect(res.status).toBe(201);

    const url = new URL(String((await json<{ invite: { url: string } }>(res)).invite.url));
    // Nothing in the real query string: the router never looks there.
    expect(url.search).toBe('');
    const routed = new URL(url.hash.substring(1), 'http://router.invalid');
    expect(routed.pathname).toBe('/accept-invite');
    expect(routed.searchParams.get('token')).toBeTruthy();
  });

  it('every invite route is 401 without a session', async () => {
    const anon = client('192.0.2.22');
    expect((await anon.post('/api/invites', { email: 'x@test.local' })).status).toBe(401);
    expect((await anon.get('/api/invites')).status).toBe(401);
    expect(
      (await anon.del('/api/invites/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(401);
  });

  it('the minted token verifies, and only its HMAC is stored', async () => {
    const owner = await loggedIn(ctx.users.owner, '192.0.2.23');
    const res = await owner.post('/api/invites', { email: 'roundtrip@test.local' });
    const url = String((await json<{ invite: { url: string } }>(res)).invite.url);
    /*
     * Read out of the HASH, exactly as the client does. Reading
     * `new URL(url).searchParams` — which is what this line used to do — is the
     * F3 defect itself: under `createHashRouter` the query string of the outer
     * URL reaches no route, so a token that only lives there can never be
     * redeemed by anyone.
     */
    const token = new URL(new URL(url).hash.substring(1), 'http://router.invalid')
      .searchParams.get('token')!;

    const stored = await ctx.db.execute(sql`SELECT token_hash FROM invites`);
    expect(String(stored.rows[0].token_hash)).not.toBe(token);

    const accepted = await client('192.0.2.24').post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'Round Trip',
    });
    expect(accepted.status).toBe(201);
  });

  it('GET /api/invites lists outstanding invites and never a token hash', async () => {
    const owner = await loggedIn(ctx.users.owner, '192.0.2.25');
    await owner.post('/api/invites', { email: 'live@test.local' });
    const spent = await createInvite(ctx.db, {
      email: 'spent@test.local',
      role: 'writer',
      invitedBy: ctx.users.owner.id,
    });
    await ctx.db.execute(
      sql`UPDATE invites SET accepted_at = ${Date.now()} WHERE id = ${spent.id}`,
    );

    const res = await owner.get('/api/invites');
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { items: { email: string }[] };
    expect(body.items.map((i) => i.email)).toEqual(['live@test.local']);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain('tokenHash');

    const writer = await loggedIn(ctx.users.writer, '192.0.2.26');
    expect((await writer.get('/api/invites')).status).toBe(403);
  });

  it('DELETE /api/invites/:id revokes, is owner-only, and 404s twice', async () => {
    const owner = await loggedIn(ctx.users.owner, '192.0.2.27');
    const created = await owner.post('/api/invites', { email: 'revoke@test.local' });
    const id = String((await json<{ invite: { id: string } }>(created)).invite.id);

    const writer = await loggedIn(ctx.users.writer, '192.0.2.28');
    expect((await writer.del(`/api/invites/${id}`)).status).toBe(403);

    const first = await owner.del(`/api/invites/${id}`);
    expect(first.status).toBe(200);
    const second = await owner.del(`/api/invites/${id}`);
    expect(second.status).toBe(404);
    expect((await json(second)).error).toBe('gone');
  });

  it('a malformed invite id is a 400, not a 500 the client retries', async () => {
    // `invites.id` is a uuid column, so 'not-a-uuid' reaches the driver as
    // SQLSTATE 22P02 — a scrubbed DbError, a 500, and five retries with backoff
    // for a request that can never succeed.
    const owner = await loggedIn(ctx.users.owner, '192.0.2.29');
    const res = await owner.del('/api/invites/not-a-uuid');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'id' });
  });

  it('inviting an address that already has an account is refused before minting', async () => {
    const owner = await loggedIn(ctx.users.owner, '192.0.2.30');
    const res = await owner.post('/api/invites', { email: ctx.users.writer.email });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('email');
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM invites`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// ----------------------------------------------------- the invite email

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** A mailer that records instead of sending. No `assertConfigured` — it is. */
function fakeMailer(): { mailer: Mailer; sent: Sent[] } {
  const sent: Sent[] = [];
  return { sent, mailer: { async send(msg) { sent.push(msg); } } };
}

describe('POST /api/invites and the mail it sends', () => {
  it('mails the link and says so, and the mailed link is the one in the body', async () => {
    /*
     * THE MAILED URL AND THE RETURNED URL MUST BE THE SAME STRING. They are
     * built once and handed to two places, and the failure mode of building
     * them twice is silent: an invitee follows a link with a token that was
     * never stored, gets `detail: 'invite'`, and the owner — looking at a
     * perfectly good URL in their own screen — has no way to see why.
     */
    const { mailer, sent } = fakeMailer();
    const owner = await loggedIn(ctx.users.owner, '192.0.2.40', { mailer });

    const res = await owner.post('/api/invites', { email: 'Mailed@Test.Local' });
    expect(res.status).toBe(201);
    const body = await json<{ invite: { url: string }; emailed: boolean }>(res);
    expect(body.emailed).toBe(true);

    expect(sent).toHaveLength(1);
    // Lowercased, exactly as the row is stored: a link mailed to a
    // differently-cased address than the invite names is one bounce away from
    // being unexplainable.
    expect(sent[0].to).toBe('mailed@test.local');
    expect(sent[0].text).toContain(body.invite.url);
    expect(sent[0].html).toContain(body.invite.url);
    // The inviter is named, which is why the response resolves display names at
    // all — "somebody invited you" is a phishing email.
    expect(sent[0].text).toContain(ctx.users.owner.displayName);
  });

  it('with no mailer configured it still mints the link and says emailed:false', async () => {
    /*
     * An invite is the ONLY way a second person gets into an invite-only
     * instance. Making it depend on a working mail provider would mean a mail
     * outage — or a deployment that never configured one — locks the team out
     * of growing. So the URL stays in the response and `emailed` says which
     * happened.
     *
     * The default mailer is `resendMailer()`, and the suite environment sets no
     * `RESEND_API_KEY`, so this is the unconfigured deployment for real rather
     * than a fake standing in for one.
     */
    const owner = await loggedIn(ctx.users.owner, '192.0.2.41');
    const res = await owner.post('/api/invites', { email: 'nomail@test.local' });
    expect(res.status).toBe(201);
    const body = await json<{ invite: { url: string }; emailed: boolean }>(res);
    expect(body.emailed).toBe(false);
    expect(body.invite.url).toContain(`${TEST_ORIGIN}${INVITE_PATH}?token=`);

    // The row exists and the token in that URL redeems, so hand delivery works.
    const token = new URL(new URL(body.invite.url).hash.substring(1), 'http://router.invalid')
      .searchParams.get('token')!;
    const accepted = await client('192.0.2.42').post('/api/auth/accept-invite', {
      token,
      password: 'a-long-enough-password',
      displayName: 'Hand Delivered',
    });
    expect(accepted.status).toBe(201);
  });

  it('a failed send is swallowed for the caller and the invite survives', async () => {
    // Swallowed for the CALLER, never for the operator — the same shape
    // `POST /api/auth/forgot` uses. Not a 500: the row is already committed and
    // the URL is already in the response, so failing would tell the owner to
    // mint a SECOND live token for an address that already has one.
    const broken: Mailer = {
      async send() {
        throw new Error('resend refused the message: HTTP 422');
      },
    };
    const owner = await loggedIn(ctx.users.owner, '192.0.2.43', { mailer: broken });
    const res = await owner.post('/api/invites', { email: 'broken@test.local' });
    expect(res.status).toBe(201);
    expect((await json<{ emailed: boolean }>(res)).emailed).toBe(false);

    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM invites WHERE email = 'broken@test.local'`,
    );
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it('the response never carries the token outside the url', async () => {
    const { mailer } = fakeMailer();
    const owner = await loggedIn(ctx.users.owner, '192.0.2.44', { mailer });
    const res = await owner.post('/api/invites', { email: 'shape@test.local' });
    const body = await json<{ invite: Record<string, unknown> }>(res);
    expect(Object.keys(body.invite).sort()).toEqual([
      'email',
      'expiresAt',
      'id',
      'role',
      'url',
    ]);
  });
});

// ------------------------------------------------------- the invite history

describe('GET /api/invites?include=', () => {
  /** An accepted invite, an expired one and an open one, in that order. */
  async function threeInvites() {
    const accepted = await createInvite(ctx.db, {
      email: 'accepted@test.local',
      role: 'writer',
      invitedBy: ctx.users.owner.id,
    });
    await ctx.db.execute(
      sql`UPDATE invites SET accepted_at = ${Date.now()} WHERE id = ${accepted.id}`,
    );
    const expired = await createInvite(ctx.db, {
      email: 'expired@test.local',
      role: 'writer',
      invitedBy: ctx.users.writer.id,
    });
    await ctx.db.execute(
      sql`UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${expired.id}`,
    );
    await createInvite(ctx.db, {
      email: 'open@test.local',
      role: 'owner',
      invitedBy: ctx.users.owner.id,
    });
  }

  interface InviteItem {
    email: string;
    state: 'open' | 'accepted' | 'expired';
    invitedBy: string;
    invitedByName: string;
    acceptedAt: number | null;
  }

  const list = async (query: string): Promise<InviteItem[]> => {
    const owner = await loggedIn(ctx.users.owner, '192.0.2.50');
    const res = await owner.get(`/api/invites${query}`);
    expect(res.status).toBe(200);
    return (await json<{ items: InviteItem[] }>(res)).items;
  };

  it('defaults to open invites only', async () => {
    await threeInvites();
    expect((await list('')).map((i) => i.email)).toEqual(['open@test.local']);
  });

  it('include=accepted and include=expired each add exactly their bucket', async () => {
    await threeInvites();
    expect((await list('?include=accepted')).map((i) => i.email).sort()).toEqual([
      'accepted@test.local',
      'open@test.local',
    ]);
    expect((await list('?include=expired')).map((i) => i.email).sort()).toEqual([
      'expired@test.local',
      'open@test.local',
    ]);
    expect((await list('?include=accepted,expired')).map((i) => i.email).sort()).toEqual([
      'accepted@test.local',
      'expired@test.local',
      'open@test.local',
    ]);
  });

  it('labels each row, and accepted beats expired', async () => {
    /*
     * A spent invite whose seven days have since elapsed is history, not a
     * missed opportunity. Labelled "expired" it would tell an owner to re-send
     * an invite to somebody who already has an account — and
     * `POST /api/invites` would then refuse it with `detail: 'email'`, which
     * reads as a bug in the screen.
     */
    const stale = await createInvite(ctx.db, {
      email: 'accepted.then.expired@test.local',
      role: 'writer',
      invitedBy: ctx.users.owner.id,
    });
    await ctx.db.execute(sql`
      UPDATE invites SET accepted_at = ${Date.now() - 10}, expires_at = ${Date.now() - 1}
       WHERE id = ${stale.id}`);
    await threeInvites();

    const byEmail = new Map(
      (await list('?include=accepted,expired')).map((i) => [i.email, i]),
    );
    expect(byEmail.get('open@test.local')?.state).toBe('open');
    expect(byEmail.get('accepted@test.local')?.state).toBe('accepted');
    expect(byEmail.get('expired@test.local')?.state).toBe('expired');
    expect(byEmail.get('accepted.then.expired@test.local')?.state).toBe('accepted');

    expect(byEmail.get('accepted@test.local')?.acceptedAt).toBeGreaterThan(0);
    expect(byEmail.get('open@test.local')?.acceptedAt).toBeNull();
  });

  it('resolves invitedBy to a name and keeps the uuid beside it', async () => {
    // A bare uuid is unreadable, and the only route that could turn one into a
    // name is `GET /api/users` — owner-only, and a whole second request to
    // render one cell.
    await threeInvites();
    const items = await list('?include=expired');
    const open = items.find((i) => i.email === 'open@test.local')!;
    const expired = items.find((i) => i.email === 'expired@test.local')!;

    expect(open.invitedBy).toBe(ctx.users.owner.id);
    expect(open.invitedByName).toBe(ctx.users.owner.displayName);
    expect(expired.invitedByName).toBe(ctx.users.writer.displayName);
  });

  it('an unknown include member is a 400 naming the parameter', async () => {
    // Silently ignoring it would return the default list for a query that asked
    // for something else, which looks like a bug in the screen rather than in
    // the request — the rule `ListQueryParams` states for post filters.
    const owner = await loggedIn(ctx.users.owner, '192.0.2.51');
    const res = await owner.get('/api/invites?include=acepted');
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'include' });

    const unknownParam = await owner.get('/api/invites?includes=accepted');
    expect(unknownParam.status).toBe(400);
    expect((await json(unknownParam)).detail).toBe('includes');
  });

  it('is still owner-only', async () => {
    const writer = await loggedIn(ctx.users.writer, '192.0.2.52');
    expect((await writer.get('/api/invites?include=accepted,expired')).status).toBe(403);
  });
});
