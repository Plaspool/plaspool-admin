import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readJson, readJsonOrEmpty, str } from '../../../middleware/errors';
import { requireAuth } from '../../../middleware/session';
import { NotFoundError } from '../../../repo/errors';
import { getCart } from '../cart/repo';
import {
  applyDiscount,
  freezeCheckout,
  frozenTotals,
  previewCheckout,
  putAddresses,
  removeDiscount,
  setShipping,
  shippingOptionsForCart,
  startCheckout,
  thawCheckout,
} from '../checkout/repo';
import { setAddOnChoice } from '../checkout/add-ons';
import { loadShippingZonesForCheckout } from '../checkout/shipping-zones-repo';
import { loadDeliveryRules } from '../../settings/repo';
import { ADDRESS_MAX_LENGTHS } from '../../settings/config';
import { extendReservations } from '../reservations/repo';
import { runCartMaintenance } from '../events/consumer';
import { assertCronRequest } from '../cron-auth';
import { cartCookie } from '../identity/cookies';
import { CHECKOUT_START_LIMIT, CHECKOUT_START_WINDOW_MS } from '../limits';
import type { CheckoutConfig, PricingRefusal } from '../checkout/repo';
import type { ShopCartDeps } from './deps';
import { shopDb, shopLimit } from '../shop-env';
import type { ShopEnv } from '../shop-env';
import type { Context } from 'hono';
import type { Db } from '../../../db/client';

/**
 * The checkout surface (brief §6).
 *
 * ═══ HOW A FAILURE IS REPORTED, AND WHY IT IS NOT AN EXCEPTION ═══
 * `startCheckout` and `freezeCheckout` return discriminated results, and these
 * routes turn them into 409s carrying the SPECIFICS — which line is short and by
 * how many, which variant vanished. A 409 stops the client's retry policy (spec
 * §8) because none of these can be fixed by asking again; and the body carries
 * what the shopper needs to fix it themselves.
 *
 * ═══ WHAT IS NOT HERE ═══
 * There is no `POST /checkout/complete`. Completing a checkout emits
 * `checkout.completed`, which is what Orders builds an order from, and exposing
 * it as a public route would let anybody convert a cart without paying. It is an
 * exported function whose caller is the seam contract §6 leaves open — see
 * AMENDMENTS A-007.
 */
