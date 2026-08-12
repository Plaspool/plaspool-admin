import { sql } from 'drizzle-orm';
import { hashPassword } from './password';
import { assertCredentials, mintToken, tokenId } from './users';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';

/**
 * Password resets (studio auth).
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO HOLD, and it is the same one
 * `server/routes/auth.ts` opens with: nothing a caller can observe distinguishes
 * an address that has an account from one that does not. `createPasswordReset`
 * therefore returns `null` for BOTH "no such user" and "the user is disabled",
 * and the route cannot tell them apart because the type gives it nothing to tell
 * them apart with. A `{ found: false, reason }` shape would have been more
 * informative and would have leaked the whole thing the first time a route
 * logged it or branched on it.
 *
 * THE SECOND PROPERTY: single use is enforced by a guarded UPDATE, never by a
 * read-then-write. Two redemptions racing on one token both pass a
 * `SELECT ... WHERE used_at IS NULL`, and both then set a password — so the
 * loser's password is what sticks, which is an account takeover if the loser is
 * the attacker. `UPDATE ... WHERE used_at IS NULL RETURNING` makes Postgres the
 * arbiter: exactly one of the two gets a row back.
 *
 * NOT `db.transaction`, anywhere. The Neon HTTP driver throws unconditionally on
 * `transaction()`, so a transaction here would pass every PGlite test and 500 in
 * production (see `disableUser`). Each step is one statement instead.
 */

/**
 * One hour.
 *
 * Much shorter than `INVITE_TTL_MS` (7 days) and deliberately so: an invite is
 * an appointment someone may take a week to keep, while a reset is a live
 * credential to an EXISTING account, minted seconds ago by someone sitting at a
 * form. The window only has to cover the round trip through a mail server.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * 400 `{ error: 'bad_request', detail: 'token' }` — mapped in
 * `server/middleware/errors.ts`.
 *
 * ONE ERROR FOR FOUR CONDITIONS: unknown token, expired token, already-spent
 * token, and a token whose account has since been disabled. Told apart, they
 * answer "does this token exist" and "is this account still live" for anyone
 * holding a stale link. The message carries no token and no email.
 */
export class PasswordResetError extends Error {
  constructor() {
    super('password reset token is invalid, expired or already used');
    this.name = 'PasswordResetError';
  }
}

/**
 * Mint a reset for `email`, or `null` if there is nobody to mint one for.
 *
 * `null` covers "no account" AND "account disabled" — see the file header. A
 * disabled user must not be able to reset their way back in: `disableUser`
 * destroys their sessions, and a reset that still worked would hand the
 * revocation straight back.
 *
 * Any OTHER outstanding reset for the same user is deleted first. Otherwise
 * every "I didn't get the mail, send it again" click leaves another live
 * credential in the mailbox, and the oldest of them stays valid for its full
 * hour — so an attacker who saw one link keeps a working one after the user has
 * moved on to the newest.
 */
export async function createPasswordReset(
  db: Db,
  email: string,
): Promise<{ token: string; user: AuthUser } | null> {
  const res = await db.execute(sql`
    SELECT id, email, display_name, role
      FROM users
     WHERE email = ${email.trim().toLowerCase()} AND disabled_at IS NULL`);
  const row = res.rows[0];
  if (!row) return null;

  const userId = String(row.id);
  const now = Date.now();
  const token = mintToken();

  // Supersede, then issue. A DELETE and not `used_at = now`: an unspent reset
  // carries a live credential, and the only state that means "this token can
  // never be used" is the absence of the row it hashes to.
  await db.execute(sql`DELETE FROM password_resets WHERE user_id = ${userId}::uuid`);

  await db.execute(sql`
    INSERT INTO password_resets (user_id, token_hash, created_at, expires_at)
    VALUES (${userId}::uuid, ${tokenId(token)}, ${now},
            ${now + PASSWORD_RESET_TTL_MS})`);

  return {
    token,
    user: {
      id: userId,
      email: String(row.email),
      displayName: String(row.display_name),
      role: row.role as AuthUser['role'],
    },
  };
}

/**
 * Spend a token and set the new password. Throws `PasswordResetError` on
 * anything that is not a live, unspent token for a live account.
 *
 * @returns the id of the user whose password changed.
 */
export async function consumePasswordReset(
  db: Db,
  token: string,
  newPassword: string,
): Promise<string> {
  /*
   * Judged BEFORE the token is claimed, so a too-short password costs a round
   * trip rather than burning the user's only link — the same ordering
   * `acceptInvite` uses, and the same reason.
   *
   * `displayName` is a placeholder that only exists to satisfy the shared
   * signature: this path changes no display name, and the check it would run is
   * "not empty". Loosening `assertCredentials` to make the field optional would
   * make it possible for an account-CREATING caller to skip the check by
   * omission, which is a worse trade than one ignored string here.
   */
  assertCredentials({ password: newPassword, displayName: 'unused' });

  // Derived before the claim too: ~200 ms of scrypt inside the window between
  // claiming the row and writing the hash is 200 ms in which a crash leaves the
  // token spent and the password unchanged.
  const passwordHash = await hashPassword(newPassword);

  const now = Date.now();

  /*
   * THE GUARDED CLAIM — one statement, and the ONLY thing standing between two
   * concurrent redemptions. `used_at IS NULL` in the WHERE (not in a prior
   * SELECT) means the second racer updates zero rows and gets a 400.
   *
   * The join to `users` folds the disabled check into the same statement rather
   * than into a second read, so a token for a revoked account can never be spent
   * — not even in the window between the check and the claim.
   */
  const claimed = await db.execute(sql`
    UPDATE password_resets AS r
       SET used_at = ${now}
      FROM users AS u
     WHERE u.id = r.user_id
       AND u.disabled_at IS NULL
       AND r.token_hash = ${tokenId(token)}
       AND r.used_at IS NULL
       AND r.expires_at > ${now}
    RETURNING r.user_id`);

  const claim = claimed.rows[0];
  if (!claim) throw new PasswordResetError();
  const userId = String(claim.user_id);

  /*
   * THE PASSWORD CHANGE AND THE SESSION SWEEP ARE ONE STATEMENT.
   *
   * A reset is what someone does when they believe their account is
   * compromised, so a new password that leaves the attacker's 30-day cookie
   * working is not a reset at all — it is a password change with the intruder
   * still inside. Two statements would leave a window where the password had
   * moved and the sessions had not; a CTE closes it, and cannot half-apply.
   */
  await db.execute(sql`
    WITH changed AS (
      UPDATE users SET password_hash = ${passwordHash}
       WHERE id = ${userId}::uuid
      RETURNING id
    )
    DELETE FROM sessions WHERE user_id IN (SELECT id FROM changed)`);

  // Any sibling reset minted before this one dies with it — the user has just
  // proved control of the mailbox, so every other link in it is surplus.
  await db
    .execute(
      sql`DELETE FROM password_resets
           WHERE user_id = ${userId}::uuid AND used_at IS NULL`,
    )
    .catch(() => undefined);

  return userId;
}
