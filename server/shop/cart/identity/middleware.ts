import type { MiddlewareHandler } from 'hono';
import { resolveCustomerSession } from './customers';
import { shopSessionToken } from './cookies';
import { shopDb } from '../shop-env';
import type { ShopEnv } from '../shop-env';

/**
 * Resolve `__Host-shop_session` into a customer, or into `null`.
 * **NEVER a 401 by itself** (contract §7, brief §2).
 *
 * The anonymous twin of `sessionMiddleware()`, and every line of it is a
 * deliberate copy:
 *
 * - **Separating "who is this" from "must there be someone."** That split is
 *   what lets `GET /api/shop/customer/me` answer 401 through the same code path
 *   that lets `POST /api/shop/customer/logout` succeed on an already-expired
 *   session — a logout that 401s leaves the cookie in the browser, which is the
 *   one thing logout exists to prevent. For the shop it does one more thing:
 *   it is what makes guest checkout possible at all. A middleware that refused
 *   anonymous callers would make "a cart exists before any identity does"
 *   unimplementable.
 *
 * - **`currentDb` only when a cookie is present.** Same reason as the writer's:
 *   it keeps an anonymous request from building a database client just to be
 *   told it is anonymous — the difference between a `customer: null` and a 500
 *   on a deployment whose `DATABASE_URL` is wrong. For a storefront that
 *   matters more than for the studio, because almost every shop request IS
 *   anonymous.
 *
 * WHAT IT DOES NOT DO, and each of these is asserted in `session.test.ts`:
 * it does not read, write or clear `__Host-studio_session`; it does not touch
 * `c.get('user')`; and it never queries the `sessions` table, so a writer token
 * presented as a customer token resolves to nothing rather than to a customer.
 */
export function shopSessionMiddleware(): MiddlewareHandler<ShopEnv> {
  return async (c, next) => {
    const token = shopSessionToken(c);
    c.set('customer', token ? await resolveCustomerSession(shopDb(c), token) : null);
    await next();
  };
}
