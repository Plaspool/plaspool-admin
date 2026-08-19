import { randomUUID } from 'node:crypto';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { normalizeBlobId, publicImageUrl } from '../../repo/public-projection';
import type { DocNode } from '../../../shared/types';
import type {
  HoldState,
  ProductStatus,
  VariantStatus,
} from '../../../shared/commerce/catalog-port';
import type {
  InventoryHold,
  InventoryLevel,
  Product,
  StorefrontProduct,
  StorefrontVariant,
  Variant,
  VariantWithPrice,
} from './types';

/**
 * The ONLY place a Catalog row becomes a domain object.
 *
 * Same reason `server/repo/mapping.ts` exists: `db.execute(sql`…`)` hands back
 * raw driver rows — snake_case keys, int8 as a STRING on Neon and a number on
 * stock PGlite, jsonb as whatever the driver decided — so a row is not a
 * `Product`, and casting one to `Product` is a lie the type system accepts
 * without complaint.
 *
 * Every bigint read goes through `toEpochMs`. That is not defensive style: the
 * PGlite/Neon int8 divergence was invisible until it was a production 500
 * (`row.expires_at <= now` becomes a string comparison, `row.created_at + TTL`
 * becomes concatenation), and `server/test/harness.ts` configures PGlite to hand
 * int8 back as a string precisely so this is exercised rather than trusted.
 */

// ------------------------------------------------------------------------ ids

/**
 * The prefixed, client-safe id scheme (contract §10). Same shape as
 * `server/repo/posts.ts:newId`, so a commerce id is indistinguishable in form
 * from a post id and neither is a guessable sequential integer on the wire.
 *
 * `prd_` and `var_` are contract §10's. `prc_` (a price row), `prv_` (a
 * product revision) and `cat_` (a managed category, migration 0200) are
 * additions — §10's list names no prefix for any of them, because none of those
 * tables appears in it. All three are internal: a price id is never quoted to a
 * customer, a revision id is admin-only, and a category is addressed publicly by
 * its `slug` rather than its id.
 *
 * Time-prefixed in base 36 so ids sort roughly by creation, which is what makes
 * `ORDER BY id` a usable tiebreak in the keyset cursor.
 */
export function newCatalogId(prefix: 'prd_' | 'var_' | 'prc_' | 'prv_' | 'cat_'): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// -------------------------------------------------------------------- columns

/**
 * Every column needed to build a `Product`, enumerated.
 *
 * NO `SELECT *` AND NO `RETURNING *` ANYWHERE, for the reason
 * `server/repo/mapping.ts` gives: `shop_products` also holds `description_text`,
 * which is a derived storage detail that is not on `Product` and must not ride
 * along into a response, and `lifecycle_generation`, which is a concurrency
 * token for one code path. A star would put both in every list response.
 */
export const PRODUCT_COLUMNS: string[] = [
  'id',
  'slug',
  'title',
  'description',
  'status',
  'category',
  'tags',
  'cover_image_id',
  'image_ids',
  'created_at',
  'updated_at',
  'published_at',
  'deleted_at',
  'author_id',
  'revision',
];

/**
 * A list response ships no documents. `description` is a whole `DocNode` per
 * row, and shipping every one of them to render a grid of cards is the mistake
 * `LIST_POST_COLUMNS` exists to avoid on the blog side.
 */
export const LIST_PRODUCT_COLUMNS: string[] = PRODUCT_COLUMNS.filter(
  (c) => c !== 'description',
);

/** `PRODUCT_COLUMNS` qualified for a join, e.g. `p.id, p.slug, …`. */
export function productColumns(alias: string, columns: string[] = PRODUCT_COLUMNS): string {
  return columns.map((c) => `${alias}.${c}`).join(', ');
}

export const VARIANT_COLUMNS: string[] = [
  'id',
  'product_id',
  'sku',
  'option_values',
  'position',
  'weight_grams',
  'status',
  'image_id',
  'color_hex',
  'created_at',
  'updated_at',
];

// ------------------------------------------------------------------- mappers

/**
 * jsonb arrives parsed from both drivers today. Handling the string form as well
 * is the same insurance `toEpochMs` is: the int8 divergence was invisible until
 * it was a production 500, and a document silently becoming the string
 * `"[object Object]"` is worse.
 */
function json<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    // Nullable and UNIQUE — drafts hold NULL until titled or published.
    slug: row.slug == null ? null : String(row.slug),
    title: String(row.title),
    /*
     * `description` is absent from a LIST select, so this mapper is shared by
     * both shapes and fills the empty document rather than `undefined`. A
     * consumer that gets `{ type: 'doc', content: [] }` renders nothing; one
     * that gets `undefined` throws in whatever walks it.
     */
    description: json<DocNode>(row.description) ?? { type: 'doc', content: [] },
    status: row.status as ProductStatus,
    category: String(row.category),
    tags: textArray(row.tags),
    coverImageId: row.cover_image_id == null ? null : String(row.cover_image_id),
    imageIds: textArray(row.image_ids),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    publishedAt: toEpochMsOrNull(row.published_at),
    deletedAt: toEpochMsOrNull(row.deleted_at),
    authorId: String(row.author_id),
    revision: Number(row.revision),
  };
}

