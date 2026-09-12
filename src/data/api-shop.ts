/**
 * The shop admin's half of the API — HANDOFF §2 A4/A5 and the catalog/orders
 * routes that already exist (§1.9).
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the reason
 * `api-categories.ts` gives above the same decision: `api.ts` is a file four
 * concurrent writers append to, and a file four writers append to is a file
 * that loses a block. Nothing here is a different convention — `apiFetch` is
 * `api.ts`'s own request function, so `credentials: 'include'`, the error
 * envelope and spec §8's status table are the shared ones and the shop cannot
 * grow its own dialect of them.
 *
 * NO DEXIE, deliberately (HANDOFF §3 B3). The sync layer exists because a
 * writer must be able to keep writing on a train; nobody fulfils an order
 * offline, and a read-through cache of stock levels is a cache that tells an
 * operator they have four of something they sold this morning. Every read here
 * is a plain fetch into component state.
 */
import { apiFetch, type RequestOptions } from './api';
import type { AnalyticsMoney } from './api-shop-analytics';
import { UNRENDERABLE } from './when';
import type { AddOnBasis, AddOnRule, AddOnStatus } from '../../shared/commerce/add-ons';

/**
 * `apiFetch` with the one method the blog's own API never uses.
 *
 * `PUT /api/shop/admin/variants/:id/price` is a PUT on purpose — catalog's
 * `routes.ts` explains that setting a price is idempotent in intent even though
 * it appends a history row — and `RequestOptions['method']` is a four-member
 * union written before the shop existed. Widening that union is an edit to
 * `api.ts`, which this run does not own, so the cast is here, once, where it can
 * be deleted the moment the union grows a fifth member.
 */
type ShopRequestOptions = Omit<RequestOptions, 'method'> & {
  method?: RequestOptions['method'] | 'PUT';
};

function shopFetch<T>(path: string, opts: ShopRequestOptions = {}): Promise<T> {
  return apiFetch<T>(path, opts as RequestOptions);
}

/** A path segment that cannot escape its position, whatever the id contains. */
const seg = (value: string): string => encodeURIComponent(value);

// ============================================================================
// MONEY
// ============================================================================

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE PLACE MINOR UNITS BECOME MAJOR UNITS AND BACK.
 *
 * Every amount on the wire is an INTEGER of minor units plus an ISO-4217 code
 * (HANDOFF §0.8, `shared/commerce/money.ts`). Every amount a person types is
 * major units — nobody enters a price as 1999. Those two facts meet exactly
 * here and nowhere else in `src/`, because the failure they produce when they
 * meet in three places is the one nobody notices: a screen that is out by a
 * factor of a hundred is obvious, and a screen that is out by one minor unit on
 * one row in a thousand is a customer dispute that cannot be reproduced.
 *
 * NO FLOAT TOUCHES A MONEY VALUE HERE, not even as an intermediate.
 * `1999 / 100` is 19.99 only in the sense that the nearest double prints that
 * way, and `19.99 * 100` is 1998.9999999999998. So the split and the join are
 * both done on DIGIT STRINGS, and the only numeric conversion is
 * `Number(<string of digits>)`, which is exact for every safe integer.
 *
 * `shared/commerce/money.ts` deliberately does NOT do this job: its own
 * `formatMoney` carries the comment "NOT for a customer-facing UI — that needs
 * `Intl.NumberFormat`, a locale, and the currency's real exponent (JPY has
 * none)". This is that function, with all three.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Thrown only for a value that is not an integer of minor units — a bug. */
export class MoneyShapeError extends Error {
  constructor(value: number) {
    super(`money must be an integer of minor units, got ${String(value)}`);
    this.name = 'MoneyShapeError';
  }
}

const DIGITS_BY_CURRENCY = new Map<string, number>();

/**
 * How many minor-unit digits a currency has: 2 for GBP, 0 for JPY, 3 for KWD.
 *
 * Asked of `Intl` rather than carried as a table, because a table of 180
 * exponents in a client bundle is a table that goes stale and that nobody
 * notices going stale. An unknown-but-well-formed code resolves to 2, which is
 * the ISO default and the right guess.
 */
export function currencyDigits(currency: string): number {
  const code = currency.toUpperCase();
  const cached = DIGITS_BY_CURRENCY.get(code);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    // `?? 2` is not defensive padding: `ResolvedNumberFormatOptions` types
    // `maximumFractionDigits` as optional because the field is absent for
    // `notation: 'compact'`. It is always present for a currency format.
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // A code `Intl` refuses outright (not three letters) is a server bug, not a
    // reason for a table of numbers to disappear off the screen.
  }
  DIGITS_BY_CURRENCY.set(code, digits);
  return digits;
}

/**
 * The formatter behind `formatMinor`, with the currency SIGN rather than its
 * code: `₦1,500.00`, not `NGN 1,500.00` (the owner's call for every table,
 * 2026-09-06). Under an English locale CLDR's plain `symbol` for the naira IS
 * the three-letter code — only `narrowSymbol` reaches the ₦ — while the
 * dollar and the pound render the same either way. An engine too old to know
 * `narrowSymbol` throws a RangeError, and gets the code form rather than a
 * screen with no money on it.
 */
function currencyFormat(currency: string, digits: number, locale?: string): Intl.NumberFormat {
  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  };
  try {
    return new Intl.NumberFormat(locale, { ...options, currencyDisplay: 'narrowSymbol' });
  } catch {
    return new Intl.NumberFormat(locale, options);
  }
}

/**
 * Minor units → what a person reads. `1990, 'GBP'` → `£19.90`, `150000, 'NGN'`
 * → `₦1,500.00`.
 *
 * THE TRAILING ZERO IS THE WHOLE REASON THIS IS NOT ONE LINE. `1990 / 100`
 * formatted by any code that thinks in numbers gives `£19.9`, and a price list
 * with `£19.9` in it looks like a typo to a customer and like rounding to an
 * accountant. The digits come from the integer, padded, and are spliced into
 * `Intl`'s own parts — so the grouping, the separators, the symbol and its
 * placement are the locale's, and the digits are ours and are exact.
 */
export function formatMinor(amount: number, currency: string, locale?: string): string {
  if (!Number.isSafeInteger(amount)) throw new MoneyShapeError(amount);
  const digits = currencyDigits(currency);
  const negative = amount < 0;

  // `padStart` guarantees at least one whole digit, so 5 minor units of a
  // 2-digit currency is "0" + "05" rather than "" + "05".
  const raw = String(Math.abs(amount)).padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits);
  const fraction = digits === 0 ? '' : raw.slice(raw.length - digits);

  const format = currencyFormat(currency, digits, locale);
  /*
   * A BigInt, so the whole part is formatted without ever becoming a double —
   * `Intl` formats BigInt exactly, at any magnitude.
   */
  const parts = format.formatToParts(negative ? -BigInt(whole) : BigInt(whole));
  const rendered = parts.map((p) => (p.type === 'fraction' ? fraction : p.value)).join('');

  /*
   * `-0n` is `0n`, so a value between -1 and 0 minor units of a whole unit —
   * -£0.50 — would come back unsigned. A refund of fifty pence rendered as a
   * charge of fifty pence is the worst rounding-shaped bug on this screen, so
   * the sign is put back by hand when `Intl` had no negative to sign.
   */
  if (negative && !parts.some((p) => p.type === 'minusSign')) return `-${rendered}`;
  return rendered;
}

/**
 * `formatMinor` MADE TOTAL, FOR DISPLAY AND FOR NOTHING ELSE. Never throws; a
 * value it cannot render comes back as `UNRENDERABLE`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE ARE TWO OF THESE, AND WHY THE THROWING ONE STAYS.
 *
 * `when.ts` makes a promise on behalf of the whole app — a value this app cannot
 * render becomes one odd-looking cell, never an error screen — and until this
 * function existed that promise covered dates and nothing else. The order list
 * renders `order.grandTotal` on every row; `formatMinor` throws
 * `MoneyShapeError` on anything that is not a safe integer; React escalates a
 * throw during render to the route's error boundary. So ONE broken total was
 * still the whole of `/shop/orders` gone — the same outage `when.ts` was written
 * after, one column across, and reachable the same way: an unchecked
 * `shopFetch<T>` naming a shape the server does not send.
 *
 * SO WHY NOT SIMPLY MAKE `formatMinor` TOTAL AND HAVE ONE FUNCTION? Because it
 * is not only a display function, and on its other callers a placeholder is the
 * worst answer available rather than the safe one. `refundPayment` and
 * `setVariantPrice` re-check with `MoneyShapeError` on the way OUT to the
 * server, and `majorPlaceholder` in `ShopOrders.tsx` seeds a refund box from
 * this formatter's own digits — a write path that quietly renders "––" instead
 * of refusing is a bug that reaches somebody's card rather than a bug that
 * reaches a screen, and the operator would have no signal either way. Total is
 * right for a cell and wrong for a form, so the two behaviours have two names
 * and every call site says which one it meant.
 *
 * BOTH GUARDS ARE LOAD-BEARING, not just the amount. `currencyDigits` already
 * swallows a code `Intl` refuses — but `formatMinor` then builds a SECOND
 * `Intl.NumberFormat`, this one with `style: 'currency'`, and THAT constructor
 * throws `RangeError: Invalid currency code` on the same value. Guarding the
 * amount alone would therefore have left the screen exactly as reachable, by a
 * row whose `currency` came back `undefined` rather than by one whose total did
 * — a repair that looks finished and is not, which is the most expensive kind.
 *
 * `locale` is NOT guarded, and does not need to be: it is this app's own literal
 * at every call site rather than a field off a payload, so there is no untrusted
 * value there to downgrade.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function safeFormatMinor(amount: unknown, currency: unknown, locale?: string): string {
  // `unknown` rather than `number`/`string` ON PURPOSE. Everything this guards
  // against is a field whose DECLARED type was already `number` and `string` —
  // taking them as declared here would make the guards unreachable to the type
  // checker and tempt the next reader to delete them as impossible.
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return UNRENDERABLE;
  // Three letters is what ISO 4217 allows and what `Intl` accepts; anything else
  // is a server bug, and this is the cell that reports it rather than the throw
  // that hides it.
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return UNRENDERABLE;
  return formatMinor(amount, currency, locale);
}

/**
 * Minor units → the digits a person types. `1990, 'GBP'` → `'19.90'`.
 *
 * `formatMinor`'s plain twin, and it lives here for the reason at the top of
 * this section: the split is done on DIGIT STRINGS, never on a float, so a
 * stepper that walks a price one unit at a time cannot drift. No symbol, no
 * grouping separators — the output goes back into an `<input>`, and a comma in
 * there is something `parseMajor` would then have to strip back out.
 */
export function plainMajor(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount)) throw new MoneyShapeError(amount);
  const digits = currencyDigits(currency);
  const raw = String(Math.abs(amount)).padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits);
  const fraction = digits === 0 ? '' : `.${raw.slice(raw.length - digits)}`;
  return `${amount < 0 ? '-' : ''}${whole}${fraction}`;
}

/** Why a typed amount was refused. One reason, one sentence, one place. */
export type MoneyRefusal =
  | 'empty'
  | 'shape'
  | 'precision'
  | 'range'
  | 'negative'
  | 'zero'
  | 'exceeds';

export type MoneyParse = { ok: true; minor: number } | { ok: false; reason: MoneyRefusal };

/**
 * What a person typed → minor units. `'19.90', 'GBP'` → `1990`.
 *
 * Grouping separators and spaces are stripped because they are what comes out
 * of a spreadsheet; the dot is the only separator with meaning, which is a
 * decision this app can make because its whole UI is in English and a comma
 * decimal would be ambiguous with the grouping it also has to accept.
 *
 * MORE DECIMAL PLACES THAN THE CURRENCY HAS IS A REFUSAL, NOT A ROUNDING.
 * `19.999` in a GBP price box is somebody who has lost track of what they are
 * typing, and silently storing £20.00 (or £19.99, depending on which way the
 * rounding went) is the app deciding a price on their behalf.
 */
export function parseMajor(input: string, currency: string): MoneyParse {
  const digits = currencyDigits(currency);
  const text = input.replace(/[\s,]/g, '');
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.startsWith('-')) return { ok: false, reason: 'negative' };

  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return { ok: false, reason: 'shape' };
  const whole = match[1];
  const fraction = match[2] ?? '';
  // `.` on its own matches the pattern and names no number.
  if (whole === '' && fraction === '') return { ok: false, reason: 'shape' };
  if (fraction.length > digits) return { ok: false, reason: 'precision' };

  // String concatenation, then ONE conversion. `Number('1990')` is exact.
  const minor = Number(`${whole}${fraction.padEnd(digits, '0')}` || '0');
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'range' };
  return { ok: true, minor };
}

