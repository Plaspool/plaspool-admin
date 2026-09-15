import type { DocNode } from '../../../shared/types';
import type {
  BulkTier,
  HoldState,
  ProductStatus,
  VariantStatus,
} from '../../../shared/commerce/catalog-port';

/**
 * One rung of a quantity ladder (migration 0600).
 *
 * RE-EXPORTED, NOT REDECLARED. The definition lives in
 * `shared/commerce/catalog-port.ts` — Catalog's own shared file — because the
 * totals engine needs it and that module is forbidden from importing anything
 * under `server/`. A second declaration here would be a second thing to keep in
 * step with the wire format.
 */
export type { BulkTier };

/**
 * Catalog's domain types — what a route returns and what a repo hands back.
 *
 * IN CATALOG'S OWN TREE AND NOT IN `shared/`, deliberately. `shared/` is
 * compiled into the browser bundle and is the compile surface of every other
 * subsystem; a `Product` there would make Catalog's internal shape part of
 * three other agents' builds for no benefit, since none of them may read
 * `shop_products` (R3) and all of them reach Catalog through `CatalogPort`. What
 * IS shared is the port's `VariantQuote`, which is deliberately narrower.
 *
 * The precedent is `posts.lifecycle_generation`, which `server/repo/posts.ts`
 * explains at length is NOT a field on `Post`: a concurrency token for one code
 * path does not belong on a type that ships to a client.
 */

/** `descriptionText` is absent for the same reason `Post` has no `contentText`:
 *  it is a server-side storage detail derived on write, never on the wire. */
export interface Product {
  id: string;
  slug: string | null;
  title: string;
  description: DocNode;
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
   * Hand-written search-listing copy (migration 0440). `null` means "use the
   * defaults" — the storefront falls back to `title` / the trimmed description.
   * Deliberately public: rendering these into meta tags is their entire job.
   */
  seoTitle: string | null;
  seoDescription: string | null;
  /**
   * The card/summary line (migration 0580). `null` means "derive it": the
   * storefront projection falls back to the first non-empty block of the
   * description. Admin surfaces see the `null` and render the derived value as
   * a PLACEHOLDER, so "inherited" and "set" stay visually distinct.
   */
  overview: string | null;
  /**
   * `summarise(description)`, derived on write (migration 0580) — ALWAYS a
   * string, never null once the backfill has run.
   *
   * ON `Product` even though `descriptionText` deliberately is not, and the
   * difference is that this one has two consumers that cannot work without it.
   * `LIST_PRODUCT_COLUMNS` excludes `description`, so the storefront list has no
   * document to derive from and must read this. And the admin editor renders it
   * as the overview input's PLACEHOLDER, which is what keeps "inherited" and
   * "set" visually distinct. `descriptionText` is a whole-document blob nothing
   * reads; this is a short string two screens depend on.
   */
  overviewFallback: string;
  /** Whether the quantity ladder applies here (migration 0600). Default true. */
  bulkDiscountEnabled: boolean;
  /** Migration 1220. `null` is an ordinary product; `'pack'` a box staff fill by hand. */
  boxMode: 'pack' | 'built' | 'auto' | null;
  authorId: string;
  /** The CAS token. Every write carries the revision it derived from. */
  revision: number;
}


