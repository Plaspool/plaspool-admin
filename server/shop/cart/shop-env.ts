import type { Context } from 'hono';
import { currentDb } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { UnauthenticatedError } from '../../middleware/errors';
import { clientIp, limit } from '../../middleware/ratelimit';
import type { Db } from '../../db/client';
import type { Customer } from './identity/customers';

/**
 * The shop's Hono environment: everything the app already carries, plus one key.
 *
 * IT EXTENDS `AppEnv` RATHER THAN REPLACING IT, and that is what makes the two
 * middlewares independent instead of merely adjacent. `dbFactory`, `requestId`,
 * `origins` and — critically — `user` all stay exactly where they were and keep
 * exactly the meaning `server/app-env.ts` gives them. The shop middleware writes
 * ONE key, `customer`, and reads none of the others except `dbFactory`.
 *
 * That is the whole of the "neither may clobber the other" rule in contract §7,
 * expressed in the type system: a shop handler that wrote `c.set('user', …)`
 * would be visible here as an obvious mistake rather than as a subtle one.
 */
export type ShopEnv = {
  Variables: AppEnv['Variables'] & {
    /**
     * Null until `shopSessionMiddleware` runs, and null for a guest — which is
     * the ordinary case, not an error state (contract §7: guest checkout is the
     * default path).
     */
    customer: Customer | null;
  };
};

/** The customer, or null. Guests are normal; most routes take this one. */
export function currentCustomer(c: Context<ShopEnv>): Customer | null {
  return c.get('customer');
}

/**
 * The customer, or a 401.
 *
 * Used by the two routes that genuinely cannot serve a guest — reading and
 * ending a customer session. NOT used by any cart or checkout route: requiring
 * an account to buy is exactly what contract §7 forbids.
 */
export function requireCustomer(c: Context<ShopEnv>): Customer {
  const customer = c.get('customer');
  if (!customer) throw new UnauthenticatedError();
  return customer;
}

/**
 * THE ONE CAST BETWEEN THE TWO ENVIRONMENTS, and everything that needs it goes
 * through the three wrappers below.
 *
 * `ShopEnv['Variables']` is `AppEnv['Variables']` plus one key, so a shop
 * context genuinely IS an app context — but Hono's `Context<E>` is INVARIANT in
 * `E` (its `set` accepts `E['Variables']`, which makes the wider environment
 * unassignable to the narrower one). So `currentDb(c)` does not typecheck from a
 * shop handler even though it is exactly correct at runtime.
 *
 * The alternatives were worse. Casting at each of the ~20 call sites is a cast
 * nobody reads by the fifth one; widening `server/app-env.ts` would edit a file
 * this subsystem does not own (contract §2 R1) and that three other agents
 * depend on. One cast, one comment, three wrappers.
 */
function asAppContext(c: Context<ShopEnv>): Context<AppEnv> {
  return c as unknown as Context<AppEnv>;
}

/** The request-scoped handle, resolved on first use. See `server/app-env.ts`. */
export function shopDb(c: Context<ShopEnv>): Db {
  return currentDb(asAppContext(c));
}

/** Count one attempt against `key`, or throw the 429. */
export function shopLimit(
  c: Context<ShopEnv>,
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  return limit(asAppContext(c), key, max, windowMs);
}

/** The caller's IP as the platform reports it. See `middleware/ratelimit.ts`
 * for exactly what that trusts and why. */
export function shopClientIp(c: Context<ShopEnv>): string {
  return clientIp(asAppContext(c));
}