/**
 * The same parse, held to what is actually refundable.
 *
 * `POST /shop/admin/payments/intents/:id/refunds` takes
 * `z.number().int().positive()` and the provider refuses anything above what is
 * left on the intent — so both bounds are checked here, in major units, while
 * the operator is still looking at the box. A refund refused by the server after
 * the confirm dialog has been agreed to is the same information arriving after
 * the decision instead of before it.
 */
export function parseRefund(input: string, currency: string, maxMinor: number): MoneyParse {
  const parsed = parseMajor(input, currency);
  if (!parsed.ok) return parsed;
  if (parsed.minor === 0) return { ok: false, reason: 'zero' };
  if (parsed.minor > maxMinor) return { ok: false, reason: 'exceeds' };
  return parsed;
}

/** The refusal as a sentence. Kept beside the parser so the two cannot drift. */
export function moneyRefusalMessage(
  reason: MoneyRefusal,
  currency: string,
  maxMinor?: number,
): string {
  const digits = currencyDigits(currency);
  switch (reason) {
    case 'empty':
      return 'Enter an amount.';
    case 'shape':
      return 'That is not an amount — digits and one decimal point only.';
    case 'precision':
      return digits === 0
        ? `${currency.toUpperCase()} has no decimal places.`
        : `${currency.toUpperCase()} has ${digits} decimal ${digits === 1 ? 'place' : 'places'}.`;
    case 'range':
      return 'That amount is too large to be handled exactly.';
    case 'negative':
      return 'Amounts here are never negative.';
    case 'zero':
      return 'A refund has to be more than nothing.';
    case 'exceeds':
      return maxMinor === undefined
        ? 'That is more than is left to refund.'
        : `That is more than the ${formatMinor(maxMinor, currency)} left to refund.`;
  }
}

// ============================================================================
// SHAPES
// ============================================================================

/**
 * Copied from the server's own types rather than imported from them.
 *
 * `server/shop/catalog/types.ts` says at length why `Product` lives in
 * catalog's tree and not in `shared/`: it is one subsystem's internal shape, and
 * putting it in the browser's compile surface would make it three other agents'
 * problem. That argument does not stop being true when the consumer is a React
 * screen — so these are the fields this screen reads, declared here, and a
 * server field this file does not name is a field this screen does not use.
 */

export type ProductStatus = 'draft' | 'active' | 'archived' | 'trash';
export type VariantStatus = 'active' | 'discontinued';

export interface ShopProduct {
  id: string;
  slug: string | null;
  title: string;
  /** A ProseMirror document. `unknown` here because only TipTap reads it. */
  description: unknown;
  status: ProductStatus;
  category: string;
  tags: string[];
  coverImageId: string | null;
  imageIds: string[];
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  deletedAt: number | null;
  /**
   * Hand-written search-listing copy (migration 0440). `null` means the
   * storefront falls back to the title / trimmed description. `''` never
   * arrives — the server normalises it to `null` on write.
   */
  seoTitle: string | null;
  seoDescription: string | null;
  /**
   * The card/summary line (migration 0580). `null` means "derive it" and is what
   * the editor shows as an EMPTY box — the derived text goes in the placeholder,
   * which is how "inherited" and "set" stay visually distinct. `''` never
   * arrives; the server normalises it to `null` on write.
   */
  overview: string | null;
  /** `summarise(description)`, maintained server-side. Read-only here: it is
   *  what the overview box renders as its placeholder. */
  overviewFallback: string;
  /** Whether the quantity ladder applies to this product (migration 0600). */
  bulkDiscountEnabled: boolean;
  authorId: string;
  /** The CAS token. Every save carries the revision it derived from. */
  revision: number;
}

export type AuditKind = 'stock' | 'price';

/** One change to a variant: what it was, what it became, who, and why. */
export interface AuditEntry {
  id: string;
  kind: AuditKind;
  occurredAt: number;
  variantId: string;
  sku: string | null;
  productId: string | null;
  productTitle: string | null;
  optionValues: Record<string, string>;
  /** `null` means no reason was recorded — which is true of every price written
   *  before migration 0009, and is not the same as an empty one. */
  reason: string | null;
  /** `null` for a price: `shop_prices` has no actor column, and guessing one
   *  would be a fact invented by the audit view. */
  actor: string | null;
  delta: number | null;
  onHand: number | null;
  amount: number | null;
  previousAmount: number | null;
  currency: string | null;
}

/**
 * WHAT A VARIANT WRITE ANSWERS WITH, WHICH IS LESS THAN WHAT A VARIANT READ DOES.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SPLIT IS THE SERVER'S, AND WIDENING IT BACK IS THE BUG.
 *
 * `server/shop/catalog/types.ts` declares `Variant` and `VariantWithPrice` as
 * two types on purpose, and `mapping.ts` has two mappers to match: `rowToVariant`
 * builds the thirteen fields below, `rowToVariantWithPrice` spreads it and adds the
 * four `ShopVariant` adds. Which one a route uses is not a detail — the extra
 * four come from LEFT JOINs onto `shop_prices` and `shop_inventory` and from an
 * EXISTS over `shop_order_lines`, none of which a write statement performs.
 * `POST /products/:id/variants`, `PATCH /variants/:id` and `DELETE /variants/:id`
 * all answer with `rowToVariant`.
 *
 * Declaring those three `Promise<ShopVariant>` was therefore a claim nothing
 * checks and nothing warns about: `shopFetch<T>` is an unchecked assertion, so
 * `everOrdered` off a freshly-patched variant is `undefined` — falsy — and
 * `everOrdered` is precisely the field that decides whether the panel offers
 * Delete at all. A caller that adopted a PATCH response into the row it was
 * already showing would turn "this has sold, archive only" into a Delete button
 * that answers 409, silently, on the variant it is least safe to be wrong about.
 *
 * IF A CALLER NEEDS THE PRICED SHAPE AFTER A WRITE IT MUST RE-READ. There is no
 * honest way to synthesise `price`, `available` or `everOrdered` from a write
 * response, and "carry the old ones over" is the same lie with more steps — a
 * write that changed nothing about stock still leaves the client asserting a
 * stock figure it was told at some earlier time. `listVariantsWithPrices` is the
 * one call that produces `ShopVariant`, because it is the one query that asks.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ShopVariantBase {
  id: string;
  productId: string;
  sku: string;
  optionValues: Record<string, string>;
  position: number;
  weightGrams: number | null;
  status: VariantStatus;
  createdAt: number;
  updatedAt: number;
  /**
   * The photograph of THIS option (migration 0009). `null` until one is set.
   *
   * The options in this store are colours, and a colour is the thing a picture
   * settles — the product cover can only show one of them.
   */
  imageId: string | null;
  /**
   * The colour code of this option (migration 0010) — `#8b5a2b`, lowercase.
   * `null` for anything that is not a colour or has not been given one. The
   * swatch the rail draws while a variant has no photograph yet.
   */
  colorHex: string | null;
  /**
   * The struck-through "was" price, minor units (migration 0400). `null` means
   * "not on sale". The storefront draws the line through it only when it
   * exceeds the current price — a value at or below the price is stored
   * honestly and simply never renders as a sale. Currency is the price row's.
   */
  compareAtMinor: number | null;
  /**
   * What the shop pays per unit, minor units (migration 0420). `null` means
   * "never recorded". ADMIN-ONLY: present here because this client only ever
   * speaks to admin routes — the storefront wire strips it server-side.
   */
  costMinor: number | null;
}

/**
 * A variant AS THE LIST ROUTE SENDS IT — the row above plus the three joins and
 * the one EXISTS that only `rowToVariantWithPrice` performs.
 *
 * `extends` rather than a second field list, so the thirteen shared members cannot
 * drift apart the way two copies of a shape in one file always eventually do.
 */
export interface ShopVariant extends ShopVariantBase {
  /** `null` is "created but never priced", which is a real state, not an error. */
  price: { amount: number; currency: string } | null;
  /** `null` is "no inventory row", which is not the same as "none left". */
  available: number | null;
  backorderable: boolean;
  /**
   * Whether any order has ever been placed for this variant (issue #18). Drives
   * whether the panel offers Delete at all — a variant that has sold can only
   * be archived, and the control does not appear to answer 409 about it.
   */
  everOrdered: boolean;
}

export interface ShopProductDetail extends ShopProduct {
  variants: ShopVariant[];
}

/** The patchable half. No `slug`, no `status` — both are server-authoritative. */
export interface ShopProductPatch {
  title?: string;
  description?: unknown;
  category?: string;
  tags?: string[];
  coverImageId?: string | null;
  imageIds?: string[];
  /** `null` or `''` clears back to "use the defaults"; absent leaves it alone. */
  seoTitle?: string | null;
  seoDescription?: string | null;
  /** `null` or `''` clears back to "derive it from the description". */
  overview?: string | null;
  /** Absent leaves it alone — a boolean has no "clear" spelling. */
  bulkDiscountEnabled?: boolean;
}

/** One rung of a quantity ladder (migration 0600). 10 000 bps is 100%. */
export interface BulkTier {
  minQty: number;
  percentBps: number;
}

/**
 * One scope's ladder as the editor reads it.
 *
 * `tiers` is what this scope STORES and `effective` is what actually applies —
 * different whenever `inherited` is true, which is exactly the distinction the
 * editor needs to grey the table and offer Override rather than guessing.
 */
export interface BulkTierSet {
  tiers: BulkTier[];
  inherited: boolean;
  effective: BulkTier[];
}

// ============================================================================
// ADD-ONS (spec 2026-09-06)
// ============================================================================
export type { AddOnBasis, AddOnCondition, AddOnMode, AddOnRule, AddOnStatus } from '../../shared/commerce/add-ons';