export function checkoutRoutes(deps: ShopCartDeps): Hono<ShopEnv> {
  const routes = new Hono<ShopEnv>();

  /**
   * Live zones, read from the database on every request (admin#19), so an
   * operator's rate edit is visible on the next checkout call rather than after
   * a deploy. `deps.zones` — which defaults to `DEFAULT_SHIPPING_ZONES`, the
   * empty-database fallback in `checkout/shipping.ts` — is used only when the
   * table has zero rows, exactly as a fresh deployment needs.
   */
  async function loadConfig(db: Db): Promise<CheckoutConfig> {
    /*
     * BOTH READS IN PARALLEL. They are independent — the zones table and the
     * settings singleton — and this runs on every address, options, shipping
     * and freeze call, so serialising them would add a round trip to the
     * checkout's hottest path for nothing.
     */
    const [dbZones, rules] = await Promise.all([
      loadShippingZonesForCheckout(db),
      loadDeliveryRules(db),
    ]);
    return {
      zones: dbZones.length > 0 ? dbZones : deps.zones,
      /* How addresses are collected and which regions are served (migration
       * 0760). Read live for the same reason the zones are: a switch the owner
       * flips must reach the next checkout call, not the next deploy. */
      rules,
      storeCurrency: deps.storeCurrency,
      /* SpoolPoints, when this deployment wired them (admin#2). Passed straight
       * through: the route decides nothing about redemption, `freezeCheckout`
       * does. */
      redemption: deps.redemption,
      /* Discount codes, likewise (admin#100 Part B). */
      discounts: deps.discounts,
      /* Payments, for the one question a thaw has to ask before it reopens a
       * frozen checkout. Absent refuses — see `ShopCartDeps.payments`. */
      payments: deps.payments,
      /* Checkout add-ons (spec 2026-09-06). Absent means no add-ons anywhere —
       * see `ShopCartDeps.addOns`. */
      addOns: deps.addOns,
    };
  }

  /** Reserve stock. Freezes nothing. */
  routes.post('/checkout/start', async (c) => {
    const db = shopDb(c);
    const cart = await requireCart(c, db);
    await shopLimit(
      c,
      `shop-checkout:${cart.id}`,
      CHECKOUT_START_LIMIT,
      CHECKOUT_START_WINDOW_MS,
    );

    const result = await startCheckout(db, deps.catalog, { cartId: cart.id });
    if (!result.ok) {
      if (result.reason === 'empty_cart') {
        /*
         * ═══ `reason` IS ADDITIVE, AND `operation` STAYS THE OPERATION ═══
         * Everywhere else in this server `operation` names the operation —
         * `update_cart`, `remove_line`, `capture`, `parseWebhook`. The freeze
         * route below is the exception: it passes its REASON through the same
         * key, which is where `empty_cart` and `no_shipping_address` come
         * from, and the storefront was written against that second sense.
         *
         * So this refusal — an empty cart, reported honestly as
         * `operation: 'checkout_start'` — matched neither of the storefront's
         * two branches and fell through to its unnamed-error copy. A shopper
         * at step 1 of 4 was told "That didn't go through. Try again" about a
         * cart the store could simply have said was empty.
         *
         * Renaming `operation` would fix that by spreading the overload, and
         * would break every consumer already reading it. A separate `reason`
         * costs one key, breaks nothing, and means only one thing.
         */
        return c.json(
          { error: 'precondition_failed', operation: 'checkout_start', reason: 'empty_cart' },
          409,
        );
      }
      // THE NUMBER, in the body. "Out of stock" is not actionable; "only 3 left"
      // lets the shopper reduce the quantity without leaving the page.
      return c.json(
        { error: 'insufficient_stock', shortfalls: result.shortfalls },
        409,
      );
    }
    return c.json({
      reservations: result.reservations.map((r) => ({
        id: r.id,
        variantId: r.variantId,
        qty: r.qty,
        expiresAt: r.expiresAt,
      })),
    });
  });

  routes.put('/checkout/addresses', async (c) => {
    const db = shopDb(c);
    const body = await readJson(c, AddressesBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);
    const { zone } = await putAddresses(db, config, {
      cartId: cart.id,
      shipping: body.shipping,
      billing: body.billing ?? null,
      baseRevision: body.baseRevision,
    });
    return c.json({ zone, options: await shippingOptionsForCart(db, config, cart.id) });
  });

  routes.get('/checkout/shipping-options', async (c) => {
    const db = shopDb(c);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);
    return c.json({ options: await shippingOptionsForCart(db, config, cart.id) });
  });

  routes.put('/checkout/shipping', async (c) => {
    const db = shopDb(c);
    const body = await readJson(c, ShippingBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);
    const option = await setShipping(db, config, {
      cartId: cart.id,
      optionId: body.optionId,
      baseRevision: body.baseRevision,
    });
    return c.json({ shipping: option });
  });

  /**
   * Back out of payment: `converting → open`, basket intact.
   *
   * ═══ THE ROUTE THAT SHOULD HAVE EXISTED FROM THE START ═══
   *
   * `cart/repo.ts` has always listed `converting → open` as a legal transition
   * with a comment promising exactly this, and until now no route, function or
   * scheduled job anywhere in the application performed it. A shopper who
   * reached Paystack and did not pay was locked out of their own checkout
   * permanently — see `thawCheckout` for the full account.
   *
   * ═══ SAFE TO CALL WHENEVER THE SHOPPER LEAVES A PAYMENT PAGE ═══
   *
   * Idempotent on an already-open cart (200, nothing written), so the
   * storefront may fire it from a back button, a "change my details" link, and
   * a `beforeunload` without tracking which of them ran. What it is NOT safe
   * to call blindly on is a cart that was paid: that answers 409
   * `operation: 'checkout_paid'` and the shopper should be sent to their
   * order, not back to the basket.
   *
   * `baseRevision` is OPTIONAL here where the edit routes want it. A shopper
   * abandoning a payment has no competing writer to lose a race against, and
   * demanding a token they may not have would make the recovery fail for
   * exactly the disoriented caller it exists to serve.
   */
  routes.post('/checkout/cancel', async (c) => {
    const db = shopDb(c);
    const body = await readJsonOrEmpty(c, BaseOnlyBody);
    const cart = await requireCart(c, db);
    /*
     * ITS OWN BUCKET, not `shop-checkout:`. Sharing the start limiter would let
     * a shopper who backed out twice exhaust the allowance for STARTING a
     * checkout — locking them out of the thing the cancel exists to return
     * them to. Same numbers, separate key.
     */
    await shopLimit(
      c,
      `shop-checkout-cancel:${cart.id}`,
      CHECKOUT_START_LIMIT,
      CHECKOUT_START_WINDOW_MS,
    );
    const config = await loadConfig(db);
    const after = await thawCheckout(db, config, {
      cartId: cart.id,
      baseRevision: body.baseRevision,
    });
    /*
     * THE CART COMES BACK, not a bare `{ ok: true }`. Its `revision` is the
     * token every subsequent edit must chain off, and its `status` is what the
     * storefront re-renders from — asking for both in a second round trip
     * would leave a window in which the page shows a frozen basket that is no
     * longer frozen.
     */
    return c.json({
      cart: {
        id: after.id,
        status: after.status,
        revision: after.revision,
        currency: after.currency,
      },
    });
  });

  /**
   * Freeze. From here the number is the price.
   *
   * Reservations are extended ONCE here rather than at `start`, because this is
   * the step immediately before payment — extending at start would spend the one
   * extension on a shopper who is still typing an address.
   */
  routes.post('/checkout/freeze', async (c) => {
    const db = shopDb(c);
    const body = await readJsonOrEmpty(c, FreezeBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);

    const result = await freezeCheckout(db, deps.catalog, config, {
      cartId: cart.id,
      baseRevision: body.baseRevision,
      redeemPoints: body.redeemPoints,
    });
    if (!result.ok) return refusePricing(c, result);

    await extendReservations(db, cart.id);
    return c.json({ totals: result.totals });
  });

  /**
   * Price the cart WITHOUT freezing it (admin#100 Part A, storefront#112).
   *
   * ═══ WHY IT IS A POST, GIVEN THAT IT WRITES NOTHING ═══
   * Because it takes a body, and because it must never be cached. `redeemPoints`
   * is the shopper's opt-in; as a GET it would be a query parameter on a URL
   * that a browser, a proxy or a CDN is entitled to cache — and the answer
   * depends on the caller's cart cookie and their points balance, so one
   * shopper's total could be served to another. That is the same reasoning
   * `reviews/public.ts` sets out for keeping per-viewer data off a cacheable
   * router. The route is otherwise a read in every sense that matters: no
   * `UPDATE`, no reservation, no clock, and the cart's revision is untouched —
   * which `routes/preview.test.ts` asserts rather than assumes.
   *
   * NO `baseRevision`. Every other checkout write takes one so a stale client
   * loses the race rather than overwriting; a read has no race to lose. The
   * freeze still takes one, which is where a cart that moved underneath the
   * shopper is actually caught.
   *
   * THE SAME REFUSALS AS THE FREEZE, through the same function, so a storefront
   * that can render one can render the other and the two cannot drift.
   */
  routes.post('/checkout/preview', async (c) => {
    const db = shopDb(c);
    const body = await readJsonOrEmpty(c, PreviewBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);

    const result = await previewCheckout(db, deps.catalog, config, {
      cartId: cart.id,
      redeemPoints: body.redeemPoints,
    });
    if (!result.ok) return refusePricing(c, result);

    return c.json({ totals: result.totals, redemption: result.redemption, addOns: result.addOns });
  });

  /**
   * Apply a discount code to the cart (admin#100 Part B, storefront#113).
   *
   * ═══ 501 WHEN THE PORT IS NOT WIRED, AND NOT 404 ═══
   * "This deployment does not do discount codes" and "that code does not exist"
   * are different facts and need different words: the first is not something a
   * shopper can fix by typing a better code. It is also the discipline the
   * bridge exchange already keeps for a missing `bridgeSecret`. In practice a
   * storefront never reaches it, because `discountCodesEnabled` on the cart view
   * is derived from the same dependency and it will not render the field.
   *
   * A REJECTION IS A 409 WITH ITS REASON, never a bare 400. storefront#113:
   * "never a generic 'something went wrong'" — each of the six reasons implies a
   * different next step, and a shopper told the generic one retries, which
   * cannot fix any of them.
   */
  routes.post('/checkout/discount', async (c) => {
    if (!deps.discounts) return c.json({ error: 'not_implemented' }, 501);
    const db = shopDb(c);
    const body = await readJson(c, DiscountBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);

    const result = await applyDiscount(db, config, {
      cartId: cart.id,
      code: body.code,
      baseRevision: body.baseRevision,
      now: Date.now(),
    });
    if (!result.ok) {
      return c.json({ error: 'discount_rejected', reason: result.reason }, 409);
    }
    return c.json({ discount: result.discount });
  });

  /**
   * Take the code off the cart. IDEMPOTENT: clearing nothing is a 204, because
   * the storefront's control must not have to know whether a code is applied,
   * and a 409 there is a dead end on the screen whose job is to escape one.
   *
   * NO 501 GUARD, deliberately — removing a code needs no port, and a
   * deployment that lost the dependency must still let a shopper clear the code
   * that is now refusing their freeze.
   */
  routes.delete('/checkout/discount', async (c) => {
    const db = shopDb(c);
    const body = await readJsonOrEmpty(c, BaseOnlyBody);
    const cart = await requireCart(c, db);
    await removeDiscount(db, { cartId: cart.id, baseRevision: body.baseRevision });
    return c.body(null, 204);
  });

  /**
   * Record the shopper's answer (spec §6). Open cart only, CAS like every
   * edit. One 409 code for "nothing to answer right now" AND "no such
   * add-on": the storefront's remedy is the same silent re-read, and a 404
   * gone here would be read by its client as a lost cart.
   *
   * TAKES AN `opt_out` ANSWER TOO, since 0960 -- 'declined' there means
   * "take the box out and pay me back", not "no thanks". Only `include`
   * offers no choice at all, and it is the only mode this refuses.
   */
  routes.put('/checkout/add-ons/:addOnId', async (c) => {
    if (!deps.addOns) return c.json({ error: 'not_implemented' }, 501);
    const db = shopDb(c);
    const addOnId = pathParam(c, 'addOnId');
    const body = await readJson(c, AddOnChoiceBody);
    const cart = await requireCart(c, db);
    const config = await loadConfig(db);
    const result = await setAddOnChoice(db, deps.catalog, config, {
      cartId: cart.id,
      addOnId,
      choice: body.choice,
      baseRevision: body.baseRevision,
      now: Date.now(),
    });
    if (!result.ok) return c.json({ error: 'add_on_not_offered' }, 409);
    return c.json({
      cart: { id: result.cart.id, status: result.cart.status, revision: result.cart.revision, currency: result.cart.currency },
      addOns: result.offers,
    });
  });

  /** The frozen totals, for a client re-rendering the payment step. */
  routes.get('/checkout/totals', async (c) => {
    const db = shopDb(c);
    const cart = await requireCart(c, db);
    return c.json({ totals: await frozenTotals(db, cart.id) });
  });

  /**
   * Cart's housekeeping: DRAIN the outbox, then sweep expired holds (brief §4).
   *
   * ONE PATH, TWO METHODS, TWO CREDENTIALS.
   *
   * - **GET** is what Vercel's cron issues, authenticated by
   *   `Authorization: Bearer $CRON_SECRET` (see `cron-auth.ts`). A GET that
   *   mutates is not something to be pleased about; the platform issues nothing
   *   else for a cron, and an endpoint it cannot invoke is an endpoint that does
   *   nothing. `originGuard` waves every GET through, so that token is the only
   *   thing in front of this — and it fails closed when unset.
   * - **POST** is for an operator running it by hand, behind `requireAuth()` and
   *   a session cookie, under `/admin/*` as contract §10 requires.
   *
   * Neither credential is accepted in place of the other: a leaked session must
   * not become a way to drive maintenance, and the cron token must not become a
   * general-purpose admin credential.
   *
   * ONE ROUTE FOR BOTH JOBS, AND IN THAT ORDER. They are not independent: a
   * `payment.captured` that arrives after the TTL has elapsed must still sell
   * the stock, so the drain has to run before the sweeper looks. The other way
   * round the sweeper releases units somebody has paid for and the capture then
   * finds nothing to commit. Splitting them into two routes would make the
   * ordering a caller's problem, and callers are cron entries nobody reads.
   *
   * A ROUTE AND NOT A TIMER, deliberately. Brief §4: "Do not build a background
   * timer. Sweep lazily on read plus on a cron route, the same shape the image
   * orphan sweep uses." A tight retry loop froze a tab in GAUNTLET I Round 1 #2;
   * a tight loop on a serverless platform does the same to a bill.
   */
  routes.get(CRON_ROUTE, async (c) => {
    assertCronRequest(c.req.header('Authorization'));
    return c.json(await maintenance(c, deps, Number(c.req.query('limit')) || undefined));
  });

  routes.post(CRON_ROUTE, requireAuth(), async (c) => {
    const body = await readJsonOrEmpty(c, SweepBody);
    return c.json(await maintenance(c, deps, body.limit));
  });

  return routes;
}

