/**
 * The local API server. `npm run dev:api`, and half of `npm run dev:all`.
 *
 * It serves the REAL app — `server/index.ts`, the same object
 * `api/[[...route]].ts` hands to Vercel — rather than a parallel copy of the
 * route table. A dev server that assembles its own middleware chain is a second
 * implementation of the thing most likely to be got wrong, and every
 * disagreement between the two shows up as "works locally".
 *
 * Two properties are load-bearing and both are pinned by `dev.test.ts`:
 *
 * - **it does not import `./env`.** `getEnv()` is called per request, from the
 *   middleware that needs it, so importing this module (or running it with an
 *   empty `.env`) does not fail at boot. `/api/health` is registered before the
 *   database middleware for the same reason: a liveness probe that demands
 *   `DATABASE_URL` reports the environment rather than the process.
 * - **importing it binds no port.** `serve()` runs only when this file is the
 *   process entrypoint, so the suite can drive `app.request()` with no socket
 *   to collide with and no teardown to leak.
 */
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { app } from './index';

/** Same port `vite.config.ts` proxies `/api` to. */
export const DEV_PORT = 8787;

export { app };

/**
 * Vercel serves this app from `api/[[...route]].ts` in production; this file is
 * only the local listener, so a 404 here means "no such route", exactly as it
 * would there.
 */
// `pathToFileURL`, not a string compare: `import.meta.url` percent-encodes, and
// this repo's own path contains a space.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? DEV_PORT);
  serve({ fetch: app.fetch, port });
  // eslint-disable-next-line no-console -- this is a CLI entrypoint
  console.log(`api listening on http://localhost:${port}`);
}

export default app;
