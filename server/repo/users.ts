import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../db/client';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
import { getEnv } from '../env';
import { hashPassword } from './password';

/** Re-exported from the shared table so server code keeps its old import
 * path; the vocabulary itself lives beside the labels and grants it must
 * never drift from (`shared/roles.ts`, migration 0680). */
export type Role = import('../../shared/roles').Role;

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

/**
 * 256 bits, URL-safe. Returned to the client once and never stored raw.
 *
 * EXPORTED for `repo/password-reset.ts`, which mints a token of exactly this
 * shape. Re-deriving it there would be two definitions of "how long is a
 * credential in this app", and the weaker one would never announce itself.
 */
export function mintToken(): string {
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
export function tokenId(token: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update(token).digest('hex');
}

/** EXPORTED for `repo/login-challenges.ts`, which joins users through a
 * challenge and must map the row identically. */
export function rowToAuthUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as Role,
  };
}

// ------------------------------------------------------------------- users

/**
 * The one place a display name is judged.
 *
 * LIFTED OUT OF `assertCredentials` RATHER THAN COPIED. `PATCH /api/auth/me`
 * changes a display name and no password, so it cannot call
 * `assertCredentials` without inventing a password to hand it — and an
 * `if (name.trim() === '')` written at that route would be a second definition
 * of "blank" that nothing keeps in step with this one. Zod's `.min(1)` is not
 * that definition either: it accepts `'   '`, which is exactly the value this
 * refuses.
 */
export function assertDisplayName(displayName: string): void {
  if (displayName.trim() === '') {
    throw new UserInputError('displayName', 'display name must not be empty');
  }
}

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
  assertDisplayName(a.displayName);
}

export async function createUser(
  db: Db,
  a: {
    email: string;
    password: string;
    displayName: string;
    role: Role;
    /**
     * DEFAULT true — every REAL account starts protected, which is what the
     * owner asked for. The DDL default is false so the column-less inserts in
     * the test harness stay single-factor (migration 0700's header carries the
     * ordering argument).
     */
    twoFactorEmail?: boolean;
  },
): Promise<AuthUser> {
  // Before hashing: a rejected password should not cost 200 ms of scrypt.
  assertCredentials(a);
  const passwordHash = await hashPassword(a.password);
  try {
    const res = await db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at,
                         two_factor_email)
      VALUES (${a.email.trim().toLowerCase()}, ${passwordHash}, ${a.displayName.trim()},
              ${a.role}, ${Date.now()}, ${a.twoFactorEmail ?? true})
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
): Promise<{
  user: AuthUser;
  passwordHash: string;
  disabledAt: number | null;
  twoFactorEmail: boolean;
} | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, role, password_hash, disabled_at, two_factor_email
      FROM users WHERE email = ${email.trim().toLowerCase()}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    user: rowToAuthUser(row),
    passwordHash: String(row.password_hash),
    disabledAt: toEpochMsOrNull(row.disabled_at),
    twoFactorEmail: Boolean(row.two_factor_email),
  };
}

/**
 * The same three-part shape `findUserByEmail` returns, keyed by id instead.
 *
 * `POST /api/auth/change-password` needs the stored hash for a caller it has
 * ALREADY authenticated, and going back through `findUserByEmail` would mean
 * re-normalising an address the session already resolved — one more place for
 * the lowercase/trim rule to be applied differently.
 *
 * `id` reaches a `uuid` column, so a value that is not one is SQLSTATE 22P02:
 * a scrubbed `DbError`, a 500, and five client retries for a request that can
 * never succeed. Every caller either passes `currentUser(c).id` (which came out
 * of this table) or a path segment already put through `uuidParam` — the rule
 * `server/routes/auth.ts` states for `invites.id` and for the same reason.
 */
