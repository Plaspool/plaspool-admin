import { handle } from 'hono/vercel';
import { app } from '../server/index';

/**
 * The Vercel entrypoint (spec §2).
 *
 * THE CATCH-ALL PASSES THE PATH THROUGH UNMODIFIED, which is why every route in
 * `server/index.ts` is registered WITH the `/api` prefix. A request for
 * `/api/posts` arrives here as `/api/posts`, not as `/posts`: Vercel's optional
 * catch-all rewrites nothing, it only decides which function runs. Mounting the
 * routers at `/posts` would 404 everything in production while passing every
 * in-process test, because `app.request('/api/posts')` would still be what the
 * suite asks for.
 *
 * A DEFAULT EXPORT, NOT `export const GET = handle(app)`. The named-method form
 * is the **Next.js App Router** convention, and this is a Vite project whose
 * functions come from the `api/` directory — where Vercel's Node builder looks
 * for a default export and ignores named ones. Written the Next way, every
 * route in the application would 500 in production and pass every test here.
 * One function object handles every method: `handle` returns `(req) =>
 * app.fetch(req)`, which is method-agnostic.
 *
 * `runtime = 'nodejs'` and never `'edge'`: password hashing is `node:crypto`
 * `scrypt` (spec §6), which the edge runtime does not have. The authoritative
 * setting for a non-Next project is `functions.runtime` in `vercel.json`; this
 * export is what Hono's own Vercel example carries and it documents the
 * requirement next to the code that depends on it.
 */
export const runtime = 'nodejs';

export default handle(app);