export interface ShopAddOn {
  id: string;
  title: string;
  description: string | null;
  imageId: string | null;
  priceMinor: number;
  currency: string;
  status: AddOnStatus;
  rules: AddOnRule[];
  position: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ShopAddOnInput {
  title: string;
  description?: string | null;
  imageId?: string | null;
  priceMinor: number;
  status?: AddOnStatus;
  rules: AddOnRule[];
  position?: number;
}
export type ShopAddOnPatch = Partial<ShopAddOnInput>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ProductLifecycleOp =
  | 'publish'
  | 'unpublish'
  | 'archive'
  | 'unarchive'
  | 'restore';

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'fulfilled'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export interface ShopOrder {
  id: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  /** All minor units, and all FROZEN at checkout — never recomputed. */
  subtotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  /** Σ add-on amounts, frozen. 0 for orders placed before add-ons. */
  addOnTotal: number;
  refundedTotal: number;
  status: OrderStatus;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  placedAt: number;
  paidAt: number | null;
  fulfilledAt: number | null;
  /** Every non-cancelled parcel delivered, and when the last one was. Derived
   *  server-side from the fulfilment rows the list does not return. */
  deliveredAt: number | null;
  cancelledAt: number | null;
  revision: number;
  checkoutId: string;
  paymentIntentId: string | null;
  /**
   * Where the order came from: the online checkout, or a sale somebody
   * recorded by hand (a payment link, a transfer, cash). OPTIONAL on purpose —
   * a response from before manual orders shipped has no key, and absent reads
   * as `'online'`, which is what every such order was.
   */
  source?: OrderSource;
}

export type OrderSource = 'online' | 'manual';

export interface ShopOrderLine {
  id: string;
  lineNo: number;
  variantId: string;
  sku: string;
  title: string;
  optionValues: Record<string, string>;
  qty: number;
  unitAmount: number;
  lineTotal: number;
  /** Covered by fulfilments that have not been cancelled. */
  fulfilledQty: number;
}

export type FulfillmentStatus = 'pending' | 'shipped' | 'delivered' | 'cancelled';

export type CourierProviderId = 'manual' | 'fez' | 'terminal';
export type CourierState =
  | 'draft' | 'booked' | 'picked_up' | 'in_transit' | 'delivered'
  | 'returned' | 'cancelled' | 'failed' | 'unknown';

export interface ShopFulfillment {
  id: string;
  orderId: string;
  status: FulfillmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  revision: number;
  lines: { id: string; orderLineId: string; qty: number }[];
  /** Courier booking (migration 0980) — all absent on responses from before couriers shipped; read as null. */
  provider?: Exclude<CourierProviderId, 'manual'> | null;
  providerRef?: string | null;
  providerStatus?: string | null;
  courierState?: CourierState | null;
  trackingUrl?: string | null;
  labelUrl?: string | null;
  providerCostMinor?: number | null;
  providerSyncedAt?: number | null;
  providerLastError?: string | null;
}

/**
 * The delivery-courier surface (`server/shop/logistics/*`, migration 0980).
 *
 * `GET /shop/logistics/provider` is NOT under `BASE` — every signed-in role may
 * ask which courier is switched on (the route is `requireAuth()` only, so the
 * teammate packing a parcel gets an answer). Everything else here sits under
 * `/shop/admin/logistics/*` (the `settings` permission) or
 * `/shop/admin/fulfillments/:id/courier/*` (booking a parcel, gated `orders`).
 */
export interface ShopCourierProvider { provider: CourierProviderId; label: string }

export interface ShopShipFrom {
  name: string; phone: string; email?: string; line1: string; line2?: string;
  city: string; region: string; postalCode: string; countryCode: 'NG';
}
export interface ShopCourierPackaging { name: string; lengthCm: number; widthCm: number; heightCm: number; weightKg: number }
export interface ShopCourierProviderStatus {
  /** A parcel can be BOOKED with this courier: the credentials it books with are on the server. */
  configured: boolean;
  /**
   * This courier's callbacks can be VERIFIED here — a different question, and
   * for Fez a different credential (`FEZ_SECRET_KEY`, absent from
   * `configured`). `configured && !webhookReady` is a shop that can send
   * parcels and can never hear what happened to them.
   */
  webhookReady: boolean;
  environment: 'sandbox' | 'live';
  webhookUrl: string;
}
export interface ShopCourierWebhookRow {
  id: string; provider: 'fez' | 'terminal'; providerRef: string | null; rawStatus: string | null;
  verified: boolean; applied: 'applied' | 'ignored' | 'unmatched' | 'rejected'; receivedAt: number;
}
export interface ShopCourierSettings {
  provider: CourierProviderId;
  shipFrom: ShopShipFrom | null;
  packaging: ShopCourierPackaging;
  revision: number;
  /** Rides along on every settings read (`settingsView` in the courier routes); tolerated, not yet shown. */
  updatedAt: number;
  providers: { fez: ShopCourierProviderStatus; terminal: ShopCourierProviderStatus };
  variantsMissingWeight: number;
  variantsTotal: number;
  recentWebhooks: ShopCourierWebhookRow[];
}
export interface ShopCourierSettingsPatch {
  expectedRevision: number;
  provider?: CourierProviderId;
  shipFrom?: ShopShipFrom | null;
  packaging?: ShopCourierPackaging;
}
/**
 * What `POST /shop/admin/logistics/places/refresh` answers — the courier's own
 * lists of states and the places inside them, re-fetched and cached.
 *
 * `cities` IS EVERY PLACE ACROSS EVERY STATE, not the number of states that
 * have any, and it is `0` for a courier that checks no place names at all
 * (Fez). Zero and "none acceptable" are not the same claim, which is why the
 * screen says the two differently.
 */
export interface ShopCourierPlaces {
  country: string;
  provider: CourierProviderId;
  regions: number;
  cities: number;
  updatedAt: number;
}

/**
 * What `POST /shop/admin/logistics/exports/refresh` answers - where the courier
 * carries to outside Nigeria, re-fetched and cached (migration 1080).
 *
 * `maxKg` IS THE NUMBER THAT DECIDES WHETHER THIS IS A REAL CHANNEL. It is the
 * heaviest ceiling any bracket the courier publishes carries, and `null` when
 * none publishes one. A courier topping out at 2 kg can send one spool abroad
 * and no more, which the screen has to say out loud rather than leave an owner
 * to discover one refused checkout at a time.
 *
 * `unmapped` NAMES THE COURIER PUBLISHED THAT WE COULD NOT TURN INTO A COUNTRY.
 * Those rows are cached and offered to nobody, so an operator seeing a country
 * that never appears has somewhere to look instead of a mystery.
 */
export interface ShopCourierExports {
  provider: CourierProviderId;
  destinations: number;
  weights: number;
  unmapped: string[];
  maxKg: number | null;
  updatedAt: number;
}

export interface ShopCourierOption {
  id: string; carrier: string; label: string; amountMinor: number; currency: 'NGN'; eta?: string; pickupEta?: string;
}
export interface ShopCourierMissingWeight { orderLineId: string; variantId: string; sku: string; title: string }
export interface ShopCourierQuote {
  provider: 'fez' | 'terminal';
  providerLabel: string;
  weightKg: number;
  quoteRef: string | null;
  note: string | null;
  options: ShopCourierOption[];
  missingWeights: ShopCourierMissingWeight[];
}

/**
 * What `POST …/courier/refresh` answers (`server/shop/logistics/routes.ts`).
 * `changed` and `transitioned` ride along with the parcel on purpose — the
 * screen can say "nothing new" instead of repainting an identical row and
 * leaving the operator to wonder whether the button did anything.
 */
export interface ShopCourierRefresh {
  fulfillment: ShopFulfillment;
  changed: boolean;
  transitioned: 'shipped' | 'delivered' | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COURIER DIAGNOSTICS — `POST /shop/admin/logistics/diagnostics`.
 *
 * The four questions that used to need a throwaway script: are the credentials
 * good, will this courier price this address, can this admin hear a callback,
 * and will the courier actually send one.
 *
 * A DISCRIMINATED UNION because the four checks take four different bodies and
 * the server's Zod schema is `.strict()` — an extra key is a permanent 400, so
 * a single wide optional-everything shape would let a caller assemble one that
 * can never succeed and only find out at runtime.
 *
 * `provider_simulate` is `terminal` ALONE, mirroring `z.literal('terminal')` on
 * the server: Fez has no simulator, so asking for one is a malformed request
 * rather than an unlucky one, and the type says so before the request is made.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export type ShopCourierDiagnosticRequest =
  | { check: 'connection'; provider: 'fez' | 'terminal' }
  | {
      check: 'quote';
      provider: 'fez' | 'terminal';
      /** A made-up destination. No name and no phone: this check is about an ADDRESS —
       *  the recipient is synthesised on the server from the shop's own ship-from. */
      to: { line1: string; city: string; region: string; postalCode?: string };
      /** Defaults to 1000 g on the server. */
      weightGrams?: number;
      }
  | { check: 'webhook_self_test'; provider: 'fez' | 'terminal' }
  | { check: 'provider_simulate'; provider: 'terminal'; shipmentId: string };

/**
 * One envelope for all four checks, and **`ok: false` arrives with a 200**.
 *
 * A courier refusing is what the operator pressed the button to find out, so it
 * is an answer rather than a failure: `summary` then carries the courier's own
 * words VERBATIM (paraphrasing "Invalid city, please select a city from the
 * list of cities" throws away the finding) and `detail.accepted` carries the
 * names it said it would take.
 *
 * `detail` IS DELIBERATELY UNTYPED. It is a different shape per check and per
 * courier, every field of it is optional in practice, and the screen reads it
 * defensively — a strict shape here would make an unfamiliar-but-useful answer
 * a client crash instead of a rendered finding.
 */
export interface ShopCourierDiagnosticResult {
  check: ShopCourierDiagnosticRequest['check'];
  ok: boolean;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface ShopTimelineEntry {
  id: string;
  type: string;
  message: string;
  occurredAt: number;
  actorId: string | null;
  /** The staff member's name, on the admin view only. */
  actorName?: string | null;
}

/**
 * One row of the order's transactional outbox.
 *
 * `sentAt` MEANS "HANDED TO THE MAILER" AND NOT "DELIVERED", and until
 * HANDOFF §2 A6 wires `registerOrdersDeps` to the real Resend mailer the mailer
 * is `LoggingMailer` — it records the message and sends nothing. The screen has
 * to say so, because "sent 3 days ago" against an email nobody received is the
 * single most misleading thing this surface could claim.
 */
export interface ShopEmailIntent {
  id: string;
  orderId: string;
  kind: string;
  to: string;
  subject: string;
  body: string;
  /** The designed HTML part; `null` on rows written before migration 0320. */
  html: string | null;
  createdAt: number;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
  /** An operator dismissed this unsent intent (migration 0660). */
  dismissedAt: number | null;
}

/** The outbox screen's slices. Disjoint, and together they cover the table. */
export type OutboxBucket = 'attention' | 'queued' | 'sent' | 'dismissed';

/**
 * What one run of the sweep moved.
 *
 * COPIED OFF `runSweep`'s OWN RETURN (`server/shop/orders/routes.ts`), field by
 * field, because `shopFetch<T>` is an unchecked assertion — nothing compares T
 * to the payload at runtime, so a shape written from memory is a screen reading
 * `undefined` with no type error anywhere. Both halves of this were guessed
 * wrong on the first attempt: payments answers `count`, not settled/failed, and
 * the event drain answers applied/ignored/parked, not processed.
 */
export interface SweepRun {
  payments: { count: number };
  events: { applied: number; ignored: number; parked: number; passes: number };
  emails: { sent: number; failed: number; skipped: number };
  seeded: number;
  passes: number;
}

/** An intent joined with the order number the list screen links through. */
export interface ShopOutboxItem extends ShopEmailIntent {
  orderNumber: string;
}

export interface ShopOutbox {
  items: ShopOutboxItem[];
  counts: Record<OutboxBucket, number>;
}

export type PaymentStatus =
  | 'requires_payment'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

export interface ShopPayment {
  intentId: string;
  checkoutId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  refundedTotal: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * ONE ROW OF THE ORDER LIST, AND IT IS A WRAPPER RATHER THAN AN ORDER.
 *
 * `listOrders` in `server/shop/orders/repo/orders.ts` returns
 * `{ items: { order, lines }[] }` — the SAME shape as the detail endpoint minus
 * the fulfilments, timeline, emails and payment — because the list aggregates
 * the lines in the one statement that fetches the page (`LINE_AGG`), and the one
 * `rowToRead` projection maps both.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS TYPE EXISTS BECAUSE THE CLIENT USED TO SAY `Page<ShopOrder>` HERE.
 *
 * `shopFetch<T>` is an UNCHECKED ASSERTION — it parses JSON and names the
 * result. Nothing at runtime compares the name to the payload, so a wrong `T`
 * is not a type error anywhere; it is a screen reading fields off the wrong
 * object. Every field came back `undefined`, and the first one to be handed to
 * `Intl.DateTimeFormat.format` — `placedAt` — threw `RangeError: Invalid time
 * value` and took the whole route to its error boundary. Live, for every
 * operator, while ELEVEN unit tests passed: the list fixture in
 * `Shop.test.tsx` was flat, so the suite proved the screen worked against a
 * payload the server has never sent (CLAUDE.md §2).
 *
 * The lines are not decoration on this surface — `fulfilledQty` is what tells
 * the board whether a paid order has been packed, and it is the only fulfilment
 * signal the list carries.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ShopOrderRow {
  order: ShopOrder;
  lines: ShopOrderLine[];
}

export interface ShopOrderAddOn {
  id: string;
  position: number;
  addOnId: string;
  title: string;
  mode: 'chosen' | 'included' | 'removed';
  amount: number;
  listPrice: number;
  /** Signed price of one, and how many of them (migration 0960). */
  unitAmount: number;
  units: number;
  basis: AddOnBasis;
  currency: string;
}

export interface ShopOrderDetail {
  order: ShopOrder;
  lines: ShopOrderLine[];
  fulfillments: ShopFulfillment[];
  timeline: ShopTimelineEntry[];
  emails: ShopEmailIntent[];
  /** `null` until Payments is wired at the composition root (§1.9). */
  payment: ShopPayment | null;
  /** Absent on a response from before add-ons shipped. */
  addOns?: ShopOrderAddOn[];
  /**
   * How a MANUAL order was paid and who bought it. `null` for an online order,
   * and absent on a response from before manual orders shipped — both read
   * the same way: there is nothing to show.
   */
  manual?: ShopManualOrderInfo | null;
}

// ------------------------------------------------------------ manual orders

/** How a sale recorded by hand was paid. Wire values — the labels live in
 *  `src/v2/routes/manual-order-copy.ts`. */
export type ManualPaymentMethod =
  | 'flutterwave_link'
  | 'paystack_link'
  | 'bank_transfer'
  | 'cash'
  | 'pos'
  | 'other';

/** Where a sale recorded by hand came from. */
export type ManualSalesChannel = 'walk_in' | 'whatsapp' | 'instagram' | 'phone' | 'website' | 'other';

export interface ManualCustomer {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** The `manual` block of `GET /admin/orders/:id`. Every text field is nullable:
 *  most of the form is optional, and a blank box is stored as nothing. */
export interface ShopManualOrderInfo {
  /** Nullable at the column, though every write sets it. */
  paymentMethod: ManualPaymentMethod | null;
  paymentReference: string | null;
  salesChannel: ManualSalesChannel | null;
  note: string | null;
  /** Whether the items were taken out of stock when it was recorded. */
  stockTaken: boolean;
  customer: ManualCustomer | null;
}

/**
 * The body of `POST /admin/orders/manual` (and, plus `baseRevision`, of
 * `PUT /admin/orders/:id/manual`). Money is MINOR units throughout.
 *
 * Every optional member is OMITTED rather than sent empty when the box was
 * left blank — `JSON.stringify` drops `undefined`, so a field nobody filled
 * never travels. An edit is a PUT, so what is absent there is cleared.
 */
export interface ManualOrderInput {
  /** `YYYY-MM-DD`, not in the future. */
  soldAt: string;
  lines: { variantId: string; qty: number; unitAmount?: number }[];
  paymentMethod: ManualPaymentMethod;
  paymentReference?: string;
  takeFromStock?: boolean;
  advanced?: {
    customer?: { name?: string; email?: string; phone?: string };
    salesChannel?: ManualSalesChannel;
    address?: { line1?: string; city?: string; region?: string; countryCode?: string };
    shippingAmount?: number;
    discountAmount?: number;
    taxAmount?: number;
    note?: string;
  };
}

/** Lines the server could not take out of stock. The order is saved anyway. */
export interface ManualOrderStock {
  failed: { variantId: string; sku: string; reason: string }[];
}

/** What a manual create or edit answers with: the detail body, plus stock. */
export interface ShopManualOrderResult extends ShopOrderDetail {
  stock?: ManualOrderStock;
}

/**
 * One saved state of a manual order, from `GET /admin/orders/:id/revisions`.
 * Every member is optional because this is jsonb copied at the time of the
 * save and never recomputed — an older snapshot may lack a field a newer
 * server writes, and a strict read would make the whole history unreadable.
 */
export interface ManualOrderSnapshot {
  /** Epoch ms. */
  soldAt?: number;
  lines?: {
    variantId: string;
    sku?: string;
    title?: string;
    optionValues?: Record<string, string>;
    qty: number;
    unitAmount: number;
    lineTotal?: number;
  }[];
  paymentMethod?: ManualPaymentMethod | string;
  paymentReference?: string | null;
  salesChannel?: ManualSalesChannel | string | null;
  customer?: Partial<ManualCustomer> | null;
  address?: Record<string, unknown> | null;
  shippingAmount?: number;
  discountAmount?: number;
  taxAmount?: number;
  subtotal?: number;
  grandTotal?: number;
  note?: string | null;
  takeFromStock?: boolean;
  status?: string;
  /** Only on a `voided` entry: the reason typed in the confirm, if any. */
  voidReason?: string | null;
}

export interface ManualOrderRevision {
  revision: number;
  kind: 'created' | 'edited' | 'voided';
  editedAt: number;
  editedBy: { id: string; name: string | null } | null;
  snapshot: ManualOrderSnapshot;
}

/**
 * HANDOFF §2 A4's aggregate, as `server/shop/admin/stats.ts` actually answers it.
 *
 * TWO THINGS IN THIS SHAPE ARE NOT WHAT A DASHBOARD WOULD ASSUME, and both are
 * the server refusing to assert something it does not know:
 *
 *  - `ordersByStatus` and `revenue` ARE GROUPED BY CURRENCY. Two ISO-4217 codes
 *    cannot be added, so there is no single store total to return; v1 has one
 *    currency and therefore one row, and the grouping is what makes the day that
 *    stops being true visible rather than silently wrong.
 *  - A STATUS WITH NO ORDERS HAS NO ROW. A zero row would have to carry a
 *    currency and there is no order to take one from. Rendering a zero for an
 *    absent status is one line on this side and would be a lie on that one.
 */
export interface OrderStatusTotal {
  status: OrderStatus;
  currency: string;
  count: number;
  /** Sum of `grandTotal`, MINOR UNITS. Not net of refunds — see `revenue`. */
  total: number;
}

export interface RevenueWindow {
  currency: string;
  /**
   * Each window is the full money split over orders paid in it — `sales` is
   * ITEM PRICES, with delivery, tax, discounts, charged, refunded and net
   * named beside it (the analytics screen's shape). Windows from `generatedAt`.
   */
  last24h: AnalyticsMoney;
  last7d: AnalyticsMoney;
  last30d: AnalyticsMoney;
}

export interface EmailBacklog {
  /** Written, not yet handed to a mailer, still inside the attempt budget. */
  pending: number;
  /** Out of attempts. NOTHING WILL RETRY THESE without a human. */
  stuck: number;
  /** Handed to a mailer. Counted so "0 pending" can be told from "no email ever". */
  sent: number;
  /**
   * When the oldest still-waiting intent was written, or `null` if none is.
   *
   * OPTIONAL ON THE WIRE, and read defensively for it: a deployment serving a
   * bundle older than the field answers without it, and a strict read would
   * make the bell treat an ordinary response as broken. Same rule the frozen
   * totals learned twice.
   */
  oldestPendingAt?: number | null;
}

/** A row of `GET /shop/admin/inventory`, which `stats` reuses for low stock. */
export interface InventoryRow {
  variantId: string;
  sku: string;
  optionValues: Record<string, string>;
  variantStatus: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  onHand: number;
  reserved: number;
  /** `onHand - reserved`. Negative for an oversold backorderable variant. */
  available: number;
  backorderable: boolean;
  updatedAt: number;
}

/** The dashboard strip. Deliberately NOT a whole `ShopOrder` — no lines. */
export interface LatestOrderRow {
  id: string;
  orderNumber: string;
  email: string;
  status: OrderStatus;
  currency: string;
  grandTotal: number;
  placedAt: number;
}

export interface ShopStats {
  /** The instant every number below was taken at. The windows are relative to it. */
  generatedAt: number;
  ordersByStatus: OrderStatusTotal[];
  revenue: RevenueWindow[];
  lowStockThreshold: number;
  lowStock: InventoryRow[];
  /** There are more low-stock variants than `lowStock` carries. */
  lowStockMore: boolean;
  emails: EmailBacklog;
  latestOrders: LatestOrderRow[];
}

/** HANDOFF §2 A4: buyers, which is not the same list as accounts. */
export interface ShopBuyer {
  /** The folded address. It is this row's identity and the cursor's id. */
  email: string;
  /** `null` for a guest checkout — the ordinary case, not an error. */
  customerId: string | null;
  displayName: string | null;
  /** Every order at this address, whatever its status. */
  orderCount: number;
  /** Of those, the ones that were actually paid for. */
  paidCount: number;
  /**
   * MINOR UNITS: `sum(grandTotal - refundedTotal)` over the PAID orders only. A
   * pending order is not spend and a fully refunded one is not either.
   */
  totalSpent: number;
  currency: string;
  lastOrderAt: number;
  lastOrderId: string;
  lastOrderNumber: string;
  lastOrderStatus: OrderStatus;
}

/**
 * "Not bought yet" — people with a basket, an account or a subscription who
 * have never ordered, and the basket each of them left. Mirrors
 * `server/shop/admin/prospects.ts` field for field; see that file for why the
 * tabs are disjoint, why the address is folded, and why a basket is quoted
 * live rather than frozen.
 */
export type SubscribeState = 'subscribed' | 'never_asked' | 'unsubscribed';

/** The four tabs `listProspects` filters on — `'all'` is their union. */
export type ProspectTab = 'basket' | 'account' | 'subscriber' | 'all';

export interface ShopBasketLine {
  variantId: string;
  productId: string;
  /** The PRODUCT's title. A shopper recognises "PLA Basic", not a SKU. */
  title: string;
  optionValues: Record<string, string>;
  sku: string;
  qty: number;
  unitMinor: number;
  lineMinor: number;
  /** The variant's own photograph, falling back to the product cover. Normalised. */
  imageId: string | null;
}

export interface ShopBasket {
  cartId: string;
  status: 'open' | 'converting' | 'converted' | 'abandoned';
  currency: string;
  updatedAt: number;
  expiresAt: number | null;
  lines: ShopBasketLine[];
  totalMinor: number;
  discountCode: string | null;
  addOnChoices: unknown | null;
  redemptionPoints: number | null;
}

/** One broadcast a prospect was queued for. Mirrors `Send` in
 * `server/shop/admin/prospects.ts` field for field. */
export interface ShopSend {
  broadcastId: string;
  subject: string;
  /** 'pending' | 'sent' | 'failed' | 'skipped' */
  status: string;
  sentAt: number | null;
  lastError: string | null;
}

export interface ShopProspect {
  /** The folded address. It is this row's identity, and the cursor's id. */
  email: string;
  displayName: string | null;
  hasBasket: boolean;
  hasAccount: boolean;
  isSubscriber: boolean;
  subscribeState: SubscribeState;
  /** Units in the basket, summed over its lines. Zero when there is none. */
  basketItems: number;
  /** MINOR UNITS, quoted live. Zero when there is no basket. */
  basketMinor: number;
  /** What `basketMinor` is denominated in. EMPTY when there is no basket. */
  currency: string;
  /** Cart last touched, else account created, else subscribed. Never null. */
  lastSeenAt: number;
  /** When a broadcast last actually reached them, or null. */
  lastNudgeAt: number | null;
}

export interface ShopProspectPage {
  items: ShopProspect[];
  nextCursor: string | null;
  /**
   * Carts with lines that resolve to no address at all. NOT affected by the
   * tab or the search query — a property of the shop, not of the page.
   */
  unreachableBaskets: number;
}

/**
 * One row of the categories surface — the UNION of the managed
 * `shop_categories` table and the values still sitting in
 * `shop_products.category` as free text (migration 0200).
 *
 * `id` IS NULLABLE AND THE NULL IS LOAD-BEARING: it means "in use, not
 * managed". Such a row can be ADOPTED — post its name to create the managed row
 * — but cannot be renamed, recoloured or deleted, because there is nothing to
 * change. `managed` is the same fact as a boolean, and `slug` is null for
 * exactly the same rows, which is why the storefront never sees them: an
 * unmanaged category has no URL to route to.
 *
 * The product-list filter reads `name` and `count` and nothing else, which is
 * what made widening this shape safe when the route moved.
 */
export interface ShopCategory {
  id: string | null;
  slug: string | null;
  name: string;
  /** The line under the heading on the storefront's category page. */
  blurb: string;
  /** The tile's spool tint, lowercase six-digit hex, or null for none chosen. */
  accentHex: string | null;
  /** Tile order, ascending. Ties break on folded name. */
  position: number;
  /** Products carrying it — drafts, archived and trash included. */
  count: number;
  managed: boolean;
}

export interface ShopCategoryDraft {
  name: string;
  blurb?: string;
  accentHex?: string | null;
  position?: number;
}

export interface ShopCategoryPatch {
  name?: string;
  /** Moving the URL, which a rename deliberately does NOT do. */
  slug?: string;
  blurb?: string;
  accentHex?: string | null;
  position?: number;
}

export interface ShopCategoryRenameResult {
  category: ShopCategory;
  /** Products the rename actually moved off the old name. */
  movedProducts: number;
}

/**
 * A shipping zone and its delivery options — the admin-editable replacement
 * for `DEFAULT_SHIPPING_ZONES` (migration 0240, admin#19).
 */
export interface ShopShippingOption {
  id: string;
  zoneId: string;
  label: string;
  /** Minor units, in the store currency. Integer. */
  amountMinor: number;
  estimate: string;
  position: number;
}

/**
 * `shop_delivery_settings`, the whole row (migrations 0760 and 1060).
 *
 * `servedCountries` is where the shop will send a parcel it arranges ITSELF —
 * the manual method. It is never empty and there is no "everywhere": a country
 * nobody named falls to the catch-all zone, which is the fail-safe rate.
 */
export interface ShopDeliverySettings {
  addressMode: 'district' | 'simple';
  locationOffered: boolean;
  servedRegions: string[] | null;
  servedCountries: string[];
  revision: number;
  updatedAt: number;
}

export interface ShopShippingZone {
  id: string;
  label: string;
  countries: string[];
  /** Empty means "no region restriction" — matches any region in the country. */
  regions: string[];
  taxRateBps: number;
  taxLabel: string;
  shippingTaxable: boolean;
  isFallback: boolean;
  position: number;
  options: ShopShippingOption[];
}

export interface ShopShippingZoneDraft {
  label: string;
  countries: string[];
  regions: string[];
  taxRateBps: number;
  taxLabel: string;
  shippingTaxable: boolean;
  isFallback: boolean;
  position: number;
}

export type ShopShippingZonePatch = Partial<ShopShippingZoneDraft>;

export interface ShopShippingOptionDraft {
  zoneId: string;
  label: string;
  amountMinor: number;
  estimate?: string;
  position?: number;
}

/**
 * The shop's opinion about one district (migration 0300). NOT the district
 * itself — no name, no region. `marketingApi.listAreas` owns those, and the
 * join is on `areaKey`, the handle a rename does not move.
 */
export interface ShopDeliveryArea {
  id: string;
  areaKey: string;
  delivers: boolean;
  /** `null` means NO OVERRIDE — price from the state's zone. Never "free". */
  rateMinor: number | null;
  revision: number;
}

export interface ShopDeliveryAreaWrite {
  delivers?: boolean;
  /** Absent leaves it; explicit `null` clears the override. The two differ. */
  rateMinor?: number | null;
  /** CAS. `null` asserts "no row for this district yet". */
  expectedRevision: number | null;
}

export interface ShopDeliveryAreasBulkWrite {
  areaKeys: string[];
  delivers?: boolean;
  rateMinor?: number | null;
}

export interface ShopShippingOptionPatch {
  label?: string;
  amountMinor?: number;
  estimate?: string;
  position?: number;
}

/**
 * WHO IS TOLD WHEN AN ORDER IS PAID FOR — a CHECK-pinned singleton row, so
 * there is no create, no delete and no id anywhere in this shape.
 *
 * THE DEFAULTS ARE ON, AND AN EMPTY `orderRecipients` IS A LEGITIMATE STATE
 * rather than a broken one: the migration seeds `notifyTeam` and
 * `notifyOnOrder` true with no hand-typed addresses at all, because the owner
 * asked for notifications that work the moment they deploy. So a screen that
 * renders the empty list as "nobody is being told" would be wrong — the team
 * roster is where the addresses come from until somebody types one.
 *
 * Every field below is read off the pinned contract rather than remembered:
 * `shopFetch<T>` is an UNCHECKED ASSERTION (see the header of this file and
 * `safeFormatMinor`'s), so a name misspelt here is `undefined` at runtime with
 * nothing anywhere to say so.
 */
export interface ShopNotificationSettings {
  /** Extra addresses somebody typed by hand — a shared inbox, a warehouse. */
  orderRecipients: string[];
  /** Also mail everyone on the team who handles orders. */
  notifyTeam: boolean;
  /** The master switch. Off means nobody is emailed at all. */
  notifyOnOrder: boolean;
  revision: number;
  updatedAt: number;
  /** The account that last saved. `null` for the migration's own seed. */
  updatedBy: string | null;
}

/**
 * The CAS patch. `expectedRevision` is REQUIRED, as on every settings patch in
 * this codebase — a save without one is two tabs quietly overwriting each
 * other, and the losing one never finds out. Everything else is optional and
 * absent means "leave it alone".
 */
export interface ShopNotificationSettingsPatch {
  expectedRevision: number;
  orderRecipients?: string[];
  notifyTeam?: boolean;
  notifyOnOrder?: boolean;
}

/** One row of the tag vocabulary — canonical spelling per case-fold group. */
export interface ShopTag {
  name: string;
  count: number;
}

export interface ShopRefund {
  id: string;
  intentId: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: number;
}

/**
 * What `POST /admin/orders/:id/cancel` refunds before it cancels, for a PAID
 * order (`server/shop/orders/routes.ts`, task-d3). REQUIRED by the server on a
 * paid order — there is no default, because a silent default is the exact
 * mismatch the feature exists to close: "if you refund without cancelling,
 * what happens when you cancel by that logic." Never sent for a PENDING
 * order, which the server refuses (there is nothing to refund).
 *
 * `'none'` IS "CANCEL WITHOUT REFUNDING", CHOSEN ON PURPOSE. A refund of zero
 * is not a refund — `parseRefund` already refuses to parse one — so this is
 * the named alternative rather than an amount box left empty.
 */
export type CancelRefundChoice =
  | { kind: 'percent'; percent: 100 | 75 }
  | { kind: 'amount'; amount: number }
  | { kind: 'none' };

/**
 * The two gateways a payment can route through (`server/shop/payments/schema.ts`'s
 * `PROVIDER_NAMES`, copied rather than imported — see this file's header for why).
 */
export type PaymentProviderName = 'paystack' | 'flutterwave';

/** One gateway's row of `GET`/`PATCH /shop/admin/payments/settings`. */
export interface PaymentGatewaySettings {
  /** Whether THIS DEPLOYMENT has the gateway's key(s). A boolean — never the key. */
  hasKey: boolean;
  /** Switched on for this account — `shop_payment_settings`' own column. */
  currencies: string[];
  /**
   * The adapter's ceiling: every currency its API can charge at all, whether or
   * not this account has switched it on. Bounds what the card may OFFER, so
   * nobody can switch on a currency the gateway cannot actually take.
   */
  canCharge: string[];
}

/**
 * `GET`/`PATCH /shop/admin/payments/settings`'s response — THE SAME SHAPE
 * both ways, so the settings card re-renders from a PATCH response rather
 * than guessing what it just saved.
 */
export interface PaymentSettings {
  activeProvider: PaymentProviderName;
  /** `null` means "same as `activeProvider`". */
  internationalProvider: PaymentProviderName | null;
  revision: number;
  gateways: Record<PaymentProviderName, PaymentGatewaySettings>;
}

/**
 * The PATCH body. `revision` is REQUIRED and named exactly that — unlike every
 * other settings patch in this file, the server's own field is `revision`, not
 * `expectedRevision`.
 *
 * ⚠ A KEY-PRESENCE CONTRACT. The server tells "leave alone" from "clear" by
 * whether `internationalProvider` is PRESENT on the body, so
 * `{ internationalProvider: undefined }` is not the same as omitting the key —
 * build this object with only the keys actually meant, never by spreading a
 * partial object that might carry an `undefined` value under a real key.
 */
export interface PaymentSettingsPatch {
  activeProvider?: PaymentProviderName;
  internationalProvider?: PaymentProviderName | null;
  currencies?: Partial<Record<PaymentProviderName, string[]>>;
  revision: number;
}

// ============================================================================
// ROUTES
// ============================================================================

const BASE = '/shop/admin';

export const shopApi = {
  // --------------------------------------------------------------- overview
  /**
   * HANDOFF §2 A4's single aggregate. Everything `/shop` draws comes from here.
   *
   * `threshold` is what counts as low stock and defaults server-side. It is
   * exposed because the route takes it and a client that cannot reach a
   * parameter is a parameter that does not exist; the overview leaves it alone.
   */
  async stats(query: { threshold?: number } = {}, signal?: AbortSignal): Promise<ShopStats> {
    return shopFetch<ShopStats>(`${BASE}/stats`, { query: { ...query }, signal });
  },

  // ---------------------------------------------------------------- outbox

  /** The order-email outbox, one bucket at a time, with every tab's count. */
  async listEmailOutbox(bucket: OutboxBucket, signal?: AbortSignal): Promise<ShopOutbox> {
    return shopFetch<ShopOutbox>(`${BASE}/emails`, { query: { bucket }, signal });
  },

  /**
   * Reset the attempt counter AND run one sweep, so "retry" means "try now".
   * The summary says whether anything actually left; 404 for a sent intent.
   */
  async retryEmailIntent(
    id: string,
  ): Promise<{ ok: true; emails: { sent: number; failed: number; skipped: number } }> {
    return shopFetch(`${BASE}/emails/${seg(id)}/retry`, { method: 'POST', id });
  },

  /** Stop counting an unsent intent at the operator. Retry undoes it. */
  async dismissEmailIntent(id: string): Promise<{ ok: true }> {
    return shopFetch(`${BASE}/emails/${seg(id)}/dismiss`, { method: 'POST', id });
  },

  /**
   * Run the sweep now — settle payments, drain commerce events, send the queued
   * mail — instead of waiting for whatever is scheduled to call it.
   *
   * ON PRODUCTION THIS IS A NUDGE. An external cron already holds the
   * `CRON_SECRET` and calls `GET /admin/sweep` on a schedule, so the queue is
   * normally seconds old and pressing this changes little.
   *
   * ON A PREVIEW HOST IT IS THE ONLY DRAINER THERE IS, which is the reason it
   * exists. Vercel's own cron entries fire for the PRODUCTION deployment only,
   * and the external service authenticates with production's secret, which the
   * Preview scope does not share — so on `admin.dev.plaspool.com` nothing calls
   * the sweep at all. An order still reaches `paid` there, because the
   * storefront's checkout-complete page resolves the capture from Paystack
   * directly, which is exactly what makes the silence confusing: the order
   * moves and the outbox does not. Measured 2026-09-08, three intents stuck at
   * `attempts = 0` with no error anywhere.
   *
   * `requireAdmin()` on the server — owner and developers.
   */
  async sweepNow(): Promise<SweepRun> {
    return shopFetch<SweepRun>(`${BASE}/sweep`, { method: 'POST', body: {} });
  },

  // ------------------------------------------------------------------ push

  /**
   * The VAPID public key a browser needs before it can subscribe.
   *
   * OVER THE WIRE RATHER THAN BAKED INTO THE BUNDLE, deliberately. A `VITE_`
   * variable is read at BUILD time, so an owner who sets the keys and reloads
   * would see nothing change until the next deploy — and would reasonably
   * conclude the feature was broken. `configured` is false when the deployment
   * has no keys, which is a state the UI shows rather than an error.
   *
   * The key is not a secret; it is published to every subscribing browser.
   *
   * `orders` domain, not `settings`: whether a person's own phone buzzes is not
   * an owner-only decision.
   */
  async pushKey(signal?: AbortSignal): Promise<{ publicKey: string | null; configured: boolean }> {
    return shopFetch(`${BASE}/push/key`, { signal });
  },

  /** How many devices the CALLER has registered, and whether push works here. */
  async pushDevices(signal?: AbortSignal): Promise<{ configured: boolean; devices: number }> {
    return shopFetch(`${BASE}/push/devices`, { signal });
  },

  /** Register this browser, or refresh the keys of one already registered.
   *  Idempotent on the endpoint — re-subscribing must not deliver twice. */
  async pushSubscribe(body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }): Promise<{ ok: true; configured: boolean }> {
    return shopFetch(`${BASE}/push/subscribe`, {
      method: 'POST',
      subject: 'Notifications',
      body,
    });
  },

