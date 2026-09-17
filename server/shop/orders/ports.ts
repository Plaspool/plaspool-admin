import type { Context } from 'hono';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import type { PaymentPort } from '../../../shared/commerce/ports';
import { LoggingMailer, type Mailer } from './mailer';
import type { PointsRedemptionPort } from '../../../shared/marketing/redemption';
import type { DiscountCodePort } from '../../../shared/marketing/discounts';

/**
 * What this subsystem needs from the two it cannot see, **taken by injection** (contract
 * §5: "consumed by injection, never by direct import of the implementation — so every
 * consumer can be tested against a fake").
 *
 * NEITHER DEPENDENCY BLOCKS ANYTHING, and that is contract §11's test of whether the
 * design is right: "If you find yourself blocked on another agent, you have coupled to an
 * implementation instead of a port." Both default to absent, and everything except the
 * signed-in-customer list works with both absent.
 */

/** Contract §7's identity. Deliberately the narrowest thing this subsystem needs. */
export interface ShopCustomer {
  id: string;
}

/**
 * Resolve the shop customer session, or null. **NEVER 401s by itself.**
 *
 * CART OWNS THE REAL ONE. Contract §7 puts `shop_customers`,
 * `shop_customer_sessions`, the `__Host-shop_session` cookie and
 * `shopSessionMiddleware()` in Cart's half, and R1 makes them Cart's to write. So this is
 * a function this subsystem is HANDED, and the default returns null — which makes every
 * customer-scoped route answer 401 rather than pretending to have an identity it cannot
 * resolve.
 *
 * Wiring the real one is one line at the mount site:
 * `{ customer: (c) => resolveShopCustomer(currentDb(c), c) }`.
 *
 * The "never 401s by itself" split is the same one `server/middleware/session.ts`
 * documents for the writer session, and §7 requires both middlewares to be independent:
 * a single request may legitimately carry BOTH cookies (the shop owner browsing their own
 * store), and neither may clobber the other. Taking the customer as a resolver rather than
 * as a middleware that writes `c.set('user', …)` makes that structural.
 */
export type CustomerResolver = (c: Context<AppEnv>) => Promise<ShopCustomer | null>;

/** The default: nobody is signed in as a customer. */
export const NO_CUSTOMER: CustomerResolver = () => Promise.resolve(null);

/**
 * Everything the HTTP surface is handed.
 *
 * `payments` IS READ-ONLY AND FOR DISPLAY ONLY (brief `04` header). Contract §5 is explicit
 * that Payments has no port into Orders and Orders has no port into Payments FOR STATE
 * CHANGES — a capture does not call `markOrderPaid`, it appends `payment.captured` to the
 * outbox and this subsystem reacts. This port exists so an admin order page can render
 * "captured" without a second system of record, and for nothing else. `null` means the
 * page omits the panel.
 */
/**
 * Drain Payments' stored-but-unprocessed webhook events, THEN return however many
 * were looked at. The shape is deliberately loose (`unknown[]`-ish count, not
 * `ProcessResult[]`) so this file never needs to import a Payments type to declare
 * it — contract §2 R3 forbids Orders importing Payments directly, and a type-only
 * import is still an import.
 *
 * WHY THIS SEAM EXISTS AT ALL: `GET /admin/sweep` and `POST /admin/sweep` are
 * Orders' routes, but the event webhook can freeze *after* acknowledging and
 * *before* its post-response drain runs (`shop_payment_events.processed_at`
 * stays null, `last_error` stays null — no anomaly, just nothing happened). The
 * owner-gated `POST /shop/admin/payments/events/drain` is the manual safety net
 * for that; this seam is what lets the CRON-gated `runSweep` reach the same
 * safety net on a schedule, without Orders reaching into Payments' module to get
 * it.
 */
export type PaymentDrain = (db: Db, now: number) => Promise<{ count: number }>;

/** The default: nothing to drain, because nothing was wired. A deployment that
 *  forgets to register `drainPayments` degrades to today's behaviour — the
 *  commerce-event sweep still runs — rather than crashing. */
export const NO_PAYMENT_DRAIN: PaymentDrain = () => Promise.resolve({ count: 0 });

