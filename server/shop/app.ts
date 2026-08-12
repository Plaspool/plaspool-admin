import { Hono } from 'hono';
import type { AppEnv } from '../app-env';
import { toResponse } from '../middleware/errors';
import {
  ProductPreconditionFailedError,
  StaleProductWriteError,
} from './catalog/errors';
import { DuplicateSkuError } from './catalog/variants';
import { routes as catalog } from './catalog/routes';
import { catalogPort } from './catalog/port';
import { orders } from './orders/routes';
import { cartShopRoutes } from './cart/routes';
import { shopAdminRoutes } from './admin/routes';

/**
 * The shop sub-app — everything under `/api/shop` (contract §10).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED, AND EACH SUBSYSTEM ADDS EXACTLY TWO LINES: one import, one
 * `shop.route(...)`. Created by Catalog because contract §3 makes the `/api/shop`
 * mount in `server/index.ts` Catalog's one-line edit, and that line has to mount
 * something. Contract §11: "Everyone else mounts *into* the shop app."
 *
 * `server/index.ts` mounts THIS, not four routers, so the other three agents
 * never touch `server/index.ts` — which is the point of §3 naming exactly one
 * owner for it.
 *
 * Cart / Payments / Orders: append your two lines at the marker below.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const SHOP_PREFIX = '/shop';

export function shopApp(): Hono<AppEnv> {
  const shop = new Hono<AppEnv>();

  /**
   * Catalog's two conflict errors, rendered with the payload they carry.
   *
   * WHY A LOCAL HANDLER RATHER THAN AN EDIT TO `server/middleware/errors.ts`.
   * That file is not Catalog's (contract §3 lists it read-only), and the two
   * errors here are subclasses of `StaleWriteError` and `PreconditionFailedError`
   * — so a request that escapes this handler still lands on the global one and
   * still becomes the correct 409. This is not a fork of the §8 error table; it
   * is the same rows with the right entity in them.
   *
   * The entity has to be there. Brief §4 requires the conflict to carry "the
   * full current product from a single re-read, so a client's 'load theirs'
   * needs no second request", and the shared classes carry a `Post` — a
   * different shape with different fields. Naming the field `product` is the
   * only version of this that is not a lie. See amendment A-CAT-011.
   *
   * ANYTHING ELSE FALLS THROUGH to `toResponse` untouched, so every other row of
   * the error table — 401, 403, 404, 400, 422, 429, 500 — is answered by the one
   * implementation the whole application shares, and a Catalog route cannot
   * quietly grow its own dialect of them.
   */
  shop.onError((err, c) => {
    const requestId = c.get('requestId') ?? '';
    const body =
      err instanceof StaleProductWriteError
        ? {
            error: 'stale_write',
            expected: err.expected,
            actual: err.actual,
            product: err.product,
          }
        : err instanceof ProductPreconditionFailedError
          ? {
              error: 'precondition_failed',
              operation: err.operation,
              product: err.product,
            }
          : /*
             * A TAKEN SKU IS A CONFLICT WITH EXISTING STATE, not a malformed
             * field, and the difference is the whole of what a caller can do
             * next. It used to arrive as a bare 400 `detail: 'sku'` — the same
             * answer an empty or NUL-bearing SKU gets — so the screen could only
             * say "the sku was refused" and send somebody to inspect characters
             * in a SKU whose sole problem was that it already existed.
             *
             * The `sku` travels with it so the client can name it rather than
             * echo whatever is currently in the input, which by then may have
             * been retyped.
             */
            err instanceof DuplicateSkuError
            ? { error: 'duplicate_sku', detail: 'sku', sku: err.sku }
            : null;

    if (!body) return toResponse(err, requestId);

    return new Response(JSON.stringify({ ...body, requestId }), {
      status: 409,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-request-id': requestId,
      },
    });
  });

  shop.route('/', catalog);

  shop.route('/', orders);

  /*
   * CART + CHECKOUT, with the REAL `CatalogPort` injected.
   *
   * THIS LINE IS THE COMPOSITION ROOT AND THE ONLY PLACE THAT KNOWS BOTH HALVES
   * of the Catalog seam. Contract §5: a port is "consumed by injection, never by
   * direct import of the implementation", and R2 forbids Cart importing anything
   * from `server/shop/catalog/`. Nothing under `server/shop/cart/` does —
   * `resolveShopCartDeps` defaults to `unavailableCatalog()`, which throws on
   * every method, so a deployment that forgets this argument fails loudly rather
   * than quoting prices it invented.
   *
   * Three lines rather than the marker's two, because the dependency is named
   * here on purpose.
   */
  shop.route('/', cartShopRoutes({ catalog: catalogPort }));

  /*
   * THE DASHBOARD'S READ SURFACE — `/admin/stats`, `/admin/customers`,
   * `/admin/inventory`, `/admin/categories` (HANDOFF §2 A4).
   *
   * MOUNTED LAST, AND THE POSITION IS NOT ARBITRARY. Hono resolves two routers
   * claiming one path by registration order, and these four paths sit under the
   * same `/admin` prefix Catalog and Orders already use — so they are registered
   * after both, where a collision would be this router losing rather than this
   * router shadowing an existing route. None of the four collides today
   * (Catalog owns `/admin/products*` and `/admin/variants*`, Orders owns
   * `/admin/orders*`, `/admin/fulfillments*` and `/admin/sweep`), which
   * `server/shop/admin/routes.test.ts` asserts by calling the neighbours after
   * this mount exists rather than by reading the list above and trusting it.
   *
   * NO DEPENDENCIES TO INJECT. Every route in it is a read over tables that
   * already exist — no mailer, no payment port, no customer resolver — so unlike
   * Cart and Orders there is nothing here for a composition root to decide.
   */
  shop.route('/', shopAdminRoutes);

  /*
   * ==========================================================================
   * PAYMENTS IS NOT MOUNTED HERE, AND THE MARKER THAT USED TO INVITE IT IS GONE.
   *
   * It landed in `server/index.ts` instead, for two reasons that only became
   * visible once its routes existed:
   *
   * 1. Its webhook cannot live in this app at all. `shopApp()` is mounted below
   *    `originGuard`, and a provider webhook is a server-to-server POST with no
   *    `Origin` header — a 403 every time. It needs a mount above the guard,
   *    which is a line in `server/index.ts` by definition (AMENDMENTS A-PAY-001).
   * 2. Its other routes carry their own full paths (`/shop/payments/...`), so
   *    mounting them into an app that is itself at `/api/shop` would produce
   *    `/api/shop/shop/payments/...`. Splitting the pair across two files to fix
   *    that would hide the security-relevant ordering between them.
   *
   * So both halves are mounted together in `server/index.ts`, where their
   * relative order to the guard is the thing you read.
   * ==========================================================================
   */

  return shop;
}
