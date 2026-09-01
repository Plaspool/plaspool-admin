/**
 * The team surface (HANDOFF §2 A2), driven end to end through the real app.
 *
 * `disableUser` in `server/repo/users.ts` has been correct and covered by its
 * own suite since it was written, and until this router it was called by
 * nothing outside that suite. So what is new — and what this file is mostly
 * about — is the two refusals wrapped around it, and the one property they
 * exist to hold: **an instance can never be left with no owner who can sign
 * in.** Everything under `/api/users` is owner-only, so the moment the last
 * active owner is revoked there is nobody who can undo it through the API at
 * all; the recovery is `scripts/bootstrap-owner.ts` against the production
 * database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { httpClient, json, type HttpClient } from '../test/http';
import type { AuthUser } from '../../shared/types';

let ctx: TestCtx;

interface UserItem {
  id: string;
  email: string;
  displayName: string;
  role: 'owner' | 'writer';
  createdAt: number;
  disabledAt: number | null;
  postCount: number;
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM posts`);
});

afterEach(async () => {
  // Extra accounts, and the revocations the cases leave behind. Without the
  // second statement, one disable case turns every later `loggedIn` into a 401
  // for reasons a reader would look for in the wrong file.
  await ctx.db.execute(
    sql`DELETE FROM users WHERE email NOT IN ('owner@test.local', 'writer@test.local')`,
  );
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
});

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

async function loggedIn(user: { email: string }, ip: string): Promise<HttpClient> {
  const c = client(ip);
  await c.signIn(user);
  return c;
}

/**
 * A second account, sharing the seeded password hash.
 *
 * Copied rather than derived: `createUser` hashes at the production scrypt cost
 * (~200 ms), the seeded rows are hashed at a deliberately cheap one, and a
 * suite that needs three or four extra owners would spend a second of every run
 * proving something `password.test.ts` already pins.
 */
