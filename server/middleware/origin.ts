import type { MiddlewareHandler } from 'hono';
import { getEnv } from '../env';
import { ForbiddenError } from './errors';
import type { AppEnv } from '../app-env';
import { storefrontOrigin } from '../shop/storefront-url';

/**
 * CSRF, by same-origin deployment plus `SameSite=Lax` plus this (spec §6).
 *
 * THE ALLOW-LIST IS MATCHED BY EQUALITY, NEVER BY SUFFIX. `origin.endsWith('.
 * vercel.app')` — or any `endsWith` at all — is not a check: anyone can deploy
 * to `*.vercel.app`, and `https://evil-myapp.vercel.app` ends with
 * `myapp.vercel.app`. Preview deployments get their own entry in `APP_ORIGINS`
 * instead, which is one environment variable against a whole class of forged
 * cross-origin writes.
 *
 * AN ABSENT `Origin` IS REFUSED ON UNSAFE METHODS. Every browser sends one on a
 * cross-origin request and on any same-origin request that is not a plain form
 * or navigation, so "no Origin" on a `POST` is either a non-browser client —
 * which has no cookie to ride on and can therefore use a different credential —
 * or a browser deliberately withholding it. Treating absence as permission is
 * the hole a `SameSite=Lax` cookie plus a top-level form POST walks straight
 * through.
 *
 * GET IS ALLOWED FROM ANYWHERE, and that is not an oversight: a cross-origin
 * `GET` cannot read the response without CORS headers this app never sends, and
 * refusing it would break nothing an attacker relies on while breaking every
 * ordinary navigation.
 */

/** Methods that do not mutate, so they carry no CSRF risk worth a refusal. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `APP_ORIGINS`, split and trimmed.
 *
 * Read per call rather than at module scope: a module-level constant would
 * evaluate at import time, which is the same defect `getEnv()` exists to avoid
 * and would make importing the app demand a full environment.
 */
export function configuredOrigins(): string[] {
  const fromEnv = getEnv()
    .APP_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE STOREFRONT IS ALWAYS ALLOWED, WHETHER OR NOT ANYBODY REMEMBERED.
   *
   * `storefrontOrigin()` is the site this API exists to serve. Leaving it out of
   * `APP_ORIGINS` is not a policy decision anybody would make on purpose — it is
   * a value somebody forgot to update — and the failure it produces is silent
   * and expensive:
   *
   *   The preflight still answers 204. It simply carries no
   *   `access-control-allow-origin`, so the BROWSER refuses the response. The
   *   server logs a success. The storefront reports "We couldn't load your
   *   cart", and every credentialed call — cart, session exchange, orders,
   *   returns — fails identically with nothing anywhere naming the cause.
   *
   * That happened when `plaspool.com` was attached to the Worker: `APP_ORIGINS`
   * still listed only the old `*.workers.dev` hostname, and sign-in broke on the
   * live site while every check on this side stayed green.
   *
   * ═══ THIS GRANTS NO NEW TRUST ═══
   * `STOREFRONT_ORIGIN` is already trusted to build the links in customer mail
   * (`shop/storefront-url.ts`), so an attacker who could set it already owns
   * more than this. And the guarantee the module header makes is untouched:
   * matching is still EQUALITY against a fixed list, never a suffix test.
   *
   * `APP_ORIGINS` remains the place to add anything else — previews, the admin's
   * own origin, a second storefront. This only makes the one entry that must
   * always be present impossible to omit.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const storefront = storefrontOrigin();
  return fromEnv.includes(storefront) ? fromEnv : [...fromEnv, storefront];
}

/**
 * @param origins injected by tests and by `createApp`, so the allow-list can be
 * varied without a module reset. Production passes nothing and gets
 * `APP_ORIGINS`.
 */
export function originGuard(origins?: readonly string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const allowed = origins ?? configuredOrigins();
    // Published on every request, safe or not: `POST /api/invites` builds an
    // invite URL from it, and building one from the request's own `Host` header
    // would deliver a credential to whatever domain the caller named.
    c.set('origins', allowed);
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header('Origin');
    // `includes` on the exact string. Not `startsWith`, not `endsWith`, not a
    // URL parse that would normalise a trailing slash into a match.
    if (!origin || !allowed.includes(origin)) throw new ForbiddenError();
    await next();
  };
}
