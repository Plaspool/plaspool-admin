import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readJsonOrEmpty, str } from '../../../middleware/errors';
import { NotFoundError } from '../../../repo/errors';
import { addLine, createCart, getCart, listLines, removeLine, setLineQty } from '../cart/repo';
import { adoptCartForCustomer } from '../cart/merge';
import { runCartMaintenance } from '../events/consumer';
import { computeTotals } from '../totals/compute';
import { unknownZoneTaxRate } from '../checkout/shipping';
import { cartCookie, clearCartCookie, setCartCookie } from '../identity/cookies';
import { currentCustomer, shopClientIp, shopDb, shopLimit } from '../shop-env';
import {
  CART_CREATE_LIMIT,
  CART_CREATE_WINDOW_MS,
  CART_WRITE_LIMIT,
  CART_WRITE_WINDOW_MS,
} from '../limits';
import type { Cart } from '../cart/repo';
import type { ShopCartDeps } from './deps';
import type { ShopEnv } from '../shop-env';
import type { Context } from 'hono';
import type { Db } from '../../../db/client';

/**
 * The cart surface (brief §6).
 *
 * ═══ ANONYMOUS BY DEFAULT ═══
 * Not one route here requires a customer. Contract §7: "Guest checkout is the
 * default path. A cart exists before any identity does. Do not require an
 * account to buy." The cart is identified by `__Host-shop_cart`, which carries a
 * cart id and no identity at all.
 *
 * ═══ THE CART COOKIE IS NOT A CAPABILITY ANYBODY ELSE CAN GUESS ═══
 * A cart id is the only thing standing between two strangers' baskets, so it is
 * minted the same way a session token is (16 hex characters of a v4 UUID after a
 * time prefix), and every line mutation is scoped to the cart as well as the
 * line — `repo.ts` refuses a line id that belongs to another cart even when the
 * caller holds it.
 *
 * ═══ RATE LIMITS ═══
 * Cart creation is per IP, line writes are per cart. Both go through
 * `server/middleware/ratelimit.ts`, which keeps its counters in Postgres — see
 * `limits.ts` for why that matters more here than anywhere else in the app.
 */
export function cartRoutes(deps: ShopCartDeps): Hono<ShopEnv> {
  const routes = new Hono<ShopEnv>();

  /**
   * Create a cart, or adopt the one the cookie already names.
   *
   * ADOPT RATHER THAN REPLACE. A double-submitted "start shopping" must not
   * strand the first basket — the shopper would watch their items vanish with no
   * explanation, which is the worst version of every failure in this brief.
   */
  routes.post('/cart', async (c) => {
    const db = shopDb(c);
    const existing = await currentCart(c, db);
    if (existing) return c.json(await view(c, db, deps, existing));

    await shopLimit(c, `shop-cart-new:${shopClientIp(c)}`, CART_CREATE_LIMIT, CART_CREATE_WINDOW_MS);
    const cart = await createCart(db, {
      currency: deps.storeCurrency,
      customerId: currentCustomer(c)?.id ?? null,
    });
    setCartCookie(c, cart.id, cart.expiresAt);
    return c.json(await view(c, db, deps, cart), 201);
  });

  /**
   * The basket. `cart: null` for a browser that has never had one.
   *
   * NO WRITE ON A READ — a `GET` that created a row would make every crawler and
   * every prefetch a cart, and would put the rate limiter on the page a shopper
   * loads most.
   */
  routes.get('/cart', async (c) => {
    const db = shopDb(c);
    const cart = await currentCart(c, db);
    if (!cart) return c.json({ cart: null, lines: [], preview: null, changes: [] });
    return c.json(await view(c, db, deps, cart));
  });

  routes.post('/cart/lines', async (c) => {
    const db = shopDb(c);
    const body = await readJson(c, AddLineBody);
    const cart = await requireCart(c, db);
    await limitWrites(c, cart.id);
    const { cart: after } = await addLine(db, {
      cartId: cart.id,
      variantId: body.variantId,
      qty: body.qty,
      baseRevision: body.baseRevision,
    });
    return c.json(await view(c, db, deps, after), 201);
  });

  routes.patch('/cart/lines/:id', async (c) => {
    const db = shopDb(c);
    // THE PATH SEGMENT IS JUDGED FIRST — before the body, before the cookie,
    // before any database read. See the note on `pathParam` below.
    const lineId = pathParam(c, 'id');
    const body = await readJson(c, SetQtyBody);
    const cart = await requireCart(c, db);
    await limitWrites(c, cart.id);
    const { cart: after } = await setLineQty(db, {
      cartId: cart.id,
      lineId,
      qty: body.qty,
      baseRevision: body.baseRevision,
    });
    return c.json(await view(c, db, deps, after));
  });

  /**
   * `pathParam` FIRST, and this ordering is a fix rather than a preference.
   *
   * It used to resolve the cart before reading `:id`, so
   * `DELETE /api/shop/cart/lines/%00` from a browser with no cart cookie
   * answered 404 (no cart) instead of 400 (that is not a storable id). Found by
   * `server/nul-bytes.test.ts` — which walks every REGISTERED route — the moment
   * these routes were mounted into the real app, and by nothing before that,
   * because Cart's own suite always had a cart in hand.
   *
   * The ordering is right independently of that test: a NUL in the URL is a 400
   * whatever the caller's session state, and a malformed request should be
   * refused on its own terms rather than after a database read it did not earn.
   */
  routes.delete('/cart/lines/:id', async (c) => {
    const db = shopDb(c);
    const lineId = pathParam(c, 'id');
    const body = await readJsonOrEmpty(c, BaseOnlyBody);
    const cart = await requireCart(c, db);
    await limitWrites(c, cart.id);
    const after = await removeLine(db, {
      cartId: cart.id,
      lineId,
      baseRevision: body.baseRevision,
    });
    return c.json(await view(c, db, deps, after));
  });

  return routes;
}

