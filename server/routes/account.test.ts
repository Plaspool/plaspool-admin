/**
 * The self-service account surface (HANDOFF §2 A1), driven end to end through
 * the real app: display name, the signed-in password change, and the sessions
 * list that `sessions.user_agent`/`last_seen_at` have been maintained for since
 * those columns were added.
 *
 * TWO CASES HERE ARE THE POINT OF THE WHOLE FILE and the rest is boundary work.
 *
 * The first is `the caller's cookie survives and a second one does not`. A
 * change-password that ends every session is `POST /api/auth/reset`, which
 * already exists; a change-password that ends none is cosmetic against the
 * borrowed-laptop attacker it is aimed at. Only the asymmetry is new, and only
 * a test holding two live cookies for one account can see it.
 *
 * The second is `a rename lands on an existing post`. `PATCH /api/auth/me` is
 * the first UPDATE of `users.display_name` that has ever existed, and whether
 * it needs a backfill turns entirely on whether `posts.author_name` is a column
 * or a join. It is a join — so this asserts on a post written BEFORE the rename
 * and read after it, which fails the moment anyone denormalises the name onto
 * `posts` without a backfill.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import { SESSION_COOKIE } from '../middleware/session';
import { CHANGE_PASSWORD_LIMIT } from './auth';
import { MIN_PASSWORD_LENGTH } from '../repo/users';
import type { AuthUser } from '../../shared/types';

let ctx: TestCtx;

/**
 * The seeded rows exactly as `freshDb()` left them.
 *
 * Every suite in this repository shares one database across its cases, and this
 * one mutates the two columns the seed is defined by. Without the restore, case
 * three logs in with a password case two changed — a failure whose cause is two
 * tests away from its symptom. Captured rather than re-derived because the seed
 * hash is built at a deliberately cheap scrypt cost that the harness does not
 * export.
 */
let seeded: { id: string; passwordHash: string; displayName: string }[] = [];

