import { Hono } from 'hono';
import { shopSessionMiddleware } from '../identity/middleware';
import { shopRoute } from './errors';
import { customerRoutes } from './customer';
import { cartRoutes } from './cart';
import { checkoutRoutes } from './checkout';
import { resolveShopCartDeps } from './deps';
import type { ShopCartDeps } from './deps';
import type { ShopEnv } from '../shop-env';
import type { AppEnv } from '../../../app-env';

export type { ShopCartDeps } from './deps';

/**
 * The Cart + Checkout sub-app (brief §6).
 *
 * MOUNTED, NOT SELF-MOUNTING. Contract §3 gives `server/index.ts` — the one line
 * that mounts the shop — to the **Catalog** agent, so this file exports
 * something to be mounted and touches nothing outside `server/shop/cart/`.
 * Until Catalog mounts it, these routes are reachable only from Cart's own
 * suites, which mount them into a real `createApp()` and drive them through the
 * whole stack: router, origin guard, session middleware, error handler.
 *
 * `shopSessionMiddleware()` runs before every route, so each one has `customer`
 * resolved and a route added later inherits it rather than having to remember.
 * It never 401s (contract §7), so putting it in front of the public storefront
 * routes costs them nothing.
 *
 * Error mapping is NOT a middleware — see `mapErrors` below and the long note in
 * `routes/errors.ts` for the measurement that settled it.
 *
 * What is NOT here: an origin guard, a request-id middleware, and a database
 * middleware. All three are installed by `createApp()` on `/api/*`, and this
 * mounts under `/api/shop`, so they already cover it — `session.test.ts` asserts
 * the origin guard does rather than assuming. Re-installing them would be a
 * second copy of a decision that has to agree with the first.
 */
export const SHOP_PREFIX = '/api/shop';

export function shopCartRoutes(partial: Partial<ShopCartDeps> = {}): Hono<ShopEnv> {
  const deps = resolveShopCartDeps(partial);
  const built = new Hono<ShopEnv>();

  built.use('*', shopSessionMiddleware());
  built.route('/', customerRoutes(deps));
  built.route('/', cartRoutes(deps));
  built.route('/', checkoutRoutes(deps));

  return mapErrors(built);
}

/**
 * Rebuild the app with every handler wrapped in this subsystem's error mapping.
 *
 * DONE HERE, MECHANICALLY, RATHER THAN AT EACH ROUTE, because a wrapper the
 * author of the next route has to remember is a wrapper the next route will not
 * have — a guard on one surface and not its twin, which is the finding
 * GAUNTLET.md records in every single round. `routes.test.ts` re-reads
 * `app.routes` and fails if any entry is unwrapped, so this cannot rot either.
 *
 * `routes/errors.ts` explains at length why the mapping cannot be a middleware
 * or an `onError`: Hono's `compose` calls the app's `onError` at the frame that
 * threw, so an error never reaches an enclosing `await next()`. Wrapping a
 * MIDDLEWARE entry as well as a handler is harmless — its catch is simply never
 * reached, for that same reason — and wrapping everything is what removes the
 * judgement call.
 */
function mapErrors(src: Hono<ShopEnv>): Hono<ShopEnv> {
  const out = new Hono<ShopEnv>();
  for (const route of src.routes) {
    out.on(route.method, route.path, shopRoute(route.handler));
  }
  return out;
}

/**
 * Mount into an existing app. THE ONLY PLACE THE ENV WIDENING HAPPENS.
 *
 * `ShopEnv` extends `AppEnv` with one variable, so a `Hono<ShopEnv>` is
 * structurally a `Hono<AppEnv>` that also sets `customer` — but Hono's generics
 * are invariant in `Env`, so the assignment needs a cast. It is done here, once,
 * with this comment, rather than at each of the (eventually four) call sites:
 * a cast repeated is a cast nobody reads.
 *
 * Registration order is why this works when called AFTER `createApp()` returns.
 * Hono matches in registration order, and `createApp` installs its `/api/*`
 * middlewares before any router, so a route added later still passes through all
 * of them.
 */
export function mountShopCart(
  app: Hono<AppEnv>,
  partial: Partial<ShopCartDeps> = {},
): void {
  app.route(SHOP_PREFIX, shopCartRoutes(partial) as unknown as Hono<AppEnv>);
}
