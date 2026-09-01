import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, readJsonOrEmpty, str } from '../../../middleware/errors';
import { requireAuth } from '../../../middleware/session';
import { NotFoundError } from '../../../repo/errors';
import { getCart } from '../cart/repo';
import {
  freezeCheckout,
  frozenTotals,
  putAddresses,
  setShipping,
  shippingOptionsForCart,
  startCheckout,
} from '../checkout/repo';
import { loadShippingZonesForCheckout } from '../checkout/shipping-zones-repo';
import { extendReservations } from '../reservations/repo';
import { runCartMaintenance } from '../events/consumer';
import { assertCronRequest } from '../cron-auth';
import { cartCookie } from '../identity/cookies';
import { CHECKOUT_START_LIMIT, CHECKOUT_START_WINDOW_MS } from '../limits';
import type { CheckoutConfig } from '../checkout/repo';
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
    const dbZones = await loadShippingZonesForCheckout(db);
    return {
      zones: dbZones.length > 0 ? dbZones : deps.zones,
      storeCurrency: deps.storeCurrency,
      /* SpoolPoints, when this deployment wired them (admin#2). Passed straight
       * through: the route decides nothing about redemption, `freezeCheckout`
       * does. */
      redemption: deps.redemption,
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
    if (!result.ok) {
      if (result.reason === 'unresolved_lines') {
        return c.json(
          { error: 'unavailable_lines', variantIds: result.variantIds },
          409,
        );
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
      /* `operation` keeps carrying the reason here for the consumers that
         already read it that way; `reason` says the same thing in the field
         that only ever means why. Same value, two keys, nothing broken. */
      return c.json(
        { error: 'precondition_failed', operation: result.reason, reason: result.reason },
        409,
      );
    }

    await extendReservations(db, cart.id);
    return c.json({ totals: result.totals });
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
const Address = z
  .object({
    name: str().min(1).max(200),
    line1: str().min(1).max(200),
    line2: str().max(200).nullable().optional(),
    city: str().min(1).max(120),
    region: str().max(120).nullable().optional(),
    postalCode: str().max(40).nullable().optional(),
    // Two uppercase letters, refused here AND by a CHECK in migration 0120: the
    // shipping zone and therefore the tax rate are derived from this, so a
    // lowercase code would silently pick the fallback zone and charge the wrong
    // tax.
    countryCode: str().regex(/^[A-Z]{2}$/),
    phone: str().max(40).nullable().optional(),
    // A `marketing_service_areas.key`, CHOSEN from the storefront's picker —
    // never parsed from `line1`. No shape check beyond length: an unknown key
    // already means "no opinion — zone rate" by construction (migration 0460),
    // and a switched-off one is refused by the repo, not the schema.
    district: str().max(120).nullable().optional(),
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

const SweepBody = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();
