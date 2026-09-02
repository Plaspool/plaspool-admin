/**
 * The ADMIN's own origin — where a teammate signs in.
 *
 * ═══ THIS IS NOT `APP_ORIGINS[0]`, AND CONFUSING THE TWO IS A SHIPPED BUG ═══
 * `server/shop/storefront-url.ts` opens with that sentence about customer links,
 * and this file exists because the invite mail made the identical mistake one
 * email over — down to the same hostname.
 *
 * `POST /api/invites` built its link from `c.get('origins')[0]`, so on
 * 2026-09-02 an invitation to a new developer read
 * `https://blog-admin-app-gold.vercel.app/#/`. That origin is a real alias of
 * this deployment and serves the app perfectly, which is why it looked fine on
 * the screen that minted it — and it is DEAD ON ARRIVAL for the person who
 * opens it.
 *
 * WHY DEAD, and not merely untidy: Clerk is the only auth, and the production
 * publishable key is domain-locked to `plaspool.com`. On any `*.vercel.app`
 * host Clerk refuses to load — "Production Keys are only allowed for domain
 * plaspool.com" — so the sign-in card never renders. Before Clerk that link
 * would have shown a password form and worked; now the invitee gets a logo on a
 * blank page, with nothing on screen to explain it and nothing in the logs of
 * the person who sent it.
 *
 * `APP_ORIGINS` answers "which origins may send this API a credentialed
 * request". That list legitimately contains every alias. It was never an answer
 * to "where do I tell a human to go", and its ORDER is not a decision anybody
 * made — the first entry is wherever it happened to land in an environment
 * variable.
 *
 * WHY A CONSTANT AND NOT AN ENVIRONMENT VARIABLE ALONE — the same argument
 * `storefront-url.ts` and `payments/utils/callback-url.ts` both make, and both
 * learned the hard way: this is a PUBLIC URL that appears in mail we send, so
 * there is no secret to protect, and keeping the default in the repository
 * means a fresh clone and every preview behave like production. A value that
 * lives only in the environment goes stale silently, with nothing in the code
 * to contradict it.
 *
 * `ADMIN_ORIGIN` still overrides, so a preview can point elsewhere without a
 * code change.
 *
 * NO TRAILING SLASH, enforced here rather than trusted from whoever sets the
 * variable: callers concatenate a path beginning with `/`, and an origin ending
 * in one produces `//#/`.
 */

/**
 * ⚠  THE ADMIN'S OWN DOMAIN, not a `*.vercel.app` alias.
 *
 * `admin.plaspool.com` is a subdomain of `plaspool.com`, which is what makes
 * Clerk's production key work here at all. If this ever moves, it has to move
 * to something Clerk's domain restriction still admits — otherwise every
 * invitation this application sends stops working, and it stops working on the
 * invitee's screen where nobody who could fix it is looking.
 */
export const DEFAULT_ADMIN_ORIGIN = 'https://admin.plaspool.com';

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * The origin invitation links are built from.
 *
 * READS THE ENVIRONMENT ON EVERY CALL rather than at module load, for the
 * reason `storefrontOrigin` gives: a module-level `const` is captured once per
 * process, and these functions run inside a Vercel lambda reused across
 * invocations, so a value read at import time is whatever was set when the
 * container happened to start.
 */
export function adminOrigin(): string {
  const configured = process.env.ADMIN_ORIGIN;
  if (configured !== undefined && configured.trim() !== '') return normalise(configured);
  return DEFAULT_ADMIN_ORIGIN;
}
