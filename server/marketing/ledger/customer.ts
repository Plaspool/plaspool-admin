/**
 * A CUSTOMER READING THEIR OWN POINTS BALANCE (admin#2).
 *
 * WHY THESE EXIST WHEN `/customers/:email` ALREADY DOES.
 *
 * The routes next door in `./routes.ts` are OPERATOR routes: `auth`-gated, and
 * keyed by an email in the PATH. That is exactly right for an admin screen and
 * exactly wrong for a shopper — a customer holding a `__Host-shop_session` has
 * no writer credential to present, and an endpoint that took an address from the
 * URL would let anyone who could guess one read a stranger's balance and their
 * entire purchase-adjacent history.
 *
 * So the address is never an input here. It is derived from the session, and the
 * only thing a caller can ask for is their own.
 *
 * That gap was invisible until customer accounts existed. They do now.
 *
 * ═══ THE RESOLVER IS A PORT, AND THAT IS SPEC D9 ═══
 *
 * `shop_customers`, `shop_customer_sessions` and the `__Host-shop_session`
 * cookie all belong to Cart. Marketing may not import `server/shop/**`, and a
 * type-only import is still an import — so this file declares the NARROWEST
 * thing it needs (an address, or nobody) and `server/index.ts` hands in Cart's
 * `resolveShopCustomer`, which satisfies it structurally. The same arrangement
 * `OrdersDeps.customer` already uses, for the same reason.
 *
 * THE DEFAULT RESOLVES NOBODY, so a deployment that forgets the injection
 * answers 401 to every caller rather than inventing an identity. That is the
 * discipline `NO_CUSTOMER` established: a route that cannot tell who is asking
 * must not guess.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import { UnauthenticatedError, readQuery, str } from '../../middleware/errors';
import { currentDb } from '../../app-env';
import { foldEmail, getCustomerSummary, listLedger } from './repo';
import { getSettings } from '../settings/repo';
import { resolveLabels } from '../labels';
import type { AppEnv } from '../../app-env';

/**
 * Whoever is signed in, or nobody. **NEVER 401s by itself** — that is the
 * route's decision, not the resolver's, exactly as `CustomerResolver` requires.
 *
 * `email` is nullable because `shop_customers.email` is: a customer row can
 * exist without one. A wallet cannot be found without an address, so this file
 * treats a null email the same as no session at all.
 */
export type PointsCustomerResolver = (
  c: Context<AppEnv>,
) => Promise<{ email: string | null } | null>;

/** The default: nobody is signed in, so every route below answers 401. */
export const NO_POINTS_CUSTOMER: PointsCustomerResolver = () => Promise.resolve(null);

export interface CustomerPointsDeps {
  customer?: PointsCustomerResolver;
  /**
   * The response-side CORS middleware, INJECTED (admin#2).
   *
   * `shopCors()` lives in `server/shop/cart/cors.ts` and spec D9 forbids this
   * subsystem importing it — a type-only import would be an import too. It is
   * also emphatically NOT something to apply at `marketingApp()`'s root: that
   * would hand a credentialed cross-origin surface to every operator route in
   * this subsystem, none of which has been reviewed for one. `server/index.ts`
   * is the only file allowed to know both halves, so it passes the middleware
   * in and this router scopes it to the two customer-facing paths it owns.
   *
   * Absent means no CORS header, which is the correct degraded state for a
   * deployment that has not composed the shop: the routes still work
   * same-origin and simply are not reachable from the storefront's JS.
   */
  cors?: MiddlewareHandler<AppEnv>;
}

/**
 * The same filter and paging the operator route accepts, MINUS anything that
 * could name another customer. Spelled here rather than imported so widening the
 * admin query can never widen this one by accident.
 */
