import type { Context, MiddlewareHandler } from 'hono';
import type { ShopEnv } from './shop-env';

/**
 * Cross-site CORS for the cart and checkout, WITH CREDENTIALS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT IS NOT A COPY OF THE REVIEWS ONE.
 *
 * `server/shop/reviews/routes.ts` already answers a preflight for the one
 * public mutation this app had, and the argument in its header applies here
 * unchanged: the allow-list is `APP_ORIGINS` via `c.get('origins')`, so ONE list
 * decides both "may this origin write" (the guard's 403) and "may this browser
 * read the answer" (these headers); the echo is the specific origin, never `*`.
 *
 * WHAT IS DIFFERENT IS CREDENTIALS. A review submission is anonymous — it
 * carries no cookie, so that file needs none of this. The cart is the opposite:
 * `__Host-shop_cart` IS the basket's identity and `__Host-shop_session` is the
 * customer's, so a cart request without its cookies is a request for somebody
 * else's empty cart. Two consequences follow, and they are not optional:
 *
 *   - `access-control-allow-credentials: true`, or the browser drops the cookie
 *     on the way out and ignores `Set-Cookie` on the way back
 *   - the origin echo can NEVER become `*`. A wildcard with credentials is
 *     refused outright by every browser, so the allow-list is load-bearing for
 *     function as well as for security
 *
 * The caller must also opt in with `credentials: 'include'`; nothing the server
 * sends can make a browser attach cookies it was not asked to attach.
 *
 * PAIRED WITH `SameSite=None` ON THOSE COOKIES (`identity/cookies.ts`), which
 * carries the longer note about what that costs. Neither half works alone: the
 * cookie attribute lets the browser send it cross-site, and these headers let
 * the browser accept the answer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO `access-control-allow-origin` AT ALL FOR AN UNKNOWN ORIGIN — not an empty
 * one, not a wildcard. An absent header is the browser's own refusal and needs
 * no cooperation from this file to be correct; inventing a value would be this
 * file deciding something `APP_ORIGINS` is the authority on.
 */

/** Everything the cart and checkout actually use. `OPTIONS` is the preflight. */
const METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';

/**
 * The only request header the storefront sends that needs permission.
 *
 * `content-type: application/json` is precisely what makes these requests
 * preflight in the first place — a form-encoded body would be a "simple
 * request" and skip it. Listed explicitly rather than reflected back from
 * `Access-Control-Request-Headers`, because reflecting turns the allow-list into
 * whatever the caller asked for.
 */
const HEADERS = 'content-type';

/** A day. The preflight is identical for every cart route, so re-asking is pure
 *  latency on the first write of every session. */
const MAX_AGE = '86400';

function allowedOrigin(c: Context<ShopEnv>): string | null {
  const origin = c.req.header('Origin');
  const allowed = (c.get('origins') as string[] | undefined) ?? [];
  return origin && allowed.includes(origin) ? origin : null;
}

/**
 * Sets the response headers on every cart response, preflight or not.
 *
 * AFTER `await next()`, because the headers belong to the response the handler
 * produced. Setting them first would lose them on any path that replaces the
 * response rather than mutating it.
 *
 * ⚠️  IT DOES NOT COVER `originGuard`'S OWN 403. That guard is installed by
 * `createApp` on `/api/*`, above the shop app, so a request from a disallowed
 * origin is refused before this middleware runs and the browser sees an opaque
 * failure rather than a readable status. Only reachable while `APP_ORIGINS` is
 * misconfigured — `cors.test.ts` pins the behaviour so it is not later mistaken
 * for a regression.
 *
 * `Vary: Origin` on EVERY response, including the ones with no allow header —
 * otherwise a shared cache can store the version computed for a permitted origin
 * and hand it to a different one, which is the same defect in the opposite
 * direction from the reviews router's public caching note.
 */
export function shopCors(): MiddlewareHandler<ShopEnv> {
  return async (c, next) => {
    await next();
    c.header('vary', 'Origin', { append: true });
    const origin = allowedOrigin(c);
    if (!origin) return;
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-credentials', 'true');
  };
}

/**
 * The preflight, for every path under the cart router.
 *
 * `OPTIONS` is in `SAFE_METHODS`, so `originGuard` lets it through to here
 * without an `Origin` check of its own — which is correct: refusing the
 * preflight and refusing the request are the same refusal, and doing it at the
 * preflight only tells the browser less about why.
 *
 * A 204 EITHER WAY. When the origin is not allowed the response simply carries
 * no permission headers, and the browser refuses the real request itself. There
 * is nothing useful to say in a body no page will ever read.
 */
export function shopPreflight(c: Context<ShopEnv>): Response {
  const origin = allowedOrigin(c);
  if (!origin) return c.body(null, 204);
  return c.body(null, 204, {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': METHODS,
    'access-control-allow-headers': HEADERS,
    'access-control-max-age': MAX_AGE,
    /* NO `vary` HERE. `shopCors` appends it on the way out of every response,
       preflight included, and setting it in both places produced a literal
       `Vary: Origin, Origin` in production. Harmless to a cache, which reads the
       field as a set, but it reads as a bug to the next person to look at a
       response header. One writer. */
  });
}
