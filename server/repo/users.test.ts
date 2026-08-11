import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb, migratedDb } from '../test/harness';
import { verifyPassword } from './password';
import { sessions } from '../db/schema';
import type { Db } from '../db/client';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_TTL_MS,
  UserInputError,
  acceptInvite,
  createInvite,
  createSession,
  createUser,
  destroySession,
  disableUser,
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
    password: 'pw-owner-strong',
    displayName: 'Owner',
    role: 'owner',
  });
}

async function sessionRow(userId: string) {
  const res = await db.execute(sql`
    SELECT id, created_at, expires_at, last_seen_at
      FROM sessions WHERE user_id = ${userId}`);
  return {
    id: String(res.rows[0].id),
    createdAt: Number(res.rows[0].created_at),
    expiresAt: Number(res.rows[0].expires_at),
    lastSeenAt: Number(res.rows[0].last_seen_at),
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

  it('writes last_seen_at on every resolve, not only when the window slides', async () => {
    const user = await owner();
    const { token } = await createSession(db, user.id);
    const before = await sessionRow(user.id);

    // Backdate ONLY last_seen_at. `expires_at` stays fresh, so the session is
    // nowhere near the halfway point and the sliding-refresh branch cannot
    // fire. Written inside that branch — as it used to be — last_seen_at moves
    // at most once per ~15 days, so a session-management UI reports a
    // fortnight-old "last used" for a session in use this minute, and the one
    // question that column exists to answer is answered wrongly.
    const stale = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await db.execute(sql`
      UPDATE sessions SET last_seen_at = ${stale} WHERE user_id = ${user.id}`);

    expect(await resolveSession(db, token)).not.toBeNull();

    const after = await sessionRow(user.id);
    expect(after.lastSeenAt).toBeGreaterThan(stale);
    // Proof the refresh branch really did not run: expiry did not move.
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it('stores the session id keyed by SESSION_SECRET, not as a bare digest', async () => {
    // A bare SHA-256 is offline-computable, so a stolen database dump can be
    // attacked with a precomputed table of candidate tokens and the winning row
    // replayed as a live session. Keying it with a secret that lives in the
    // environment rather than the database makes the dump inert on its own —
    // and gives SESSION_SECRET, which `server/env.ts` requires, a consumer.
    const secret = process.env.SESSION_SECRET;
    expect(secret).toBeTruthy();

    const user = await owner();
    const { token } = await createSession(db, user.id);
    const stored = (await sessionRow(user.id)).id;

    expect(stored).not.toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored).toBe(createHmac('sha256', secret!).update(token).digest('hex'));

    // Invite tokens go through the same function, so they are keyed too.
    const { token: inviteToken } = await createInvite(db, {
      email: email(),
      role: 'writer',
      invitedBy: user.id,
    });
    const inviteRow = await db.execute(sql`
      SELECT token_hash FROM invites WHERE invited_by = ${user.id}`);
    const storedInvite = String(inviteRow.rows[0].token_hash);
    expect(storedInvite).not.toBe(
      createHash('sha256').update(inviteToken).digest('hex'),
    );
    expect(storedInvite).toBe(
      createHmac('sha256', secret!).update(inviteToken).digest('hex'),
    );
  });

  it('disabling a user destroys their sessions, so reinstating cannot resurrect one', async () => {
    const user = await owner();
    const { token } = await createSession(db, user.id);
    expect(await resolveSession(db, token)).not.toBeNull();

    expect(await disableUser(db, user.id)).toBe(1);
    expect(await resolveSession(db, token)).toBeNull();

    // Gone, not merely shadowed by `disabled_at`. Marking alone is not
    // revocation: the rows survive, so the day someone clears `disabled_at` to
    // reinstate a writer, every session ever issued to them comes back — including
    // the one on the laptop that prompted the revocation.
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user.id}`);
    expect(rows.rows[0].n).toBe(0);

    await db.execute(sql`UPDATE users SET disabled_at = NULL WHERE id = ${user.id}`);
    expect(await resolveSession(db, token)).toBeNull();

    // Idempotent, and it keeps the original disable time.
    const first = await db.execute(sql`
      UPDATE users SET disabled_at = 123 WHERE id = ${user.id} RETURNING disabled_at`);
    expect(Number(first.rows[0].disabled_at)).toBe(123);
    expect(await disableUser(db, user.id)).toBe(0);
    const still = await db.execute(sql`
      SELECT disabled_at FROM users WHERE id = ${user.id}`);
    expect(Number(still.rows[0].disabled_at)).toBe(123);
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
      acceptInvite(db, { token, password: 'second-attempt-x', displayName: 'Impostor' }),
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
      acceptInvite(db, { token, password: 'too-late-here', displayName: 'Late' }),
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
      password: 'mallory-password',
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

describe('credential policy', () => {
  async function inviteFor(inviterId: string) {
    const invitee = email();
    const { token } = await createInvite(db, {
      email: invitee,
      role: 'writer',
      invitedBy: inviterId,
    });
    return { invitee, token };
  }

  it('refuses an empty or too-short password and leaves the invite spendable', async () => {
    const inviter = await owner();
    const { invitee, token } = await inviteFor(inviter.id);

    // Before this policy, an empty password was ACCEPTED — scrypt hashes ''
    // quite happily — and then `verifyPassword('', stored)` returned true, so
    // the account was open to anyone who knew the address.
    await expect(
      acceptInvite(db, { token, password: '', displayName: 'Empty' }),
    ).rejects.toBeInstanceOf(UserInputError);
    await expect(
      acceptInvite(db, { token, password: 'nine-char', displayName: 'Short' }),
    ).rejects.toThrow(/at least 10/);

    // Nothing was created, and the invite was not burned on the way out.
    expect(await findUserByEmail(db, invitee)).toBeNull();
    const user = await acceptInvite(db, {
      token,
      password: 'a-long-enough-one',
      displayName: 'Real',
    });
    expect(user.email).toBe(invitee);
  });

  it('refuses a display name that is blank or only whitespace', async () => {
    const inviter = await owner();
    const { invitee, token } = await inviteFor(inviter.id);

    const err = await acceptInvite(db, {
      token,
      password: 'a-long-enough-one',
      displayName: '   ',
    }).then(
      () => {
        throw new Error('expected a blank display name to be refused');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserInputError);
    expect((err as UserInputError).field).toBe('displayName');
    expect(await findUserByEmail(db, invitee)).toBeNull();
  });

  it('applies to createUser too, and trims the stored display name', async () => {
    await expect(
      createUser(db, {
        email: email(),
        password: 'short',
        displayName: 'Anyone',
        role: 'writer',
      }),
    ).rejects.toBeInstanceOf(UserInputError);

    const user = await createUser(db, {
      email: email(),
      password: 'a-long-enough-one',
      displayName: '  Padded Name  ',
      role: 'writer',
    });
    expect(user.displayName).toBe('Padded Name');
  });
});

describe('users', () => {
  it('findUserByEmail is case-insensitive and returns the hash separately', async () => {
    const address = email();
    const created = await createUser(db, {
      email: address.toUpperCase(),
      password: 'pw-lookup-long',
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
