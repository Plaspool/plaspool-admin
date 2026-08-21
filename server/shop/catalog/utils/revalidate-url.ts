/**
 * Where the storefront's cache-purge endpoint lives.
 *
 * IN THE REPOSITORY, NOT THE ENVIRONMENT, for the reason
 * `server/shop/payments/utils/callback-url.ts` gives about the payment callback:
 * there is nothing here to keep secret. It is a public URL on a public Worker,
 * and holding it in the repo means a fresh clone and every preview behave like
 * production, with one place to look when a purge goes somewhere wrong. No
 * variable to set in Vercel, and no deployment that silently stops purging
 * because somebody forgot one.
 *
 * THE ORIGIN IS WRITTEN OUT AGAIN HERE RATHER THAN IMPORTED FROM
 * `payments/utils/callback-url.ts`, WHICH HOLDS THE SAME STRING. Catalog reaching
 * into Payments for a constant would make a subsystem boundary carry a
 * dependency that has nothing to do with either subsystem's job — a rename in
 * Payments would break the catalogue's cache. The cost is that moving the
 * storefront means editing two files, and this comment is where the second one
 * is named.
 *
 * IT IS PART OF AN EXTERNAL CONTRACT. `/api/revalidate` is the storefront's
 * route, and its body grammar (`{"slug": …}` or `{}`) is the storefront's too.
 * Change either end and change this together.
 *
 * NO SECRET, NO SIGNATURE, NO BEARER TOKEN — knowingly. The endpoint is
 * unauthenticated today and that is documented as debt on the storefront side.
 * Adding a header here that nothing verifies would leave the next reader
 * believing the endpoint is protected. When the check lands over there, it gets
 * wired here at the same time.
 */
const STOREFRONT_ORIGIN = 'https://plaspool-storefront.uririnathaniel.workers.dev';

export const STOREFRONT_REVALIDATE_URL = `${STOREFRONT_ORIGIN}/api/revalidate`;
