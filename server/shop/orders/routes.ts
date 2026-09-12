import { Hono } from 'hono';
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
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
import { requireAdmin, requireAuth } from '../../middleware/session';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { rejectNul } from '../../repo/cursor';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import { refundPoints, drainCommerceEvents } from './repo/consumer';
import { assertCronRequest } from '../cart/cron-auth';
import { requireOrderNumber } from './order-number';
import { mintGuestToken, verifyGuestToken } from './tokens';
import { resolveDeps, type OrdersDeps, type ResolvedDeps } from './ports';
import type { AccessLink } from './mailer';
import { storefrontOrigin } from '../storefront-url';
import {
  PAYMENT_METHODS,
  SALES_CHANNELS,
  createManualOrder,
  listOrderRevisions,
  readManualDetails,
  updateManualOrder,
  voidManualOrder,
  type ManualOrderInput,
} from './repo/manual';
import { ensureSystemTemplates, loadTemplates } from '../../email/system-templates';
import {
  cancelOrder,
  getOrderForCustomer,
  getOrderForGuest,
  listAllOrders,
  listCustomerOrders,
  listCustomerShippingAddresses,
  listTimeline,
  readOrder,
  settleOrderFulfilled,
  type Order,
  type OrderAddOn,
  type OrderLine,
  type OrderRead,
  type OrderTimelineEntry,
} from './repo/orders';
import {
  cancelFulfillment,
  createFulfillment,
  deliverFulfillment,
  listFulfillments,
  readFulfillment,
  shipFulfillment,
  updateFulfillmentDetails,
  type Fulfillment,
} from './repo/fulfillments';
import {
  countOutbox,
  dismissIntent,
  listIntents,
  listOutbox,
  retryIntent,
  sweepEmailIntents,
} from './repo/emails';
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
  /** Where the sale came from: the checkout, or recorded by hand (migration 1110). */
  source: z.enum(['online', 'manual']).optional(),
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
 *
 * `status` IS NOW OPTIONAL, because the ship dialog grew a second job: editing
 * carrier/tracking on a parcel that has not shipped, with no transition. The
 * schema only fixes SHAPES — which field combinations mean what is decided in
 * the handler, against the fulfilment it actually read:
 *
 *  - `{ status: 'shipped', carrier?, trackingNumber? }` — ship, writing the
 *    details in the same statement so the shipment email reads the new values.
 *  - `{ carrier and/or trackingNumber }` — details-only edit, pending parcels
 *    only (a shipped parcel's details are frozen: the email already told the
 *    customer).
 *  - `{}` — refused: nothing to do is a caller mistake, not a no-op.
 *  - `delivered`/`cancelled` REFUSE the two fields rather than ignoring them —
 *    a caller sending tracking with `delivered` believed it would be recorded,
 *    and silence would confirm the belief.
 *
 * Per field: absent means keep, explicit `null` means clear (see
 * `FulfillmentDetails`).
 */
const FulfillmentStatusBody = z
  .object({
    status: z.enum(['shipped', 'delivered', 'cancelled']).optional(),
    carrier: str().max(300).nullable().optional(),
    trackingNumber: str().max(300).nullable().optional(),
  })
  .strict();

/**
 * task-d3: cancelling a PAID order must choose a refund amount; cancelling a
 * PENDING one must not, because there is nothing captured to refund. Which of
 * those applies depends on the ORDER's status, so this schema only fixes the
 * SHAPE of a choice — the handler decides whether one is required, forbidden,
 * or free to be absent, against the order it actually read.
 */
const CancelRefundChoice = z.discriminatedUnion('kind', [
  /** The two presets task-d3 asks for by name — not an arbitrary percentage. */
  z
    .object({ kind: z.literal('percent'), percent: z.union([z.literal(100), z.literal(75)]) })
    .strict(),
  z.object({ kind: z.literal('amount'), amount: z.number().int().positive() }).strict(),
  /** Explicit "cancel without refunding" — never a silent default. A refund of
   *  zero is not a refund; this is the named alternative to typing one. */
  z.object({ kind: z.literal('none') }).strict(),
]);

const CancelBody = z.object({ refund: CancelRefundChoice.optional() }).strict();

/**
 * Percentage of a FROZEN total, in minor units. `100` is returned as the exact
 * total with no arithmetic — a full refund must never land a unit short of it
 * because of a multiply-then-divide it never needed.
 *
 * ROUNDS TO THE NEAREST MINOR UNIT (half up). A percentage of an odd total
 * does not divide evenly, and floor/ceil would each ALWAYS favour one side —
 * the shop on every odd total under floor, the customer on every odd total
 * under ceil. Rounding to nearest is the rule under which neither party is
 * favoured by the direction alone; the minor-unit remainder this leaves on an
 * odd total goes wherever ordinary rounding sends it, not wherever is
 * administratively convenient.
 */
