import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, str } from '../../../middleware/errors';
import { createCustomerSession, destroyCustomerSession, findOrCreateCustomerByEmail } from '../identity/customers';
import { clearShopSessionCookie, setShopSessionCookie, shopSessionToken } from '../identity/cookies';
import { BadAssertionError, verifyAssertion } from '../identity/bridge';
import { spendAssertion } from '../identity/assertions';
import { NotImplementedError } from '../errors';
import { currentCustomer, shopClientIp, shopDb, shopLimit } from '../shop-env';
import { EXCHANGE_IP_LIMIT, EXCHANGE_WINDOW_MS } from '../limits';
import type { ShopCartDeps } from './deps';
import type { ShopEnv } from '../shop-env';

/**
 * Customer identity (brief §6, contract §7).
 *
 * NEON AUTH OWNS SIGN-IN NOW. The storefront runs its own auth UI against Neon
 * Auth, mints a short-lived, single-use, HMAC-signed assertion naming a
 * verified email, and this subsystem's only job is translating that assertion
 * into `__Host-shop_session` — the cookie every cart and order route already
 * reads. `identity/bridge.ts` carries the format and the reasoning for the
 * shared-secret shape; `identity/assertions.ts` carries the single-use
 * enforcement.
 *
 * THIS RETIRES THE MAGIC-LINK STUB THAT USED TO LIVE HERE. That stub was a
 * deliberate refusal rather than a pretence — `deliverMagicLink` had no
 * default, so an unwired deployment 501'd rather than minting a session it
 * could not deliver — but it never actually delivered anything, because this
 * application has no mailer and adding one was never this subsystem's job
 * (AMENDMENTS A-006 recorded the shape it would have needed: a single-use
 * exchange token in its own table, distinct from the long-lived session it
 * would have mailed). The bridge is that shape, built by the party that
 * actually owns sign-in, so the stub's job is now the mint's job, done
 * upstream where the mailer already exists.
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
   * Exchange a storefront assertion for the session cookie.
   *
   * THE ONLY WAY TO BECOME A SIGNED-IN CUSTOMER. Neon Auth owns sign-in; this
   * route owns nothing but the translation into `__Host-shop_session`, which
   * every cart and order route already reads.
   *
   * A BAD ASSERTION IS A 400, NOT A 401, for the reason the redeem route gave
   * before it: 401 means "authenticate and try again", which is advice the
   * caller cannot act on when the credential was minted elsewhere.
   *
   * A REPLAY ANSWERS EXACTLY AS A FORGERY DOES, deliberately. Distinguishing
   * them would tell an attacker holding a captured assertion whether it was ever
   * real. `assertion_expired` IS distinct, because that one the client can act
   * on by minting a fresh assertion.
   */
  routes.post('/customer/session/exchange', async (c) => {
    const body = await readJson(c, ExchangeBody);
    await shopLimit(
      c,
      `shop-exchange:${shopClientIp(c)}`,
      EXCHANGE_IP_LIMIT,
      EXCHANGE_WINDOW_MS,
    );

    // BEFORE any verification, so an unconfigured deployment answers the same
    // way for every caller — the enumeration argument `mail/port.ts` makes.
    if (!deps.bridgeSecret) throw new NotImplementedError('identity-bridge');

    let assertion;
    try {
      assertion = verifyAssertion(deps.bridgeSecret, body.assertion);
    } catch (err) {
      if (err instanceof BadAssertionError) {
        const detail = err.reason === 'expired' ? 'assertion_expired' : 'assertion';
        return c.json({ error: 'bad_request', detail }, 400);
      }
      throw err;
    }

    // Single-use. A replay lands here and gets the forgery's answer.
    if (!(await spendAssertion(shopDb(c), assertion.jti))) {
      return c.json({ error: 'bad_request', detail: 'assertion' }, 400);
    }

    const customer = await findOrCreateCustomerByEmail(shopDb(c), assertion.email);

    /*
     * ADOPT WHAT THIS PERSON BOUGHT AS A GUEST (2026-09-08).
     *
     * `assertion.email` is verified upstream and has just been spent, so this is
     * the one moment in the application where an address is known to belong to
     * the caller. `adoptGuestOrders` binds it against `customer_id IS NULL`
     * only, so it can never take an order off somebody else and a second
     * exchange adopts nothing.
     *
     * BEST-EFFORT, DELIBERATELY. The session below is the thing the caller
     * asked for; order history is a convenience on top of it. An adoption that
     * failed must not turn a successful sign-in into a 500 the client retries,
     * and the next sign-in will pick the orphans up anyway.
     */
    if (customer.email) {
      await deps
        .adoptOrders?.(shopDb(c), customer.id, customer.email)
        .catch(() => undefined);
    }

    const session = await createCustomerSession(shopDb(c), customer.id);
    setShopSessionCookie(c, session.token, session.expiresAt);
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

/** Bounded so a 10 MB "assertion" is a 400 rather than work. */
const ExchangeBody = z.object({ assertion: str().min(1).max(4096) }).strict();
