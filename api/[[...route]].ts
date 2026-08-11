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
 * `export const runtime = 'nodejs'` and not `'edge'`: password hashing is
 * `node:crypto` `scrypt` (spec §6), which the edge runtime does not have.
 */
export const runtime = 'nodejs';

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
export const HEAD = handle(app);
