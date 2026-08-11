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

/** A product with its variants, for `GET /api/shop/products/:slug`. */
export interface ProductWithVariants extends Product {
  variants: VariantWithPrice[];
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  optionValues: Record<string, string>;
  position: number;
  weightGrams: number | null;
  status: VariantStatus;
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

/** A row of `shop_product_revisions`, as the history endpoint returns it. */
export interface ProductRevision {
  id: string;
  productId: string;
  revision: number;
  createdAt: number;
  authorId: string;
  title: string;
  description: DocNode;
  status: string;
  kind: 'edit' | 'status';
  note: string | null;
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
}
