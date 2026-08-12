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
 * Minor units → what a person reads. `1990, 'GBP'` → `£19.90`.
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

  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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

export interface ShopVariant {
  id: string;
  productId: string;
  sku: string;
  optionValues: Record<string, string>;
  position: number;
  weightGrams: number | null;
  status: VariantStatus;
  createdAt: number;
  updatedAt: number;
  /** `null` is "created but never priced", which is a real state, not an error. */
  price: { amount: number; currency: string } | null;
  /** `null` is "no inventory row", which is not the same as "none left". */
  available: number | null;
  backorderable: boolean;
  /**
   * The photograph of THIS option (migration 0009). `null` until one is set.
   *
   * The options in this store are colours, and a colour is the thing a picture
   * settles — the product cover can only show one of them.
   */
  imageId: string | null;
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
}

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
  refundedTotal: number;
  status: OrderStatus;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  placedAt: number;
  paidAt: number | null;
  fulfilledAt: number | null;
  cancelledAt: number | null;
  revision: number;
  checkoutId: string;
  paymentIntentId: string | null;
}

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
}

export interface ShopTimelineEntry {
  id: string;
  type: string;
  message: string;
  occurredAt: number;
  actorId: string | null;
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
  createdAt: number;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
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

export interface ShopOrderDetail {
  order: ShopOrder;
  lines: ShopOrderLine[];
  fulfillments: ShopFulfillment[];
  timeline: ShopTimelineEntry[];
  emails: ShopEmailIntent[];
  /** `null` until Payments is wired at the composition root (§1.9). */
  payment: ShopPayment | null;
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
  /** MINOR UNITS, net of refunds, over paid orders. Windows from `generatedAt`. */
  last24h: number;
  last7d: number;
  last30d: number;
}

export interface EmailBacklog {
  /** Written, not yet handed to a mailer, still inside the attempt budget. */
  pending: number;
  /** Out of attempts. NOTHING WILL RETRY THESE without a human. */
  stuck: number;
  /** Handed to a mailer. Counted so "0 pending" can be told from "no email ever". */
  sent: number;
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

export interface ShopCategory {
  name: string;
  /** Products carrying it — drafts, archived and trash included. */
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
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<ShopProduct>> {
    return shopFetch<Page<ShopProduct>>(`${BASE}/products`, { query: { ...query }, signal });
  },

  async getProduct(id: string, signal?: AbortSignal): Promise<ShopProductDetail> {
    const res = await shopFetch<{ product: ShopProductDetail }>(
      `${BASE}/products/${seg(id)}`,
      { id, subject: 'Product', signal },
    );
    return res.product;
  },

  /** 201, not 200. */
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

  /** 201. `optionValues` is the variant's own axis map (`{ Size: 'M' }`). */
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
    },
  ): Promise<ShopVariant> {
    const res = await shopFetch<{ variant: ShopVariant }>(
      `${BASE}/products/${seg(productId)}/variants`,
      { method: 'POST', body, id: productId, subject: 'Product' },
    );
    return res.variant;
  },

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
    },
  ): Promise<ShopVariant> {
    const res = await shopFetch<{ variant: ShopVariant }>(`${BASE}/variants/${seg(id)}`, {
      method: 'PATCH',
      body,
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

  /** `reason` is MANDATORY server-side: an unexplained stock change is the one
   *  you will most wish you had logged. */
  async adjustInventory(
    variantId: string,
    delta: number,
    reason: string,
  ): Promise<{ variantId: string; onHand: number; reserved: number; available: number }> {
    const res = await shopFetch<{
      inventory: { variantId: string; onHand: number; reserved: number; available: number };
    }>(`${BASE}/inventory/${seg(variantId)}/adjust`, {
      method: 'POST',
      body: { delta, reason },
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

  // ----------------------------------------------------------------- orders
  /**
   * Keyset, filtered by status, and searchable by order number or email
   * (HANDOFF §2 A4). `search` is matched EXACTLY on the server — an order
   * number's check character is validated first, so 22 of every 23 guesses are
   * refused before a query runs — which is why the box says "exact".
   */
  async listOrders(
    query: { status?: OrderStatus; search?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<ShopOrder>> {
    return shopFetch<Page<ShopOrder>>(`${BASE}/orders`, { query: { ...query }, signal });
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
   * Advance a fulfilment. `shipped` also attempts the ORDER's own `fulfilled`
   * transition, which ordinarily answers "not yet, two parcels to go" — so
   * `order` in the response is optional and its absence is not a failure.
   */
  async setFulfillmentStatus(
    id: string,
    status: 'shipped' | 'delivered' | 'cancelled',
  ): Promise<{ fulfillment: ShopFulfillment; order?: ShopOrder }> {
    return shopFetch<{ fulfillment: ShopFulfillment; order?: ShopOrder }>(
      `${BASE}/fulfillments/${seg(id)}`,
      { method: 'PATCH', body: { status }, id, subject: 'Fulfilment' },
    );
  },

  /** OWNER-ONLY. Cancelling releases stock and stops the order ever shipping. */
  async cancelOrder(id: string): Promise<ShopOrder> {
    const res = await shopFetch<{ order: ShopOrder }>(`${BASE}/orders/${seg(id)}/cancel`, {
      method: 'POST',
      body: {},
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
};

export type ShopApi = typeof shopApi;
