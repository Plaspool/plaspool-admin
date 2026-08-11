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
import { extendReservations, sweepExpiredReservations } from '../reservations/repo';
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
  const config: CheckoutConfig = { zones: deps.zones, storeCurrency: deps.storeCurrency };

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
        return c.json({ error: 'precondition_failed', operation: 'checkout_start' }, 409);
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
    return c.json({ options: await shippingOptionsForCart(db, config, cart.id) });
  });

  routes.put('/checkout/shipping', async (c) => {
    const db = shopDb(c);
    const body = await readJson(c, ShippingBody);
    const cart = await requireCart(c, db);
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
    const body = await readJsonOrEmpty(c, BaseOnlyBody);
    const cart = await requireCart(c, db);

    const result = await freezeCheckout(db, deps.catalog, config, {
      cartId: cart.id,
      baseRevision: body.baseRevision,
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
      return c.json({ error: 'precondition_failed', operation: result.reason }, 409);
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
   * The cron route for the expiry sweep (brief §4).
   *
   * BEHIND `requireAuth()` and under `/admin/*` (contract §10). It is not a
   * public endpoint: sweeping is cheap per call but it reaches `CatalogPort` once
   * per expired hold, so an anonymous caller could turn it into an amplifier.
   *
   * A ROUTE AND NOT A TIMER, deliberately. Brief §4: "Do not build a background
   * timer. Sweep lazily on read plus on a cron route, the same shape the image
   * orphan sweep uses." A tight retry loop froze a tab in GAUNTLET I Round 1 #2;
   * a tight sweep loop on a serverless platform does the same to a bill.
   */
  routes.post('/admin/reservations/sweep', requireAuth(), async (c) => {
    const body = await readJsonOrEmpty(c, SweepBody);
    const outcome = await sweepExpiredReservations(shopDb(c), deps.catalog, {
      limit: body.limit,
    });
    // `failed` is reported rather than swallowed: a non-zero value means stock
    // is held for checkouts that are over, and this is the only signal saying so.
    return c.json(outcome);
  });

  return routes;
}

async function requireCart(c: Context<ShopEnv>, db: Db) {
  const id = cartCookie(c);
  if (!id) throw new NotFoundError('cart');
  const cart = await getCart(db, id);
  if (!cart) throw new NotFoundError(id);
  return cart;
}

// -------------------------------------------------------------------- bodies

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
  }));

const AddressesBody = z
  .object({ shipping: Address, billing: Address.nullable().optional(), baseRevision: Base })
  .strict();

const ShippingBody = z
  .object({ optionId: str().min(1).max(64), baseRevision: Base })
  .strict();

const BaseOnlyBody = z.object({ baseRevision: Base }).strict();

const SweepBody = z
  .object({ limit: z.number().int().min(1).max(1000).optional() })
  .strict();
