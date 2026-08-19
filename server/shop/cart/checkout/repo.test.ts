/**
 * Checkout: addresses, shipping, the freeze, and `checkout.completed`.
 *
 * THE PROPERTY THIS FILE IS MOSTLY ABOUT: frozen totals are READ, never
 * recomputed (brief §5). A `totals()` that re-ran the engine at capture time is
 * a system that can charge a number the customer never saw — a price change or
 * a tax-table edit between freeze and capture is all it takes. That is asserted
 * by moving the price under a frozen checkout and watching the number not move.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import { GUARDS, mutating } from '../test/mutating';
import { addLine, createCart, getCart } from '../cart/repo';
import type { ShippingZone } from './shipping';
import {
  completeCheckout,
  freezeCheckout,
  frozenTotals,
  putAddresses,
  setCheckoutContact,
  setShipping,
  shippingOptionsForCart,
  startCheckout,
} from './repo';
import { CartPreconditionError, CartStaleWriteError } from '../errors';
import { NotFoundError } from '../../../repo/errors';
import { checkoutPort } from '../port';
import { parseCheckoutCompleted } from '../../orders/inbound';
import type { CartFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

/*
 * A LOCAL FIXTURE, DELIBERATELY NOT `DEFAULT_SHIPPING_ZONES` (admin#19).
 *
 * This file exercises checkout MECHANICS — multiple zones, per-zone VAT,
 * taxable-vs-not shipping, a fallback for an unmatched country — and those
 * properties need a fixture shaped to show them off, not the shop's real
 * three same-country Nigerian zones. `DEFAULT_SHIPPING_ZONES` is now the
 * empty-database fallback for a real NGN deployment (see `shipping.ts`);
 * coupling this file to its contents would make an unrelated pricing change
 * break tests that are not about pricing.
 */
const CURRENCY = 'GBP';
const TEST_ZONES: readonly ShippingZone[] = [
  {
    id: 'domestic',
    label: 'United Kingdom',
    countries: ['GB'],
    taxRateBps: 2000,
    taxLabel: 'VAT',
    shippingTaxable: true,
    options: [
      { id: 'standard', label: 'Standard (3–5 days)', amountMinor: 399 },
      { id: 'express', label: 'Express (next day)', amountMinor: 799 },
    ],
  },
  {
    id: 'eu',
    label: 'Europe',
    countries: ['IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'SE', 'DK', 'PL'],
    taxRateBps: 0,
    taxLabel: 'No VAT charged (export)',
    shippingTaxable: false,
    options: [{ id: 'standard', label: 'Standard (5–10 days)', amountMinor: 999 }],
  },
  {
    id: 'international',
    label: 'Rest of world',
    countries: [],
    taxRateBps: 0,
    taxLabel: 'No VAT charged (export)',
    shippingTaxable: false,
    options: [{ id: 'standard', label: 'Standard (10–20 days)', amountMinor: 1999 }],
    fallback: true,
  },
];
const CONFIG = { zones: TEST_ZONES, storeCurrency: CURRENCY };

const UK = {
  name: 'A Shopper',
  line1: '1 High Street',
  line2: null,
  city: 'London',
  region: null,
  postalCode: 'E1 6AN',
  countryCode: 'GB',
  phone: null,
};

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  catalog = fakeCatalog([
    {
      variantId: 'var_tee',
      productId: 'prd_tee',
      sku: 'TEE-NAVY-M',
      title: 'Navy Tee',
      optionValues: { Size: 'M' },
      price: { amount: 1999, currency: CURRENCY },
      weightGrams: 180,
      onHand: 10,
    },
  ]);
});

/** A cart with one line, addresses set and a shipping method chosen. */
async function readyCart(qty = 2) {
  const cart = await createCart(db, { currency: CURRENCY });
  await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty });
  await putAddresses(db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
  await setShipping(db, CONFIG, { cartId: cart.id, optionId: 'standard' });
  return (await getCart(db, cart.id))!;
}