/**
 * The route both methods share, so the two credentials cannot drift into two
 * behaviours.
 *
 * `abandoned` and `failed` are reported rather than swallowed. A non-zero
 * `abandoned` means a capture Cart could not read and has given up on — stock
 * held for a sale that already happened. A non-zero `failed` means stock held
 * for checkouts that are over. Neither has any other signal, and Vercel does not
 * retry a failed cron invocation.
 */
async function maintenance(c: Context<ShopEnv>, deps: ShopCartDeps, limit?: number) {
  const db = shopDb(c);
  const cart = await runCartMaintenance(db, deps.catalog, {
    limit: limit ?? CRON_BATCH,
    /*
     * UNTIL THE OUTBOX IS EMPTY, not one batch. Measured with the batch at 50
     * against a day of 120 captures: one invocation applied 50 and left 70 —
     * three days to clear one busy day, while more arrived. A scheduled job that
     * drains a fixed slice does not catch up; it falls behind at the rate the
     * shop succeeds. Bounded by wall clock instead, because `maxDuration` is what
     * actually constrains this and Vercel does not retry a timed-out cron.
     */
    untilEmpty: true,
  });

  /*
   * AND THEN THE OTHER CONSUMERS' HALF OF THE SAME OUTBOX (admin#29).
   *
   * WHY IT IS HERE RATHER THAN IN A THIRD CRON: `vercel.json` is at the Hobby
   * ceiling of two, both taken. Folding the commerce drain into a cron that
   * already exists keeps the count at two, so `vercel.json` is not touched and
   * `cron.test.ts` — which walks every entry and asserts the app registers it —
   * keeps passing unchanged.
   *
   * AFTER THE CART HALF, NOT BEFORE. `runCartMaintenance` drains Cart's
   * consumer and then releases expired holds; running Orders first would let its
   * `payment.captured` mark an order paid while the stock behind it was still
   * `held` and a millisecond from expiry. Cart commits the stock, then Orders
   * tells the customer. The two consumers keep separate consumption ledgers, so
   * neither can hide a row from the other whichever way round they run — this is
   * about what a customer is told, not about correctness of the ledger.
   *
   * `catch` AND NOT `throw`: a failure in the newer half must not stop the cron
   * reporting the older half's `abandoned` and `failed` counts, which are the
   * only signal that stock is being held for sales that already happened. Vercel
   * does not retry a failed cron invocation, so a 500 here costs a whole day.
   */
  const events = deps.sweepEvents
    ? await deps
        .sweepEvents(db, c.get('origins')?.[0] ?? null)
        .catch(() => ({ applied: 0, ignored: 0, parked: 0, passes: 0, failed: true }))
    : null;

  return { ...cart, events };
}

