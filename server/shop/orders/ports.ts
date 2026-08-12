import type { Context } from 'hono';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';
import type { PaymentPort } from '../../../shared/commerce/ports';
import { LoggingMailer, type Mailer } from './mailer';

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
export interface OrdersDeps {
  customer?: CustomerResolver;
  payments?: PaymentPort<Db> | null;
  /** Injectable so route tests are deterministic. Defaults to the wall clock. */
  now?: () => number;
  /**
   * Where email actually goes.
   *
   * ⚠️  **THE DEFAULT DOES NOT SEND EMAIL.** `LoggingMailer` records the rendered
   *     message and returns. Registering a real provider is one line —
   *     `registerOrdersDeps({ mailer: new ResendMailer(...) })` — and until somebody
   *     does, the sweeper will mark intents delivered that nobody received. The
   *     `sent` count in a sweep summary means "handed to the mailer", not
   *     "delivered", and that is true of a real provider too.
   */
  mailer?: Mailer;
}

export interface ResolvedDeps {
  customer: CustomerResolver;
  payments: PaymentPort<Db> | null;
  now: () => number;
  mailer: Mailer;
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
  };
}

/**
 * One instance, so the messages it records accumulate somewhere a deployment can be
 * asked about rather than being discarded per request. **It sends nothing.**
 */
const DEFAULT_MAILER = new LoggingMailer();
