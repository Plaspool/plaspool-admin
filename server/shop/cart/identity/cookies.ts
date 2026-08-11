import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { ShopEnv } from '../shop-env';

/**
 * The shop's cookies, and the writer cookie's reasoning copied verbatim
 * (brief §2 says to copy it exactly, so it is copied rather than paraphrased).
 *
 * `__Host-` is not decoration. The prefix is enforced by the browser: a cookie
 * whose name starts with it is rejected unless it is `Secure`, has `Path=/` and
 * carries NO `Domain` attribute. That last one is the point — without it, a
 * subdomain (a preview deployment, a marketing site, anything an attacker gets
 * to host on the registrable domain) can set a cookie that the app then treats
 * as a session, which is session fixation with no XSS required.
 *
 * `SameSite=Lax` rather than `Strict`, for the same reason `session.ts` gives:
 * `Strict` means a link from an email — which is exactly how a magic link and an
 * order-confirmation link arrive — lands the customer on a logged-out shop.
 * `Lax` still withholds the cookie on every cross-site POST, and the `Origin`
 * check in `origin.ts` covers the top-level navigation `Lax` does allow. That
 * guard is registered on `/api/*` and the shop mounts under `/api/shop`, so it
 * already covers these routes; `session.test.ts` asserts it rather than assuming.
 *
 * TWO COOKIES, NOT ONE, and they are separate for a reason that is not
 * cosmetic. The cart cookie identifies a BASKET and the session cookie
 * identifies a PERSON. A customer logging out must lose the person and keep the
 * basket — merging a logged-out browser's cart into the next person to use that
 * browser is how one customer's address ends up on another's order. Keeping them
 * in one cookie would make that impossible to express.
 */

/** The customer identity cookie. NEVER read or written by the writer session. */
export const SHOP_SESSION_COOKIE = '__Host-shop_session';

/** The anonymous cart cookie. Holds a cart id; carries no identity at all. */
export const CART_COOKIE = '__Host-shop_cart';

/**
 * Shared attributes, in ONE object.
 *
 * `clearSessionCookie` in `server/middleware/session.ts` documents why: the
 * attributes on a deletion must match the ones the cookie was set with or the
 * browser treats it as a different cookie and keeps the original. Two literal
 * lists that have to agree is the shape of that bug; one constant is not.
 */
const ATTRS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const;

/**
 * `Max-Age` derived from the row's own expiry rather than fixed, so a cookie
 * never outlives the session it names — an outlived cookie produces a silent
 * "you are logged out" on the next write instead of a clean expiry.
 */
function maxAge(expiresAt: number): number {
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

export function setShopSessionCookie(
  c: Context<ShopEnv>,
  token: string,
  expiresAt: number,
): void {
  setCookie(c, SHOP_SESSION_COOKIE, token, { ...ATTRS, maxAge: maxAge(expiresAt) });
}

export function clearShopSessionCookie(c: Context<ShopEnv>): void {
  deleteCookie(c, SHOP_SESSION_COOKIE, ATTRS);
}

export function shopSessionToken(c: Context<ShopEnv>): string | undefined {
  return getCookie(c, SHOP_SESSION_COOKIE);
}

export function setCartCookie(c: Context<ShopEnv>, cartId: string, expiresAt: number): void {
  setCookie(c, CART_COOKIE, cartId, { ...ATTRS, maxAge: maxAge(expiresAt) });
}

export function clearCartCookie(c: Context<ShopEnv>): void {
  deleteCookie(c, CART_COOKIE, ATTRS);
}

export function cartCookie(c: Context<ShopEnv>): string | undefined {
  return getCookie(c, CART_COOKIE);
}