/**
 * One pricing refusal, rendered — shared by the freeze and the preview.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE MAPPING, TWO ROUTES, for the reason `priceCart` is one function: the
 * preview exists to tell a shopper what the freeze will do, and a preview that
 * reported a refusal differently from the freeze would send them round a loop
 * the storefront had no branch for. Both are `409` — none of these is fixable
 * by asking again (spec §8's retry policy stops there) and every body carries
 * what the shopper needs to fix it themselves.
 * ═══════════════════════════════════════════════════════════════════════════
 */
function refusePricing(c: Context<ShopEnv>, result: PricingRefusal) {
  if (result.reason === 'unresolved_lines') {
    return c.json({ error: 'unavailable_lines', variantIds: result.variantIds }, 409);
  }
  if (result.reason === 'currency_mismatch') {
    return c.json(
      { error: 'currency_mismatch', expected: result.expected, found: result.found },
      409,
    );
  }
  // Its own error code rather than the catch-all: the storefront has to
  // tell the customer "we do not deliver to <district>" and offer the
  // address step back — a generic precondition message reads as a glitch
  // to retry, and retrying cannot fix a place we refuse to go.
  if (result.reason === 'outside_delivery_area') {
    return c.json({ error: 'outside_delivery_area' }, 409);
  }
  // Its own code for the same reason, and a DIFFERENT one: the message
  // above names a district the customer picked from a list, and under
  // simple mode there is no list to send them back to. "We don't deliver
  // to Kano yet" and "we don't deliver to Gwarinpa" need different
  // sentences and different next steps.
  if (result.reason === 'outside_service_region') {
    return c.json({ error: 'outside_service_region' }, 409);
  }
  // And its own again for the country (migration 1060). The two above are both
  // fixed by editing the address; this one is not — a shopper in Canada cannot
  // retype their way into a country the shop does not ship to, so the message
  // has to stop offering the address step as the remedy.
  if (result.reason === 'outside_service_country') {
    return c.json({ error: 'outside_service_country' }, 409);
  }
  /* THE SAME BODY THE APPLY ROUTE ANSWERS, so a storefront reads "your code
   * stopped working" identically whether it learns it while typing the code or
   * at the freeze. The alternative is two shapes for one situation and a branch
   * that only ever runs on the rarer of them. */
  if (result.reason === 'discount_rejected') {
    return c.json({ error: 'discount_rejected', reason: result.discountReason }, 409);
  }
  /* `operation` keeps carrying the reason here for the consumers that
     already read it that way; `reason` says the same thing in the field
     that only ever means why. Same value, two keys, nothing broken. */
  return c.json(
    { error: 'precondition_failed', operation: result.reason, reason: result.reason },
    409,
  );
}

