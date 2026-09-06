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
  thawCheckout,
} from './repo';
import { saveDeliveryArea } from './delivery-areas-repo';
import { CartPreconditionError, CartStaleWriteError } from '../errors';
import { BadRequestError, NotFoundError } from '../../../repo/errors';
import type { PaymentStatus } from '../../../../shared/commerce/ports';
import { checkoutPort } from '../port';
import { parseCheckoutCompleted } from '../../orders/inbound';
import type { CartFakeCatalog } from '../test/fake-catalog';
import type { Db } from '../../../db/client';
import type { AddOnPort } from '../../../../shared/commerce/add-ons';

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

  /**
   * ═══ THIS TEST'S MEANING CHANGED, AND THE CHANGE IS THE POINT ═══
   *
   * It used to read "cannot be changed once the cart is converting" and assert
   * a bare `CartPreconditionError`. That was the invariant for as long as the
   * freeze had no way back — and the cost of it was that a shopper who reached
   * the payment page and did not pay could never edit their own checkout again.
   *
   * The invariant NOW is narrower and truer: an address may not be changed
   * once a total has been frozen from it AND THAT TOTAL MIGHT BE CHARGED. When
   * nothing was ever paid, editing the address thaws the checkout instead —
   * see the `thawCheckout` suite, which owns that path.
   *
   * What survives here is the refusal when the thaw cannot be PROVEN safe: no
   * payments port means nothing can answer "was this paid", and absence
   * refuses rather than guessing.
   */
  it('cannot be changed once converting, when nothing can prove it was unpaid', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });

    // `CONFIG` carries no `payments` port — the deployment cannot tell a stuck
    // cart from a paid one, so it refuses. 501, permanent, and named.
    await expect(
      putAddresses(db, CONFIG, { cartId: cart.id, shipping: { ...UK, city: 'Hull' }, billing: null }),
    ).rejects.toMatchObject({ name: 'NotImplementedError', feature: 'checkout_cancel' });

    expect((await getCart(db, cart.id))?.status).toBe('converting');
    const stored = await db.execute(sql`
      SELECT city FROM shop_addresses WHERE cart_id = ${cart.id} AND kind = 'shipping'`);
    expect(stored.rows[0]?.city).toBe('London');
  });

  it('cannot be changed once converting AND PAID, even with the port wired', async () => {
    // The refusal that actually protects money, as opposed to the one above
    // that protects against not knowing.
    const cart = await readyCart();
    await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    const config = {
      ...CONFIG,
      payments: {
        intentsFor: async () => [{ id: 'pi_1', status: 'captured' as PaymentStatus }],
        cancel: async () => {},
      },
    };

    await expect(
      putAddresses(db, config, { cartId: cart.id, shipping: { ...UK, city: 'Hull' }, billing: null }),
    ).rejects.toBeInstanceOf(CartPreconditionError);
    expect((await getCart(db, cart.id))?.status).toBe('converting');
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

describe('district delivery pricing', () => {
  /*
   * Migration 0460 + `districtRuling`: the shipping address carries a CHOSEN
   * `marketing_service_areas.key`, and `shop_delivery_areas` (migration 0300)
   * holds the shop's opinion of it. These four pin the contract — no opinion
   * means the zone rate, a priced district replaces every option's amount AND
   * the frozen number, and a switched-off district is refused at the door and
   * again at the freeze, per the owner's "off = we refuse to deliver there".
   */
  const GWARINPA = { ...UK, district: 'gwarinpa' };

  it('prices every option — and the FROZEN total — at the district override', async () => {
    await saveDeliveryArea(db, 'gwarinpa', { delivers: true, rateMinor: 555 }, null);
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: GWARINPA, billing: null });

    // Both zone options survive — id, label and taxability are still the
    // zone's — but the amount is the district's flat rate on each of them.
    const options = await shippingOptionsForCart(db, CONFIG, cart.id);
    expect(options.map((o) => o.id)).toEqual(['standard', 'express']);
    expect(options.map((o) => o.amount.amount)).toEqual([555, 555]);

    // The number `setShipping` answers is the number the freeze will reach.
    const chosen = await setShipping(db, CONFIG, { cartId: cart.id, optionId: 'standard' });
    expect(chosen.amount).toEqual({ amount: 555, currency: CURRENCY });

    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    if (!result.ok) throw new Error('expected totals');
    // £19.99 + £5.55 district delivery, 20% VAT on both: the override changes
    // the shipping AMOUNT, never its taxability — that stays the zone's call.
    expect(result.totals.shippingTotal).toEqual({ amount: 555, currency: CURRENCY });
    expect(result.totals.taxTotal).toEqual({ amount: 400 + 111, currency: CURRENCY });
    expect(result.totals.grandTotal).toEqual({ amount: 1999 + 555 + 511, currency: CURRENCY });
  });

  it('prices a district nobody has an opinion about at the zone rate', async () => {
    // No row in `shop_delivery_areas` is not "missing" — it is the live
    // behaviour before the table existed, and most districts will never have
    // a row. An unknown key must therefore be indistinguishable from none.
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });
    await putAddresses(db, CONFIG, {
      cartId: cart.id,
      shipping: { ...UK, district: 'maitama' },
      billing: null,
    });
    const options = await shippingOptionsForCart(db, CONFIG, cart.id);
    expect(options.map((o) => o.amount.amount)).toEqual([399, 799]);
  });

  it('refuses a switched-off district at the door, writing NOTHING', async () => {
    await saveDeliveryArea(db, 'gwarinpa', { delivers: false }, null);
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });
    await expect(
      putAddresses(db, CONFIG, { cartId: cart.id, shipping: GWARINPA, billing: null }),
    ).rejects.toThrow(/outside_delivery_area/);
    // Refused BEFORE the cart write: no address exists, so no options do
    // either — the customer is still on the address step with a clean slate.
    expect(await shippingOptionsForCart(db, CONFIG, cart.id)).toEqual([]);
  });

  it('the freeze refuses a district switched off mid-checkout', async () => {
    // The address passed when it was written; the owner turned Gwarinpa off
    // while the customer sat at the payment step. The freeze is the last
    // instant a refusal costs nothing — after it, the answer is a refund.
    const cart = await createCart(db, { currency: CURRENCY });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });
    await putAddresses(db, CONFIG, { cartId: cart.id, shipping: GWARINPA, billing: null });
    await setShipping(db, CONFIG, { cartId: cart.id, optionId: 'standard' });

    await saveDeliveryArea(db, 'gwarinpa', { delivers: false }, null);

    expect(await shippingOptionsForCart(db, CONFIG, cart.id)).toEqual([]);
    const result = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('outside_delivery_area');
    // Nothing froze: the cart is still open, and still editable back to an
    // address the shop does go to.
    expect((await getCart(db, cart.id))?.status).toBe('open');
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
        /* Migration 0600. This fake catalog seeds no ladder, so the line is
           undiscounted and `effectiveUnit` is the list price — which is exactly
           what every frozen total looked like before bulk pricing existed. */
        bulkQty: 2,
        bulkPercentBps: 0,
        effectiveUnit: { amount: 1999, currency: CURRENCY },
        lineTotal: { amount: 3998, currency: CURRENCY },
        /* Migration 0820, and the same story one feature later: no code is
           applied to this cart, so the line's share of one is zero — which is
           what every frozen total looked like before discount codes existed. */
        codeDiscount: { amount: 0, currency: CURRENCY },
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
    // `district` rides along since 0460 — null here, because UK names none.
    // `location` rides along since 0780 — null here, and null on almost every
    // order: the pin is optional and the prompt ships switched off.
    expect(payload.shippingAddress).toEqual({ ...UK, district: null, location: null });

    // The holds, so whoever commits stock on capture knows which ones.
    expect(payload.reservationIds).toEqual([]);
  });

  it('carries the add-ons through the event and Orders reads them back, including a free one', async () => {
    const port: AddOnPort<Db> = {
      async offers() {
        return [
          { id: 'ado_box', title: 'Gift box', description: null, imageUrl: null, price: { amount: 1500, currency: CURRENCY }, amount: { amount: 1500, currency: CURRENCY }, mode: 'include', choice: null },
          { id: 'ado_note', title: 'Note', description: null, imageUrl: null, price: { amount: 500, currency: CURRENCY }, amount: { amount: 0, currency: CURRENCY }, mode: 'include', choice: null },
        ];
      },
    };
    const cart = await readyCart();
    const frozen = await freezeCheckout(db, catalog, { ...CONFIG, addOns: port }, { cartId: cart.id });
    if (!frozen.ok) throw new Error('expected totals');
    await setCheckoutContact(db, { cartId: cart.id, email: 'buyer@example.test' });

    await completeCheckout(db, { cartId: cart.id });

    const rows = await db.execute(sql`SELECT payload FROM commerce_events`);
    const payload = rows.rows[0].payload as Record<string, unknown>;
    const parsed = parseCheckoutCompleted(payload, cart.id);
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(parsed.value.addOnTotal).toBe(1500);
    expect(parsed.value.addOns).toEqual([
      { id: 'ado_box', title: 'Gift box', mode: 'included', amount: 1500, listPrice: 1500 },
      { id: 'ado_note', title: 'Note', mode: 'included', amount: 0, listPrice: 500 },
    ]);
    expect(parsed.value.grandTotal).toBe(frozen.totals.grandTotal.amount);
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

/**
 * THAWING — the handle on the inside of the freeze's one-way door.
 *
 * `converting → open` sat in the transition allow-list from the beginning with
 * a comment promising a shopper their basket back, and NOTHING in the
 * application ever performed it. Every test below is about a cart that a real
 * customer would otherwise never be able to edit again.
 */
describe('thawCheckout', () => {
  /**
   * A stand-in for `CheckoutPaymentsPort` that RECORDS what it was asked.
   *
   * Its `cancel` never throws, which is what the real adapter promises: the
   * refusals `cancelIntent` raises for an already-settled intent are races the
   * thaw has already ruled on, and turning one into a 500 would fail a shopper's
   * recovery for a cart that by then is in the state they wanted.
   */
  function fakePayments(intents: Array<{ id: string; status: PaymentStatus }> = []) {
    const cancelled: string[] = [];
    return {
      cancelled,
      port: {
        intentsFor: async () => intents,
        cancel: async (_db: Db, id: string) => {
          cancelled.push(id);
        },
      },
    };
  }

  /** A cart taken all the way to `converting`, as a shopper on the payment page. */
  async function frozenCart() {
    const cart = await readyCart();
    const frozen = await freezeCheckout(db, catalog, CONFIG, { cartId: cart.id });
    expect(frozen.ok).toBe(true);
    return (await getCart(db, cart.id))!;
  }

  it('reopens the cart, CLEARS THE FROZEN TOTALS, and cancels the pending intent', async () => {
    const cart = await frozenCart();
    expect(cart.status).toBe('converting');
    const payments = fakePayments([{ id: 'pi_1', status: 'requires_payment' }]);

    const after = await thawCheckout(db, { ...CONFIG, payments: payments.port }, {
      cartId: cart.id,
    });

    expect(after.status).toBe('open');
    expect(after.revision).toBeGreaterThan(cart.revision);
    expect(payments.cancelled).toEqual(['pi_1']);

    /*
     * THE LOAD-BEARING HALF. `frozenTotals` has no status guard and
     * `createIntent` prices a payment from whatever it returns, so a thaw that
     * flipped the status alone would leave a freely editable cart carrying a
     * stale, still-chargeable total. It must now refuse.
     */
    await expect(frozenTotals(db, cart.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('REFUSES a checkout whose payment was authorized, and writes nothing', async () => {
    /*
     * The bar is `authorized`, not `captured`. A capture normally drives
     * `converting → converted` inline, but `completeCheckoutForIntent` records
     * three ways that does not happen while the money is still taken — and each
     * leaves a PAID cart sitting at `converting`, which is indistinguishable
     * from this function's target by anything Cart can see on its own.
     */
    const cart = await frozenCart();
    const payments = fakePayments([{ id: 'pi_1', status: 'authorized' }]);

    await expect(
      thawCheckout(db, { ...CONFIG, payments: payments.port }, { cartId: cart.id }),
    ).rejects.toMatchObject({ name: 'CartPreconditionError', operation: 'checkout_paid' });

    expect((await getCart(db, cart.id))?.status).toBe('converting');
    expect(payments.cancelled).toEqual([]);
    // And the total is still there to charge, because the order is still coming.
    await expect(frozenTotals(db, cart.id)).resolves.toBeTruthy();
  });

  it('REFUSES a captured checkout for the same reason', async () => {
    const cart = await frozenCart();
    const payments = fakePayments([{ id: 'pi_1', status: 'captured' }]);
    await expect(
      thawCheckout(db, { ...CONFIG, payments: payments.port }, { cartId: cart.id }),
    ).rejects.toMatchObject({ operation: 'checkout_paid' });
    expect((await getCart(db, cart.id))?.status).toBe('converting');
  });

  it('a FAILED or CANCELLED intent does not block the shopper — that IS the back-out', async () => {
    /*
     * `paymentStatusRank` puts both below `authorized` on purpose: they are
     * terminal only in the sense that we stopped expecting money. A declined
     * card is the single most likely reason somebody is here.
     */
    const cart = await frozenCart();
    const payments = fakePayments([
      { id: 'pi_dead', status: 'failed' },
      { id: 'pi_gone', status: 'cancelled' },
    ]);

    const after = await thawCheckout(db, { ...CONFIG, payments: payments.port }, {
      cartId: cart.id,
    });

    expect(after.status).toBe('open');
    // Neither is cancelled again — both already outrank what `cancelIntent` moves.
    expect(payments.cancelled).toEqual([]);
  });

  it('is IDEMPOTENT on an open cart, and does not consult Payments at all', async () => {
    // The storefront fires this from a back button, a link and a `beforeunload`
    // without tracking which of them ran.
    const cart = await readyCart();
    let asked = false;
    const port = {
      intentsFor: async () => {
        asked = true;
        return [];
      },
      cancel: async () => {},
    };

    const after = await thawCheckout(db, { ...CONFIG, payments: port }, { cartId: cart.id });

    expect(after.status).toBe('open');
    expect(after.revision).toBe(cart.revision);
    expect(asked).toBe(false);
  });

  it('refuses a CONVERTED cart — that is an order, and reopening it would un-sell it', async () => {
    const cart = await frozenCart();
    await completeCheckout(db, { cartId: cart.id });
    const payments = fakePayments();

    await expect(
      thawCheckout(db, { ...CONFIG, payments: payments.port }, { cartId: cart.id }),
    ).rejects.toMatchObject({ operation: 'cancel_checkout' });
    expect((await getCart(db, cart.id))?.status).toBe('converted');
  });

  it('refuses with 501 when no payments port is wired, rather than guessing', async () => {
    /*
     * The deliberate inverse of admin#27, where an unwired `CheckoutPort` let
     * the highest-severity route in the system run and quietly do nothing.
     * There is no correct weaker behaviour for "unfreeze without checking
     * whether it was paid", so absence refuses.
     */
    const cart = await frozenCart();
    await expect(thawCheckout(db, CONFIG, { cartId: cart.id })).rejects.toMatchObject({
      name: 'NotImplementedError',
      feature: 'checkout_cancel',
    });
    expect((await getCart(db, cart.id))?.status).toBe('converting');
  });

  it('MUTATION: neutralising `status = converting` lets a CONVERTED cart be reopened', async () => {
    /*
     * The allow-list check runs against a row that has already been read, so on
     * its own it is exactly the stale pre-check the CAS rules forbid. This
     * proves the predicate in the statement is what actually refuses.
     */
    const cart = await frozenCart();
    await completeCheckout(db, { cartId: cart.id });
    const payments = fakePayments();
    const mutant = mutating(db, GUARDS.cartConverting, 'true');

    // The JS allow-list still refuses on the real handle...
    await expect(
      thawCheckout(db, { ...CONFIG, payments: payments.port }, { cartId: cart.id }),
    ).rejects.toMatchObject({ operation: 'cancel_checkout' });
    // ...and under the mutant the statement would have matched, which is the
    // whole reason the predicate is not left to the JavaScript check.
    const res = await mutant.execute(sql`
      UPDATE shop_carts SET status = 'open', revision = revision + 1
       WHERE id = ${cart.id} AND status = 'converting' RETURNING id`);
    expect(res.rows).toHaveLength(1);
  });

  it('an address edit on a FROZEN cart thaws it instead of answering 409', async () => {
    /*
     * ═══ THE BUG THIS WHOLE FEATURE IS ABOUT ═══
     *
     * A shopper reached the payment page, did not pay, and came back to fix
     * their street. Every such request answered
     * `409 precondition_failed / update_cart`, for ever, and `LIVE_STATUSES`
     * kept handing the same dead cart back to the cookie.
     */
    const cart = await frozenCart();
    const payments = fakePayments([{ id: 'pi_1', status: 'requires_payment' }]);

    const { zone } = await putAddresses(
      db,
      { ...CONFIG, payments: payments.port },
      {
        cartId: cart.id,
        shipping: { ...UK, line1: '2 High Street' },
        billing: null,
        /*
         * THE SHOPPER'S OWN TOKEN, taken before the thaw — the exact value a
         * storefront holds after a freeze. The thaw is itself a write and bumps
         * the revision, so passing this straight on to the address write would
         * answer a successful recovery with `409 stale_write`: the same dead
         * end, one step further along.
         */
        baseRevision: cart.revision,
      },
    );

    expect(zone).toBe('domestic');
    expect((await getCart(db, cart.id))?.status).toBe('open');
    expect(payments.cancelled).toEqual(['pi_1']);
    const stored = await db.execute(sql`
      SELECT line1 FROM shop_addresses WHERE cart_id = ${cart.id} AND kind = 'shipping'`);
    expect(stored.rows[0]?.line1).toBe('2 High Street');
  });

  it('an address edit REFUSED by the delivery rules thaws nothing', async () => {
    /*
     * Position, not just presence: `makeEditable` runs AFTER both refusals and
     * before the first write. An address the shop will not deliver to must
     * leave the frozen checkout exactly as it found it — otherwise a typo in a
     * country code would cancel somebody's payment.
     */
    const cart = await frozenCart();
    const payments = fakePayments([{ id: 'pi_1', status: 'requires_payment' }]);

    await expect(
      putAddresses(
        db,
        { ...CONFIG, payments: payments.port },
        { cartId: cart.id, shipping: { ...UK, countryCode: 'not-a-code' }, billing: null },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect((await getCart(db, cart.id))?.status).toBe('converting');
    expect(payments.cancelled).toEqual([]);
  });

  it('a thawed cart can be re-frozen, and the NEW address is what gets priced', async () => {
    // The round trip the shopper actually makes: pay page → back → change the
    // country → pay page. The second freeze must price the second address.
    const cart = await frozenCart();
    const config = { ...CONFIG, payments: fakePayments().port };

    await putAddresses(db, config, {
      cartId: cart.id,
      shipping: { ...UK, city: 'Dublin', postalCode: 'D02', countryCode: 'IE' },
      billing: null,
    });
    await setShipping(db, config, { cartId: cart.id, optionId: 'standard' });
    const refrozen = await freezeCheckout(db, catalog, config, { cartId: cart.id });

    expect(refrozen.ok).toBe(true);
    if (!refrozen.ok) return;
    // The EU zone: 999 shipping, no VAT — not the UK's 399 and 20%.
    expect(refrozen.totals.shippingTotal.amount).toBe(999);
    expect(refrozen.totals.taxTotal.amount).toBe(0);
  });
});
