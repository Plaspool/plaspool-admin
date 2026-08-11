import { Hono } from 'hono';
import type { AppEnv } from '../app-env';
import { toResponse } from '../middleware/errors';
import {
  ProductPreconditionFailedError,
  StaleProductWriteError,
} from './catalog/errors';
import { routes as catalog } from './catalog/routes';

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

  // ==========================================================================
  // CART / PAYMENTS / ORDERS — append your two lines here.
  //
  //   import { routes as cart } from './cart/routes';
  //   shop.route('/', cart);
  //
  // Mount at '/' like Catalog does, and give your own routes their full path
  // (`/checkout/...`, `/admin/payments/...`). Mounting at a sub-prefix would
  // work equally well; what must not happen is two routers claiming one path,
  // because Hono resolves that by registration order rather than by refusing.
  // ==========================================================================

  return shop;
}
