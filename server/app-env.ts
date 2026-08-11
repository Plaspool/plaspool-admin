import type { Context } from 'hono';
import type { Db } from './db/client';
import type { AuthUser } from '../shared/types';
import { UnauthenticatedError } from './middleware/errors';

/**
 * The Hono environment every middleware and every route shares.
 *
 * IN ITS OWN FILE, not in `server/index.ts`, so the middleware modules do not
 * have to import the app they are mounted into. The cycle would be erased at
 * runtime (`AppEnv` is a type and `verbatimModuleSyntax` drops it) but it would
 * still be a cycle in the module graph, and the two helpers below are real
 * values that cannot be.
 */
export type AppEnv = {
  Variables: {
    /** Null until `sessionMiddleware` runs, and null for an anonymous caller. */
    user: AuthUser | null;
    db: Db;
    requestId: string;
    /**
     * The exact-match allow-list this request was judged against.
     *
     * Shared with the routes rather than re-read, so the invite URL and the
     * CSRF guard cannot disagree about what this deployment's origin is — and
     * so neither is ever built from an attacker-controlled `Host` header.
     */
    origins: readonly string[];
  };
};

/**
 * The session user, or a 401.
 *
 * Every mutating route is already behind `requireAuth()`, so this never throws
 * in practice — which is exactly why it exists rather than a `!`. A route added
 * later and mounted in the wrong place would silently get `null` and take a
 * permission decision against it; here it gets a 401 instead.
 */
export function currentUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** The request-scoped database handle. */
export function currentDb(c: Context<AppEnv>): Db {
  return c.get('db');
}