export async function findUserById(
  db: Db,
  id: string,
): Promise<{ user: AuthUser; passwordHash: string; disabledAt: number | null } | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, role, password_hash, disabled_at
      FROM users WHERE id = ${id}::uuid`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    user: rowToAuthUser(row),
    passwordHash: String(row.password_hash),
    disabledAt: toEpochMsOrNull(row.disabled_at),
  };
}

/**
 * THE FIRST UPDATE OF `users.display_name` THAT HAS EVER EXISTED. Until this,
 * the column was INSERT-only: `createUser` wrote it at accept-invite and
 * nothing ever moved it again.
 *
 * NO BACKFILL IS NEEDED, and that is a fact read out of the schema rather than
 * a hope. `posts` has no `author_name` column — every place a post carries one,
 * it is produced by a live join on the way out: `server/repo/posts.ts:62`,
 * `server/repo/query.ts:371`, `server/repo/backup.ts:44` and
 * `server/repo/public.ts:212` all read `u.display_name AS author_name` through
 * `JOIN users u ON u.id = p.author_id`, and `rowToPost` takes it as an argument
 * rather than off the row. So a rename is visible on every existing post, every
 * revision listing, the export bundle and the public feed the moment this
 * statement commits. Had the column been denormalised onto `posts`, this
 * function would owe a second UPDATE and this comment would say so.
 *
 * Trimmed exactly as `createUser` trims it, so a name set here and a name set
 * at accept-invite cannot differ by a space.
 *
 * @returns the updated user, or `null` if the id matched nothing.
 */
export async function updateDisplayName(
  db: Db,
  userId: string,
  displayName: string,
): Promise<AuthUser | null> {
  assertDisplayName(displayName);
  const res = await db.execute(sql`
    UPDATE users SET display_name = ${displayName.trim()}
     WHERE id = ${userId}::uuid
    RETURNING id, email, display_name, role`);
  const row = res.rows[0];
  return row ? rowToAuthUser(row) : null;
}

/**
 * Set a new password and end every session EXCEPT the one that asked.
 *
 * The asymmetry is the whole route. `consumePasswordReset` ends every session
 * without exception, because a reset is what someone does when they believe an
 * intruder holds one — there is nobody to keep. A signed-in change is the
 * opposite: the person at the keyboard has just proved they hold the old
 * password, so logging them out of the tab they are typing in is a bug, while
 * leaving the OTHER thirty-day cookies alive would make the change cosmetic
 * against exactly the attacker it is aimed at.
 *
 * ONE STATEMENT, for the reason `consumePasswordReset` gives at length: two
 * would leave a window in which the password had moved and the sessions had
 * not. Not `db.transaction` either — the Neon HTTP driver throws
 * unconditionally on `transaction()`, so a transaction here would pass every
 * PGlite test and 500 in production.
 *
 * `keepSessionToken` is the RAW cookie value; the id it must not delete is
 * derived here so no caller has to know that a session id is an HMAC. Absent,
 * the sentinel `''` matches no row — every session goes, which is the honest
 * behaviour for a caller that cannot name one to keep.
 *
 * @returns how many OTHER sessions were destroyed.
 */
export async function changePassword(
  db: Db,
  a: { userId: string; newPassword: string; keepSessionToken?: string },
): Promise<number> {
  // Before the derivation, exactly as `createUser` orders it: a rejected
  // password should not cost 200 ms of scrypt.
  assertCredentials({ password: a.newPassword, displayName: 'unused' });
  const passwordHash = await hashPassword(a.newPassword);
  const keepId = a.keepSessionToken ? tokenId(a.keepSessionToken) : '';

  const res = await db.execute(sql`
    WITH changed AS (
      UPDATE users SET password_hash = ${passwordHash}
       WHERE id = ${a.userId}::uuid
      RETURNING id
    )
    DELETE FROM sessions
     WHERE user_id IN (SELECT id FROM changed) AND id <> ${keepId}
    RETURNING id`);

  /*
   * Any outstanding reset link dies with the change, best-effort. Somebody who
   * asked for a reset, gave up, and then changed the password from inside the
   * app has left a live credential sitting in a mailbox for the rest of its
   * hour — and it would still work, because `consumePasswordReset` only cares
   * that the token is unspent. Best-effort because the password has already
   * committed: failing the request now would tell the caller to retry a change
   * that already happened.
   */
  await db
    .execute(
      sql`DELETE FROM password_resets
           WHERE user_id = ${a.userId}::uuid AND used_at IS NULL`,
    )
    .catch(() => undefined);

  return res.rows.length;
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

/**
 * One row of `GET /api/auth/sessions` — the UI `sessions.user_agent` and
 * `sessions.last_seen_at` have been maintained for since they were added.
 */
export interface SessionSummary {
  /**
   * The row's primary key, which is `HMAC-SHA-256(token, SESSION_SECRET)`.
   *
   * `listInvites` refuses to return `invites.token_hash` on the grounds that
   * nothing needs it outside the database, and that rule genuinely does not
   * apply here: `DELETE /api/auth/sessions/:id` has to name a session, and this
   * is the only stable name one has.
   *
   * IT IS NOT A CREDENTIAL, and the check that says so is worth writing down.
   * A request authenticates by presenting the raw token in the cookie;
   * `resolveSession` hashes that and looks the row up. Nothing anywhere accepts
   * the stored id as an input, and the digest is keyed by an environment secret,
   * so it cannot be turned back into the token it names. The day something
   * compares a cookie against `sessions.id` directly, this field becomes one.
   */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** Whatever the browser sent when the session was created. Never parsed. */
  userAgent: string | null;
  /** The session making this request — "which of these is me". */
  current: boolean;
}

/**
 * A user's own live sessions, newest use first.
 *
 * EXPIRED ROWS ARE EXCLUDED rather than shown greyed out. `resolveSession`
 * deletes one the next time it is presented, so an expired row is a session
 * that has already ended and simply has not been swept — listing it invites
 * somebody to revoke something that is not there, and the revoke would 404.
 *
 * `currentToken` is the RAW cookie value; the comparison is made against its
 * HMAC here so no caller has to know how a session id is derived.
 */
export async function listSessions(
  db: Db,
  userId: string,
  currentToken?: string,
): Promise<SessionSummary[]> {
  const currentId = currentToken ? tokenId(currentToken) : '';
  const res = await db.execute(sql`
    SELECT id, created_at, expires_at, last_seen_at, user_agent
      FROM sessions
     WHERE user_id = ${userId}::uuid AND expires_at > ${Date.now()}
     ORDER BY last_seen_at DESC, id DESC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    createdAt: toEpochMs(row.created_at),
    lastSeenAt: toEpochMs(row.last_seen_at),
    expiresAt: toEpochMs(row.expires_at),
    userAgent: row.user_agent == null ? null : String(row.user_agent),
    current: String(row.id) === currentId,
  }));
}

