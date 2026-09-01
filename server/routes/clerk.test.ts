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

/**
 * PROVISIONING — the branch that lets this route be the only door.
 *
 * `createUser` used to run in exactly one place: accept-invite, behind a
 * password form. Deleting the password routes without this would have left
 * every future teammate verifying with Google perfectly and then bouncing off
 * `not_invited` forever, with no screen left able to let them in. These are
 * the properties that make claiming an invite BY VERIFIED ADDRESS safe.
 */
describe('provisioning from an invite', () => {
  /* `token_hash` is UNIQUE, so the counter is load-bearing: two open invites
     for one address is a case below, and a shared literal makes it a 23505
     rather than the thing under test. The token itself is never read — the
     claim keys on the ADDRESS now. */
  let seq = 0;
  const openInvite = async (email: string, role = 'writer') => {
    seq += 1;
    await ctx.db.execute(sql`
      INSERT INTO invites (email, token_hash, role, invited_by, created_at, expires_at)
      VALUES (${email}, ${`hash-${seq}-${email}`}, ${role}, ${ctx.users.owner.id}::uuid,
              ${Date.now()}, ${Date.now() + 86_400_000})`);
  };

  it('a first sign-in on an open invite creates the account and spends it', async () => {
    await openInvite('newcomer@test.local', 'supply_chain');
    registerClerkVerifier({
      verify: async () => ({ email: 'newcomer@test.local', name: 'New Comer' }),
    });

    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 'whatever' });
    expect(res.status).toBe(200);

    /* THE INVITE decides the role, not the caller and not Clerk. */
    const body = await json<{ user: { email: string; role: string; displayName: string } }>(res);
    expect(body.user).toMatchObject({
      email: 'newcomer@test.local',
      role: 'supply_chain',
      displayName: 'New Comer',
    });

    /* And the session is the ordinary one, straight away. */
    expect((await c.get('/api/auth/me')).status).toBe(200);

    const spent = await ctx.db.execute(
      sql`SELECT accepted_at FROM invites WHERE email = 'newcomer@test.local'`,
    );
    expect(spent.rows[0].accepted_at).not.toBeNull();
  });

  it('signing in again finds the account rather than claiming a second invite', async () => {
    await openInvite('twice@test.local');
    registerClerkVerifier({ verify: async () => ({ email: 'twice@test.local' }) });

    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(200);
    /* A second open invite for the same address must NOT be spent by a return
       visit — the account already exists, so the claim is never reached. */
    await openInvite('twice@test.local', 'developer');
    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(200);

    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM invites
       WHERE email = 'twice@test.local' AND accepted_at IS NULL`);
    expect(Number(rows.rows[0].n)).toBe(1);
    /* The role from the FIRST invite stands; the later one did not promote. */
    const user = await ctx.db.execute(
      sql`SELECT role FROM users WHERE email = 'twice@test.local'`,
    );
    expect(String(user.rows[0].role)).toBe('writer');
  });

  it('the display name falls back to the local part when Clerk has no name', async () => {
    await openInvite('nameless@test.local');
    registerClerkVerifier({ verify: async () => ({ email: 'nameless@test.local' }) });

    const res = await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' });
    expect(res.status).toBe(200);
    /* `createUser` refuses a blank display name, so a Google account with no
       profile name would otherwise be a 500 rather than a sign-in. */
    expect((await json<{ user: { displayName: string } }>(res)).user.displayName).toBe(
      'nameless',
    );
  });

  it('an expired invite provisions nothing', async () => {
    await ctx.db.execute(sql`
      INSERT INTO invites (email, token_hash, role, invited_by, created_at, expires_at)
      VALUES ('late@test.local', 'hash-late', 'writer', ${ctx.users.owner.id}::uuid,
              ${Date.now() - 200_000}, ${Date.now() - 100_000})`);
    registerClerkVerifier({ verify: async () => ({ email: 'late@test.local' }) });

    const c = httpClient(ctx.db);
    const res = await c.post('/api/auth/clerk/exchange', { token: 't' });
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toBe('not_invited');

    const made = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE email = 'late@test.local'`,
    );
    expect(Number(made.rows[0].n)).toBe(0);
  });

  it('a spent invite provisions nothing — one account, not a standing pass', async () => {
    await ctx.db.execute(sql`
      INSERT INTO invites (email, token_hash, role, invited_by, created_at, expires_at,
                           accepted_at)
      VALUES ('spent@test.local', 'hash-spent', 'writer', ${ctx.users.owner.id}::uuid,
              ${Date.now()}, ${Date.now() + 86_400_000}, ${Date.now()})`);
    registerClerkVerifier({ verify: async () => ({ email: 'spent@test.local' }) });

    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(403);
  });

  it('a REVOKED account is not resurrected by an invite that outlived it', async () => {
    /*
     * The order inside the route is what this pins: the disabled check runs
     * BEFORE the claim, so a revoked teammate holding an open invite row stays
     * out. Reverse the two and revocation becomes a formality.
     */
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE email = ${ctx.users.writer.email}`,
    );
    await openInvite(ctx.users.writer.email, 'developer');
    registerClerkVerifier({ verify: async () => ({ email: ctx.users.writer.email }) });

    const res = await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' });
    expect(res.status).toBe(403);

    const still = await ctx.db.execute(
      sql`SELECT role, disabled_at FROM users WHERE email = ${ctx.users.writer.email}`,
    );
    expect(String(still.rows[0].role)).toBe('writer');
    expect(still.rows[0].disabled_at).not.toBeNull();
  });

  it('a historical owner-role invite row is refused at provisioning', async () => {
    /*
     * Moved here from `team-rules.test.ts` when acceptance moved to this
     * route. The column still admits 'owner' — migration 0680 keeps history
     * legal — and the pre-0680 route could mint one, so an unspent row could
     * otherwise create a SECOND owner who could then disable the first.
     */
    await openInvite('usurper@test.local', 'owner');
    registerClerkVerifier({ verify: async () => ({ email: 'usurper@test.local' }) });

    expect(
      (await httpClient(ctx.db).post('/api/auth/clerk/exchange', { token: 't' })).status,
    ).toBe(403);
    const owners = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE role = 'owner'`,
    );
    expect(Number(owners.rows[0].n)).toBe(1);
  });
});
