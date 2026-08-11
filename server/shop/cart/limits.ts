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
 * Magic-link requests, per address and per IP.
 *
 * The per-address bucket stops one address being mail-bombed. The per-IP bucket
 * is what stops the address list being WALKED — `repo/ratelimit.ts` records that
 * finding for login and it applies identically here: five attempts against each
 * of twenty addresses is a hundred requests and not one of them crosses a
 * per-address threshold.
 */
export const MAGIC_LINK_LIMIT = 5;
export const MAGIC_LINK_IP_LIMIT = 20;
export const MAGIC_LINK_WINDOW_MS = 15 * 60_000;
