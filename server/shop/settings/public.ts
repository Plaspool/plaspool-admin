import { Hono } from 'hono';
import { currentDb } from '../../app-env';
import { deliveryConfigFor } from './config';
import { DEFAULT_DELIVERY_SETTINGS, getDeliverySettings } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * The public delivery config — the address form, as data (migration 0760).
 *
 * A SEPARATE ROUTER BECAUSE OF WHERE IT IS MOUNTED, following
 * `server/shop/reviews/public.ts` and `server/marketing/public.ts` to the word:
 * `server/index.ts` mounts this ABOVE `sessionMiddleware`, so `c.get('user')`
 * is structurally `undefined` on every request that reaches this file. That is
 * what makes `Cache-Control: public` safe by CONSTRUCTION rather than by
 * review — a response a shared cache may store and hand to a different reader
 * cannot vary by cookie if the middleware that would resolve one has not run.
 * `server/routes/public.ts` carries the long form of the argument (threat T6).
 *
 * NOTHING HERE IS PER-VIEWER AND NOTHING MAY BECOME SO. Every field is a
 * property of the shop: which questions the form asks, what the limits are,
 * where the district list lives. "Which address did this shopper use last
 * time" is the kind of thing that would be convenient to add here and would
 * hand one shopper's address to another; it belongs below the session
 * middleware, on a route that carries no `Cache-Control: public`.
 *
 * SIXTY SECONDS, NOT THE FIVE MINUTES `MARKETING_CACHE.rewards` USES.
 *
 * For the length of this window a storefront can be rendering the old form
 * while the server has moved on — showing an area picker the shop no longer
 * wants, or omitting one it does. Both are survivable BY DESIGN (`PUT
 * /checkout/addresses` accepts a district in either mode and requires one in
 * neither), and the window is kept short anyway because the flip is a
 * deliberate act somebody is standing at a screen waiting to see.
 */

const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';
const CORS_HEADER = 'access-control-allow-origin';
const CORS_VALUE = '*';

/**
 * NO `Access-Control-Allow-Credentials`, DELIBERATELY, and it is the one header
 * whose ABSENCE is correct here. This response carries no cookie and must not
 * be fetched with one — a credentialed request would make it per-viewer, which
 * is exactly what the mount above `sessionMiddleware` exists to prevent. The
 * storefront fetches it with `credentials: 'omit'`.
 *
 * ⚠️  IT MUST BE FETCHED AS A **SIMPLE** REQUEST — no custom request headers.
 *
 * Nothing in this app answers a CORS preflight for these public routes:
 * `originGuard` waves `OPTIONS` through as a safe method and is mounted BELOW
 * this router anyway, so an `OPTIONS` to this path matches no route and 404s
 * with no CORS headers on it. A plain `fetch(url)` never preflights and works.
 * Adding a `Cache-Control: no-cache` REQUEST header — the cache-busting habit
 * CLAUDE.md §5 recommends elsewhere — would make it non-simple and break it in
 * the browser while every server-side test stayed green. Bust the cache with a
 * shorter TTL, not with a header. (The same is true of every route in
 * `server/shop/reviews/public.ts` and `server/marketing/public.ts`; this note
 * lives here because this is the one a storefront fetches on a code path
 * somebody will be tempted to instrument.)
 */
export function createDeliveryConfigRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/public/shop/delivery-config', async (c) => {
    /*
     * A MISSING ROW IS ANSWERED, NOT 404'd. Migration 0760 seeds it and no
     * route deletes it, so `null` means a hand-run DELETE or a restore from
     * before the migration — and the right answer to that is the form the shop
     * shipped last week, not a checkout the storefront cannot render. The
     * `revision: 0` in the payload is how an operator tells the two apart.
     */
    const settings = (await getDeliverySettings(currentDb(c))) ?? DEFAULT_DELIVERY_SETTINGS;

    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json({ config: deliveryConfigFor(settings) });
  });

  return routes;
}
