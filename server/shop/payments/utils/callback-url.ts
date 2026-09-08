import { DEFAULT_STOREFRONT_ORIGIN, storefrontOrigin } from '../../storefront-url';

/**
 * Where Paystack sends the customer once they have finished paying.
 *
 * IN THE REPOSITORY, NOT THE ENVIRONMENT, and unlike the storefront's bridge
 * secret there is nothing to weigh up: this is a public URL. Paystack puts it in
 * a redirect the customer's browser follows, so it is visible in their address
 * bar and their history the moment it is used. Keeping it here means a fresh
 * clone and every preview behave like production, and there is one place to look
 * when the redirect lands somewhere wrong.
 *
 * IT IS PART OF AN EXTERNAL CONTRACT. Renaming the route it points at is not a
 * local refactor — the value is also configured at Paystack's end via the
 * intent's `callback_url`, and an in-flight payment redirects to whatever was
 * sent when the intent was created. Change this and the storefront route
 * together, and expect payments already in flight to land on the old path.
 *
 * WHY NOT THE STOREFRONT ROOT. Paystack redirects the instant the customer
 * finishes, and it does so for an abandoned or failed payment as well as a
 * successful one. The root would show a marketing page with no acknowledgement
 * that anything happened and no way to tell those cases apart. `/checkout/complete`
 * exists to answer that question — and to hold the customer while the order is
 * created, which can lag the payment by up to ten minutes because the outbox
 * sweep does the work rather than the webhook itself.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠  THE HOST WAS HARDCODED HERE, AND THAT BECAME A CROSS-ENVIRONMENT BUG THE
 *    DAY A SECOND STOREFRONT EXISTED (fixed 2026-09-08).
 *
 * This module used to spell `https://plaspool.com` out itself. So a test payment
 * created against `admin.dev.plaspool.com` was stamped with PRODUCTION's
 * callback, and the customer who finished paying was redirected to the LIVE
 * shop. That page called `POST /confirm` against the LIVE API, whose database
 * has never heard of a dev intent — `NotFoundError('intent')`, a 404 — so a
 * payment that genuinely succeeded rendered as a failure, on the wrong site,
 * while the dev order settled silently on the sweep some minutes later.
 *
 * `revalidate-url.ts` had already been bitten by the identical mistake and fixed
 * it by reading `storefrontOrigin()`. Its header argues — correctly — that
 * CATALOG must not import this module, because that would make the catalogue's
 * cache depend on Payments. That argument was about the direction of the arrow,
 * and it left this file as the last hardcoded copy of a string two other modules
 * had already centralised. Reading `shop/storefront-url.ts` from here is the
 * same "child using its parent's value" that made revalidation correct: Payments
 * is not reaching sideways into a peer subsystem, it is asking the shop where
 * its own customer lives.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PAYMENTS_CALLBACK_URL` still overrides the whole thing, so a preview can point
 * somewhere else entirely without a code change.
 */

/**
 * The storefront route that receives the customer back.
 *
 * A PATH, NOT A URL, because the host is now a decision made per request and
 * this half is not. Both storefronts serve this route.
 */
export const CHECKOUT_COMPLETE_PATH = '/checkout/complete';

/**
 * The production callback, as a whole URL.
 *
 * BUILT FROM `DEFAULT_STOREFRONT_ORIGIN`, THE CONSTANT — never from
 * `storefrontOrigin()`, the function. That distinction is the entire subject of
 * `revalidate-url.ts`'s closing warning: a module-scope value derived from an
 * environment-reading function is captured once per container and then serves
 * whatever the lambda happened to start with. This is a constant built from a
 * constant, so it is exactly what its name says and nothing more — the fallback
 * when no request tells us better.
 */
export const DEFAULT_PAYMENTS_CALLBACK_URL = `${DEFAULT_STOREFRONT_ORIGIN}${CHECKOUT_COMPLETE_PATH}`;

/**
 * The callback for the storefront this payment is actually being made from.
 *
 * @param requestOrigin the intent-creation request's `Origin` header. The
 * storefront's browser is the caller, so this is the one place in the shop where
 * the request's origin genuinely answers "which storefront is this". It is a KEY
 * into a fixed list and never a value — `storefrontOrigin` documents why, and
 * enforces it.
 *
 * A FUNCTION, for the reason above: called per request, reading the environment
 * per request.
 */
export function paymentsCallbackUrl(requestOrigin?: string): string {
  return `${storefrontOrigin(requestOrigin)}${CHECKOUT_COMPLETE_PATH}`;
}
