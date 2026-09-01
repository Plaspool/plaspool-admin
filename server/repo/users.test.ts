import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { freshDb, migratedDb } from '../test/harness';
import { sessions } from '../db/schema';
import type { Db } from '../db/client';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_TTL_MS,
  DuplicateEmailError,
  UserInputError,
  claimInviteForEmail,
  countActiveOwners,
  createInvite,
  createSession,
  createUser,
  destroySession,
  disableUser,
  enableUser,
  findUserByEmail,
  findUserById,
  listInvites,
  listSessions,
  listUsers,
  resolveSession,
  revokeSession,
  updateDisplayName,
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

  it('the sliding window is 30 days and the absolute cap is three of them', async () => {
    // Spec §6 fixes the number. Unpinned, `SESSION_TTL_MS` could be cut to a
    // day — logging every writer out daily — with the whole suite still green,
    // because every other test here uses the constant rather than a literal.
    expect(SESSION_TTL_MS / (24 * 60 * 60 * 1000)).toBe(30);
    expect(SESSION_ABSOLUTE_MAX_MS).toBe(3 * SESSION_TTL_MS);

    // And it is the number `createSession` actually writes, not just a constant
    // sitting next to the code that ignores it.
    // Bracketed by two clock reads rather than compared to one: `createSession`
    // takes its own `Date.now()`, so `expiresAt - before` is the TTL plus
    // however long the insert took, and asserting `<= SESSION_TTL_MS` against a
    // single reading fails whenever that is more than 0 ms.
    const user = await owner();
    const before = Date.now();
    const { expiresAt } = await createSession(db, user.id);
    const after = Date.now();
    expect(expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + SESSION_TTL_MS);
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

/**
 * CLAIMING AN INVITE, at the repo level.
 *
 * Every case here drove `acceptInvite` — a token plus a chosen password —
 * until Clerk became the only auth (2026-09-01). `claimInviteForEmail`
 * replaced it: the Clerk exchange has already proved control of the ADDRESS by
 * the time this runs, so the invite is claimed by address and there is no
 * password to choose. The properties are the ones that survived that move, and
 * they are worth repeating below the route (`server/routes/clerk.test.ts`
 * covers the same ground through HTTP) because the compensation path in
 * particular is invisible from there.
 *
 * `null` REPLACED A THROW, and that is the shape change to watch for: a
 * refusal is now a return value the exchange turns into its own 403, not an
 * `InviteError` for the error mapper.
 */
describe('invites', () => {
  it('an invite can be claimed exactly once', async () => {
    const inviter = await owner();
    const invitee = email();
    await createInvite(db, { email: invitee, role: 'writer', invitedBy: inviter.id });

    const user = await claimInviteForEmail(db, { email: invitee, displayName: 'Invitee' });
    expect(user?.email).toBe(invitee);
    expect(await findUserByEmail(db, invitee)).not.toBeNull();

    // Spent. A second claim finds no open row and answers null.
    expect(await claimInviteForEmail(db, { email: invitee, displayName: 'Impostor' })).toBeNull();
  });

  it('an expired invite is refused', async () => {
    const inviter = await owner();
    const invitee = email();
    const { id } = await createInvite(db, {
      email: invitee,
      role: 'writer',
      invitedBy: inviter.id,
    });
    await db.execute(sql`
      UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${id}`);

    expect(await claimInviteForEmail(db, { email: invitee, displayName: 'Late' })).toBeNull();
    // Nothing was created on the way to the refusal.
    expect(await findUserByEmail(db, invitee)).toBeNull();
  });

  it('claims exactly ONE invite when the address holds two', async () => {
    /*
     * The reason the claim is a CTE and not a bare UPDATE keyed on the email.
     * Two open invites for one address is ordinary — an owner re-invites
     * somebody who never got round to it — and a statement without the
     * `LIMIT 1` subquery would spend both to create one account, silently
     * destroying the second role's invitation.
     */
    const inviter = await owner();
    const invitee = email();
    await createInvite(db, { email: invitee, role: 'writer', invitedBy: inviter.id });
    await createInvite(db, { email: invitee, role: 'support', invitedBy: inviter.id });

    const user = await claimInviteForEmail(db, { email: invitee, displayName: 'Two Invites' });
    expect(user).not.toBeNull();

    const open = await db.execute(sql`
      SELECT count(*)::int AS n FROM invites
       WHERE email = ${invitee} AND accepted_at IS NULL`);
    expect(Number(open.rows[0].n)).toBe(1);
  });

  /**
   * The compensation path. `claimInviteForEmail` claims the invite with a
   * conditional UPDATE and only then creates the user, so a `createUser`
   * failure leaves a claimed invite behind an account that does not exist.
   * Deleting the `UPDATE invites SET accepted_at = NULL` that hands it back
   * left the whole suite green, while any transient failure — a duplicate
   * email, a dropped connection, a disk error — burned the invite permanently
   * and the only remedy was for the owner to issue a new one.
   */
  it('hands the invite back when creating the user fails', async () => {
    const inviter = await owner();
    const taken = email();
    await createUser(db, { email: taken, displayName: 'Incumbent', role: 'writer' });

    const { id } = await createInvite(db, {
      email: taken,
      role: 'writer',
      invitedBy: inviter.id,
    });

    await expect(
      claimInviteForEmail(db, { email: taken, displayName: 'Second' }),
    ).rejects.toBeInstanceOf(DuplicateEmailError);

    // Claimed by the UPDATE on the way in, so it must have been released on the
    // way out.
    const row = await db.execute(sql`SELECT accepted_at FROM invites WHERE id = ${id}`);
    expect(row.rows[0].accepted_at).toBeNull();

    // Not merely NULL in the column — still spendable, which is the point.
    await db.execute(sql`DELETE FROM users WHERE email = ${taken}`);
    const user = await claimInviteForEmail(db, { email: taken, displayName: 'Second' });
    expect(user?.email).toBe(taken);
  });

  it('the invite decides the role, and the caller cannot smuggle one in', async () => {
    const inviter = await owner();
    const invitee = email();
    await createInvite(db, { email: invitee, role: 'support', invitedBy: inviter.id });

    const user = await claimInviteForEmail(db, {
      email: invitee,
      displayName: 'Mallory',
      // Smuggled in. The invite is the authority for both of these.
      role: 'owner',
    } as never);

    expect(user?.email).toBe(invitee);
    expect(user?.role).toBe('support');
    expect(user?.displayName).toBe('Mallory');
  });

  it('an owner-role invite row is refused, and stays claimed', async () => {
    /*
     * The column still admits 'owner' (migration 0680 keeps history legal) and
     * the pre-0680 route could mint one. The row is deliberately NOT handed
     * back: an invitation that can never be honoured should not be retryable.
     */
    const inviter = await owner();
    const invitee = email();
    const { id } = await createInvite(db, {
      email: invitee,
      role: 'owner' as never,
      invitedBy: inviter.id,
    });

    expect(await claimInviteForEmail(db, { email: invitee, displayName: 'Usurper' })).toBeNull();
    expect(await findUserByEmail(db, invitee)).toBeNull();

    const row = await db.execute(sql`SELECT accepted_at FROM invites WHERE id = ${id}`);
    expect(row.rows[0].accepted_at).not.toBeNull();
  });

  it('falls back to the local part when no display name is offered', async () => {
    /*
     * `createUser` refuses a blank display name, and a Google account with no
     * profile name is ordinary — so the fallback lives in the repo function
     * rather than at the one call site that could forget it.
     */
    const inviter = await owner();
    const invitee = `no-name.${Date.now().toString(36)}@test.local`;
    await createInvite(db, { email: invitee, role: 'writer', invitedBy: inviter.id });

    const user = await claimInviteForEmail(db, { email: invitee, displayName: '  ' });
    expect(user?.displayName).toBe(invitee.split('@')[0]);
  });
});

describe('users', () => {
  it('findUserByEmail is case-insensitive, and hands back no hash', async () => {
    const address = email();
    const created = await createUser(db, {
      email: address.toUpperCase(),
      displayName: 'Mixed Case',
      role: 'writer',
    });
    // Stored lowercased, so an address typed in any case still finds the row.
    expect(created.email).toBe(address.toLowerCase());

    const found = await findUserByEmail(db, address.toUpperCase());
    expect(found?.user.id).toBe(created.id);
    expect(found?.disabledAt).toBeNull();
    /*
     * IT USED TO RETURN `passwordHash` and this case asserted the shape of it.
     * The login route was the only reader; with Clerk the only auth, a lookup
     * that hands a password hash to every caller that wanted an id is a leak
     * looking for somewhere to happen. Asserted as ABSENT rather than simply
     * unmentioned, because re-adding the column to the SELECT is a one-line
     * change that nothing else would notice.
     */
    expect(found).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(found)).not.toContain('scrypt');

    expect(await findUserByEmail(db, `nobody.${address}`)).toBeNull();
  });

  it('findUserById returns the same two parts findUserByEmail does', async () => {
    const user = await owner();
    const found = await findUserById(db, user.id);
    expect(found?.user).toEqual(user);
    expect(found?.disabledAt).toBeNull();
    expect(found).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(found)).not.toContain('scrypt');

    expect(await findUserById(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('freshDb seeds an owner and a writer', async () => {
    // Every task from 5 onward reads `ctx.users.owner.id`. If the seed
    // regresses, this is where it shows up rather than three layers down in a
    // repo suite.
    const ctx = await freshDb();
    try {
      expect(ctx.users.owner.role).toBe('owner');
      expect(ctx.users.writer.role).toBe('writer');
      expect(ctx.users.owner.id).not.toBe(ctx.users.writer.id);

      /*
       * The seed's password used to be asserted here by verifying it. Nothing
       * verifies passwords any more — `http.signIn()` mints a session directly
       * and the Clerk exchange is the only route that authenticates — so what
       * is worth pinning is that the rows exist and are addressable.
       */
      expect(await findUserByEmail(ctx.db, 'owner@test.local')).not.toBeNull();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------- the account

describe('display name', () => {
  it('updates, trims, and refuses a blank one', async () => {
    const user = await createUser(db, {
      email: email(),
      displayName: 'Original',
      role: 'writer',
    });

    const renamed = await updateDisplayName(db, user.id, '  Renamed  ');
    // Trimmed exactly as `createUser` trims it, so a name set here and a name
    // set at accept-invite cannot differ by a space.
    expect(renamed).toEqual({ ...user, displayName: 'Renamed' });
    expect((await findUserById(db, user.id))?.user.displayName).toBe('Renamed');

    // `UserInputError`, not a stored row of three spaces — Zod's `.min(1)` at
    // the route accepts whitespace, so this is the check that refuses it.
    const err = await updateDisplayName(db, user.id, '   ').then(
      () => {
        throw new Error('expected a blank display name to be refused');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UserInputError);
    expect((err as UserInputError).field).toBe('displayName');
    expect((await findUserById(db, user.id))?.user.displayName).toBe('Renamed');
  });

  it('returns null for an id that names nobody', async () => {
    expect(
      await updateDisplayName(db, '00000000-0000-4000-8000-000000000000', 'Ghost'),
    ).toBeNull();
  });
});

describe('the sessions list', () => {
  it('lists a user\'s own live sessions, newest use first, and marks the current one', async () => {
    const user = await createUser(db, {
      email: email(),
      displayName: 'Lister',
      role: 'writer',
    });
    const laptop = await createSession(db, user.id, 'Studio (laptop)');
    const phone = await createSession(db, user.id, 'Studio (phone)');
    // A different account's session, which must not appear.
    const stranger = await owner();
    await createSession(db, stranger.id, 'Studio (stranger)');

    // Ordered by last use: backdate the laptop so the order is asserted rather
    // than inherited from insertion.
    await db.execute(sql`
      UPDATE sessions SET last_seen_at = ${Date.now() - 60_000}
       WHERE user_agent = 'Studio (laptop)'`);

    const items = await listSessions(db, user.id, phone.token);
    expect(items.map((s) => s.userAgent)).toEqual(['Studio (phone)', 'Studio (laptop)']);
    expect(items.map((s) => s.current)).toEqual([true, false]);
    expect(items[0].expiresAt).toBe(phone.expiresAt);
    expect(items[1].expiresAt).toBe(laptop.expiresAt);
    // Numbers, not the strings a bigint arrives as under the Neon-like parser.
    for (const s of items) {
      expect(typeof s.lastSeenAt).toBe('number');
      expect(typeof s.createdAt).toBe('number');
    }
  });

  it('omits an expired session rather than offering it for revocation', async () => {
    // `resolveSession` deletes one the next time it is presented, so an expired
    // row is a session that has already ended. Listing it would invite somebody
    // to revoke something that is not there, and the revoke would 404.
    const user = await createUser(db, {
      email: email(),
      displayName: 'Expiring',
      role: 'writer',
    });
    const live = await createSession(db, user.id, 'live');
    const dead = await createSession(db, user.id, 'dead');
    await db.execute(sql`
      UPDATE sessions SET expires_at = ${Date.now() - 1} WHERE user_agent = 'dead'`);

    const items = await listSessions(db, user.id, live.token);
    expect(items).toHaveLength(1);
    expect(items[0].userAgent).toBe('live');
    expect(dead.token).not.toBe(live.token);
  });

  it('a session with no user agent is listed with null rather than skipped', async () => {
    const user = await createUser(db, {
      email: email(),
      displayName: 'Headless',
      role: 'writer',
    });
    await createSession(db, user.id);
    const items = await listSessions(db, user.id);
    expect(items).toHaveLength(1);
    expect(items[0].userAgent).toBeNull();
    // Nothing was named as current, so nothing claims to be.
    expect(items[0].current).toBe(false);
  });

  it('revokeSession is scoped by user, so a foreign id changes nothing', async () => {
    /*
     * `user_id` IS IN THE WHERE CLAUSE, not in a prior read. Scoping by a
     * SELECT first would leave a route free to forget the comparison, and the
     * failure mode of forgetting it is one writer signing another writer out.
     */
    const mine = await createUser(db, {
      email: email(),
      displayName: 'Mine',
      role: 'writer',
    });
    const theirs = await owner();
    const myToken = await createSession(db, mine.id, 'mine');
    await createSession(db, theirs.id, 'theirs');

    const foreign = (await listSessions(db, theirs.id))[0];
    expect(await revokeSession(db, mine.id, foreign.id)).toBe(false);
    expect((await listSessions(db, theirs.id))).toHaveLength(1);

    const own = (await listSessions(db, mine.id, myToken.token))[0];
    expect(await revokeSession(db, mine.id, own.id)).toBe(true);
    expect(await resolveSession(db, myToken.token)).toBeNull();
    // Twice is `false`, so the route answers 404 rather than pretending.
    expect(await revokeSession(db, mine.id, own.id)).toBe(false);
  });
});

// ------------------------------------------------------------------- team

describe('the team list', () => {
  it('lists accounts oldest first with their post counts, trashed included', async () => {
    const ctx = await freshDb();
    try {
      const now = Date.now();
      const post = async (authorId: string, id: string, deletedAt: number | null) =>
        ctx.db.execute(sql`
          INSERT INTO posts (id, title, subtitle, excerpt, excerpt_source, content,
                             content_text, category, status, created_at, updated_at,
                             deleted_at, word_count, reading_time, author_id, revision)
          VALUES (${id}, 'T', '', '', 'derived', ${'{"type":"doc","content":[]}'}::jsonb,
                  '', '', 'draft', ${now}, ${now}, ${deletedAt}, 0, 0, ${authorId}, 1)`);

      await post(ctx.users.writer.id, 'p_kept', null);
      await post(ctx.users.writer.id, 'p_binned', now);

      const items = await listUsers(ctx.db);
      expect(items.map((u) => u.email)).toEqual([
        'owner@test.local',
        'writer@test.local',
        'developer@test.local',
        'supply@test.local',
        'support@test.local',
        'marketing@test.local',
      ]);

      const writer = items.find((u) => u.id === ctx.users.writer.id)!;
      // A trashed post is restorable until somebody empties the trash, so it is
      // still theirs and still comes back — the count answers "what does
      // disabling this person leave behind".
      expect(writer.postCount).toBe(2);
      expect(writer.disabledAt).toBeNull();
      expect(typeof writer.createdAt).toBe('number');

      // A LEFT JOIN: the account with nothing written must still appear.
      expect(items.find((u) => u.id === ctx.users.owner.id)?.postCount).toBe(0);

      // No `SELECT *` on a table with a secret in it.
      expect(JSON.stringify(items)).not.toContain('scrypt');
    } finally {
      await ctx.close();
    }
  });

  it('reports disabledAt once an account is revoked', async () => {
    const user = await createUser(db, {
      email: email(),
      displayName: 'Revoked',
      role: 'writer',
    });
    await disableUser(db, user.id);
    const row = (await listUsers(db)).find((u) => u.id === user.id)!;
    expect(typeof row.disabledAt).toBe('number');
    expect(row.disabledAt).toBeGreaterThan(0);
  });
});

describe('enableUser and countActiveOwners', () => {
  it('enabling clears disabled_at and does not resurrect a session', async () => {
    /*
     * The reason `disableUser` DELETEs the sessions rather than relying on the
     * column: if the rows survived, clearing it would bring back every cookie
     * ever issued — including the one on the laptop that prompted the
     * revocation.
     */
    const user = await createUser(db, {
      email: email(),
      displayName: 'Reinstated',
      role: 'writer',
    });
    const { token } = await createSession(db, user.id);
    await disableUser(db, user.id);

    expect(await enableUser(db, user.id)).toBe(true);
    expect((await findUserById(db, user.id))?.disabledAt).toBeNull();
    expect(await resolveSession(db, token)).toBeNull();

    // A brand new session works, which is the whole of what enabling restores.
    const fresh = await createSession(db, user.id);
    expect(await resolveSession(db, fresh.token)).toMatchObject({ id: user.id });
  });

  it('enabling an id that names nobody is false', async () => {
    expect(await enableUser(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('counts only owners who can still sign in', async () => {
    const ctx = await freshDb();
    try {
      // The seed is one owner and one writer.
      expect(await countActiveOwners(ctx.db)).toBe(1);

      const second = await createUser(ctx.db, {
        email: 'second.owner@test.local',
        displayName: 'Second Owner',
        role: 'owner',
      });
      expect(await countActiveOwners(ctx.db)).toBe(2);

      // A revoked owner is not holding the door open — the check has to look at
      // `disabled_at` and not at `role` alone.
      await disableUser(ctx.db, second.id);
      expect(await countActiveOwners(ctx.db)).toBe(1);

      await enableUser(ctx.db, second.id);
      expect(await countActiveOwners(ctx.db)).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});

// ------------------------------------------------------- the invite history

describe('listInvites', () => {
  async function threeStates() {
    const inviter = await createUser(db, {
      email: email(),
      displayName: 'The Inviter',
      role: 'owner',
    });
    const open = await createInvite(db, { email: email(), role: 'writer', invitedBy: inviter.id });
    const accepted = await createInvite(db, {
      email: email(),
      role: 'writer',
      invitedBy: inviter.id,
    });
    await db.execute(
      sql`UPDATE invites SET accepted_at = ${Date.now()} WHERE id = ${accepted.id}`,
    );
    const expired = await createInvite(db, {
      email: email(),
      role: 'writer',
      invitedBy: inviter.id,
    });
    await db.execute(
      sql`UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${expired.id}`,
    );
    return { inviter, open, accepted, expired };
  }

  const idsFor = async (include: { accepted?: boolean; expired?: boolean }, inviterId: string) =>
    (await listInvites(db, include))
      .filter((i) => i.invitedBy === inviterId)
      .map((i) => i.id);

  it('returns open invites by default and each history bucket on request', async () => {
    const { inviter, open, accepted, expired } = await threeStates();

    expect(await idsFor({}, inviter.id)).toEqual([open.id]);
    expect((await idsFor({ accepted: true }, inviter.id)).sort()).toEqual(
      [open.id, accepted.id].sort(),
    );
    expect((await idsFor({ expired: true }, inviter.id)).sort()).toEqual(
      [open.id, expired.id].sort(),
    );
    expect((await idsFor({ accepted: true, expired: true }, inviter.id)).sort()).toEqual(
      [open.id, accepted.id, expired.id].sort(),
    );
  });

  it('labels the state and resolves the inviter, and accepted beats expired', async () => {
    const { inviter, open, accepted, expired } = await threeStates();
    // Spent AND past its seven days: history, not a missed opportunity.
    await db.execute(
      sql`UPDATE invites SET expires_at = ${Date.now() - 1} WHERE id = ${accepted.id}`,
    );

    const byId = new Map(
      (await listInvites(db, { accepted: true, expired: true })).map((i) => [i.id, i]),
    );
    expect(byId.get(open.id)?.state).toBe('open');
    expect(byId.get(accepted.id)?.state).toBe('accepted');
    expect(byId.get(expired.id)?.state).toBe('expired');

    expect(byId.get(open.id)?.invitedBy).toBe(inviter.id);
    expect(byId.get(open.id)?.invitedByName).toBe('The Inviter');
    expect(byId.get(open.id)?.acceptedAt).toBeNull();
    expect(byId.get(accepted.id)?.acceptedAt).toBeGreaterThan(0);
  });

  it('never returns a token hash', async () => {
    const { inviter } = await threeStates();
    const items = await listInvites(db, { accepted: true, expired: true });
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toContain('token');
    expect(items.some((i) => i.invitedBy === inviter.id)).toBe(true);
  });
});