/**
 * Execute a refund against a payment intent, and report enough of it to react.
 *
 * STRUCTURAL, LIKE `PaymentDrain` ABOVE AND FOR THE IDENTICAL REASON. Contract
 * §2 R3 forbids Orders importing Payments directly, and `shared/commerce/
 * ports.ts`'s own `PaymentPort` is deliberately READ-ONLY — that file's words:
 * "Payments has no port into Orders, and Orders has no port into Payments for
 * state changes." A refund is a state change, so it does not belong on that
 * shared, append-only interface; it belongs here, exactly where `drainPayments`
 * already lives for the same reason, typed by SHAPE rather than by importing
 * `server/shop/payments/refunds.ts`.
 *
 * task-d3: "cancelling a paid order should refund it first." That coupling is
 * an ADMIN-INITIATED, SYNCHRONOUS operation — one owner clicking one button —
 * not the reactive, event-carried causation contract §2 R4 governs between
 * subsystems reacting to each other's independent events. The composition root
 * (`server/index.ts`) is the one place allowed to know both halves and is
 * where this is wired to the real `createRefund`; Orders itself only ever sees
 * this shape.
 *
 * THROWS ON A GENUINE REFUSAL — a known provider failure, an amount that would
 * exceed what is left to refund, a wrong intent status — so the caller can
 * decide NOT to cancel. See the long comment on the admin cancel route in
 * `routes.ts` for why refund-then-cancel, in that order, is what makes a
 * thrown refund leave the order untouched rather than cancelled with no money
 * moved.
 *
 * A REFUND THE GATEWAY DID NOT CARRY OUT THROWS TOO, and that includes a key
 * whose earlier attempt failed: `createRefund` used to hand that failed row
 * back as a result, so a retried cancel cancelled the order with nothing
 * refunded. It is `RefundFailedError` now (answered 422), which means an outcome
 * that comes back at all is pending or succeeded.
 */
export interface RefundOutcome {
  refundId: string;
  /** Paystack refunds settle asynchronously; `pending` is a normal, accepted
   *  outcome here and is treated the same as `succeeded` by the caller — see
   *  `routes.ts`. */
  status: 'pending' | 'succeeded' | 'failed';
}
export type RefundIssuer = (
  db: Db,
  args: {
    intentId: string;
    /** Minor units, positive. */
    amount: number;
    reason?: string;
    idempotencyKey: string;
    /** `users.id` of the owner who asked for it. */
    createdBy: string;
  },
) => Promise<RefundOutcome>;

/**
 * Ask every courier with a parcel in flight where it has got to, and report how
 * that went.
 *
 * STRUCTURAL, LIKE `PaymentDrain` AND `RefundIssuer` ABOVE, AND FOR THE SAME
 * RULE: `GET /admin/sweep` is Orders' route, and Orders does not import
 * Logistics — not even a type, since a type-only import is still an import. The
 * shape is declared here and the composition root (`server/index.ts`) is the one
 * place allowed to know that the real implementation is
 * `shop/logistics/sync.ts#syncCourierStatuses`.
 *
 * WHY IT IS IN THE SWEEP AT ALL. The couriers' webhooks are the mechanism; a
 * callback can be lost to a deploy, a cold start, a 500 answered while the
 * database was asleep, or a URL nobody registered. Without a scheduled second
 * ask, a parcel delivered on Tuesday still reads "Pending Pick-Up" in the admin
 * on Friday and its customer never got a shipment email — the same class of
 * silence `drainPayments` exists for, one subsystem over.
 *
 * IT NEVER THROWS FOR A COURIER BEING DOWN. The failure is recorded per parcel
 * and counted in `failed`, because a courier's bad afternoon must not stop the
 * sweep that also settles payments.
 */
export type CourierSync = (
  db: Db,
  now: number,
) => Promise<{ checked: number; changed: number; transitioned: number; failed: number }>;

