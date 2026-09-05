import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json } from '../test/http';
import type { HttpClient } from '../test/http';
import type { AuthUser } from '../../shared/types';

/**
 * Handing the store over, through the real app.
 *
 * DRIVEN THROUGH `createApp()` AND NOT A TEST ROUTER, because the thing most
 * likely to be wrong here is not the SQL — `repo/ownership.test.ts` pins that,
 * including the swap that once left zero owners — but the GUARDS, and a guard
 * is a property of how the route is mounted. Two of these routes are
 * deliberately not admin-only, which is exactly the sort of decision that is
 * invisible to a suite that builds its own app.
 *
 * The seniority rules this leans on live in `shared/roles.ts`: the owner may
 * give the store away, a developer may not, and the recipient accepts while
 * still holding whatever role they had.
 */

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ownership_transfers`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
  await ctx.db.execute(sql`UPDATE users SET role = 'owner' WHERE email = 'owner@test.local'`);
  await ctx.db.execute(sql`UPDATE users SET role = 'writer' WHERE email = 'writer@test.local'`);
  await ctx.db.execute(
    sql`UPDATE users SET role = 'developer' WHERE email = 'developer@test.local'`,
  );
});

const as = async (user: { id: string }): Promise<HttpClient> => {
  const c = httpClient(ctx.db);
  await c.signIn(user);
  return c;
};

const roleOf = async (email: string): Promise<string> => {
  const res = await ctx.db.execute(sql`SELECT role FROM users WHERE email = ${email}`);
  return String(res.rows[0].role);
};

const ownerCount = async (): Promise<number> => {
  const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'owner'`);
  return Number(res.rows[0].n);
};

const propose = async (c: HttpClient, toUserId: string) =>
  c.post('/api/ownership/transfer', { toUserId });

describe('proposing', () => {
  it('is the owner’s alone — a developer is forbidden, and a writer too', async () => {
    /*
     * `canManage` already says a developer may not demote the owner. Proposing
     * to move the owner's role is that same act under another verb, so the
     * route is `requireOwner()` and not `requireAdmin()`.
     */
    const dev = await as(ctx.users.developer);
    expect((await propose(dev, ctx.users.writer.id)).status).toBe(403);

    const writer = await as(ctx.users.writer);
    expect((await propose(writer, ctx.users.developer.id)).status).toBe(403);

    expect((await httpClient(ctx.db).post('/api/ownership/transfer', {
      toUserId: ctx.users.writer.id,
    })).status).toBe(401);

    expect(await ownerCount()).toBe(1);
  });

  it('creates a pending proposal and changes NOTHING yet', async () => {
    const owner = await as(ctx.users.owner);
    const res = await propose(owner, ctx.users.writer.id);
    expect(res.status).toBe(201);

    const body = await json<{ transfer: { to: { email: string }; expiresAt: number } }>(res);
    expect(body.transfer.to.email).toBe(ctx.users.writer.email);

    /* The owner asked for acceptance rather than a swap on click. A proposal
       that moved a role on its own would be the other feature. */
    expect(await roleOf(ctx.users.writer.email)).toBe('writer');
    expect(await roleOf(ctx.users.owner.email)).toBe('owner');
  });

  it('refuses a second one, and refuses a disabled recipient, by name', async () => {
    const owner = await as(ctx.users.owner);
    expect((await propose(owner, ctx.users.writer.id)).status).toBe(201);

    const second = await propose(owner, ctx.users.developer.id);
    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({
      error: 'precondition_failed',
      operation: 'already_pending',
    });

    await ctx.db.execute(sql`DELETE FROM ownership_transfers`);
    await ctx.db.execute(
      sql`UPDATE users SET disabled_at = ${Date.now()} WHERE email = ${ctx.users.writer.email}`,
    );
    const bad = await propose(owner, ctx.users.writer.id);
    expect(bad.status).toBe(409);
    expect(await json(bad)).toMatchObject({ operation: 'bad_recipient' });
  });
});

