/**
 * A DISCOUNT CODE ON A CART (admin#100 Part B, storefront#113) — the Cart half
 * of the second marketing seam.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PINS.
 *
 * 1. **The code is stored, not derived.** storefront#113 requires that an
 *    applied code survives a page reload, so it lives on `shop_carts` and the
 *    pricing pass reads it back. `preview` and `freeze` therefore both see it
 *    without either being told.
 *
 * 2. **IT IS RE-JUDGED AT THE MONEY MOMENT, and a dead code REFUSES rather than
 *    quietly costing more.** An owner can disable a campaign while a cart sits
 *    at the payment step. Pricing without the code at that point would charge a
 *    shopper more than the screen showed them, silently — which is the one
 *    outcome that must not happen. The refusal names the reason, so the
 *    storefront can say "that code expired" and offer the new total, and the
 *    same argument the district ruling makes at the freeze applies here.
 *
 * 3. **The port is a fake.** The rules are proved against marketing's own tables
 *    in `server/marketing/discounts/port.test.ts`. What is unproven until here
 *    is what CART does with each answer.
 *
 * Money is GBP pence, matching `repo.test.ts` and `redemption.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, resetShopTables } from '../test/harness';
import { fakeCatalog } from '../test/fake-catalog';
import type { CartFakeCatalog } from '../test/fake-catalog';
import { addLine, createCart, getCart } from '../cart/repo';
import {
  applyDiscount,
  freezeCheckout,
  previewCheckout,
  putAddresses,
  removeDiscount,
  setShipping,
} from './repo';
import type { CheckoutConfig } from './repo';
import type { ShippingZone } from './shipping';
import type { Db } from '../../../db/client';
import type { DiscountCodePort, DiscountRejection } from '../../../../shared/marketing/discounts';

let db: Db;
let close: () => Promise<void>;
let catalog: CartFakeCatalog;

const CURRENCY = 'GBP';

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

const TEN_PERCENT = {
  code: 'WELCOME10',
  label: '10% off',
  kind: 'percent',
  percentBps: 1000,
} as const;

/** What the fake was asked, so a test can assert the freeze re-judged at all. */
let asked: Array<{ code: string; currency: string }> = [];

function portAnswering(answer: DiscountRejection | null): DiscountCodePort {
  return {
    async validate({ code, currency }) {
      asked.push({ code, currency });
      return answer === null
        ? { ok: true, id: 'dsc_1', discount: TEN_PERCENT }
        : { ok: false, reason: answer };
    },
    redeem() {
      throw new Error('the cart must never count a use; the capture does');
    },
  };
}

function configWith(port?: DiscountCodePort): CheckoutConfig {
  return {
    zones: ZONES,
    storeCurrency: CURRENCY,
    discounts: port ? () => port : undefined,
  };
}

async function readyCart() {
  const cart = await createCart(db, { currency: CURRENCY, customerId: null });
  await addLine(db, { cartId: cart.id, variantId: 'var_tee', qty: 2 });
  await putAddresses(db, configWith(), { cartId: cart.id, shipping: UK, billing: null });
  await setShipping(db, configWith(), { cartId: cart.id, optionId: 'standard' });
  return (await getCart(db, cart.id))!;
}

const storedCode = async (cartId: string) =>
  (await db.execute(sql`SELECT discount_code FROM shop_carts WHERE id = ${cartId}`)).rows[0]
    ?.discount_code ?? null;

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

