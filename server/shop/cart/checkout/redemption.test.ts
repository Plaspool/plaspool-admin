/**
 * SPOOLPOINTS AT THE FREEZE (admin#2) — the Cart half of the seam.
 *
 * WHAT THIS FILE PINS.
 *
 * The freeze is the one-way door: `frozen_totals` is written once and every
 * later reader COPIES it. So a points discount either exists at that instant or
 * it can never exist at all, and the point count that justified it has to be
 * written by the same statement — otherwise a crash between two writes leaves a
 * charge with nothing to explain it, or a debit owed against a discount nobody
 * received.
 *
 * THE PORT IS A FAKE, and `server/marketing/redemption/port.test.ts` is where the
 * real one is proved against marketing's own tables. What is unproven until here
 * is what CART does with each answer — and specifically that the ordinary cart,
 * the one with no port wired at all, is priced exactly as it was before any of
 * this landed.
 *
 * NOTE THE MONEY CONVENTION: cart money is `{ amount, currency }` and the
 * amounts here are minor units. The fixture prices are GBP pence, matching
 * `repo.test.ts` next door, because this file is about the seam and not about
 * the shop's real NGN catalogue.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import type { CartFakeCatalog } from '../test/fake-catalog';
import { addLine, createCart, getCart } from '../cart/repo';
import { createCustomer } from '../identity/customers';
import { freezeCheckout, putAddresses, setShipping } from './repo';
import type { CheckoutConfig } from './repo';
import type { ShippingZone } from './shipping';
import type { Db } from '../../../db/client';
import type {
  PointsRedemptionPort,
  RedemptionQuote,
  RedemptionQuoteInput,
} from '../../../../shared/marketing/redemption';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

const CURRENCY = 'GBP';
const WALLET = 'shopper@example.test';

const ZONES: readonly ShippingZone[] = [
  {
    id: 'domestic',
    label: 'United Kingdom',
    countries: ['GB'],
    taxRateBps: 0,
    taxLabel: 'No VAT',
    shippingTaxable: false,
    options: [{ id: 'standard', label: 'Standard', amountMinor: 400 }],
    fallback: true,
  },
];

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

/** What the fake was ASKED, so a test can assert the cap was quoted against the
 *  undiscounted total rather than merely that a discount appeared. */
let asked: RedemptionQuoteInput[] = [];

function portReturning(quote: RedemptionQuote | null): PointsRedemptionPort {
  return {
    async quote(input) {
      asked.push(input);
      return quote;
    },
    redeem() {
      throw new Error('the freeze must never redeem; the capture does');
    },
    release() {
      throw new Error('the freeze must never release');
    },
  };
}

function throwingPort(): PointsRedemptionPort {
  return {
    quote() {
      throw new Error('marketing is down');
    },
    redeem() {
      throw new Error('unreachable');
    },
    release() {
      throw new Error('unreachable');
    },
  };
}

const discountOf = (minor: number, points: number): RedemptionQuote => ({
  adjustment: {
    code: 'points_redemption',
    label: `${points} Spool Points redeemed`,
    amount: { amount: -minor, currency: CURRENCY },
  },
  points,
  balanceAfter: 0,
});

function configWith(port?: PointsRedemptionPort): CheckoutConfig {
  return {
    zones: ZONES,
    storeCurrency: CURRENCY,
    redemption: port ? () => port : undefined,
  };
}

/** A cart belonging to a signed-in customer, ready to freeze. */
async function readyCart(opts: { signedIn: boolean }) {
  const customer = opts.signedIn ? await createCustomer(db, { email: WALLET }) : null;
  const cart = await createCart(db, { currency: CURRENCY, customerId: customer?.id ?? null });
  await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 2 });
  await putAddresses(db, configWith(), { cartId: cart.id, shipping: UK, billing: null });
  await setShipping(db, configWith(), { cartId: cart.id, optionId: 'standard' });
  return (await getCart(db, cart.id))!;
}

/** The two columns migration 0260 added, as stored. */
async function storedRedemption(cartId: string) {
  const res = await db.execute(sql`
    SELECT redemption_points, redemption_email FROM shop_carts WHERE id = ${cartId}`);
  return {
    points: res.rows[0]?.redemption_points ?? null,
    email: res.rows[0]?.redemption_email ?? null,
  };
}

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetShopTables(db);
  asked = [];
  catalog = fakeCatalog([
    {
      variantId: 'var_tee',
      productId: 'prd_tee',
      sku: 'TEE-NAVY-M',
      title: 'Navy Tee',
      optionValues: { Size: 'M' },
      price: { amount: 2000, currency: CURRENCY },
      onHand: 10,
    },
  ]);
});

