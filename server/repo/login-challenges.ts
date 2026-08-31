import { randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMsOrNull } from '../db/client';
import { mintToken, tokenId, rowToAuthUser } from './users';
import type { AuthUser } from '../../shared/types';

/**
 * Email login codes — the second factor (migration 0700).
 *
 * A challenge is minted AFTER the password verifies and holds two credentials:
 * a 256-bit TICKET the browser keeps (proof the password step happened, so the
 * code route never sees a password), and a 6-digit CODE that goes to the
 * inbox. Both are stored only as HMACs under SESSION_SECRET — `tokenId`, the
 * same treatment sessions and invites get — so a database dump alone is inert.
 *
 * THE CODE IS GUESSABLE BY DESIGN AND BOUNDED BY EVERYTHING ELSE. One in a
 * million per guess, five guesses per challenge (an attempts CAS, so
 * concurrent guesses cannot stretch it), ten minutes per challenge, and the
 * login IP limiter in front of the whole flow. What the short code buys is a
 * person typing six digits off a phone screen; what bounds it is this file.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_ATTEMPT_LIMIT = 5;
export const CODE_RESEND_LIMIT = 3;
/** Six digits, zero-padded — "047201" must survive as typed. */
export const CODE_LENGTH = 6;

function mintCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export interface MintedChallenge {
  /** Returned to the browser once, never stored raw. */
  ticket: string;
  /** Goes into the email once, never stored raw, never logged. */
  code: string;
  expiresAt: number;
}

export async function createLoginChallenge(
  db: Db,
  userId: string,
  now: number,
): Promise<MintedChallenge> {
  const ticket = mintToken();
  const code = mintCode();
  const expiresAt = now + CODE_TTL_MS;
  await db.execute(sql`
    INSERT INTO auth_login_challenges (user_id, ticket_hash, code_hash, created_at, expires_at)
    VALUES (${userId}::uuid, ${tokenId(ticket)}, ${tokenId(code)}, ${now}, ${expiresAt})`);
  return { ticket, code, expiresAt };
}

export type VerifyRefusal =
  /** No live challenge for that ticket — expired, spent, or never existed.
   * ONE bucket on purpose: telling them apart tells an attacker which tickets
   * are real. */
  | 'unknown'
  /** The code did not match. The attempt is spent; the challenge may be too. */
  | 'mismatch';

export type VerifyResult = { ok: true; user: AuthUser } | { ok: false; reason: VerifyRefusal };

/**
 * Spend one guess. The bookkeeping is a single guarded UPDATE — the CAS is on
 * the row still being live — and the comparison happens in SQL against the
 * stored HMAC, so two concurrent guesses each consume an attempt and the
 * ceiling cannot be raced past. A correct code CONSUMES the challenge in the
 * same statement that verifies it, so a replayed ticket+code pair mints
 * nothing twice.
 *
 * The user comes back joined, already filtered by `disabled_at IS NULL`: an
 * account revoked between password and code gets `unknown`, not a session.
 */
export async function verifyLoginChallenge(
  db: Db,
  ticket: string,
  code: string,
  now: number,
): Promise<VerifyResult> {
  const res = await db.execute(sql`
    WITH spent AS (
      UPDATE auth_login_challenges c
         SET attempts = c.attempts + 1,
             consumed_at = CASE
               WHEN c.code_hash = ${tokenId(code)} THEN ${now}
               WHEN c.attempts + 1 >= ${CODE_ATTEMPT_LIMIT} THEN ${now}
               ELSE c.consumed_at
             END
       WHERE c.ticket_hash = ${tokenId(ticket)}
         AND c.consumed_at IS NULL
         AND c.expires_at > ${now}
      RETURNING c.user_id, (c.code_hash = ${tokenId(code)}) AS matched
    )
    SELECT s.matched, u.id, u.email, u.display_name, u.role
      FROM spent s
      JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL`);

  const row = res.rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (!row.matched) return { ok: false, reason: 'mismatch' };
  return { ok: true, user: rowToAuthUser(row) };
}

/**
 * A fresh code on the SAME challenge: same ticket, same expiry window, new six
 * digits. The old code stops working — one stored hash per challenge is the
 * design — and the clock deliberately does NOT restart, so resending cannot be
 * used to hold a challenge open forever. Bounded by `CODE_RESEND_LIMIT` in the
 * same guarded statement.
 *
 * @returns the new code and the address to mail it to, or `null` when the
 * challenge is spent, expired, unknown, or out of resends — one bucket, for
 * the reason `VerifyRefusal` gives.
 */
export async function resendLoginChallenge(
  db: Db,
  ticket: string,
  now: number,
): Promise<{ code: string; to: string } | null> {
  const code = mintCode();
  const res = await db.execute(sql`
    WITH refreshed AS (
      UPDATE auth_login_challenges c
         SET code_hash = ${tokenId(code)}, resends = c.resends + 1
       WHERE c.ticket_hash = ${tokenId(ticket)}
         AND c.consumed_at IS NULL
         AND c.expires_at > ${now}
         AND c.resends < ${CODE_RESEND_LIMIT}
      RETURNING c.user_id
    )
    SELECT u.email FROM refreshed r
      JOIN users u ON u.id = r.user_id AND u.disabled_at IS NULL`);
  const row = res.rows[0];
  if (!row) return null;
  return { code, to: String(row.email) };
}

/** Yesterday's challenges, swept opportunistically by the login route. */
export async function sweepLoginChallenges(db: Db, now: number): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM auth_login_challenges
     WHERE expires_at < ${now - 24 * 60 * 60_000}
    RETURNING id`);
  return res.rows.length;
}
