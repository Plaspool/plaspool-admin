import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestCtx } from '../../test/harness';
import { httpClient, json, type HttpClient } from '../../test/http';
import { seedSellable } from '../catalog/test/catalog-harness';
import { DEFAULT_STORE_CURRENCY } from './checkout/shipping';

/**
 * The store currency, asserted through the REAL composition root.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES, AND WHY NOTHING ELSE DID.
 *
 * `DEFAULT_STORE_CURRENCY` is `'GBP'` — scaffolding from this subsystem's spec,
 * which was written for a UK shop. Every other suite in this directory builds a
 * standalone router and seeds prices in that same default, so the cart and the
 * catalogue agreed in every test and disagreed only in production, where prices
 * are NGN.
 *
 * The symptom was not an error. `money()` refuses to add two currencies — the
 * right behaviour — so the totals engine simply produced **`preview: null`** on
 * every read: no subtotal, no shipping, no total, and a 200 response carrying
 * none of them. A cart that looks like it works and can total nothing.
 *
 * So this suite deliberately goes through `createApp()` rather than
 * `shopCartRoutes(deps)`. The bug was in the MOUNT — `server/shop/app.ts`
 * passing `catalog` and not `storeCurrency` — and a suite that injects its own
 * deps cannot see a mount defect by construction.
 * ═══════════════════════════════════════════════════════════════════════════
 */

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

interface CartView {
  cart: { currency: string };
  lines: { unit: { amount: number; currency: string } }[];
  preview: { subtotal: { amount: number; currency: string } } | null;
}

describe('the mounted cart uses the catalogue’s currency', () => {
  it('creates carts in NGN, not the subsystem default', async () => {
    const res = await http.post('/api/shop/cart');
    expect(res.status).toBe(201);
    const view = await json<CartView>(res);
    expect(view.cart.currency).toBe('NGN');
  });

  /* Stated as an inequality as well, so the day somebody changes the default
   * this file still says which value the SHOP chose and why. */
  it('does not silently inherit DEFAULT_STORE_CURRENCY', async () => {
    expect(DEFAULT_STORE_CURRENCY).toBe('GBP');
    const view = await json<CartView>(await http.post('/api/shop/cart'));
    expect(view.cart.currency).not.toBe(DEFAULT_STORE_CURRENCY);
  });

  /*
   * THE ASSERTION THAT WOULD HAVE CAUGHT IT. A line priced in one currency
   * inside a cart denominated in another produces a null preview — a 200 with no
   * totals in it, which no status code reveals.
   */
  it('totals a real NGN line instead of answering preview: null', async () => {
    const { variant } = await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Currency Spool',
      amount: 2_300_000,
      currency: 'NGN',
      onHand: 10,
    });

    http.clearCookies();
    await http.post('/api/shop/cart');
    await http.post('/api/shop/cart/lines', { variantId: variant.id, qty: 2 });

    const view = await json<CartView>(await http.get('/api/shop/cart'));
    expect(view.lines[0].unit.currency).toBe('NGN');
    expect(view.preview, 'a mixed-currency cart totals to null').not.toBeNull();
    expect(view.preview?.subtotal).toEqual({ amount: 4_600_000, currency: 'NGN' });
  });
});
