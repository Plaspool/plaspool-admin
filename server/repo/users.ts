import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../db/client';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
import { getEnv } from '../env';
import { hashPassword } from './password';

export type Role = 'owner' | 'writer';

/** 30-day expiry, refreshed when more than half has elapsed (spec §6). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A hard ceiling measured from `created_at`, so a stolen token cannot be kept
 * alive forever simply by using it. The spec fixes the 30-day sliding window
 * but not this number; 90 days (three windows) is the choice made here.
 */
export const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/** Spec §3.3. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InviteError extends Error {
  constructor(message = 'invite is invalid, expired or already used') {
    super(message);
    this.name = 'InviteError';
  }
}

/**
 * A duplicate email surfaced as a domain error rather than a driver error.
 *
 * Without this, the ordinary "invite an address that already has an account"
 * path throws a `DrizzleQueryError` whose message and stack carry the account
 * email and the freshly derived password hash. `guardDb` scrubs that centrally;
 * translating here means the unique-violation path never produces a driver
 * error to scrub in the first place, and gives the route layer something it can
 * map onto a 409 without string-matching a SQLSTATE.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    // Deliberately no email in the message — this is the exact value the leak
    // was about.
    super('an account already exists for that email address');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * Ghost's bar is ten characters plus a common-password blocklist. The length
 * floor is here; the blocklist is not, and its absence is deliberate rather
 * than forgotten — it belongs with the auth routes that can report it usefully.
 *
 * Before this existed, `acceptInvite({ password: '' })` succeeded and the empty
 * password then verified `true`, because scrypt hashes an empty string quite
 * happily.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** A rejected `password` or `displayName`, carrying which one. */
export class UserInputError extends Error {
  readonly field: 'password' | 'displayName';
  constructor(field: 'password' | 'displayName', message: string) {
    super(message);
    this.name = 'UserInputError';
    this.field = field;
  }
}

/** 256 bits, URL-safe. Returned to the client once and never stored raw. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stored id of a session or invite token: HMAC-SHA-256 under
 * `SESSION_SECRET`, not a bare SHA-256.
 *
 * A bare digest is offline-computable, so a stolen database dump can be
 * attacked with a precomputed table of candidate tokens and the winning row
 * replayed as a live session. Keying the digest with a secret that lives in the
 * environment and not in the database means a dump on its own is inert. It also
 * gives `SESSION_SECRET` — required by `server/env.ts` — an actual consumer;
 * a required variable nothing reads erodes boot-time validation.
 *
 * Rotating `SESSION_SECRET` invalidates every outstanding session and invite,
 * which is the correct behaviour for a secret rotation.
 */
function tokenId(token: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update(token).digest('hex');
}

function rowToAuthUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as Role,
  };
}

// ------------------------------------------------------------------- users

/**
 * The one place a password or a display name is judged, so every route that
 * creates an account — accept-invite today, anything else later — is bound by
 * it without having to remember.
 */
