import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { rejectNul } from '../../repo/cursor';
import { committedImageIds } from '../../repo/images';
import { normalizeBlobId } from '../../repo/public-projection';
import type { AuthUser } from '../../../shared/types';
import type { VariantStatus } from '../../../shared/commerce/catalog-port';
import { VARIANT_COLUMNS, newCatalogId, rowToVariant, rowToVariantWithPrice } from './mapping';
import type { Variant, VariantPatch, VariantWithPrice } from './types';

/**
 * Variants — the sellable unit.
 *
 * NO CAS HERE, AND THAT IS A DECISION RATHER THAN AN OMISSION. `shop_products`
 * carries `revision` because a product is a document two people edit at once and
 * losing one of their edits is the failure the whole CAS path exists to prevent.
 * A variant is a tuple of short scalars — a SKU, a position, a weight, a status
 * — and there is no merge to lose: a PATCH names the fields it sets and each one
 * is last-writer-wins by construction. Adding a revision column would create a
 * conflict surface where the domain has none, and every admin edit would then
 * need a token nobody has a use for.
 *
 * The two things that DO need database-level protection have it, and neither is
 * a CAS: `sku` is UNIQUE (a SKU is an address, and two products claiming one is
 * a picking error in a warehouse), and stock lives in `shop_inventory` where
 * `reserve` is a single conditional statement.
 *
 * A NEW VARIANT GETS AN INVENTORY ROW IN THE SAME STATEMENT. A variant that
 * exists with no inventory row is a variant `reserve` answers `unknown_variant`
 * for — indistinguishable, at the port, from one that was deleted. Creating both
 * together means that state is unreachable through this API rather than merely
 * unlikely.
 */

/**
 * The SKU is already taken (`shop_variants_sku_unique`).
 *
 * IT CARRIES THE SKU, AND THE SHOP APP RENDERS IT AS A 409, because "already
 * in use" is not the same complaint as "malformed" and a caller cannot act on
 * the two the same way. Both used to arrive as a bare 400 `detail: 'sku'`, and
 * the screen could say no more than "the sku was refused" — which sent somebody
 * to check the characters in a SKU whose only problem was that it existed.
 *
 * Still a `BadRequestError` underneath so that a caller reaching this outside
 * the shop app's `onError` — a direct repository call, a future mount — still
 * gets a 4xx that stops the retry policy rather than a 500 that does not.
 * `server/shop/app.ts` upgrades it to the 409 the condition actually is.
 */
export class DuplicateSkuError extends BadRequestError {
  readonly sku: string;

  constructor(sku: string) {
    super('sku');
    this.name = 'DuplicateSkuError';
    this.sku = sku;
  }
}

export interface CreateVariantInput {
  sku: string;
  optionValues?: Record<string, string>;
  position?: number;
  weightGrams?: number | null;
  /** Stock at creation. Defaults to zero — nothing is in the warehouse yet. */
  onHand?: number;
  backorderable?: boolean;
  /** The photograph of this colour. Validated as a committed image. */
  imageId?: string | null;
}

/**
 * The variant's image must name a COMMITTED image, exactly as a product's cover
 * must (`checkImageRefs` in `products.ts`, whose header explains at length why
 * this is advisory rather than a referential invariant).
 *
 * The protection that actually keeps the bytes alive is the other half:
 * `server/repo/images.ts#REFERENCE_SET` unions `shop_variants.image_id`, so an
 * image a variant names is never collected in the first place. This check exists
 * so a typo becomes a 400 at the boundary instead of a broken colour swatch.
 *
 * An empty string is not an id — `null` clears the field, and every consumer
 * downstream already skips `''`.
 */
async function checkVariantImage(db: Db, imageId: string | null | undefined): Promise<void> {
  if (imageId == null || imageId === '') return;
  const known = await committedImageIds(db, [imageId]);
  if (!known.has(normalizeBlobId(imageId))) throw new BadRequestError('imageId');
}

/**
 * Variants of one product, joined to the current price and the stock row.
 *
 * ONE STATEMENT, NOT N+1. A product page renders every variant with its price
 * and availability; doing that as a query per variant is the shape that looks
 * fine on a two-variant product and takes forty round trips on a size-by-colour
 * grid. `pr.effective_to IS NULL` is the "current price" predicate, and the
 * partial unique index guarantees it matches at most one row — without that
 * index this join would silently multiply rows.
 */
export async function listVariantsWithPrices(
  db: Db,
  productId: string,
): Promise<VariantWithPrice[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(VARIANT_COLUMNS.map((c) => `v.${c}`).join(', '))},
           pr.amount AS price_amount, pr.currency AS price_currency,
           i.on_hand - i.reserved AS available, i.backorderable
      FROM shop_variants v
      LEFT JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
      LEFT JOIN shop_inventory i ON i.variant_id = v.id
     WHERE v.product_id = ${productId}
     ORDER BY v.position ASC, v.id ASC`);
  return res.rows.map(rowToVariantWithPrice);
}

export async function getVariant(db: Db, id: string): Promise<Variant | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(VARIANT_COLUMNS.join(', '))} FROM shop_variants WHERE id = ${id}`);
  const row = res.rows[0];
  return row ? rowToVariant(row) : null;
}

