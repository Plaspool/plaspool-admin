import { Hono } from 'hono';
import { getEnv } from '../env';
import type { AppEnv } from '../app-env';
import { toResponse } from '../middleware/errors';
import {
  ProductPreconditionFailedError,
  StaleProductWriteError,
  VariantPreconditionFailedError,
} from './catalog/errors';
import { ShopCategoryPreconditionFailedError } from './catalog/categories';
import { DuplicateOptionsError, DuplicateSkuError } from './catalog/variants';
import { routes as catalog } from './catalog/routes';
import { createReviewRoutes } from './reviews/routes';
import { catalogPort } from './catalog/port';
import { orders } from './orders/routes';
import { cartShopRoutes } from './cart/routes';
import { resolveShopCustomer } from './cart/identity/customers';
import { SHOP_CURRENCY } from './currency';
import { shopAdminRoutes } from './admin/routes';
import { shippingZoneRoutes } from './cart/checkout/shipping-zones-routes';
import { ShippingZonePreconditionFailedError } from './cart/checkout/shipping-zones-repo';

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
             * A VARIANT DELETE REFUSED BECAUSE IT HAS BEEN ORDERED (issue #18).
             * Same shape as the product branch above, `variant` in place of
             * `product` — the UI's one job here is "this has been sold —
             * archive it instead", which needs the variant that refused, not a
             * fresh read of anything else.
             */
            err instanceof VariantPreconditionFailedError
            ? {
                error: 'precondition_failed',
                operation: err.operation,
                variant: err.variant,
              }
            : /*
             * A CATEGORY CONFLICT CARRIES THE CATEGORY, for the reason the
             * product branch above carries the product: "someone else got there
             * first, here is theirs" is only actionable if the client is told
             * WHICH row won. Both the duplicate-name refusal and the
             * still-in-use delete refusal arrive here, and `operation`
             * distinguishes them — a management screen needs different words for
             * "that name is taken" and "twelve products still use this".
             */
            err instanceof ShopCategoryPreconditionFailedError
            ? {
                error: 'precondition_failed',
                operation: err.operation,
                category: err.category,
              }
            : /*
             * EXACTLY-ONE-FALLBACK-ZONE, refused rather than silently
             * dropped: the constraint `shop_shipping_zones_fallback_uq`
             * (migration 0240) enforces it, and this renders that 23505 as a
             * conflict an admin screen can explain instead of a bare 500.
             */
            err instanceof ShippingZonePreconditionFailedError
            ? { error: 'precondition_failed', operation: err.operation }
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
            : /*
               * The same upgrade for a duplicate option COMBINATION (0010's
               * create-time half): "Colour Black already exists" is a conflict
               * with state, not a malformed field. `summary` is the STORED
               * variant's rendering, so the message can name what was collided
               * with rather than echo what was typed.
               */
              err instanceof DuplicateOptionsError
              ? { error: 'duplicate_options', detail: 'optionValues', summary: err.summary }
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
  /*
   * REVIEWS, WITH THE REAL CUSTOMER RESOLVER INJECTED — the same shape as
   * Cart below and Orders' registry: `createReviewRoutes` defaults to
   * `NO_CUSTOMER`, so a deployment that forgot this line would still submit
   * reviews as a guest rather than 500ing. `resolveShopCustomer` reads
   * `__Host-shop_session` and is Cart's; Reviews never imports Cart directly,
   * only this composition root does.
   */
  shop.route('/', createReviewRoutes({ customer: resolveShopCustomer }));

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
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * `storeCurrency: 'NGN'`, AND WITHOUT IT THE CART HAS NO TOTALS AT ALL.
   *
   * `DEFAULT_STORE_CURRENCY` is `'GBP'` — scaffolding from the cart subsystem's
   * own spec, which was written for a UK shop. This catalogue is priced in NGN
   * (`shop_prices.currency`), so a cart taking the default held NGN lines in a
   * GBP cart and the totals engine refused the mix: `preview` came back **null**
   * on every read, meaning no subtotal, no shipping, no total. Measured in
   * production before this line existed.
   *
   * `money()` refuses to add two currencies, which is the right behaviour and is
   * exactly what surfaced this — the failure was a null preview rather than a
   * silently converted number, which is the direction to be wrong in.
   *
   * SHIPPING ZONES NOW COME FROM THE DATABASE (admin#19), not from
   * `DEFAULT_SHIPPING_ZONES`. That constant is kept only as the empty-database
   * fallback and its contents were rewritten from the UK placeholders to the
   * three Nigerian zones the owner confirmed (Abuja ₦3,000, Lagos ₦10,000, rest
   * of Nigeria ₦10,000 — `server/shop/cart/checkout/shipping.ts`), so a fresh
   * deployment with no `shop_shipping_zones` rows is not wrong either. The
   * checkout routes (`server/shop/cart/routes/checkout.ts`) read the live rows
   * per request through `loadShippingZonesForCheckout`, falling back to this
   * `zones` value only when the table is empty, so an operator can correct a
   * rate without a deploy.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  shop.route(
    '/',
    cartShopRoutes({
      catalog: catalogPort,
      storeCurrency: SHOP_CURRENCY,
      bridgeSecret: getEnv().SHOP_AUTH_BRIDGE_SECRET || undefined,
    }),
  );

  /*
   * SHIPPING ZONE ADMIN — `/admin/shipping-zones`, `/admin/shipping-options`
   * (admin#19). Auth-gated per route inside the router itself, exactly as
   * Catalog's `/admin/categories` and the dashboard's read surface are.
   */
  shop.route('/', shippingZoneRoutes);

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
