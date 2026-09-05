/**
 * `POST` / `DELETE /api/shop/checkout/discount` over HTTP (admin#100 Part B,
 * storefront#113).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO THINGS ARE ROUTE-LEVEL AND CANNOT BE PROVED ANYWHERE ELSE:
 *
 * 1. **A rejected code answers a TYPED reason on the wire.** storefront#113 is
 *    explicit: "never a generic 'something went wrong'". The port produces the
 *    reason and the repo carries it; this is where it becomes a status code and
 *    a body, and where a regression would turn six actionable messages back into
 *    one useless one.
 * 2. **The capability flag.** The storefront will not ship a field that 404s, so
 *    the cart view advertises `discountCodesEnabled`. It is derived from whether
 *    the port is wired and nothing else — a constant `true` would be a promise
 *    the deployment might not keep.
 *
 * Through `standaloneShop` rather than a real `createApp()`, because `AppDeps`
 * has no seam for a discount port and mounting a second cart router into the
 * real app loses the race with the app's own mount (see `test/standalone.ts`).
 * The composition root is covered instead by `mount.test.ts` and by the wiring
 * assertion at the end of this file.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, resetShopTables } from '../test/harness';
import { standaloneShop } from '../test/standalone';
import { fakeCatalog } from '../test/fake-catalog';
import { httpClient } from '../../../test/http';
import { CART_COOKIE } from '../identity/cookies';
import { addLine, createCart } from '../cart/repo';
import { putAddresses, setShipping } from '../checkout/repo';
import type { CheckoutConfig } from '../checkout/repo';
import type { ShippingZone } from '../checkout/shipping';
import type { TestCtx } from '../test/harness';
import type { ShopCartDeps } from './deps';
import type { DiscountCodePort, DiscountRejection } from '../../../../shared/marketing/discounts';

let ctx: TestCtx;
let cartId: string;

const CURRENCY = 'GBP';

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

const TEN_PERCENT = {
  code: 'WELCOME10',
  label: '10% off',
  kind: 'percent',
  percentBps: 1000,
} as const;

function portAnswering(answer: DiscountRejection | null): DiscountCodePort {
  return {
    async validate() {
      return answer === null
        ? { ok: true, id: 'dsc_1', discount: TEN_PERCENT }
        : { ok: false, reason: answer };
    },
    redeem() {
      throw new Error('a route must never count a use; the capture does');
    },
  };
}

const catalog = () =>
  fakeCatalog([
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

/** `deps` for a shop with — or deliberately without — the discount port. */
function deps(port?: DiscountCodePort): Partial<ShopCartDeps> {
  return {
    catalog: catalog(),
    zones: ZONES,
    storeCurrency: CURRENCY,
    ...(port ? { discounts: () => port } : {}),
  };
}

const shop = (port?: DiscountCodePort) => standaloneShop(ctx.db, deps(port));