describe('the discount is baked into the frozen totals', () => {
  it('applies the adjustment and moves the grand total by exactly its amount', async () => {
    const cart = await readyCart({ signedIn: true });

    const plain = await freezeCheckout(db, catalog, configWith(), { cartId: cart.id });
    expect(plain.ok).toBe(true);
    const before = plain.ok ? plain.totals.grandTotal.amount : 0;

    await resetShopTables(db);
    const withPoints = await readyCart({ signedIn: true });
    const result = await freezeCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: withPoints.id,
      redeemPoints: 250,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.adjustments).toHaveLength(1);
    expect(result.totals.adjustments[0].amount.amount).toBe(-500);
    expect(result.totals.adjustmentTotal.amount).toBe(-500);
    // The engine's own sum, not a number this test computed a second way.
    expect(result.totals.grandTotal.amount).toBe(before - 500);
  });

  it('stores the point count and the wallet in the same write as the totals', async () => {
    const cart = await readyCart({ signedIn: true });
    await freezeCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    const stored = await storedRedemption(cart.id);
    expect(Number(stored.points)).toBe(250);
    expect(String(stored.email)).toBe(WALLET);
  });

  it('quotes the cap against the UNDISCOUNTED total', async () => {
    /*
     * `max_redeem_bps` is "how much of an ORDER may be paid for in points". Quote
     * it against an already-discounted figure and the cap moves every time it is
     * applied — so the number handed to the port has to be the total before any
     * adjustment. 2 × 2000 + 400 shipping, no tax in this zone.
     */
    const cart = await readyCart({ signedIn: true });
    await freezeCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0].pointsRequested).toBe(250);
    expect(asked[0].cartTotalMinor).toBe(4400);
    expect(asked[0].currency).toBe(CURRENCY);
    expect(asked[0].email).toBe(WALLET);
  });
});

describe('the cases that must price exactly as they did before admin#2', () => {
  it('no port wired at all', async () => {
    const cart = await readyCart({ signedIn: true });
    const result = await freezeCheckout(db, catalog, configWith(), { cartId: cart.id });

    expect(result.ok && result.totals.adjustments).toEqual([]);
    expect(result.ok && result.totals.adjustmentTotal.amount).toBe(0);
    expect(await storedRedemption(cart.id)).toEqual({ points: null, email: null });
  });

  it('a port that answers null — nothing to spend, or below the minimum', async () => {
    const cart = await readyCart({ signedIn: true });
    const result = await freezeCheckout(db, catalog, configWith(portReturning(null)), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(result.ok && result.totals.adjustments).toEqual([]);
    expect(await storedRedemption(cart.id)).toEqual({ points: null, email: null });
  });

  it('A GUEST — who has no email at freeze time, and cannot have one', async () => {
    /*
     * THE CONSTRAINT THAT SCOPED THIS FEATURE. Balances are email-keyed, and
     * `shop_carts.email` is not written until the PAYMENT step
     * (`setCheckoutContact`), which runs after this. A guest genuinely has no
     * address to look a balance up by at the moment the total is decided, and
     * frozen totals are never recomputed — so there is no later point at which a
     * guest's discount could be applied. The port must not even be asked.
     */
    const cart = await readyCart({ signedIn: false });
    const result = await freezeCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(asked).toEqual([]);
    expect(result.ok && result.totals.adjustments).toEqual([]);
    expect(await storedRedemption(cart.id)).toEqual({ points: null, email: null });
  });

  it('A SIGNED-IN CUSTOMER WHO DID NOT ASK — the port is not even consulted', async () => {
    /*
     * THE OPT-IN, AND IT IS THE REASON THIS SEAM IS SAFE TO MERGE AHEAD OF THE
     * WIDGET. `quote()` reads an omitted `pointsRequested` as "as much as the
     * rules allow" — correct for the port, and catastrophic as a route default:
     * every signed-in shopper's balance would be spent on their next order
     * without anyone asking. Until the storefront sends a number, nothing here
     * changes for anybody.
     */
    const cart = await readyCart({ signedIn: true });
    const result = await freezeCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
    });

    expect(asked).toEqual([]);
    expect(result.ok && result.totals.adjustments).toEqual([]);
    expect(await storedRedemption(cart.id)).toEqual({ points: null, email: null });
  });

  it('a THROWING port still freezes the cart, at the undiscounted price', async () => {
    /*
     * The freeze is the step immediately before money. A marketing outage that
     * failed it would be a customer who cannot pay at all; degrading to the price
     * the shop charged yesterday is the direction to be wrong in.
     */
    const cart = await readyCart({ signedIn: true });
    const result = await freezeCheckout(db, catalog, configWith(throwingPort()), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.totals.adjustments).toEqual([]);
    expect(result.ok && result.totals.grandTotal.amount).toBe(4400);
  });
});
