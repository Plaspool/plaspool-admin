import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from './db/client';
import type { Db } from './db/client';
import { toResponse } from './middleware/errors';
import { NotFoundError } from './repo/errors';
import { originGuard } from './middleware/origin';
import { sessionMiddleware } from './middleware/session';
import { routes as auth } from './routes/auth';
import { routes as posts } from './routes/posts';
import { routes as revisions } from './routes/revisions';
import { routes as backup } from './routes/backup';
import type { AppEnv } from './app-env';

export type { AppEnv } from './app-env';

/**
 * The app (spec §2).
 *
 * A FACTORY, NOT A MODULE-SCOPE SINGLETON WITH BAKED-IN DEPENDENCIES. Two
 * things force it, and both are properties the plan asks to be proved:
 *
 * - the rate limiter must bound the DEPLOYMENT, not one instance, and the only
 *   honest way to test that is to build two apps over one database and watch
 *   the count carry across them. A singleton holding a module-level handle
 *   cannot express the question.
 * - every suite in this repository runs against its own PGlite. A `getDb()`
 *   baked in at import time would dial Neon, or would need an environment
 *   variable per test file.
 *
 * `export const app` still exists below for the two callers that want the real
 * thing — the Vercel entrypoint and the dev server.
 */

export interface AppDeps {
  /**
   * The handle, or a function returning it. Defaulted to `getDb`.
   *
   * NEVER CALLED AT CONSTRUCTION, and never eagerly per request either: it is
   * invoked by the first `currentDb(c)` of a request and memoised for the rest
   * of it. So importing this module does not demand `DATABASE_URL`, and neither
   * does a request that has no reason to touch the database — see the note on
   * `dbFactory` in `server/app-env.ts` for what that was measured to fix.
   */
  db?: Db | (() => Db);
  /** Exact-match allow-list. Defaults to `APP_ORIGINS` (spec §6). */
  origins?: readonly string[];
}

/**
 * The prefix, in one constant.
 *
 * Every route in this app is registered under `/api` — the Vercel catch-all
 * passes the path through unmodified and the Vite dev proxy forwards `/api` to
 * port 8787, so a route mounted at `/posts` would be reachable in neither.
 */
export const API_PREFIX = '/api';

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const { db } = deps;
  const resolveDb: () => Db =
    typeof db === 'function' ? (db as () => Db) : db ? () => db : getDb;

  const app = new Hono<AppEnv>();

  /*
   * FIRST, SO EVERYTHING AFTER IT HAS ONE. Spec §8: every response carries a
   * `requestId`, logged alongside the stack, and a 500 never leaks the stack
   * itself — the id is the only thread between what the caller saw and what the
   * log holds.
   *
   * Minted here and never read from the request. Echoing a caller-supplied
   * `X-Request-Id` would let anyone write arbitrary ids into the log and
   * collide them with somebody else's incident.
   */
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    await next();
    c.res.headers.set('x-request-id', requestId);
  });

  app.onError((err, c) => toResponse(err, c.get('requestId') ?? ''));

  /*
   * An unrouted path answers with the same shape as everything else. `gone` is
   * spec §8's only 404 and the client's retry policy stops on 404 either way,
   * so a typo'd URL fails immediately instead of being retried five times as a
   * transient error.
   */
  // `NotFoundError` carries an id only for its message, which is never sent —
  // spec §8's 404 body is `{ error: 'gone' }` and nothing else.
  app.notFound((c) =>
    toResponse(new NotFoundError(c.req.path), c.get('requestId') ?? ''),
  );

  /*
   * BEFORE the database middleware, deliberately. A liveness probe that cannot
   * answer without `DATABASE_URL` reports the environment, not the process, and
   * `server/dev.ts` is expected to serve it with no environment at all.
   */
  app.get(`${API_PREFIX}/health`, (c) => c.json({ ok: true }));

  /*
   * ORIGIN FIRST, THEN THE DATABASE, THEN THE SESSION.
   *
   * A forged cross-origin write is refused before anything is resolved or
   * looked up — it is the cheapest possible refusal and it must not depend on
   * a dependency being available. Measured on a booted dev server with an
   * unusable `DATABASE_URL`: with the database middleware first, that 403 was
   * a 500.
   */
  app.use(`${API_PREFIX}/*`, originGuard(deps.origins));

  /*
   * LAZY, AND MEMOISED PER REQUEST. `resolveDb` is not called here; the closure
   * is published and `currentDb(c)` calls it on first use. A request that never
   * touches the database — an unrouted path, an anonymous 401, the 403 above —
   * never builds a client, so its answer cannot be turned into a 500 by an
   * environment it did not need.
   */
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    let handle: Db | null = null;
    c.set('dbFactory', () => (handle ??= resolveDb()));
    await next();
  });

  app.use(`${API_PREFIX}/*`, sessionMiddleware());

  app.route(API_PREFIX, auth);
  app.route(API_PREFIX, posts);
  app.route(API_PREFIX, revisions);
  app.route(API_PREFIX, backup);

  return app;
}

/** The real app, for `api/[[...route]].ts` and `server/dev.ts`. */
export const app = createApp();

export default app;
