/**
 * The seniority rules (migration 0680), through the real app:
 *
 *   - exactly one owner, never mintable, never demotable;
 *   - the owner manages everyone but themselves;
 *   - a developer is owner-grade about WORK and powerless about PEERS —
 *     cannot disable, re-role, or mint the owner or another developer.
 *
 * Every rule is asserted from BOTH sides (the refusal for the junior actor,
 * the success for the senior one), because a guard that fails closed for
 * everybody would pass half of these on its own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../test/harness';
import type { TestCtx } from '../test/harness';
import { httpClient, json } from '../test/http';
import type { HttpClient } from '../test/http';
import type { AuthUser } from '../../shared/types';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`DELETE FROM invites`);
  /* Undo whatever a previous test disabled or re-roled — the seeds are shared
   * across the file. */
  await ctx.db.execute(sql`UPDATE users SET disabled_at = NULL`);
  await ctx.db.execute(
    sql`UPDATE users SET role = 'support' WHERE email = ${ctx.users.support.email}`,
  );
  await ctx.db.execute(
    sql`UPDATE users SET role = 'developer' WHERE email = ${ctx.users.developer.email}`,
  );
});

async function login(user: AuthUser): Promise<HttpClient> {
  const c = httpClient(ctx.db);
  await c.signIn(user);
  return c;
}

interface Refusal {
  error: string;
  operation: string;
}

describe('disable and enable', () => {
  it('a developer cannot disable the owner or a fellow developer, and the owner can', async () => {
    const dev = await login(ctx.users.developer);

    const onOwner = await dev.post(`/api/users/${ctx.users.owner.id}/disable`);
    expect(onOwner.status).toBe(409);
    expect((await json<Refusal>(onOwner)).operation).toBe('manage_peer');

    /* A second developer to aim at. */
    await ctx.db.execute(
      sql`UPDATE users SET role = 'developer' WHERE email = ${ctx.users.support.email}`,
    );
    const onPeer = await dev.post(`/api/users/${ctx.users.support.id}/disable`);
    expect(onPeer.status).toBe(409);
    expect((await json<Refusal>(onPeer)).operation).toBe('manage_peer');

    const owner = await login(ctx.users.owner);
    const res = await owner.post(`/api/users/${ctx.users.support.id}/disable`);
    expect(res.status).toBe(200);
  });

  it('a developer manages the lower roles: disable, then enable', async () => {
    const dev = await login(ctx.users.developer);
    expect((await dev.post(`/api/users/${ctx.users.writer.id}/disable`)).status).toBe(200);
    expect((await dev.post(`/api/users/${ctx.users.writer.id}/enable`)).status).toBe(200);
  });

  it('a developer cannot re-enable a developer the owner revoked', async () => {
    await ctx.db.execute(
      sql`UPDATE users SET role = 'developer' WHERE email = ${ctx.users.support.email}`,
    );
    const owner = await login(ctx.users.owner);
    expect((await owner.post(`/api/users/${ctx.users.support.id}/disable`)).status).toBe(200);

    const dev = await login(ctx.users.developer);
    const res = await dev.post(`/api/users/${ctx.users.support.id}/enable`);
    expect(res.status).toBe(409);
    expect((await json<Refusal>(res)).operation).toBe('manage_peer');
  });

  it('the self and last-owner refusals survive the widening', async () => {
    const owner = await login(ctx.users.owner);
    const self = await owner.post(`/api/users/${ctx.users.owner.id}/disable`);
    expect(self.status).toBe(409);
    expect((await json<Refusal>(self)).operation).toBe('disable_last_owner');
  });

  it('team routes are closed to every other role', async () => {
    const c = await login(ctx.users.marketing);
    expect((await c.get('/api/users')).status).toBe(403);
    expect((await c.post(`/api/users/${ctx.users.writer.id}/disable`)).status).toBe(403);
  });
});

describe('role changes', () => {
  it('the owner may re-role anyone below them, to anything assignable', async () => {
    const owner = await login(ctx.users.owner);
    const res = await owner.patch(`/api/users/${ctx.users.support.id}/role`, {
      role: 'developer',
    });
    expect(res.status).toBe(200);
    const body = await json<{ user: { role: string } }>(res);
    expect(body.user.role).toBe('developer');
  });

  it('nobody writes owner, in either direction', async () => {
    const owner = await login(ctx.users.owner);
    /* Granting it: not even a legal body. */
    expect(
      (await owner.patch(`/api/users/${ctx.users.writer.id}/role`, { role: 'owner' })).status,
    ).toBe(400);
    /* Demoting it: a legal body aimed at the owner row. */
    const demote = await owner.patch(`/api/users/${ctx.users.owner.id}/role`, {
      role: 'developer',
    });
    expect(demote.status).toBe(409);
    expect((await json<Refusal>(demote)).operation).toBe('role_self');
  });

  it('a developer re-roles the lower roles but cannot mint or touch developers', async () => {
    const dev = await login(ctx.users.developer);
    expect(
      (await dev.patch(`/api/users/${ctx.users.support.id}/role`, { role: 'marketing' }))
        .status,
    ).toBe(200);
    /* Minting a peer. */
    const mint = await dev.patch(`/api/users/${ctx.users.writer.id}/role`, {
      role: 'developer',
    });
    expect(mint.status).toBe(409);
    expect((await json<Refusal>(mint)).operation).toBe('manage_peer');
  });
});

describe('invites', () => {
  it('nobody invites an owner — the body itself is refused', async () => {
    const owner = await login(ctx.users.owner);
    expect(
      (await owner.post('/api/invites', { email: 'second-owner@test.local', role: 'owner' }))
        .status,
    ).toBe(400);
  });

  it('the owner invites developers; a developer cannot', async () => {
    const owner = await login(ctx.users.owner);
    const minted = await owner.post('/api/invites', {
      email: 'new-dev@test.local',
      role: 'developer',
    });
    expect(minted.status).toBe(201);

    const dev = await login(ctx.users.developer);
    expect(
      (await dev.post('/api/invites', { email: 'peer@test.local', role: 'developer' })).status,
    ).toBe(403);
    /* But the four lower roles are theirs to mint. */
    expect(
      (await dev.post('/api/invites', { email: 'analyst@test.local', role: 'support' })).status,
    ).toBe(201);
  });
});