// ------------------------------------------------------------------- helpers

async function limitWrites(c: Context<ShopEnv>, cartId: string): Promise<void> {
  // Keyed on the CART, not the IP: a shared office is one address and many
  // shoppers, and a per-IP limit would make the shop look broken at exactly the
  // moment it is busiest.
  await shopLimit(c, `shop-cart-write:${cartId}`, CART_WRITE_LIMIT, CART_WRITE_WINDOW_MS);
}

/**
 * Statuses a browser may still be holding as "my basket".
 *
 * `converting` IS ONE OF THEM: that is a cart mid-payment, and the shopper is
 * looking at the page that will either finish or fail — a payment that fails
 * sends it back to `open` and they still have their basket. `converted` and
 * `abandoned` are terminal, and `currentCart` retires the cookie naming one.
 */
const LIVE_STATUSES: readonly Cart['status'][] = ['open', 'converting'];

/** The cart the cookie names, or null. Never creates one. */
async function currentCart(c: Context<ShopEnv>, db: Db): Promise<Cart | null> {
  const id = cartCookie(c);
  if (!id) return null;
  const cart = await getCart(db, id);
  /*
   * A cookie naming a cart that no longer exists — swept, or from another
   * deployment — resolves to null rather than 404ing. The shopper gets an empty
   * basket and can fill it again, which is what they would do anyway; a 404 on
   * the shop's landing page is a dead end they cannot clear without knowing
   * about cookies.
   */
  if (!cart) return null;

  /*
   * ═══ A CART THAT HAS BECOME AN ORDER IS NOT THIS BROWSER'S BASKET ═══
   *
   * `converted` is TERMINAL — `cart/repo.ts` gives it no outgoing edge at all,
   * because it has become an order and Orders owns what happens next. But
   * nothing retired the cookie that named it, so the browser went on presenting
   * a dead cart as its live basket:
   *
   *   - `GET /cart` answered the converted cart, lines and all, with a live
   *     price preview — so the drawer redrew a basket the shopper had already
   *     paid for, indefinitely.
   *   - every line write was then correctly refused with
   *     `409 precondition_failed`, so "Remove" did nothing.
   *   - checkout could not start again, and the shopper had no way to clear it
   *     that did not involve knowing what a cookie is.
   *
   * `clearCartCookie` existed for this and had NEVER been called from anywhere
   * in the server. This is the call site it was written for.
   *
   * THE SAME ANSWER AS A SWEPT CART, and deliberately so: from the shopper's
   * side "your basket is gone because you bought it" and "your basket is gone
   * because it expired" are the same situation — an empty basket they can fill
   * again. The order itself is not lost; it is in `/account/orders` and in the
   * receipt email, which is where an order belongs.
   *
   * `POST /cart` calls this too, so a shopper who adds something after checking
   * out gets a genuinely new cart: this clears the stale cookie and the create
   * path writes a fresh one over it in the same response.
   */
  if (!LIVE_STATUSES.includes(cart.status)) {
    clearCartCookie(c);
    return null;
  }

  return cart;
}

async function requireCart(c: Context<ShopEnv>, db: Db): Promise<Cart> {
  const cart = await currentCart(c, db);
  if (!cart) throw new NotFoundError(cartCookie(c) ?? 'cart');
  return cart;
}

/**
 * The cart as a storefront needs it: lines resolved through `CatalogPort`, an
 * indicative total, and whatever the merge changed.
 *
 * ═══ AN UNRESOLVABLE LINE IS RENDERED, NOT DROPPED ═══
 * Brief §3: "render an unresolvable line as 'no longer available' rather than
 * dropping it. A line that vanishes with no explanation is the worst version of
 * this." So the line comes back with `available: false` and no price, and the
 * preview total is `null` — because there is no honest number for a basket
 * containing something that cannot be priced.
 *
 * ═══ THE PREVIEW IS NOT THE PRICE ═══
 * It is computed live on every read and is explicitly not what anyone is
 * charged. The tax rate is the NAMED zero rate until an address exists, so a
 * shopper never sees a domestic-VAT figure that the real checkout then changes.
 * `freezeCheckout` is the only thing that produces a number that binds.
 */
