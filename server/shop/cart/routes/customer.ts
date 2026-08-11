import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../../middleware/errors';
import {
  createCustomerSession,
  destroyCustomerSession,
  findOrCreateCustomerByEmail,
  resolveCustomerSession,
} from '../identity/customers';
import {
  clearShopSessionCookie,
  setShopSessionCookie,
  shopSessionToken,
} from '../identity/cookies';
import { NotImplementedError } from '../errors';
import { currentCustomer, shopClientIp, shopDb, shopLimit } from '../shop-env';
import { MAGIC_LINK_IP_LIMIT, MAGIC_LINK_LIMIT, MAGIC_LINK_WINDOW_MS } from '../limits';
import type { ShopCartDeps } from './deps';
import type { ShopEnv } from '../shop-env';

/**
 * Customer identity (brief §6, contract §7).
 *
 * THE MAGIC LINK IS A STUB, AND IT IS A STUB THAT REFUSES RATHER THAN ONE THAT
 * PRETENDS. `POST /api/shop/customer/session` needs to deliver a token to an
 * address; this application has no mailer and adding one is not this
 * subsystem's job. Two ways to express that were available and only one of them
 * is honest:
 *
 *   * mint a session and return the token in the response body — which is an
 *     unauthenticated account-takeover primitive for any address an attacker
 *     cares to type, and it would have passed every test written against it;
 *   * make delivery an INJECTED dependency with no default, so a deployment
 *     that has not wired one gets a 501 naming the missing feature.
 *
 * The second is what is here. `deliverMagicLink` sits in `AppDeps`-style
 * injection exactly as `db` and `origins` already do, so the seam is visible in
 * the type rather than hidden behind an environment variable, and the tests
 * exercise the whole real path by supplying one.
 *
 * KNOWN LIMITATION, recorded rather than papered over: what is delivered is the
 * session token itself, so a production magic link would carry a live 30-day
 * credential in a URL — exposed to the mail path, to browser history and to
 * `Referer` on the landing page. The correct shape is a single-use exchange
 * token in its own table, and contract §4 allocates no such table to this
 * subsystem. Raised as AMENDMENTS A-006; until it is resolved the default
 * deployment answers 501, so the weak shape is never actually reachable.
 */
export function customerRoutes(deps: ShopCartDeps): Hono<ShopEnv> {
  const routes = new Hono<ShopEnv>();

  /**
   * Who is this? `{ customer: Customer | null }`, never a 401.
   *
   * `customer: null` for a guest rather than a refusal — the same "who is this"
   * versus "must there be someone" split the writer middleware documents.
   */
  routes.get('/customer/me', (c) => c.json({ customer: currentCustomer(c) }));

  /**
   * Start a magic-link sign-in.
   *
   * ALWAYS THE SAME ANSWER, whether or not the address has a customer. A
   * different status or a different body for a known address turns this into a
   * customer-enumeration oracle — the property `routes/auth.ts` exists to hold
   * for writers, and a shop leaks something arguably worse: who has bought
   * something here.
   *
   * Rate-limited on two buckets for the reason `repo/ratelimit.ts` gives: a
   * per-address limit alone lets one host walk an address list without ever
   * crossing a threshold.
   */
  routes.post('/customer/session', async (c) => {
    const body = await readJson(c, SessionBody);
    const ip = shopClientIp(c);
    const email = body.email.trim().toLowerCase();

    await shopLimit(c, `shop-magic:${ip}`, MAGIC_LINK_IP_LIMIT, MAGIC_LINK_WINDOW_MS);
    await shopLimit(c, `shop-magic:${ip}|${email}`, MAGIC_LINK_LIMIT, MAGIC_LINK_WINDOW_MS);

    /*
     * BEFORE the customer row is created, deliberately. Refusing after the
     * insert would leave a customer with no way to reach it and would make the
     * 501 path quietly write rows — and it would make the enumeration answer
     * depend on whether the address already existed.
     */
    if (!deps.deliverMagicLink) throw new NotImplementedError('magic-link delivery');

    const customer = await findOrCreateCustomerByEmail(shopDb(c), email);
    const session = await createCustomerSession(shopDb(c), customer.id);
    await deps.deliverMagicLink({ email, token: session.token, expiresAt: session.expiresAt });

    // 202, and a body that says nothing about whether the address was known.
    return c.json({ sent: true }, 202);
  });

  /**
   * Exchange a delivered token for the cookie.
   *
   * A BAD TOKEN IS A 400, NOT A 401. 401 means "authenticate and try again",
   * which for a magic link is advice the caller cannot act on, and the client's
   * retry policy stops on both — so the difference is purely what the customer
   * is told. `detail: 'token'` names the field and never the value.
   */
  routes.post('/customer/session/redeem', async (c) => {
    const body = await readJson(c, RedeemBody);
    const db = shopDb(c);
    await shopLimit(c, `shop-redeem:${shopClientIp(c)}`, MAGIC_LINK_IP_LIMIT, MAGIC_LINK_WINDOW_MS);

    const customer = await resolveCustomerSession(db, body.token);
    if (!customer) return c.json({ error: 'bad_request', detail: 'token' }, 400);

    /*
     * The cookie is set from the SESSION's expiry, re-read rather than assumed:
     * `resolveCustomerSession` may have just slid the window forward, and a
     * cookie whose `Max-Age` disagrees with the row is a customer who appears
     * logged out while a live session sits in the database.
     */
    setShopSessionCookie(c, body.token, Date.now() + deps.sessionTtlMs);

    // The merge of an anonymous cart into this customer happens in the cart
    // routes, on the next cart read — see `mergeCartsForCustomer`. Doing it here
    // would need this route to know about carts, which is the coupling brief §2
    // warns about.
    return c.json({ customer });
  });

  /**
   * Log out. Idempotent, and it CANNOT fail on an expired session.
   *
   * It clears exactly ONE cookie. `__Host-studio_session` is not touched and
   * neither is `__Host-shop_cart`: logging out is losing the person, not the
   * basket, and destroying the basket here would also destroy the anonymous
   * cart of whoever uses the browser next.
   */
  routes.post('/customer/logout', async (c) => {
    const token = shopSessionToken(c);
    if (token) await destroyCustomerSession(shopDb(c), token);
    clearShopSessionCookie(c);
    return c.json({ ok: true });
  });

  return routes;
}

/**
 * Bounded before it becomes part of a rate-limit key, exactly as
 * `routes/auth.ts` bounds its own: the key is `shop-magic:<ip>|<email>` and
 * `auth_attempts.key` is a primary key, so an unbounded address is an unbounded
 * row. 320 is the RFC 5321 maximum.
 *
 * The FORMAT is deliberately not validated, for the same reason auth does not
 * validate it: a route that rejects a malformed address with a different status
 * from a valid-but-unknown one is the enumeration oracle again, one layer up.
 */
const SessionBody = z.object({ email: str().min(1).max(320) }).strict();

/** 43 base64url characters for 256 bits; bounded so a 10 MB "token" is a 400. */
const RedeemBody = z.object({ token: str().min(1).max(512) }).strict();
