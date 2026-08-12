import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from './db/client';
import type { Db } from './db/client';
import { toResponse } from './middleware/errors';
import { NotFoundError } from './repo/errors';
import { originGuard } from './middleware/origin';
import { sessionMiddleware } from './middleware/session';
import { createAuthRoutes } from './routes/auth';
import { routes as users } from './routes/users';
import { routes as posts } from './routes/posts';
import { routes as revisions } from './routes/revisions';
import { routes as backup } from './routes/backup';
import { routes as categories } from './routes/categories';
import { routes as images } from './routes/images';
import { createEmailRoutes, createUnsubscribeRoutes } from './routes/email';
import { createPublicRoutes } from './routes/public';
import { portMailer } from './shop/orders/mailer';
import { registerOrdersDefaults } from './shop/orders/ports';
import { resendMailer } from './mail/resend';
import { SHOP_PREFIX, shopApp } from './shop/app';
import {
  createPaymentRoutes,
  webhookRoutes as paymentsWebhook,
} from './shop/payments/routes';
import { checkoutPort } from './shop/cart/port';
import { resolveShopCustomer } from './shop/cart/identity/customers';
import { paymentPort } from './shop/payments/port';
import type { Mailer } from './mail/port';
import type { AppEnv } from './app-env';

export type { AppEnv } from './app-env';

/**
 * The app (spec §2).
 *
 * A FACTORY, NOT A MODULE-SCOPE SINGLETON WITH BAKED-IN DEPENDENCIES. Two
 * things force it, and both are properties the plan asks to be proved:
 *
 * - the rate limiter must bound the DEPLOYMENT, not one instance, and the only
 *   honest way to test that is to build two apps over one database and watch
 *   the count carry across them. A singleton holding a module-level handle
 *   cannot express the question.
 * - every suite in this repository runs against its own PGlite. A `getDb()`
 *   baked in at import time would dial Neon, or would need an environment
 *   variable per test file.
 *
 * `export const app` still exists below for the two callers that want the real
 * thing — the Vercel entrypoint and the dev server.
 */

export interface AppDeps {
  /**
   * The handle, or a function returning it. Defaulted to `getDb`.
   *
   * NEVER CALLED AT CONSTRUCTION, and never eagerly per request either: it is
   * invoked by the first `currentDb(c)` of a request and memoised for the rest
   * of it. So importing this module does not demand `DATABASE_URL`, and neither
   * does a request that has no reason to touch the database — see the note on
   * `dbFactory` in `server/app-env.ts` for what that was measured to fix.
   */
  db?: Db | (() => Db);
  /** Exact-match allow-list. Defaults to `APP_ORIGINS` (spec §6). */
  origins?: readonly string[];

  /**
   * Outbound mail, for the password-reset flow. Defaults to `resendMailer()`.
   *
   * INJECTED FOR THE SAME REASON `checkoutPort` IS. A route that mails a
   * credential cannot be tested by having it return the credential — that shape
   * is an unauthenticated account-takeover primitive and it passes every test
   * written against it (`server/shop/cart/routes/customer.ts` has the long
   * version). So the transport is a seam in the type, and the suite supplies a
   * recorder.
   *
   * The default builds nothing and reads nothing at construction, so importing
   * this module still demands no mail configuration — see `server/mail/resend.ts`.
   */
  mailer?: Mailer;
}

/**
 * The prefix, in one constant.
 *
 * Every route in this app is registered under `/api` — the Vercel catch-all
 * passes the path through unmodified and the Vite dev proxy forwards `/api` to
 * port 8787, so a route mounted at `/posts` would be reachable in neither.
 */