  /**
   * Push a test to the CALLER's own devices and say how many took it.
   *
   * `devices` is counted before the send, so `devices: 1, sent: 0` is a
   * different story from `devices: 0` — one is a browser that dropped its
   * subscription, the other is a device that was never registered. The screen
   * says which; without the pair it could only say "nothing happened".
   */
  async pushTest(): Promise<{
    ok: true;
    configured: boolean;
    devices: number;
    sent: number;
  }> {
    return shopFetch(`${BASE}/push/test`, {
      method: 'POST',
      subject: 'Notifications',
      body: {},
    });
  },

  /** Forget this browser. `ok` even when no row existed — unsubscribing twice
   *  has got what it asked for. */
  async pushUnsubscribe(endpoint: string): Promise<{ ok: true; removed: number }> {
    return shopFetch(`${BASE}/push/unsubscribe`, {
      method: 'POST',
      subject: 'Notifications',
      body: { endpoint },
    });
  },

  /** The full low-stock list the overview only shows the head of. */
  async listInventory(
    query: { belowOnly?: boolean; threshold?: number; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<InventoryRow>> {
    return shopFetch<Page<InventoryRow>>(`${BASE}/inventory`, {
      /*
       * `'1'`/`'0'` and never a boolean. The route's schema is
       * `z.enum(['0','1'])` precisely because `?belowOnly=false` is a string
       * that every truthiness test in JavaScript calls true — a filter that
       * reads as applied, is not, and reports nothing.
       */
      query: {
        ...query,
        belowOnly: query.belowOnly === undefined ? undefined : query.belowOnly ? '1' : '0',
      },
      signal,
    });
  },

  // --------------------------------------------------------------- products
  /**
   * The admin list — drafts and trash included, unlike the storefront's.
   *
   * NO `search` PARAMETER, AND THAT IS THE ROUTE'S SHAPE RATHER THAN AN
   * OVERSIGHT: `AdminListQueryParams` in `server/shop/catalog/routes.ts` is
   * `.strict()`, so sending one would be a 400 naming the field. The catalogue
   * screen filters the page it has, and says so where the box is.
   */
  async listProducts(
    query: {
      status?: ProductStatus;
      category?: string;
      sort?: 'newest' | 'price_asc' | 'price_desc' | 'alphabetical';
      cursor?: string;
      limit?: number;
      /**
       * "And how many are there altogether?" — off by default because the
       * server pays for a second scan to answer it (see `withTotal` in
       * `server/shop/catalog/query.ts`). The products screen asks once, to
       * put a number on the Export action.
       */
      withTotal?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<ShopProduct> & { total?: number }> {
    return shopFetch<Page<ShopProduct> & { total?: number }>(`${BASE}/products`, {
      // `'1'`/`'0'`, never a boolean — the same reason spelled out on
      // `listInventory` above: `?withTotal=false` is a truthy string.
      query: {
        ...query,
        withTotal: query.withTotal === undefined ? undefined : query.withTotal ? '1' : '0',
      },
      signal,
    });
  },

  async getProduct(id: string, signal?: AbortSignal): Promise<ShopProductDetail> {
    const res = await shopFetch<{ product: ShopProductDetail }>(
      `${BASE}/products/${seg(id)}`,
      { id, subject: 'Product', signal },
    );
    return res.product;
  },

  /** 201, not 200. */
  // ------------------------------------------------------- bulk discounts

  /** The store-wide default ladder every product inherits (migration 0600). */
  async defaultBulkTiers(): Promise<BulkTier[]> {
    return (await shopFetch<{ tiers: BulkTier[] }>(`${BASE}/bulk-tiers`, { subject: 'Bulk tiers' }))
      .tiers;
  },

  async saveDefaultBulkTiers(tiers: BulkTier[]): Promise<BulkTier[]> {
    return (
      await shopFetch<{ tiers: BulkTier[] }>(`${BASE}/bulk-tiers`, {
        method: 'PUT',
        body: { tiers },
        subject: 'Bulk tiers',
      })
    ).tiers;
  },

  /** One product's ladder, with `inherited` saying whether it has one at all. */
  async productBulkTiers(id: string): Promise<BulkTierSet> {
    return shopFetch<BulkTierSet>(`${BASE}/products/${id}/bulk-tiers`, { subject: 'Bulk tiers' });
  },

  /**
   * PUT the product's ladder. AN EMPTY ARRAY IS THE RESET — it deletes the
   * product's own rungs and returns it to inheriting the store default, which is
   * why there is no delete method beside this one.
   */
  async saveProductBulkTiers(id: string, tiers: BulkTier[]): Promise<BulkTierSet> {
    return shopFetch<BulkTierSet>(`${BASE}/products/${id}/bulk-tiers`, {
      method: 'PUT',
      body: { tiers },
      subject: 'Bulk tiers',
    });
  },

  // -------------------------------------------------------------- add-ons
  async listAddOns(signal?: AbortSignal): Promise<ShopAddOn[]> {
    return (await shopFetch<{ items: ShopAddOn[] }>(`${BASE}/add-ons`, { subject: 'Add-ons', signal })).items;
  },
  async getAddOn(id: string, signal?: AbortSignal): Promise<ShopAddOn> {
    return (await shopFetch<{ addOn: ShopAddOn }>(`${BASE}/add-ons/${seg(id)}`, { id, subject: 'Add-on', signal })).addOn;
  },
  async createAddOn(input: ShopAddOnInput): Promise<ShopAddOn> {
    return (await shopFetch<{ addOn: ShopAddOn }>(`${BASE}/add-ons`, { method: 'POST', body: input, subject: 'Add-on' })).addOn;
  },
  /** CAS: a 409 `stale_write` carries `addOn`, the current row. */
  async updateAddOn(id: string, patch: ShopAddOnPatch, baseRevision: number): Promise<ShopAddOn> {
    return (
      await shopFetch<{ addOn: ShopAddOn }>(`${BASE}/add-ons/${seg(id)}`, {
        method: 'PATCH',
        body: { baseRevision, patch },
        id,
        subject: 'Add-on',
      })
    ).addOn;
  },

  async createProduct(patch: ShopProductPatch = {}): Promise<ShopProduct> {
    const res = await shopFetch<{ product: ShopProduct }>(`${BASE}/products`, {
      method: 'POST',
      body: patch,
      subject: 'Product',
    });
    return res.product;
  },

  /**
   * The CAS write.
   *
   * `baseRevision` is what makes a second tab a 409 instead of a silent
   * overwrite, and the 409 carries the server's current product so the form's
   * "load theirs" needs no second request (`server/shop/app.ts`'s own error
   * handler exists for exactly that).
   */
  async saveProduct(
    id: string,
    patch: ShopProductPatch,
    opts: { baseRevision?: number; note?: string } = {},
  ): Promise<ShopProduct> {
    const res = await shopFetch<{ product: ShopProduct }>(`${BASE}/products/${seg(id)}`, {
      method: 'PATCH',
      id,
      subject: 'Product',
      body: { patch, baseRevision: opts.baseRevision, note: opts.note },
    });
    return res.product;
  },

  /**
   * The lifecycle transitions, which take NO `baseRevision` by contract: they
   * re-read, re-derive and re-CAS server-side, and each answers with the NEW
   * product so a form can adopt the bumped revision without a second request.
   * Without that the next save carries a base the server has already passed and
   * 409s against itself.
   */
  async transitionProduct(id: string, op: ProductLifecycleOp): Promise<ShopProduct> {
    const res = await shopFetch<{ product: ShopProduct }>(
      `${BASE}/products/${seg(id)}/${op}`,
      { method: 'POST', id, subject: 'Product' },
    );
    return res.product;
  },

  /** SOFT delete — to the trash. There is deliberately no hard-delete route. */
  async trashProduct(id: string): Promise<ShopProduct> {
    const res = await shopFetch<{ product: ShopProduct }>(`${BASE}/products/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Product',
    });
    return res.product;
  },

  /**
   * 201. `optionValues` is the variant's own axis map (`{ Size: 'M' }`).
   *
   * `ShopVariantBase`, NOT `ShopVariant`, and see that type for why: this route
   * answers with `rowToVariant`, which knows nothing about price, stock or
   * whether anything has ever been ordered. A brand-new variant has no price row
   * and no inventory row, so even the values a widened type would imply
   * (`price: null`, `available: null`) would be assertions this response never
   * made — the panel re-reads instead.
   */
  async createVariant(
    productId: string,
    body: {
      /** OPTIONAL — the server derives one from the title and the options. */
      sku?: string;
      optionValues?: Record<string, string>;
      position?: number;
      weightGrams?: number | null;
      onHand?: number;
      backorderable?: boolean;
      imageId?: string | null;
      /** The colour code of this option. The server lowercases it. */
      colorHex?: string | null;
      /** Minor units; the caller has already converted via `parseMajor`. */
      compareAtMinor?: number | null;
      costMinor?: number | null;
    },
  ): Promise<ShopVariantBase> {
    const res = await shopFetch<{ variant: ShopVariantBase }>(
      `${BASE}/products/${seg(productId)}/variants`,
      { method: 'POST', body, id: productId, subject: 'Product' },
    );
    return res.variant;
  },

  /** `ShopVariantBase` for the reason `createVariant` gives — `rowToVariant` again. */
  async updateVariant(
    id: string,
    body: {
      sku?: string;
      optionValues?: Record<string, string>;
      position?: number;
      weightGrams?: number | null;
      status?: VariantStatus;
      /** `null` clears the colour photograph; a committed image id sets it. */
      imageId?: string | null;
      /** `null` clears the colour code; `#rrggbb` sets it. */
      colorHex?: string | null;
      /** `null` clears — "no longer on sale". Minor units, via `parseMajor`. */
      compareAtMinor?: number | null;
      /** `null` clears. Minor units. Admin-only; never reaches the storefront. */
      costMinor?: number | null;
      /**
       * No longer create-only (owner's queue, 2026-08-25): the server lands the
       * flag on `shop_inventory` inside `updateVariant`'s one statement. NOTE
       * the response is still `ShopVariantBase` — the flag it reports lives on
       * another table, so re-read the product to see it, as with price/stock.
       */
      backorderable?: boolean;
    },
  ): Promise<ShopVariantBase> {
    const res = await shopFetch<{ variant: ShopVariantBase }>(`${BASE}/variants/${seg(id)}`, {
      method: 'PATCH',
      body,
      id,
      subject: 'Variant',
    });
    return res.variant;
  },

  /**
   * HARD delete (issue #18) — unlike `trashProduct`, this one really removes
   * the row. Only reachable for a variant that has never been ordered; the
   * server answers 409 (`precondition_failed`) otherwise, which the panel
   * avoids by hiding the control rather than by catching this.
   *
   * The returned row is the DELETED one, and `ShopVariantBase` again: reading
   * `everOrdered` off it would be doubly wrong, since the route only ever
   * answers at all when that field would have been `false`.
   */
  async deleteVariant(id: string): Promise<ShopVariantBase> {
    const res = await shopFetch<{ variant: ShopVariantBase }>(`${BASE}/variants/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Variant',
    });
    return res.variant;
  },

  /**
   * `amount` IS MINOR UNITS AND THE CALLER HAS ALREADY CONVERTED.
   *
   * The route's Zod is `z.number().int()`, so `19.99` is a 400 rather than a
   * rounding, and `money()` refuses it a second time before it can reach a
   * column. Every caller in `src/` reaches this through `parseMajor` above.
   */
  async setVariantPrice(
    id: string,
    amount: number,
    currency: string,
    /** WHY it moved. Optional on the wire — every price written before
     *  migration 0009 has none, and the audit view says so rather than
     *  inventing one. */
    reason?: string,
  ): Promise<{ amount: number; currency: string }> {
    if (!Number.isSafeInteger(amount)) throw new MoneyShapeError(amount);
    const res = await shopFetch<{ price: { amount: number; currency: string } }>(
      `${BASE}/variants/${seg(id)}/price`,
      {
        method: 'PUT',
        body: {
          amount,
          currency: currency.toUpperCase(),
          ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
        },
        id,
        subject: 'Variant',
      },
    );
    return res.price;
  },

  /**
   * `reason` is OPTIONAL since 2026-09-03 — it was mandatory server-side, on the
   * argument that an unexplained stock change is the one you will most wish you
   * had logged. The ledger is still kept; the field just no longer blocks a
   * correction.
   *
   * OMITTED RATHER THAN SENT EMPTY, the same way `setVariantPrice` above does
   * it: the body's schema is `.strict()` and its `reason` is still `.min(1)`
   * INSIDE the `.optional()`, so `{ reason: '' }` is a 400 while an absent key
   * is the blank. One rule for both fields, in one place, rather than four
   * screens each remembering.
   */
  async adjustInventory(
    variantId: string,
    delta: number,
    reason?: string,
  ): Promise<{ variantId: string; onHand: number; reserved: number; available: number }> {
    const res = await shopFetch<{
      inventory: { variantId: string; onHand: number; reserved: number; available: number };
    }>(`${BASE}/inventory/${seg(variantId)}/adjust`, {
      method: 'POST',
      body: { delta, ...(reason && reason.trim() ? { reason: reason.trim() } : {}) },
      id: variantId,
      subject: 'Variant',
    });
    return res.inventory;
  },

  /**
   * What changed in the catalogue, who changed it, and why.
   *
   * Two sources behind one list — `commerce_events` for stock and the
   * append-only `shop_prices` for money — unioned and keyset-paged server-side.
   * See `server/shop/admin/audit.ts` for why this needed no new table.
   */
  async listAudit(
    q: { kind?: AuditKind; variantId?: string; productId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    return await shopFetch<{ items: AuditEntry[]; nextCursor: string | null }>(
      `${BASE}/audit`,
      { query: q as Record<string, string | number | undefined>, signal },
    );
  },

  /**
   * HANDOFF §2 A4's product categories — distinct over ALL products, drafts and
   * trash included, unlike the public rule.
   *
   * `items`, NOT `categories`: the route is `{ items: [...] }`
   * (`server/shop/admin/routes.ts`), matching every other list on this surface.
   * It takes NO query at all and its schema is `.strict()`, so a stray `?limit=`
   * would be a 400 rather than a page of a list that does not paginate.
   *
   * `''` IS NOT IN THE ANSWER. The route excludes it, because
   * `shop_products.category` is `NOT NULL` and `''` is what "no category"
   * carries — an empty `?category=` filter means "no filter", not "products with
   * no category", so an option for it would filter nothing.
   */
  async listCategories(signal?: AbortSignal): Promise<ShopCategory[]> {
    const res = await shopFetch<{ items: ShopCategory[] }>(`${BASE}/categories`, { signal });
    return res.items ?? [];
  },

  /**
   * Promote a name to a managed row, allocating its slug server-side.
   *
   * 201, not 200. A name already in use as free text comes back with its
   * products already counted — "adopt the category I have been typing" and
   * "create a new one" are the same request.
   */
  async createCategory(draft: ShopCategoryDraft): Promise<ShopCategory> {
    const res = await shopFetch<{ category: ShopCategory }>(`${BASE}/categories`, {
      method: 'POST',
      body: draft,
      subject: 'Category',
    });
    return res.category;
  },

  /**
   * Rename, recolour, reword or reorder.
   *
   * A RENAME REWRITES EVERY PRODUCT carrying the old value and reports how many
   * moved — which is why this returns a result rather than just the row. It does
   * NOT move the slug: a published URL is a promise, so `patch.slug` is the only
   * thing that changes it, deliberately and separately.
   *
   * `accentHex: null` CLEARS the tint and is not the same as omitting the key,
   * which leaves it alone.
   */
  async saveCategory(id: string, patch: ShopCategoryPatch): Promise<ShopCategoryRenameResult> {
    return shopFetch<ShopCategoryRenameResult>(`${BASE}/categories/${seg(id)}`, {
      method: 'PATCH',
      id,
      subject: 'Category',
      body: patch,
    });
  },

  /**
   * Delete a managed row.
   *
   * `reassign` UNDEFINED means "only if nothing uses it", and a category still
   * in use is refused with a 409 carrying the count. Passing a name moves the
   * products there first; passing `''` means make them uncategorised, which the
   * wire spells `-` because a query parameter cannot carry the empty string.
   */
  async deleteCategory(id: string, reassign?: string): Promise<{ movedProducts: number }> {
    return shopFetch<{ movedProducts: number }>(`${BASE}/categories/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Category',
      query: reassign === undefined ? {} : { reassign: reassign === '' ? '-' : reassign },
    });
  },

  /** Every shipping zone with its options, for the admin screen. */
  /**
   * The delivery settings row (migration 0760) — of which the admin uses ONE
   * field today, `servedCountries` (migration 1060).
   *
   * The row also carries `addressMode`, `servedRegions` and `locationOffered`,
   * and no screen has ever edited them; 0760's card was never built. They ride
   * along here because the endpoint returns the whole row and a patch that
   * omits a key leaves it alone, so reading them costs nothing and inventing a
   * narrower endpoint would cost a migration's worth of confusion later.
   */
  async getDeliverySettings(signal?: AbortSignal): Promise<ShopDeliverySettings> {
    const res = await shopFetch<{ settings: ShopDeliverySettings }>(
      `${BASE}/delivery-settings`,
      { signal },
    );
    return res.settings;
  },

  /** CAS on `expectedRevision`, like every other settings write here. */
  async saveDeliverySettings(
    expectedRevision: number,
    patch: { servedCountries?: string[] },
  ): Promise<ShopDeliverySettings> {
    const res = await shopFetch<{ settings: ShopDeliverySettings }>(
      `${BASE}/delivery-settings`,
      { method: 'PATCH', subject: 'Delivery settings', body: { expectedRevision, ...patch } },
    );
    return res.settings;
  },

  async listShippingZones(signal?: AbortSignal): Promise<ShopShippingZone[]> {
    const res = await shopFetch<{ items: ShopShippingZone[] }>(`${BASE}/shipping-zones`, {
      signal,
    });
    return res.items ?? [];
  },

  async createShippingZone(draft: ShopShippingZoneDraft): Promise<ShopShippingZone> {
    const res = await shopFetch<{ zone: ShopShippingZone }>(`${BASE}/shipping-zones`, {
      method: 'POST',
      body: draft,
      subject: 'Shipping zone',
    });
    return res.zone;
  },

  async saveShippingZone(
    id: string,
    patch: ShopShippingZonePatch,
  ): Promise<ShopShippingZone> {
    const res = await shopFetch<{ zone: ShopShippingZone }>(
      `${BASE}/shipping-zones/${seg(id)}`,
      { method: 'PATCH', id, subject: 'Shipping zone', body: patch },
    );
    return res.zone;
  },

  async deleteShippingZone(id: string): Promise<void> {
    await shopFetch<{ ok: boolean }>(`${BASE}/shipping-zones/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Shipping zone',
    });
  },

  // ------------------------------------------------------------ delivery courier
  /** Which courier is switched on. Any signed-in role may ask; the order screen needs it. */
  async getCourierProvider(signal?: AbortSignal): Promise<ShopCourierProvider> {
    /* NOT under /shop/admin: every signed-in role may ask which courier is on. */
    return shopFetch<ShopCourierProvider>('/shop/logistics/provider', { signal });
  },

  async getCourierSettings(signal?: AbortSignal): Promise<ShopCourierSettings> {
    return shopFetch<ShopCourierSettings>(`${BASE}/logistics/settings`, { signal });
  },

  /** CAS on `expectedRevision`, like every settings PATCH here. A stale revision
   *  answers 409 `stale_write` (not `conflict`, despite the name) — the caller
   *  should treat the two alike. */
  async saveCourierSettings(patch: ShopCourierSettingsPatch): Promise<ShopCourierSettings> {
    return shopFetch<ShopCourierSettings>(`${BASE}/logistics/settings`, {
      method: 'PATCH',
      body: patch,
      subject: 'Delivery courier',
    });
  },

  async registerCourierWebhook(provider: 'fez' | 'terminal'): Promise<void> {
    await shopFetch<{ ok: boolean }>(`${BASE}/logistics/webhooks/register`, {
      method: 'POST',
      body: { provider },
      subject: 'Delivery courier',
    });
  },

  /**
   * Run ONE courier check. A courier's refusal comes back as a 200 with
   * `ok: false` and is a normal return here, not a throw — only a request that
   * cannot be run at all raises: 400 `bad_request`, 409
   * `provider_not_configured`, 409 `ship_from_incomplete` (which carries
   * `missing`).
   *
   * Books nothing and spends nothing. The one thing it can write is Terminal's
   * cached packaging id, which Terminal mints during a quote whether we asked
   * or not.
   */
  async runCourierDiagnostic(
    body: ShopCourierDiagnosticRequest,
  ): Promise<ShopCourierDiagnosticResult> {
    return shopFetch<ShopCourierDiagnosticResult>(`${BASE}/logistics/diagnostics`, {
      method: 'POST',
      body,
      subject: 'Delivery courier',
    });
  },

  /**
   * Ask the ACTIVE courier which places it will accept, and cache the answer.
   *
   * DOZENS OF CALLS AT A COURIER — one for the states and one per state — so it
   * is an operator pressing a button and never anything on a request path.
   * `country` is omitted for the shop's own, which is the only one today.
   *
   * Throws 409 `provider_not_configured` (ships by hand, or no credentials
   * here) and 409 `places_unsupported` (that courier publishes no list —
   * nothing is broken, and retrying cannot change it).
   */
  async refreshCourierExports(): Promise<ShopCourierExports> {
    /* NO BODY: a courier publishes its whole export catalogue in one call, so
       there is no country to ask about - unlike places, which is per country. */
    return shopFetch<ShopCourierExports>(`${BASE}/logistics/exports/refresh`, {
      method: 'POST',
    });
  },

  async refreshCourierPlaces(country?: string): Promise<ShopCourierPlaces> {
    return shopFetch<ShopCourierPlaces>(`${BASE}/logistics/places/refresh`, {
      method: 'POST',
      body: country ? { country } : {},
      subject: 'Delivery courier',
    });
  },

  /**
   * PER-DISTRICT DELIVERY (migration 0300). Only the shop's OPINION about a
   * district — the districts themselves come from `marketingApi.listAreas`, and
   * `ShopDeliveryAreas.tsx` joins the two on `areaKey`. A district with no row
   * here delivers at its state's zone rate, which is the pre-0300 behaviour.
   */
  async listDeliveryAreas(signal?: AbortSignal): Promise<ShopDeliveryArea[]> {
    const res = await shopFetch<{ items: ShopDeliveryArea[] }>(`${BASE}/delivery-areas`, {
      signal,
    });
    return res.items ?? [];
  },

  async saveDeliveryArea(
    areaKey: string,
    body: ShopDeliveryAreaWrite,
  ): Promise<ShopDeliveryArea> {
    const res = await shopFetch<{ area: ShopDeliveryArea }>(
      `${BASE}/delivery-areas/${seg(areaKey)}`,
      { method: 'PUT', id: areaKey, subject: 'Delivery area', body },
    );
    return res.area;
  },

  /** "Every district in this state" — one request, no compare-and-swap. */
  async saveDeliveryAreas(body: ShopDeliveryAreasBulkWrite): Promise<ShopDeliveryArea[]> {
    const res = await shopFetch<{ items: ShopDeliveryArea[] }>(`${BASE}/delivery-areas/bulk`, {
      method: 'POST',
      body,
      subject: 'Delivery areas',
    });
    return res.items ?? [];
  },

  async createShippingOption(
    draft: ShopShippingOptionDraft,
  ): Promise<ShopShippingOption> {
    const res = await shopFetch<{ option: ShopShippingOption }>(`${BASE}/shipping-options`, {
      method: 'POST',
      body: draft,
      subject: 'Shipping option',
    });
    return res.option;
  },

  async saveShippingOption(
    id: string,
    patch: ShopShippingOptionPatch,
  ): Promise<ShopShippingOption> {
    const res = await shopFetch<{ option: ShopShippingOption }>(
      `${BASE}/shipping-options/${seg(id)}`,
      { method: 'PATCH', id, subject: 'Shipping option', body: patch },
    );
    return res.option;
  },

  async deleteShippingOption(id: string): Promise<void> {
    await shopFetch<{ ok: boolean }>(`${BASE}/shipping-options/${seg(id)}`, {
      method: 'DELETE',
      id,
      subject: 'Shipping option',
    });
  },

  // -------------------------------------------------- order notifications
  /**
   * READ AND WRITE ARE BOTH `settings`, which only the owner and developers
   * hold. `permissions.ts` matches on the PREFIX and is method-agnostic, so
   * the one rule over `/api/shop/admin/notification-settings` closes the GET
   * to every other role exactly as it closes the PATCH — there is no
   * "everybody may look" half, and writing this block as though there were is
   * how a screen ends up rendering controls that each come back a 403. The
   * screen gates itself on `hasDomain(role, 'settings')` for that reason and
   * says so rather than calling the read.
   *
   * `requireAdmin` on the PATCH is a SECOND lock on the half that changes
   * where money-shaped news is sent; the domain gate has already refused
   * everyone without `settings` by the time it runs.
   */
  async getNotificationSettings(signal?: AbortSignal): Promise<ShopNotificationSettings> {
    const res = await shopFetch<{ settings: ShopNotificationSettings }>(
      `${BASE}/notification-settings`,
      { subject: 'Notification settings', signal },
    );
    return res.settings;
  },

  /**
   * CAS. A lost race is a 409 `stale_write`, which `api.ts` maps to
   * `StaleWriteError` carrying `expected` and `actual` — the settings screen
   * re-reads off that rather than retrying, because the other tab's change is
   * a real change and overwriting it silently is the failure the revision
   * exists to prevent.
   *
   * `subject` IS NAMED for the reason `NotFoundError` carries one at all: the
   * default is `'Post'`, and a route that is not deployed yet would otherwise
   * tell an owner "Post not found" about their notification settings.
   */
  async saveNotificationSettings(
    patch: ShopNotificationSettingsPatch,
  ): Promise<ShopNotificationSettings> {
    const res = await shopFetch<{ settings: ShopNotificationSettings }>(
      `${BASE}/notification-settings`,
      { method: 'PATCH', body: patch, subject: 'Notification settings' },
    );
    return res.settings;
  },

  /**
   * The tag vocabulary, one row per case-fold group under its canonical
   * spelling — what the tag box offers while somebody types, so a spelling is
   * reused rather than re-invented. Same no-params, `.strict()` rule as
   * categories.
   */
  async listTags(signal?: AbortSignal): Promise<ShopTag[]> {
    const res = await shopFetch<{ items: ShopTag[] }>(`${BASE}/tags`, { signal });
    return res.items ?? [];
  },

  // ----------------------------------------------------------------- orders
  /**
   * Keyset, filtered by status, and searchable by order number or email
   * (HANDOFF §2 A4). `search` is matched EXACTLY on the server — an order
   * number's check character is validated first, so 22 of every 23 guesses are
   * refused before a query runs — which is why the box says "exact".
   */
  async listOrders(
    query: {
      status?: OrderStatus;
      search?: string;
      /** Where it came from: the checkout, or recorded by hand. */
      source?: OrderSource;
      cursor?: string;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<ShopOrderRow>> {
    return shopFetch<Page<ShopOrderRow>>(`${BASE}/orders`, { query: { ...query }, signal });
  },

  async getOrder(id: string, signal?: AbortSignal): Promise<ShopOrderDetail> {
    return shopFetch<ShopOrderDetail>(`${BASE}/orders/${seg(id)}`, {
      id,
      subject: 'Order',
      signal,
    });
  },

  /** The support path: somebody has an order number and nothing else. */
  async getOrderByNumber(orderNumber: string, signal?: AbortSignal): Promise<ShopOrderDetail> {
    return shopFetch<ShopOrderDetail>(`${BASE}/orders/by-number/${seg(orderNumber)}`, {
      id: orderNumber,
      subject: 'Order',
      signal,
    });
  },

  /**
   * Record a sale made outside the online checkout. 201, answering with the
   * detail body plus `stock.failed` — lines that could not be taken out of
   * stock. Those are a warning, not a failure: the order is saved either way.
   */
  async createManualOrder(body: ManualOrderInput): Promise<ShopManualOrderResult> {
    return shopFetch<ShopManualOrderResult>(`${BASE}/orders/manual`, {
      method: 'POST',
      body,
      subject: 'Order',
    });
  },

  /**
   * Replace a manual order's details. A PUT: the body is the WHOLE order
   * again, so an optional field left out is cleared. 409 when `baseRevision`
   * is stale — somebody else saved it first.
   */
  async updateManualOrder(
    id: string,
    body: ManualOrderInput & { baseRevision: number },
  ): Promise<ShopManualOrderResult> {
    return shopFetch<ShopManualOrderResult>(`${BASE}/orders/${seg(id)}/manual`, {
      method: 'PUT',
      body,
      id,
      subject: 'Order',
    });
  },

  /** Void a manual order: it stops counting as a sale, and stock taken for
   *  it goes back. `reason` is omitted, not sent empty, when none was given. */
  async voidOrder(id: string, baseRevision: number, reason?: string): Promise<ShopOrderDetail> {
    return shopFetch<ShopOrderDetail>(`${BASE}/orders/${seg(id)}/void`, {
      method: 'POST',
      body: reason ? { baseRevision, reason } : { baseRevision },
      id,
      subject: 'Order',
    });
  },

  /** Every saved state of a manual order, newest first. */
  async listOrderRevisions(id: string, signal?: AbortSignal): Promise<ManualOrderRevision[]> {
    const res = await shopFetch<{ items: ManualOrderRevision[] }>(
      `${BASE}/orders/${seg(id)}/revisions`,
      { id, subject: 'Order', signal },
    );
    return Array.isArray(res?.items) ? res.items : [];
  },

  /** 201. `lines` names order lines and quantities — a partial shipment is normal. */
  async createFulfillment(
    orderId: string,
    body: {
      lines: { orderLineId: string; qty: number }[];
      carrier?: string | null;
      trackingNumber?: string | null;
    },
  ): Promise<ShopFulfillment> {
    const res = await shopFetch<{ fulfillment: ShopFulfillment }>(
      `${BASE}/orders/${seg(orderId)}/fulfillments`,
      { method: 'POST', body, id: orderId, subject: 'Order' },
    );
    return res.fulfillment;
  },

  /**
   * Advance a fulfilment.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * `order` HAS THREE STATES AND THIS TYPE NAMES ALL THREE. It used to say
   * `order?: ShopOrder`, which names two and gets one of them wrong.
   *
   * `PATCH /admin/fulfillments/:id` is three routes wearing one path.
   * `delivered` and `cancelled` return `{ fulfillment }` and stop — there is no
   * order-level transition to attempt, so the key is genuinely ABSENT. `shipped`
   * returns `{ fulfillment, order: settled }`, where `settled` is
   * `settleOrderFulfilled(…): Promise<Order | null>` and `null` is its ORDINARY
   * answer: settling is the one lifecycle move nobody asked for, so "not yet,
   * there are two parcels left" is a partial shipment reported rather than an
   * error raised. So `null` here means "this shipment did not complete the
   * order" — information, and a different fact from "this call could not have
   * completed one".
   *
   * WHY NOT `order: ShopOrder | null`, WHICH IS WHAT THE SHIPPED BRANCH SENDS?
   * Because the other two branches send no key, and a type that promises one
   * would move the same defect one step sideways rather than fix it: the guard
   * `if (res.order === null)` would then look exhaustive and let `undefined`
   * through to the property read. Optional AND nullable is the shape that makes
   * the compiler insist on a plain truthiness check, which is the only check
   * correct for all three.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `change` TAKES A BARE STATUS OR AN OBJECT, and the string form is kept so
   * every existing call site compiles unchanged. The object form is the ship
   * dialog's: `{ status: 'shipped', carrier, trackingNumber }` writes the
   * details in the same statement as the transition (the shipment email renders
   * them), and `{ carrier, trackingNumber }` with NO status edits a pending
   * parcel's details without transitioning — the server 409s it once the parcel
   * has shipped, because the email already told the customer. Per field: absent
   * means keep, explicit `null` means clear. `JSON.stringify` drops `undefined`
   * members, so an absent field genuinely never travels.
   */
  async setFulfillmentStatus(
    id: string,
    change:
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | {
          status?: 'shipped' | 'delivered' | 'cancelled';
          carrier?: string | null;
          trackingNumber?: string | null;
        },
  ): Promise<{ fulfillment: ShopFulfillment; order?: ShopOrder | null }> {
    return shopFetch<{ fulfillment: ShopFulfillment; order?: ShopOrder | null }>(
      `${BASE}/fulfillments/${seg(id)}`,
      {
        method: 'PATCH',
        body: typeof change === 'string' ? { status: change } : change,
        id,
        subject: 'Fulfilment',
      },
    );
  },

  /**
   * Asks the active courier for a price. 422 `weights_missing` carries the
   * lines to fix; 422 `provider_rejected` carries `accepted` — the place names
   * the courier said it WOULD take — when it named any.
   *
   * `routingCity` IS A DELIVERY ZONE FOR THIS REQUEST ONLY. It is what the
   * courier is told to deliver to, in place of the city on the order, and it is
   * stored nowhere: the customer's address is never rewritten. Omitted (rather
   * than sent as null) so an ordinary quote is still the empty body the route
   * has always taken.
   */
  async quoteCourier(fulfillmentId: string, routingCity?: string): Promise<ShopCourierQuote> {
    return shopFetch<ShopCourierQuote>(`${BASE}/fulfillments/${seg(fulfillmentId)}/courier/quote`, {
      method: 'POST',
      body: routingCity ? { routingCity } : {},
      id: fulfillmentId,
      subject: 'Parcel',
    });
  },

  /** `routingCity` must be the zone the quote was asked with — see `quoteCourier`. */
  async bookCourier(
    fulfillmentId: string,
    body: { optionId: string; quoteRef: string | null; routingCity?: string },
  ): Promise<ShopFulfillment> {
    const res = await shopFetch<{ fulfillment: ShopFulfillment }>(
      `${BASE}/fulfillments/${seg(fulfillmentId)}/courier/book`,
      { method: 'POST', body, id: fulfillmentId, subject: 'Parcel' },
    );
    return res.fulfillment;
  },

  /** Returns the whole answer, not just the parcel — `changed` and
   *  `transitioned` are what let the caller say whether anything moved. */
  async refreshCourier(fulfillmentId: string): Promise<ShopCourierRefresh> {
    return shopFetch<ShopCourierRefresh>(
      `${BASE}/fulfillments/${seg(fulfillmentId)}/courier/refresh`,
      { method: 'POST', body: {}, id: fulfillmentId, subject: 'Parcel' },
    );
  },

  async cancelCourier(fulfillmentId: string, reason?: string): Promise<ShopFulfillment> {
    const res = await shopFetch<{ fulfillment: ShopFulfillment }>(
      `${BASE}/fulfillments/${seg(fulfillmentId)}/courier/cancel`,
      { method: 'POST', body: reason ? { reason } : {}, id: fulfillmentId, subject: 'Parcel' },
    );
    return res.fulfillment;
  },

  /**
   * OWNER-ONLY. Cancelling releases stock and stops the order ever shipping.
   *
   * `refund` IS REQUIRED FOR A PAID ORDER (task-d3) — the server 400s a paid
   * cancel sent with none, because "cancel and leave the money unaddressed" is
   * no longer a default this route falls into silently. Omit it entirely for
   * a PENDING order, which the server refuses to see one at all: nothing was
   * captured, so there is nothing to choose an amount of.
   */
  async cancelOrder(id: string, refund?: CancelRefundChoice): Promise<ShopOrder> {
    const res = await shopFetch<{ order: ShopOrder }>(`${BASE}/orders/${seg(id)}/cancel`, {
      method: 'POST',
      body: refund === undefined ? {} : { refund },
      id,
      subject: 'Order',
    });
    return res.order;
  },

  /**
   * OWNER-ONLY, and the only route in this file that moves money.
   *
   * `idempotencyKey` IS REQUIRED BY THE SERVER (`min(8)`) and must be STABLE
   * across a retry: it is what stops a refund the network swallowed from being
   * paid twice when the operator clicks again. The caller mints one per refund
   * attempt and keeps it for the lifetime of that attempt — generating a fresh
   * one inside this function would defeat the whole mechanism.
   */
  async refundPayment(
    intentId: string,
    body: { amount: number; reason?: string; idempotencyKey: string },
  ): Promise<ShopRefund> {
    if (!Number.isSafeInteger(body.amount)) throw new MoneyShapeError(body.amount);
    const res = await shopFetch<{ refund: ShopRefund }>(
      `${BASE}/payments/intents/${seg(intentId)}/refunds`,
      { method: 'POST', body, id: intentId, subject: 'Payment' },
    );
    return res.refund;
  },

  // ------------------------------------------------------ payment settings
  /**
   * Which gateway takes a charge, and which currencies each one is switched
   * on for. Owner/developer only (`payments` domain). The response is the
   * FLAT shape, not wrapped in `{ settings }` — `routes.ts`'s
   * `paymentSettingsResponse` answers it directly, and `PATCH` answers the
   * identical shape.
   */
  async getPaymentSettings(signal?: AbortSignal): Promise<PaymentSettings> {
    return shopFetch<PaymentSettings>(`${BASE}/payments/settings`, {
      subject: 'Payment settings',
      signal,
    });
  },

  /**
   * CAS on `revision`. A lost race is a 409 `stale_write`, which `api.ts` maps
   * to `StaleWriteError` — the card re-reads off that rather than retrying,
   * the same rule every other settings screen in this file follows.
   */
  async savePaymentSettings(patch: PaymentSettingsPatch): Promise<PaymentSettings> {
    return shopFetch<PaymentSettings>(`${BASE}/payments/settings`, {
      method: 'PATCH',
      body: patch,
      subject: 'Payment settings',
    });
  },

  // -------------------------------------------------------------- customers
  /**
   * Buyers assembled from ORDERS and joined to accounts, not the other way
   * round (HANDOFF §2 A4). Guest checkout exists, so starting from
   * `shop_customers` would silently omit most of the people who have paid.
   *
   * Keyset by last order, like every other list in this codebase.
   */
  async listCustomers(
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<ShopBuyer>> {
    return shopFetch<Page<ShopBuyer>>(`${BASE}/customers`, { query: { ...query }, signal });
  },

  /**
   * "Not bought yet" — people with a basket, an account or a subscription and
   * no order at all (`server/shop/admin/prospects.ts`). `tab` defaults to
   * `'basket'` server-side when it is absent, so it is optional here too.
   */
  async listProspects(
    query: { tab?: ProspectTab; cursor?: string; limit?: number; query?: string } = {},
    signal?: AbortSignal,
  ): Promise<ShopProspectPage> {
    return shopFetch<ShopProspectPage>(`${BASE}/customers/prospects`, {
      query: { ...query },
      signal,
    });
  },

  /**
   * One prospect's basket, read by the same statement the broadcast drain
   * reads it with (`basketFor`'s own header explains why one serves both), and
   * what the shop has emailed them, newest first. `basket` is `null` for
   * somebody with nothing in it any more; `sends` is `[]` for somebody never
   * mailed — the ordinary case today, since production has sent no broadcasts.
   *
   * `seg`, NOT A BARE TEMPLATE INTERPOLATION: the address is a path segment
   * containing `@` and `.`, and the server decodes it once (`pathParam`), so
   * this encodes exactly once.
   */
  async getProspect(
    email: string,
    signal?: AbortSignal,
  ): Promise<{ basket: ShopBasket | null; sends: ShopSend[] }> {
    return shopFetch(`${BASE}/customers/prospects/${seg(email)}`, { signal });
  },
};

export type ShopApi = typeof shopApi;
