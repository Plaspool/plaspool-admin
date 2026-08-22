import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { toResponse } from '../middleware/errors';
import { renderMarketingError } from './wire';
import { routes as areaRoutes } from './areas/routes';
import { routes as bannerRoutes } from './banners/routes';
import { routes as discountRoutes } from './discounts/routes';
import { routes as ledgerRoutes } from './ledger/routes';
import { createCustomerPointsRoutes } from './ledger/customer';
import type { PointsCustomerResolver } from './ledger/customer';
import { createNotifyRoutes } from './notify/routes';
import { routes as programRoutes } from './programs/routes';
import { routes as returnRoutes } from './returns/routes';
import { createCustomerReturnRoutes } from './returns/customer';
import { routes as settingsRoutes } from './settings/routes';
import { routes as summaryRoutes } from './summary/routes';
import type { AppEnv } from '../app-env';
import type { Mailer } from '../mail/port';

/**
 * The marketing sub-app — everything under `/api/marketing` (spec §Frozen API
 * contract).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE MOUNT IN `server/index.ts`, AND EACH SUBSYSTEM ADDS EXACTLY TWO LINES
 * HERE: one import, one `marketing.route(...)`. The `server/shop/app.ts`
 * arrangement, for the same reason — five task-agents build programs, returns,
 * ledger, banners and discounts against one seam instead of five edits to the
 * composition root, and none of them has to touch a file another stream owns.
 *
 * Programs / Returns / Ledger / Banners / Discounts: append your two lines at
 * the marker below.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const MARKETING_PREFIX = '/marketing';

export interface MarketingAppDeps {
  /**
   * Outbound mail, for `POST /api/marketing/sweep` (spec D6).
   *
   * INJECTED RATHER THAN IMPORTED, the seam `server/mail/port.ts` argues for: a
   * route that delivers a message to a customer's address cannot be tested by
   * having it hand the message back, so the suite drives the real route with a
   * recorder. It is the SAME transport `createApp` gives the auth routes and the
   * email broadcasts, so a deployment has one mailer rather than three and a
   * suite that injects a recorder sees every message this application sends.
   *
   * Optional, and "no transport" is a defined state rather than a crash —
   * whether it arrives absent or arrives as a `resendMailer()` with no API key
   * behind it. Either way the sweep answers `501 mail_not_configured` and the
   * queued intents stay queued, which is the persistent ops banner Stream B
   * renders (spec D6), never a retry loop.
   *
   * Nothing else in this subsystem needs it. The intent rows are written by the
   * transitions that owe them, with their subject and body ALREADY RENDERED from
   * the labels of that instant, so an unconfigured deployment can still inspect
   * a return and award the points — it just has mail waiting.
   */
  mailer?: Mailer;

  /**
   * Who is signed in as a SHOPPER, for `/me/points` (admin#2).
   *
   * A PORT, NOT AN IMPORT. `shop_customers`, `shop_customer_sessions` and the
   * `__Host-shop_session` cookie are Cart's, and spec D9 forbids this subsystem
   * reaching into `server/shop/**` for them. `server/index.ts` hands in Cart's
   * `resolveShopCustomer`, which satisfies the narrow shape
   * `./ledger/customer.ts` declares.
   *
   * Absent means every `/me/*` route answers 401 — honest, and the same
   * discipline `NO_CUSTOMER` set for Orders.
   */
  customer?: PointsCustomerResolver;

  /**
   * The response-side CORS middleware for the `/me/*` routes, and nothing else.
   *
   * Also Cart's, also injected rather than imported, and deliberately NOT
   * applied at this app's root: `marketingApp()` is almost entirely operator
   * routes, and handing them a credentialed cross-origin surface as a side
   * effect of adding two customer ones is exactly the widening
   * `server/shop/orders/routes.ts` refused to make. See `CustomerPointsDeps`.
   */
  cors?: MiddlewareHandler<AppEnv>;
}