/**
 * A product as an ANONYMOUS CUSTOMER sees it: the row, plus its image ids
 * resolved to public URLs.
 *
 * WHY THE URLS ARE A SEPARATE SHAPE AND NOT TWO MORE FIELDS ON `Product`. The
 * URLs point at `/api/public/images/:id`, which serves an image only while an
 * ACTIVE product (or a published post) references it — see
 * `server/repo/public-images.ts`. On a draft or archived product every one of
 * them 404s, so putting them on `Product` would ship a guaranteed-broken URL to
 * the admin surface and invite a form to render it. The storefront routes are the
 * only place the resolution is true, so the storefront shape is the only place it
 * belongs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO `FIELD_DISPOSITION` FOR THIS SHAPE, AND THAT IS A GAP, NOT A
 * DECISION.
 *
 * `server/repo/public-projection.ts` classifies every key of `Post` as
 * `'public' | 'private'` in an exhaustive `Record`, so adding a field to `Post`
 * is a COMPILE ERROR until somebody decides in writing whether an anonymous
 * reader may see it. Catalog has no such control: the storefront routes return
 * the whole `Product`, which today means `authorId`, `revision` and `deletedAt`
 * are on the public wire, and the next field added to `Product` joins them
 * silently. `coverImageUrl` and `imageUrls` are deliberately public — they are
 * the reason this type exists — but they are extending a surface that is
 * allow-listed by nothing.
 *
 * Closing it means an allow-list mapper here of the kind `rowToPublicPost` is,
 * which changes what the storefront already returns and therefore belongs to
 * whoever owns that contract. Recorded here so the absence is a known one.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface StorefrontProduct extends Product {
  /** `null` when the product has no cover, or its cover id is empty. */
  coverImageUrl: string | null;
  /**
   * Positionally parallel to `imageIds` MINUS any empty entry, which names no
   * image and would resolve to `/api/public/images/` — a URL that is not a 404
   * but the collection route with a trailing slash.
   */
  imageUrls: string[];
  /**
   * RESOLVED, AND THEREFORE NEVER `null` — unlike `Product.overview`.
   *
   * `toStorefrontProduct` substitutes `summarise(description)` when the column
   * is NULL, so the storefront renders this string and owns no fallback logic
   * of its own. That is the whole point of the field: the derivation used to
   * live on the far side of the network, where it could disagree with what the
   * admin previewed.
   */
  overview: string;
  /**
   * The ladder that actually applies to this product, already resolved through
   * `bulkDiscountEnabled` and the store-wide default — so an EMPTY ARRAY means
   * "no bulk discount here", and the storefront needs no second rule to decide.
   * Ascending by `minQty`.
   */
  bulkTiers: BulkTier[];
}

/**
 * A variant, plus the public URL of the photograph of THIS colour.
 *
 * The same rule and the same function as `StorefrontProduct` — one definition
 * of the public URL, resolved on the routes where it is actually true. Added
 * because the storefront had no way to draw a colour's own photograph: the
 * variant carried a bare `imageId`, and the only way to use it there was to
 * re-derive `/api/public/images/:id` on the far side of the network, which is
 * the second definition `mapping.ts` exists to prevent.
 *
 * `Omit<…, 'costMinor'>` IS THE FIRST DELIBERATE STRIP ON THIS WIRE. The
 * FIELD_DISPOSITION gap above still stands for everything else — but what the
 * shop pays per unit is commercial information with no storefront use, so
 * `toStorefrontVariant` removes it and this type says so, making a future
 * widening a compile error instead of a silent leak. `compareAtMinor` stays,
 * on purpose: the sale strikethrough is the reason it exists.
 *
 * `shippingWeightGrams` IS THE SECOND STRIP (migration 1180), and it is here
 * because of the gap the paragraph above describes rather than in spite of it:
 * adding a column to `Variant` joins this wire silently, and the field arrived
 * on one. `weightGrams` is what the shop SHOWS and stays — it is the spool
 * size on the product page. The shipping weight is an internal packing figure
 * the storefront has no use for, because delivery is priced server-side and a
 * shopper is quoted an amount rather than a weight.
 */
