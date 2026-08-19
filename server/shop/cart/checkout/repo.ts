import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { BadRequestError, NotFoundError } from '../../../repo/errors';
import { CartPreconditionError, CartStaleWriteError } from '../errors';
import { newId } from '../ids';
import { getCart, listLines, updateCartFields } from '../cart/repo';
import { heldReservations, reserveForCheckout } from '../reservations/repo';
import { computeTotals, parseFrozenTotals } from '../totals/compute';
import {
  shippingOptionById,
  shippingOptionsFor,
  taxRateFor,
  unknownZoneTaxRate,
  zoneFor,
} from './shipping';
import type { ShippingZone } from './shipping';
import type { CatalogPort } from '../catalog-port';
import type { Reservation, Shortfall } from '../reservations/repo';
import type { TotalsInputLine } from '../totals/compute';
import type {
  AddressSnapshot,
  CheckoutCompletedLine,
  CheckoutCompletedPayload,
} from '../../../../shared/commerce/events';
import type { FrozenTotals, ShippingQuote } from '../../../../shared/commerce/ports';

/**
 * Checkout — a state machine over the cart (brief §5).
 *
 * `open → converting → converted`, plus `abandoned`. There is no separate
 * checkout aggregate and no `shop_checkouts` table: `checkoutId` IS the cart id,
 * so `CheckoutPort.totals(db, checkoutId)` and every route below take the same
 * value. A second identity would need a mapping whose only job is to be got
 * wrong.
 *
 * ═══ WHAT FREEZING MEANS, AND WHY IT IS A ONE-WAY DOOR ═══
 *
 * `freezeCheckout` runs the pure totals engine ONCE, writes the result to
 * `shop_carts.frozen_totals`, and moves the cart to `converting` in the same
 * statement. From that instant the number is the price: `frozenTotals()` reads
 * the column and never re-runs the engine, so a price change, a tax-table edit
 * or a shipping re-quote between freeze and capture cannot move what the
 * customer is charged. `repo.test.ts` doubles the price under a frozen checkout
 * and asserts the total does not move.
 *
 * Everything the cart can still be edited through is guarded on
 * `status = 'open'`, so a frozen checkout's addresses and lines are immutable by
 * construction rather than by convention.
 */

export interface CheckoutConfig {
  zones: readonly ShippingZone[];
  storeCurrency: string;
}

// ------------------------------------------------------------------ addresses

export type AddressKind = 'shipping' | 'billing';

const COUNTRY = /^[A-Z]{2}$/;

function assertAddress(a: AddressSnapshot): void {
  if (!COUNTRY.test(a.countryCode)) throw new BadRequestError('countryCode');
  if (!a.name.trim()) throw new BadRequestError('name');
  if (!a.line1.trim()) throw new BadRequestError('line1');
  if (!a.city.trim()) throw new BadRequestError('city');
}

function rowToAddress(row: Record<string, unknown>): AddressSnapshot {
  return {
    name: String(row.name),
    line1: String(row.line1),
    line2: row.line2 == null ? null : String(row.line2),
    city: String(row.city),
    region: row.region == null ? null : String(row.region),
    postalCode: row.postal_code == null ? null : String(row.postal_code),
    countryCode: String(row.country_code),
    phone: row.phone == null ? null : String(row.phone),
  };
}

export async function getAddress(
  db: Db,
  cartId: string,
  kind: AddressKind,
): Promise<AddressSnapshot | null> {
  const res = await db.execute(sql`
    SELECT name, line1, line2, city, region, postal_code, country_code, phone
      FROM shop_addresses WHERE cart_id = ${cartId} AND kind = ${kind}`);
  return res.rows[0] ? rowToAddress(res.rows[0]) : null;
}

/**
 * Put the shipping and (optionally) billing addresses, and record the zone.
 *
 * THE ZONE IS STORED, not re-derived at freeze time. Deriving it twice is two
 * chances to derive it differently, and the second derivation would happen after
 * the customer has seen a delivery price — which is exactly when a number moving
 * loses a sale. `updateCartFields` carries the `status = 'open'` guard and the
 * CAS, so an address cannot be changed once a total has been frozen from it.
 *
 * `ON CONFLICT (cart_id, kind)` rather than delete-then-insert: one statement,
 * and a partly-applied address change is not a state this can reach.
 */
