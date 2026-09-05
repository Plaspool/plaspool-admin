import { storefrontOrigin } from '../../storefront-url';

/**
 * Where the storefront's cache-purge endpoint lives.
 *
 * THE ORIGIN COMES FROM `storefrontOrigin()`, WHICH IS THE SAME VALUE EVERY
 * CUSTOMER LINK IS BUILT FROM. The default still lives in the repository — see
 * that module's header for why a public URL belongs in code rather than only in
 * the environment — so a fresh clone and every preview still behave like
 * production, and there is no deployment that silently stops purging because
 * somebody forgot a variable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠  THIS WAS A LOCAL CONSTANT PINNED TO `https://plaspool.com`, AND THAT
 *    BECAME A CROSS-ENVIRONMENT BUG THE DAY A SECOND ENVIRONMENT EXISTED.
 *
 * With `admin.dev.plaspool.com` live, a product edited in the DEVELOPMENT admin
 * fired its purge at PRODUCTION's `/api/revalidate`. Two things went wrong at
 * once and neither reported anything:
 *
 *   - the live shop re-rendered catalogue pages nothing had changed, on an
 *     endpoint that is unauthenticated and therefore happy to be called
 *   - the development storefront's own cache was never purged AT ALL, so it
 *     served a stale catalogue until its ISR window ran out — which reads as a
 *     caching bug in the storefront and is not one
 *
 * Both ends answered 200 throughout. The only way to see it was to read the URL.
 *
 * ═══ WHY IMPORTING THIS ONE IS FINE WHEN IMPORTING PAYMENTS' WAS NOT ═══
 * This file used to write the origin out by hand, with a note explaining that
 * pulling it from `payments/utils/callback-url.ts` — which holds the same string
 * — would make Catalog depend on Payments, so a rename over there would break
 * the catalogue's cache. That reasoning was right and still is.
 *
 * It does not apply here. `shop/storefront-url.ts` is not a peer subsystem
 * reaching sideways; it is the shop's own shared answer to "where does the
 * customer live", already depended on by `middleware/origin.ts` for the CORS
 * allow-list and by the mail templates for order links. Catalog reading it is a
 * child using its parent's value, and it is what makes the purge target and the
 * allow-list incapable of disagreeing — which, as two constants holding one
 * string, they eventually did.
 *
 * ═══ IT IS PART OF AN EXTERNAL CONTRACT ═══
 * `/api/revalidate` is the storefront's route and its body grammar
 * (`{"slug": …}` or `{}`) is the storefront's too. Change either end and change
 * this together. The storefront resolves its own hosts from one table
 * (`packages/brand/src/environment.ts`); this is the admin's half of the same
 * arrangement.
 *
 * NO SECRET, NO SIGNATURE, NO BEARER TOKEN — knowingly. The endpoint is
 * unauthenticated today and that is documented as debt on the storefront side.
 * Adding a header here that nothing verifies would leave the next reader
 * believing the endpoint is protected. When the check lands over there, it gets
 * wired here at the same time.
 */

/** The path the storefront serves its purge endpoint on. */
const REVALIDATE_PATH = '/api/revalidate';

/**
 * The purge endpoint for the storefront this deployment belongs to.
 *
 * ⚠  A FUNCTION, NOT A CONSTANT, AND THAT IS THE WHOLE FIX RATHER THAN A STYLE
 * CHOICE. `storefrontOrigin()` reads the environment on EVERY call because these
 * run inside a Vercel lambda that is reused across invocations — a value
 * captured at module scope is whatever the container happened to start with.
 * Rebuilding this as an `export const` from `storefrontOrigin()` would read
 * exactly like a fix, pass a casual review, and reintroduce the same defect one
 * level down.
 */
export function storefrontRevalidateUrl(): string {
  return `${storefrontOrigin()}${REVALIDATE_PATH}`;
}
