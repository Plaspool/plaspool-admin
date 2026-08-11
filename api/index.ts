import { handle } from 'hono/vercel';
import { app } from '../server/index';

/**
 * The Vercel entrypoint (spec §2).
 *
 * `api/index.ts`, AND NOT `api/[[...route]].ts`. The bracket form is a
 * **Next.js** convention. Vercel's zero-config `api/` builder does not
 * implement it: it parses `[[...route]]` as ONE dynamic segment whose parameter
 * name is literally `[...route]` and emits
 *
 *     {"src":"^/api/([^/]+)$","dest":"/api/[[...route]]?[...route]=$1"}
 *     {"src":"^/api(/.*)?$","status":404}
 *
 * — so `/api/posts` and `/api/health` reached the function while
 * `/api/auth/login`, `/api/posts/:id` and `/api/posts/:id/publish` were a
 * PLATFORM 404, before any code here ran. Login and every per-post route were
 * unreachable in production while the whole suite passed, because every route
 * test calls `app.request()` and never crosses the platform router.
 * `api/[...route].ts` emits the same one-segment regex, so the bracket form is
 * not the fix at all. One flat function plus an explicit
 * `{"source": "/api/(.*)", "destination": "/api"}` rewrite in `vercel.json` is.
 *
 * THE REWRITE PASSES THE PATH THROUGH UNMODIFIED, which is why every route in
 * `server/index.ts` is registered WITH the `/api` prefix. A request for
 * `/api/auth/login` arrives here as `/api/auth/login`. Mounting the routers at
 * `/auth/login` would 404 everything in production while passing every
 * in-process test, because `app.request('/api/auth/login')` would still be what
 * the suite asks for.
 *
 * A DEFAULT EXPORT, NOT `export const GET = handle(app)`. The named-method form
 * is the **Next.js App Router** convention too, and this is a Vite project
 * whose functions come from the `api/` directory — where Vercel's Node builder
 * looks for a default export and ignores named ones. Written the Next way,
 * every route in the application would 500 in production and pass every test
 * here. One function object handles every method: `handle` returns `(req) =>
 * app.fetch(req)`, which is method-agnostic.
 *
 * NODE, NEVER `'edge'`: password hashing is `node:crypto` `scrypt` (spec §6),
 * which the edge runtime does not have. Node is the default for the `api/`
 * builder and the VERSION is pinned by `engines.node` in `package.json` — NOT
 * by `functions[].runtime` in `vercel.json`, which is the npm package spec of a
 * community runtime (`name@version`). `"nodejs24.x"` there aborted both
 * `vercel build` and `vercel dev` with "Function Runtimes must have a valid
 * version", i.e. nothing could build at all. The export below is what Hono's
 * own Vercel example carries and it documents the requirement next to the code
 * that depends on it.
 */
export const runtime = 'nodejs';

export default handle(app);
