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

/**
 * ⚠  THE DEVELOPMENT STOREFRONT — a different DATABASE behind it, not a staging
 * copy of the same one.
 *
 * `dev.plaspool.com` is the storefront that talks to `admin.dev.plaspool.com`,
 * whose Preview environment scope carries its own `DATABASE_URL`. The same
 * sentence `admin-url.ts` writes about invitations applies here to money: a URL
 * that names the wrong one of these two is not a broken link, it is a link to
 * the wrong database, and both ends answer 200 while it happens.
 *
 * THE BUG THIS EXISTS FOR (found 2026-09-08 by reading the redirect, which is
 * the only place it is visible). A test payment made against the dev admin was
 * stamped with production's `/checkout/complete` as its Paystack `callback_url`.
 * Paystack redirected the customer to the LIVE shop, which called `/confirm`
 * against the LIVE API, whose database has never heard of that intent — so a
 * successful test payment rendered as a 404 on the wrong site, and the dev order
 * settled minutes later via the sweep with nothing on screen connecting the two.
 *
 * This is `revalidate-url.ts`'s bug wearing a second hat, and it survived that
 * fix because payments held its own hardcoded copy of the same string rather
 * than reading this module.
 */
export const DEV_STOREFRONT_ORIGIN = 'https://dev.plaspool.com';

/**
 * Every hostname a customer of this shop may legitimately be SENT to.
 *
 * Not an allow-list for requests — `middleware/origin.ts` owns that, and
 * `APP_ORIGINS` is where a second storefront is granted the right to CALL this
 * API. This is the far smaller set of addresses fit to put in a redirect or in
 * mail, and membership here grants nothing.
 */
export const STOREFRONT_ORIGINS: readonly string[] = [
  DEFAULT_STOREFRONT_ORIGIN,
  DEV_STOREFRONT_ORIGIN,
];

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * The origin customer links are built from.
 *
 * @param requestOrigin the calling request's `Origin` header, when the caller is
 * a browser on the storefront and there is one. OMIT IT unless the request is
 * genuinely coming FROM the storefront — see the warning below.
 *
 * ═══ THE REQUEST'S ORIGIN IS A KEY INTO `STOREFRONT_ORIGINS`, NEVER A VALUE ═══
 * The same safety property `adminOrigin` spells out, for the same reason. `Host`
 * is attacker-controlled outright and `Origin` is only better, not authoritative
 * — so it is matched by EQUALITY against the constants above and the matched
 * CONSTANT is returned. Anything else is discarded and production stands. The
 * worst a forged header achieves is choosing between two hostnames we own,
 * publish, and would have been content to send anyway.
 *
 * ═══ MOST CALLERS MUST NOT PASS ONE, AND THAT IS NOT AN OVERSIGHT ═══
 * The parameter is optional because for nearly every caller there is no request
 * whose origin means anything:
 *
 *   - order and review mail is sent by the SWEEP, on a cron, with no request in
 *     sight at all
 *   - the catalogue's cache purge runs on an ADMIN save, so the origin in hand
 *     is `admin.dev.plaspool.com` — an admin host, never a member of this list,
 *     correctly discarded
 *   - `configuredOrigins()` is building an allow-list, where reading the
 *     caller's own claim would be circular
 *
 * Passing `c.req.header('Origin')` at one of those sites would look like an
 * improvement and would be wrong. It is right at exactly one kind of site: a
 * request the STOREFRONT made, about the browser that made it. Payment intent
 * creation is that site.
 *
 * READS THE ENVIRONMENT ON EVERY CALL rather than at module load. A module-level
 * `const` is captured once per process, and these functions run inside a Vercel
 * lambda that is reused across invocations — so a value read at import time is
 * the value from whenever the container happened to start. It is also what makes
 * this testable without module-registry games.
 *
 * `STOREFRONT_ORIGIN` still wins over both, so a host not yet listed here can be
 * pointed at without a code change.
 */
export function storefrontOrigin(requestOrigin?: string): string {
  const configured = process.env.STOREFRONT_ORIGIN;
  if (configured !== undefined && configured.trim() !== '') return normalise(configured);

  if (requestOrigin !== undefined && requestOrigin.trim() !== '') {
    const candidate = normalise(requestOrigin);
    const known = STOREFRONT_ORIGINS.find((origin) => origin === candidate);
    if (known !== undefined) return known;
  }

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
