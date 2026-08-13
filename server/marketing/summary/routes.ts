import { Hono } from 'hono';
import { currentDb } from '../../app-env';
import { requireAuth } from '../../middleware/session';
import { readSummary } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Contract #28 — `GET /api/marketing/summary`, the Overview's one read.
 *
 * `requireAuth` AND NOT `requireOwner`, per the spec's role matrix: this is the
 * section's front door and everything on it is a workload a writer processes.
 * The two owner-only surfaces (adjustments, program and settings writes) guard
 * themselves at their own routes; a landing screen a writer cannot open would
 * make the rail's first entry a 403 for half the team.
 *
 * ATTACHED PER ROUTE, never `routes.use('*')` — the house rule
 * `server/shop/catalog/routes.ts` records: a router-wide guard turns every
 * unrouted path under the prefix into a 401, which is a 404 wearing the wrong
 * status. This route's absence was itself the defect that put this file here.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

routes.get('/summary', auth, async (c) => {
  /* `Date.now()` at the route, like every other read and write in this
   * subsystem: the repository takes the instant so a test can name it. */
  return c.json(await readSummary(currentDb(c), Date.now()));
});