describe('applying and removing', () => {
  it('stores the code so it survives a reload', async () => {
    const cart = await readyCart();

    const result = await applyDiscount(db, configWith(portAnswering(null)), {
      cartId: cart.id,
      code: 'welcome10',
      now: 1_000,
    });

    expect(result.ok).toBe(true);
    // The ROW's code, uppercase, not the string the shopper typed. The port
    // normalises, and storing its answer means the freeze re-reads the same
    // spelling the model holds.
    expect(await storedCode(cart.id)).toBe('WELCOME10');
    expect((await getCart(db, cart.id))?.discountCode).toBe('WELCOME10');
  });

  it('refuses a bad code with its reason, and stores nothing', async () => {
    const cart = await readyCart();

    const result = await applyDiscount(db, configWith(portAnswering('expired')), {
      cartId: cart.id,
      code: 'GONE',
      now: 1_000,
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(await storedCode(cart.id)).toBeNull();
  });

  it('removes a code that was applied', async () => {
    const cart = await readyCart();
    await applyDiscount(db, configWith(portAnswering(null)), {
      cartId: cart.id,
      code: 'WELCOME10',
      now: 1_000,
    });

    await removeDiscount(db, { cartId: cart.id });

    expect(await storedCode(cart.id)).toBeNull();
  });

  it('removing when none is applied is a no-op, not a failure', async () => {
    const cart = await readyCart();
    // The storefront's "clear" button must not need to know whether there is
    // anything to clear — a 409 there would be a dead end on a screen whose
    // whole job is to get the shopper out of one.
    await expect(removeDiscount(db, { cartId: cart.id })).resolves.not.toThrow();
  });
});

describe('what the code does to the price', () => {
  it('reaches the frozen totals, pre-tax', async () => {
    const cart = await readyCart();
    const config = configWith(portAnswering(null));
    await applyDiscount(db, config, { cartId: cart.id, code: 'WELCOME10', now: 1_000 });

    const result = await freezeCheckout(db, catalog, config, { cartId: cart.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 × 2000 = 4000 goods, 10% off = 400, VAT 20% on 3600 = 720, £4 shipping.
    expect(result.totals.subtotal.amount).toBe(4_000);
    expect(result.totals.discountTotal.amount).toBe(-400);
    expect(result.totals.taxTotal.amount).toBe(720);
    expect(result.totals.discount).toEqual(TEN_PERCENT);
    expect(result.totals.grandTotal.amount).toBe(4_000 - 400 + 400 + 720);
  });

  it('is priced identically by the preview and the freeze', async () => {
    const cart = await readyCart();
    const config = configWith(portAnswering(null));
    await applyDiscount(db, config, { cartId: cart.id, code: 'WELCOME10', now: 1_000 });

    const preview = await previewCheckout(db, catalog, config, { cartId: cart.id });
    const freeze = await freezeCheckout(db, catalog, config, { cartId: cart.id });

    expect(preview.ok && freeze.ok).toBe(true);
    if (!preview.ok || !freeze.ok) return;
    expect(preview.totals).toEqual(freeze.totals);
  });

  it('prices a cart with no code exactly as it did before this feature', async () => {
    const cart = await readyCart();

    const result = await freezeCheckout(db, catalog, configWith(portAnswering(null)), {
      cartId: cart.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.discount).toBeNull();
    expect(result.totals.discountTotal.amount).toBe(0);
    // 4000 goods + 800 VAT + 400 shipping, untouched.
    expect(result.totals.grandTotal.amount).toBe(5_200);
    // And the port was never consulted, because there was nothing to judge.
    expect(asked).toHaveLength(0);
  });
});

describe('re-judged at the money moment', () => {
  it('REFUSES the freeze when the code died after it was applied', async () => {
    const cart = await readyCart();
    await applyDiscount(db, configWith(portAnswering(null)), {
      cartId: cart.id,
      code: 'WELCOME10',
      now: 1_000,
    });

    // The owner switched the campaign off while the shopper was typing a card
    // number. Pricing without the code here would charge them more than the
    // screen showed, silently — so it refuses and names why.
    const result = await freezeCheckout(db, catalog, configWith(portAnswering('disabled')), {
      cartId: cart.id,
    });

    expect(result).toEqual({ ok: false, reason: 'discount_rejected', discountReason: 'disabled' });
    // And nothing was frozen: the cart is still the shopper's to fix.
    expect((await getCart(db, cart.id))?.status).toBe('open');
  });

  it('re-judges on the PREVIEW too, so the storefront learns before the freeze', async () => {
    const cart = await readyCart();
    await applyDiscount(db, configWith(portAnswering(null)), {
      cartId: cart.id,
      code: 'WELCOME10',
      now: 1_000,
    });

    const result = await previewCheckout(db, catalog, configWith(portAnswering('limit_reached')), {
      cartId: cart.id,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'discount_rejected',
      discountReason: 'limit_reached',
    });
  });

  it('asks about the stored code, in the cart’s own currency', async () => {
    const cart = await readyCart();
    const config = configWith(portAnswering(null));
    await applyDiscount(db, config, { cartId: cart.id, code: 'welcome10', now: 1_000 });
    asked = [];

    await freezeCheckout(db, catalog, config, { cartId: cart.id });

    expect(asked).toEqual([{ code: 'WELCOME10', currency: CURRENCY }]);
  });

  it('carries the code onto the frozen cart row, for the order to inherit', async () => {
    const cart = await readyCart();
    const config = configWith(portAnswering(null));
    await applyDiscount(db, config, { cartId: cart.id, code: 'WELCOME10', now: 1_000 });

    await freezeCheckout(db, catalog, config, { cartId: cart.id });

    // `checkout.completed` copies this across to `shop_orders`, where the
    // capture reads it — Orders may not read Cart's tables (contract §2).
    expect(await storedCode(cart.id)).toBe('WELCOME10');
  });
});
