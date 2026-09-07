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
import type { AddOnOffer, AddOnPort } from '../../../../shared/commerce/add-ons';
import type { Db } from '../../../db/client';

let ctx: TestCtx;
let cartId: string;
const CURRENCY = 'GBP';
const ZONES: readonly ShippingZone[] = [
  { id: 'domestic', label: 'UK', countries: ['GB'], taxRateBps: 0, taxLabel: 'No VAT', shippingTaxable: false, options: [{ id: 'standard', label: 'Standard', amountMinor: 400 }], fallback: true },
];
const UK = { name: 'A Shopper', line1: '1 High Street', line2: null, city: 'London', region: null, postalCode: 'E1 6AN', countryCode: 'GB', phone: null };

const port: AddOnPort<Db> = {
  async offers(_db, input) {
    const offer: AddOnOffer = { id: 'ado_box', title: 'Gift box', description: null, imageUrl: null, price: { amount: 1500, currency: CURRENCY }, unitAmount: { amount: 1500, currency: CURRENCY }, units: 1, basis: 'order', amount: { amount: 1500, currency: CURRENCY }, mode: 'ask', choice: input.choices?.ado_box ?? null };
    return [offer];
  },
};
const catalog = () => fakeCatalog([{ variantId: 'var_tee', productId: 'prd_tee', sku: 'TEE', title: 'Tee', optionValues: {}, price: { amount: 2000, currency: CURRENCY }, onHand: 10 }]);
const deps = (withPort: boolean): Partial<ShopCartDeps> => ({ catalog: catalog(), zones: ZONES, storeCurrency: CURRENCY, ...(withPort ? { addOns: port } : {}) });
const shop = (withPort = true) => standaloneShop(ctx.db, deps(withPort));
const send = (withPort: boolean, path: string, method: string, body?: unknown) =>
  shop(withPort).request(path, { method, headers: { 'content-type': 'application/json', cookie: `${CART_COOKIE}=${cartId}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

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

describe('PUT /checkout/add-ons/:addOnId', () => {
  it('records the answer and answers the cart and the fresh offers', async () => {
    const res = await send(true, '/checkout/add-ons/ado_box', 'PUT', { choice: 'accepted' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cart: { id: string; revision: number; status: string }; addOns: AddOnOffer[] };
    /*
     * 5, not 4 — read off the first run against this repo's actual revision
     * counter and pinned: create (1) -> addLine (2) -> addresses (3) ->
     * shipping (4) -> this choice (5).
     */
    expect(body.cart).toMatchObject({ id: cartId, status: 'open', revision: 5 });
    expect(body.addOns[0]?.choice).toBe('accepted');
    const row = (await ctx.db.execute(sql`SELECT add_on_choices FROM shop_carts WHERE id = ${cartId}`)).rows[0];
    expect(row?.add_on_choices).toEqual({ ado_box: 'accepted' });
  });

  it('is typed about its refusals: a stale write and an id that is not on offer', async () => {
    const stale = await send(true, '/checkout/add-ons/ado_box', 'PUT', { choice: 'accepted', baseRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale_write' });
    const unknown = await send(true, '/checkout/add-ons/ado_nope', 'PUT', { choice: 'accepted' });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: 'add_on_not_offered' });
  });

  it('answers 501 when the deployment has no add-ons', async () => {
    const res = await send(false, '/checkout/add-ons/ado_box', 'PUT', { choice: 'accepted' });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: 'not_implemented' });
  });
});

/**
 * THE SCHEMA'S REFUSALS BELONG TO THE REAL APP, exactly as
 * `routes/discount.test.ts` documents it: `standaloneShop` deliberately gives
 * up the shared error handler (see `test/standalone.ts`), which is what turns
 * a Zod failure into a 400 — driven through the standalone router the same
 * bodies are 500s. Testing them there would have pinned the wrong number and
 * called it a pass. The path param is judged before `requireCart` runs (see
 * `checkout.ts`), so no cart needs to exist for either case below.
 */
describe('the body schema, through the app the deployment runs', () => {
  const put = (body: unknown) =>
    httpClient(ctx.db).put('/api/shop/checkout/add-ons/ado_box', body, {
      headers: { cookie: `${CART_COOKIE}=${cartId}` },
    });

  it('400s a choice the enum does not know', async () => {
    expect((await put({ choice: 'maybe' })).status).toBe(400);
  });

  it('400s a body carrying a field the schema does not know', async () => {
    expect((await put({ choice: 'accepted', extra: 1 })).status).toBe(400);
  });
});

describe('offers on the reads', () => {
  it('the preview carries the offers; the cart view carries them only when wired', async () => {
    const preview = await send(true, '/checkout/preview', 'POST', {});
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { addOns: AddOnOffer[] }).addOns.map((o) => o.id)).toEqual(['ado_box']);
    const wired = (await (await send(true, '/cart', 'GET')).json()) as { addOns?: AddOnOffer[] };
    expect(wired.addOns?.map((o) => o.id)).toEqual(['ado_box']);
    const bare = (await (await send(false, '/cart', 'GET')).json()) as { addOns?: AddOnOffer[] };
    expect(bare.addOns).toBeUndefined();
  });

  it('an accepted ask is inside the cart view preview total', async () => {
    await send(true, '/checkout/add-ons/ado_box', 'PUT', { choice: 'accepted' });
    const view = (await (await send(true, '/cart', 'GET')).json()) as { preview: { grandTotal: { amount: number }; addOnTotal: { amount: number } } };
    expect(view.preview.addOnTotal.amount).toBe(1500);
    expect(view.preview.grandTotal.amount).toBe(4000 + 1500);
  });
});