async function requireCart(c: Context<ShopEnv>, db: Db) {
  const id = cartCookie(c);
  if (!id) throw new NotFoundError('cart');
  const cart = await getCart(db, id);
  if (!cart) throw new NotFoundError(id);
  return cart;
}

// -------------------------------------------------------------------- bodies

/** The path within the shop app. `CRON_PATH` is the same thing as `vercel.json`
 * spells it, and `cron.test.ts` asserts the two agree against the router's own
 * table — Vercel runs a cron pointed at a nonexistent path forever, in silence. */
const CRON_ROUTE = '/admin/cart/maintenance';
export const CRON_PATH = `/api/shop${CRON_ROUTE}`;

/**
 * How much one invocation takes on.
 *
 * Smaller than the sweeper's own default of 200 because `vercel.json` caps these
 * functions at `maxDuration: 30`, and every release or commit is a network round
 * trip to Neon — two hundred of them is not obviously inside thirty seconds.
 * Vercel does not retry a cron that times out, so an over-large batch is a batch
 * that never completes rather than one that runs slowly. A backlog is drained
 * over successive invocations, which is what the ordering makes safe.
 */
export const CRON_BATCH = 50;

const Base = z.number().int().positive().optional();

/**
 * Every field goes through `str()`, which refuses U+0000.
 *
 * Postgres `text` cannot hold a NUL — the driver raises 22021 — and spec §8 has
 * no row for it, so untranslated it is a 500 the client retries five times for
 * input that can never be accepted. `server/nul-bytes.test.ts` walks every
 * registered route and fails if a NUL in a string body field produces a 5xx, so
 * these routes either inherit this or fail that test.
 */
