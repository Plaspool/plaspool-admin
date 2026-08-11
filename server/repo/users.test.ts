import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, migratedDb } from '../test/harness';
import { verifyPassword } from './password';
import { sessions } from '../db/schema';
import type { Db } from '../db/client';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_TTL_MS,
  acceptInvite,
  createInvite,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  resolveSession,
} from './users';

let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});

afterAll(async () => {
  await close?.();
});

let seq = 0;
const email = () => `u${++seq}.${Date.now().toString(36)}@test.local`;

async function owner() {
  return createUser(db, {
    email: email(),
    password: 'pw-owner',
    displayName: 'Owner',
    role: 'owner',
  });
}

async function sessionRow(userId: string) {
  const res = await db.execute(sql`
    SELECT created_at, expires_at FROM sessions WHERE user_id = ${userId}`);
  return {
    createdAt: Number(res.rows[0].created_at),
    expiresAt: Number(res.rows[0].expires_at),
  };
}

describe('sessions', () => {
  it('the sessions table never contains the raw token', async () => {
    const user = await owner();
    const { token } = await createSession(db, user.id);
    expect(token.length).toBeGreaterThan(20);
    const stored = JSON.stringify(await db.select().from(sessions));
    expect(stored).not.toContain(token);
    // The row exists — the token is absent because it is hashed, not because
    // nothing was written.
    expect(await resolveSession(db, token)).toMatchObject({ id: user.id });

    await destroySession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('resolveSession rejects an expired session', async () => {
    const user = await owner();
    const { token } = await createSession(db, user.id);
    await db.execute(sql`
      UPDATE sessions SET expires_at = ${Date.now() - 1} WHERE user_id = ${user.id}`);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('resolveSession rejects a session whose user is disabled', async () => {
    const user = await owner();
    const { token } = await createSession(db, user.id);
    expect(await resolveSession(db, token)).not.toBeNull();
    await db.execute(sql`
      UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${user.id}`);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it('resolveSession refreshes expiry past the halfway point but never beyond the absolute cap', async () => {
    const user = await owner();
    const { token, expiresAt } = await createSession(db, user.id);

    // Freshly issued: less than half elapsed, so nothing moves.
    await resolveSession(db, token);
    expect((await sessionRow(user.id)).expiresAt).toBe(expiresAt);

    // More than half the window elapsed: slide it forward.
    const now = Date.now();
    await db.execute(sql`
      UPDATE sessions SET created_at = ${now - SESSION_TTL_MS},
                          expires_at = ${now + 60_000}
       WHERE user_id = ${user.id}`);
    await resolveSession(db, token);
    const slid = await sessionRow(user.id);
    expect(slid.expiresAt).toBeGreaterThan(now + SESSION_TTL_MS - 60_000);

    // A session almost at the absolute cap slides only up to the cap, so a
    // stolen token cannot be kept alive forever by using it.
    const createdAt = now - (SESSION_ABSOLUTE_MAX_MS - 60_000);
    await db.execute(sql`
      UPDATE sessions SET created_at = ${createdAt}, expires_at = ${now + 60_000}
       WHERE user_id = ${user.id}`);
    await resolveSession(db, token);
    const capped = await sessionRow(user.id);
    expect(capped.expiresAt).toBeLessThanOrEqual(createdAt + SESSION_ABSOLUTE_MAX_MS);
    expect(capped.expiresAt).toBeLessThan(now + SESSION_TTL_MS);
    expect(capped.expiresAt).toBeGreaterThan(now);
  });
});

describe('invites', () => {
  it('an invite can be accepted exactly once', async () => {
    const inviter = await owner();
    const invitee = email();
    const { token } = await createInvite(db, {
      email: invitee,
      role: 'writer',
      invitedBy: inviter.id,
    });

    const user = await acceptInvite(db, {
      token,
      password: 'first-and-only',
      displayName: 'Invitee',
    });
    expect(user.email).toBe(invitee);
    expect(await findUserByEmail(db, invitee)).not.toBeNull();

    await expect(
      acceptInvite(db, { token, password: 'second', displayName: 'Impostor' }),
    ).rejects.toThrow(/invite/i);
  });

  it('an expired invite is refused', async () => {
    const inviter = await owner();
    const invitee = email();
    const { id, token } = await createInvite(db, {
      email: invitee,
      role: 'writer',
      invitedBy: inviter.id,
    });
    await db.execute(sql`
      UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${id}`);

    await expect(
      acceptInvite(db, { token, password: 'pw', displayName: 'Late' }),
    ).rejects.toThrow(/invite/i);
    // Nothing was created on the way to the rejection.
    expect(await findUserByEmail(db, invitee)).toBeNull();
  });

  it('an invitee cannot choose their own email or role', async () => {
    const inviter = await owner();
    const invitee = email();
    const { token } = await createInvite(db, {
      email: invitee,
      role: 'writer',
      invitedBy: inviter.id,
    });

    const user = await acceptInvite(db, {
      token,
      password: 'pw',
      displayName: 'Mallory',
      // Smuggled in. The invite is the authority for both of these.
      email: 'mallory@evil.test',
      role: 'owner',
    } as never);

    expect(user.email).toBe(invitee);
    expect(user.role).toBe('writer');
    expect(user.displayName).toBe('Mallory');
    expect(await findUserByEmail(db, 'mallory@evil.test')).toBeNull();
  });
});

describe('users', () => {
  it('findUserByEmail is case-insensitive and returns the hash separately', async () => {
    const address = email();
    const created = await createUser(db, {
      email: address.toUpperCase(),
      password: 'pw-lookup',
      displayName: 'Mixed Case',
      role: 'writer',
    });
    // Stored lowercased, so a login typed in any case still finds the row.
    expect(created.email).toBe(address.toLowerCase());

    const found = await findUserByEmail(db, address.toUpperCase());
    expect(found?.user.id).toBe(created.id);
    expect(found?.passwordHash).toMatch(/^scrypt\$/);
    // AuthUser is what crosses the boundary, and it carries no hash.
    expect(JSON.stringify(found?.user)).not.toContain('scrypt');

    expect(await findUserByEmail(db, `nobody.${address}`)).toBeNull();
  });

  it('freshDb seeds an owner and a writer whose seeded password verifies', async () => {
    // Every task from 5 onward reads `ctx.users.owner.id`. If the seed regresses,
    // this is where it shows up rather than three layers down in a repo suite.
    const ctx = await freshDb();
    try {
      expect(ctx.users.owner.role).toBe('owner');
      expect(ctx.users.writer.role).toBe('writer');
      expect(ctx.users.owner.id).not.toBe(ctx.users.writer.id);

      const found = await findUserByEmail(ctx.db, 'owner@test.local');
      expect(found).not.toBeNull();
      expect(await verifyPassword(SEED_PASSWORD, found!.passwordHash)).toBe(true);
      expect(await verifyPassword('wrong', found!.passwordHash)).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