/**
 * Revoke one of a user's OWN sessions. `false` when there was nothing to
 * revoke, so the route can answer 404 rather than pretending.
 *
 * `user_id` IS IN THE WHERE CLAUSE, NOT IN A PRIOR READ. Scoping by a SELECT
 * first would leave a route free to forget the comparison, and the failure mode
 * of forgetting it is one writer signing another writer out. In the statement,
 * "somebody else's session id" and "no such session id" are the same zero rows
 * and therefore the same 404 — which is also the answer that stops the route
 * being a probe for whether an id belongs to somebody.
 */
export async function revokeSession(
  db: Db,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const res = await db.execute(sql`
    DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}::uuid
    RETURNING id`);
  return res.rows.length > 0;
}

// -------------------------------------------------------------------- team

/** One row of `GET /api/users`. Never `password_hash`, on any path. */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: number;
  /** Non-null means revoked — `resolveSession` refuses their every session. */
  disabledAt: number | null;
  postCount: number;
  /** Login demands an emailed code after the password (migration 0700). */
  twoFactorEmail: boolean;
}

/**
 * Every account, oldest first. NO PAGINATION, and that is a decision rather
 * than an omission: accounts exist only by invite, one at a time, issued by an
 * owner. An instance with enough of them to page is an instance where something
 * has gone wrong, and a cursor here would be machinery maintained forever for a
 * list that fits on a phone.
 *
 * `password_hash` IS ENUMERATED OUT rather than dropped by the mapper — the
 * same rule as `POST_COLUMNS` and `listInvites`: no `SELECT *` on a table with
 * a secret in it, so a future column cannot arrive in a response by default.
 *
 * `postCount` COUNTS TRASHED POSTS TOO. The question this column exists to
 * answer is "what does disabling this person leave behind", and a trashed post
 * is restorable until somebody empties the trash — so it is still theirs and
 * still comes back. A count that silently omitted them would read as zero for a
 * writer whose entire body of work is one `POST /api/trash/empty` away from
 * being destroyed.
 *
 * A LEFT JOIN and not a correlated subquery per row: `posts_author_idx` covers
 * the grouping, and a user with no posts must still appear (an account invited
 * this morning is exactly the one an owner is looking at).
 */