/**
 * THE OPTIONAL PIN (migration 0780). Decimal degrees on the wire; the repo
 * stores integer micro-degrees.
 *
 * `capturedAt` IS NOT ACCEPTED HERE — the server stamps it. A client-supplied
 * timestamp is untrusted input that an operator would read as fact ("this pin
 * was taken at 14:02"), and clock skew on a phone would make some of them
 * wrong with nothing on screen saying so. Stamped here it means "when this pin
 * was attached to this address", which is both true and the question an
 * operator is actually asking. What the browser knows and the server does not
 * — the coordinate, how accurate the fix was, and whether a person dropped it
 * by hand — is exactly what it sends.
 *
 * THE BOUNDS ARE REAL AND THE COLUMN REPEATS THEM. A swapped lat/lng is the
 * classic mistake and it is silent: `7.49508, 9.05785` is a legal pair of
 * numbers and a spot in the Gulf of Guinea. Latitude bounded at 90 catches a
 * longitude in the latitude slot for every point outside the tropics.
 */
const Location = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    /** Metres. `null` or absent for a hand-dropped pin, which has none. */
    accuracyM: z.number().finite().min(0).max(10_000_000).nullable().optional(),
    source: z.enum(['device', 'pin']),
  })
  .strict()
  .transform((l) => ({
    lat: l.lat,
    lng: l.lng,
    /* Rounded: `coords.accuracy` is a float and the column is `integer`. */
    accuracyM: l.accuracyM == null ? null : Math.round(l.accuracyM),
    source: l.source,
    capturedAt: Date.now(),
  }));

