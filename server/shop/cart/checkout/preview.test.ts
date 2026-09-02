/**
 * THE PREVIEW (admin#100 Part A, storefront#112) — pricing BEFORE the one-way door.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE EXISTS TO PIN, and it is one sentence: THE PREVIEW AND THE
 * FREEZE MUST NEVER DISAGREE.
 *
 * The storefront shows a shopper a discount and a total, and then freezes. If
 * the two numbers are produced by two pieces of arithmetic, they will diverge —
 * not today, but the first time somebody edits one of them. So `previewCheckout`
 * and `freezeCheckout` share `priceCart`, and the first test below drives BOTH
 * against the same cart and compares the whole `FrozenTotals` object rather than
 * a field of it. A future edit that prices only one of the two paths fails here.
 *
 * THE SECOND THING IT PINS IS THAT PREVIEW WRITES NOTHING. `quote()` reserves
 * nothing by construction, but the freeze's UPDATE sits four lines away from the
 * preview's return, and a copy-paste is all it would take to move a cart to
 * `converting` on a read. The cart's status, revision, frozen columns and both
 * redemption columns are asserted unchanged.
 *
 * THE PORT IS A FAKE, as in `redemption.test.ts` next door — the real one is
 * proved against marketing's own tables in `server/marketing/redemption/port.test.ts`.
 * What is unproven until here is what the PREVIEW does with each answer.
 *
 * Money is GBP pence, matching `repo.test.ts` and `redemption.test.ts`: this
 * file is about the seam, not about the shop's real NGN catalogue.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import type { CartFakeCatalog } from '../test/fake-catalog';
import { addLine, createCart, getCart } from '../cart/repo';
import { createCustomer } from '../identity/customers';
import { freezeCheckout, previewCheckout, putAddresses, setShipping } from './repo';
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
    taxRateBps: 2000,
    taxLabel: 'VAT',
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
      throw new Error('a preview must never redeem');
    },
    release() {
      throw new Error('a preview must never release');
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
  balanceAfter: 1_000,
});

function configWith(port?: PointsRedemptionPort): CheckoutConfig {
  return {
    zones: ZONES,
    storeCurrency: CURRENCY,
    redemption: port ? () => port : undefined,
  };
}

/** A cart belonging to a signed-in customer, ready to price. */
async function readyCart(opts: { signedIn: boolean } = { signedIn: true }) {
  const customer = opts.signedIn ? await createCustomer(db, { email: WALLET }) : null;
  const cart = await createCart(db, { currency: CURRENCY, customerId: customer?.id ?? null });
  await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 2 });
  await putAddresses(db, configWith(), { cartId: cart.id, shipping: UK, billing: null });
  await setShipping(db, configWith(), { cartId: cart.id, optionId: 'standard' });
  return (await getCart(db, cart.id))!;
}