export async function listUsers(db: Db): Promise<UserSummary[]> {
  const res = await db.execute(sql`
    SELECT u.id, u.email, u.display_name, u.role, u.created_at, u.disabled_at,
           u.two_factor_email, count(p.id)::int AS post_count
      FROM users u
      LEFT JOIN posts p ON p.author_id = u.id
     GROUP BY u.id, u.email, u.display_name, u.role, u.created_at, u.disabled_at,
              u.two_factor_email
     ORDER BY u.created_at ASC, u.id ASC`);
  return res.rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as Role,
    createdAt: toEpochMs(row.created_at),
    disabledAt: toEpochMsOrNull(row.disabled_at),
    // `::int` in the SELECT, so this is a number under both drivers. A bare
    // `count(*)` is int8, which `@neondatabase/serverless` hands back as a
    // string while PGlite hands back a number — the seam `toEpochMs` exists for.
    postCount: Number(row.post_count),
    twoFactorEmail: Boolean(row.two_factor_email),
  }));
}

/**
 * Change what an account IS — its role. The rules about WHO may aim this at
 * WHOM live in the route (`server/routes/users.ts`), because they are about
 * the actor; this function holds only the invariant no caller may override:
 *
 * OWNER IS IMMUTABLE IN BOTH DIRECTIONS. The guarded UPDATE refuses to write
 * `owner` and refuses to touch a row that IS `owner`, so however the route
 * rules evolve, "exactly one owner, the seeded one" survives as a property of
 * the statement rather than of the callers (`shared/roles.ts` header).
 *
 * @returns the updated user, or `null` when the id matched nothing the
 * statement may touch — a missing row and the owner row look identical here,
 * and the route re-reads to tell 404 from 409.
 */
export async function setUserRole(db: Db, userId: string, role: Role): Promise<AuthUser | null> {
  if (role === 'owner') return null;
  const res = await db.execute(sql`
    UPDATE users SET role = ${role}
     WHERE id = ${userId}::uuid AND role <> 'owner'
    RETURNING id, email, display_name, role`);
  return res.rows[0] ? rowToAuthUser(res.rows[0]) : null;
}

/**
 * Turn the emailed second factor on or off for one account.
 *
 * NO SESSION SWEEP RIDES ALONG: flipping the factor changes what the NEXT
 * login demands, and ending live sessions is `disableUser`'s job — an admin
 * hardening an account should not sign its holder out mid-shift.
 *
 * @returns `false` when the id matched nothing, so the route can 404.
 */
export async function setTwoFactorEmail(db: Db, userId: string, on: boolean): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE users SET two_factor_email = ${on} WHERE id = ${userId}::uuid RETURNING id`);
  return res.rows.length > 0;
}

/**
 * Reinstate a revoked user: clear `disabled_at` and nothing else.
 *
 * DELIBERATELY NOT THE MIRROR OF `disableUser`. That one destroys every session
 * as it revokes, and the whole point of destroying them (see its comment) is
 * that reinstating must not resurrect the cookie on the laptop that prompted
 * the revocation. So enabling restores the ability to log in and no more: the
 * user types their password again.
 *
 * @returns `false` when the id matched nothing, so the route can 404.
 */
export async function enableUser(db: Db, userId: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE users SET disabled_at = NULL WHERE id = ${userId}::uuid RETURNING id`);
  return res.rows.length > 0;
}

/**
 * How many owners can currently sign in.
 *
 * The one number standing between an owner and an instance nobody can
 * administer: invites, exports, destroys and this very route are all
 * `requireOwner()`, so disabling the last active owner locks the door from the
 * inside. Recovery would mean `scripts/set-owner-password.ts --apply` against
 * the production database, which is a serious enough operation that refusing
 * the click is worth a 409.
 *
 * A COUNT AND NOT A GUARDED UPDATE, and the residual race is worth stating
 * rather than implying: two owners disabling each other in the same instant can
 * both read 2 and both proceed, leaving none. Closing that needs SERIALIZABLE
 * or a row lock, and this codebase has neither available — the Neon HTTP driver
 * throws on `transaction()`. The exposure is two humans clicking within a few
 * milliseconds of each other on a blog with two owners, and the recovery is the
 * bootstrap script; a check-then-act that says so beats a lock that cannot be
 * written here.
 */
