import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
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

/** 256 bits, URL-safe. Returned to the client once and never stored raw. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * PGlite hands `bigint` back as a JS number; the Neon HTTP driver hands it
 * back as a string. Coerce at every read so the two agree — a divergence here
 * is the exact class of bug that passes every test and breaks in production.
 */
function num(value: unknown): number {
  return Number(value);
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

export async function createUser(
  db: Db,
  a: { email: string; password: string; displayName: string; role: Role },
): Promise<AuthUser> {
  const passwordHash = await hashPassword(a.password);
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    VALUES (${a.email.trim().toLowerCase()}, ${passwordHash}, ${a.displayName},
            ${a.role}, ${Date.now()})
    RETURNING id, email, display_name, role`);
  return rowToAuthUser(res.rows[0]);
}

/**
 * The hash comes back beside the user rather than on it, so `AuthUser` — the
 * only user shape that crosses the boundary — can never carry a password hash
 * into a response.
 */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ user: AuthUser; passwordHash: string } | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, role, password_hash
      FROM users WHERE email = ${email.trim().toLowerCase()}`);
  const row = res.rows[0];
  if (!row) return null;
  return { user: rowToAuthUser(row), passwordHash: String(row.password_hash) };
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
  const expiresAt = num(row.expires_at);
  if (expiresAt <= now) {
    await db.execute(sql`DELETE FROM sessions WHERE id = ${id}`).catch(() => undefined);
    return null;
  }
  // A revoked writer's outstanding sessions die with the revocation, not at
  // their own expiry.
  if (row.disabled_at != null) return null;

  const createdAt = num(row.created_at);
  const halfway = expiresAt - SESSION_TTL_MS / 2;
  if (now > halfway) {
    const next = Math.min(now + SESSION_TTL_MS, createdAt + SESSION_ABSOLUTE_MAX_MS);
    if (next > expiresAt) {
      await db
        .execute(
          sql`UPDATE sessions SET expires_at = ${next}, last_seen_at = ${now}
               WHERE id = ${id}`,
        )
        .catch(() => undefined);
    }
  }

  return rowToAuthUser(row);
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
    throw err;
  }
}
