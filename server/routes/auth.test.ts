/**
 * Sessions and invites, driven end to end through the real app (spec §5.1, §6).
 *
 * Every case here goes through `app.request()` with real cookies, headers and
 * bodies. The seam this task adds is the one between `server/repo/users.ts` —
 * already covered by its own suite — and HTTP, so testing anything short of a
 * request would test the half that is already proven.
 *
 * SIGNING IN IS NOT TESTED HERE ANY MORE. It used to be most of this file:
 * `POST /api/auth/login`, its two rate-limit buckets, the enumeration property
 * that made an unknown email and a wrong password indistinguishable, and
 * `POST /api/auth/accept-invite`. All four routes were deleted when Clerk
 * became the only door (2026-09-01), and the property they existed to hold —
 * that an outsider learns nothing about who has an account — now belongs to
 * `clerk.test.ts`, which drives the one surviving session-minting route
 * through the same real `createApp()`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { TEST_ORIGIN, httpClient, json } from '../test/http';
import { SESSION_COOKIE } from '../middleware/session';
import { INVITE_PATH } from './auth';
import { createInvite } from '../repo/users';
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
  await c.signIn(user);
  return c;
}


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
    expect(body.invite.url).toBe(`${TEST_ORIGIN}${INVITE_PATH}`);
  });

  it('the invite link carries no credential at all', async () => {
    /*
     * THIS CASE INVERTED WHEN CLERK BECAME THE ONLY DOOR, and the inversion is
     * the point rather than an accident of deleting a route.
     *
     * It used to assert the opposite: that a token reached the invitee where a
     * hash router could read it, because holding the link was the only proof
     * an invitee could offer. Clerk takes a stronger proof first — control of
     * the address — so the invite is claimed by ADDRESS and the link is just
     * the front door. Anything token-shaped reappearing in this URL is a
     * credential emailed for no reason, which is why it is asserted against
     * rather than merely no longer asserted for.
     */
    const owner = await loggedIn(ctx.users.owner, '192.0.2.31');
    const res = await owner.post('/api/invites', { email: 'front-door@test.local' });
    expect(res.status).toBe(201);

    const url = new URL(String((await json<{ invite: { url: string } }>(res)).invite.url));
    expect(url.search).toBe('');
    // Nothing in the hash either — that is where the token used to hide.
    expect(url.hash).toBe('#/');
  });

  it('every invite route is 401 without a session', async () => {
    const anon = client('192.0.2.22');
    expect((await anon.post('/api/invites', { email: 'x@test.local' })).status).toBe(401);
    expect((await anon.get('/api/invites')).status).toBe(401);
    expect(
      (await anon.del('/api/invites/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(401);
  });

  it('mints a row an exchange can claim, and stores no readable token', async () => {
    /*
     * The round trip this used to make — mint a link, redeem its token at
     * `POST /api/auth/accept-invite` — has no second half any more; redemption
     * belongs to `POST /api/auth/clerk/exchange` and is covered there against
     * the real route (`clerk.test.ts`, 'provisioning from an invite').
     *
     * What is still THIS route's to prove is what it writes: an open row for
     * the normalised address, and a `token_hash` that is a hash. The column is
     * vestigial — nothing reads it now — and it is asserted on anyway, because
     * a future change that starts putting a raw token in it would be silent.
     */
    const owner = await loggedIn(ctx.users.owner, '192.0.2.23');
    const res = await owner.post('/api/invites', { email: 'roundtrip@test.local' });
    expect(res.status).toBe(201);

    const stored = await ctx.db.execute(sql`
      SELECT token_hash, accepted_at, expires_at FROM invites
       WHERE email = 'roundtrip@test.local'`);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].accepted_at).toBeNull();
    expect(Number(stored.rows[0].expires_at)).toBeGreaterThan(Date.now());
    // A hash, not a secret: fixed width and nothing a person could type.
    expect(String(stored.rows[0].token_hash)).toMatch(/^[0-9a-f]{32,}$/);
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
    expect(body.invite.url).toBe(`${TEST_ORIGIN}${INVITE_PATH}`);

    /*
     * And the row is open, which is the half that matters for hand delivery:
     * the owner passes on the URL by any means they like, and the invitee's
     * first Clerk sign-in claims this row. Whether the claim works is proved
     * against the real exchange in `clerk.test.ts`.
     */
    const row = await ctx.db.execute(sql`
      SELECT accepted_at FROM invites WHERE email = 'nomail@test.local'`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].accepted_at).toBeNull();
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