export interface StorefrontVariant
  extends Omit<VariantWithPrice, 'costMinor' | 'shippingWeightGrams'> {
  /** `null` when nobody has photographed this colour yet. */
  imageUrl: string | null;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  optionValues: Record<string, string>;
  position: number;
  /** Grams. What the shop SHOWS — the spool size on the storefront. */
  weightGrams: number | null;
  /**
   * Grams. What DELIVERY is priced on (migration 1180). NULL means "use
   * `weightGrams`", so an untouched variant prices exactly as it always did.
   * UNRESOLVED on this shape: the admin has to be able to show the difference
   * between "same as the displayed weight" and a deliberate override.
   */
  shippingWeightGrams: number | null;
  status: VariantStatus;
  /**
   * The photograph of THIS option (migration 0009).
   *
   * The options in this store are colours, and a colour is the thing a picture
   * settles: the product cover can only show one spool, so a customer choosing
   * between eight PLA colours was choosing between eight words.
   */
  imageId: string | null;
  /**
   * The colour code of this option (migration 0010) — `#8b5a2b`, lowercase,
   * NULL for anything that is not a colour or has not been given one. A column
   * rather than a key in `optionValues` because the tuple is the variant's
   * identity and feeds SKU derivation; a swatch is presentation.
   */
  colorHex: string | null;
  /**
   * The struck-through "was" price, minor units (migration 0400). NULL means
   * "not on sale". Display-only — never an input to a quote or an order total —
   * which is why it is a plain column and not a `shop_prices` row. Currency is
   * implied by the current price row's. Deliberately public.
   */
  compareAtMinor: number | null;
  /**
   * What the shop pays per unit, minor units (migration 0420). NULL means
   * "never recorded". ⚠️ ADMIN-ONLY: `toStorefrontVariant` strips it, and
   * `StorefrontVariant` omits it at the type level so widening it back is a
   * compile error rather than a silent leak.
   */
  costMinor: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A variant plus the two things a storefront always needs beside it.
 *
 * `price` is null when no current price row exists, which is a real state — a
 * variant created but not yet priced — and not an error. `available` is derived
 * from `on_hand - reserved` and is null when the variant has no inventory row
 * at all; a shop that renders "0 left" for a variant nobody has stocked is
 * telling the customer something different from "we do not track this".
 */
export interface VariantWithPrice extends Variant {
  price: { amount: number; currency: string } | null;
  available: number | null;
  backorderable: boolean;
  /**
   * Whether any `shop_order_lines` row has ever referenced this variant
   * (issue #18). Carried on the read so the admin panel can hide Delete
   * outright rather than offer a control that only ever answers 409 — the
   * panel already shows price and stock on this same row, and "has this ever
   * sold" is one more fact about it, not a separate request.
   */
  everOrdered: boolean;
}

/** A row of `shop_inventory`, for the admin surface. `available` is derived. */
export interface InventoryLevel {
  variantId: string;
  onHand: number;
  reserved: number;
  available: number;
  backorderable: boolean;
  updatedAt: number;
}

/** A row of `shop_inventory_holds` (amendment A-CAT-002). */
export interface InventoryHold {
  reservationId: string;
  variantId: string;
  qty: number;
  state: HoldState;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * The patchable half of a product. **NO `slug` KEY, and no `status` key.**
 *
 * Slugs are server-authoritative, exactly as `PostPatch` makes them (spec §4.5):
 * a published URL is a promise, not a value that follows the heading around.
 * `status` is absent so a PATCH body cannot smuggle a lifecycle change past the
 * lifecycle rules — the same omission `savePost`'s SET list makes, and the thing
 * that keeps the generation trigger meaningful.
 */
export interface ProductPatch {
  title?: string;
  description?: DocNode;
  category?: string;
  tags?: string[];
  coverImageId?: string | null;
  imageIds?: string[];
  /** `null` (or `''`, normalised) clears back to "use the defaults". */
  seoTitle?: string | null;
  seoDescription?: string | null;
  /** `null` (or `''`, normalised) clears back to "derive from the description". */
  overview?: string | null;
  /** Absent leaves it alone; the column's own default is `true`. */
  bulkDiscountEnabled?: boolean;
  /** Migration 1220. `null` switches the box off. Phase 1 accepts only `'pack'`. */
  boxMode?: 'pack' | null;
}

/** The patchable half of a variant. `productId` is absent: a variant does not
 *  move between products, it is discontinued and a new one is created. */
export interface VariantPatch {
  sku?: string;
  optionValues?: Record<string, string>;
  position?: number;
  weightGrams?: number | null;
  /** `null` clears the override, so delivery rejoins `weightGrams`. Grams,
   *  non-negative int. Migration 1180. */
  shippingWeightGrams?: number | null;
  status?: VariantStatus;
  /** `null` clears it. Validated as a committed image, like a product's cover. */
  imageId?: string | null;
  /** `null` clears it. Lowercased and shape-checked on the way in. */
  colorHex?: string | null;
  /** `null` clears it — "no longer on sale". Minor units, non-negative int. */
  compareAtMinor?: number | null;
  /** `null` clears it. Minor units, non-negative int. Admin-only on the wire. */
  costMinor?: number | null;
  /**
   * The inventory POLICY flip the edit modal was missing (owner's queue,
   * 2026-08-25 — "updateVariant cannot flip backorderable"). Lives on
   * `shop_inventory`, not `shop_variants`; `updateVariant` writes it in the
   * same statement, exactly as `createVariant` already writes both tables.
   */
  backorderable?: boolean;
}