/**
 * THE LENGTHS COME FROM `ADDRESS_MAX_LENGTHS`, WHICH THE PUBLIC CONFIG ROUTE
 * ALSO PUBLISHES — one source of truth rather than two that a test compares.
 *
 * The storefront renders `maxLength` on each input from
 * `GET /api/public/shop/delivery-config`, so a limit that drifted from this
 * schema would let a shopper type an address the form accepted and this route
 * then 400'd, naming a field and nothing else. Sharing the constant makes that
 * unrepresentable instead of merely tested.
 */
const Address = z
  .object({
    name: str().min(1).max(ADDRESS_MAX_LENGTHS.name),
    line1: str().min(1).max(ADDRESS_MAX_LENGTHS.line1),
    line2: str().max(ADDRESS_MAX_LENGTHS.line2).nullable().optional(),
    city: str().min(1).max(ADDRESS_MAX_LENGTHS.city),
    region: str().max(ADDRESS_MAX_LENGTHS.region).nullable().optional(),
    postalCode: str().max(ADDRESS_MAX_LENGTHS.postalCode).nullable().optional(),
    // Two uppercase letters, refused here AND by a CHECK in migration 0120: the
    // shipping zone and therefore the tax rate are derived from this, so a
    // lowercase code would silently pick the fallback zone and charge the wrong
    // tax.
    countryCode: str().regex(/^[A-Z]{2}$/),
    phone: str().max(ADDRESS_MAX_LENGTHS.phone).nullable().optional(),
    // A `marketing_service_areas.key`, CHOSEN from the storefront's picker —
    // never parsed from `line1`. No shape check beyond length: an unknown key
    // already means "no opinion — zone rate" by construction (migration 0460),
    // and a switched-off one is refused by the repo, not the schema.
    district: str().max(ADDRESS_MAX_LENGTHS.district).nullable().optional(),
    /*
     * OPTIONAL, AND THE STOREFRONT SENDS IT ONLY WHEN THE PUBLIC CONFIG SAYS
     * `location.offer` IS TRUE. This object is `.strict()`, so a server old
     * enough to reject this key is also old enough to never advertise the
     * button — the config IS the feature flag for the wire shape, and there is
     * no window in which a storefront can send a field its server refuses.
     */
    location: Location.nullable().optional(),
  })
  .strict()
  .transform((a) => ({
    name: a.name,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city,
    region: a.region ?? null,
    postalCode: a.postalCode ?? null,
    countryCode: a.countryCode,
    phone: a.phone ?? null,
    district: a.district ?? null,
    location: a.location ?? null,
  }));

