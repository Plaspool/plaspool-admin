import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The storefront→admin identity bridge (spec §3).
 *
 * DELIBERATELY NOT A JWT. A JWT carries its own algorithm in a header the
 * verifier is invited to trust, which is the root of `alg: none` and of every
 * algorithm-confusion bug in the family. There is one algorithm here, it is
 * hard-coded, and a payload that wants a different one has nowhere to say so.
 *
 * WHY A SHARED SECRET AND NOT JWKS. Neon Auth's `jwt` plugin is not enabled on
 * this project — `<auth-base>/jwks` 404s and `neon_auth.jwks` is empty — so
 * `getJWTToken()` has nothing to return. Public-key verification is the better
 * shape and this module is the only thing that would change to adopt it:
 * `verifyAssertion` keeps its signature and stops needing a secret.
 *
 * WHY NOT `SESSION_SECRET`. That key already authenticates two token families
 * (`sessions` and `shop_customer_sessions`). A third, cross-service purpose on
 * one key means a rotation cannot be staged — the admin and the storefront must
 * then cut over in the same instant, which two independent deploy pipelines
 * cannot do.
 */

/** The one shape crossing the bridge. `iat`/`exp` are epoch ms, as everywhere. */
export interface Assertion {
  v: 1;
  /** `neon_auth.user.id`, a uuid. Carried so a later email change is traceable. */
  sub: string;
  /** Verified and lowercased by the MINTER. This side re-lowercases anyway. */
  email: string;
  iat: number;
  exp: number;
  /** 128 bits, base64url. The single-use key. */
  jti: string;
}

export class BadAssertionError extends Error {
  readonly reason: 'malformed' | 'mac' | 'expired';

  constructor(reason: 'malformed' | 'mac' | 'expired') {
    super(`bad assertion: ${reason}`);
    this.name = 'BadAssertionError';
    this.reason = reason;
  }
}

/** 60 seconds. It crosses one tab to one endpoint; longer only widens replay. */
export const ASSERTION_TTL_MS = 60_000;

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signAssertion(secret: string, a: Assertion): string {
  const payload = Buffer.from(JSON.stringify(a)).toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

/**
 * Verify, or throw. NEVER returns a boolean and never echoes the input.
 *
 * ORDER MATTERS: the MAC is checked BEFORE the payload is trusted for anything,
 * including its own expiry. Reading `exp` out of an unverified payload to decide
 * whether to bother checking the MAC would let an attacker skip the check.
 */
export function verifyAssertion(secret: string, raw: string, now = Date.now()): Assertion {
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new BadAssertionError('malformed');
  const [payload, given] = parts;

  const expected = mac(secret, payload);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length must match before `timingSafeEqual`, which THROWS on a mismatch
  // rather than returning false — a truncated MAC would otherwise be a 500.
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadAssertionError('mac');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new BadAssertionError('malformed');
  }

  const p = parsed as Partial<Assertion>;
  if (
    p?.v !== 1 ||
    typeof p.sub !== 'string' ||
    typeof p.email !== 'string' ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number' ||
    typeof p.jti !== 'string' ||
    !p.sub ||
    !p.email ||
    !p.jti
  ) {
    throw new BadAssertionError('malformed');
  }

  // No skew allowance. Both sides run on managed platforms with synced clocks;
  // a tolerance here is a replay window with a friendly name.
  if (p.exp <= now) throw new BadAssertionError('expired');

  return { ...(p as Assertion), email: p.email.trim().toLowerCase() };
}
