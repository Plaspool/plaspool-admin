/**
 * The `{{basket}}` block, and the one boundary that matters about it: every
 * field going in is escaped by `lineTable`/`esc`, and the assembled markup then
 * goes into the message unescaped. `Mug <3` has reached this code path in
 * production, and these tests use the sharper shape of the same problem — a
 * title carrying an `<img onerror>` payload — because a real product title is
 * exactly this kind of field: typed by an operator, never by the customer this
 * mail goes out to.
 */
import { describe, expect, it } from 'vitest';
import { basketBlock, basketTotal } from './basket-block';
import { assetOrigin } from '../mail/brand';
import { formatAmount } from '../shop/orders/mailer';
import type { Basket, BasketLine } from '../shop/admin/prospects';

/**
 * One basket, one line, every field a plausible catalogue value — override
 * whichever the test is about. `lineMinor` and `totalMinor` are DERIVED from
 * `unitMinor`/`qty` rather than passed separately, so a test that overrides one
 * of those cannot leave the fixture's own arithmetic wrong.
 */
function fixture(overrides: Partial<BasketLine> = {}): Basket {
  const unitMinor = overrides.unitMinor ?? 150_000;
  const qty = overrides.qty ?? 2;
  const line: BasketLine = {
    variantId: 'var_1',
    productId: 'prod_1',
    title: 'PLA Basic',
    optionValues: { Colour: 'Black' },
    sku: 'PLA-BASIC-BLK',
    qty,
    unitMinor,
    lineMinor: unitMinor * qty,
    imageId: 'img_1',
    ...overrides,
  };
  return {
    cartId: 'cart_1',
    status: 'open',
    currency: 'NGN',
    updatedAt: 1_725_000_000_000,
    expiresAt: null,
    lines: [line],
    totalMinor: line.lineMinor,
    discountCode: null,
    addOnChoices: null,
    redemptionPoints: null,
  };
}

