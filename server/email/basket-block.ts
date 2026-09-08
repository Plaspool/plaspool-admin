import { lineTable, type LineRow } from '../mail/brand';
import { textLines } from '../mail/transactional';
import { formatAmount } from '../shop/orders/mailer';
import { publicImageUrl } from '../repo/public-projection';
import type { Basket } from '../shop/admin/prospects';

/**
 * The `{{basket}}` block: a reader's own basket, drawn by THE SAME COMPONENT
 * THE ORDER EMAILS USE.
 *
 * `brand.ts`'s `lineTable` is already Outlook-safe (dimensions as attributes as
 * well as CSS), already decides that a line with no photograph renders no cell
 * rather than a grey placeholder, and is already the thing a customer has seen
 * on every order confirmation this shop has sent. Rebuilding it here would buy
 * a second table that looks nearly the same and drifts — CLAUDE.md §2's account
 * of the product CSV's two independent codecs is the same mistake wearing a
 * different name. `mail/transactional.ts`'s `textLines` is the same argument for
 * the plain-text row shape: it is what spells "2 × Enamel Mug", not "2 x Enamel
 * Mug", and every order email this shop has sent has said it that way since the
 * first version — a nudge that says "x" instead would be the one message in the
 * lifecycle that reads differently for no reason.
 *
 * MONEY IS `formatAmount`, NOT THE ADMIN'S ₦ FORMAT. `server/shop/orders/mailer.ts`
 * already prints "3000.00 NGN" on every receipt a customer receives; a shopper who
 * gets this nudge and later a receipt for the same basket must see one money
 * format, not two. CLAUDE.md §7's naira-symbol rule is about ADMIN SCREENS, and
 * `formatAmount`'s own header explains why it avoids `Intl.NumberFormat` — no
 * locale decision has been made, and ICU data differs across Node builds.
 *
 * ⚠️  EVERY FIELD GOING IN IS ESCAPED, BY `lineTable`/`esc`; THE ASSEMBLED
 *     MARKUP THEN GOES INTO THE MESSAGE UNESCAPED — see `TEMPLATE_BLOCKS` in
 *     `shared/email/variables.ts` for the whole of that security boundary. It
 *     only holds while this function's inputs come from the catalogue (via
 *     `basketFor`, never a request body) — a title, a SKU and option values
 *     an operator or a catalogue import typed, not anything a customer's
 *     request supplies directly to this function.
 *
 * `origin` IS THE ADMIN'S OWN ASSET ORIGIN, NOT THE STOREFRONT'S. Product
 * photographs are served from THIS deployment's `/api/public/images/…`,
 * unauthenticated — the storefront is a separate Worker that carries no such
 * route. Passing `storefrontOrigin()` here would build a link that 404s on
 * every image in the basket; pass the same origin `server/mail/brand.ts`'s
 * `assetOrigin()` and `server/shop/orders/mailer.ts`'s `storefrontAssetOrigin()`
 * already use for exactly this reason (`BRAND_ASSET_ORIGIN`, confusingly named
 * for what it is used for rather than what it is).
 */
export function basketBlock(basket: Basket, origin: string): { html: string; text: string } {
  const rows: LineRow[] = basket.lines.map((line) => ({
    title: line.title,
    sku: line.sku,
    qty: line.qty,
    amount: formatAmount(line.lineMinor, basket.currency),
    imageUrl: line.imageId ? `${origin}${publicImageUrl(line.imageId)}` : null,
  }));
  const total = basketTotal(basket);

  return {
    html: lineTable(rows, [{ label: 'Basket total', amount: total, strong: true }]),
    /*
     * THE TOTAL IS APPENDED HERE, NOT LEFT TO `{{basket_total}}` ALONE. The HTML
     * table above always carries a "Basket total" footer row, because a table
     * with lines and no total reads as unfinished; the text part must not read
     * differently from the html part of the same message. A template author who
     * ALSO writes `{{basket_total}}` in the body text gets it twice — the same
     * trade `order_lines`' own `Total` footer makes in `mailer.ts`'s baseValues,
     * where the risk is the opposite: nothing guarantees a template mentions the
     * total anywhere else at all.
     */
    text: `${textLines(rows)}\nBasket total: ${total}`,
  };
}

/** `{{basket_total}}`: this basket's total, in the same money format every
 *  receipt this shop already sends — see `basketBlock`'s header. */
export function basketTotal(basket: Basket): string {
  return formatAmount(basket.totalMinor, basket.currency);
}