export async function putAddresses(
  db: Db,
  config: CheckoutConfig,
  a: {
    cartId: string;
    shipping: AddressSnapshot;
    billing: AddressSnapshot | null;
    baseRevision?: number;
  },
): Promise<{ zone: string }> {
  assertAddress(a.shipping);
  if (a.billing) assertAddress(a.billing);

  const zone = zoneFor(config.zones, a.shipping.countryCode, a.shipping.region);
  // The cart write goes FIRST because it carries the CAS and the state guard: if
  // the cart is not open, or has moved on, no address is written at all.
  await updateCartFields(db, {
    cartId: a.cartId,
    baseRevision: a.baseRevision,
    fields: { taxZone: zone.id },
  });

  for (const [kind, address] of [
    ['shipping', a.shipping],
    ['billing', a.billing],
  ] as const) {
    if (!address) continue;
    await db.execute(sql`
      INSERT INTO shop_addresses (id, cart_id, kind, name, line1, line2, city, region,
                                  postal_code, country_code, phone)
      VALUES (${newId('address')}, ${a.cartId}, ${kind}, ${address.name}, ${address.line1},
              ${address.line2}, ${address.city}, ${address.region}, ${address.postalCode},
              ${address.countryCode}, ${address.phone})
      ON CONFLICT (cart_id, kind) DO UPDATE
        SET name = EXCLUDED.name, line1 = EXCLUDED.line1, line2 = EXCLUDED.line2,
            city = EXCLUDED.city, region = EXCLUDED.region,
            postal_code = EXCLUDED.postal_code, country_code = EXCLUDED.country_code,
            phone = EXCLUDED.phone`);
  }

  return { zone: zone.id };
}

// ------------------------------------------------------------------- shipping

export async function shippingOptionsForCart(
  db: Db,
  config: CheckoutConfig,
  cartId: string,
): Promise<ShippingQuote[]> {
  const address = await getAddress(db, cartId, 'shipping');
  // NO OPTIONS WITHOUT AN ADDRESS. A shop that shows domestic delivery prices
  // before it knows the destination shows a number that goes up at the last
  // step, which is when a customer abandons.
  if (!address) return [];
  return shippingOptionsFor(
    zoneFor(config.zones, address.countryCode, address.region),
    config.storeCurrency,
  );
}

export async function setShipping(
  db: Db,
  config: CheckoutConfig,
  a: { cartId: string; optionId: string; baseRevision?: number },
): Promise<ShippingQuote> {
  const address = await getAddress(db, a.cartId, 'shipping');
  if (!address) throw new BadRequestError('shipping_address');
  const zone = zoneFor(config.zones, address.countryCode, address.region);
  const option = shippingOptionById(zone, config.storeCurrency, a.optionId);
  // An option from ANOTHER zone is refused rather than honoured: accepting the
  // UK next-day price for a parcel to France is a real loss on every order.
  if (!option) throw new BadRequestError('shipping_option');

  await updateCartFields(db, {
    cartId: a.cartId,
    baseRevision: a.baseRevision,
    fields: { shippingOptionId: option.id },
  });
  return option;
}

// ---------------------------------------------------------------------- start

export type StartOutcome =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; reason: 'empty_cart' }
  | { ok: false; reason: 'insufficient'; shortfalls: Shortfall[] };

/**
 * Take holds for the cart's lines. Leaves the cart OPEN (brief §6).
 *
 * The cart stays open because addresses and shipping are still to come and every
 * cart-field write is guarded on `status = 'open'` — moving to `converting` here
 * would make the customer's next legitimate step a precondition failure.
 */
export async function startCheckout(
  db: Db,
  catalog: CatalogPort,
  a: { cartId: string },
): Promise<StartOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  const lines = await listLines(db, a.cartId);
  // Reserving nothing and calling it success is how a customer reaches payment
  // with an empty basket.
  if (lines.length === 0) return { ok: false, reason: 'empty_cart' };

  const result = await reserveForCheckout(db, catalog, {
    cartId: a.cartId,
    lines: lines.map((line) => ({ variantId: line.variantId, qty: line.qty })),
  });
  if (!result.ok) return { ok: false, reason: 'insufficient', shortfalls: result.shortfalls };
  return { ok: true, reservations: result.reservations };
}

// --------------------------------------------------------------------- freeze

export type FreezeOutcome =
  | { ok: true; totals: FrozenTotals }
  | { ok: false; reason: 'empty_cart' }
  | { ok: false; reason: 'no_shipping_address' }
  | { ok: false; reason: 'unresolved_lines'; variantIds: string[] }
  | {
      ok: false;
      reason: 'currency_mismatch';
      expected: string;
      found: Array<{ where: string; currency: string }>;
    };

/**
 * Price the cart once, store the answer, and close the door.
 *
 * Every input to `computeTotals` is gathered HERE and passed in: this function
 * has the database and the clock, and the engine has neither. That separation is
 * the whole design — see `totals/compute.ts`.
 */
