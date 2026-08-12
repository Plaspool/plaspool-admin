/**
 * The password-reset flow, driven end to end through the real app.
 *
 * THE MAILER IS A FAKE AND NOTHING HERE TOUCHES THE NETWORK. That is not only a
 * speed choice: the token only ever exists in the delivered message, so a suite
 * that could not read what was sent would have to reach into `password_resets`
 * and reverse an HMAC — i.e. it would have to test something other than the
 * flow a user actually walks. Recording the message is what lets every case
 * below start from the link, exactly as the user does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, type TestCtx } from '../test/harness';
import { TEST_ORIGIN, httpClient, json } from '../test/http';
import { SESSION_COOKIE } from '../middleware/session';
import { FORGOT_LIMIT, RESET_PATH } from './auth';
import { LOGIN_IP_LIMIT } from '../repo/ratelimit';
import { MIN_PASSWORD_LENGTH } from '../repo/users';
import type { Mailer } from '../mail/port';

let ctx: TestCtx;

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** A mailer that records instead of sending. No `assertConfigured` — it is. */
function fakeMailer(): { mailer: Mailer; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    mailer: {
      async send(msg) {
        sent.push(msg);
      },
    },
  };
}

const NEW_PASSWORD = 'a-brand-new-password';

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  // Shared buckets and shared users across cases: every test starts from a
  // known password and an empty limiter, or the third one 429s for reasons
  // that have nothing to do with what it is asserting.
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM password_resets`);
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
});

/** A client with a stable IP and its own recording mailer. */
function studio(ip = '203.0.113.50') {
  const { mailer, sent } = fakeMailer();
  const base = httpClient(ctx.db, { mailer });
  const withIp = (init: RequestInit = {}): RequestInit => {
    const headers = new Headers(init.headers);
    headers.set('x-real-ip', ip);
    return { ...init, headers };
  };
  return {
    sent,
    get: (p: string, i: RequestInit = {}) => base.get(p, withIp(i)),
    post: (p: string, b?: unknown, i: RequestInit = {}) => base.post(p, b, withIp(i)),
    cookies: base.cookies,
  };
}

/** The token out of the delivered link, read the way the hash router reads it. */
function tokenFrom(message: Sent): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  expect(link).toBeTruthy();
  const url = new URL(link!);
  // Nothing in the real query string: `createHashRouter` never looks there, so
  // a token that only lived there would be unredeemable by any real client.
  expect(url.search).toBe('');
  const routed = new URL(url.hash.substring(1), 'http://router.invalid');
  expect(routed.pathname).toBe('/reset');
  const token = routed.searchParams.get('token');
  expect(token).toBeTruthy();
  return token!;
}

/** Ask for a reset for `email` and return the token that was mailed. */
async function requestReset(email: string, ip = '203.0.113.50') {
  const c = studio(ip);
  const res = await c.post('/api/auth/forgot', { email });
  expect(res.status).toBe(202);
  expect(c.sent).toHaveLength(1);
  return { client: c, token: tokenFrom(c.sent[0]) };
}

// ------------------------------------------------------------------ forgot

describe('POST /api/auth/forgot', () => {
  it('answers 202 for an unknown address and sends nothing', async () => {
    const c = studio('203.0.113.51');
    const res = await c.post('/api/auth/forgot', { email: 'nobody@test.local' });
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ sent: true });
    expect(c.sent).toHaveLength(0);
    // And no row: an address with no account leaves no trace to count.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM password_resets`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('answers 202 for a known address and sends exactly one link', async () => {
    const c = studio('203.0.113.52');
    const res = await c.post('/api/auth/forgot', { email: ctx.users.writer.email });
    expect(res.status).toBe(202);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].to).toBe(ctx.users.writer.email);

    const token = tokenFrom(c.sent[0]);
    expect(token.length).toBeGreaterThan(20);
    // Built from the configured origin, never from a Host header.
    expect(c.sent[0].text).toContain(`${TEST_ORIGIN}${RESET_PATH}?token=`);
    expect(c.sent[0].html).toContain(`${TEST_ORIGIN}${RESET_PATH}?token=`);
  });

  it('is indistinguishable between a known and an unknown address', async () => {
    const known = studio('203.0.113.53');
    const unknown = studio('203.0.113.54');
    const a = await known.post('/api/auth/forgot', { email: ctx.users.owner.email });
    const b = await unknown.post('/api/auth/forgot', { email: 'ghost@test.local' });

    expect(a.status).toBe(b.status);
    const bodyA = await json(a);
    const bodyB = await json(b);
    expect({ ...bodyA, requestId: null }).toEqual({ ...bodyB, requestId: null });
  });

  it('the case of the address does not matter', async () => {
    const c = studio('203.0.113.55');
    const res = await c.post('/api/auth/forgot', { email: 'Writer@Test.Local' });
    expect(res.status).toBe(202);
    expect(c.sent).toHaveLength(1);
  });

  it('stores a DIGEST — the mailed token appears nowhere in the table', async () => {
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.56');
    const rows = await ctx.db.execute(sql`SELECT token_hash FROM password_resets`);
    expect(rows.rows).toHaveLength(1);
    const stored = String(rows.rows[0].token_hash);
    expect(stored).not.toBe(token);
    expect(stored).not.toContain(token);
    // An HMAC-SHA-256 in hex, exactly like a session id.
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issuing a new reset invalidates the previous one', async () => {
    const first = await requestReset(ctx.users.writer.email, '203.0.113.57');
    const second = await requestReset(ctx.users.writer.email, '203.0.113.58');
    expect(second.token).not.toBe(first.token);

    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM password_resets`);
    expect(Number(rows.rows[0].n)).toBe(1);

    const stale = await studio('203.0.113.59').post('/api/auth/reset', {
      token: first.token,
      password: NEW_PASSWORD,
    });
    expect(stale.status).toBe(400);
    expect(await json(stale)).toMatchObject({ error: 'bad_request', detail: 'token' });
  });

  it('sends nothing for a disabled account, and still answers 202', async () => {
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${ctx.users.writer.id}`,
    );
    const c = studio('203.0.113.60');
    const res = await c.post('/api/auth/forgot', { email: ctx.users.writer.email });
    expect(res.status).toBe(202);
    expect(c.sent).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- reset

describe('POST /api/auth/reset', () => {
  it('the emailed token changes the password: the old one 401s, the new one 200s', async () => {
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.61');

    const res = await studio('203.0.113.62').post('/api/auth/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });
    // Resetting is not logging in: no cookie comes back.
    expect(res.headers.getSetCookie()).toHaveLength(0);

    const old = await studio('203.0.113.63').post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(old.status).toBe(401);

    const fresh = studio('203.0.113.64');
    const ok = await fresh.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: NEW_PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect((await fresh.get('/api/auth/me')).status).toBe(200);

    // Put it back, so the shared seed survives for the rest of the suite.
    const again = await requestReset(ctx.users.writer.email, '203.0.113.66');
    await studio('203.0.113.67').post('/api/auth/reset', {
      token: again.token,
      password: SEED_PASSWORD,
    });
  });

  it('the token is single-use: the second attempt is a 400', async () => {
    const { token } = await requestReset(ctx.users.owner.email, '203.0.113.68');

    const first = await studio('203.0.113.69').post('/api/auth/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(first.status).toBe(200);

    const second = await studio('203.0.113.70').post('/api/auth/reset', {
      token,
      password: 'a-different-password-again',
    });
    expect(second.status).toBe(400);
    expect(await json(second)).toMatchObject({ error: 'bad_request', detail: 'token' });

    // The second attempt did not take: the FIRST password is the live one.
    const login = await studio('203.0.113.71').post('/api/auth/login', {
      email: ctx.users.owner.email,
      password: NEW_PASSWORD,
    });
    expect(login.status).toBe(200);

    const back = await requestReset(ctx.users.owner.email, '203.0.113.72');
    await studio('203.0.113.73').post('/api/auth/reset', {
      token: back.token,
      password: SEED_PASSWORD,
    });
  });

  it('two concurrent redemptions cannot both succeed', async () => {
    /*
     * The guarded UPDATE is the whole of single-use, and a read-then-write
     * passes the sequential case above while failing this one — both readers
     * see `used_at IS NULL` and both set a password, so whichever lands second
     * owns the account.
     */
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.74');
    const [a, b] = await Promise.all([
      studio('203.0.113.75').post('/api/auth/reset', { token, password: NEW_PASSWORD }),
      studio('203.0.113.76').post('/api/auth/reset', {
        token,
        password: 'yet-another-password',
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const back = await requestReset(ctx.users.writer.email, '203.0.113.77');
    await studio('203.0.113.78').post('/api/auth/reset', {
      token: back.token,
      password: SEED_PASSWORD,
    });
  });

  it('an expired token is a 400 and changes nothing', async () => {
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.79');
    await ctx.db.execute(sql`UPDATE password_resets SET expires_at = ${Date.now() - 1}`);

    const res = await studio('203.0.113.80').post('/api/auth/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('token');

    const login = await studio('203.0.113.81').post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(login.status).toBe(200);
  });

  it('a token minted before the account was disabled does not work', async () => {
    /*
     * A revocation must not be undoable by a link already sitting in the
     * revoked user's mailbox — `disableUser` destroys their sessions, and a
     * reset that still worked would hand the account straight back.
     */
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.82');
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${ctx.users.writer.id}`,
    );

    const res = await studio('203.0.113.83').post('/api/auth/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toBe('token');

    // Unspent, so nothing was consumed on the way to refusing.
    const rows = await ctx.db.execute(sql`SELECT used_at FROM password_resets`);
    expect(rows.rows[0].used_at).toBeNull();
  });

  it('an unknown token is a 400, not a 500 the client retries', async () => {
    const res = await studio('203.0.113.84').post('/api/auth/reset', {
      token: 'not-a-token-anyone-minted',
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'token' });
  });

  it('a short password is a 400 naming the field, and the token survives', async () => {
    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.85');

    const res = await studio('203.0.113.86').post('/api/auth/reset', {
      token,
      password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'bad_request', detail: 'password' });
    // The field name, never the value: a 400 that echoed the submitted password
    // would put one in every proxy log the first time somebody typed it.
    expect(text).not.toContain('xxxx');

    // Not burned: a rejected password must not cost the user their only link.
    const rows = await ctx.db.execute(sql`SELECT used_at FROM password_resets`);
    expect(rows.rows[0].used_at).toBeNull();

    const ok = await studio('203.0.113.87').post('/api/auth/reset', {
      token,
      password: SEED_PASSWORD,
    });
    expect(ok.status).toBe(200);
  });

  it('resetting destroys every existing session', async () => {
    const signedIn = studio('203.0.113.88');
    const login = await signedIn.post('/api/auth/login', {
      email: ctx.users.writer.email,
      password: SEED_PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(signedIn.cookies().has(SESSION_COOKIE)).toBe(true);
    expect((await signedIn.get('/api/auth/me')).status).toBe(200);

    const { token } = await requestReset(ctx.users.writer.email, '203.0.113.89');
    const res = await studio('203.0.113.90').post('/api/auth/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);

    // THE POINT OF THE WHOLE FLOW: the cookie the intruder holds is dead.
    expect((await signedIn.get('/api/auth/me')).status).toBe(401);
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${ctx.users.writer.id}`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);

    const back = await requestReset(ctx.users.writer.email, '203.0.113.91');
    await studio('203.0.113.92').post('/api/auth/reset', {
      token: back.token,
      password: SEED_PASSWORD,
    });
  });
});

// ------------------------------------------------------------ rate limiting

describe('password-reset rate limiting', () => {
  it('the narrow forgot bucket fires at FORGOT_LIMIT for one ip+email', async () => {
    const c = studio('198.51.100.40');
    const statuses: number[] = [];
    for (let i = 0; i < FORGOT_LIMIT + 1; i += 1) {
      const res = await c.post('/api/auth/forgot', { email: ctx.users.writer.email });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, FORGOT_LIMIT)).toEqual(Array(FORGOT_LIMIT).fill(202));
    expect(statuses[FORGOT_LIMIT]).toBe(429);
    // The refusal is a refusal: no sixth message left the building.
    expect(c.sent).toHaveLength(FORGOT_LIMIT);

    const body = await json(
      await c.post('/api/auth/forgot', { email: ctx.users.writer.email }),
    );
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('the wide forgot bucket fires per ip across DISTINCT addresses', async () => {
    // Two attempts each against many addresses: no narrow bucket ever reaches
    // FORGOT_LIMIT, so anything refused here is the per-ip bucket.
    const ip = '198.51.100.41';
    const c = studio(ip);
    let refusals = 0;
    const attempts = LOGIN_IP_LIMIT + 4;
    for (let i = 0; i < attempts; i += 1) {
      const res = await c.post('/api/auth/forgot', { email: `walk-${i}@test.local` });
      if (res.status === 429) refusals += 1;
    }
    expect(refusals).toBe(attempts - LOGIN_IP_LIMIT);

    const keys = await ctx.db.execute(sql`SELECT key FROM auth_attempts`);
    expect(keys.rows.map((r) => String(r.key))).toContain(`forgot:${ip}`);
  });

  it('the ip bucket is consulted BEFORE the body is parsed', async () => {
    const c = studio('198.51.100.42');
    for (let i = 0; i < LOGIN_IP_LIMIT; i += 1) {
      await c.post('/api/auth/forgot', { email: `pre-${i}@test.local` });
    }
    const res = await c.post('/api/auth/forgot', { email: 12345 });
    // A body that cannot parse answered 429 rather than 400 is only possible
    // if the limiter ran first.
    expect(res.status).toBe(429);
  });

  it('the reset route is rate limited by ip', async () => {
    const ip = '198.51.100.43';
    const c = studio(ip);
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_IP_LIMIT + 1; i += 1) {
      const res = await c.post('/api/auth/reset', {
        token: `guess-${i}`,
        password: NEW_PASSWORD,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, LOGIN_IP_LIMIT)).toEqual(Array(LOGIN_IP_LIMIT).fill(400));
    expect(statuses[LOGIN_IP_LIMIT]).toBe(429);

    const keys = await ctx.db.execute(sql`SELECT key FROM auth_attempts`);
    expect(keys.rows.map((r) => String(r.key))).toContain(`reset:${ip}`);
  });
});

// ---------------------------------------------------------- the unwired case

describe('an unconfigured mailer', () => {
  it('refuses IDENTICALLY for a known and an unknown address', async () => {
    /*
     * THE ENUMERATION ORACLE THIS ORDERING EXISTS TO CLOSE. If the missing
     * configuration only surfaced inside `send`, a known address would 501 (it
     * got that far) and an unknown one would 202 (it never did) — a perfect,
     * status-code-reliable account list on any deployment that forgot to set
     * `RESEND_API_KEY`.
     *
     * The route asks BEFORE it looks the user up, so both answers are the same.
     */
    const { MailNotConfiguredError } = await import('../mail/port');
    const real: Mailer = {
      assertConfigured() {
        throw new MailNotConfiguredError(['RESEND_API_KEY']);
      },
      async send() {
        throw new Error('never reached');
      },
    };

    const ask = async (email: string, ip: string) => {
      const base = httpClient(ctx.db, { mailer: real });
      const headers = new Headers({ 'x-real-ip': ip });
      return base.post('/api/auth/forgot', { email }, { headers });
    };

    const known = await ask(ctx.users.owner.email, '198.51.100.50');
    const unknown = await ask('ghost@test.local', '198.51.100.51');
    expect(known.status).toBe(501);
    expect(unknown.status).toBe(501);
    expect({ ...(await json(known)), requestId: null }).toEqual({
      ...(await json(unknown)),
      requestId: null,
    });
    // Nothing was minted on the way to refusing.
    const rows = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM password_resets`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});