export interface OrdersDeps {
  customer?: CustomerResolver;
  payments?: PaymentPort<Db> | null;
  /** Injectable so route tests are deterministic. Defaults to the wall clock. */
  now?: () => number;
  /**
   * Drain Payments' stored-but-unprocessed webhook events. Defaults to
   * {@link NO_PAYMENT_DRAIN}. Wired at the composition root
   * (`server/index.ts`) to `drainPaymentEvents`, the same function
   * `POST /shop/admin/payments/events/drain` calls by hand.
   */
  drainPayments?: PaymentDrain;
  /**
   * Where email actually goes.
   *
   * ⚠️  **THE DEFAULT STILL DOES NOT SEND EMAIL.** `LoggingMailer` records the
   *     rendered message and returns, and it is what a suite that registers nothing
   *     gets — deliberately, because a test that silently reached a real provider
   *     would be worse than one that sends nothing.
   *
   * WHAT HAS CHANGED: `server/index.ts` now calls `registerOrdersDefaults({ mailer:
   * portMailer(resendMailer()) })` at the composition root, so a deployment with
   * `RESEND_API_KEY` set delivers order mail for real. `portMailer` is the adapter
   * between this subsystem's `{ to, subject, body }` and `server/mail/port.ts`'s
   * `{ to, subject, text, html }`; see `mailer.ts` for why the two shapes stay
   * different rather than one becoming the other.
   *
   * The `sent` count in a sweep summary still means "handed to the mailer" and not
   * "delivered", and that is true of a real provider too.
   */
  mailer?: Mailer;
  /**
   * SPOOLPOINTS, SPENT AND GIVEN BACK (admin#2).
   *
   * A FACTORY OVER THE HANDLE, for the reason `ShopCartDeps.redemption` gives:
   * `PointsRedemptionPort` is frozen without a database argument because the
   * browser bundle compiles it, so the handle is closed over instead.
   *
   * TYPED FROM `shared/marketing/redemption.ts` — the one module spec D9 lets
   * both halves name — and injected at the composition root. This subsystem
   * never imports `server/marketing/**`.
   *
   * ABSENT MEANS NO DEBIT AND NO CREDIT. An order that carries a point count is
   * still created, still paid and still confirmed; the points simply are not
   * spent, which is a deployment that has not wired marketing rather than a
   * customer whose checkout fails.
   */
  redemption?: (db: Db) => PointsRedemptionPort;
  /**
   * DISCOUNT CODES — COUNTED, NEVER JUDGED (admin#100 Part B).
   *
   * A factory over the handle and typed from `shared/marketing/discounts.ts`,
   * for every reason `redemption` above is. This subsystem never imports
   * `server/marketing/**`.
   *
   * THE ONLY METHOD THIS SUBSYSTEM CALLS IS `redeem()`. Whether a code applies
   * was settled at the freeze, and the price is already struck by the time an
   * order exists — an Orders-side `validate()` could only ever disagree with a
   * charge that has already been made.
   *
   * ABSENT MEANS THE TALLY DOES NOT MOVE. The order is still created, paid and
   * confirmed at the discounted price; only the campaign's count goes unwritten,
   * which is a deployment that has not wired marketing rather than a customer
   * whose checkout fails.
   */
  discounts?: (db: Db) => DiscountCodePort;
  /**
   * ISSUE A REFUND (task-d3). Wired at the composition root to the real
   * `createRefund`. `null` when absent — NOT a silent no-op like `drainPayments`
   * defaults to, because a refund the admin asked for and did not get is a
   * customer out of pocket rather than a missed maintenance sweep. The cancel
   * route in `routes.ts` throws loudly, rather than proceeding, when a refund
   * was requested and this is absent.
   */
  refund?: RefundIssuer;
  /**
   * ASK THE COURIERS WHERE THE PARCELS ARE, on the schedule. See
   * {@link CourierSync}. Wired at the composition root to
   * `syncCourierStatuses`.
   *
   * ABSENT MEANS THE SWEEP SIMPLY DOES NOT ASK, and `runSweep` reports
   * `couriers: null` rather than a zeroed summary — a deployment with no
   * couriers wired is a different thing from one that looked and found nothing
   * to do, and an operator reading the sweep's answer has to be able to tell
   * them apart.
   */
  syncCouriers?: CourierSync;
  /**
   * REFRESH THE DAILY EXCHANGE RATES, on the schedule (1160). Wired at the
   * composition root to `refreshFeedRates` — injected rather than imported for
   * the same rule as `syncCouriers`. It fetches only when a rate is due (twelve
   * hours), never throws, and never touches a hand-set rate.
   *
   * ABSENT MEANS THE SWEEP DOES NOT REFRESH, and reports `rates: null`.
   */
  refreshRates?: (db: Db, now: number) => Promise<unknown>;
}

export interface ResolvedDeps {
  customer: CustomerResolver;
  payments: PaymentPort<Db> | null;
  now: () => number;
  mailer: Mailer;
  drainPayments: PaymentDrain;
  redemption?: (db: Db) => PointsRedemptionPort;
  refund: RefundIssuer | null;
  /** `null` when no courier subsystem is wired — see {@link OrdersDeps.syncCouriers}. */
  syncCouriers: CourierSync | null;
  /** `null` when not wired — see {@link OrdersDeps.refreshRates}. */
  refreshRates: ((db: Db, now: number) => Promise<unknown>) | null;
}

