import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { resolveSession } from '../repo/users';
import { ForbiddenError, UnauthenticatedError } from './errors';
import type { AppEnv } from '../app-env';

/**
 * Sessions on the wire (spec §6).
 *
 * `__Host-` is not decoration. The prefix is enforced by the browser: a cookie
 * whose name starts with it is rejected unless it is `Secure`, has `Path=/` and
 * carries NO `Domain` attribute. That last one is the point — without it, a
 * subdomain (a preview deployment, a marketing site, anything an attacker gets
 * to host on the registrable domain) can set a cookie that the app then treats
 * as a session, which is session fixation with no XSS required.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` means a link from an email or
 * from anywhere else lands the writer on a logged-out app, which is how people
 * conclude the login is broken. `Lax` still withholds the cookie on every
 * cross-site POST, and the `Origin` check in `origin.ts` covers the top-level
 * navigation `Lax` does allow.
 */
export const SESSION_COOKIE = '__Host-studio_session';

/**
 * Resolve the cookie into a user, or into `null`. NEVER a 401 by itself.
 *
 * Separating "who is this" from "must there be someone" is what lets
 * `GET /api/auth/me` answer 401 through the same code path that lets
 * `POST /api/auth/logout` succeed for a session that has already expired —
 * a logout that 401s leaves the cookie in the browser, which is the one thing
 * logout exists to prevent.
 */
export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set('user', token ? await resolveSession(c.get('db'), token) : null);
    await next();
  };
}

/** 401 unless a session resolved. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('user')) throw new UnauthenticatedError();
    await next();
  };
}

/**
 * Owner only — invites, empty-trash, export, destroy.
 *
 * 401 before 403, so an anonymous caller learns nothing about which routes are
 * owner-only that they could not learn from the source anyway, and an
 * authenticated writer gets the accurate answer.
 */
export function requireOwner(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new UnauthenticatedError();
    if (user.role !== 'owner') throw new ForbiddenError();
    await next();
  };
}

/**
 * `Max-Age` is derived from the session's own expiry rather than fixed at 30
 * days, so a session capped by the 90-day absolute ceiling (spec §6) gets a
 * cookie that dies with it instead of one that outlives it and produces a
 * silent 401 on the next write.
 */
export function setSessionCookie(
  c: Context<AppEnv>,
  token: string,
  expiresAt: number,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  });
}

/**
 * The attributes must match the ones the cookie was set with or the browser
 * treats the deletion as a different cookie and keeps the original.
 */
export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  });
}

/** The raw token from the cookie, for logout's session delete. */
export function sessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
