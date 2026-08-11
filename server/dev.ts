/**
 * The local API server. `npm run dev:api`, and half of `npm run dev:all`.
 *
 * `package.json` has pointed `dev:api` at this file since Task 1, but the file
 * did not exist — so `npm run dev:api` and `npm run dev:all` both died with
 * `Cannot find module server/dev.ts`, and `dev:all` took the Vite dev server
 * down with it under `concurrently`.
 *
 * Deliberately minimal, and deliberately not a placeholder that throws: Task 10
 * mounts the real router by replacing the single `app.route(...)` line below,
 * and every task before it needs `dev:all` to start. `/api/health` is the only
 * route, so this imports neither `./env` nor `./db/client` — a dev server that
 * demands `DATABASE_URL` and `SESSION_SECRET` before it will answer at all
 * would be a worse failure than the one being fixed.
 *
 * The app is exported and `serve()` runs only when this file is the process
 * entrypoint, so `dev.test.ts` can drive it through `app.request()` without
 * binding a port.
 */
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/** Same port `vite.config.ts` proxies `/api` to. */
export const DEV_PORT = 8787;

export const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

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