describe('startCheckout', () => {
  it('reserves every line and LEAVES THE CART OPEN', async () => {
    /*
     * Brief §6: "POST /checkout/start → reserves, freezes nothing yet." The cart
     * stays `open` because addresses and shipping are still to come, and every
     * cart-field write is guarded on `status = 'open'`. Moving to `converting`
     * here would make the next legitimate step a precondition failure.
     */
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 2 });

    const result = await startCheckout(db, catalog, { cartId: cart.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reservations).toHaveLength(1);
    expect((await getCart(db, cart.id))?.status).toBe('open');
    expect(catalog.stockOf('var_tee')).toEqual({ onHand: 10, reserved: 2 });
  });

  it('refuses an empty cart rather than reserving nothing and calling it success', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    const result = await startCheckout(db, catalog, { cartId: cart.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_cart');
  });

  it('reports a shortfall with the number, and holds nothing', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 99 });

    const result = await startCheckout(db, catalog, { cartId: cart.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'insufficient') throw new Error(`got ${result.reason}`);
    expect(result.shortfalls).toEqual([
      { variantId: 'var_tee', requested: 99, available: 10 },
    ]);
    expect(catalog.stockOf('var_tee')).toEqual({ onHand: 10, reserved: 0 });
  });
});

describe('addresses', () => {
  it('stores one address per kind, and replaces rather than duplicating', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
    await putAddresses(db, CONFIG, {
      cartId: cart.id,
      shipping: { ...UK, city: 'Leeds' },
      billing: null,
    });

    const rows = await db.execute(
      sql`SELECT kind, city FROM shop_addresses WHERE cart_id = ${cart.id}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].city)).toBe('Leeds');
  });

  it('records the shipping zone on the cart, so tax is not re-derived later', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
    expect((await getCart(db, cart.id))?.taxZone).toBe('domestic');

    await putAddresses(db, CONFIG, {
      cartId: cart.id,
      shipping: { ...UK, countryCode: 'AU' },
      billing: null,
    });
    // Australia is in no zone's country list, so it falls to the declared
    // fallback — never to the first zone in the array.
    expect((await getCart(db, cart.id))?.taxZone).toBe('international');
  });

  it('refuses a country code that is not two uppercase letters', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await expect(
      putAddresses(db, CONFIG, {
        cartId: cart.id,
        shipping: { ...UK, countryCode: 'gb' },
        billing: null,
      }),
    ).rejects.toThrow(/country/i);
  });

  it('cannot be changed once the cart is converting', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    await expect(
      putAddresses(db, CONFIG, { cartId: cart.id, shipping: { ...UK, city: 'Hull' }, billing: null }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
  });
});

describe('shipping options', () => {
  it('are the zone the shipping address falls in, priced in the store currency', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });

    const options = await shippingOptionsForCart(db, CONFIG, cart.id);
    expect(options.map((o) => o.id)).toEqual(['standard', 'express']);
    expect(options[0].amount).toEqual({ amount: 399, currency: CURRENCY });
  });

  it('are empty until an address exists — never a domestic guess', async () => {
    // A shop that shows domestic delivery prices before it knows where the
    // parcel is going shows a number that goes UP at the last step, which is
    // when a customer abandons.
    const cart = await createCart(db, { currency: CURRENCY });
    expect(await shippingOptionsForCart(db, CONFIG, cart.id)).toEqual([]);
  });

  it('refuses an option that is not in the cart’s zone', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await putAddresses(db, CONFIG, {
      cartId: cart.id,
      shipping: { ...UK, countryCode: 'FR' },
      billing: null,
    });
    // `express` exists in the domestic zone only. Accepting it here would ship a
    // parcel to France at the UK next-day price.
    await expect(
      setShipping(db, CONFIG, { cartId: cart.id, optionId: 'express' }),
    ).rejects.toThrow(/shipping/i);
  });
});

describe('freezeCheckout', () => {
  it('computes the totals, stores them, and moves the cart to converting', async () => {
    const cart = await readyCart(2);

    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 × £19.99 = £39.98, + £3.99 delivery, + 20% VAT on both.
    expect(result.totals.subtotal).toEqual({ amount: 3998, currency: CURRENCY });
    expect(result.totals.shippingTotal).toEqual({ amount: 399, currency: CURRENCY });
    expect(result.totals.taxTotal).toEqual({ amount: 800 + 80, currency: CURRENCY });
    expect(result.totals.grandTotal).toEqual({ amount: 3998 + 399 + 880, currency: CURRENCY });
    expect((await getCart(db, cart.id))?.status).toBe('converting');
  });

  it('stores the ITEMISED BREAKDOWN, not just the four sums', async () => {
    // The breakdown is the evidence for the number about to be charged (brief
    // §5). Without it, "why £47.77?" is unanswerable the moment a price moves.
    const cart = await readyCart(2);
    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    if (!result.ok) throw new Error('expected totals');

    expect(result.totals.lines).toEqual([
      {
        variantId: 'var_tee',
        qty: 2,
        unit: { amount: 1999, currency: CURRENCY },
        lineTotal: { amount: 3998, currency: CURRENCY },
        taxable: true,
        taxAmount: { amount: 800, currency: CURRENCY },
      },
    ]);
    expect(result.totals.tax).toEqual({ zone: 'domestic', label: 'VAT', rateBps: 2000 });
    expect(result.totals.rounding).toBe('half-up');
  });

  it('refuses an empty cart — arithmetic says zero, checkout says no', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: UK, billing: null });
    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_cart');
    expect((await getCart(db, cart.id))?.status).toBe('open');
  });

  it('refuses a cart with no shipping address', async () => {
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });
    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_shipping_address');
  });

  it('REFUSES a cart holding a line whose variant has vanished', async () => {
    /*
     * The cart shows three items; a total covering two would be a charge the
     * customer never agreed to. The unresolvable line is NAMED so the shopper
     * can remove it — brief §3: a line that vanishes with no explanation is the
     * worst version of this.
     */
    const cart = await readyCart(1);
    catalog.seed({
      variantId: 'var_tee',
      price: { amount: 1999, currency: CURRENCY },
      onHand: 10,
      sellable: false,
    });

    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.reason !== 'unresolved_lines') throw new Error(`got ${result.reason}`);
    expect(result.variantIds).toEqual(['var_tee']);
    expect((await getCart(db, cart.id))?.status).toBe('open');
  });

  it('REFUSES a currency mismatch rather than coercing it', async () => {
    const cart = await readyCart(1);
    catalog.seed({
      variantId: 'var_tee',
      price: { amount: 1999, currency: 'EUR' },
      onHand: 10,
    });

    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('currency_mismatch');
  });

  it('cannot be frozen twice', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    await expect(
      freezeCheckout(db, catalog, CONFIG, { cartId: cart.id }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
  });

  it('MUTATION: neutralising the cart CAS lets a stale freeze land', async () => {
    const cart = await readyCart();
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 }); // moves the revision

    await expect(
      freezeCheckout(db, catalog, CONFIG, { cartId: cart.id, baseRevision: cart.revision }),
    ).rejects.toBeInstanceOf(CartStaleWriteError);

    const mutant = mutating(db, GUARDS.cartCas, 'true');
    const result = await freezeCheckout(mutant, catalog, CONFIG, {
      cartId: cart.id,
      baseRevision: cart.revision,
    });
    expect(result.ok).toBe(true);
  });
});

describe('frozenTotals — the CheckoutPort read', () => {
  it('reads STORAGE and never recomputes, even when the price has moved', async () => {
    /*
     * THE DEFINING PROPERTY OF THE WHOLE SUBSYSTEM (brief §5, contract §5).
     * Payments charges this number and Orders snapshots it. Re-running the
     * engine here would let a price change between freeze and capture charge a
     * number the customer never saw.
     */
    const cart = await readyCart(2);
    const frozen = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    if (!frozen.ok) throw new Error('expected totals');

    // The world moves: the price doubles and stock changes.
    catalog.seed({
      variantId: 'var_tee',
      price: { amount: 3998, currency: CURRENCY },
      onHand: 1,
    });

    const read = await frozenTotals(db, cart.id);
    expect(read).toEqual(frozen.totals);
    expect(read.grandTotal).toEqual({ amount: 3998 + 399 + 880, currency: CURRENCY });
  });

  it('404s for a checkout that has not been frozen', async () => {
    // A 404 and not a null: spec §8's retry policy stops on 404, and "no totals"
    // is not something Payments could do anything useful with.
    const cart = await readyCart();
    await expect(frozenTotals(db, cart.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('404s for a checkout id that does not exist', async () => {
    await expect(frozenTotals(db, 'crt_nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('REFUSES a stored total that has been corrupted, rather than charging it', async () => {
    // A hand-run UPDATE, a bad import, a half-written jsonb. Every amount goes
    // back through `money()` on the way out, so a corrupt row is a 404 rather
    // than a charge of NaN.
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    await db.execute(sql`
      UPDATE shop_carts SET frozen_totals = jsonb_set(frozen_totals, '{grandTotal,amount}', '"oops"')
       WHERE id = ${cart.id}`);

    await expect(frozenTotals(db, cart.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('checkout.completed', () => {
  it('is written in the SAME STATEMENT as the transition it describes', async () => {
    /*
     * Contract §6 rule 1: "Write the event in the same transaction as the state
     * change that caused it. An event that can be lost while its cause commits
     * is worse than no event, because the system then believes something
     * happened that nobody will act on."
     *
     * One statement, not `db.transaction` — the Neon HTTP driver throws
     * unconditionally on `transaction()` (spec §4.3a). Proved by neutralising
     * the transition's guard: with the CAS unable to match, the event must not
     * appear either.
     */
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    // A cart already converted: the transition matches nothing.
    await db.execute(sql`UPDATE shop_carts SET status = 'converted' WHERE id = ${cart.id}`);
    await completeCheckout(db, { cartId: cart.id }).catch(() => undefined);

    const events = await db.execute(sql`SELECT id FROM commerce_events`);
    expect(events.rows).toHaveLength(0);
  });

  it('carries everything Orders needs to build an order with NO callback', async () => {
    /*
     * Brief §7 is binding: "Orders must never need to call back into Cart to
     * construct an order. If Orders needs a field, it goes in this payload."
     * Asserted by building an order-shaped object out of the payload alone.
     */
    const cart = await readyCart(2);
    const frozen = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    if (!frozen.ok) throw new Error('expected totals');
    /*
     * THE PAYMENT STEP, WHICH IS THE ONLY THING THAT EVER RECORDS AN EMAIL.
     * `POST /api/shop/payments/intents` carries it and hands it back through
     * `CheckoutPort.recordContact`; no cart route collects one. Without this
     * line the payload below carries `email: null` and Orders parks it — which
     * is exactly what production would have done, so the fixture reproduces the
     * real sequence rather than pre-filling the column.
     */
    await setCheckoutContact(db, { cartId: cart.id, email: 'buyer@example.test' });

    await completeCheckout(db, { cartId: cart.id });

    const rows = await db.execute(sql`
      SELECT id, type, subject_id, payload, occurred_at, processed_at, attempts
        FROM commerce_events`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(String(row.type)).toBe('checkout.completed');
    expect(String(row.subject_id)).toBe(cart.id);
    expect(String(row.id)).toMatch(/^evt_/);
    // Consumer bookkeeping is the CONSUMER's to set (contract §6 rule 3).
    expect(row.processed_at).toBeNull();
    expect(Number(row.attempts)).toBe(0);

    const payload = row.payload as Record<string, unknown>;
    expect(payload.checkoutId).toBe(cart.id);
    expect(payload.email).toBe('buyer@example.test');
    expect(payload.currency).toBe(CURRENCY);
    expect(payload.totals).toEqual(JSON.parse(JSON.stringify(frozen.totals)));

    // The product snapshot: an order line needs a SKU and a title, and Catalog
    // may rename or discontinue the variant tomorrow.
    expect(payload.lines).toEqual([
      {
        variantId: 'var_tee',
        productId: 'prd_tee',
        sku: 'TEE-NAVY-M',
        title: 'Navy Tee',
        optionValues: { Size: 'M' },
        qty: 2,
        unit: { amount: 1999, currency: CURRENCY },
        /*
         * `unitAmount` AND `lineTotal`, UNDER THE NAMES ORDERS' PARSER READS
         * (admin#27). COPIED from the frozen totals, never `unit × qty` computed
         * here — the figure that travels must be the figure the customer was
         * charged. `shop_carts.frozen_lines` stores neither; they are joined on
         * when the event is built, which is why this assertion is on the EVENT
         * payload and the one in `freezes` is not.
         */
        unitAmount: { amount: 1999, currency: CURRENCY },
        lineTotal: { amount: 3998, currency: CURRENCY },
        weightGrams: 180,
      },
    ]);

    /*
     * AND THE SEAM ITSELF, ASSERTED RATHER THAN ASSUMED.
     *
     * This is the fault that would have survived fixing admin#27's missing
     * caller: `parseCheckoutCompleted` requires `unitAmount` and `lineTotal` on
     * every line and `billingAddress` as an object, and Cart emits `unit` and
     * `null`. Nothing could see the disagreement because `checkout.completed`
     * had never been emitted for any cart — so both halves were green and the
     * event would have parked twenty times and been abandoned.
     *
     * Cart's REAL payload through Orders' REAL parser. If either side moves, one
     * of the two subsystems fails a test instead of a customer losing an order.
     */
    const parsed = parseCheckoutCompleted(payload, cart.id);
    expect(parsed.ok, parsed.ok ? '' : `parked at: ${parsed.detail}`).toBe(true);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.value.grandTotal).toBe(frozen.totals.grandTotal.amount);
    expect(parsed.value.lines[0]).toMatchObject({
      sku: 'TEE-NAVY-M',
      qty: 2,
      unitAmount: 1999,
      lineTotal: 3998,
    });
    // No separate billing address means it IS the shipping address, not a park.
    expect(payload.billingAddress).toBeNull();
    expect(parsed.value.billingAddress).toEqual(parsed.value.shippingAddress);

    // The address is a COPY. `shop_addresses` is Cart's table under R3, so an
    // event carrying only an id would force the callback brief §7 forbids.
    expect(payload.shippingAddress).toEqual(UK);

    // The holds, so whoever commits stock on capture knows which ones.
    expect(payload.reservationIds).toEqual([]);
  });

  it('carries the reservation ids taken at checkout start', async () => {
    const cart = await readyCart(2);
    const started = await startCheckout(db, catalog, { cartId: cart.id });
    if (!started.ok) throw new Error('expected holds');
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    await completeCheckout(db, { cartId: cart.id });

    const rows = await db.execute(sql`SELECT payload FROM commerce_events`);
    const payload = rows.rows[0].payload as { reservationIds: string[] };
    expect(payload.reservationIds).toEqual(started.reservations.map((r) => r.id));
  });

  it('moves the cart to converted, and refuses a second completion', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    await completeCheckout(db, { cartId: cart.id });
    expect((await getCart(db, cart.id))?.status).toBe('converted');

    await expect(completeCheckout(db, { cartId: cart.id })).rejects.toBeInstanceOf(
      CartPreconditionError,
    );
    // Exactly one event, whatever the caller does. At-least-once delivery is the
    // outbox guarantee; at-least-once EMISSION would be a second order.
    const events = await db.execute(sql`SELECT id FROM commerce_events`);
    expect(events.rows).toHaveLength(1);
  });
});

/**
 * `CheckoutPort.complete` — the answer to `completeCheckout`'s "WHO CALLS THIS"
 * (admin#27), and the reason it returns a value instead of throwing.
 *
 * Payments calls this from the capture path, and Paystack redelivers
 * `charge.success`. So the SECOND call for a cart is expected traffic, not an
 * error: `completeCheckout` refuses it with `CartPreconditionError` because the
 * cart is already `converted`, and mapping that to a value here is what keeps a
 * duplicate webhook from 500ing — which Paystack would answer by redelivering
 * every 3 minutes and then hourly for 72 hours.
 */
describe('CheckoutPort.complete', () => {
  const port = checkoutPort();

  it('completes once and answers already-completed thereafter', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    await setCheckoutContact(db, { cartId: cart.id, email: 'buyer@example.test' });

    expect(await port.complete(db, cart.id)).toBe('completed');
    expect(await port.complete(db, cart.id)).toBe('already-completed');
    expect(await port.complete(db, cart.id)).toBe('already-completed');

    // ONE event, not three. The transition matched nothing on calls two and
    // three, and the event INSERT selects FROM that transition.
    const events = await db.execute(sql`
      SELECT id FROM commerce_events WHERE type = 'checkout.completed'`);
    expect(events.rows).toHaveLength(1);
  });

  it('answers unavailable for a cart that was never frozen', async () => {
    // `frozenTotals` raises `NotFoundError` for both "no such cart" and "not
    // frozen", and neither is something a retry fixes — so neither may throw
    // past the capture path and cost the payment its record.
    const cart = await readyCart();
    expect(await port.complete(db, cart.id)).toBe('unavailable');
    expect(await port.complete(db, 'crt_does_not_exist')).toBe('unavailable');
  });
});
