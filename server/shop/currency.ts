/**
 * This shop's currency, in one place.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SEPARATE FROM `DEFAULT_STORE_CURRENCY`, AND THE DISTINCTION IS THE POINT.
 *
 * `checkout/shipping.ts` exports `DEFAULT_STORE_CURRENCY = 'GBP'` as the cart
 * subsystem's own default — scaffolding from a spec written for a UK shop. It
 * is not wrong; it is simply not a statement about THIS shop.
 *
 * This constant is. The catalogue is priced in NGN (`shop_prices.currency`), so
 * the cart has to be denominated in NGN or the totals engine has two currencies
 * to add and refuses: `money()` will not sum across them, and the visible result
 * was **`preview: null`** on every cart read — a 200 response carrying no
 * subtotal, no shipping and no total. Measured in production.
 *
 * WHY A MODULE OF ITS OWN rather than a constant in `server/shop/app.ts`. The
 * test harness that seeds prices needs the same value, and it lives under
 * `server/shop/catalog/test/`. Importing the composition root from a catalog
 * helper would tie the two together for one string; a leaf module both can read
 * ties nothing to anything.
 *
 * ⚠️  CURRENCY IS NOT THE WHOLE STORE CONFIGURATION. `DEFAULT_SHIPPING_ZONES` is
 *     still United Kingdom / Europe / Rest of world with amounts in pence and a
 *     20% VAT line, which under NGN reads as ₦3.99 delivery. Shipping is only
 *     consulted at CHECKOUT and the cart's subtotal computes without it, so the
 *     cart is correct and checkout is not — real delivery rates and whether this
 *     shop collects Nigerian VAT are business facts rather than defaults to
 *     invent. Tracked for the checkout bundle.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const SHOP_CURRENCY = 'NGN';