async function makeUser(
  email: string,
  role: 'owner' | 'writer',
  displayName = 'Second',
): Promise<AuthUser> {
  const res = await ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    SELECT ${email}, u.password_hash, ${displayName}, ${role}, ${Date.now()}
      FROM users u WHERE u.id = ${ctx.users.owner.id}::uuid
    RETURNING id, email, display_name, role`);
  const row = res.rows[0];
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as 'owner' | 'writer',
  };
}

const listUsersVia = async (c: HttpClient): Promise<UserItem[]> => {
  const res = await c.get('/api/users');
  expect(res.status).toBe(200);
  return (await json<{ items: UserItem[] }>(res)).items;
};

// ---------------------------------------------------------------- the list

describe('GET /api/users', () => {
  it('is 401 anonymous and 403 for a writer', async () => {
    const anon = await client('203.0.113.120').get('/api/users');
    expect(anon.status).toBe(401);
    expect((await json(anon)).error).toBe('unauthenticated');

    const writer = await loggedIn(ctx.users.writer, '203.0.113.121');
    const refused = await writer.get('/api/users');
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toBe('forbidden');
  });

  it('lists every account with the fields the team screen needs', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.122');
    const items = await listUsersVia(owner);

    expect(items.map((u) => u.email)).toEqual(['owner@test.local', 'writer@test.local']);
    expect(items[0]).toMatchObject({
      id: ctx.users.owner.id,
      email: ctx.users.owner.email,
      displayName: ctx.users.owner.displayName,
      role: 'owner',
      disabledAt: null,
      postCount: 0,
    });
    // A bigint through the Neon-like parser: a string here would sort and
    // compare wrongly in every client that renders it as a date.
    expect(typeof items[0].createdAt).toBe('number');
    expect(items[0].createdAt).toBeGreaterThan(0);
  });

  it('never returns a password hash', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.123');
    const text = await (await owner.get('/api/users')).text();
    expect(text).not.toContain('scrypt$');
    expect(text).not.toContain('password');
  });

  it('counts posts per author, trashed ones included', async () => {
    /*
     * The count answers "what does disabling this person leave behind", and a
     * trashed post is restorable until somebody empties the trash — so it is
     * still theirs and still comes back. Omitting them would report zero for a
     * writer whose entire body of work is one `POST /api/trash/empty` from
     * being destroyed.
     */
    const writer = await loggedIn(ctx.users.writer, '203.0.113.124');
    const kept = await json<{ post: { id: string } }>(
      await writer.post('/api/posts', { title: 'Kept' }),
    );
    const binned = await json<{ post: { id: string } }>(
      await writer.post('/api/posts', { title: 'Binned' }),
    );
    expect((await writer.post(`/api/posts/${binned.post.id}/trash`)).status).toBe(200);

    const owner = await loggedIn(ctx.users.owner, '203.0.113.125');
    const items = await listUsersVia(owner);
    expect(items.find((u) => u.id === ctx.users.writer.id)?.postCount).toBe(2);
    expect(items.find((u) => u.id === ctx.users.owner.id)?.postCount).toBe(0);
    expect(kept.post.id).not.toBe(binned.post.id);
  });

  it('shows an account with no posts at all', async () => {
    // A LEFT JOIN and not an inner one: the account invited this morning is
    // exactly the row an owner has come to the screen to look at.
    const fresh = await makeUser('brand.new@test.local', 'writer', 'Brand New');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.126');
    const items = await listUsersVia(owner);
    expect(items.find((u) => u.id === fresh.id)).toMatchObject({ postCount: 0 });
  });

  it('reports disabledAt so the screen can grey the row out', async () => {
    const target = await makeUser('revoked@test.local', 'writer', 'Revoked');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.127');
    expect((await owner.post(`/api/users/${target.id}/disable`)).status).toBe(200);

    const items = await listUsersVia(owner);
    const row = items.find((u) => u.id === target.id)!;
    expect(typeof row.disabledAt).toBe('number');
    expect(row.disabledAt).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------- disabling

describe('POST /api/users/:id/disable', () => {
  it('is 401 anonymous and 403 for a writer', async () => {
    const id = ctx.users.writer.id;
    expect((await client('203.0.113.130').post(`/api/users/${id}/disable`)).status).toBe(401);

    const writer = await loggedIn(ctx.users.writer, '203.0.113.131');
    expect((await writer.post(`/api/users/${id}/disable`)).status).toBe(403);
  });

  it('revokes the account: sessions die and a fresh one is refused too', async () => {
    const target = await makeUser('goodbye@test.local', 'writer', 'Goodbye');
    const theirs = await loggedIn(target, '203.0.113.132');
    expect((await theirs.get('/api/auth/me')).status).toBe(200);

    const owner = await loggedIn(ctx.users.owner, '203.0.113.133');
    const res = await owner.post(`/api/users/${target.id}/disable`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, sessionsEnded: 1 });

    // The live cookie is refused, and the row is gone rather than shadowed —
    // that is what stops a later `enable` resurrecting it.
    expect((await theirs.get('/api/auth/me')).status).toBe(401);
    const rows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${target.id}::uuid`);
    expect(Number(rows.rows[0].n)).toBe(0);

    /*
     * AND A SESSION MINTED AFTERWARDS IS REFUSED TOO — the belt to the
     * sweep's braces, and the reason `resolveSession` consults `disabled_at`
     * rather than trusting that every session was deleted.
     *
     * This used to be "and login stops working", driven through
     * `POST /api/auth/login`. That route is gone; refusing a revoked account
     * AT SIGN-IN is now the Clerk exchange's job and is tested there
     * (`clerk.test.ts`: a disabled user gets `not_invited`). What is left to
     * prove here is the second line of defence, which is this one.
     */
    const revived = client('203.0.113.134');
    await revived.signIn({ email: target.email });
    expect((await revived.get('/api/auth/me')).status).toBe(401);
  });

  it('is idempotent and keeps the original disable time', async () => {
    const target = await makeUser('twice@test.local', 'writer', 'Twice');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.135');

    expect((await owner.post(`/api/users/${target.id}/disable`)).status).toBe(200);
    const first = await ctx.db.execute(sql`
      SELECT disabled_at FROM users WHERE id = ${target.id}::uuid`);

    const again = await owner.post(`/api/users/${target.id}/disable`);
    expect(again.status).toBe(200);
    // Nothing left to sweep, and a 409 for "already disabled" would make the
    // ordinary double-click an error when the state asked for is the state got.
    expect(await json(again)).toMatchObject({ ok: true, sessionsEnded: 0 });

    const second = await ctx.db.execute(sql`
      SELECT disabled_at FROM users WHERE id = ${target.id}::uuid`);
    expect(Number(second.rows[0].disabled_at)).toBe(Number(first.rows[0].disabled_at));
  });

  it('refuses to disable yourself, with a distinct operation', async () => {
    // A SECOND OWNER EXISTS, so this is not the last-owner case — that one is
    // checked first and would otherwise shadow this refusal entirely.
    await makeUser('co.owner@test.local', 'owner', 'Co Owner');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.136');

    const res = await owner.post(`/api/users/${ctx.users.owner.id}/disable`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'precondition_failed',
      operation: 'disable_self',
      userId: ctx.users.owner.id,
    });
    // The envelope, like every other error body in this app.
    expect(typeof (await json(await owner.post(`/api/users/${ctx.users.owner.id}/disable`)))
      .requestId).toBe('string');

    // Still signed in and still active.
    expect((await owner.get('/api/auth/me')).status).toBe(200);
    const row = await ctx.db.execute(sql`
      SELECT disabled_at FROM users WHERE id = ${ctx.users.owner.id}::uuid`);
    expect(row.rows[0].disabled_at).toBeNull();
  });

  it('refuses to disable the last active owner, with a different operation', async () => {
    /*
     * The seeded blog has exactly one owner, so this is the request that locks
     * the door from the inside: every route under `/api/users` is owner-only,
     * so nothing could undo it. Checked BEFORE the self check, which is why it
     * is this operation and not `disable_self` — see the route's comment.
     */
    const owner = await loggedIn(ctx.users.owner, '203.0.113.137');
    const res = await owner.post(`/api/users/${ctx.users.owner.id}/disable`);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'precondition_failed',
      operation: 'disable_last_owner',
      userId: ctx.users.owner.id,
    });

    expect((await owner.get('/api/auth/me')).status).toBe(200);
  });

  it('a disabled owner does not count towards keeping the door open', async () => {
    // Two owners, one already revoked: the survivor is still the last ACTIVE
    // one, so the refusal must look at `disabled_at` and not at `role` alone.
    const spare = await makeUser('spare.owner@test.local', 'owner', 'Spare');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.138');
    expect((await owner.post(`/api/users/${spare.id}/disable`)).status).toBe(200);

    const res = await owner.post(`/api/users/${ctx.users.owner.id}/disable`);
    expect(res.status).toBe(409);
    expect((await json(res)).operation).toBe('disable_last_owner');
  });

  it('one owner may disable another while two are active', async () => {
    const spare = await makeUser('other.owner@test.local', 'owner', 'Other');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.139');
    expect((await owner.post(`/api/users/${spare.id}/disable`)).status).toBe(200);

    // And the survivor is now unable to revoke themselves, which is the whole
    // invariant: an instance never reaches zero active owners.
    expect(
      (await json(await owner.post(`/api/users/${ctx.users.owner.id}/disable`))).operation,
    ).toBe('disable_last_owner');
  });

  it('a writer is not protected by the owner rule', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.140');
    const res = await owner.post(`/api/users/${ctx.users.writer.id}/disable`);
    expect(res.status).toBe(200);
  });

  it('an unknown id is a 404 and a malformed one is a 400', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.141');

    const missing = await owner.post('/api/users/00000000-0000-4000-8000-000000000000/disable');
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe('gone');

    // `users.id` is a uuid column, so a non-uuid reaches the driver as SQLSTATE
    // 22P02 — a 500 the client then retries five times for a request that can
    // never succeed.
    const malformed = await owner.post('/api/users/not-a-uuid/disable');
    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toMatchObject({ error: 'bad_request', detail: 'id' });
  });
});

