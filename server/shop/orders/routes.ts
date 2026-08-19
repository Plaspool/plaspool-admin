import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { shopCors } from '../cart/cors';
import {
  UnauthenticatedError,
  pathParam,
  readJson,
  readJsonOrEmpty,
  readQuery,
  str,
} from '../../middleware/errors';
import { requireAuth, requireOwner } from '../../middleware/session';
import { NotFoundError } from '../../repo/errors';
import { rejectNul } from '../../repo/cursor';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import { drainCommerceEvents } from './repo/consumer';
import { assertCronRequest } from '../cart/cron-auth';
import { requireOrderNumber } from './order-number';
import { mintGuestToken, verifyGuestToken } from './tokens';
import { resolveDeps, type OrdersDeps, type ResolvedDeps } from './ports';
import type { AccessLink } from './mailer';
import {
  cancelOrder,
  getOrderForCustomer,
  getOrderForGuest,
  listAllOrders,
  listCustomerOrders,
  listTimeline,
  readOrder,
  settleOrderFulfilled,
  type Order,
  type OrderLine,
  type OrderRead,
} from './repo/orders';
import {
  cancelFulfillment,
  createFulfillment,
  deliverFulfillment,
  listFulfillments,
  readFulfillment,
  shipFulfillment,
} from './repo/fulfillments';
import { listIntents, sweepEmailIntents } from './repo/emails';
import { MAX_SEARCH_LENGTH, readOrderByNumber, searchOrders } from '../admin/orders';

/**
 * The HTTP surface (brief §6).
 *
 * PATHS ARE RELATIVE TO `/api/shop`. `server/index.ts` mounts `shopApp()` at
 * `${API_PREFIX}${SHOP_PREFIX}` and `server/shop/app.ts` mounts each subsystem's router at
 * `'/'`, "giving your own routes their full path" — so `/orders` here is
 * `/api/shop/orders` on the wire, which is what contract §HTTP asks for. The two lines in
 * `server/shop/app.ts` are the whole of this subsystem's mounting, and
 * `server/index.ts` is untouched (contract §3 makes it the Catalog agent's).
 *
 * `requireAuth()` IS ATTACHED PER ROUTE, NEVER AS `use('*', …)`. Measured in
 * `server/routes/posts.ts` and recorded there: `app.route('/api', …)` flattens a router
 * into its parent, so a blanket `use('*')` here becomes `use('/api/*')` and applies to
 * paths this file has never heard of — an unrouted `/api/nothing-here` answered **401
 * instead of 404**.
 */
export function createOrdersRoutes(construction: OrdersDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /*
   * THE RESPONSE-SIDE CORS HEADER, REGISTERED HERE AND NOT LIFTED TO
   * `shopApp()` (admin#26).
   *
   * Preflights already pass: Cart's `built.options('/*', shopPreflight)`
   * (`cart/routes/index.ts`) catches every `OPTIONS` under `/api/shop/*`,
   * Orders included, since Orders registers no `OPTIONS` handler of its own —
   * so adding one here would be solving a problem that does not exist. What
   * was missing is `access-control-allow-credentials` on the REAL response:
   * `shopCors()` used to be `built.use('*', …)` *inside Cart's router*, which
   * never ran for a sibling mount like this one. `GET /api/shop/orders`
   * therefore came back with no credentials header, and a cross-site browser
   * refused to hand the (successful) response to the storefront's JS —
   * measured against production in the issue.
   *
   * REGISTERED ON THIS ROUTER, NOT ON `shopApp()`. Lifting `shopCors()` to the
   * shop app's root would be the smaller diff and would remove the whole class
   * of "sibling mount forgot CORS" bugs rather than this one instance — but it
   * would also silently hand a credentialed cross-origin surface to
   * `/admin/*`, which is writer-gated and has never been reviewed for that.
   * The writer session cookie is `SameSite=Lax`, so it would not actually
   * travel cross-site today — but that is a second line of defence doing the
   * first line's job, and it would become load-bearing without anyone
   * deciding that on purpose. Widening the credentialed surface is a decision
   * per mount, not a side effect of a refactor — so it is made here, on the
   * two customer-facing routes this router owns, and left unmade for the
   * admin ones in the same file.
   *
   * `<AppEnv>` EXPLICITLY: this router is `Hono<AppEnv>`, not `Hono<ShopEnv>`
   * — `shopCors()` is generic over exactly that difference (see `cors.ts`).
   */
  routes.use('/orders/*', shopCors<AppEnv>());

  /*
   * RESOLVED PER REQUEST, NOT ONCE HERE. `server/shop/app.ts` composes routers with
   * no arguments, so the real `CustomerResolver` arrives through
   * `registerOrdersDeps` — and that may happen before or after this router is
   * constructed, depending on module load order. Resolving per request makes the
   * order irrelevant. Explicit construction deps still win over the registry.
   */
  const deps = () => resolveDeps(construction);
  const auth = requireAuth();

  registerCustomerRoutes(routes, deps);
  registerAdminRoutes(routes, deps, auth);
  return routes;
}