const MyLedgerQuery = z
  .object({
    kind: z.enum(['awards', 'manual', 'redemptions', 'all']).default('all'),
    cursor: str().optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

export function createCustomerPointsRoutes(deps: CustomerPointsDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const resolver = deps.customer ?? NO_POINTS_CUSTOMER;

  /*
   * THE RESPONSE-SIDE CORS HEADER, AND IT IS THE WHOLE REASON THIS BLOCK IS
   * COMMENTED AT ALL.
   *
   * These are called by the storefront's JavaScript from a DIFFERENT ORIGIN with
   * `credentials: 'include'`, which makes `access-control-allow-credentials` the
   * difference between a working feature and one that silently does nothing. It
   * has been missing three separate times in this codebase — reviews, then
   * payments, then orders — and every test passed on every occasion, because the
   * suite drives routes server-side where CORS is never enforced.
   *
   * `/points/*` MATCHES THE BARE `/points` TOO. Measured rather than assumed:
   * `GET /api/shop/orders` is registered as `/orders/*` and returns both headers
   * on the exact path in production.
   *
   * The matching tests assert on RESPONSE HEADERS, never on behaviour, because
   * behaviour is what stayed green through all three outages.
   */
  if (deps.cors) routes.use('/me/points/*', deps.cors);

  /** The address of whoever is asking, or a 401. Never a path parameter. */
  async function requireEmail(c: Context<AppEnv>): Promise<string> {
    const customer = await resolver(c);
    /*
     * A CUSTOMER WITH NO EMAIL IS TREATED AS NO CUSTOMER. Balances are keyed by
     * address and there is nothing to look up, so the alternatives are a 401 or
     * a fabricated empty wallet — and an empty wallet is a lie a customer might
     * act on ("I had points yesterday").
     */
    if (!customer?.email) throw new UnauthenticatedError();
    return foldEmail(customer.email);
  }

  /**
   * The balance, and the words for it.
   *
   * ZEROS FOR AN ADDRESS WITH NO WALLET, NEVER A 404 — the rule the operator
   * route already follows. A customer who has never earned a point is not an
   * error; they are a customer with none, and a 404 would make the storefront
   * render an error state for the most ordinary case there is.
   *
   * THE LABELS TRAVEL WITH THE NUMBER, so the storefront never spells the
   * programme's nouns in its own source. Spec D2 makes every customer-facing
   * noun configuration everywhere else in this subsystem, and a storefront that
   * hardcoded them would be the one surface where renaming the programme
   * silently lies. (This file may not write them either — the grep guard in
   * `no-hardcoded-labels.test.ts` reads comments too, and caught this one.)
   * `resolveLabels(null, …)` is the cross-programme form: a wallet holds points
   * earned under all of them, so there is no single programme to name.
   *
   * `points` IS A COUNT, NOT MONEY. It is a bare integer and deliberately not
   * `{ amount, currency }` — this system already runs two money conventions
   * (order totals are plain minor units, cart money is an object) and a third
   * shape that merely looks like money would invite exactly the wrong reading.
   * What a balance is WORTH depends on the cart it is spent against, because
   * `max_redeem_bps` is a share of an order; only the freeze can answer that.
   */
  routes.get('/me/points', async (c) => {
    const db = currentDb(c);
    const email = await requireEmail(c);
    const [summary, settings] = await Promise.all([
      getCustomerSummary(db, email),
      getSettings(db),
    ]);
    const labels = settings ? resolveLabels(null, settings) : null;

    return c.json({
      points: summary.balance,
      lifetimeEarned: summary.lifetimeEarned,
      pointsLabelSingular: labels?.points.one ?? null,
      pointsLabelPlural: labels?.points.other ?? null,
      /*
       * WHETHER SPENDING IS EVEN OFFERED, so the storefront can decide between
       * reporting a balance and offering a widget that invites a customer to
       * spend it at a checkout that would then refuse. `redemptionEnabled`
       * alone is not the whole answer — `spendable()` also requires the
       * redemption currency to match the cart's — but it is the half that does
       * not need a cart, and the freeze is authoritative either way.
       */
      redemptionEnabled: settings?.redemptionEnabled ?? false,
      minRedeemPoints: settings?.minRedeemPoints ?? null,
    });
  });

  /**
   * Their own history, newest first, cursor-paged — the same shape the operator
   * route returns, because it is the same reader over the same rows with the
   * address supplied differently.
   *
   * Append-only: there is no PATCH and no DELETE for a ledger row anywhere in
   * this subsystem, and certainly not behind a customer session.
   */
  routes.get('/me/points/ledger', async (c) => {
    const db = currentDb(c);
    const email = await requireEmail(c);
    return c.json(await listLedger(db, email, readQuery(c, MyLedgerQuery)));
  });

  return routes;
}