async function view(
  c: Context<ShopEnv>,
  db: Db,
  deps: ShopCartDeps,
  cart: Cart,
): Promise<Record<string, unknown>> {
  /*
   * MAINTENANCE LAZILY ON READ (brief §4) — drain the outbox, then sweep. Small
   * bound and best-effort: this is nobody's request, so a failure must not cost
   * a shopper their basket page.
   *
   * THE LAZY DRAIN IS STILL LOAD-BEARING NOW THAT A CRON EXISTS, because of what
   * the cron can be. `vercel.json` schedules `/api/shop/admin/cart/maintenance`,
   * but **Vercel's Hobby plan caps a cron at ONCE PER DAY** — a more frequent
   * expression fails the deployment outright — and invokes it anywhere inside
   * the named hour. Against a 15-minute reservation TTL that is a backstop, not
   * a mechanism: a capture landing at 09:00 would wait until the next morning.
   *
   * Any shopper loading any basket drains a few events, so on a shop with
   * traffic a capture is committed within seconds. On a shop with none, nothing
   * runs at all — which is safe rather than merely lucky, because the sweeper
   * runs on the same call and therefore cannot expire a hold the drain has not
   * had a chance to commit first. The daily cron then catches up.
   *
   * FIVE, not the drain's own 25: this runs on the page a storefront loads most,
   * and the cron route is where a backlog is supposed to be cleared.
   */
  await runCartMaintenance(db, deps.catalog, { limit: 5 }).catch(() => undefined);

  // A signed-in shopper carrying an anonymous cart gets it attached, and their
  // previous basket merged in, on the next read — see `cart/merge.ts` for why
  // the redeem route does not do this itself.
  const customer = currentCustomer(c);
  let changes: unknown[] = [];
  let current = cart;
  if (customer && cart.customerId !== customer.id) {
    const outcome = await adoptCartForCustomer(db, deps.catalog, {
      guestCartId: cart.id,
      customerId: customer.id,
    });
    changes = outcome.changes;
    if (outcome.cartId !== cart.id) {
      const merged = await getCart(db, outcome.cartId);
      if (merged) {
        current = merged;
        setCartCookie(c, merged.id, merged.expiresAt);
      }
    } else {
      current = (await getCart(db, cart.id)) ?? cart;
    }
  }

  const lines = await listLines(db, current.id);
  const quoted = await Promise.all(
    lines.map(async (line) => ({ line, quote: await deps.catalog.quote(db, line.variantId) })),
  );

  const computed = computeTotals({
    currency: current.currency,
    lines: quoted.map(({ line, quote }) => ({
      variantId: line.variantId,
      qty: line.qty,
      unit: quote ? quote.price : null,
    })),
    shipping: null,
    tax: unknownZoneTaxRate(),
    adjustments: [],
  });

  return {
    cart: {
      id: current.id,
      currency: current.currency,
      status: current.status,
      revision: current.revision,
      expiresAt: current.expiresAt,
      email: current.email,
      shippingOptionId: current.shippingOptionId,
      taxZone: current.taxZone,
      customerId: current.customerId,
    },
    lines: quoted.map(({ line, quote }) => ({
      id: line.id,
      variantId: line.variantId,
      qty: line.qty,
      available: quote !== null,
      sku: quote?.sku ?? null,
      title: quote?.title ?? null,
      optionValues: quote?.optionValues ?? null,
      unit: quote?.price ?? null,
      inStock: quote ? quote.available : 0,
    })),
    /*
     * `null` rather than a partial total whenever ANY line cannot be priced. A
     * basket showing "£19.99" beside three items, one of which is unavailable,
     * is a number that will change; showing none is the honest state and it is
     * what makes the "no longer available" badge worth reading.
     */
    preview: computed.ok ? computed.totals : null,
    changes,
  };
}

// -------------------------------------------------------------------- bodies

/**
 * `baseRevision` is OPTIONAL on every mutation, and that is a deliberate
 * asymmetry with `PATCH /api/posts/:id`.
 *
 * A writer's editor always knows the revision it loaded; a storefront's "add to
 * basket" button is pressed from a cached page and a rendered email, and
 * demanding a token there would turn an ordinary purchase into a 400. When it IS
 * supplied — the basket page, which has just rendered one — the CAS uses it and
 * a second tab's concurrent edit produces a 409 carrying the current cart.
 */
const Base = z.number().int().positive().optional();

const AddLineBody = z
  .object({
    variantId: str().min(1).max(128),
    // Bounded well below anything a shop sells one of: an unbounded quantity is
    // an integer overflow looking for a place to happen, and `qty * unit` is
    // multiplied inside `Money`, which refuses anything past 2^53.
    qty: z.number().int().min(1).max(10_000),
    baseRevision: Base,
  })
  .strict();

const SetQtyBody = z
  .object({ qty: z.number().int().min(1).max(10_000), baseRevision: Base })
  .strict();

const BaseOnlyBody = z.object({ baseRevision: Base }).strict();