const AddressesBody = z
  .object({ shipping: Address, billing: Address.nullable().optional(), baseRevision: Base })
  .strict();

const ShippingBody = z
  .object({ optionId: str().min(1).max(64), baseRevision: Base })
  .strict();

const BaseOnlyBody = z.object({ baseRevision: Base }).strict();

/**
 * The freeze's body. `baseRevision` as everywhere, plus the SpoolPoints opt-in.
 *
 * `redeemPoints` IS OPT-IN, AND ABSENT MEANS SPEND NOTHING (admin#2). The port
 * treats an omitted `pointsRequested` as "as much as the rules allow", which is
 * the right default for a widget the customer has already agreed with and the
 * WRONG one for a route: it would spend a signed-in shopper's whole balance on
 * their next order without anyone asking. So the shop does not pass the omission
 * through — it declines to quote at all, and the number arrives only when a
 * customer has chosen it.
 *
 * A number LARGER than the balance is clamped rather than refused, by `quote()`
 * itself. `0` is not "no thanks" but "spend zero", which converts to nothing and
 * answers null anyway; both end at the same place, and neither is an error.
 */
const FreezeBody = z
  .object({ baseRevision: Base, redeemPoints: z.number().int().min(0).max(100_000_000).optional() })
  .strict();

/**
 * The preview's body — the freeze's, minus the revision it has no race to lose.
 *
 * `redeemPoints` CARRIES THE SAME MEANING IT CARRIES AT THE FREEZE, deliberately
 * and to the letter: absent means spend nothing, a number larger than the
 * balance is clamped by `quote()` rather than refused, and `0` converts to
 * nothing and answers null. A preview that read the field differently from the
 * freeze would show a shopper a discount the freeze then declined to give.
 */
const PreviewBody = z
  .object({ redeemPoints: z.number().int().min(0).max(100_000_000).optional() })
  .strict();

/**
 * The apply route's body.
 *
 * TRIMMED AND BOUNDED HERE, UPPERCASED IN THE PORT. The route refuses a blank
 * or absurd string so the database is never asked about one; the normalisation
 * that has to agree with the model's own spelling lives next to the model, so
 * every caller inherits it — including the freeze's re-validation, which reads
 * a code off a cart rather than off a request.
 *
 * 64 IS THE COLUMN'S OWN LIMIT (migration 0820's CHECK, and the model's).
 */
const DiscountBody = z
  .object({ code: str().trim().min(1).max(64), baseRevision: Base })
  .strict();

/** The add-on choice route's body: the answer, and the CAS token every edit takes. */
const AddOnChoiceBody = z.object({ choice: z.enum(['accepted', 'declined']), baseRevision: Base }).strict();

const SweepBody = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();
