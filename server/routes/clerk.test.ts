/**
 * The Clerk bridge, through the real app: a verified Google identity is traded
 * for the ordinary session cookie IFF the email is on the team list. The
 * verifier is faked through the registry seam; everything else — mounting,
 * origin guard, session middleware, cookie flags — is production's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json } from '../test/http';
import { resetEnvCacheForTests } from '../env';
import { registerClerkVerifier, resetClerkVerifier } from './clerk';

let ctx: TestCtx;

beforeAll(async () => {
  /* Imports are hoisted, so a bare top-of-file assignment runs AFTER some
   * import has already warmed the env memo without the key. Set, then clear
   * the memo, then let the next getEnv() re-read. */
  process.env.CLERK_SECRET_KEY = 'sk_test_suite_only';
  resetEnvCacheForTests();
  ctx = await freshDb();
});

afterAll(async () => {
  /* The worker may run other suites after this one — hand back the env this
   * file bent, or their invite routes start dialing a Clerk that isn't there. */
  delete process.env.CLERK_SECRET_KEY;
  resetEnvCacheForTests();
  await ctx.close();
});

beforeEach(async () => {
  resetClerkVerifier();
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
});

describe('the exchange', () => {
  it('trades a verified team email for the ordinary session', async () => {
    registerClerkVerifier({
      verify: async (token) =>
        token === 'good-token' ? { email: ctx.users.owner.email } : null,
    });
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 'good-token' });
    expect(res.status).toBe(200);
    const body = await json<{ user: { email: string } }>(res);
    expect(body.user.email).toBe(ctx.users.owner.email);
    /* The cookie is the REAL one: the very next request authenticates through
     * the ordinary session middleware, no Clerk anywhere in its path. */
    expect((await c.get('/api/auth/me')).status).toBe(200);
  });

  it('refuses a verified identity that is not on the team, by name', async () => {
    registerClerkVerifier({
      verify: async () => ({ email: 'stranger@example.test' }),
    });
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 'whatever' });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('not_invited');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('a disabled account is not_invited too — revocation survives the bridge', async () => {
    registerClerkVerifier({
      verify: async () => ({ email: ctx.users.writer.email }),
    });
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE email = ${ctx.users.writer.email}`,
    );
    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 'whatever' });
    expect(res.status).toBe(403);
  });

  it('an invalid token is a bare 401', async () => {
    registerClerkVerifier({ verify: async () => null });
    const c = httpClient(ctx.db);
    expect((await c.post('/api/auth/clerk/exchange', { token: 'junk' })).status).toBe(401);
  });

  it('status reports the deployment can exchange', async () => {
    const c = httpClient(ctx.db);
    const res = await c.get('/api/auth/clerk/status');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ enabled: true });
  });

  /*
   * The unconfigured half — status false, exchange 501 — is a getEnv() cache
   * question this worker cannot ask twice (the env is read once per process
   * and this file set the key before anything read it). The 501 branch is
   * two lines guarded by the same `getEnv().CLERK_SECRET_KEY === ''` the
   * status route answers from, and the client only offers the button after
   * status says enabled.
   */
});