describe('basketBlock', () => {
  it('escapes a product title into the HTML block and leaves the text part alone', () => {
    // `Mug <3` has reached this code path in production. An <img onerror> is the
    // same shape with a payload: a title is a field an operator typed, and the
    // block is the ONE place this renderer inserts markup unescaped.
    const basket = fixture({ title: 'Mug <img src=x onerror=alert(1)>' });
    const block = basketBlock(basket, 'https://admin.plaspool.com');
    expect(block.html).not.toContain('<img src=x');
    expect(block.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(block.text).toContain('Mug <img src=x onerror=alert(1)>');
    expect(block.text).not.toContain('&lt;');
    expect(block.text).not.toContain('&amp;');
  });

  it('escapes an ampersand and quotes too, not only angle brackets', () => {
    // The production title above never had a `&`, `"` or `'` in it — this closes
    // that gap. `esc()` handles all five characters; this proves the block
    // actually calls it rather than happening to pass the one case already seen.
    const basket = fixture({ title: `Mug & Bowl "Set" <o'clock>` });
    const block = basketBlock(basket, 'https://admin.plaspool.com');
    expect(block.html).toContain('Mug &amp; Bowl &quot;Set&quot; &lt;o&#39;clock&gt;');
    expect(block.html).not.toContain(`<o'clock>`);
    expect(block.text).toContain(`Mug & Bowl "Set" <o'clock>`);
  });

  it('never puts a table in the text part', () => {
    // The text part has a completely different shape from the html — it is not
    // the html with the tags stripped out, and it must carry no markup at all.
    const block = basketBlock(fixture(), 'https://admin.plaspool.com');
    expect(block.text).not.toContain('<table');
    expect(block.text).not.toContain('<td');
  });

  it('builds an ABSOLUTE image URL from the sending origin, never a relative one', () => {
    const block = basketBlock(fixture({ imageId: 'img_1' }), 'https://admin.plaspool.com');
    expect(block.html).toContain('https://admin.plaspool.com/api/public/images/img_1');
  });

  it('defaults the image origin to the admin asset origin when none is given', () => {
    /*
     * The bug this guards: `basketBlock(basket, storefrontOrigin())` type-checks
     * perfectly and 404s every photograph in the basket, silently, because the
     * storefront is a separate Worker that carries no `/api/public/images/…`
     * route. Calling with no third argument at all must resolve to the SAME
     * origin `assetOrigin()` itself returns — asserted against that function's
     * own return value, not a hardcoded literal, so this stays true whether or
     * not BRAND_ASSET_ORIGIN is set in whatever environment runs it.
     */
    const block = basketBlock(fixture({ imageId: 'img_1' }));
    expect(block.html).toContain(`${assetOrigin()}/api/public/images/img_1`);
  });

  it('still accepts an explicit origin, which wins over the default', () => {
    // The parameter stays specifically so a test — or a future caller with a
    // genuine reason — can supply a different origin and have it win.
    const block = basketBlock(fixture({ imageId: 'img_1' }), 'https://explicit.test');
    expect(block.html).toContain('https://explicit.test/api/public/images/img_1');
    expect(block.html).not.toContain(assetOrigin());
  });

  it('renders no image cell at all for a line with no photograph', () => {
    const block = basketBlock(fixture({ imageId: null }), 'https://x.test');
    // brand.ts's `thumb` returns '' rather than a grey placeholder: a placeholder
    // is indistinguishable from an image that failed to load.
    expect(block.html).not.toContain('/api/public/images/');
  });

  it("prints the shop's own money format, not the admin's naira symbol", () => {
    /*
     * CORRECTED FROM THE BRIEF: every customer-facing order email already uses
     * `formatAmount` ("3000.00 NGN"), and a shopper who gets this nudge and then
     * a receipt for the same basket must see one money format. The admin's ₦
     * rule (CLAUDE.md §7, PRs #120/#121) is about ADMIN SCREENS, not customer
     * mail. `server/shop/currency.ts` exports no `formatMoney` at all — checked
     * before writing this.
     */
    const basket = fixture({ unitMinor: 300_000, qty: 1 });
    const block = basketBlock(basket, 'https://x.test');
    expect(block.html).toContain('3000.00 NGN');
    expect(block.text).toContain('3000.00 NGN');
    expect(block.html).not.toContain('₦');
    expect(block.text).not.toContain('₦');
  });

  it("prices a line from its OWN lineMinor, never recomputed as qty × unit", () => {
    // `basketFor` always sets lineMinor = unitMinor * qty today, but that is a
    // property of the CALLER, not something basketBlock is entitled to assume —
    // shop_cart_lines stores no price at all (server/shop/cart/schema.ts fails a
    // test if one is ever added), so lineMinor is the only figure to trust. Set
    // the two to disagree here to prove the block reads the field rather than
    // re-deriving it.
    const basket = fixture({ unitMinor: 150_000, qty: 3, lineMinor: 400_000 });
    const block = basketBlock(basket, 'https://x.test');
    expect(block.html).toContain('4000.00 NGN'); // the line's own total
    expect(block.html).not.toContain('4500.00 NGN'); // NOT qty * unit
  });

  it('sums correctly across more than one line, in integer minor units', () => {
    const lineA: BasketLine = {
      variantId: 'var_a',
      productId: 'prod_a',
      title: 'PLA Basic',
      optionValues: {},
      sku: 'PLA-A',
      qty: 2,
      unitMinor: 150_000,
      lineMinor: 300_000,
      imageId: null,
    };
    const lineB: BasketLine = {
      variantId: 'var_b',
      productId: 'prod_b',
      title: 'PLA Silk',
      optionValues: {},
      sku: 'PLA-B',
      qty: 1,
      unitMinor: 200_000,
      lineMinor: 200_000,
      imageId: null,
    };
    const basket: Basket = {
      cartId: 'cart_2',
      status: 'open',
      currency: 'NGN',
      updatedAt: 1_725_000_000_000,
      expiresAt: null,
      lines: [lineA, lineB],
      totalMinor: 500_000,
      discountCode: null,
      addOnChoices: null,
      redemptionPoints: null,
    };
    const block = basketBlock(basket, 'https://x.test');
    expect(block.html).toContain('PLA Basic');
    expect(block.html).toContain('PLA Silk');
    // 300 000 + 200 000 = 500 000 minor -> 5000.00, never a float artefact.
    expect(block.html).toContain('5000.00 NGN');
    expect(block.text).toContain('5000.00 NGN');
  });
});

describe('basketTotal', () => {
  it('is the basket total in formatAmount’s shape, matching the block’s own footer', () => {
    const basket = fixture({ unitMinor: 250_000, qty: 2 });
    expect(basket.totalMinor).toBe(500_000);
    expect(basketTotal(basket)).toBe(formatAmount(basket.totalMinor, basket.currency));
    expect(basketTotal(basket)).toBe('5000.00 NGN');
  });
});