/** Everything the freeze writes and the preview must not. */
async function storedState(cartId: string) {
  const res = await db.execute(sql`
    SELECT status, revision, frozen_totals, frozen_lines, frozen_at,
           redemption_points, redemption_email
      FROM shop_carts WHERE id = ${cartId}`);
  const row = res.rows[0]!;
  return {
    status: String(row.status),
    revision: Number(row.revision),
    frozenTotals: row.frozen_totals ?? null,
    frozenLines: row.frozen_lines ?? null,
    frozenAt: row.frozen_at ?? null,
    redemptionPoints: row.redemption_points ?? null,
    redemptionEmail: row.redemption_email ?? null,
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

describe('the preview and the freeze agree', () => {
  it('prices a plain cart exactly as the freeze would', async () => {
    const cart = await readyCart();

    const preview = await previewCheckout(db, catalog, configWith(), { cartId: cart.id });
    const freeze = await freezeCheckout(db, catalog, configWith(), { cartId: cart.id });

    expect(preview.ok).toBe(true);
    expect(freeze.ok).toBe(true);
    if (!preview.ok || !freeze.ok) return;
    // THE WHOLE OBJECT, not a field of it: a future edit that prices only one
    // of the two paths has to fail here rather than in production.
    expect(preview.totals).toEqual(freeze.totals);
  });

  it('prices a redeemed cart exactly as the freeze would', async () => {
    const cart = await readyCart();
    const config = configWith(portReturning(discountOf(500, 250)));

    const preview = await previewCheckout(db, catalog, config, {
      cartId: cart.id,
      redeemPoints: 250,
    });
    const freeze = await freezeCheckout(db, catalog, config, {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(preview.ok).toBe(true);
    expect(freeze.ok).toBe(true);
    if (!preview.ok || !freeze.ok) return;
    expect(preview.totals).toEqual(freeze.totals);
    expect(preview.totals.adjustmentTotal.amount).toBe(-500);
  });

  it('quotes the cap against the UNDISCOUNTED total, as the freeze does', async () => {
    const cart = await readyCart();
    const plain = await previewCheckout(db, catalog, configWith(), { cartId: cart.id });
    const undiscounted = plain.ok ? plain.totals.grandTotal.amount : -1;

    asked = [];
    await previewCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(asked).toHaveLength(1);
    expect(asked[0].cartTotalMinor).toBe(undiscounted);
  });
});

describe('the preview writes nothing', () => {
  it('leaves the cart open, unfrozen, un-revised and unredeemed', async () => {
    const cart = await readyCart();
    const before = await storedState(cart.id);

    const result = await previewCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(result.ok).toBe(true);
    expect(await storedState(cart.id)).toEqual(before);
    // And the state it started in was genuinely the un-frozen one, so the
    // assertion above is not comparing two identical piles of nulls by accident.
    expect(before.status).toBe('open');
    expect(before.frozenTotals).toBeNull();
    expect(before.redemptionPoints).toBeNull();
  });

  it('prices a cart that has ALREADY been frozen, without disturbing it', async () => {
    const cart = await readyCart();
    await freezeCheckout(db, catalog, configWith(), { cartId: cart.id });
    const frozen = await storedState(cart.id);
    expect(frozen.status).toBe('converting');

    // A shopper who reloads the payment step must still be able to re-price.
    // The freeze refuses a non-open cart; a read has no reason to.
    const result = await previewCheckout(db, catalog, configWith(), { cartId: cart.id });

    expect(result.ok).toBe(true);
    expect(await storedState(cart.id)).toEqual(frozen);
  });
});

describe('what the preview reports about the points', () => {
  it('reports how many points were APPLIED, not how many were asked for', async () => {
    const cart = await readyCart();
    // The shopper asks to spend five million; the rules allow 250.
    const result = await previewCheckout(
      db,
      catalog,
      configWith(portReturning(discountOf(500, 250))),
      { cartId: cart.id, redeemPoints: 5_000_000 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redemption).toEqual({
      pointsApplied: 250,
      discountMinor: 500,
      balanceAfter: 1_000,
    });
  });

  it('answers no redemption when the shopper asked for none', async () => {
    const cart = await readyCart();
    const result = await previewCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redemption).toBeNull();
    expect(result.totals.adjustments).toHaveLength(0);
    // The port was never even consulted — an omitted opt-in is not a quote of
    // zero, it is no quote at all.
    expect(asked).toHaveLength(0);
  });

  it('prices without a discount when marketing is down, rather than failing', async () => {
    const cart = await readyCart();
    const result = await previewCheckout(db, catalog, configWith(throwingPort()), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redemption).toBeNull();
    expect(result.totals.adjustments).toHaveLength(0);
  });

  it('answers no redemption for a guest, who has no wallet to quote against', async () => {
    const cart = await readyCart({ signedIn: false });
    const result = await previewCheckout(db, catalog, configWith(portReturning(discountOf(500, 250))), {
      cartId: cart.id,
      redeemPoints: 250,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redemption).toBeNull();
  });
});

describe('the refusals are the freeze’s refusals', () => {
  it('refuses an empty cart with the same reason the freeze gives', async () => {
    const customer = await createCustomer(db, { email: WALLET });
    const cart = await createCart(db, { currency: CURRENCY, customerId: customer.id });

    const result = await previewCheckout(db, catalog, configWith(), { cartId: cart.id });

    expect(result).toEqual({ ok: false, reason: 'empty_cart' });
  });

  it('refuses a cart with no shipping address, as the freeze does', async () => {
    const customer = await createCustomer(db, { email: WALLET });
    const cart = await createCart(db, { currency: CURRENCY, customerId: customer.id });
    await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 1 });

    const result = await previewCheckout(db, catalog, configWith(), { cartId: cart.id });

    expect(result).toEqual({ ok: false, reason: 'no_shipping_address' });
  });
});