function refundPercentOf(grandTotal: number, percent: 75 | 100): number {
  return percent === 100 ? grandTotal : Math.round((grandTotal * percent) / 100);
}

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
 *
 * `fulfillments` IS PRESENT ONLY WHEN THE CALLER FETCHED THEM — the DETAIL
 * routes do, the LIST does not. The list is a page of orders assembled by one
 * statement, and bolting a per-order fulfilment read onto it would be N extra
 * queries for a surface whose tracking UI lives on the detail page anyway. The
 * key is genuinely absent there rather than `[]`, so a storefront cannot read
 * an empty array as "nothing shipped".
 */
function customerView(
  order: Order,
  lines: OrderLine[],
  fulfillments?: Fulfillment[],
  addOns?: OrderAddOn[],
) {
  const { checkoutId: _checkout, paymentIntentId: _intent, ...rest } = order;
  return {
    order: rest,
    lines,
    ...(fulfillments === undefined
      ? {}
      : { fulfillments: fulfillments.flatMap(customerFulfillmentView) }),
    ...(addOns === undefined ? {} : { addOns }),
  };
}

/**
 * One parcel, as the CUSTOMER may see it: identity, where it is in its life,
 * and the tracking details — nothing else.
 *
 * AN ALLOW-LIST, NOT AN OMIT. `revision` and the lifecycle machinery are this
 * subsystem's concurrency internals; `lines` carries order-line ids a
 * storefront has no business addressing. Spreading-and-deleting would leak the
 * next field anyone adds to the row; naming what ships means a new column is
 * private until somebody decides otherwise.
 *
 * A CANCELLED PARCEL IS NOT IN THE PROJECTION AT ALL. `CANCEL_FULFILLMENT`'s
 * own comment states the doctrine: a cancelled parcel is an internal re-plan —
 * the quantity is released and re-fulfilled — not a fact about the customer's
 * order, which is why cancelling one mails nothing. Showing "Parcel 2:
 * cancelled" on the storefront would announce the re-plan the system
 * deliberately never announces.
 */
