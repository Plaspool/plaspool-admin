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

/*
 * `mountShopCart(app, deps)` USED TO LIVE HERE AND HAS BEEN DELETED.
 *
 * It existed so Cart's suites could mount these routes into a real `createApp()`
 * while `server/shop/app.ts` had no line for them. Now that it does, the helper
 * had no production caller — and worse, calling it added a SECOND registration
 * of every cart path. Hono resolves that by registration order rather than by
 * refusing, so the app's own mount won and six route tests silently began
 * exercising the real `CatalogPort` while believing they had injected a fake.
 * They failed loudly, which is the only reason this was noticed.
 *
 * Tests now drive the real mount (`/api/shop/...` through `createApp()`), and a
 * test that needs a dependency injected builds a standalone router with
 * `shopCartRoutes(deps)` — see `test/standalone.ts`.
 */

/**
 * The cart router as `server/shop/app.ts` needs it: an `AppEnv` router, ready to
 * mount at the shop app's root.
 *
 * `shopApp()` composes four subsystems into one `Hono<AppEnv>` and knows nothing
 * about `ShopEnv`, so the widening happens HERE — in Cart's own file, once,
 * beside the explanation — rather than in the shared composition root where it
 * would be a bare cast three other agents have to read past.
 *
 * The DEPENDENCY still arrives from the composition root, which is the point of
 * contract §5: `server/shop/app.ts` is the only module that knows both
 * `CatalogPort` and its implementation, and nothing under `server/shop/cart/`
 * imports `server/shop/catalog/` (R2). Called with no argument, this is a
 * storefront wired to `unavailableCatalog()`, which refuses loudly.
 */
export function cartShopRoutes(partial: Partial<ShopCartDeps> = {}): Hono<AppEnv> {
  return asAppRouter(shopCartRoutes(partial));
}

function asAppRouter(app: Hono<ShopEnv>): Hono<AppEnv> {
  return app as unknown as Hono<AppEnv>;
}