export async function createVariant(
  db: Db,
  productId: string,
  input: CreateVariantInput,
  _actor: AuthUser,
): Promise<Variant> {
  const now = Date.now();
  const id = newCatalogId('var_');
  const sku = rejectNul(input.sku.trim(), 'sku');
  if (!sku) throw new BadRequestError('sku');
  const onHand = input.onHand ?? 0;
  if (!Number.isInteger(onHand) || onHand < 0) throw new BadRequestError('onHand');
  await checkVariantImage(db, input.imageId);

  /*
   * `position` DEFAULTS TO THE END, computed in SQL rather than read first.
   * `coalesce(max(position) + 1, 0)` inside the INSERT means two concurrent
   * creates cannot both read "3" and both claim it — and position is not unique,
   * so a collision would not be an error, it would be two variants in an order
   * that depends on the planner.
   */
  const position =
    input.position !== undefined
      ? sql`${input.position}`
      : sql`(SELECT coalesce(max(position) + 1, 0) FROM shop_variants WHERE product_id = ${productId})`;

  const row = await db
    .execute(sql`
      WITH prod AS (
        SELECT id FROM shop_products WHERE id = ${productId}
      ), ins AS (
        INSERT INTO shop_variants (id, product_id, sku, option_values, position,
                                   weight_grams, status, image_id, created_at, updated_at)
        SELECT ${id}, prod.id, ${sku},
               ${JSON.stringify(input.optionValues ?? {})}::jsonb, ${position},
               ${input.weightGrams ?? null}, 'active', ${input.imageId || null}, ${now}, ${now}
          FROM prod
        RETURNING ${sql.raw(VARIANT_COLUMNS.join(', '))}
      ), inv AS (
        INSERT INTO shop_inventory (variant_id, on_hand, reserved, backorderable, updated_at)
        SELECT ins.id, ${onHand}, 0, ${input.backorderable ?? false}, ${now} FROM ins
        RETURNING 1
      )
      SELECT ${sql.raw(VARIANT_COLUMNS.join(', '))} FROM ins`)
    .then((res) => res.rows[0])
    .catch((err: unknown) => {
      if (uniqueViolation(err) === 'shop_variants_sku_unique') throw new DuplicateSkuError(sku);
      throw err;
    });

  /*
   * No row means the `prod` CTE was empty — the product does not exist. A 404
   * rather than a foreign-key 500, and reached WITHOUT a separate existence read:
   * a read-then-insert would let the product be trashed in between and turn a
   * clean 404 into a raw 23503.
   */
  if (!row) throw new NotFoundError(productId);
  return rowToVariant(row);
}

/**
 * Update a variant's merchandising fields.
 *
 * `status` IS PATCHABLE HERE, unlike a product's. Discontinuing a variant is not
 * a lifecycle transition with an inverse that can be lost in a race — it is a
 * flag on a sellable unit, and the thing that must not be got wrong is that a
 * discontinued variant stops being quotable, which `quote()` enforces by reading
 * the CURRENT row rather than by trusting anything written here.
 */
export async function updateVariant(
  db: Db,
  id: string,
  patch: VariantPatch,
): Promise<Variant> {
  const assignments = [];
  // Hoisted out of the branch because the `catch` below reports it: a unique
  // violation can only have come from this value, and an error that cannot name
  // the SKU it rejected is the error this change exists to stop.
  let newSku: string | null = null;
  if (patch.sku !== undefined) {
    newSku = rejectNul(patch.sku.trim(), 'sku');
    if (!newSku) throw new BadRequestError('sku');
    assignments.push(sql`sku = ${newSku}`);
  }
  if (patch.optionValues !== undefined) {
    assignments.push(sql`option_values = ${JSON.stringify(patch.optionValues)}::jsonb`);
  }
  if (patch.position !== undefined) {
    if (!Number.isInteger(patch.position) || patch.position < 0) {
      throw new BadRequestError('position');
    }
    assignments.push(sql`position = ${patch.position}`);
  }
  if (patch.weightGrams !== undefined) {
    if (patch.weightGrams !== null && (!Number.isInteger(patch.weightGrams) || patch.weightGrams < 0)) {
      throw new BadRequestError('weightGrams');
    }
    assignments.push(sql`weight_grams = ${patch.weightGrams}`);
  }
  if (patch.status !== undefined) {
    assignments.push(sql`status = ${patch.status satisfies VariantStatus}`);
  }
  if (patch.imageId !== undefined) {
    await checkVariantImage(db, patch.imageId);
    assignments.push(sql`image_id = ${patch.imageId || null}`);
  }

  // An empty patch is a 400, not a no-op that reports success. A caller sending
  // `{}` has misunderstood something, and answering 200 confirms the mistake.
  if (assignments.length === 0) throw new BadRequestError('patch');

  const row = await db
    .execute(sql`
      UPDATE shop_variants SET ${sql.join(assignments, sql`, `)}, updated_at = ${Date.now()}
       WHERE id = ${id}
      RETURNING ${sql.raw(VARIANT_COLUMNS.join(', '))}`)
    .then((res) => res.rows[0])
    .catch((err: unknown) => {
      if (uniqueViolation(err) === 'shop_variants_sku_unique') {
        throw new DuplicateSkuError(newSku ?? '');
      }
      throw err;
    });

  if (!row) throw new NotFoundError(id);
  return rowToVariant(row);
}
