/**
 * Rate limits for the storefront (brief §6).
 *
 * Every one of these goes through `server/middleware/ratelimit.ts`, which keeps
 * its counters in Postgres rather than in module memory — and the reason is
 * sharper here than anywhere else in this app. Serverless instances do not share
 * memory, so an in-process counter bounds one warm instance and nothing else.
 * The endpoints below are anonymous, unauthenticated, cheap to call and write
 * rows, which is the exact profile of the thing an attacker points a loop at.
 *
 * The numbers are choices, not spec, and each is stated with what it is trying
 * to be useless for:
 */

/**
 * Cart creation, per IP.
 *
 * A cart is a row plus a cookie, so an unbounded creator is a storage-exhaustion
 * primitive against the database the shop runs on. Twenty an hour is generous
 * for a household behind one NAT clearing cookies and hopeless for a loop.
 */
export const CART_CREATE_LIMIT = 20;
export const CART_CREATE_WINDOW_MS = 60 * 60_000;

/**
 * Add-to-cart and line edits, per cart.
 *
 * Keyed on the CART and not the IP: a shared office address is one IP and many
 * shoppers, and a limit that punished them for each other would make the shop
 * look broken at exactly the moment it is busiest. Each add-to-cart costs a
 * `CatalogPort.quote()`, so this is also what bounds the load one basket can put
 * on Catalog.
 */
export const CART_WRITE_LIMIT = 120;
export const CART_WRITE_WINDOW_MS = 10 * 60_000;

/**
 * Starting a checkout, per cart.
 *
 * The expensive one: it reserves stock, so an unbounded caller can hold every
 * unit of a popular variant for the whole TTL without ever paying. Reservations
 * are idempotent per cart, so a legitimate customer needs very few.
 */
export const CHECKOUT_START_LIMIT = 10;
export const CHECKOUT_START_WINDOW_MS = 15 * 60_000;

/**
 * The identity-bridge exchange (`POST /customer/session/exchange`), per IP.
 *
 * This used to be two buckets guarding the retired magic-link flow: one per
 * address (stopping one address being mail-bombed) and one per IP (stopping
 * the address list being WALKED — `repo/ratelimit.ts` records that finding for
 * login). The exchange route has no address to bucket on — it verifies a
 * signed assertion, not an email a caller supplies — so only the per-IP shape
 * survives: it bounds how many assertions one caller can throw at the
 * verifier (and, on a failure, at `spendAssertion`'s write) regardless of
 * which identity each one names.
 */
export const EXCHANGE_IP_LIMIT = 20;
export const EXCHANGE_WINDOW_MS = 15 * 60_000;
