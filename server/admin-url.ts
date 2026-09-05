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
 * ═══ AND A SINGLE CONSTANT IS NOT THE ANSWER EITHER (2026-09-05) ═══
 * The fix above pinned ONE hostname, and this application answers on two. Both
 * are the same Vercel project: `admin.plaspool.com` is its production target,
 * and `admin.dev.plaspool.com` is a preview deployment `scripts/deploy.ts`
 * aliases. Identical code, different environment SCOPE — and the scope is what
 * matters here, because the preview scope's `DATABASE_URL` is the dev database.
 *
 * So an owner working on `admin.dev.plaspool.com` minted an invitation and the
 * mail read `https://admin.plaspool.com/#/`. That is not a broken link; it is a
 * link to THE WRONG DATABASE. The invite row was written to the dev database and
 * exists nowhere else, so the invitee follows the link, signs in against
 * production, and is told they are not on the team — no error, no trace, and the
 * same symptom a stolen dev alias produces, which is a diagnosis nobody enjoys
 * twice.
 *
 * WHY A CONSTANT AND NOT AN ENVIRONMENT VARIABLE ALONE — the same argument
 * `storefront-url.ts` and `payments/utils/callback-url.ts` both make, and both
 * learned the hard way: this is a PUBLIC URL that appears in mail we send, so
 * there is no secret to protect, and keeping the default in the repository
 * means a fresh clone and every preview behave predictably. A value that lives
 * only in the environment goes stale silently, with nothing in the code to
 * contradict it. `ADMIN_ORIGIN` on the Preview scope would have fixed the bug
 * above — and an environment variable nobody set is also the entire reason this
 * file exists, so both hostnames are pinned below where a clone gets them.
 *
 * `ADMIN_ORIGIN` still overrides, so a host that is not yet listed here can be
 * pointed at without a code change.
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

/**
 * ⚠  THE PREVIEW TARGET'S HOST — a different DATABASE, not a staging copy of
 * the same one.
 *
 * `admin.dev.plaspool.com` is aliased onto a preview deployment by
 * `npm run deploy:dev`, and the Preview environment scope carries its own
 * `DATABASE_URL` (`ep-holy-band-…`, against production's `ep-late-math-…`).
 * That is exactly why a link minted here must not point at production: the row
 * it refers to does not exist there.
 *
 * TWO LABELS DEEP, WHICH COSTS SOMETHING. Clerk's `pk_live_` key does accept it
 * — verified 2026-09-05; the domain lock admits a two-level subdomain of
 * plaspool.com — but Cloudflare's Universal SSL does not, so the DNS record has
 * to stay grey-cloud. `scripts/deploy.ts` carries that whole account.
 */
export const DEV_ADMIN_ORIGIN = 'https://admin.dev.plaspool.com';

/**
 * Every hostname this admin is reachable at under a name a human may be SENT
 * to. Not an allow-list for requests — `APP_ORIGINS` is that, and it holds
 * every deploy alias — but the far smaller set of addresses fit to put in mail.
 *
 * Adding a third real admin host is a one-line change here. A `*.vercel.app`
 * preview URL is not one of these and never becomes one: Clerk cannot load on
 * it, so a link there is a blank page with nothing to explain itself.
 */
export const ADMIN_ORIGINS: readonly string[] = [DEFAULT_ADMIN_ORIGIN, DEV_ADMIN_ORIGIN];

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

/**
 * The origin invitation and export links are built from.
 *
 * @param requestOrigin the calling request's `Origin` header, when there is one.
 *
 * ═══ THE REQUEST'S ORIGIN IS A KEY INTO `ADMIN_ORIGINS`, NEVER A VALUE ═══
 * That distinction is the whole safety property, and it is worth spelling out,
 * because "build the link from the request" is precisely the bug the header of
 * this file describes.
 *
 * `Host` is attacker-controlled outright. `Origin` is better — `originGuard`
 * refuses every unsafe method without one drawn from `APP_ORIGINS`, and both
 * callers are POSTs — but `APP_ORIGINS` legitimately holds every `*.vercel.app`
 * alias of this deployment, which is the exact set of hosts where the link
 * would be dead on arrival. A validated origin is still not an answer to "where
 * do I send a human".
 *
 * So the incoming origin is matched by EQUALITY against `ADMIN_ORIGINS` and the
 * matched CONSTANT is what gets returned; anything else is discarded and the
 * production default stands. The worst an attacker who forges the header can
 * achieve is choosing between two hostnames we already own, publish, and would
 * have been content to send anyway.
 *
 * NOTHING IS DERIVED FROM `VERCEL_ENV`, which was the other candidate. It is a
 * system variable a project setting can stop exposing, it would make every PR
 * preview claim the shared dev host, and it says nothing at all when the API
 * runs locally. The host in front of the person clicking the button is the
 * fact; the deployment target is only a proxy for it.
 *
 * READS THE ENVIRONMENT ON EVERY CALL rather than at module load, for the
 * reason `storefrontOrigin` gives: a module-level `const` is captured once per
 * process, and these functions run inside a Vercel lambda reused across
 * invocations, so a value read at import time is whatever was set when the
 * container happened to start.
 */
export function adminOrigin(requestOrigin?: string): string {
  const configured = process.env.ADMIN_ORIGIN;
  if (configured !== undefined && configured.trim() !== '') return normalise(configured);

  if (requestOrigin !== undefined && requestOrigin.trim() !== '') {
    const candidate = normalise(requestOrigin);
    const known = ADMIN_ORIGINS.find((origin) => origin === candidate);
    if (known !== undefined) return known;
  }

  return DEFAULT_ADMIN_ORIGIN;
}
