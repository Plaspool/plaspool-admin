/**
 * `POST /api/shop/checkout/preview` over HTTP (admin#100 Part A, storefront#112).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THROUGH A REAL `createApp()`, and CLAUDE.md §2 says why in one line: a test
 * app that registers its own dependencies hides a missing composition root.
 * `GET /api/shop/orders` 401'd every caller in production while its suite
 * passed, because production registered no resolver and the test app did. This
 * route is money-adjacent — it is the number a shopper decides on — so the
 * first thing pinned here is that the ROUTE THE DEPLOYMENT SERVES answers.
 *
 * AND THE CORS HEADERS ARE ASSERTED ON, NOT INFERRED FROM BEHAVIOUR. Three
 * separate routes in this codebase have shipped without
 * `Access-Control-Allow-Credentials` and silently done nothing in a browser
 * while every behavioural test passed. The wildcard preflight in `routes/index.ts`
 * covers this path by construction; the assertion below is what would notice if
 * that ever stopped being true.
 *
 * THE INJECTED HALF USES `standaloneShop`, because `AppDeps` has no seam for a
 * redemption port and mounting a second cart router into the real app would
 * lose the race with the app's own mount (see `test/standalone.ts`). The rules
 * themselves are proved in `checkout/preview.test.ts` and
 * `server/marketing/redemption/port.test.ts`; what is unproven until here is
 * that the ROUTE carries the port's answer onto the wire intact.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from '../test/harness';
import { standaloneShop } from '../test/standalone';
import { fakeCatalog } from '../test/fake-catalog';
import { httpClient, json, TEST_ORIGIN } from '../../../test/http';
import { CART_COOKIE } from '../identity/cookies';
import { addLine, createCart } from '../cart/repo';
import { createCustomer } from '../identity/customers';
import { putAddresses, setShipping } from '../checkout/repo';
import { seedSellable } from '../../catalog/test/catalog-harness';
import { SHOP_CURRENCY } from '../../currency';
import type { CheckoutConfig } from '../checkout/repo';
import type { ShippingZone } from '../checkout/shipping';
import type { HttpClient } from '../../../test/http';
import type { TestCtx } from '../test/harness';
import type {
  PointsRedemptionPort,
  RedemptionQuote,
} from '../../../../shared/marketing/redemption';

let ctx: TestCtx;
let client: HttpClient;
let tee: { id: string; productId: string };

const CURRENCY = SHOP_CURRENCY;

const LAGOS = {
  name: 'A Shopper',
  line1: '1 Broad Street',
  city: 'Lagos',
  region: 'Lagos',
  countryCode: 'NG',
};

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_inventory_holds CASCADE`);
  tee = (
    await seedSellable(ctx.db, ctx.users.owner, {
      title: 'Navy Tee',
      onHand: 10,
      amount: 1999,
      currency: CURRENCY,
    })
  ).variant;
  client = httpClient(ctx.db);
});

/** A cart at the point the summary is on screen: lines, address, shipping. */
async function readyCart() {
  await client.post('/api/shop/cart');
  await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 2 });
  await client.request('/api/shop/checkout/addresses', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shipping: LAGOS }),
  });
  await client.request('/api/shop/checkout/shipping', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: 'ship_lagos_standard' }),
  });
}

interface PreviewBody {
  totals: { grandTotal: { amount: number }; adjustments: unknown[] };
  redemption: { pointsApplied: number; discountMinor: number; balanceAfter: number } | null;
}

