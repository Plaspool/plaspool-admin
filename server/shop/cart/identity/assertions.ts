import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { ASSERTION_TTL_MS } from './bridge';

/**
 * Spend an assertion's `jti`, exactly once.
 *
 * `ON CONFLICT DO NOTHING` + `RETURNING`, which is the whole trick: the losing
 * branch of a race returns NO ROW, so `true` means "this call spent it" rather
 * than "it was unspent a moment ago". Read-then-write loses here, and it loses
 * silently — two concurrent posts of one assertion would both mint a session.
 *
 * NOT `db.transaction`: the Neon HTTP driver throws unconditionally on it while
 * PGlite supports it, so a transaction would pass every test in this repository
 * and 500 in production.
 */
export async function spendAssertion(
  db: Db,
  jti: string,
  now = Date.now(),
): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO shop_auth_assertions (jti, used_at)
    VALUES (${jti}, ${now})
    ON CONFLICT (jti) DO NOTHING
    RETURNING jti`);

  const spent = res.rows.length > 0;

  /*
   * Opportunistic sweep, best-effort, the same SHAPE as `createCustomerSession`
   * — swallowed catch, never blocks the caller — but NOT the same rule. That
   * one sweeps unconditionally on its own `expires_at` column; this table has
   * no expiry column, so this sweep only runs on a successful spend, and it
   * deletes everything older than `ASSERTION_TTL_MS * 10`, not `ASSERTION_TTL_MS`
   * itself — a tenfold margin past the longest an assertion could legitimately
   * still be live, so a row is never swept while it could still matter for
   * replay detection. A spent key past that horizon is safe to drop: the MAC
   * check rejects the assertion on its own expiry long before then anyway, so
   * keeping the row buys nothing.
   */
  if (spent) {
    await db
      .execute(sql`DELETE FROM shop_auth_assertions WHERE used_at <= ${now - ASSERTION_TTL_MS * 10}`)
      .catch(() => undefined);
  }

  return spent;
}
