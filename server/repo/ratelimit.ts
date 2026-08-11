import { sql } from 'drizzle-orm';
import { toEpochMs } from '../db/client';
import type { Db } from '../db/client';

/**
 * Rate limiting, in Postgres (spec §6).
 *
 * NOT IN MODULE MEMORY, AND THAT IS THE WHOLE POINT. Serverless instances do
 * not share memory: an in-process counter bounds one warm instance and nothing
 * else, so it stops a serial script and stops nothing that adds concurrency,
 * survives a cold start, or survives a deploy. `auth_attempts` sits on a path
 * that already queries the database, so the cost is one statement on a request
 * that was going to make several.
 */

/** Spec §5.1: "rate-limited 5 / 15 min per email+IP". */
export const LOGIN_LIMIT = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * The second bucket, per IP alone (spec §6).
 *
 * A single per-email limiter lets one host password-spray every account in an
 * invite-only instance without ever tripping: five attempts against each of
 * twenty addresses is a hundred guesses and not one of them crosses a
 * per-email threshold. Four times the per-account allowance is enough headroom
 * for a household or an office behind one NAT and nowhere near enough to walk
 * a user list.
 */
export const LOGIN_IP_LIMIT = 20;

/**
 * `GET /export` returns every writer's drafts and full history in one request,
 * so it is the cheapest way to exfiltrate the entire blog and the most
 * expensive query in the app. `POST /import` runs `validateDoc` over an
 * attacker-sized bundle. Neither number is in the spec — §6 says only that both
 * are "limited by the same table" — so these are choices: generous for a human
 * pressing a button, useless for a loop.
 */
export const BACKUP_LIMIT = 5;
export const BACKUP_WINDOW_MS = 60 * 60_000;

/**
 * How long a spent window is kept before it is swept.
 *
 * Keys are `login:<ip>|<email>`, i.e. partly attacker-chosen, so without a
 * sweep the table grows one row per distinct pair forever and the rate limiter
 * becomes a storage-exhaustion primitive against the database it protects.
 * Well past the longest window so a sweep can never clear a live counter.
 */
export const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RateVerdict {
  ok: boolean;
  /** Seconds until the current window ends. Always ≥ 1, never 0. */
  retryAfter: number;
}

/**
 * Count one attempt against `key` and say whether it is still inside `limit`.
 *
 * ONE STATEMENT, and not `db.transaction` — the Neon HTTP driver throws
 * unconditionally on `transaction()` while PGlite supports it, so a transaction
 * here would pass every test and 500 in production (spec §4.3a).
 *
 * Fixed windows, floored to a multiple of `windowMs`. A sliding window would
 * need a second column and a second statement to age entries out; the cost of
 * the fixed one is that an attacker straddling a boundary gets `2 × limit` in
 * quick succession, which for five login attempts is ten and changes nothing
 * about whether a password survives.
 *
 * THE SWEEP EXCLUDES THE KEY BEING HIT, deliberately. A data-modifying CTE and
 * the outer statement cannot see each other's effects, and Postgres documents
 * updating the same row twice in one statement as unpredictable — so the DELETE
 * is made disjoint from the UPSERT rather than left to chance.
 */
export async function hit(
  db: Db,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateVerdict> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const staleBefore = now - ATTEMPT_RETENTION_MS;

  const res = await db.execute(sql`
    WITH swept AS (
      DELETE FROM auth_attempts
       WHERE window_start < ${staleBefore} AND key <> ${key}
    )
    INSERT INTO auth_attempts (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key) DO UPDATE
       SET count = CASE WHEN auth_attempts.window_start < ${windowStart}
                        THEN 1 ELSE auth_attempts.count + 1 END,
           window_start = CASE WHEN auth_attempts.window_start < ${windowStart}
                              THEN ${windowStart} ELSE auth_attempts.window_start END
    RETURNING count, window_start`);

  const row = res.rows[0];
  const count = Number(row.count);
  // `toEpochMs`, not the raw column: PGlite parses int8 to a number and
  // `@neondatabase/serverless` hands back a string, so `start + windowMs` would
  // be arithmetic in tests and string concatenation in production.
  const start = toEpochMs(row.window_start);
  const retryAfter = Math.max(1, Math.ceil((start + windowMs - now) / 1000));
  return { ok: count <= limit, retryAfter };
}

/**
 * Forget one key — used on a successful login.
 *
 * Only the `email+ip` bucket is ever cleared, never the `ip` one. Clearing both
 * would hand an attacker who holds ONE valid account a reset button for the
 * spray limiter: log in, clear the IP counter, resume guessing. Clearing the
 * narrow bucket only means a writer who mistyped four times is not locked out
 * of their own account for a quarter of an hour after finally getting it right.
 */
export async function forget(db: Db, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM auth_attempts WHERE key = ${key}`);
}
