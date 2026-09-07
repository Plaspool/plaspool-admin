import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readQuery } from '../../../middleware/errors';
import { currentDb } from '../../../app-env';
import type { AppEnv } from '../../../app-env';
import { NotFoundError } from '../../../repo/errors';
import { SHOP_CURRENCY } from '../../currency';
import { getActiveProductBySlug } from '../products';
import { listVariantsWithPrices } from '../variants';
import { addOnPort } from './port';
import type { AddOnCartInput } from '../../../../shared/commerce/add-ons';

/**
 * `GET /api/shop/add-ons/for-product/:slug` — WHAT A PRODUCT PAGE NEEDS TO
 * OFFER THE BOX BEFORE THERE IS A CART TO PUT IT IN (owner, 2026-09-07).
 *
 * The exclusion control has to render beside Add to cart, and at that moment
 * `GET /api/shop/cart` cannot answer: a rule reading "1 to 4 items" does not
 * fit an empty cart, so the cart view correctly returns nothing. This route
 * asks the same evaluator a hypothetical question instead — "if somebody
 * bought `qty` of this product, what would be offered?" — and answers it with
 * the ordinary offer shape.
 *
 * IT IS AN ESTIMATE AND THE FIELD NAME SAYS SO. The real cart has other
 * products in it, an address, a discount code and a signed-in shopper, and any
 * of those can change which rule fits. NOTHING IS DECIDED HERE: the shopper's
 * answer is still recorded against the cart by
 * `PUT /api/shop/checkout/add-ons/:addOnId`, and the freeze reads the cart.
 * This is a shop window, not a till.
 *
 * PUBLIC AND COOKIELESS BY CONSTRUCTION, mounted beside `/products` above the
 * session middleware. Every fact it feeds the evaluator comes from the URL and
 * the catalogue — never from the caller's session — so two shoppers asking the
 * same question get the same answer, and there is nothing per-viewer here for
 * a shared cache to hand to the wrong person. That is the rule
 * `server/shop/reviews/public.ts` states at length and the one a later change
 * is most likely to break: DO NOT ADD "has this shopper already excluded it"
 * TO THIS RESPONSE. It belongs on the cart, below the session middleware,
 * where it already is.
 */
export const addOnPublicRoutes = new Hono<AppEnv>();

const Query = z
  .object({ qty: z.coerce.number().int().min(1).max(1000).optional() })
  .strict();

addOnPublicRoutes.get('/add-ons/for-product/:slug', async (c) => {
  const db = currentDb(c);
  const slug = pathParam(c, 'slug');
  const qty = readQuery(c, Query).qty ?? 1;

  const product = await getActiveProductBySlug(db, slug);
  if (!product) throw new NotFoundError(slug);

  /*
   * THE CHEAPEST PRICED VARIANT STANDS IN FOR THE CART LINE. A product page is
   * shown before a variant is chosen, and the rules that read money — "subtotal
   * at least X" — have to be given SOME number. The cheapest is the
   * conservative one: it can only make a subtotal rule fail to fit here that
   * would fit in the real cart, so this page under-promises rather than
   * offering something the checkout then withdraws.
   */
  const variants = await listVariantsWithPrices(db, product.id);
  const priced = variants.filter((v) => v.price !== null);
  const cheapest = priced.reduce<(typeof priced)[number] | null>(
    (best, v) => (best === null || v.price!.amount < best.price!.amount ? v : best),
    null,
  );
  const unitMinor = cheapest?.price?.amount ?? 0;
  const currency = cheapest?.price?.currency ?? SHOP_CURRENCY;

  const input: AddOnCartInput = {
    currency,
    lines: [
      {
        productId: product.id,
        variantId: cheapest?.id ?? product.id,
        sku: cheapest?.sku ?? '',
        qty,
        weightGrams: cheapest?.weightGrams ?? null,
        lineTotalMinor: unitMinor * qty,
      },
    ],
    subtotalMinor: unitMinor * qty,
    // No address, nobody signed in, no code: a product page knows none of them,
    // and inventing one would answer a question the shopper never asked.
    address: null,
    shippingOptionId: null,
    signedIn: false,
    hasDiscountCode: false,
    choices: null,
  };

  return c.json({ productId: product.id, qty, offers: await addOnPort.offers(db, input) });
});
