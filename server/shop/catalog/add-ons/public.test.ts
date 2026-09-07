import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../../test/harness';
import type { TestCtx } from '../../../test/harness';
import { httpClient, json } from '../../../test/http';
import type { HttpClient } from '../../../test/http';
import { seedProduct, seedVariant } from '../test/catalog-harness';
import { publishProduct, saveProduct } from '../products';
import { createAddOn } from './repo';

/**
 * `GET /api/shop/add-ons/for-product/:slug` — the product page's shop window
 * (0960).
 *
 * DRIVEN OVER HTTP, NOT THROUGH THE PORT. `port.test.ts` already pins the
 * evaluator against a hypothetical cart; what is unproven until here is the
 * half this route owns — that it stands a real product up as a cart line, that
 * it is reachable WITHOUT A SESSION, and that it says nothing per-viewer. That
 * last one is the property the reviews router pays for with its own file, and
 * an assertion is cheaper than remembering.
 */
let ctx: TestCtx;
let http: HttpClient;
const url = (slug: string, qty?: number) =>
  `/api/shop/add-ons/for-product/${slug}${qty === undefined ? '' : `?qty=${qty}`}`;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});
afterAll(() => ctx?.close());

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
  await ctx.db.execute(sql`DELETE FROM shop_products`);
});

/** A published product with two priced variants, the cheaper one at ₦280. */
async function pla(): Promise<string> {
  const product = await seedProduct(ctx.db, ctx.users.owner, { title: 'PLA Basic', category: 'Filament' });
  await seedVariant(ctx.db, product.id, ctx.users.owner, { sku: 'PLA-BLK', amount: 2_800_000 });
  await seedVariant(ctx.db, product.id, ctx.users.owner, { sku: 'PLA-RED', amount: 3_100_000 });
  await saveProduct(ctx.db, product.id, { slug: 'pla-basic' }, { actor: ctx.users.owner });
  const live = await publishProduct(ctx.db, product.id, ctx.users.owner);
  return live.slug!;
}

/** Packaging as the owner set it: ₦500 a box, in the price, out on carts of 1–4. */
const packaging = () =>
  createAddOn(
    ctx.db,
    {
      title: 'Packaging',
      priceMinor: 50_000,
      currency: 'NGN',
      status: 'active',
      rules: [
        {
          when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }],
          then: 'opt_out',
          basis: 'item',
        },
      ],
    },
    1,
  );

describe('GET /add-ons/for-product/:slug', () => {
  it('answers a signed-OUT caller, and the box is worth ₦500 for one item', async () => {
    const slug = await pla();
    await packaging();
    http.clearCookies();

    const res = await http.get(url(slug));
    expect(res.status).toBe(200);
    const body = await json<{ qty: number; offers: any[] }>(res);
    expect(body.qty).toBe(1);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      title: 'Packaging',
      mode: 'opt_out',
      basis: 'item',
      units: 1,
      unitAmount: { amount: 50_000, currency: 'NGN' },
      // Nothing has been taken out, so nothing has been saved yet.
      amount: { amount: 0, currency: 'NGN' },
    });
  });

  it('multiplies by qty, and stops offering past the rule’s ceiling', async () => {
    const slug = await pla();
    await packaging();

    const four = await json<{ offers: any[] }>(await http.get(url(slug, 4)));
    expect(four.offers[0].units).toBe(4);
    /* Four boxes are worth ₦2,000 — the number the product page prints beside
       "take them out". It is not charged: `amount` is still 0 until declined. */
    expect(four.offers[0].unitAmount.amount * four.offers[0].units).toBe(200_000);

    const five = await json<{ offers: any[] }>(await http.get(url(slug, 5)));
    expect(five.offers).toEqual([]);
  });

  it('NEVER carries a choice — the answer lives on the cart, not here', async () => {
    const slug = await pla();
    await packaging();
    /* Signed in, and with a choice recorded elsewhere, this response must look
       identical to the signed-out one. A per-viewer field on a public route is
       one shopper's state handed to another (threat T6). */
    await http.signIn({ email: 'owner@test.local' });
    const signedIn = await json<{ offers: any[] }>(await http.get(url(slug)));
    http.clearCookies();
    const signedOut = await json<{ offers: any[] }>(await http.get(url(slug)));
    expect(signedIn).toEqual(signedOut);
    expect(signedIn.offers[0].choice).toBe(null);
  });

  it('a draft add-on is not a shop window, and an unknown product is a 404', async () => {
    const slug = await pla();
    await createAddOn(
      ctx.db,
      { title: 'Not live yet', priceMinor: 1000, currency: 'NGN', rules: [{ when: [], then: 'ask' }] },
      1,
    );
    expect((await json<{ offers: any[] }>(await http.get(url(slug)))).offers).toEqual([]);
    expect((await http.get(url('no-such-product'))).status).toBe(404);
  });

  it('refuses a qty query it does not define, rather than ignoring it', async () => {
    const slug = await pla();
    expect((await http.get(`/api/shop/add-ons/for-product/${slug}?qty=0`)).status).toBe(400);
    expect((await http.get(`/api/shop/add-ons/for-product/${slug}?surprise=1`)).status).toBe(400);
  });
});