/**
 * Dependencies registered ONCE AT BOOT, for the router instance that
 * `server/shop/app.ts` mounts.
 *
 * WHY A REGISTRY AT ALL, GIVEN `createApp`'S OWN WARNING against module-scope
 * singletons. That warning is specific and it does not cover this: it is about a
 * baked-in `getDb()` (which would dial Neon at import time and demand
 * `DATABASE_URL` from every suite) and about the rate limiter, which must bound the
 * DEPLOYMENT rather than one instance. Neither applies to a resolver function —
 * there is nothing to connect to, nothing per-request, and no shared counter.
 *
 * WHAT FORCED IT. `server/shop/app.ts` is the shared mount point and it composes
 * routers with no arguments — `shop.route('/', orders)` — because contract §11 asks
 * each subsystem for "two lines" there and a deps-threading signature would make it
 * four agents' worth of parameters. Hono resolves two routers claiming one path by
 * registration order, so a second, injected copy mounted alongside would simply
 * never be reached. Registration is therefore the only seam that both keeps
 * `server/shop/app.ts` argument-free and keeps the dependencies injectable.
 *
 * READ PER REQUEST, NOT AT CONSTRUCTION, so the order of "mount the router" and
 * "register the resolver" cannot matter — which is what makes it safe for Cart to
 * call `registerOrdersDeps` from its own module whenever it lands.
 *
 * Explicit construction deps still win over the registry, so
 * `createOrdersRoutes({ customer })` remains the direct form.
 */
let registry: OrdersDeps = {};

/**
 * Wire a dependency. Called once, at boot, by whoever owns the real implementation:
 *
 *     registerOrdersDeps({ customer: (c) => resolveShopCustomer(currentDb(c), c) });
 */
export function registerOrdersDeps(deps: OrdersDeps): void {
  registry = { ...registry, ...deps };
}

/**
 * Register only what nobody has registered yet. **For the composition root.**
 *
 * WHY THIS EXISTS RATHER THAN A SECOND `registerOrdersDeps` CALL. `server/index.ts`
 * wires the real mailer inside `createApp()`, and `createApp()` is what
 * `server/test/http.ts` builds for EVERY server suite in this repository — so a
 * last-write-wins registration there would run after a suite had already registered
 * its own fake and would silently replace it. The failure is invisible: the test
 * still passes, having asserted on a recorder nothing ever called.
 *
 * Fill-only-absent makes the two orders of "build the app" and "register a fake"
 * equivalent, which is the same property `resolveDeps` buys by reading the registry
 * PER REQUEST rather than at construction. In production there is exactly one
 * registration, so it wins; in a suite the explicit one wins, whenever it happened.
 *
 * `undefined` is the test for "absent" rather than `in`, so
 * `registerOrdersDeps({ mailer: undefined })` — which is what an options object
 * with an unset key produces — does not count as having claimed the slot.
 */
export function registerOrdersDefaults(deps: OrdersDeps): void {
  const merged: OrdersDeps = { ...deps };
  for (const [key, value] of Object.entries(registry)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  registry = merged;
}

/** Forget everything registered. For tests, so one suite cannot leak into the next. */
export function resetOrdersDeps(): void {
  registry = {};
}

/**
 * Construction deps, then the registry, then the defaults.
 *
 * The default `customer` is `NO_CUSTOMER`, which makes every customer-scoped route
 * answer 401 until Cart registers a real one — honest, rather than falling back to
 * the writer session and showing one caller everybody's orders.
 */
export function resolveDeps(deps: OrdersDeps = {}): ResolvedDeps {
  const merged = { ...registry, ...deps };
  return {
    customer: merged.customer ?? NO_CUSTOMER,
    payments: merged.payments ?? null,
    now: merged.now ?? (() => Date.now()),
    mailer: merged.mailer ?? DEFAULT_MAILER,
    drainPayments: merged.drainPayments ?? NO_PAYMENT_DRAIN,
    redemption: merged.redemption,
    refund: merged.refund ?? null,
    syncCouriers: merged.syncCouriers ?? null,
    refreshRates: merged.refreshRates ?? null,
  };
}

/**
 * One instance, so the messages it records accumulate somewhere a deployment can be
 * asked about rather than being discarded per request. **It sends nothing.**
 */
const DEFAULT_MAILER = new LoggingMailer();
