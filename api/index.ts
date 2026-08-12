import { handle } from 'hono/vercel';
/*
 * THE BUNDLE, WITH AN EXPLICIT `.js`, AND BOTH HALVES OF THAT MATTER.
 *
 * `@vercel/node` transpiles per file rather than bundling, and keeps every
 * import specifier verbatim. The function's `package.json` is
 * `"type": "module"`, so Node's ESM loader resolves them — and it requires an
 * explicit extension. `from '../server/index'` therefore threw
 * ERR_MODULE_NOT_FOUND at module load on a real deployment, 500ing every route
 * including `/api/health`, while `tsc -b`, `tsx`, Vitest and every
 * `app.request()` route test passed, because none of them go through that
 * loader. See `vite.server.config.ts` for why the answer is one bundled module
 * rather than an extension on each of 145 relative imports.
 *
 * `api-build/server.js` is produced by `npm run build` before functions are
 * built, and is gitignored — it is build output, like `dist/`.
 */
import { app } from '../api-build/server.js';

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

/**
 * NAMED HTTP METHODS, NOT `export default handle(app)` — AND THE COMMENT ABOVE
 * USED TO SAY THE OPPOSITE.
 *
 * It was right when it was written and the platform moved. Vercel's Node
 * launcher now treats a DEFAULT export as the legacy `(req, res) => void`
 * signature: it calls it, and it THROWS AWAY the return value. `handle(app)` is
 * fetch-style — it returns a `Response` — so nothing ever wrote to `res` and
 * every request hung until the function was killed. Measured on a real
 * deployment, `GET /api/health`:
 *
 *     WARN: default export returned a `Response`. The default-export signature
 *     is `(req, res) => void` — returns are ignored. You likely meant the Web
 *     `fetch`-style API.
 *     Vercel Runtime Timeout Error: Task timed out after 30 seconds
 *
 * A HANG, not a crash: 30 s of billed execution per request, no body, and a
 * 504 the client's retry policy treats as transient — so spec §8's five
 * attempts turn one page load into 150 seconds of function time.
 *
 * The launcher's own message names the fix, and it is the form the previous
 * comment dismissed as "the Next.js App Router convention". One handler object
 * is bound to each method rather than one per verb, because `handle` returns a
 * method-agnostic `(req) => app.fetch(req)` — the names are what the launcher
 * dispatches on, not different behaviours.
 *
 * Every method the router actually serves is listed. A missing one is a 405
 * from the platform before any route in `server/index.ts` is consulted, which
 * is invisible to every in-process `app.request()` test in this repository —
 * the same blind spot that let the default export ship in the first place.
 */
const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