export function assertCredentials(a: { password: string; displayName: string }): void {
  if (a.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserInputError(
      'password',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (a.displayName.trim() === '') {
    throw new UserInputError('displayName', 'display name must not be empty');
  }
}

export async function createUser(
  db: Db,
  a: { email: string; password: string; displayName: string; role: Role },
): Promise<AuthUser> {
  // Before hashing: a rejected password should not cost 200 ms of scrypt.
  assertCredentials(a);
  const passwordHash = await hashPassword(a.password);
  try {
    const res = await db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at)
      VALUES (${a.email.trim().toLowerCase()}, ${passwordHash}, ${a.displayName.trim()},
              ${a.role}, ${Date.now()})
      RETURNING id, email, display_name, role`);
    return rowToAuthUser(res.rows[0]);
  } catch (err) {
    if (uniqueViolation(err) === 'users_email_unique') throw new DuplicateEmailError();
    throw err;
  }
}

/**
 * The hash comes back beside the user rather than on it, so `AuthUser` — the
 * only user shape that crosses the boundary — can never carry a password hash
 * into a response.
 *
 * `disabledAt` comes back too, and the login route has to consult it.
 * `resolveSession` already refuses a disabled user's SESSION, but nothing
 * stopped a disabled user from creating a new one: login would succeed, set a
 * cookie, and every subsequent request would 401 — a revoked writer who appears
 * to log in and then cannot do anything, which reads as a broken app rather
 * than as a revocation.
 */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ user: AuthUser; passwordHash: string; disabledAt: number | null } | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, role, password_hash, disabled_at
      FROM users WHERE email = ${email.trim().toLowerCase()}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    user: rowToAuthUser(row),
    passwordHash: String(row.password_hash),
    disabledAt: toEpochMsOrNull(row.disabled_at),
  };
}

// ---------------------------------------------------------------- sessions

export async function createSession(
  db: Db,
  userId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = mintToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db.execute(sql`
    INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
    VALUES (${tokenId(token)}, ${userId}, ${now}, ${expiresAt}, ${now},
            ${userAgent ?? null})`);

  // Opportunistic sweep. Best-effort: a failure here must never cost the user
  // their login.
  await db
    .execute(sql`DELETE FROM sessions WHERE expires_at <= ${now}`)
    .catch(() => undefined);

  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string): Promise<AuthUser | null> {
  const id = tokenId(token);
  const res = await db.execute(sql`
    SELECT s.created_at, s.expires_at,
           u.id, u.email, u.display_name, u.role, u.disabled_at
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ${id}`);
  const row = res.rows[0];
  if (!row) return null;

  const now = Date.now();
  const expiresAt = toEpochMs(row.expires_at);
  if (expiresAt <= now) {
    await db.execute(sql`DELETE FROM sessions WHERE id = ${id}`).catch(() => undefined);
    return null;
  }
  // A revoked writer's outstanding sessions die with the revocation, not at
  // their own expiry.
  if (row.disabled_at != null) return null;

  const createdAt = toEpochMs(row.created_at);
  const halfway = expiresAt - SESSION_TTL_MS / 2;
  const slid =
    now > halfway
      ? Math.min(now + SESSION_TTL_MS, createdAt + SESSION_ABSOLUTE_MAX_MS)
      : expiresAt;

  /**
   * `last_seen_at` is written on EVERY resolve, not only when the sliding
   * refresh fires. Folded into the refresh branch it updated at most once per
   * ~15 days, so the "last used" column of a session-management UI would show a
   * fortnight-old timestamp for a session in use this minute — and the one
   * question that column exists to answer ("is this me, or someone else?")
   * would be answered wrongly.
   *
   * `expires_at` never moves backwards: `slid` equals the stored value outside
   * the refresh window, and the absolute cap can only shorten a slide, so
   * `GREATEST` keeps a capped session from being pulled in.
   */
  await db
    .execute(
      sql`UPDATE sessions
             SET last_seen_at = ${now},
                 expires_at = GREATEST(expires_at, ${slid})
           WHERE id = ${id}`,
    )
    .catch(() => undefined);

  return rowToAuthUser(row);
}

/**
 * Revoke a user: mark them disabled AND destroy every session they hold.
 *
 * The marking alone is not revocation. `resolveSession` refuses a session whose
 * user is disabled, but the rows survive — so the day someone clears
 * `disabled_at` to reinstate a writer, every session ever issued to them comes
 * back with it, including the one on the laptop that prompted the revocation.
 * Sessions outlive their reason for existing; deleting them is the only state
 * that means "revoked".
 *
 * One statement, not `db.transaction` — the Neon HTTP driver throws
 * unconditionally on `transaction()`, so a transaction here would pass every
 * PGlite test and 500 in production. `COALESCE` keeps the original disable time
 * on a repeat call while still sweeping any session issued in between.
 *
 * @returns how many sessions were destroyed.
 */
export async function disableUser(db: Db, userId: string): Promise<number> {
  const now = Date.now();
  const res = await db.execute(sql`
    WITH revoked AS (
      UPDATE users SET disabled_at = COALESCE(disabled_at, ${now})
       WHERE id = ${userId}
      RETURNING id
    )
    DELETE FROM sessions WHERE user_id IN (SELECT id FROM revoked)
    RETURNING id`);
  return res.rows.length;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.execute(sql`DELETE FROM sessions WHERE id = ${tokenId(token)}`);
}

// ----------------------------------------------------------------- invites

export async function createInvite(
  db: Db,
  a: { email: string; role: Role; invitedBy: string },
): Promise<{ id: string; token: string; expiresAt: number }> {
  const token = mintToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const res = await db.execute(sql`
    INSERT INTO invites (email, token_hash, role, invited_by, created_at, expires_at)
    VALUES (${a.email.trim().toLowerCase()}, ${tokenId(token)}, ${a.role},
            ${a.invitedBy}, ${now}, ${expiresAt})
    RETURNING id`);
  return { id: String(res.rows[0].id), token, expiresAt };
}

/** What `GET /api/invites` returns. Never `token_hash`. */
export interface InviteSummary {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
}

/**
 * Outstanding invites — unspent and unexpired.
 *
 * `token_hash` is enumerated OUT rather than being dropped by the mapper.
 * It is an HMAC and not a token, so leaking one is not immediately fatal, but
 * it is the exact value the `invites` lookup keys on and there is no reason for
 * it to leave the database. Same rule as `POST_COLUMNS`: no `SELECT *`.
 *
 * Expired rows are filtered rather than deleted. A list called "outstanding"
 * that quietly destroys history would make "did we ever invite this address"
 * unanswerable, and `acceptInvite` refuses an expired row anyway.
 */
export async function listInvites(db: Db): Promise<InviteSummary[]> {
  const now = Date.now();
  const res = await db.execute(sql`
    SELECT id, email, role, created_at, expires_at, invited_by
      FROM invites
     WHERE accepted_at IS NULL AND expires_at > ${now}
     ORDER BY created_at DESC, id DESC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    role: row.role as Role,
    createdAt: toEpochMs(row.created_at),
    expiresAt: toEpochMs(row.expires_at),
    invitedBy: String(row.invited_by),
  }));
}