describe('reading it back', () => {
  it('is answered for the two parties and for admins, and null for anybody else', async () => {
    const owner = await as(ctx.users.owner);
    expect((await propose(owner, ctx.users.writer.id)).status).toBe(201);

    const seen = async (c: HttpClient) =>
      (await json<{ transfer: unknown }>(await c.get('/api/ownership/transfer'))).transfer;

    // The sender and the recipient, obviously.
    expect(await seen(owner)).not.toBeNull();
    expect(await seen(await as(ctx.users.writer))).not.toBeNull();
    // A developer: the team screen shows a pending transfer beside the roles.
    expect(await seen(await as(ctx.users.developer))).not.toBeNull();

    /*
     * AN UNINVOLVED WRITER GETS `null`, NOT A 403. They are entitled to ask —
     * the client asks on every load — and not entitled to the answer. A refusal
     * would also make the route a probe for "is the store changing hands".
     */
    expect(await seen(await as(ctx.users.support))).toBeNull();
  });
});

describe('accepting', () => {
  it('lets a WRITER become the owner, and demotes the outgoing one', async () => {
    /*
     * THE CASE THE SEPARATE ROUTER EXISTS FOR. The recipient holds `writer`
     * right up to the moment this succeeds, so an admin-only guard would make
     * the feature unusable by the only person who can use it.
     */
    const owner = await as(ctx.users.owner);
    expect((await propose(owner, ctx.users.writer.id)).status).toBe(201);

    const writer = await as(ctx.users.writer);
    const res = await writer.post('/api/ownership/transfer/accept');
    expect(res.status).toBe(200);
    expect((await json<{ user: AuthUser }>(res)).user).toMatchObject({
      id: ctx.users.writer.id,
      role: 'owner',
    });

    expect(await roleOf(ctx.users.writer.email)).toBe('owner');
    expect(await roleOf(ctx.users.owner.email)).toBe('developer');
    expect(await ownerCount()).toBe(1);

    /* And the new owner can immediately do owner-only work, which is the real
       proof the session is reading the new role rather than a cached one. */
    expect((await writer.post('/api/ownership/transfer', {
      toUserId: ctx.users.developer.id,
    })).status).toBe(201);
  });

  it('is a 404 for somebody it was not offered to, and for nobody at all', async () => {
    const owner = await as(ctx.users.owner);
    expect((await propose(owner, ctx.users.writer.id)).status).toBe(201);

    const dev = await as(ctx.users.developer);
    expect((await dev.post('/api/ownership/transfer/accept')).status).toBe(404);
    expect(await ownerCount()).toBe(1);
    expect(await roleOf(ctx.users.developer.email)).toBe('developer');

    await ctx.db.execute(sql`DELETE FROM ownership_transfers`);
    const writer = await as(ctx.users.writer);
    expect((await writer.post('/api/ownership/transfer/accept')).status).toBe(404);
  });
});

describe('withdrawing', () => {
  it('lets the sender cancel and the recipient decline, and refuses a bystander', async () => {
    const owner = await as(ctx.users.owner);
    expect((await propose(owner, ctx.users.writer.id)).status).toBe(201);

    // A bystander cannot make it go away.
    const dev = await as(ctx.users.developer);
    expect((await dev.post('/api/ownership/transfer/decline')).status).toBe(404);

    // The recipient declines.
    const writer = await as(ctx.users.writer);
    expect((await writer.post('/api/ownership/transfer/decline')).status).toBe(200);
    expect(
      (await json<{ transfer: unknown }>(await owner.get('/api/ownership/transfer'))).transfer,
    ).toBeNull();
    expect(await roleOf(ctx.users.writer.email)).toBe('writer');

    // And the slot is free again, so the owner can offer it elsewhere.
    expect((await propose(owner, ctx.users.developer.id)).status).toBe(201);
    expect((await owner.post('/api/ownership/transfer/decline')).status).toBe(200);
  });

  it('is refused without a session, like every other mutation', async () => {
    const anon = httpClient(ctx.db);
    expect((await anon.post('/api/ownership/transfer/accept')).status).toBe(401);
    expect((await anon.post('/api/ownership/transfer/decline')).status).toBe(401);
    expect((await anon.get('/api/ownership/transfer')).status).toBe(401);
  });
});