export const API_PREFIX = '/api';

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const { db } = deps;
  const resolveDb: () => Db =
    typeof db === 'function' ? (db as () => Db) : db ? () => db : getDb;

  const app = new Hono<AppEnv>();

  /*
   * ORDER EMAIL, WIRED TO A REAL TRANSPORT — the single line HANDOFF §1.11 calls
   * the biggest gap in this repository.
   *
   * `server/shop/orders/*` has a complete transactional outbox: four message kinds,
   * dedupe keys, intents INSERTed in the same statement as the state change, an
   * eight-attempt retry and a CAS claim. It delivered NOTHING, because its default
   * `Mailer` is `LoggingMailer` and nobody had ever called `registerOrdersDeps`.
   * `portMailer` adapts that subsystem's `{ to, subject, body }` to the
   * `{ to, subject, text, html }` shape `server/mail/port.ts` defines, so the
   * transport the password-reset flow already uses now carries order mail too.
   *
   * `registerOrdersDefaults` AND NOT `registerOrdersDeps`, because this line runs
   * inside every server suite: `server/test/http.ts` builds the real `createApp()`,
   * so a last-write-wins registration here would replace a fake a suite had already
   * registered and the suite would go on passing against a recorder nothing called.
   *
   * `deps.mailer ?? resendMailer()` — one transport for the whole deployment, so a
   * suite injecting a recorder for the auth routes gets order mail through the same
   * recorder rather than through a second, invisible one. Neither call reads the
   * environment: `resendMailer()` is lazy by construction (see its header), so this
   * still boots on a deployment with no mail configured.
   */
  /*
   * THE OTHER TWO THIRDS OF THE SAME GAP, wired in the same call.
   *
   * `OrdersDeps` has three seams and this line used to fill one. The other two
   * defaulted to absent, and "absent" is not inert:
   *
   * - `customer` fell back to `NO_CUSTOMER`, so `GET /api/shop/orders` threw
   *   `UnauthenticatedError` for EVERY caller — including one holding a valid
   *   `__Host-shop_session`. A customer could place an order and then never see
   *   it. `resolveShopCustomer` is Cart's, reading the same cookie through the
   *   same `resolveCustomerSession` as `shopSessionMiddleware`, so a session
   *   slides its expiry identically on both paths.
   * - `payments` fell back to `null`, so `orderDetail` short-circuited before it
   *   read `paymentIntentId` and the admin payment panel was null on every order
   *   ever placed. That one is worse than a missing feature: an operator reads a
   *   null panel as "never paid" rather than as "never wired".
   *
   * THIS FILE IS ALLOWED TO KNOW ALL THREE and nothing else is. Contract §2 R3
   * forbids Orders importing Cart or Payments directly, which is exactly why the
   * three arrive as ports; the composition root is where the halves are joined,
   * as the `createPaymentRoutes({ checkout: checkoutPort() })` line below already
   * does for Cart and Payments.
   *
   * `registerOrdersDefaults` AND NOT `registerOrdersDeps`, because this line runs
   * inside every server suite: `server/test/http.ts` builds the real `createApp()`,
   * so a last-write-wins registration here would replace a fake a suite had already
   * registered and the suite would go on passing against a recorder nothing called.
   * Fill-only-absent keeps `server/shop/orders/test/app.ts`'s own resolver winning.
   *
   * `deps.mailer ?? resendMailer()` — one transport for the whole deployment, so a
   * suite injecting a recorder for the auth routes gets order mail through the same
   * recorder rather than through a second, invisible one. Neither call reads the
   * environment: `resendMailer()` is lazy by construction (see its header), so this
   * still boots on a deployment with no mail configured, and `paymentPort` is a
   * plain object that dials nothing until `status()` is called.
   */
  registerOrdersDefaults({
    mailer: portMailer(deps.mailer ?? resendMailer()),
    customer: resolveShopCustomer,
    payments: paymentPort,
  });

  /*
   * FIRST, SO EVERYTHING AFTER IT HAS ONE. Spec §8: every response carries a
   * `requestId`, logged alongside the stack, and a 500 never leaks the stack
   * itself — the id is the only thread between what the caller saw and what the
   * log holds.
   *
   * Minted here and never read from the request. Echoing a caller-supplied
   * `X-Request-Id` would let anyone write arbitrary ids into the log and
   * collide them with somebody else's incident.
   */
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    await next();
    c.res.headers.set('x-request-id', requestId);
  });

  app.onError((err, c) => toResponse(err, c.get('requestId') ?? ''));

  /*
   * An unrouted path answers with the same shape as everything else. `gone` is
   * spec §8's only 404 and the client's retry policy stops on 404 either way,
   * so a typo'd URL fails immediately instead of being retried five times as a
   * transient error.
   */
  // `NotFoundError` carries an id only for its message, which is never sent —
  // spec §8's 404 body is `{ error: 'gone' }` and nothing else.
  app.notFound((c) =>
    toResponse(new NotFoundError(c.req.path), c.get('requestId') ?? ''),
  );

  /*
   * BEFORE the database middleware, deliberately. A liveness probe that cannot
   * answer without `DATABASE_URL` reports the environment, not the process, and
   * `server/dev.ts` is expected to serve it with no environment at all.
   */
  app.get(`${API_PREFIX}/health`, (c) => c.json({ ok: true }));

  /*
   * LAZY, AND MEMOISED PER REQUEST. `resolveDb` is not called here; the closure
   * is published and `currentDb(c)` calls it on first use. A request that never
   * touches the database — an unrouted path, an anonymous 401, the 403 below —
   * never builds a client, so its answer cannot be turned into a 500 by an
   * environment it did not need.
   *
   * IT SITS ABOVE `originGuard` ONLY BECAUSE THE WEBHOOK BELOW DOES. The
   * ordering note this comment used to carry — "origin first, then the
   * database", measured on a booted dev server where a database-first middleware
   * turned a forged-origin 403 into a 500 — is about RESOLVING a handle, and
   * nothing here resolves one. Publishing a closure cannot fail, so the 403 is
   * still the cheapest possible refusal and still does not depend on
   * `DATABASE_URL` being usable.
   */
  app.use(`${API_PREFIX}/*`, async (c, next) => {
    let handle: Db | null = null;
    c.set('dbFactory', () => (handle ??= resolveDb()));
    await next();
  });

  /*
   * THE PAYMENTS WEBHOOK, AND IT IS ABOVE `originGuard` DELIBERATELY.
   *
   * A provider webhook is a server-to-server POST with no `Origin` header, and
   * the guard below refuses exactly that on an unsafe method. Mounted after it,
   * this route is a 403 with zero rows in `shop_payment_events` — measured, and
   * written up as AMENDMENTS A-PAY-001.
   *
   * The exemption costs nothing an attacker can use. CSRF borrows a victim's
   * AMBIENT authority — their cookie — and this route reads no cookie, resolves
   * no session and trusts nothing about the caller: its entire authority is an
   * HMAC-SHA512 over the raw body, which a cross-origin form post cannot
   * produce. It is also one route wide. Its twin on the storefront,
   * `POST /api/shop/payments/intents`, is mounted with everything else below and
   * is still a 403 without an `Origin`.
   *
   * BELOW THE DATABASE FACTORY, because it needs one: `storeEvent` commits the
   * event before the response is acknowledged. It is deliberately ABOVE the
   * session middleware — this route resolves no session and must not, since
   * reading a cookie is the one thing that would make the origin exemption
   * unsafe.
   */
  app.route(API_PREFIX, paymentsWebhook);

  /*
   * UNSUBSCRIBE, AND IT IS ABOVE `originGuard` FOR THE SAME REASON THE WEBHOOK IS.
   *
   * `POST /api/public/unsubscribe?token=` is a mutation with no `Origin` header to
   * offer. RFC 8058 one-click unsubscribe is a server-to-server POST issued by the
   * recipient's mail PROVIDER, and the guard below refuses exactly that on an
   * unsafe method — mounted underneath it, the button in every message we send
   * would be a 403.
   *
   * The exemption costs nothing an attacker can use, and it is the same argument
   * the webhook above sets out. CSRF borrows a victim's AMBIENT authority — their
   * cookie — and this route reads no cookie, resolves no session and trusts nothing
   * about the caller: its entire authority is a 256-bit HMAC in the query string,
   * which a cross-origin form post cannot produce, and anyone who already has the
   * token can call the endpoint directly rather than through a victim's browser.
   *
   * IT IS DELIBERATELY NOT PART OF `createPublicRoutes` BELOW, despite sharing the
   * `/api/public/` prefix. That router exists to be CACHEABLE — every response
   * carries `Cache-Control: public`, which is only safe because the router is
   * mounted above the session middleware and is therefore structurally incapable of
   * varying by cookie (threat T6). A mutation inside it would put "may be stored by
   * a shared cache" and "flips a column" in one file, which is the confusion that
   * router was separated out to prevent. `server/routes/email.ts` carries the long
   * version of this decision.
   *
   * BELOW THE DATABASE FACTORY, because it resolves a subscriber and writes one
   * column. ABOVE `sessionMiddleware`, which is a property rather than an accident:
   * `c.get('user')` is undefined here, so this route cannot come to depend on who is
   * signed in — and the person clicking is, almost by definition, signed in to
   * nothing.
   */
  app.route(API_PREFIX, createUnsubscribeRoutes());

  /*
   * THE PUBLIC READING API, AND IT IS ABOVE `sessionMiddleware` DELIBERATELY.
   *
   * Every response under `/api/public/*` carries `Cache-Control: public`, so it
   * may be stored by a shared cache and handed to a different reader. A public
   * cached response that is ABLE to vary by cookie is therefore one bug away
   * from serving reader A's view to reader B (plan threat T6) — and "we
   * remembered not to read the session" is a convention, not a guarantee.
   *
   * Mounted here, `c.get('user')` is `undefined` on every request that reaches
   * the router: the middleware that would resolve a session has not run and
   * cannot be reached from inside it. The route is STRUCTURALLY incapable of
   * personalising, so the caching is safe by construction rather than by
   * review.
   *
   * ALSO ABOVE `originGuard`, which is irrelevant to it either way: every public
   * route is a GET and the guard returns `next()` for safe methods before it
   * looks at anything. The one cost is that `c.set('origins', …)` never runs for
   * these requests — so `deps.origins` is handed to the router HERE instead.
   * Reading `configuredOrigins()` from inside a handler ignored this app's own
   * allow-list, which made the feed advertise a different host than the one the
   * app was built for.
   *
   * BELOW THE DATABASE FACTORY, because every route here queries.
   */
  app.route(API_PREFIX, createPublicRoutes({ origins: deps.origins }));

  app.use(`${API_PREFIX}/*`, originGuard(deps.origins));

  app.use(`${API_PREFIX}/*`, sessionMiddleware());

  app.route(API_PREFIX, createAuthRoutes({ mailer: deps.mailer }));
  /*
   * THE TEAM ROUTES, and they are a separate router from auth deliberately.
   * `server/routes/auth.ts` is about the credential in front of you — who you
   * are, what you may present, and the enumeration property that shapes every
   * route in it. `/api/users` is about somebody ELSE's account, is owner-only
   * throughout, and needs no mailer, so it takes no part in the factory above.
   */
  app.route(API_PREFIX, users);
  app.route(API_PREFIX, posts);
  app.route(API_PREFIX, revisions);
  app.route(API_PREFIX, backup);
  /*
   * MANAGED CATEGORIES, and it is the only router here that brings its own
   * `onError` — one that renders a `precondition_failed` carrying a category
   * rather than a post, and falls through to `toResponse` for every other row of
   * the §8 table. `app.route()` wraps a sub-app's handlers in its error handler
   * only when the sub-app has a non-default one, so this mount reads exactly like
   * the four above it and behaves differently only for that one error class. The
   * shop app is mounted below on the same principle.
   */
  app.route(API_PREFIX, categories);
  /*
   * Mounted like every other router, and note what that does NOT do: importing
   * this module builds no S3 client. `server/storage/r2.ts` constructs one on
   * first use, so a deployment with no R2 configuration still boots and still
   * serves `GET /api/posts` — the media routes are the only ones that fail, and
   * they fail with a named error rather than taking the import down.
   */
  app.route(API_PREFIX, images);

  /*
   * EMAIL MARKETING — templates, subscribers and broadcasts, under
   * `/api/admin/email/*` and owner-only throughout.
   *
   * A FACTORY, LIKE `createAuthRoutes`, AND FOR THE SAME REASON: a route that
   * delivers a message to an address cannot be tested by having it hand the message
   * back, so the transport is a seam in the type and the suite supplies a recorder.
   * It takes the SAME `deps.mailer` the auth routes take, so a deployment has one
   * mail transport rather than three.
   *
   * It brings its own `onError`, like the categories router: one that renders a
   * `precondition_failed` carrying a broadcast or a template rather than a post,
   * falling through to `toResponse` for every other row of the §8 table.
   *
   * The PUBLIC half of this feature — the unsubscribe link — is a separate router
   * mounted far above, next to the payments webhook. See the note there.
   */
  app.route(API_PREFIX, createEmailRoutes({ mailer: deps.mailer }));

  /*
   * PAYMENTS' STOREFRONT AND ADMIN ROUTES — behind the guard and the session,
   * like everything else, and unlike the webhook above.
   *
   * MOUNTED AT `API_PREFIX` RATHER THAN INTO `shopApp()`, despite the marker in
   * `server/shop/app.ts` inviting the opposite. Payments' routes carry their own
   * full paths (`/shop/payments/intents`, `/shop/admin/payments/...`), and
   * `shopApp()` is itself mounted at `${API_PREFIX}${SHOP_PREFIX}` — so routing
   * them into it yields `/api/shop/shop/payments/intents`. Both mounts are
   * legal Hono; only this one produces contract §10's `/api/shop/*`. It also
   * keeps the pair adjacent to its webhook, which cannot live in the shop app
   * at all because the shop app is mounted below the guard.
   *
   * `createPaymentRoutes` RATHER THAN THE PRE-BUILT `routes` EXPORT, because
   * that export carries the default `unwiredCheckoutPort()` — which rejects
   * every call by design, so a payment attempt against it fails loudly instead
   * of reporting every checkout as missing.
   *
   * THIS IS THE COMPOSITION ROOT, and it is the only place allowed to know both
   * halves of the seam: contract R2 forbids anything under
   * `server/shop/payments/` importing `server/shop/cart/`, and nothing there
   * does — Cart's `checkoutPort()` is handed in from here, exactly as
   * `catalogPort` is handed to Cart in `server/shop/app.ts`.
   */
  app.route(API_PREFIX, createPaymentRoutes({ checkout: checkoutPort() }));

  /*
   * COMMERCE, UNDER `/api/shop` (commerce contract §10). ONE LINE, and it is the
   * only edit this file takes for the whole of commerce — that is why the
   * contract names a single owner for it (§3).
   *
   * `shopApp()` is a sub-app that Cart, Payments and Orders mount THEIR routers
   * into (`server/shop/app.ts`), so four concurrently-built subsystems reach the
   * network through one seam rather than four edits to this file.
   *
   * It inherits everything above it — the request id, the origin guard, the lazy
   * database factory, the session middleware — because it is mounted after them,
   * and it deliberately does not re-declare any of them. The storefront routes
   * are public and the admin routes carry `requireAuth()` per route; the shop
   * app adds nothing to the chain except an `onError` that renders Catalog's two
   * conflict errors with a `product` rather than a `post`, falling through to
   * `toResponse` for every other row of the §8 table.
   */
  app.route(`${API_PREFIX}${SHOP_PREFIX}`, shopApp());

  return app;
}

/** The real app, for `api/[[...route]].ts` and `server/dev.ts`. */
export const app = createApp();

export default app;