const send = (port: DiscountCodePort | undefined, method: string, body?: unknown) =>
  shop(port).request('/checkout/discount', {
    method,
    headers: { 'content-type': 'application/json', cookie: `${CART_COOKIE}=${cartId}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const storedCode = async () =>
  (await ctx.db.execute(sql`SELECT discount_code FROM shop_carts WHERE id = ${cartId}`)).rows[0]
    ?.discount_code ?? null;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await resetShopTables(ctx.db);
  const config: CheckoutConfig = { zones: ZONES, storeCurrency: CURRENCY };
  const cart = await createCart(ctx.db, { currency: CURRENCY, customerId: null });
  cartId = cart.id;
  await addLine(ctx.db, { cartId, variantId: 'var_tee', qty: 2 });
  await putAddresses(ctx.db, config, { cartId, shipping: UK, billing: null });
  await setShipping(ctx.db, config, { cartId, optionId: 'standard' });
});

describe('applying a code', () => {
  it('accepts it and answers the rule that was applied', async () => {
    const res = await send(portAnswering(null), 'POST', { code: 'welcome10' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discount: TEN_PERCENT });
    expect(await storedCode()).toBe('WELCOME10');
  });

});

/**
 * THE SCHEMA'S REFUSALS BELONG TO THE REAL APP, and this is not a preference.
 *
 * `standaloneShop` deliberately gives up the shared error handler (see
 * `test/standalone.ts`), and that handler is what turns a Zod failure into a
 * 400 — driven through the standalone router the same bodies are 500s. Testing
 * them there would have pinned the wrong number and called it a pass.
 *
 * Driving them through `createApp()` also proves the composition root wired the
 * discount port at all: without it these requests would answer 501 long before
 * the body was read, because the route checks the dependency first.
 */
describe('the schema, through the app the deployment runs', () => {
  const post = (body: unknown) =>
    httpClient(ctx.db).post('/api/shop/checkout/discount', body, {
      headers: { cookie: `${CART_COOKIE}=${cartId}` },
    });

  it('400s a body carrying a field it does not know', async () => {
    expect((await post({ coupon: 'WELCOME10' })).status).toBe(400);
  });

  it('400s a blank code, without troubling the port', async () => {
    expect((await post({ code: '   ' })).status).toBe(400);
  });

  it('400s a code longer than the column', async () => {
    expect((await post({ code: 'X'.repeat(65) })).status).toBe(400);
  });
});

describe('every rejection reaches the wire with its own reason', () => {
  const cases: DiscountRejection[] = [
    'not_found',
    'disabled',
    'expired',
    'not_started',
    'currency_mismatch',
    'limit_reached',
  ];

  for (const reason of cases) {
    it(`answers 409 ${reason}`, async () => {
      const res = await send(portAnswering(reason), 'POST', { code: 'ANYTHING' });

      expect(res.status).toBe(409);
      // `error` names the class of failure and `reason` says which one — the
      // same two-key shape the freeze's own refusals use, so a storefront reads
      // both refusals the same way.
      expect(await res.json()).toEqual({ error: 'discount_rejected', reason });
      expect(await storedCode()).toBeNull();
    });
  }
});

describe('removing a code', () => {
  it('clears it', async () => {
    await send(portAnswering(null), 'POST', { code: 'WELCOME10' });
    expect(await storedCode()).toBe('WELCOME10');

    const res = await send(portAnswering(null), 'DELETE');

    expect(res.status).toBe(204);
    expect(await storedCode()).toBeNull();
  });

  it('is idempotent — clearing nothing succeeds', async () => {
    // The storefront's control must not have to know whether a code is applied.
    const res = await send(portAnswering(null), 'DELETE');
    expect(res.status).toBe(204);
  });
});

describe('the capability flag', () => {
  it('is true on the cart view when the port is wired', async () => {
    const res = await shop(portAnswering(null)).request('/cart', {
      headers: { cookie: `${CART_COOKIE}=${cartId}` },
    });

    const body = (await res.json()) as { discountCodesEnabled: boolean };
    expect(body.discountCodesEnabled).toBe(true);
  });

  it('is FALSE when the port is not wired, so no field is rendered', async () => {
    // storefront#113: "The field must not render until the API advertises the
    // capability. Shipping an input that 404s is worse than shipping nothing."
    // A hardcoded `true` would pass the test above and fail this one.
    const res = await shop(undefined).request('/cart', {
      headers: { cookie: `${CART_COOKIE}=${cartId}` },
    });

    const body = (await res.json()) as { discountCodesEnabled: boolean };
    expect(body.discountCodesEnabled).toBe(false);
  });

  it('501s the apply route when the port is not wired', async () => {
    // The same discipline `deliverMagicLink` and the bridge exchange keep: a
    // route with no dependency answers "not implemented" rather than pretending.
    const res = await send(undefined, 'POST', { code: 'WELCOME10' });
    expect(res.status).toBe(501);
  });
});
