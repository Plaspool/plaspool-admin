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
   * Opportunistic sweep, best-effort, exactly as `createCustomerSession` does.
   * A spent key is only useful for as long as an assertion could still be
   * within its own TTL; past that the MAC check rejects it anyway, so keeping
   * the row buys nothing. A failure here must never cost a customer a sign-in,
   * hence the swallowed catch.
   */
  if (spent) {
    await db
      .execute(sql`DELETE FROM shop_auth_assertions WHERE used_at <= ${now - ASSERTION_TTL_MS * 10}`)
      .catch(() => undefined);
  }

  return spent;
}