beforeAll(async () => {
  ctx = await freshDb();
  const rows = await ctx.db.execute(sql`SELECT id, password_hash, display_name FROM users`);
  seeded = rows.rows.map((row) => ({
    id: String(row.id),
    passwordHash: String(row.password_hash),
    displayName: String(row.display_name),
  }));
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  // `chpw:<userId>` is keyed on the account, so it survives a new client and a
  // new IP — the one bucket in this file that a fresh `httpClient` cannot
  // escape. Sessions go too, so `GET /api/auth/sessions` counts only its own.
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM posts`);
});

afterEach(async () => {
  for (const row of seeded) {
    await ctx.db.execute(sql`
      UPDATE users
         SET password_hash = ${row.passwordHash}, display_name = ${row.displayName}
       WHERE id = ${row.id}::uuid`);
  }
});

/** An `httpClient` with a stable IP, so the login buckets stay disjoint. */
function client(ip: string): HttpClient {
  const base = httpClient(ctx.db);
  const withIp = (init: RequestInit = {}): RequestInit => {
    const headers = new Headers(init.headers);
    headers.set('x-real-ip', ip);
    return { ...init, headers };
  };
  return {
    ...base,
    get: (p, i = {}) => base.get(p, withIp(i)),
    post: (p, b?, i = {}) => base.post(p, b, withIp(i)),
    patch: (p, b?, i = {}) => base.patch(p, b, withIp(i)),
    del: (p, i = {}) => base.del(p, withIp(i)),
    request: (p, i = {}) => base.request(p, withIp(i)),
  };
}

async function loggedIn(
  user: AuthUser,
  ip: string,
  password = SEED_PASSWORD,
  init: RequestInit = {},
): Promise<HttpClient> {
  const c = client(ip);
  const res = await c.post('/api/auth/login', { email: user.email, password }, init);
  expect(res.status).toBe(200);
  return c;
}

// --------------------------------------------------------- PATCH /auth/me

describe('PATCH /api/auth/me', () => {
  it('is 401 without a session', async () => {
    const res = await client('203.0.113.60').patch('/api/auth/me', {
      displayName: 'Nobody',
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('unauthenticated');
  });

  it('changes the display name and every later read agrees', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.61');
    const res = await c.patch('/api/auth/me', { displayName: 'Renamed Writer' });
    expect(res.status).toBe(200);
    expect((await json<{ user: AuthUser }>(res)).user).toEqual({
      ...ctx.users.writer,
      displayName: 'Renamed Writer',
    });

    // Through the session, not through the response body: `resolveSession`
    // re-reads the row on every request, so this is the stored value.
    const me = await c.get('/api/auth/me');
    expect((await json<{ user: AuthUser }>(me)).user.displayName).toBe('Renamed Writer');
  });

  it('a rename lands on a post written BEFORE it, with no backfill', async () => {
    /*
     * THE ASSERTION THAT DECIDED THERE IS NO MIGRATION IN THIS TASK.
     *
     * `posts` has no `author_name` column: `server/repo/posts.ts:62` and
     * `server/repo/query.ts:371` both read `u.display_name AS author_name`
     * through a live join on `author_id`. So the post below — created under the
     * old name and never touched again — reports the new one. Denormalise the
     * name onto `posts` without a backfill and this goes red.
     */
    const c = await loggedIn(ctx.users.writer, '203.0.113.62');
    const created = await json<{ post: { id: string; authorName: string } }>(
      await c.post('/api/posts', { title: 'Written under the old name' }),
    );
    expect(created.post.authorName).toBe(ctx.users.writer.displayName);

    expect((await c.patch('/api/auth/me', { displayName: 'The New Name' })).status).toBe(200);

    const reread = await json<{ post: { authorName: string } }>(
      await c.get(`/api/posts/${created.post.id}`),
    );
    expect(reread.post.authorName).toBe('The New Name');

    // And in the list projection, which builds `authorName` through its own
    // join rather than through `getPost`'s.
    const listed = await json<{ items: { id: string; authorName: string }[] }>(
      await c.get('/api/posts'),
    );
    expect(listed.items.find((p) => p.id === created.post.id)?.authorName).toBe(
      'The New Name',
    );
  });

  it('trims, and refuses a name that is blank or only whitespace', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.63');

    const padded = await c.patch('/api/auth/me', { displayName: '  Padded  ' });
    expect((await json<{ user: AuthUser }>(padded)).user.displayName).toBe('Padded');

    // Zod's `.min(1)` catches the empty string; it accepts three spaces, which
    // is why `assertDisplayName` exists behind it.
    const empty = await c.patch('/api/auth/me', { displayName: '' });
    expect(empty.status).toBe(400);
    expect((await json(empty)).detail).toBe('displayName');

    const blank = await c.patch('/api/auth/me', { displayName: '   ' });
    expect(blank.status).toBe(400);
    expect(await json(blank)).toMatchObject({
      error: 'bad_request',
      detail: 'displayName',
    });

    // Unchanged by either refusal.
    const me = await c.get('/api/auth/me');
    expect((await json<{ user: AuthUser }>(me)).user.displayName).toBe('Padded');
  });

  it('refuses a name over 200 characters and an unknown key', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.64');

    const long = await c.patch('/api/auth/me', { displayName: 'x'.repeat(201) });
    expect(long.status).toBe(400);
    expect((await json(long)).detail).toBe('displayName');

    // The role is not on this body and never will be: `PATCH /api/auth/me`
    // that could set a role is privilege escalation by HTTP request.
    const escalate = await c.patch('/api/auth/me', {
      displayName: 'Sneaky',
      role: 'owner',
    });
    expect(escalate.status).toBe(400);
    expect((await json(escalate)).detail).toBe('role');
    expect((await json<{ user: AuthUser }>(await c.get('/api/auth/me'))).user.role).toBe(
      'writer',
    );
  });

  it('an empty patch is a no-op that returns the caller', async () => {
    const c = await loggedIn(ctx.users.owner, '203.0.113.65');
    const res = await c.patch('/api/auth/me', {});
    expect(res.status).toBe(200);
    expect((await json<{ user: AuthUser }>(res)).user).toEqual(ctx.users.owner);
  });
});

// ------------------------------------------------- POST /auth/change-password

const NEW_PASSWORD = 'a-brand-new-password';

describe('POST /api/auth/change-password', () => {
  it('is 401 without a session', async () => {
    const res = await client('203.0.113.70').post('/api/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('changes the password: the new one logs in and the old one does not', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.71');
    const res = await c.post('/api/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });

    const fresh = client('203.0.113.72');
    const withNew = await fresh.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: NEW_PASSWORD,
    });
    expect(withNew.status).toBe(200);

    const withOld = await client('203.0.113.73').post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(withOld.status).toBe(401);
  });

  it("the caller's cookie survives and every other one does not", async () => {
    /*
     * THE WHOLE ROUTE, IN ONE CASE.
     *
     * `POST /api/auth/reset` ends every session because a reset is what someone
     * does when they believe an intruder holds one. This is the signed-in path,
     * and it has to do the opposite for the tab doing the typing while doing the
     * same thing to every other tab — otherwise it is either unusable or
     * useless. Neither half can be seen without two live cookies for one
     * account.
     */
    const laptop = await loggedIn(ctx.users.owner, '203.0.113.74');
    const phone = await loggedIn(ctx.users.owner, '203.0.113.75');
    expect((await phone.get('/api/auth/me')).status).toBe(200);

    const res = await laptop.post('/api/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, otherSessionsEnded: 1 });

    // The caller keeps working — same cookie, no re-login, no new Set-Cookie.
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(laptop.cookies().has(SESSION_COOKIE)).toBe(true);
    expect((await laptop.get('/api/auth/me')).status).toBe(200);

    // The other one is gone, and gone from the table rather than merely
    // shadowed — `resolveSession` would still accept a surviving row.
    expect((await phone.get('/api/auth/me')).status).toBe(401);
    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${ctx.users.owner.id}::uuid`);
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it('leaves other accounts alone', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.76');
    const writer = await loggedIn(ctx.users.writer, '203.0.113.77');

    expect(
      (
        await owner.post('/api/auth/change-password', {
          currentPassword: SEED_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);

    // The writer's session and password are untouched: the sweep is scoped by
    // `user_id`, not by "every session issued before now".
    expect((await writer.get('/api/auth/me')).status).toBe(200);
    expect(
      (
        await client('203.0.113.78').post('/api/auth/login', {
          email: ctx.users.writer.email,
          password: SEED_PASSWORD,
        })
      ).status,
    ).toBe(200);
  });

  it('a wrong current password is a 400 naming the field, never a 401', async () => {
    /*
     * 401 WOULD BE THE WRONG ANSWER AND AN EXPENSIVE ONE. The session is valid
     * — `requireAuth` just said so — so 401 lies about which credential failed,
     * and `src/data/api.ts` maps every 401 onto `AuthExpiredError` and fires
     * `auth-expired`, which raises the re-authentication overlay. A typo in one
     * field would look exactly like a session that had died mid-edit.
     */
    const c = await loggedIn(ctx.users.writer, '203.0.113.79');
    const res = await c.post('/api/auth/change-password', {
      currentPassword: 'not-the-seed-password',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      error: 'bad_request',
      detail: 'currentPassword',
    });

    // Nothing moved: the old password still logs in, the session still works.
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect(
      (
        await client('203.0.113.80').post('/api/auth/login', {
          email: ctx.users.writer.email,
          password: SEED_PASSWORD,
        })
      ).status,
    ).toBe(200);
  });

  it('a short new password is a 400 and the old one still works', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.81');
    const res = await c.post('/api/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: 'x'.repeat(MIN_PASSWORD_LENGTH - 1),
    });
    expect(res.status).toBe(400);
    // `detail` is the field name `UserInputError` carries, and it is
    // `password` rather than `newPassword` because `assertCredentials` is the
    // one authority for the rule and names the field it judges.
    expect((await json(res)).detail).toBe('password');

    expect(
      (
        await client('203.0.113.82').post('/api/auth/login', {
          email: ctx.users.writer.email,
          password: SEED_PASSWORD,
        })
      ).status,
    ).toBe(200);
  });

  it('a 400 never echoes either password', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.83');
    const res = await c.post('/api/auth/change-password', {
      currentPassword: 'wrong-but-memorable',
      newPassword: 'also-quite-memorable',
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain('wrong-but-memorable');
    expect(text).not.toContain('also-quite-memorable');
  });

  it('refuses an unknown body key', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.84');
    const res = await c.post('/api/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: NEW_PASSWORD,
      userId: ctx.users.owner.id,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('userId');
  });

  it('is limited to five wrong guesses per account, whatever the IP', async () => {
    /*
     * The bucket is `chpw:<userId>`, NOT `chpw:<ip>`. Somebody sitting at an
     * unlocked laptop guessing the existing password is the threat, and moving
     * between networks must not reset the count — so every attempt below comes
     * from a different address and they still share one counter.
     */
    const statuses: number[] = [];
    for (let i = 0; i < CHANGE_PASSWORD_LIMIT + 1; i += 1) {
      const c = await loggedIn(ctx.users.writer, `198.51.100.${100 + i}`);
      const res = await c.post('/api/auth/change-password', {
        currentPassword: `guess-number-${i}`,
        newPassword: NEW_PASSWORD,
      });
      statuses.push(res.status);
      if (i === CHANGE_PASSWORD_LIMIT) {
        const body = await json(res);
        expect(body.error).toBe('rate_limited');
        expect(body.retryAfter).toBeGreaterThan(0);
        expect(res.headers.get('retry-after')).toBe(String(body.retryAfter));
      }
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);

    const keys = await ctx.db.execute(sql`SELECT key FROM auth_attempts`);
    expect(keys.rows.map((r) => String(r.key))).toContain(`chpw:${ctx.users.writer.id}`);
  });

  it('a successful change forgets the bucket', async () => {
    // Four typos then the real password: being locked out of changing your own
    // password for a quarter of an hour, immediately after proving you know it,
    // is the login route's `forget` case one endpoint over.
    const c = await loggedIn(ctx.users.owner, '198.51.100.120');
    for (let i = 0; i < 4; i += 1) {
      await c.post('/api/auth/change-password', {
        currentPassword: 'wrong',
        newPassword: NEW_PASSWORD,
      });
    }
    expect(
      (
        await c.post('/api/auth/change-password', {
          currentPassword: SEED_PASSWORD,
          newPassword: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);

    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM auth_attempts WHERE key = ${`chpw:${ctx.users.owner.id}`}`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

// -------------------------------------------------------- sessions routes

interface SessionItem {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  userAgent: string | null;
  current: boolean;
}

const listSessionsOf = async (c: HttpClient): Promise<SessionItem[]> => {
  const res = await c.get('/api/auth/sessions');
  expect(res.status).toBe(200);
  return (await json<{ items: SessionItem[] }>(res)).items;
};

describe('GET /api/auth/sessions', () => {
  it('is 401 without a session', async () => {
    expect((await client('203.0.113.90').get('/api/auth/sessions')).status).toBe(401);
  });

  it('lists the caller\'s own sessions, marks the current one, and carries the user agent', async () => {
    const laptop = await loggedIn(ctx.users.writer, '203.0.113.91', SEED_PASSWORD, {
      headers: { 'user-agent': 'Studio/1.0 (laptop)' },
    });
    await loggedIn(ctx.users.writer, '203.0.113.92', SEED_PASSWORD, {
      headers: { 'user-agent': 'Studio/1.0 (phone)' },
    });

    const items = await listSessionsOf(laptop);
    expect(items).toHaveLength(2);
    expect(items.filter((s) => s.current)).toHaveLength(1);
    expect(items.find((s) => s.current)?.userAgent).toBe('Studio/1.0 (laptop)');
    expect(items.map((s) => s.userAgent).sort()).toEqual([
      'Studio/1.0 (laptop)',
      'Studio/1.0 (phone)',
    ]);

    // The columns this route exists to surface are real numbers, not strings —
    // `sessions.last_seen_at` is a bigint and Neon hands bigints back as text.
    for (const s of items) {
      expect(typeof s.lastSeenAt).toBe('number');
      expect(typeof s.expiresAt).toBe('number');
      expect(s.expiresAt).toBeGreaterThan(Date.now());
      expect(s.lastSeenAt).toBeGreaterThan(0);
    }
  });

  it("never shows another account's sessions", async () => {
    await loggedIn(ctx.users.owner, '203.0.113.93');
    const writer = await loggedIn(ctx.users.writer, '203.0.113.94');

    const items = await listSessionsOf(writer);
    expect(items).toHaveLength(1);
    // Two sessions exist in the table; one of them belongs to somebody else.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM sessions`);
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('omits an expired session rather than offering it for revocation', async () => {
    const c = await loggedIn(ctx.users.writer, '203.0.113.95');
    await ctx.db.execute(sql`
      INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
      VALUES ('deadsession', ${ctx.users.writer.id}, ${Date.now() - 10}, ${Date.now() - 1},
              ${Date.now() - 5}, 'Studio/1.0 (dead)')`);

    const items = await listSessionsOf(c);
    expect(items.map((s) => s.userAgent)).not.toContain('Studio/1.0 (dead)');
    expect(items).toHaveLength(1);
  });

  it('never returns a raw session token', async () => {
    const c = await loggedIn(ctx.users.owner, '203.0.113.96');
    const token = c.cookies().get(SESSION_COOKIE)!;
    const text = await (await c.get('/api/auth/sessions')).text();
    expect(text).not.toContain(token);
    // What it does return is the stored id, which is the HMAC of that token.
    const items = JSON.parse(text) as { items: SessionItem[] };
    expect(items.items[0].id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('DELETE /api/auth/sessions/:id', () => {
  it('is 401 without a session', async () => {
    expect(
      (await client('203.0.113.100').del('/api/auth/sessions/whatever')).status,
    ).toBe(401);
  });

  it('revokes one of your own and that cookie stops working', async () => {
    const laptop = await loggedIn(ctx.users.writer, '203.0.113.101');
    const phone = await loggedIn(ctx.users.writer, '203.0.113.102');

    const items = await listSessionsOf(laptop);
    const other = items.find((s) => !s.current)!;
    expect(other).toBeTruthy();

    const res = await laptop.del(`/api/auth/sessions/${other.id}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });

    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).status).toBe(200);
    expect(await listSessionsOf(laptop)).toHaveLength(1);
  });

  it('revoking the CURRENT session is allowed and ends it', async () => {
    // A logout that leaves the cookie in the browser: the next request 401s and
    // the client clears it. Refusing would be a rule to learn for no benefit.
    const c = await loggedIn(ctx.users.owner, '203.0.113.103');
    const mine = (await listSessionsOf(c)).find((s) => s.current)!;
    expect((await c.del(`/api/auth/sessions/${mine.id}`)).status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it("someone else's session id is the same 404 as one that never existed", async () => {
    /*
     * Both are 404 because `revokeSession` puts `user_id` in the WHERE clause,
     * so the two cases are the same zero rows. Told apart, this route would
     * answer "does this id belong to somebody" for anyone holding a session.
     */
    const owner = await loggedIn(ctx.users.owner, '203.0.113.104');
    const writer = await loggedIn(ctx.users.writer, '203.0.113.105');
    const theirs = (await listSessionsOf(writer)).find((s) => s.current)!;

    const foreign = await owner.del(`/api/auth/sessions/${theirs.id}`);
    expect(foreign.status).toBe(404);
    expect((await json(foreign)).error).toBe('gone');

    const unknown = await owner.del('/api/auth/sessions/no-such-session-id');
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error).toBe('gone');

    // Still alive: a 404 that had actually deleted the row would pass the
    // status assertion above and fail this one.
    expect((await writer.get('/api/auth/me')).status).toBe(200);
  });

  it('revoking twice is a 200 then a 404', async () => {
    const laptop = await loggedIn(ctx.users.writer, '203.0.113.106');
    await loggedIn(ctx.users.writer, '203.0.113.107');
    const other = (await listSessionsOf(laptop)).find((s) => !s.current)!;

    expect((await laptop.del(`/api/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await laptop.del(`/api/auth/sessions/${other.id}`)).status).toBe(404);
  });
});