/**
 * Revoke an invite. `false` when there was nothing to revoke, so the route can
 * answer 404 rather than pretending.
 *
 * A DELETE and not `SET expires_at = 0`: an unspent invite carries a live
 * credential, and the only state that means "this token can never be used" is
 * the absence of the row it hashes to.
 */
export async function revokeInvite(db: Db, id: string): Promise<boolean> {
  const res = await db.execute(sql`
    DELETE FROM invites WHERE id = ${id}::uuid AND accepted_at IS NULL
    RETURNING id`);
  return res.rows.length > 0;
}

/**
 * The invite — not the request body — is the authority for `email` and `role`.
 * The signature has no room for either, and the caller could not be trusted
 * with them if it did: accepting a caller-supplied role is privilege
 * escalation by HTTP request.
 *
 * "Exactly once" is enforced by a single conditional UPDATE, not by a
 * read-then-write, and not by `db.transaction` — the Neon HTTP driver throws
 * unconditionally on `transaction()`, so a transaction would pass every PGlite
 * test and 500 in production.
 */
export async function acceptInvite(
  db: Db,
  a: { token: string; password: string; displayName: string },
): Promise<AuthUser> {
  // Judged before the invite is claimed, so a too-short password costs a
  // round trip rather than a claim-and-restore cycle.
  assertCredentials(a);

  const now = Date.now();
  const claimed = await db.execute(sql`
    UPDATE invites SET accepted_at = ${now}
     WHERE token_hash = ${tokenId(a.token)}
       AND accepted_at IS NULL
       AND expires_at > ${now}
    RETURNING id, email, role`);

  const invite = claimed.rows[0];
  if (!invite) throw new InviteError();

  try {
    return await createUser(db, {
      email: String(invite.email),
      password: a.password,
      displayName: a.displayName,
      role: invite.role as Role,
    });
  } catch (err) {
    // Creating the user failed — a duplicate email, most likely. Hand the
    // invite back rather than burning it, but only if nothing else has
    // claimed it in the meantime.
    await db
      .execute(
        sql`UPDATE invites SET accepted_at = NULL
             WHERE id = ${String(invite.id)} AND accepted_at = ${now}`,
      )
      .catch(() => undefined);
    // Safe to rethrow unchanged: `createUser` has already turned the duplicate
    // email into a `DuplicateEmailError`, and anything that still is a driver
    // error was scrubbed by `guardDb` before it got here. This line used to be
    // the shortest route from a unique violation to a password hash in a log.
    throw err;
  }
}
