import type { DocNode } from '../../../shared/types';
import type {
  HoldState,
  ProductStatus,
  VariantStatus,
} from '../../../shared/commerce/catalog-port';

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
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  optionValues: Record<string, string>;
  position: number;
  weightGrams: number | null;
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
}

/** The patchable half of a variant. `productId` is absent: a variant does not
 *  move between products, it is discontinued and a new one is created. */
export interface VariantPatch {
  sku?: string;
  optionValues?: Record<string, string>;
  position?: number;
  weightGrams?: number | null;
  status?: VariantStatus;
  /** `null` clears it. Validated as a committed image, like a product's cover. */
  imageId?: string | null;
  /** `null` clears it. Lowercased and shape-checked on the way in. */
  colorHex?: string | null;
}