export async function countActiveOwners(db: Db): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM users
     WHERE role = 'owner' AND disabled_at IS NULL`);
  return Number(res.rows[0].n);
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
  /** Non-null means spent — the account exists and the token is dead. */
  acceptedAt: number | null;
  invitedBy: string;
  /**
   * The inviter's display name, resolved here rather than by the caller.
   *
   * `invitedBy` on its own is a bare UUID, and the only route that could turn
   * one into a name is `GET /api/users` — owner-only, and a whole second
   * request to render one cell. The uuid stays alongside it because it is the
   * stable identity and a client may want to group by it.
   */
  invitedByName: string;
  /**
   * Which bucket this row is in, derived from the SAME `Date.now()` the filter
   * used. Computed once here rather than by every reader, because a client
   * comparing `expiresAt` against its own clock will disagree with the server's
   * filter on any row within a few seconds of expiry — and then show a row it
   * labels "open" that `acceptInvite` refuses.
   */
  state: 'open' | 'accepted' | 'expired';
}

/**
 * Invites. Outstanding by default; accepted and expired ones on request.
 *
 * `token_hash` is enumerated OUT rather than being dropped by the mapper.
 * It is an HMAC and not a token, so leaking one is not immediately fatal, but
 * it is the exact value the `invites` lookup keys on and there is no reason for
 * it to leave the database. Same rule as `POST_COLUMNS`: no `SELECT *`.
 *
 * Expired rows are filtered rather than deleted, and now they are also
 * REACHABLE: the row has always survived, but nothing could ask for it, so
 * "did we ever invite this address" was unanswerable through the API even
 * though the answer was sitting in the table. `include` opts the two history
 * buckets in one at a time, so the default stays the short list an owner acts
 * on rather than a growing archive.
 *
 * The join to `users` is an INNER join because `invites.invited_by` is
 * `NOT NULL REFERENCES users(id)` with no `ON DELETE` — an inviter cannot be
 * deleted out from under their invites, so there is no row this can drop.
 */
export async function listInvites(
  db: Db,
  include: { accepted?: boolean; expired?: boolean } = {},
): Promise<InviteSummary[]> {
  const now = Date.now();

  /*
   * ONE PREDICATE PER STATE, OR-ed — not a pair of flags folded into one
   * expression. The three states are mutually exclusive by construction
   * (`accepted_at` decides the first, the clock decides the other two), so a
   * bucket is either named here or is not in the result, and reading the query
   * answers "what does `?include=accepted` return" without unfolding boolean
   * algebra. The bound `false` an unrequested bucket would otherwise contribute
   * is also never sent, which keeps the plan free of a parameter Postgres would
   * have to infer a type for.
   */
  const buckets = [sql`(i.accepted_at IS NULL AND i.expires_at > ${now})`];
  if (include.accepted) buckets.push(sql`i.accepted_at IS NOT NULL`);
  if (include.expired) {
    buckets.push(sql`(i.accepted_at IS NULL AND i.expires_at <= ${now})`);
  }

  const res = await db.execute(sql`
    SELECT i.id, i.email, i.role, i.created_at, i.expires_at, i.accepted_at,
           i.invited_by, u.display_name AS invited_by_name
      FROM invites i
      JOIN users u ON u.id = i.invited_by
     WHERE ${sql.join(buckets, sql` OR `)}
     ORDER BY i.created_at DESC, i.id DESC`);

  return res.rows.map((row) => {
    const acceptedAt = toEpochMsOrNull(row.accepted_at);
    const expiresAt = toEpochMs(row.expires_at);
    return {
      id: String(row.id),
      email: String(row.email),
      role: row.role as Role,
      createdAt: toEpochMs(row.created_at),
      expiresAt,
      acceptedAt,
      invitedBy: String(row.invited_by),
      invitedByName: String(row.invited_by_name),
      /*
       * ACCEPTED WINS OVER EXPIRED. A spent invite whose seven days have since
       * elapsed is history, not a missed opportunity, and labelling it
       * "expired" would tell an owner to re-send an invite to somebody who
       * already has an account.
       */
      state: acceptedAt != null ? 'accepted' : expiresAt > now ? 'open' : 'expired',
    };
  });
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