/**
 * A product, plus the public URL of each image it names (HANDOFF §2 A5.4).
 *
 * THE SAME RESOLUTION RULE AS `PublicCoverImage.url`, VIA THE SAME FUNCTION.
 * `publicImageUrl` is described in `server/repo/public-projection.ts` as "ONE
 * definition of the public URL for an image id, shared by the projection, the
 * docs and the client", and a second one here would be a second thing to get
 * wrong the day that path changes — the storefront would keep pointing at the old
 * route with nothing failing to say so.
 *
 * NORMALISED FIRST, for the reason that file also records: the id is stored both
 * bare and `asset:`/`idb:`-prefixed, and an unnormalised prefix produces
 * `/api/public/images/asset:img_x`, which 404s on a live product.
 *
 * EMPTY IDS ARE DROPPED RATHER THAN RESOLVED. `/api/public/images/` is not the
 * image route with a bad id; it is a different path entirely, and emitting it
 * would put a URL in the response that cannot 404 in the way the client expects.
 * Product writes refuse empty ids (`checkImageRefs`), so this only ever fires on
 * rows written before that check existed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS CHECK WHETHER THE URL WILL RESOLVE. Plan D4
 * publishes the rule and lets the serving route decide; a projection that
 * pre-flighted every id would be a query per image on the storefront's hottest
 * response, and it would still be a guess by the time the browser asked.
 */
export function toStorefrontProduct(product: Product): StorefrontProduct {
  const cover = product.coverImageId == null ? '' : normalizeBlobId(product.coverImageId);
  return {
    ...product,
    coverImageUrl: cover === '' ? null : publicImageUrl(cover),
    imageUrls: product.imageIds
      .map(normalizeBlobId)
      .filter((id) => id !== '')
      .map(publicImageUrl),
  };
}

/**
 * A variant as the storefront needs it: its `imageId` resolved through the same
 * `publicImageUrl` the product's cover goes through.
 *
 * NORMALISED FIRST and EMPTY DROPPED, for the reasons `toStorefrontProduct`
 * gives at length — the id is stored both bare and `asset:`/`idb:`-prefixed,
 * and `/api/public/images/` is a different route rather than that route with a
 * bad id.
 */
export function toStorefrontVariant(variant: VariantWithPrice): StorefrontVariant {
  const id = variant.imageId == null ? '' : normalizeBlobId(variant.imageId);
  return { ...variant, imageUrl: id === '' ? null : publicImageUrl(id) };
}

export function rowToVariant(row: Record<string, unknown>): Variant {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    sku: String(row.sku),
    optionValues: json<Record<string, string>>(row.option_values) ?? {},
    position: Number(row.position),
    weightGrams: row.weight_grams == null ? null : Number(row.weight_grams),
    status: row.status as VariantStatus,
    /** Migration 0009. NULL until somebody uploads a photograph of this colour. */
    imageId: row.image_id == null ? null : String(row.image_id),
    /** Migration 0010. NULL until a colour option carries a code. */
    colorHex: row.color_hex == null ? null : String(row.color_hex),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

/**
 * A variant joined to its current price and its inventory row.
 *
 * Both joins are LEFT: a variant with no price and a variant with no stock row
 * are real states, not errors, and an INNER JOIN would make them invisible to
 * the admin surface that has to fix them.
 */
export function rowToVariantWithPrice(row: Record<string, unknown>): VariantWithPrice {
  return {
    ...rowToVariant(row),
    price:
      row.price_amount == null
        ? null
        : { amount: Number(row.price_amount), currency: String(row.price_currency) },
    /*
     * DERIVED IN SQL, NOT HERE. `on_hand - reserved` is computed by the query so
     * that the same expression orders, filters and returns it — a second
     * implementation in TypeScript is a second thing to disagree with the
     * predicate `reserve` actually enforces.
     */
    available: row.available == null ? null : Number(row.available),
    backorderable: row.backorderable === true,
    everOrdered: row.ever_ordered === true,
  };
}

export function rowToInventoryLevel(row: Record<string, unknown>): InventoryLevel {
  const onHand = Number(row.on_hand);
  const reserved = Number(row.reserved);
  return {
    variantId: String(row.variant_id),
    onHand,
    reserved,
    // Derived, never stored (brief §2): two columns that must sum to a third are
    // three ways to be inconsistent.
    available: onHand - reserved,
    backorderable: row.backorderable === true,
    updatedAt: toEpochMs(row.updated_at),
  };
}

export function rowToInventoryHold(row: Record<string, unknown>): InventoryHold {
  return {
    reservationId: String(row.reservation_id),
    variantId: String(row.variant_id),
    qty: Number(row.qty),
    state: row.state as HoldState,
    expiresAt: toEpochMs(row.expires_at),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}