describe('the route the deployment actually serves', () => {
  it('prices the caller’s cart, and agrees with the freeze that follows it', async () => {
    await readyCart();

    const previewed = await client.post('/api/shop/checkout/preview', {});
    expect(previewed.status).toBe(200);
    const preview = await json<PreviewBody>(previewed);

    const frozen = await client.post('/api/shop/checkout/freeze');
    expect(frozen.status).toBe(200);
    const freeze = await json<{ totals: unknown }>(frozen);

    // The acceptance criterion of admin#100, over the wire rather than in the
    // repo: no path where the previewed total differs from the frozen one.
    expect(preview.totals).toEqual(freeze.totals);
  });

  it('carries the credentialed CORS headers, which no behaviour would reveal', async () => {
    await readyCart();

    const res = await client.post('/api/shop/checkout/preview', {}, {
      headers: { Origin: TEST_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('freezes nothing — the totals are still unreadable and the freeze still works', async () => {
    await readyCart();

    // ASSERTED, not merely issued: an unregistered route would 404 here and
    // every assertion below would then pass while proving nothing at all.
    expect((await client.post('/api/shop/checkout/preview', {})).status).toBe(200);

    // `GET /checkout/totals` reads the frozen column and 404s when it is null.
    // A preview that had frozen the cart would answer 200 here.
    expect((await client.get('/api/shop/checkout/totals')).status).toBe(404);
    // And the one-way door is still open, which it would not be on a cart the
    // preview had moved to `converting`.
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(200);
  });

  it('can re-price a cart that has already been frozen', async () => {
    await readyCart();
    expect((await client.post('/api/shop/checkout/freeze')).status).toBe(200);

    // A shopper reloading the payment step is asking a question, not trying to
    // change anything. The freeze refuses a `converting` cart; a read must not.
    const res = await client.post('/api/shop/checkout/preview', {});
    expect(res.status).toBe(200);
  });
});

describe('what it refuses', () => {
  it('404s a caller with no cart at all', async () => {
    const res = await client.post('/api/shop/checkout/preview', {});
    expect(res.status).toBe(404);
    // THE BODY, not just the status. An unregistered route also answers 404 —
    // with no JSON body — so a status-only assertion here would have passed
    // before this route existed and gone on passing if it were ever deleted.
    expect(await json<{ error: string }>(res)).toMatchObject({ error: 'gone' });
  });

  it('409s an empty cart, naming the reason', async () => {
    await client.post('/api/shop/cart');

    const res = await client.post('/api/shop/checkout/preview', {});

    expect(res.status).toBe(409);
    const body = await json<{ error: string; reason: string }>(res);
    expect(body.error).toBe('precondition_failed');
    expect(body.reason).toBe('empty_cart');
  });

  it('409s a cart with no address, naming the reason', async () => {
    await client.post('/api/shop/cart');
    await client.post('/api/shop/cart/lines', { variantId: tee.id, qty: 1 });

    const res = await client.post('/api/shop/checkout/preview', {});

    expect(res.status).toBe(409);
    expect((await json<{ reason: string }>(res)).reason).toBe('no_shipping_address');
  });

  it('400s a body carrying a field the schema does not know', async () => {
    await readyCart();
    const res = await client.post('/api/shop/checkout/preview', { redeemPoint: 250 });
    expect(res.status).toBe(400);
  });

  it('400s a negative point request', async () => {
    await readyCart();
    const res = await client.post('/api/shop/checkout/preview', { redeemPoints: -1 });
    expect(res.status).toBe(400);
  });

  it('accepts the opt-in, and answers no redemption for a guest', async () => {
    await readyCart();
    const res = await client.post('/api/shop/checkout/preview', { redeemPoints: 250 });

    expect(res.status).toBe(200);
    // A guest cart has no `customerId`, so there is no wallet to quote against —
    // the field is accepted by the schema and answers null, which is what the
    // storefront renders as "no widget".
    expect((await json<PreviewBody>(res)).redemption).toBeNull();
  });
});

describe('the port’s answer, carried onto the wire', () => {
  const ZONES: readonly ShippingZone[] = [
    {
      id: 'domestic',
      label: 'Nigeria',
      countries: ['NG'],
      taxRateBps: 0,
      taxLabel: 'No VAT',
      shippingTaxable: false,
      options: [{ id: 'standard', label: 'Standard', amountMinor: 400 }],
      fallback: true,
    },
  ];

  const quote: RedemptionQuote = {
    adjustment: {
      code: 'points_redemption',
      label: '250 Spool Points redeemed',
      amount: { amount: -500, currency: CURRENCY },
    },
    points: 250,
    balanceAfter: 1_000,
  };

  const port: PointsRedemptionPort = {
    async quote() {
      return quote;
    },
    redeem() {
      throw new Error('a preview must never redeem');
    },
    release() {
      throw new Error('a preview must never release');
    },
  };

  it('reports the points APPLIED, the discount as a positive number, and the balance', async () => {
    const catalog = fakeCatalog([
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
    const config: CheckoutConfig = { zones: ZONES, storeCurrency: CURRENCY };

    const customer = await createCustomer(ctx.db, { email: 'shopper@example.test' });
    const cart = await createCart(ctx.db, { currency: CURRENCY, customerId: customer.id });
    await addLine(ctx.db, { cartId: cart.id, variantId: 'var_tee', qty: 2 });
    await putAddresses(ctx.db, config, {
      cartId: cart.id,
      shipping: { ...LAGOS, line2: null, postalCode: null, phone: null },
      billing: null,
    });
    await setShipping(ctx.db, config, { cartId: cart.id, optionId: 'standard' });

    const wired = standaloneShop(ctx.db, {
      catalog,
      zones: ZONES,
      storeCurrency: CURRENCY,
      redemption: () => port,
    });
    const res = await wired.request('/checkout/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${CART_COOKIE}=${cart.id}` },
      body: JSON.stringify({ redeemPoints: 5_000_000 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    // The shopper asked for five million; the rules allowed 250. Showing the
    // request back would be a lie the storefront cannot detect.
    expect(body.redemption).toEqual({
      pointsApplied: 250,
      discountMinor: 500,
      balanceAfter: 1_000,
    });
    expect(body.totals.adjustments).toHaveLength(1);
  });
});
