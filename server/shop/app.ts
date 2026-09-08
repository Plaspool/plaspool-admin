import { Hono } from 'hono';
import { getEnv } from '../env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';
import type { PointsRedemptionPort } from '../../shared/marketing/redemption';
import type { DiscountCodePort } from '../../shared/marketing/discounts';
import { toResponse } from '../middleware/errors';
import {
  ProductPreconditionFailedError,
  StaleAddOnWriteError,
  StaleProductWriteError,
  VariantPreconditionFailedError,
} from './catalog/errors';
import { ShopCategoryPreconditionFailedError } from './catalog/categories';
import { DuplicateOptionsError, DuplicateSkuError } from './catalog/variants';
import { routes as catalog } from './catalog/routes';
import { createReviewRoutes } from './reviews/routes';
import { queueReviewApprovedEmail } from './orders/review-mail';
import { catalogPort } from './catalog/port';
import { addOnPort } from './catalog/add-ons/port';
import { checkoutPaymentsPort } from './payments/port';
import { orders } from './orders/routes';
import { drainCommerceEvents } from './orders/repo/consumer';
import { adoptGuestOrders } from './orders/repo/orders';
import { cartShopRoutes } from './cart/routes';
import { resolveShopCustomer } from './cart/identity/customers';
import { SHOP_CURRENCY } from './currency';
import { shopAdminRoutes } from './admin/routes';
import { shippingZoneRoutes } from './cart/checkout/shipping-zones-routes';
import { deliverySettingsRoutes } from './settings/routes';
import { notificationSettingsRoutes, pushRoutes } from './notifications/routes';
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

/** What the shop's composition point may be handed from the app's own. */
export interface ShopAppOptions {
  /**
   * SpoolPoints redemption, injected at `server/index.ts` (admin#2). A factory
   * over the request's database handle — see `ShopCartDeps.redemption` for why
   * the frozen port cannot take one itself.
   */
  redemption?: (db: Db) => PointsRedemptionPort;
  /**
   * Discount codes, injected at `server/index.ts` (admin#100 Part B). A factory
   * over the request's handle, for the reason `redemption` is one.
   *
   * Passed straight down to the cart router. The shop app decides nothing about
   * a code; `applyDiscount` and `priceCart` do.
   */
  discounts?: (db: Db) => DiscountCodePort;
}

