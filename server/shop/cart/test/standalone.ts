import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { shopCartRoutes } from '../routes';
import type { ShopCartDeps } from '../routes';
import type { ShopEnv } from '../shop-env';
import type { Db } from '../../../db/client';

/**
 * The cart router with a dependency injected, for the handful of tests that
 * need one.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT THE DEFAULT ═══
 *
 * `server/shop/app.ts` builds the cart router once, with the real `CatalogPort`
 * and no magic-link deliverer, and `createApp()` mounts it. That is the shape
 * production has, so it is the shape almost every route test drives — through
 * `httpClient()`, at `/api/shop/...`, with the whole middleware stack.
 *
 * What that arrangement cannot do is inject. `AppDeps` has no `catalog` and no
 * `deliverMagicLink` field, and `server/index.ts` belongs to Catalog (contract
 * §3), so a test cannot reach past `createApp()` to hand Cart a different
 * dependency. Mounting a SECOND cart router into the same app is not the answer
 * either: Hono resolves two routers claiming one path by registration order
 * rather than by refusing, so the app's own mount silently wins — which is
 * exactly what happened, and what deleted `mountShopCart`.
 *
 * So a test that must inject drives a router that nothing else is competing
 * for. It gives up the origin guard and the shared error handler, which is a
 * real loss and the reason this is used for two tests and not for twenty; what
 * it keeps is the request-scoped database handle and the request id, because
 * every handler reads both.
 */
export function standaloneShop(db: Db, deps: Partial<ShopCartDeps> = {}): Hono<ShopEnv> {
  const app = new Hono<ShopEnv>();

  /*
   * The two `AppEnv` variables Cart's handlers actually read, set exactly as
   * `createApp()` sets them — lazily and memoised per request, so a handler that
   * never touches the database never builds a client (see `server/app-env.ts`).
   */
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    let handle: Db | null = null;
    c.set('dbFactory', () => (handle ??= db));
    await next();
  });

  app.route('/', shopCartRoutes(deps));
  return app;
}