export function marketingApp(deps: MarketingAppDeps = {}): Hono<AppEnv> {
  const marketing = new Hono<AppEnv>();

  /**
   * Marketing's own conflict rendering — the `server/shop/app.ts` idiom.
   *
   * A LOCAL HANDLER RATHER THAN AN EDIT TO `server/middleware/errors.ts`, which
   * is not this subsystem's file and which every other router in the application
   * shares. Adding eleven marketing codes to the global table would put this
   * feature's vocabulary in front of routes that will never raise it, and would
   * be an edit to a shared file in a window where two other sessions are
   * building against it.
   *
   * THE TABLE ITSELF LIVES IN `./wire.ts`, because `POST /returns/bulk` needs
   * the same codes PER ITEM — fifty transitions in one request, each with its
   * own outcome, none of which reaches an error handler because the response is
   * a 200 carrying a list of results. A bulk route importing this file would
   * close a cycle, and one spelling the codes itself would be a second catalogue.
   *
   * IT IS SAFE TO ESCAPE. Every class it recognises subclasses a shared one
   * (`server/marketing/errors.ts` sets out which and why), so a marketing
   * error that reaches the global handler instead — a repo function called
   * outside this app, a route mounted somewhere else later — is still a
   * retry-stopping 4xx with the right status, just a blunter code. Nothing here
   * can turn into a 500 by being mounted differently.
   *
   * ANYTHING ELSE FALLS THROUGH to `toResponse` untouched, so 401, 403, 404,
   * 400, 422, 429 and 500 are answered by the one implementation the whole
   * application shares — including the `Retry-After` header on a 429, which is
   * set there and would be lost by a body-only re-render here.
   */
  marketing.onError((err, c) => {
    const requestId = c.get('requestId') ?? '';
    const rendered = renderMarketingError(err);

    if (!rendered) return toResponse(err, requestId);

    return new Response(JSON.stringify({ ...rendered.body, requestId }), {
      status: rendered.status,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-request-id': requestId,
      },
    });
  });

  /*
   * ==========================================================================
   * THE MOUNT MARKER. Two lines per subsystem, as at the top of this file.
   *
   * AN UNROUTED `/api/marketing/anything` IS STILL A 404 `gone` from the
   * application's own `notFound`, and `app.test.ts` pins it. It is worth
   * pinning because the obvious shortcut for a subsystem where nearly every
   * route needs a session is `marketing.use('*', requireAuth())`, and that
   * turns every unrouted path under this prefix into a 401: the guard runs,
   * finds no session, and refuses a request that had no handler to reach.
   * `server/shop/catalog/routes.ts` records the same defect on the blog side.
   * Auth is attached PER ROUTE in this subsystem for that reason.
   *
   * `deps` is consumed at this marker too: the sweep route takes `deps.mailer`,
   * exactly as `server/shop/app.ts` hands `catalogPort` to the cart router at
   * its own mount line. The composition root is where the halves of a seam are
   * joined, and this is marketing's.
   * ==========================================================================
   */

  /*
   * PROGRAMS — contract #1-3. The rewards programs themselves: every word a
   * customer reads, and the two numbers that decide what a return is worth.
   * Reading the list is `requireAuth`; both writes are `requireOwner`.
   */
  marketing.route('/', programRoutes);

  /*
   * SETTINGS — contract #19-20. The cross-program layer: the words for the
   * surfaces that span every program, the redemption economics, and which
   * program the intake defaults to.
   *
   * THE ORDER OF THESE TWO DOES NOT MATTER, because they claim disjoint paths
   * (`/programs*` and `/settings`). Recorded because the next router along will
   * not be so lucky: returns owns `/returns/bulk` AND `/returns/:id`, and Hono
   * resolves two routers claiming one path by registration order — the board's
   * multi-select must register before the parameterised route or it is
   * swallowed by it (spec §Risks; A5 pins the order with its own test).
   */
  marketing.route('/', settingsRoutes);

  /*
   * SERVICE AREAS — contract #6.1. Where the vans go: the board switcher's rows,
   * and the list the intake gate refuses an address against.
   *
   * MOUNTED BEFORE RETURNS because it is what returns now depends on — the
   * intake resolves an area before it writes a row — though the ORDER STILL DOES
   * NOT MATTER to Hono: `/areas*` is disjoint from every path here. Reading is
   * `requireAuth`; both writes are `requireOwner`, because this list decides
   * where the business sends a driver.
   */
  marketing.route('/', areaRoutes);

  /*
   * RETURNS — contract #4-14. The lifecycle and the queue that drives it —
   * every route in this router is `requireAuth`, staff only.
   *
   * IT MOUNTS AFTER THE OTHER TWO AND THE ORDER STILL DOES NOT MATTER, for the
   * reason above: `/returns*` is disjoint from `/programs*` and `/settings`.
   * What DOES matter is the order INSIDE that router, and it is settled there:
   * `POST /returns/bulk` — the board's multi-select — registers above every
   * `/returns/:id` pattern, because `bulk` is a legal value for `:id` and Hono
   * resolves two patterns claiming one path by registration order.
   * `returns/routes.ts` pins it.
   *
   * THE CUSTOMER'S OWN MUTATION IS NOT IN THIS ROUTER. A shopper asking for
   * their own return posts to `/me/returns`, mounted separately below, under
   * their shop session rather than under `requireAuth`'s staff one.
   */
  marketing.route('/', returnRoutes);

  /*
   * LEDGER — contract #15-18. The customer directory, one customer's balance and
   * history, and the manual adjustment that is the only way points are created
   * or destroyed without a return.
   *
   * THE ORDER DOES NOT MATTER HERE EITHER: `/customers*` and `/adjustments` are
   * disjoint from every path above. What this router does share with returns is
   * the discipline that made the order matter there — `/customers` is registered
   * above `/customers/:email` inside it, so a fixed segment can never be
   * swallowed by a parameterised one.
   */
  marketing.route('/', ledgerRoutes);

  /*
   * A CUSTOMER READING THEIR OWN POINTS — `/me/points` and `/me/points/ledger`
   * (admin#2).
   *
   * MOUNTED AFTER `ledgerRoutes` AND DISJOINT FROM IT. Those are the operator
   * routes: `auth`-gated and keyed by an email in the PATH. These are the same
   * two reads with the address taken from the `__Host-shop_session` instead, so
   * a shopper can see their own balance and history and nobody else's. `/me/*`
   * shares no prefix with `/customers*` or `/adjustments`, so ordering is not
   * load-bearing here either.
   *
   * BOTH DEPENDENCIES ARE PORTS, AND THAT IS SPEC D9. The session cookie and the
   * CORS middleware both belong to Cart, which this subsystem may not import —
   * so `server/index.ts`, the one file allowed to know both halves, hands them
   * in. Absent, the routes answer 401 to everybody and carry no CORS header,
   * which is honest rather than a deployment that invents an identity.
   */
  marketing.route(
    '/',
    createCustomerPointsRoutes({ customer: deps.customer, cors: deps.cors }),
  );

  /*
   * A CUSTOMER ASKING FOR THEIR OWN RETURN — `/me/returns` and its list.
   *
   * MOUNTED BESIDE `/me/points` AND DISJOINT FROM IT: `/me/returns*` shares no
   * prefix with `/me/points*`, `/customers*` or `/adjustments`, so registration
   * order is not load-bearing here either.
   *
   * THE SAME TWO PORTS, THE SAME REASON (spec D9). `deps.customer` is now typed
   * `{ id, email } | null` — widened in `./ledger/customer.ts` for exactly this
   * router, which keys a written row by customer id where `/me/points` never
   * needed one. `deps.cors` is Cart's `shopCors()` again, scoped by the
   * receiving router to `/me/returns/*` rather than applied at this app's root.
   */
  marketing.route(
    '/',
    createCustomerReturnRoutes({ customer: deps.customer, cors: deps.cors }),
  );

  /*
   * NOTIFY — contract #27. The outbox's only caller: the sweep the admin's own
   * inspection fires, because nothing schedules one (spec D6).
   *
   * THIS IS WHERE `deps.mailer` IS FINALLY READ, at the composition point the
   * comment on `MarketingAppDeps` promised — the seam declared in A2 and filled
   * here, so the line that supplies a transport stays in `server/index.ts` and
   * no later task has to edit it. A deployment with none answers 501
   * `mail_not_configured` and leaves the queue intact.
   *
   * `/sweep` is disjoint from every path above, so the order does not matter
   * here either.
   */
  marketing.route('/', createNotifyRoutes({ mailer: deps.mailer }));

  /*
   * BANNERS — contract #21-23. The admin half of the only thing in this
   * subsystem the public internet reads.
   *
   * `/banners*` is disjoint from every path above, so the order does not matter
   * here either. What is worth saying instead is where the OTHER half is:
   * `GET /api/public/marketing/banners` is not in this sub-app at all. It is in
   * `./public.ts`, mounted above `sessionMiddleware` so it cannot read a cookie
   * — the two surfaces share `banners/repo.ts` and nothing else, and the
   * read-time schedule predicate lives there so both of them mean the same
   * thing by "live" (spec D8).
   */
  marketing.route('/', bannerRoutes);

  /*
   * DISCOUNTS — contract #24-26. The model, landing ahead of the surface that
   * will redeem it: `computeTotals` never sees one of these rows in v1 and the
   * Discounts screen is an honest placeholder (spec D1).
   *
   * MOUNTED ANYWAY, rather than held back until something redeems a code,
   * because the routes are what make the model real: an unreachable table is a
   * migration nobody can check, while a mounted CRUD surface is one an owner can
   * fill with the season's codes today and one `server/nul-bytes.test.ts` walks
   * with everything else. `/discounts*` is disjoint from every path above, so
   * the order does not matter here either.
   */
  marketing.route('/', discountRoutes);

  /*
   * SUMMARY — contract #28. The Overview's single aggregate read, over four of
   * the tables above.
   *
   * MOUNTED LAST AND DEPENDENT ON NONE OF THEM: it reads their tables directly
   * rather than calling their routes, so it adds no ordering constraint and
   * `/summary` is disjoint from every path above. It is last because it is the
   * only router here that is a VIEW over the others rather than a subsystem of
   * its own — every figure it returns belongs to a table somebody else owns.
   */
  marketing.route('/', summaryRoutes);

  return marketing;
}

/**
 * The public reading surface — re-exported so `server/index.ts` keeps ONE import
 * from this file and needs no edit as the subsystem grows.
 *
 * IT LIVES IN `./public.ts` because of what it is rather than where it is
 * imported from: a cookieless, cacheable router mounted ABOVE
 * `sessionMiddleware` beside `createPublicRoutes`, with a different security
 * posture from every route in the sub-app above. Keeping the two in one file
 * would put "may be stored by a shared cache and handed to another reader" and
 * "resolves a session" in one route table. The long argument, the cache TTLs and
 * the clock seam are all in that file.
 */
export { createMarketingPublicRoutes } from './public';
export type { MarketingPublicDeps } from './public';
