import type { Context } from 'hono';
import { hit } from '../repo/ratelimit';
import { RateLimitedError } from './errors';
import type { AppEnv } from '../app-env';

/**
 * The route-facing half of the Postgres rate limiter.
 *
 * Not a `MiddlewareHandler`: every limited route needs a key built from
 * something only the handler knows — the email in the body, the id of the
 * session user — so a middleware would either be per-route anyway or would have
 * to parse the body twice.
 */

/**
 * The caller's IP, as reported by the platform in front of this app.
 *
 * WHAT THIS TRUSTS, SAID OUT LOUD. `x-forwarded-for` is an ordinary request
 * header: anything reaching the Node process directly can put whatever it likes
 * in it, and then every per-IP bucket in the app is one header edit away from
 * being useless. It is trusted here because this app is only ever reached
 * through Vercel's edge, which sets `x-real-ip` and appends the true client
 * address to `x-forwarded-for` — deploy it behind anything that does not, and
 * this function needs changing with it.
 *
 * `x-real-ip` FIRST, and the LEFTMOST `x-forwarded-for` entry only as a
 * fallback: a client-supplied `x-forwarded-for` arrives with the real address
 * appended after it, so taking the leftmost value is what an attacker would
 * choose. `x-real-ip` is single-valued and set by the proxy, so it is the one
 * that cannot be extended.
 */
export function clientIp(c: Context<AppEnv>): string {
  const real = c.req.header('x-real-ip');
  if (real && real.trim()) return real.trim();
  const forwarded = c.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  // A bucket named 'unknown' is still a bucket: better that every unattributed
  // request shares one counter than that they share none.
  return first && first.length > 0 ? first : 'unknown';
}

/** Count one attempt, or throw the 429 spec §8 describes. */
export async function limit(
  c: Context<AppEnv>,
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const verdict = await hit(c.get('db'), key, max, windowMs);
  if (!verdict.ok) throw new RateLimitedError(verdict.retryAfter);
}
