import { timingSafeEqual } from 'node:crypto';
import { UnauthenticatedError } from '../../middleware/errors';

/**
 * Authenticating a Vercel cron invocation.
 *
 * ═══ WHAT THE PLATFORM SENDS ═══
 * Vercel invokes a cron with an **HTTP GET** to the path named in `vercel.json`,
 * and — **only if the project has a `CRON_SECRET` environment variable** — an
 * `Authorization: Bearer <that value>` header. There is no signature, no
 * timestamp and no replay protection; possession of the secret is the whole of
 * the proof.
 *
 * ═══ WHY THIS FAILS CLOSED, AND WHY THAT IS THE WHOLE POINT ═══
 * The obvious way to write this is "if a secret is configured, compare it",
 * which reads as cautious and is a public endpoint on any deployment that has
 * not set one — the default state of a new project and of every preview
 * deployment. `originGuard` waves every GET through (`SAFE_METHODS`, and
 * correctly so: a cross-origin GET cannot read a response this app never sends
 * CORS headers for), so on such a deployment this token is the ONLY thing in
 * front of the endpoint. No secret therefore means NO ACCESS, not open access.
 *
 * ═══ WHY `process.env` AND NOT `getEnv()` ═══
 * `server/env.ts` validates the environment in one place and is the right home
 * for this, and it is not this subsystem's file to edit (contract §2 R1) — see
 * amendment A-013. Read here instead of at module scope, matching `getEnv()`'s
 * own reasoning: a module-level constant evaluates at import time, which turns a
 * missing variable into a confusing import-time crash and breaks any test that
 * sets `process.env` in a setup file.
 *
 * The cost of being outside `getEnv()` is that boot-time validation does not
 * cover it. That is acceptable here and nowhere else: an ABSENT `CRON_SECRET` is
 * a legitimate configuration — it means "this deployment runs no cron" — and it
 * already produces the correct behaviour, which is a 401.
 */

/**
 * Vercel's own recommendation is "a random string of at least 16 characters".
 * Enforced rather than hoped for: a two-character `CRON_SECRET` is a secret in
 * name only, and the failure mode is an endpoint anybody can drive.
 */
export const MIN_CRON_SECRET_LENGTH = 16;

const BEARER = /^Bearer (.+)$/;

/**
 * Throws `UnauthenticatedError` (401) unless the header carries the configured
 * secret. Returns nothing on success — there is no identity here, only a proof.
 *
 * CONSTANT-TIME, AND LENGTH-GUARDED FIRST. `timingSafeEqual` throws on
 * mismatched lengths rather than returning false, so the length check is not
 * optional; it also means a wrong-length token is rejected marginally faster,
 * which leaks the length of the secret and nothing else. Comparing with `===`
 * would leak rather more: it stops at the first differing byte, and this is a
 * value an attacker can guess against at their own pace.
 */
export function assertCronRequest(authorization: string | undefined): void {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < MIN_CRON_SECRET_LENGTH) throw new UnauthenticatedError();

  const presented = BEARER.exec(authorization ?? '')?.[1];
  if (presented === undefined) throw new UnauthenticatedError();

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthenticatedError();
}

/** True when this deployment is configured to run crons at all. For diagnostics
 * — never as a branch that skips the check. */
export function cronConfigured(): boolean {
  return (process.env.CRON_SECRET ?? '').length >= MIN_CRON_SECRET_LENGTH;
}