// --------------------------------------------------------------- enabling

describe('POST /api/users/:id/enable', () => {
  it('is 401 anonymous and 403 for a writer', async () => {
    const id = ctx.users.writer.id;
    expect((await client('203.0.113.150').post(`/api/users/${id}/enable`)).status).toBe(401);
    const writer = await loggedIn(ctx.users.writer, '203.0.113.151');
    expect((await writer.post(`/api/users/${id}/enable`)).status).toBe(403);
  });

  it('reinstates the account without resurrecting a single session', async () => {
    /*
     * The reason `disableUser` DELETEs the sessions rather than relying on
     * `disabled_at`: if the rows survived, clearing the column would bring back
     * every cookie ever issued — including the one on the laptop that prompted
     * the revocation.
     */
    const target = await makeUser('welcome.back@test.local', 'writer', 'Back');
    const theirs = await loggedIn(target, '203.0.113.152');
    const owner = await loggedIn(ctx.users.owner, '203.0.113.153');

    expect((await owner.post(`/api/users/${target.id}/disable`)).status).toBe(200);
    const res = await owner.post(`/api/users/${target.id}/enable`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });

    // The old cookie is still dead...
    expect((await theirs.get('/api/auth/me')).status).toBe(401);
    // ...and a fresh login works, which is the whole of what enabling restores.
    const again = await loggedIn(target, '203.0.113.154');
    expect((await again.get('/api/auth/me')).status).toBe(200);

    const items = await listUsersVia(owner);
    expect(items.find((u) => u.id === target.id)?.disabledAt).toBeNull();
  });

  it('enabling an account that was never disabled is a 200', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.155');
    expect((await owner.post(`/api/users/${ctx.users.writer.id}/enable`)).status).toBe(200);
  });

  it('an unknown id is a 404 and a malformed one is a 400', async () => {
    const owner = await loggedIn(ctx.users.owner, '203.0.113.156');
    expect(
      (await owner.post('/api/users/00000000-0000-4000-8000-000000000000/enable')).status,
    ).toBe(404);
    const malformed = await owner.post('/api/users/not-a-uuid/enable');
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).detail).toBe('id');
  });
});