function customerFulfillmentView(f: Fulfillment) {
  if (f.status === 'cancelled') return [];
  return [
    {
      id: f.id,
      status: f.status,
      carrier: f.carrier,
      trackingNumber: f.trackingNumber,
      /* The courier's tracking page (migration 0980) — the one courier column
       * on the customer's side of the allow-list, because it is the whole
       * point of the booking from where they are standing. The reference, the
       * waybill, what the courier cost us and the last error stay private. */
      trackingUrl: f.trackingUrl,
      shippedAt: f.shippedAt,
      deliveredAt: f.deliveredAt,
      createdAt: f.createdAt,
    },
  ];
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

  /**
   * The addresses this customer has shipped to before.
   *
   * REGISTERED BEFORE `/orders/:orderNumber`, and that ordering is load-bearing:
   * Hono matches in registration order, so the wildcard below would otherwise
   * swallow this path and answer 404 for an order numbered "addresses".
   *
   * FOR THE CHECKOUT, which is why it exists — every checkout began at an empty
   * form, and a returning shopper retyped an address they had already given us.
   * It lives on the ORDERS surface rather than the checkout's because an order
   * is where the evidence is; Cart reading `shop_orders` directly would put a
   * second owner on that table.
   */
  routes.get('/orders/addresses', async (c) => {
    const customer = await deps().customer(c);
    if (!customer) throw new UnauthenticatedError();
    const addresses = await listCustomerShippingAddresses(currentDb(c), customer.id);
    return c.json({ addresses });
  });

  routes.get('/orders/:orderNumber', async (c) => {
    const read = await authorizeLookup(c, deps());
    /*
     * TRACKING ON THE CUSTOMER SURFACE. Fetched AFTER `authorizeLookup`, so the
     * fulfilment read is scoped by an order id that has already been proven to
     * be this caller's — both the session path and the guest-token path arrive
     * here through the same check, so both get the same body.
     */
    const fulfillments = await listFulfillments(currentDb(c), read.order.id);
    return c.json(customerView(read.order, read.lines, fulfillments, read.addOns));
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

  /*
   * ═══ MANUAL ORDERS (migration 1110) ═══
   * A sale made outside the online checkout, recorded complete. `repo/manual.ts`
   * carries the design; these routes only read the body and pick the actor.
   * Recording and editing ride the orders domain like fulfilments do; voiding
   * takes a sale out of the figures, so it is `requireAdmin()`, like cancel.
   */
  routes.post('/admin/orders/manual', auth, async (c) => {
    const db = currentDb(c);
    const input = manualInput(await readJson(c, ManualOrderBody));
    const result = await createManualOrder(db, input, currentUser(c));
    return c.json({ ...(await orderDetail(db, result.read, deps())), stock: result.stock }, 201);
  });

  routes.put('/admin/orders/:id/manual', auth, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    const body = await readJson(c, EditManualOrderBody);
    const result = await updateManualOrder(db, id, manualInput(body), body.baseRevision, currentUser(c));
    return c.json({ ...(await orderDetail(db, result.read, deps())), stock: result.stock });
  });

  routes.post('/admin/orders/:id/void', requireAdmin(), async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    const body = await readJson(c, VoidManualOrderBody);
    const result = await voidManualOrder(db, id, body.baseRevision, emptyToNull(body.reason), currentUser(c));
    return c.json({ ...(await orderDetail(db, result.read, deps())), stock: result.stock });
  });

  /** Every save of an order, newest first — the edit history. */
  routes.get('/admin/orders/:id/revisions', auth, async (c) => {
    const db = currentDb(c);
    const read = await requireOrder(db, pathParam(c, 'id'));
    return c.json({ items: await listOrderRevisions(db, read.order.id) });
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
   * `PATCH /shop/admin/fulfillments/:id { status?, carrier?, trackingNumber? }`.
   *
   * THE ORDER'S OWN `fulfilled` TRANSITION IS ATTEMPTED AFTER A SHIPMENT, and it is
   * separate on purpose: it is the only thing here that nobody asked for, so its ordinary
   * answer is "not yet, two parcels to go" and it returns `null` rather than throwing.
   * Folding it into the shipment statement would either make a partial shipment an error or
   * make the shipment's own guard depend on a coverage predicate that has nothing to do
   * with it.
   *
   * The field-combination semantics are on `FulfillmentStatusBody` above; the
   * details-only branch answers `{ fulfillment }` with no `order` key, exactly
   * like `delivered`/`cancelled` — there is no settlement to attempt.
   */
  routes.patch('/admin/fulfillments/:id', auth, async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, FulfillmentStatusBody);
    const id = pathParam(c, 'id');
    const existing = await readFulfillment(db, id);
    if (!existing) throw new NotFoundError(id);

    const actorId = currentUser(c).id;
    const now = deps().now();

    const hasDetails = body.carrier !== undefined || body.trackingNumber !== undefined;

    if (body.status === undefined) {
      /* Nothing at all was asked for. `.strict()` already refused unknown keys,
       * so an empty object is a caller that meant to send something. */
      if (!hasDetails) throw new BadRequestError('status');
      const fulfillment = await updateFulfillmentDetails(db, id, {
        carrier: body.carrier,
        trackingNumber: body.trackingNumber,
      });
      return c.json({ fulfillment });
    }

    /*
     * `delivered` AND `cancelled` REFUSE THE DETAIL FIELDS, naming the field.
     * Both moments come after the shipment email went out, so the details are
     * frozen; accepting-and-ignoring would tell the caller their tracking
     * number was recorded when it was not.
     */
    if (body.status !== 'shipped' && hasDetails) {
      throw new BadRequestError(body.carrier !== undefined ? 'carrier' : 'trackingNumber');
    }

    if (body.status === 'delivered') {
      /*
       * THE LINK AND THE TEMPLATES ARE NEW HERE because delivery now mails the
       * customer (migration 0320). The order is read before the transition
       * because the link is an HMAC over the order NUMBER, which this route has
       * only the fulfilment id for.
       */
      const delivering = await requireOrder(db, existing.fulfillment.orderId);
      return c.json({
        fulfillment: await deliverFulfillment(
          db,
          id,
          now,
          actorId,
          linkFor(c, delivering, deps()),
          await loadTemplates(db),
        ),
      });
    }
    if (body.status === 'cancelled') {
      return c.json({ fulfillment: await cancelFulfillment(db, id, now, actorId) });
    }

    const order = await requireOrder(db, existing.fulfillment.orderId);
    const fulfillment = await shipFulfillment(
      db,
      id,
      now,
      linkFor(c, order, deps()),
      actorId,
      await loadTemplates(db),
      /* Ship-time details ride the SAME statement as the transition, so the
       * shipment email renders the values the operator just confirmed — see
       * `shipTransition`. Absent fields keep whatever the parcel holds. */
      hasDetails ? { carrier: body.carrier, trackingNumber: body.trackingNumber } : undefined,
    );
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
   * THE OUTBOX SCREEN'S ROUTES (migration 0660's range) — the first UI over
   * `shop_order_email_intents` that is not scoped to one order.
   *
   * The Home banner has counted dead intents since `emailBacklog` existed and
   * pointed at a screen that showed none of them; the documented recovery was a
   * human running `UPDATE … SET attempts = 0` against production. These three
   * routes are that count made actionable: list what the number is made of,
   * retry the row (the documented UPDATE, plus an immediate sweep so "retry"
   * means "try now" rather than "try within ten minutes"), or dismiss it.
   */
  const OutboxQuery = z
    .object({
      bucket: z.enum(['attention', 'queued', 'sent', 'dismissed']).optional(),
    })
    .strict();

  routes.get('/admin/emails', auth, async (c) => {
    const q = readQuery(c, OutboxQuery);
    const db = currentDb(c);
    return c.json({
      items: await listOutbox(db, q.bucket ?? 'attention'),
      counts: await countOutbox(db),
    });
  });

  /**
   * Retry = reset AND attempt, in that order. The reset alone would leave the
   * operator watching an unchanged screen until the next cron pass; the sweep
   * here is the same bounded `sweepEmailIntents` every other caller runs, so a
   * retry cannot deliver anything the schedule would not. A sent intent is a
   * 404 — retrying it would re-deliver a message the customer already has.
   */
  routes.post('/admin/emails/:id/retry', auth, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    if (!(await retryIntent(db, id))) throw new NotFoundError(id);
    const emails = await sweepEmailIntents(db, deps().mailer, deps().now());
    return c.json({ ok: true, emails });
  });

  routes.post('/admin/emails/:id/dismiss', auth, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    if (!(await dismissIntent(db, id, deps().now()))) throw new NotFoundError(id);
    return c.json({ ok: true });
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
   *  2. **An external cron service**, every ten minutes, through the GET below.
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
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️  THE CADENCE IS A SPENDING DECISION, NOT A FREE DIAL. Read this before
   *     changing how often this is called.
   *
   * Neon's free plan bills COMPUTE HOURS and autosuspends the compute after
   * ~5 minutes idle — the database is meant to be asleep most of the time, and
   * that is the whole economics of the plan. **Any cron faster than the
   * autosuspend window keeps it awake permanently.**
   *
   * At one call a minute the compute never sleeps: ~720 hours a month against a
   * free allowance in the ~190-hour range, exhausted in about a week. The cost
   * is not this endpoint's own work — an idle sweep is a handful of rows — it is
   * that calling it at all resets the idle timer.
   *
   * THE CADENCE IS TEN MINUTES, settled by the owner on 2026-08-25 (it ran at
   * one minute before that, deliberately, while the customer moment was judged
   * worth more than the compute hours). Ten minutes ≈ 145 compute-hours/month
   * with a short autosuspend — inside the free allowance. The storefront's
   * `/checkout/complete` was updated IN THE SAME DECISION: its `confirm` call
   * still resolves a capture from Paystack directly within its ~60s poll, and
   * past that it settles early on the honest "we'll email you when it's
   * confirmed" copy instead of spinning out the sweep gap. If the cadence
   * moves again, move that page's copy and window with it — mismatched, every
   * order reads as a failure to the person least able to tell.
   *
   * The highest-leverage lever is not here: shortening Neon's autosuspend
   * decides what each wake-up costs regardless of how often this is called.
   *
   * None of this survives real traffic — customers keep the compute awake by
   * themselves. It only bites while the store is empty.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  routes.get('/admin/sweep', async (c) => {
    assertCronRequest(c.req.header('Authorization'));
    return c.json(await runSweep(c, deps()));
  });

  routes.post('/admin/sweep', requireAdmin(), async (c) => c.json(await runSweep(c, deps())));

  /**
   * `requireOwner()`, not `requireAuth()` — contract §HTTP puts anything money-adjacent
   * behind owner, and cancelling a paid order is the most money-adjacent thing here: it
   * tells every consumer of `order.cancelled` to release the stock and it stops the order
   * ever shipping.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * TASK-D3: A PAID ORDER'S CANCEL REFUNDS FIRST, THEN CANCELS — IN THAT ORDER,
   * AND THE ORDER IS THE WHOLE ANSWER TO "WHAT IF ONE HALF FAILS".
   *
   * If the refund throws — `createRefund`'s own contract makes every
   * SYNCHRONOUS throw a KNOWN, permanent refusal (an over-large amount, a
   * provider failure that means no money moved) — this handler returns before
   * `cancelOrder` is ever reached: the order is untouched and the request is
   * safe to retry. The reverse order has no good failure mode: cancel first,
   * and a refund that then fails leaves a CANCELLED order (stock already
   * released, the customer already told "this is off") with no money back —
   * and nothing transitions a cancelled order back to paid to retry from.
   * Refund-first makes the failure boring: nothing happened yet, try again.
   *
   * A refund call that does NOT throw — `succeeded`, or the provider's
   * ordinary `pending` (Paystack settles most refunds asynchronously) — is
   * treated as "the money is committed to move", and cancellation proceeds.
   * This mirrors `refunds.ts`'s OWN distinction between a KNOWN failure
   * (throws, its reservation released) and an INDETERMINATE one (returns
   * normally, reservation held): this route invents no second opinion about
   * which is which.
   *
   * THE ASYNCHRONOUS FLIP SIDE WAS A REAL, SILENT GAP — CLOSED BY TASK-D4,
   * NAMED HERE RATHER THAN LEFT FOR THE NEXT READER TO REDISCOVER. A `pending`
   * refund that later fails AT THE PROVIDER, arriving well after this order is
   * already cancelled, used to tell Orders nothing: `applyRefundEvent`
   * (`refunds.ts`) emitted `payment.refunded` only on `succeeded`, so a failed
   * settlement emitted no event and the order sat `cancelled` with no signal
   * its refund had not, in fact, landed. `applyRefundEvent` now ALSO emits
   * `payment.refund_failed` on a failed settlement — same shape, opposite
   * `WHERE`, a pure addition beside the succeeded arm — and
   * `server/shop/orders/repo/consumer.ts` records it as a `refund_failed`
   * timeline entry (`recordRefundFailure` in `./repo/orders.ts`) WITHOUT
   * touching `shop_orders.status`: cancelling already released the
   * reservations, and un-cancelling here would be a second, messier failure.
   * The intent-level ledger — `shop_refunds.status`,
   * `shop_payment_intents.refunded_total` — still records the truth for
   * reconciliation; the order's own history now does too, and an operator
   * reading either finds the same story. The recovery from here is still
   * human: retry the refund, or pay the customer another way.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  routes.post('/admin/orders/:id/cancel', requireAdmin(), async (c) => {
    const db = currentDb(c);
    const body = await readJsonOrEmpty(c, CancelBody);
    const read = await requireOrder(db, pathParam(c, 'id'));

    /*
     * AN UNPAID ORDER MUST NEVER REACH A REFUND PATH (task-d3, verbatim).
     * Nothing was captured, so a `refund` choice here can only be a caller
     * that misread the order's own state — refused rather than quietly
     * ignored, so the mistake is visible immediately rather than hidden
     * behind a cancel that did less than the caller thought it asked for.
     */
    if (read.order.status === 'pending' && body.refund !== undefined) {
      throw new BadRequestError('refund');
    }

    let refundedAmount: number | undefined;

    /*
     * A PAID ORDER MUST CHOOSE, EXPLICITLY — never a silent default. Before
     * this change, `POST .../cancel` with no body cancelled a paid order and
     * refunded nothing, which is precisely the mismatch task-d3 exists to
     * close ("if you refund without cancelling, what happens when you cancel
     * by that logic"). `{ kind: 'none' }` can still choose that same outcome —
     * it is simply chosen on purpose and named, and the admin UI's button
     * reads "cancel without refunding" rather than leaving an amount box
     * empty and hoping the operator reads a hint underneath it.
     */
    if (read.order.status === 'paid') {
      if (body.refund === undefined) throw new BadRequestError('refund');

      if (body.refund.kind !== 'none') {
        refundedAmount =
          body.refund.kind === 'percent'
            ? refundPercentOf(read.order.grandTotal, body.refund.percent)
            : body.refund.amount;

        /*
         * A STATIC BOUND, NOT THE CONCURRENCY GUARD. `grandTotal` is FROZEN and
         * never changes for this order, so comparing a requested amount
         * against it races nothing and reads no total that a concurrent write
         * could invalidate. The real guard — the one that must never be
         * reimplemented as a JS pre-check — is the UPDATE's own WHERE inside
         * `createRefund`, and it runs regardless of this line. This only turns
         * an over-large custom amount into a same-request 400 instead of a
         * round trip that was always going to be refused.
         */
        if (refundedAmount > read.order.grandTotal) throw new BadRequestError('amount');
        if (!read.order.paymentIntentId) throw new BadRequestError('paymentIntentId');

        const issue = deps().refund;
        if (!issue) {
          throw new Error('refunds are not wired: pass `refund` to registerOrdersDefaults');
        }

        /*
         * THE DETERMINISTIC KEY IS THIS ROUTE'S OWN DOUBLE-SUBMIT SAFETY, and it
         * is keyed on the AMOUNT as well as the order. Keying on the order
         * alone would make a retry with a DIFFERENT amount — after a failure
         * between the refund and the cancel below — silently read through to
         * the FIRST amount and ignore the second, which is a wrong number no
         * caller would see. Keying on both makes an identical retry idempotent
         * (same key, `createRefund`'s own read-through) and a genuinely
         * different amount either succeed or fail LOUDLY against the intent's
         * real remaining balance, never silently.
         */
        await issue(db, {
          intentId: read.order.paymentIntentId,
          amount: refundedAmount,
          idempotencyKey: `cancel:${read.order.id}:${refundedAmount}`,
          createdBy: currentUser(c).id,
        });
        // Did not throw: the money is committed to move (see the block comment
        // on this route). Cancel is what happens next, unconditionally.
      }
    }

    const order = await cancelOrder(
      db,
      read.order.id,
      {
        reason: 'admin',
        actorId: currentUser(c).id,
        link: linkFor(c, read, deps()),
        templates: await loadTemplates(db),
        refundedAmount,
      },
      deps().now(),
      null,
    );

    /*
     * GIVE BACK ANY SPOOLPOINTS THE ORDER SPENT (admin#2).
     *
     * THIS ROUTE IS NOT AN EVENT, AND THAT IS WHY IT NEEDS ITS OWN LINE.
     * `cancelOrder` emits `order.cancelled`, but the consumer ignores that type
     * as one of this subsystem's own emissions — so a cancel driven by a person
     * reaches no branch of the consumer at all. Wiring the release only into
     * `payment.failed` and `payment.refunded` left an admin cancel stranding the
     * debit, which is the exact failure `release()` was written to prevent: the
     * order is gone, the points are not coming back, and the customer is quietly
     * out of pocket with no recovery path anybody named.
     *
     * AFTER THE CANCEL, AND IT NEVER THROWS. The state change has already been
     * applied and is what the caller is owed; a throw here would turn a
     * successful cancellation into a 500 and invite an operator to click again.
     * `release()` is idempotent per order, so the second click is harmless, but
     * the first one should not look like a failure. A points release that could
     * not be completed is recoverable by hand; an admin who believes the cancel
     * failed is not.
     *
     * UNCONDITIONAL. `release()` answers `entryId: null` when there was nothing
     * to release and documents that as a success, so no caller has to check
     * first — and most cancelled orders never spent a point.
     */
    await refundPoints(db, deps().redemption, read.order.id, read.order.orderNumber, 'admin');

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
  /*
   * THE SYSTEM TEMPLATES, LOADED ONCE PER SWEEP AND PASSED DOWN AS DATA.
   *
   * Here rather than per event because the render happens inside a statement
   * builder that composes SQL synchronously — it cannot await — and a sweep
   * draining forty events would otherwise issue forty identical reads of a
   * nine-row table.
   *
   * `loadTemplates` NEVER THROWS: a failed read returns the built-in defaults, so
   * a database hiccup here degrades the wording of an email and cannot stop a
   * sweep that is also settling payments. `server/email/system-templates.ts`
   * carries the full argument.
   */
  const templates = await loadTemplates(db);
  const events = await drainCommerceEvents(
    db,
    /*
     * THE STOREFRONT'S ORIGIN, NOT THIS APP'S. `c.get('origins')[0]` is the ADMIN
     * allow-list, and building the customer's "view your order" link from it sent
     * every buyer to the dashboard — see `server/shop/storefront-url.ts`.
     */
    { origin: storefrontOrigin(), redemption: d.redemption, templates },
    { now, limit: SWEEP_BATCH, passes: RUN_SWEEP_COMMERCE_PASS_CEILING },
  );
  const emails = await sweepEmailIntents(db, d.mailer, now);
  /*
   * ASK THE COURIERS WHERE THE PARCELS ARE — the backstop behind their webhooks
   * (`shop/logistics/webhooks.ts`), reached through `d.syncCouriers` rather than
   * by importing Logistics, exactly as `drainPayments` above is reached.
   *
   * AFTER `sweepEmailIntents`, DELIBERATELY. A courier answering "delivered"
   * enqueues a shipment and a delivery email through the same statement as the
   * status change; queueing them AFTER this pass's mail run means they go out on
   * the NEXT sweep, ten minutes later, rather than being sent by a mailer whose
   * own budget has already been spent. The same ordering `runSweep` gives
   * `ensureSystemTemplates` below, and for the same reason: this pass does the
   * work, the next pass sends what it created.
   *
   * `null` RATHER THAN A ZEROED SUMMARY when nothing is wired — a deployment
   * with no courier subsystem is not the same as one that looked and found no
   * parcel, and the sweep's answer is read by an operator.
   */
  const couriers = d.syncCouriers ? await d.syncCouriers(db, now) : null;
  /*
   * THE DAILY EXCHANGE RATES (1160), after the courier pass and for the same
   * reason: nothing above depends on them. `refreshFeedRates` asks a feed only
   * when a rate is twelve hours old — twice a day on a ten-minute cadence —
   * never throws, and never touches a hand-set rate; the `.catch` is only a
   * belt against a wiring that does. A refresh here is what keeps the
   * storefront's published multipliers from going stale on a quiet week.
   */
  const rates = d.refreshRates
    ? await d.refreshRates(db, now).catch(() => ({ error: 'refresh_failed' }))
    : null;
  /*
   * SEED ANY SYSTEM TEMPLATE THAT IS NOT IN THE TABLE YET, LAST.
   *
   * Last because it is the only step here that nothing depends on: this pass
   * already rendered from whatever was in the table, and a row created now takes
   * effect on the next one. Putting it first would add nine writes to the front of
   * the work that actually settles payments, inside a function `vercel.json` caps
   * at `maxDuration: 30`.
   *
   * IN THE SWEEP AT ALL because the admin templates screen is the other seeder,
   * and a deployment nobody has opened that screen on would otherwise never seed —
   * which is fine for rendering (the built-ins cover it) and not fine for the
   * promise that an owner can find and edit these messages.
   *
   * `ensureSystemTemplates` never throws and never overwrites an edited row.
   */
  const seeded = await ensureSystemTemplates(db, now);
  return { payments, events, emails, couriers, rates, seeded, passes: events.passes };
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
 * WHO DID IT, BY NAME — for the admin view only. `actor_id` is a user id, which
 * tells a reader nothing; the customer's `/events` route reads the same timeline
 * and must NOT learn staff names, so the lookup lives here, not in `listTimeline`.
 */
async function withActorNames(db: Db, timeline: OrderTimelineEntry[]) {
  const ids = [...new Set(timeline.map((e) => e.actorId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return timeline.map((e) => ({ ...e, actorName: null }));
  const res = await db.execute(sql`
    SELECT id::text AS id, display_name FROM users WHERE id::text = ANY(${sql.param(ids)}::text[])`);
  const names = new Map(res.rows.map((r) => [String(r.id), String(r.display_name)]));
  return timeline.map((e) => ({ ...e, actorName: e.actorId ? (names.get(e.actorId) ?? null) : null }));
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
    addOns: read.addOns,
    /*
     * HOW A MANUAL ORDER WAS PAID, and the owner's note — ADMIN ONLY, and that
     * is why it is here and not on `Order`: the customer's view spreads every
     * field of `Order`. `null` for an online order.
     */
    manual: read.order.source === 'manual' ? await readManualDetails(db, read.order.id) : null,
    fulfillments: await listFulfillments(db, read.order.id),
    timeline: await withActorNames(db, await listTimeline(db, read.order.id)),
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
 * WARNING: THE STOREFRONT'S ORIGIN, NOT `c.get('origins')[0]`. This function used
 * the latter, and it is the second half of the bug `server/shop/storefront-url.ts`
 * describes: `origins` is the ADMIN app's allow-list, so a shipment mail sent by
 * an operator pressing "ship" told the customer to view their order on the admin
 * dashboard. It was invisible in every test, because on a dev box the two are the
 * same localhost.
 *
 * STILL NEVER A `Host` HEADER, which is what the old comment was really about, and
 * that reasoning stands: a link built from an attacker-supplied header is a
 * phishing link the application sent itself. `storefrontOrigin()` reads a constant
 * or an environment variable and never touches the request.
 *
 * `c` IS NO LONGER READ. The parameter is kept so the origin fix is not tangled up
 * with churn at every call site; it is the next thing to remove.
 */
function linkFor(c: Context<AppEnv>, read: OrderRead, deps: ResolvedDeps): AccessLink | null {
  void c;
  const origin = storefrontOrigin();
  if (!origin) return null;
  return {
    origin,
    token: mintGuestToken(
      { orderNumber: read.order.orderNumber, email: read.order.email },
      deps.now(),
    ),
  };
}

// ------------------------------------------------------------ manual orders

/** Minor units (kobo), whole, never negative, bounded well past any real sale. */
const Minor = z.number().int().min(0).max(100_000_000_000);

/** Optional text: trimmed, and an empty box is the same as leaving it out. */
const OptionalText = (max: number) => str().trim().max(max).optional();

/**
 * THE MANUAL ORDER BODY. Three things are required — what was sold, when, and
 * how it was paid — and everything else is optional, most of it under
 * `advanced`, which is the form's own "Advanced" dropdown. `.strict()` like
 * every body here: a mistyped field is refused, not quietly dropped.
 */
const ManualOrderBody = z
  .object({
    /** The day it was sold, as the owner's calendar says it: `YYYY-MM-DD`. */
    soldAt: str().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z
      .array(
        z
          .object({
            variantId: str().min(1).max(128),
            qty: z.number().int().min(1).max(100_000),
            /** Omitted: the variant's current price. */
            unitAmount: Minor.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    paymentMethod: z.enum(PAYMENT_METHODS),
    paymentReference: OptionalText(200),
    takeFromStock: z.boolean().optional(),
    advanced: z
      .object({
        customer: z
          .object({
            name: OptionalText(200),
            email: str()
              .trim()
              .max(320)
              .refine((s) => s === '' || /^[^\s@]+@[^\s@]+$/.test(s), 'an email address')
              .optional(),
            phone: OptionalText(50),
          })
          .strict()
          .optional(),
        salesChannel: z.enum(SALES_CHANNELS).optional(),
        address: z
          .object({
            line1: OptionalText(200),
            city: OptionalText(120),
            region: OptionalText(120),
            countryCode: str().regex(/^[A-Za-z]{2}$/).optional(),
          })
          .strict()
          .optional(),
        shippingAmount: Minor.optional(),
        discountAmount: Minor.optional(),
        taxAmount: Minor.optional(),
        note: OptionalText(2000),
      })
      .strict()
      .optional(),
  })
  .strict();

const EditManualOrderBody = ManualOrderBody.extend({ baseRevision: z.number().int().positive() }).strict();

const VoidManualOrderBody = z
  .object({ baseRevision: z.number().int().positive(), reason: OptionalText(500) })
  .strict();

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

const WAT_MS = 3_600_000;

/**
 * THE DAY SOLD, as a moment. Noon West Africa Time on that day — the analytics
 * bucket days in WAT, so noon can never slip into the day either side — except
 * today, which is now, so a sale recorded as it happens keeps its real time.
 * A day that has not happened yet is refused.
 */
export function soldAtFromDate(day: string, now: number = Date.now()): number {
  const [y, m, d] = day.split('-').map(Number);
  const noonWat = Date.UTC(y, m - 1, d, 12) - WAT_MS;
  const parsed = new Date(noonWat + WAT_MS);
  if (
    Number.isNaN(noonWat) ||
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d ||
    y < 2000
  ) {
    throw new BadRequestError('soldAt');
  }
  const today = new Date(now + WAT_MS).toISOString().slice(0, 10);
  if (day === today) return now;
  if (day > today) throw new BadRequestError('soldAt');
  return noonWat;
}

function manualInput(body: z.infer<typeof ManualOrderBody>): ManualOrderInput {
  const a = body.advanced ?? {};
  const address = a.address
    ? {
        line1: emptyToNull(a.address.line1),
        city: emptyToNull(a.address.city),
        region: emptyToNull(a.address.region),
        countryCode: a.address.countryCode ? a.address.countryCode.toUpperCase() : null,
      }
    : null;
  return {
    soldAt: soldAtFromDate(body.soldAt),
    lines: body.lines,
    paymentMethod: body.paymentMethod,
    paymentReference: emptyToNull(body.paymentReference),
    takeFromStock: body.takeFromStock ?? true,
    customer: {
      name: emptyToNull(a.customer?.name),
      email: emptyToNull(a.customer?.email),
      phone: emptyToNull(a.customer?.phone),
    },
    salesChannel: a.salesChannel ?? null,
    address: address && Object.values(address).some((v) => v !== null) ? address : null,
    shippingAmount: a.shippingAmount ?? 0,
    discountAmount: a.discountAmount ?? 0,
    taxAmount: a.taxAmount ?? 0,
    note: emptyToNull(a.note),
  };
}

/** The default wiring, for a mount site with nothing to inject. */
export const orders = createOrdersRoutes();
