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
 * origin ending in one produces `//account/orders/…`, which is a
 * protocol-relative path in some clients and a 404 in the rest.
 */

/**
 * ⚠  THE SITE'S OWN DOMAIN, not the Worker's generated hostname.
 *
 * This was `plaspool-storefront.uririnathaniel.workers.dev`, which is where the
 * Worker answered before `plaspool.com` was attached to it. Both still resolve
 * to the same deployment, so nothing 404s — which is exactly why this could sit
 * wrong indefinitely. What it costs is not a broken link but a WRONG one: every
 * order email tells a customer their receipt lives at a hostname that is not the
 * shop they bought from, and the day that route stops being served, mail already
 * delivered breaks with it.
 */
export const DEFAULT_STOREFRONT_ORIGIN = 'https://plaspool.com';

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
 * storefront serves `/account/orders/:orderNumber` and reads `?token=` — and a
 * mail already delivered cannot be corrected, so the shape is worth centralising
 * even though it is one line.
 *
 * THIS WAS WRONG UNTIL 2026-08-23. Every order email built `/shop/orders/…`,
 * which 404s — the route this comment used to claim "the storefront serves" does
 * not exist. Verified against the deployed storefront: `/shop/orders/…?token=…`
 * is a 404, `/account/orders/…` is a 200 and reads `?token=` in
 * `apps/storefront/app/(shop)/account/orders/[orderNumber]/page.tsx`. Nothing
 * caught it for the same reason the module doc above describes: it is invisible
 * to any test or check that does not read the delivered link, and the assertion
 * that used to guard this string (`storefront-url.test.ts`) pinned the wrong path
 * with just as much confidence as this comment claimed it.
 */
export function orderUrl(orderNumber: string, token: string): string {
  return (
    `${storefrontOrigin()}/account/orders/${encodeURIComponent(orderNumber)}` +
    `?token=${encodeURIComponent(token)}`
  );
}

/**
 * The storefront's basket page — where `{{basket_url}}` sends the reader of a
 * "not bought yet" nudge.
 *
 * THE PATH IS `/cart`. Verified against the deployed storefront rather than
 * assumed, 2026-09-08: `https://plaspool.com/cart` is a 200; `/basket` and
 * `/bag` are both 404. Same discipline `orderUrl` above records for its own
 * path, and for the same reason — a mail already delivered cannot be
 * corrected, so this is centralised HERE, the one place that knows it, rather
 * than guessed per caller.
 *
 * DOES NOT RESTORE THIS PERSON'S SPECIFIC BASKET. The storefront has no
 * resume-a-cart token today — unlike `orderUrl`, which carries one — so this
 * is the generic basket page. A shopper whose cart is still live in that
 * browser sees it because the storefront keeps its own cart state there; one
 * reading the nudge from a different device, or after clearing storage, sees
 * an empty basket. Inventing a resume token here would be admin code writing
 * a storefront contract it does not own, so this function does not claim to
 * do more than it does.
 */
export function basketUrl(): string {
  return `${storefrontOrigin()}/cart`;
}