export function shopApp(opts: ShopAppOptions = {}): Hono<AppEnv> {
  const shop = new Hono<AppEnv>();
  const { redemption, discounts } = opts;

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
        : err instanceof StaleAddOnWriteError
          ? { error: 'stale_write', expected: err.expected, actual: err.actual, addOn: err.addOn }
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
  /* And the review-approved mailer, whose implementation is Orders' because
     Orders owns the outbox it writes to. Reviews declares the port and never
     imports Orders; this root is the only place that knows both halves. */
  shop.route(
    '/',
    createReviewRoutes({
      customer: resolveShopCustomer,
      reviewApprovedMailer: (db, input) => queueReviewApprovedEmail(db, input, Date.now()),
    }),
  );

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
      /* Discount codes (admin#100 Part B), when `server/index.ts` wired them.
         Undefined turns the feature off end to end: the cart view reports
         `discountCodesEnabled: false` and the apply route answers 501. */
      discounts,
      /* Checkout add-ons (spec 2026-09-06): Catalog's port, handed to Cart here
         and nowhere else. The one seam that decides whether the shop offers any. */
      addOns: addOnPort,
      /*
       * THE COMMERCE OUTBOX'S SCHEDULED BACKSTOP (admin#29), AND THIS IS THE
       * SEAM THAT MAKES IT ONE CRON INSTEAD OF TWO.
       *
       * Cart's maintenance cron is the only scheduled thing under `/api/shop`
       * and `vercel.json` is at the Hobby ceiling of two entries, so Orders'
       * sweep is handed to it here rather than given a cron of its own. This
       * file is the shop's composition point — it already mounts all four
       * subsystems — so it is the one place allowed to know that Cart's cron
       * and Orders' consumer belong to the same table. Neither subsystem
       * imports the other.
       *
       * BEFORE THIS LINE NOTHING DRAINED `commerce_events` FOR ORDERS AT ALL.
       * `orders/routes.ts` said "NOTHING SCHEDULES IT YET" of its `/admin/sweep`
       * route, and it was right: production held seven
       * `catalog.variant.published` rows and a `payment.captured` all at
       * `processed_at = NULL, attempts = 0`, and a customer who had genuinely
       * paid had no order.
       *
       * THIS IS THE BACKSTOP, NOT THE PRIMARY PATH. The capture drains inline,
       * and an external cron service calls `GET /api/shop/admin/sweep` by the
       * minute; a daily run with ±59 minutes of jitter earns its place only as
       * the caller that still runs when both of those have stopped.
       */
      sweepEvents: (db, origin) =>
        drainCommerceEvents(db, { origin, redemption }, { limit: 50 }),
      /*
       * SPOOLPOINTS AT THE FREEZE (admin#2). Handed down from `server/index.ts`,
       * which is the only file allowed to know both halves of the seam — spec D9
       * forbids `server/shop/**` importing `server/marketing/**`, so this router
       * receives the port and never constructs one.
       *
       * Absent is a legal deployment: the cart prices exactly as it did before
       * redemption existed.
       */
      redemption,
      /*
       * GUEST ORDERS FOLLOW THEIR BUYER INTO AN ACCOUNT (2026-09-08).
       *
       * The same seam as `sweepEvents` above and for the same reason: signing in
       * is CART's route, `shop_orders` is ORDERS' table, and this file is the
       * only one allowed to know both. Neither subsystem imports the other.
       *
       * Before this line a shopper who checked out as a guest and signed in
       * later had an empty order history for ever — the order kept
       * `customer_id NULL` and the list query has always been scoped by id.
       */
      adoptOrders: adoptGuestOrders,
      /*
       * ═══════════════════════════════════════════════════════════════════════
       * PAYMENTS → CART, SO A FROZEN CHECKOUT CAN BE UNFROZEN.
       *
       * THE SECOND SEAM THIS FILE OWNS, and the same shape as the Catalog one
       * above it: Cart declares `CheckoutPaymentsPort`
       * (`cart/payments-port.ts`), Payments exports an object of that shape
       * (`payments/port.ts`) without naming Cart's type, and this line is the
       * only place in the application that knows both halves. The assignment
       * is where the two are structurally checked against each other — a
       * mismatch is a compile error HERE, which is where somebody wiring the
       * seam is already looking.
       *
       * PAYMENTS IS MOUNTED IN `server/index.ts`, NOT HERE (see the block at
       * the bottom of this file), and that does not matter to this line: what
       * is injected is a port over the request's handle, not a router. The
       * mount decides which URLs answer; this decides what Cart may ask.
       *
       * ═══ WITHOUT THIS LINE THE FEATURE IS OFF, LOUDLY ═══
       *
       * `thawCheckout` refuses with 501 when the port is absent rather than
       * reopening a cart it cannot prove was unpaid — so forgetting this line
       * leaves `POST /checkout/cancel` answering `not_implemented` and address
       * edits answering the same 409 they answer today. That is the deliberate
       * inverse of the trap admin#27 recorded, where an unwired `CheckoutPort`
       * let the highest-severity route in the system run and quietly do
       * nothing. `composition.test.ts` drives this through the real
       * `createApp()` for the reason that file exists: Cart's own suites
       * inject their own port and would stay green with this line deleted.
       * ═══════════════════════════════════════════════════════════════════════
       */
      payments: checkoutPaymentsPort,
    }),
  );

  /*
   * SHIPPING ZONE ADMIN — `/admin/shipping-zones`, `/admin/shipping-options`
   * (admin#19). Auth-gated per route inside the router itself, exactly as
   * Catalog's `/admin/categories` and the dashboard's read surface are.
   */
  shop.route('/', shippingZoneRoutes);

  /*
   * DELIVERY SETTINGS — `/admin/delivery-settings` (migration 0760). The switch
   * that decides whether checkout asks for a district at all, so it belongs
   * beside the zones and areas it governs rather than in a settings router of
   * its own. `settings` domain, guarded per route inside the router.
   *
   * ITS PUBLIC HALF IS NOT HERE. `GET /api/public/shop/delivery-config` is
   * mounted in `server/index.ts` ABOVE `sessionMiddleware`, because it carries
   * `Cache-Control: public` and must be cookieless by construction — the same
   * split `server/shop/reviews/public.ts` makes and for the same reason.
   */
  shop.route('/', deliverySettingsRoutes);

  /*
   * WHO THE SHOP TELLS WHEN AN ORDER IS PAID — `/admin/notification-settings`
   * (migration 0980). Beside the delivery settings because it is the same kind
   * of object: a CHECK-pinned singleton on the `settings` domain, guarded per
   * route inside its own router.
   *
   * IT HAS NO PUBLIC HALF AT ALL, unlike the delivery settings above. Nothing a
   * shopper renders depends on this row — it decides which of OUR addresses get
   * an email — so there is nothing to mount above `sessionMiddleware`.
   */
  shop.route('/', notificationSettingsRoutes);
  /* Web Push device registration (migration 1040). A SEPARATE router from the
     settings beside it because its permissions prefix is different — `orders`,
     not `settings`: whether a packer's own phone buzzes is not an owner-only
     decision. See `server/middleware/permissions.ts`. */
  shop.route('/', pushRoutes);

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
