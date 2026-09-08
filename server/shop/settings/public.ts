import { Hono } from 'hono';
import { currentDb } from '../../app-env';
import { publicPlaces } from '../logistics/places';
import { activeCourier } from '../logistics/repo';
import { deliveryConfigFor } from './config';
import { DEFAULT_DELIVERY_SETTINGS, getDeliverySettings } from './repo';
import type { AppEnv } from '../../app-env';

/**
 * The public delivery config — the address form, as data (migration 0760) —
 * and the place lists that form picks a delivery zone from (migration 1000).
 *
 * TWO ROUTES, ONE ROUTER, because everything below is an argument about WHERE
 * they are mounted rather than about what they answer, and it applies to both
 * of them identically.
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
 * TEN MINUTES FOR THE PLACE LISTS, not the config's sixty seconds.
 *
 * The two windows measure different things. The config's is short because
 * flipping the address mode is a deliberate act somebody is standing at a
 * screen waiting to see. A courier's list of states and cities moves about once
 * a year and is refreshed by an operator pressing a button, so a stale copy
 * costs nothing a shopper can notice — and the payload is the largest thing
 * this router serves, so caching it is what keeps it cheap.
 */
const PLACES_CACHE = 'public, s-maxage=600, stale-while-revalidate=3600';

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
    /*
     * WHICH COURIER IS SWITCHED ON DECIDES WHETHER THE FORM ASKS FOR A ROUTING
     * CITY AT ALL — only Terminal enforces a city list, and asking a Fez shop's
     * customers to pick from one nothing will check is a question with no
     * answer. `activeCourier` answers `manual` for a missing settings row
     * rather than throwing: this response is what a checkout is rendered from,
     * and a 500 here is a shop that cannot take an order.
     *
     * STILL NOTHING PER-VIEWER. The courier is a property of the shop, like
     * every other field on this payload, so `Cache-Control: public` holds.
     */
    const courier = await activeCourier(currentDb(c));

    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json({ config: deliveryConfigFor(settings, courier) });
  });

  /**
   * WHICH PLACES THE ACTIVE COURIER WILL ACCEPT — the list the address form
   * picks a delivery zone from (migration 1000).
   *
   * BESIDE `delivery-config` AND IN THIS FILE FOR ITS REASONS, not because it
   * is about settings: mounted above `sessionMiddleware`, cookieless by
   * construction, `Cache-Control: public` with no `Allow-Credentials`, and
   * FETCHABLE AS A SIMPLE REQUEST — read the header of this file before adding
   * a request header to it.
   *
   * IT NEVER 404s AND NEVER 500s. An empty cache is `regions: []`, an unknown
   * country is `regions: []`, a shop shipping by hand is `regions: []`, and a
   * missing courier configuration row is `provider: 'manual'`. Every one of
   * those is a storefront falling back to free text — which is exactly what it
   * does today — and any of them as an error would be a shop that cannot take
   * an order because an operator has not pressed a button.
   *
   * `cities: null` IS NOT `cities: {}`. Null means the courier enforces no city
   * list and the shopper may type anything; an empty object would mean every
   * region's list is empty and nothing is acceptable. Fez is the first, and no
   * courier is ever the second.
   */
  routes.get('/public/shop/delivery-places', async (c) => {
    const places = await publicPlaces(currentDb(c), c.req.query('country') ?? '');

    c.header('cache-control', PLACES_CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json(places);
  });

  return routes;
}