export async function freezeCheckout(
  db: Db,
  catalog: CatalogPort,
  config: CheckoutConfig,
  a: { cartId: string; baseRevision?: number },
): Promise<FreezeOutcome> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);
  if (cart.status !== 'open') {
    throw new CartPreconditionError('freeze', {
      id: cart.id,
      status: cart.status,
      revision: cart.revision,
      currency: cart.currency,
    });
  }

  const lines = await listLines(db, a.cartId);
  if (lines.length === 0) return { ok: false, reason: 'empty_cart' };

  const address = await getAddress(db, a.cartId, 'shipping');
  if (!address) return { ok: false, reason: 'no_shipping_address' };

  const zone = zoneFor(config.zones, address.countryCode, address.region);
  const shipping = cart.shippingOptionId
    ? shippingOptionById(zone, config.storeCurrency, cart.shippingOptionId)
    : null;

  /*
   * ONE `quote` PER LINE, and the result is carried forward rather than
   * re-fetched. An unresolvable variant becomes `unit: null`, which the totals
   * engine REFUSES rather than dropping — a cart showing three items and a total
   * covering two is a charge the customer never agreed to.
   */
  const quotes = await Promise.all(
    lines.map((line) => catalog.quote(db, line.variantId).then((q) => ({ line, quote: q }))),
  );

  const totalsLines: TotalsInputLine[] = quotes.map(({ line, quote }) => ({
    variantId: line.variantId,
    qty: line.qty,
    unit: quote ? { amount: quote.price.amount, currency: quote.price.currency } : null,
  }));

  /*
   * THE GOODS, CAPTURED FROM THE SAME `quote` CALLS THAT PRODUCED THE PRICES.
   *
   * `FrozenTotals.lines` is money-only by design — the totals engine is pure and
   * must not need a product title to do arithmetic — but an order line needs a
   * SKU, a title and an option tuple, and Catalog may rename or discontinue the
   * variant tomorrow. Re-quoting at completion time would reintroduce exactly
   * the drift freezing exists to prevent, so both halves are frozen at the same
   * instant, from the same reads, into the same statement.
   */
  const frozenLines: CheckoutCompletedLine[] = quotes.map(({ line, quote }) => ({
    variantId: line.variantId,
    productId: quote?.productId ?? '',
    sku: quote?.sku ?? '',
    title: quote?.title ?? '',
    optionValues: quote?.optionValues ?? {},
    qty: line.qty,
    unit: quote
      ? { amount: quote.price.amount, currency: quote.price.currency }
      : { amount: 0, currency: cart.currency },
    weightGrams: quote?.weightGrams ?? null,
  }));

  const computed = computeTotals({
    currency: cart.currency,
    lines: totalsLines,
    shipping,
    // A cart with no address yet would have had no shipping either; the named
    // zero-rate exists so a preview never shows a domestic VAT figure it will
    // then change.
    tax: cart.taxZone ? taxRateFor(zone) : unknownZoneTaxRate(),
    adjustments: [],
  });

  if (!computed.ok) {
    if (computed.reason === 'unresolved_lines') {
      return { ok: false, reason: 'unresolved_lines', variantIds: computed.variantIds };
    }
    if (computed.reason === 'currency_mismatch') {
      return {
        ok: false,
        reason: 'currency_mismatch',
        expected: computed.expected,
        found: computed.found,
      };
    }
    // `bad_currency` means the CART's own currency column is not ISO-4217, which
    // no ordinary path can produce — the CHECK in migration 0120 refuses it. A
    // corrupt row, then, and a 500 is the honest answer.
    throw new Error(`cart ${a.cartId} has an unusable currency`);
  }

  const now = Date.now();
  const base = a.baseRevision ?? cart.revision;
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET status = 'converting',
           frozen_totals = ${JSON.stringify(computed.totals)}::jsonb,
           frozen_lines = ${JSON.stringify(frozenLines)}::jsonb,
           frozen_at = ${now},
           revision = revision + 1,
           updated_at = ${now}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = 'open'
    RETURNING revision`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    const snap = {
      id: after.id,
      status: after.status,
      revision: after.revision,
      currency: after.currency,
    };
    if (after.status !== 'open') throw new CartPreconditionError('freeze', snap);
    throw new CartStaleWriteError(base, after.revision, snap);
  }

  return { ok: true, totals: computed.totals };
}

/**
 * `CheckoutPort.totals` — READ, never recomputed (contract §5, brief §5).
 *
 * Every amount goes back through `money()` on the way out (`parseFrozenTotals`),
 * so a row corrupted by a hand-run UPDATE or a bad import is refused at the
 * boundary rather than flowing into a charge. Both "not frozen" and "corrupt"
 * answer `NotFoundError` → 404 `gone`, which spec §8's retry policy stops on:
 * neither is something a retry could fix.
 */
export async function frozenTotals(db: Db, checkoutId: string): Promise<FrozenTotals> {
  const res = await db.execute(sql`
    SELECT frozen_totals FROM shop_carts WHERE id = ${checkoutId}`);
  const row = res.rows[0];
  if (!row || row.frozen_totals == null) throw new NotFoundError(checkoutId);
  const parsed = parseFrozenTotals(row.frozen_totals);
  if (!parsed) throw new NotFoundError(checkoutId);
  return parsed;
}

// ------------------------------------------------------------------ complete

/**
 * The checkout is done: `converting → converted`, and `checkout.completed`
 * appended IN THE SAME STATEMENT.
 *
 * CONTRACT §6 RULE 1 IS THE WHOLE DESIGN OF THIS FUNCTION: "Write the event in
 * the same transaction as the state change that caused it. An event that can be
 * lost while its cause commits is worse than no event, because the system then
 * believes something happened that nobody will act on."
 *
 * One statement rather than `db.transaction` — the Neon HTTP driver throws
 * unconditionally on `transaction()` while PGlite supports it, so a transaction
 * would pass every test here and 500 in production (spec §4.3a). The event
 * INSERT selects FROM the cart UPDATE, so a transition that matches nothing
 * writes no event. `repo.test.ts` proves that by making the transition
 * impossible and asserting the outbox stays empty.
 *
 * WHO CALLS THIS is the seam contract §7 leaves open — brief §7 says the event
 * is emitted "when the cart freezes and payment is authorised", and Cart has no
 * way to learn the second half. See AMENDMENTS A-007.
 */
export async function completeCheckout(
  db: Db,
  a: { cartId: string; baseRevision?: number },
): Promise<CheckoutCompletedPayload> {
  const cart = await getCart(db, a.cartId);
  if (!cart) throw new NotFoundError(a.cartId);

  const totals = await frozenTotals(db, a.cartId);
  const payload = await buildCompletedPayload(db, a.cartId, totals);
  const now = Date.now();
  const base = a.baseRevision ?? cart.revision;

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE shop_carts
         SET status = 'converted', revision = revision + 1, updated_at = ${now}
       WHERE id = ${a.cartId} AND revision = ${base} AND status = 'converting'
      RETURNING id
    ), evt AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${newId('event')}, 'checkout.completed', upd.id,
             ${JSON.stringify({ ...payload, occurredAt: now })}::jsonb, ${now}, 0
        FROM upd
      RETURNING id
    )
    SELECT upd.id FROM upd`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    const snap = {
      id: after.id,
      status: after.status,
      revision: after.revision,
      currency: after.currency,
    };
    if (after.status !== 'converting') throw new CartPreconditionError('complete', snap);
    throw new CartStaleWriteError(base, after.revision, snap);
  }

  return { ...payload, occurredAt: now };
}

