/**
 * The STOREFRONT's origin — where a customer lives.
 *
 * ═══ THIS IS NOT `APP_ORIGINS[0]`, AND CONFUSING THE TWO IS A SHIPPED BUG ═══
 * `APP_ORIGINS` is the ADMIN application's allow-list: the origins this Hono app
 * will answer a credentialed request from. Every customer-facing link was being
 * built from `APP_ORIGINS[0]` — so a shipment email sent on 2026-08-21 told the
 * buyer to "view your order" at `https://blog-admin-app-gold.vercel.app/shop/…`,
 * which is the admin dashboard. A customer who follows it sees a login screen for
 * a system they have no account on.
 *
 * The two values answer different questions and only coincide on a localhost dev
 * box, which is exactly why the mistake survived: it is invisible in every test
 * and in every manual check that does not read the delivered link.
 *
 * WHY A CONSTANT AND NOT AN ENVIRONMENT VARIABLE ALONE. Identical reasoning to
 * `payments/utils/callback-url.ts`, which pins the same host: this is a PUBLIC
 * URL that appears in mail the shop sends, so there is no secret to protect, and
 * keeping the default in the repository means a fresh clone and every preview
 * behave like production. `PAYMENTS_CALLBACK_URL`'s history is the argument —
 * that value lived only in the environment, went stale, and pointed paying
 * customers at the admin app for weeks with nothing in the code to contradict it.
 *
 * `STOREFRONT_ORIGIN` still overrides, so a preview can point elsewhere without a
 * code change.
 *
 * NO TRAILING SLASH, and `normalise` enforces it rather than trusting whoever
 * sets the variable. Every caller concatenates a path beginning with `/`; an
 * origin ending in one produces `//shop/orders/…`, which is a protocol-relative
 * path in some clients and a 404 in the rest.
 */

export const DEFAULT_STOREFRONT_ORIGIN =
  'https://plaspool-storefront.uririnathaniel.workers.dev';

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * The origin customer links are built from.
 *
 * READS THE ENVIRONMENT ON EVERY CALL rather than at module load. A module-level
 * `const` is captured once per process, and these functions run inside a Vercel
 * lambda that is reused across invocations — so a value read at import time is
 * the value from whenever the container happened to start. It is also what makes
 * this testable without module-registry games.
 */
export function storefrontOrigin(): string {
  const configured = process.env.STOREFRONT_ORIGIN;
  if (configured !== undefined && configured.trim() !== '') return normalise(configured);
  return DEFAULT_STOREFRONT_ORIGIN;
}

/**
 * A customer's own order page, given the order number and a guest token.
 *
 * ONE PLACE THAT KNOWS THIS PATH. It is part of an external contract — the
 * storefront serves `/shop/orders/:orderNumber` and reads `?token=` — and a mail
 * already delivered cannot be corrected, so the shape is worth centralising even
 * though it is one line.
 */
export function orderUrl(orderNumber: string, token: string): string {
  return (
    `${storefrontOrigin()}/shop/orders/${encodeURIComponent(orderNumber)}` +
    `?token=${encodeURIComponent(token)}`
  );
}