/** A late-bound `ResolvedDeps`. See `createOrdersRoutes`. */
type Deps = () => ResolvedDeps;

// ------------------------------------------------------------------- schemas

/**
 * STRICT, LIKE EVERY OTHER QUERY SCHEMA IN THIS APPLICATION. A mistyped filter that is
 * silently ignored is worse than a refusal: `?statuss=paid` would quietly return every
 * order in the shop and look like a bug in the dashboard.
 *
 * (Note the deliberate contrast with `inbound.ts`, which is `.passthrough()`. The sender
 * there is a peer subsystem contract §6 allows to evolve ahead of this one; the sender here
 * is a client that must be told when it tries to set something it may not.)
 */
const PageQuery = z
  .object({
    cursor: str().optional(),
    /** `pageLimit` decides the range and answers 400 itself; this stops `?limit=abc` NaN-ing. */
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const AdminPageQuery = PageQuery.extend({
  status: z
    .enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded', 'partially_refunded'])
    .optional(),
  /**
   * An EXACT order number or an EXACT email address, and nothing else. The two
   * branches, why neither is a substring match, and why a mistyped order number
   * is an empty page rather than a 400 are all in `server/shop/admin/orders.ts`.
   *
   * Bounded here as well as there so an oversized term is refused by the schema
   * that already refuses every other malformed parameter, with `detail: 'search'`
   * from the same `zodDetail` path as the rest.
   */
  search: str().max(MAX_SEARCH_LENGTH).optional(),
}).strict();

const LookupQuery = z
  .object({ token: str().max(4000).optional() })
  .strict();

const FulfillmentBody = z
  .object({
    lines: z
      .array(
        z
          .object({
            orderLineId: str().min(1).max(300),
            qty: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    carrier: str().max(300).nullable().optional(),
    trackingNumber: str().max(300).nullable().optional(),
  })
  .strict();

/**
 * `pending` IS ABSENT ON PURPOSE. A fulfilment starts `pending` and every transition from
 * it is forward-only: `shipped`, `delivered`, or `cancelled`. Offering `pending` would be
 * offering an un-ship, which the database refuses anyway (`shop_fulfillments_release`
 * raises `ORD05` for un-cancelling, and `SHIP`'s guard refuses a re-ship) — so accepting it
 * here would produce a 409 for a value the schema should never have admitted.
 */
const FulfillmentStatusBody = z
  .object({ status: z.enum(['shipped', 'delivered', 'cancelled']) })
  .strict();

const CancelBody = z.object({}).strict();

// ------------------------------------------------------------------- shaping

/**
 * What a STOREFRONT sees.
 *
 * `checkoutId` AND `paymentIntentId` ARE DROPPED. Both are another subsystem's identifiers
 * that this one holds only as plumbing — the checkout so `payment.*` events can find the
 * order, the intent so `PaymentPort` can be called. A storefront has no use for either, and
 * shipping them invites a client to start addressing Cart's and Payments' aggregates
 * directly, which is the coupling contract §2 exists to prevent. The admin view keeps them,
 * because an operator chasing a chargeback needs exactly those two strings.
 */
function customerView(order: Order, lines: OrderLine[]) {
  const { checkoutId: _checkout, paymentIntentId: _intent, ...rest } = order;
  return { order: rest, lines };
}

// ---------------------------------------------------------- customer surface

function registerCustomerRoutes(routes: Hono<AppEnv>, deps: Deps): void {
  /**
   * The signed-in customer's own orders.
   *
   * 401 WHEN NO CUSTOMER RESOLVES, INCLUDING WHEN NO RESOLVER IS WIRED. Contract §7 gives
   * the customer session to Cart, so until it lands this route answers 401 for every
   * caller — which is honest. The alternative, falling back to the writer session, would
   * make a shop owner's own orders list show every customer's orders under a URL a
   * storefront calls.
   */
  routes.get('/orders', async (c) => {
    const customer = await deps().customer(c);
    if (!customer) throw new UnauthenticatedError();
    const q = readQuery(c, PageQuery);
    const page = await listCustomerOrders(currentDb(c), customer.id, q);
    return c.json({
      items: page.items.map((item) => customerView(item.order, item.lines)),
      nextCursor: page.nextCursor,
    });
  });

  routes.get('/orders/:orderNumber', async (c) => {
    const read = await authorizeLookup(c, deps());
    return c.json(customerView(read.order, read.lines));
  });

  routes.get('/orders/:orderNumber/events', async (c) => {
    const read = await authorizeLookup(c, deps());
    return c.json({ events: await listTimeline(currentDb(c), read.order.id) });
  });
}

/**
 * THE AUTHORIZATION CHECK BRIEF §6 CALLS "THE ONE TO GET RIGHT", in one place.
 *
 * Two ways in, and BOTH SCOPE IN THE SQL:
 *
 *  - a resolved customer id, bound into `WHERE … AND customer_id = $2`;
 *  - a signed guest token, whose OWN order number and email are bound into
 *    `WHERE order_number = $1 AND lower(email) = lower($2)`.
 *
 * THE ORDER NUMBER USED IN THE QUERY COMES FROM THE VERIFIED TOKEN, NOT FROM THE PATH.
 * The path is only compared against it. So there is no code path in which an
 * attacker-chosen order number reaches a query — a valid token for order A cannot read
 * order B even when the URL says B, and the failure is a 404 rather than a hint.
 *
 * EVERY FAILURE IS THE SAME 404. Absent, not yours, wrong token, expired token — one
 * answer, because any distinction between them tells an unauthenticated caller whether an
 * order exists. Spec §8 answers absent and destroyed identically for the same reason.
 *
 * THE ORDER NUMBER IS VALIDATED FIRST, so 22 of every 23 guessed numbers are refused by
 * the check character before a query runs.
 */
async function authorizeLookup(c: Context<AppEnv>, deps: ResolvedDeps): Promise<OrderRead> {
  const db = currentDb(c);
  const orderNumber = requireOrderNumber(pathParam(c, 'orderNumber'));
  const { token } = readQuery(c, LookupQuery);

  const customer = await deps.customer(c);
  if (customer) {
    const own = await getOrderForCustomer(db, customer.id, orderNumber);
    if (own) return own;
  }

  /*
   * FALLING THROUGH TO THE TOKEN WHEN A CUSTOMER SESSION EXISTS IS DELIBERATE. Contract §7:
   * a single request may carry both cookies, and the two identities are independent. A shop
   * owner following a guest link from a support ticket while signed in as themselves must
   * not be refused because their own session did not own the order.
   */
  if (token !== undefined) {
    const grant = verifyGuestToken(rejectNul(token, 'token'), deps.now());
    if (grant && grant.orderNumber === orderNumber) {
      const guest = await getOrderForGuest(db, grant.orderNumber, grant.email);
      if (guest) return guest;
    }
  }

  throw new NotFoundError(orderNumber);
}

// ------------------------------------------------------------- admin surface

function registerAdminRoutes(
  routes: Hono<AppEnv>,
  deps: Deps,
  auth: ReturnType<typeof requireAuth>,
): void {
  /**
   * Keyset, filter by status, and — since HANDOFF §2 A4 — find one order.
   * `server/repo/cursor.ts` verbatim (brief §6).
   *
   * `?search=` DISPATCHES TO A DIFFERENT QUERY RATHER THAN ADDING A PREDICATE
   * HERE, because the term has to be classified (order number or address) before
   * a statement can be chosen. `server/shop/admin/orders.ts` holds both branches
   * and the reasoning for each.
   *
   * AN EMPTY `?search=` IS NO FILTER AT ALL, not a search for the empty string.
   * The same rule `listProducts` applies to `?category=` — "an empty string is
   * 'no filter', not 'products with no category'" — and it is what makes a
   * cleared search box behave like no search box, rather than emptying the list
   * the operator was reading.
   */
  routes.get('/admin/orders', auth, async (c) => {
    const q = readQuery(c, AdminPageQuery);
    const db = currentDb(c);
    const search = q.search?.trim();
    if (search === undefined || search === '') return c.json(await listAllOrders(db, q));
    return c.json(await searchOrders(db, { ...q, search }));
  });

  routes.get('/admin/orders/:id', auth, async (c) => {
    const db = currentDb(c);
    const read = await requireOrder(db, pathParam(c, 'id'));
    return c.json(await orderDetail(db, read, deps()));
  });

  /**
   * The same view, addressed by the number on the customer's receipt.
   *
   * THE SAME BODY AS `/admin/orders/:id`, DELIBERATELY, and assembled by the same
   * function rather than by a similar one. An operator who reaches an order by
   * pasting a number and an operator who reaches it from the list are looking at
   * the same screen, and two assemblies of it would drift the first time a field
   * was added to one.
   *
   * `requireOrderNumber` FIRST, so a mistyped number is a 400 that says the check
   * character failed — and 22 of every 23 guesses never reach a statement. This
   * is the opposite of `?search=`, where a bad number is an empty page: there the
   * number is a search term, here it IS the request, and a 404 for a typo would
   * be indistinguishable from an order that does not exist.
   *
   * FOUR PATH SEGMENTS, so it cannot be shadowed by the three-segment
   * `/admin/orders/:id` above whatever the registration order — but the test
   * suite asserts that rather than leaving it to a reading of Hono's matcher.
   */
  routes.get('/admin/orders/by-number/:orderNumber', auth, async (c) => {
    const db = currentDb(c);
    const orderNumber = requireOrderNumber(pathParam(c, 'orderNumber'));
    const read = await readOrderByNumber(db, orderNumber);
    if (!read) throw new NotFoundError(orderNumber);
    return c.json(await orderDetail(db, read, deps()));
  });

  routes.post('/admin/orders/:id/fulfillments', auth, async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, FulfillmentBody);
    const read = await requireOrder(db, pathParam(c, 'id'));
    const fulfillment = await createFulfillment(
      db,
      read.order.id,
      {
        lines: body.lines,
        carrier: body.carrier ?? null,
        trackingNumber: body.trackingNumber ?? null,
      },
      currentUser(c).id,
      deps().now(),
    );
    return c.json({ fulfillment }, 201);
  });

  /**
   * `PATCH /shop/admin/fulfillments/:id { status }`.
   *
   * THE ORDER'S OWN `fulfilled` TRANSITION IS ATTEMPTED AFTER A SHIPMENT, and it is
   * separate on purpose: it is the only thing here that nobody asked for, so its ordinary
   * answer is "not yet, two parcels to go" and it returns `null` rather than throwing.
   * Folding it into the shipment statement would either make a partial shipment an error or
   * make the shipment's own guard depend on a coverage predicate that has nothing to do
   * with it.
   */
  routes.patch('/admin/fulfillments/:id', auth, async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, FulfillmentStatusBody);
    const id = pathParam(c, 'id');
    const existing = await readFulfillment(db, id);
    if (!existing) throw new NotFoundError(id);

    const actorId = currentUser(c).id;
    const now = deps().now();

    if (body.status === 'delivered') {
      return c.json({ fulfillment: await deliverFulfillment(db, id, now, actorId) });
    }
    if (body.status === 'cancelled') {
      return c.json({ fulfillment: await cancelFulfillment(db, id, now, actorId) });
    }

    const order = await requireOrder(db, existing.fulfillment.orderId);
    const fulfillment = await shipFulfillment(db, id, now, linkFor(c, order, deps()), actorId);
    const settled = await settleOrderFulfilled(
      db,
      order.order.id,
      {
        fulfillmentId: fulfillment.id,
        carrier: fulfillment.carrier,
        trackingNumber: fulfillment.trackingNumber,
      },
      now,
    );
    return c.json({ fulfillment, order: settled });
  });

  /**
   * THE TWO SWEEPERS, GIVEN A CALLER.
   *
   * Without this route `sweepCommerceEvents` and `sweepEmailIntents` are exported
   * functions that nothing invokes — and "a mechanism wired to no caller" is one of the
   * three failure shapes contract §2 says both previous gauntlets found in every round.
   * An outbox nobody drains is worse than no outbox: orders would sit `pending` after a
   * successful capture and no email would ever leave.
   *
   * AN HTTP ROUTE, BECAUSE THAT IS WHAT THIS CODEBASE ALREADY DOES with maintenance
   * work: `POST /api/posts/sweep-blank` and the image orphan collector are both routes,
   * behind a session, invoked by a dashboard or a schedule. Authenticated on both
   * methods because draining the outbox moves money-adjacent state — a capture becomes
   * a paid order and a confirmation goes out.
   *
   * IT NOW HAS THREE CALLERS, none of them a `vercel.json` cron of its own — there is
   * no third slot on Hobby and both are taken:
   *
   *  1. **The capture path**, inline and bounded, so an order exists seconds after the
   *     customer pays (`server/shop/payments/routes.ts`).
   *  2. **An external cron service**, minute by minute, through the GET below.
   *  3. **The cart's daily maintenance cron**, which drains this outbox too
   *     (`server/shop/app.ts` injects it) — the backstop if 1 and 2 both stop.
   *
   * The line that used to stand here — "NOTHING SCHEDULES IT YET" — was true, and it
   * was measured: production held every `commerce_events` row at `processed_at = NULL,
   * attempts = 0`, including a real customer's capture, and `shop_orders` was empty.
   *
   * ⚠️  `emails.sent` MEANS "HANDED TO THE MAILER". The default mailer records the
   *     message and sends nothing (see `OrdersDeps.mailer`).
   */
  /*
   * GET, FOR AN EXTERNAL CRON SERVICE (admin#29 follow-up).
   *
   * `vercel.json` IS AT THE HOBBY CEILING OF TWO CRONS AND BOTH SLOTS ARE TAKEN
   * — `server/routes/email.ts` states it: "Two crons is also the Hobby ceiling; a
   * third needs a plan, not a config line." Worse, a Hobby cron runs DAILY with
   * ±59 minutes of jitter, and a customer waiting up to a day to learn their
   * order exists is not an order pipeline. Folding the sweep into the cart's
   * maintenance cron (which this change does NOT remove) buys a backstop, not a
   * mechanism.
   *
   * A free external scheduler — cron-job.org and its like — can call an HTTPS
   * endpoint every minute, which solves the latency properly and needs no plan
   * upgrade. What it needs from us is a GET it can authenticate, because that is
   * all such a service issues.
   *
   * SAME SHAPE AS `GET /api/admin/email/drain`, COPIED RATHER THAN REINVENTED:
   * one path, two methods, TWO DIFFERENT CREDENTIALS, one shared implementation.
   * A leaked session must not become a way to drive the sweeper, and the cron
   * token must not become a general-purpose admin credential — and `runSweep`
   * below is what stops the two credentials growing two behaviours.
   *
   * `assertCronRequest` FAILS CLOSED, and that is the whole security of this
   * route. `originGuard` waves every GET through (`SAFE_METHODS`), so the bearer
   * token is the ONLY thing in front of it: a deployment with no `CRON_SECRET`,
   * or one shorter than 16 characters, answers 401 to everybody rather than
   * opening the endpoint. NOT UNAUTHENTICATED, deliberately — draining this
   * outbox turns a capture into a paid order and sends a confirmation email, and
   * an open endpoint would let anyone drive money-adjacent work.
   */
  routes.get('/admin/sweep', async (c) => {
    assertCronRequest(c.req.header('Authorization'));
    return c.json(await runSweep(c, deps()));
  });

  routes.post('/admin/sweep', requireOwner(), async (c) => c.json(await runSweep(c, deps())));

  /**
   * `requireOwner()`, not `requireAuth()` — contract §HTTP puts anything money-adjacent
   * behind owner, and cancelling a paid order is the most money-adjacent thing here: it
   * tells every consumer of `order.cancelled` to release the stock and it stops the order
   * ever shipping.
   */
  routes.post('/admin/orders/:id/cancel', requireOwner(), async (c) => {
    const db = currentDb(c);
    await readJsonOrEmpty(c, CancelBody);
    const read = await requireOrder(db, pathParam(c, 'id'));
    const order = await cancelOrder(
      db,
      read.order.id,
      { reason: 'admin', actorId: currentUser(c).id, link: linkFor(c, read, deps()) },
      deps().now(),
      null,
    );
    return c.json({ order });
  });
}

/**
 * The work both sweep methods share, so the two credentials cannot drift into two
 * behaviours — `server/routes/email.ts`'s `runDrain`, in this subsystem.
 *
 * EVENTS FIRST, THEN EMAIL. The order matters: draining the outbox is what WRITES
 * the email intents, so doing it the other way round would always leave this
 * sweep's own new mail for the next one.
 *
 * BOUNDED AT `SWEEP_BATCH`, AND THE REASON STILL APPLIES TO AN EXTERNAL CALLER.
 * `vercel.json` caps these functions at `maxDuration: 30`, and that cap is on the
 * FUNCTION, not on whoever invoked it — an external scheduler has no timeout of
 * its own to worry about, but the platform still kills the invocation at thirty
 * seconds and neither Vercel nor cron-job.org retries what it killed. So an
 * over-large batch is one that never completes rather than one that runs slowly.
 * The bound also keeps each run's load on Neon predictable, which matters far
 * more at one call a minute than at one a day.
 *
 * `drainCommerceEvents` RATHER THAN A SINGLE `sweepCommerceEvents` PASS: it keeps
 * going while passes make progress and stops the moment one does not, so a
 * backlog clears over one invocation instead of one row-batch per call. Its own
 * wall-clock budget sits inside `maxDuration`.
 *
 * PAYMENTS DRAINED FIRST, BEFORE EITHER SWEEPER — that is what closes the gap a
 * real production payment fell through. The webhook route acknowledges the
 * request, THEN does the post-response work that turns the stored event into a
 * `commerce_events` row; Vercel is free to freeze the function the instant the
 * response is sent, and when it does, `shop_payment_events.processed_at` stays
 * null forever with no error recorded anywhere. `POST /shop/admin/payments/
 * events/drain` is the owner-driven safety net for that; `d.drainPayments`
 * (§`ports.ts`) is the same safety net reached from a schedule, injected rather
 * than imported so Orders never reaches into Payments' module directly.
 *
 * A COMMERCE SWEEP THAT ONLY EVER RAN ONCE PER INVOCATION WOULD NOT BE ENOUGH,
 * even with the payment drain fixed. Draining payments emits fresh
 * `commerce_events` rows (a `checkout.completed`, a `payment.captured`) that a
 * single `sweepCommerceEvents` pass can select in the WRONG order relative to
 * each other within that same pass — `payment.captured` parks on its own
 * `checkout.completed` predecessor when both are newly minted in the same
 * drain. That predecessor only gets applied on a LATER pass (never retried
 * within the one that parked it — `consumer.ts`'s own doc comment on
 * `sweepCommerceEvents`), so a fixed-point loop across passes, not a single
 * pass, is what actually clears a backlog seeded by this same call.
 * `drainCommerceEvents` already IS that loop (stops at "no progress", i.e. a
 * pass that applied and ignored nothing, so it cannot spin on a permanently
 * parked event) — this only needed a caller that goes to it after payments.
 *
 * `passes: RUN_SWEEP_COMMERCE_PASS_CEILING` NARROWS ITS DEFAULT CEILING OF 20
 * DOWN TO 5, because unlike `drainCommerceEvents`'s other callers, this one
 * shares its `maxDuration: 30` budget with `drainPayments` above it — the two
 * scanned-and-applied-recovery, capture-created-order sequence measured by hand
 * only ever needed two commerce passes (apply `checkout.completed`, then apply
 * the parked `payment.captured`), so five is headroom, not the tight number.
 */
async function runSweep(c: Context<AppEnv>, d: ResolvedDeps) {
  const db = currentDb(c);
  const now = d.now();
  const payments = await d.drainPayments(db, now);
  const events = await drainCommerceEvents(
    db,
    { origin: c.get('origins')?.[0] ?? null },
    { now, limit: SWEEP_BATCH, passes: RUN_SWEEP_COMMERCE_PASS_CEILING },
  );
  const emails = await sweepEmailIntents(db, d.mailer, now);
  return { payments, events, emails, passes: events.passes };
}

/**
 * How many `sweepCommerceEvents` passes one `runSweep` call allows itself.
 *
 * Small on purpose (contract's own reasoning for `SWEEP_BATCH` applies again
 * here): `vercel.json` caps this function at `maxDuration: 30` and Vercel does
 * not retry a timed-out cron, so an over-large unit of work is one that never
 * completes rather than one that runs slowly. `drainCommerceEvents`'s own
 * ceiling of 20 was sized for a caller that owns the whole budget; `runSweep`
 * also pays for `drainPayments` and `sweepEmailIntents` out of the same 30
 * seconds, so its slice of the commerce sweep is capped lower. 5 passes clears
 * the two-pass "predecessor arrives in the same drain" case measured by hand
 * with three passes of headroom for an ordinary backlog, and still gives up on
 * a permanently-parked event well inside the function's time budget rather than
 * spinning until `maxDuration` kills it.
 */
export const RUN_SWEEP_COMMERCE_PASS_CEILING = 5;

/**
 * How many outbox rows one pass of one invocation takes on.
 *
 * The same 50 the cart's maintenance cron uses (`CRON_BATCH`), and spelled here
 * rather than imported because the two are the same NUMBER for the same REASON,
 * not the same setting — coupling Orders' batch to Cart's would make an unrelated
 * change to one silently retune the other.
 */
export const SWEEP_BATCH = 50;

/** What an external cron service should be pointed at. Exported so
 *  `routes.test.ts` asserts the string the operator is given is the string the
 *  router registers — a path in a runbook that nothing checks is a scheduled job
 *  that 404s on time, forever. */
export const SWEEP_CRON_PATH = '/api/shop/admin/sweep';

async function requireOrder(db: Db, id: string): Promise<OrderRead> {
  const read = await readOrder(db, id);
  if (!read) throw new NotFoundError(id);
  return read;
}

/**
 * THE support view: one order and everything about it.
 *
 * A FUNCTION RATHER THAN AN INLINE BODY because two routes answer with it — by
 * id and by order number — and a second, hand-copied assembly would be one
 * screen missing whatever the next field added is, with no error anywhere.
 */
async function orderDetail(db: Db, read: OrderRead, deps: ResolvedDeps) {
  return {
    order: read.order,
    lines: read.lines,
    fulfillments: await listFulfillments(db, read.order.id),
    timeline: await listTimeline(db, read.order.id),
    /*
     * THE EMAIL INTENTS ARE PART OF THE ADMIN VIEW, and brief §5 says why: "an email you
     * cannot prove you sent is a support ticket you cannot answer." What a customer
     * received, when, and whether a send failed is the first question support asks.
     */
    emails: await listIntents(db, read.order.id),
    /*
     * READ-ONLY, FOR DISPLAY, AND ABSENT UNTIL PAYMENTS LANDS. Contract §5 gives Orders no
     * port into Payments for state changes; this is the whole of what it may know.
     */
    payment:
      deps.payments && read.order.paymentIntentId
        ? await deps.payments.status(db, read.order.paymentIntentId)
        : null,
  };
}

/**
 * The guest access link for an email sent from a REQUEST.
 *
 * `c.get('origins')[0]`, NEVER A `Host` HEADER. `originGuard` publishes the allow-list this
 * request was judged against, and `server/routes/auth.ts` builds invite URLs from the same
 * place for the same reason: a link built from an attacker-supplied header is a phishing
 * link the application sent itself.
 */
function linkFor(c: Context<AppEnv>, read: OrderRead, deps: ResolvedDeps): AccessLink | null {
  const origin = c.get('origins')?.[0];
  if (!origin) return null;
  return {
    origin,
    token: mintGuestToken(
      { orderNumber: read.order.orderNumber, email: read.order.email },
      deps.now(),
    ),
  };
}

/** The default wiring, for a mount site with nothing to inject. */
export const orders = createOrdersRoutes();