/**
 * Everything Orders needs, gathered before the write.
 *
 * BUILT FROM THE FROZEN TOTALS PLUS THE CART'S OWN ROWS — never from a fresh
 * `CatalogPort.quote`. The prices in the payload must be the prices that were
 * frozen, and re-quoting here would reintroduce exactly the drift freezing
 * exists to prevent. The product snapshot (`sku`, `title`, `optionValues`,
 * `weightGrams`) is the one thing a cart row does not hold, so it is read from
 * the line's stored variant id at completion time and copied — an order is a
 * record of what was sold, and Catalog may rename the variant tomorrow.
 */
async function buildCompletedPayload(
  db: Db,
  cartId: string,
  totals: FrozenTotals,
): Promise<CheckoutCompletedPayload> {
  const cart = await getCart(db, cartId);
  if (!cart) throw new NotFoundError(cartId);

  const stored = await db.execute(sql`
    SELECT frozen_lines FROM shop_carts WHERE id = ${cartId}`);
  const lines = (stored.rows[0]?.frozen_lines ?? []) as CheckoutCompletedLine[];

  const held = await heldReservations(db, cartId);

  return {
    checkoutId: cartId,
    customerId: cart.customerId,
    email: cart.email,
    currency: cart.currency,
    totals,
    lines,
    shippingAddress: await getAddress(db, cartId, 'shipping'),
    billingAddress: await getAddress(db, cartId, 'billing'),
    reservationIds: held.map((reservation) => reservation.id),
    occurredAt: 0,
  };
}
