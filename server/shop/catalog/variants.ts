import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { rejectNul } from '../../repo/cursor';
import { committedImageIds } from '../../repo/images';
import { generateSku } from './sku';
import { canonicalizeOptions, foldedTupleKey } from './fold';
import { normalizeBlobId } from '../../repo/public-projection';
import { VariantPreconditionFailedError } from './errors';
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

/**
 * The combination already exists on this product, up to case (migration 0010's
 * create-time half).
 *
 * THE SAME SHAPE AS `DuplicateSkuError`, FOR THE SAME REASON: "already exists"
 * is a conflict with state, not a malformed field, and a caller cannot act on
 * the two the same way. `BadRequestError` underneath so any mount without the
 * shop app's `onError` still answers a retry-stopping 4xx; `shop/app.ts`
 * upgrades it to the 409 it is. Carries the stored summary so the screen can
 * name the variant it collided with rather than echo what was typed.
 */
export class DuplicateOptionsError extends BadRequestError {
  readonly summary: string;

  constructor(summary: string) {
    super('optionValues');
    this.name = 'DuplicateOptionsError';
    this.summary = summary;
  }
}

export interface CreateVariantInput {
  /**
   * OPTIONAL. Omitted means "derive one" — see `sku.ts` for why the human is no
   * longer the one who has to satisfy `shop_variants_sku_unique`.
   */
  sku?: string;
  optionValues?: Record<string, string>;
  position?: number;
  weightGrams?: number | null;
  /** Stock at creation. Defaults to zero — nothing is in the warehouse yet. */
  onHand?: number;
  backorderable?: boolean;
  /** The photograph of this colour. Validated as a committed image. */
  imageId?: string | null;
  /** The colour code of this option (migration 0010). Stored lowercase. */
  colorHex?: string | null;
}

/**
 * `#a1b2c3` or null, or a 400 that names the field.
 *
 * Lowercased HERE, because the column's CHECK accepts lowercase only — the
 * check is a backstop against hand-run SQL, not a user-facing refusal, and two
 * spellings of one colour code would be the same case-twin defect this whole
 * change exists to end, one column over. `''` clears, like `imageId`.
 */
function normalizeColorHex(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const hex = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new BadRequestError('colorHex');
  return hex;
}

/**
 * The tuples this product already has, with the summary each renders as —
 * the evidence for both halves of the duplicate check.
 */
async function existingOptionTuples(
  db: Db,
  productId: string,
  excludeId?: string,
): Promise<Record<string, string>[]> {
  const res = await db.execute(sql`
    SELECT id, option_values FROM shop_variants WHERE product_id = ${productId}`);
  return res.rows
    .filter((row) => String(row.id) !== excludeId)
    .map((row) => {
      const raw = row.option_values;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, string>;
        } catch {
          return {};
        }
      }
      return (raw ?? {}) as Record<string, string>;
    });
}

/**
 * Canonicalise an incoming tuple against the product's vocabulary and refuse a
 * case-fold duplicate.
 *
 * `'{}'` IS EXEMPT FROM THE DUPLICATE CHECK, deliberately: several option-less
 * variants per product is a supported shape (the suites create them; a shop can
 * run SKU-only families), not a case collision. It still returns the tuple so
 * every caller stores the canonicalised form.
 *
 * ADVISORY, NOT AN INDEX, AND SAYING SO IS THE POINT. Two concurrent creates of
 * the same combination can both pass this read — the cost is one duplicate an
 * admin deletes, the same as before this check existed. The mechanical answer,
 * a unique index over the folded tuple, is deliberately NOT taken: legacy
 * conflicts where BOTH twins carry orders or stock survive migration 0010 on
 * purpose (deleting either would orphan history), and an index they violate
 * would wedge `db:migrate` on every database that has one.
 */
function checkedOptions(
  existing: Record<string, string>[],
  incoming: Record<string, string>,
): Record<string, string> {
  const canonical = canonicalizeOptions(existing, incoming);
  if (canonical === null) throw new BadRequestError('optionValues');
  if (Object.keys(canonical).length === 0) return canonical;

  const key = foldedTupleKey(canonical);
  const taken = existing.find((tuple) => foldedTupleKey(tuple) === key);
  if (taken) {
    const summary = Object.entries(taken)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    throw new DuplicateOptionsError(summary);
  }
  return canonical;
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
           i.on_hand - i.reserved AS available, i.backorderable,
           eo.ever_ordered
      FROM shop_variants v
      LEFT JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
      LEFT JOIN shop_inventory i ON i.variant_id = v.id
      LEFT JOIN LATERAL (
        SELECT true AS ever_ordered FROM shop_order_lines ol
         WHERE ol.variant_id = v.id LIMIT 1
      ) eo ON true
     WHERE v.product_id = ${productId}
     ORDER BY v.position ASC, v.id ASC`);
  return res.rows.map(rowToVariantWithPrice);
}

/**
 * The same join, for MANY products at once, grouped by product id.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A SUBREQUEST BUDGET IN ANOTHER REPOSITORY.
 *
 * `GET /api/shop/products` used to return products without variants, so the
 * storefront had to fetch the list and then one detail response per product to
 * learn any price. That storefront is Next.js on Cloudflare Workers, where a
 * request has a **50-subrequest cap on the free plan** and a 10ms CPU budget
 * that plaspool-storefront#9 (Error 1102) was only just brought inside. A
 * fifty-product catalogue would therefore have made the listing page fail at the
 * platform level, not merely render slowly.
 *
 * So the fan-out moves to where it is one SQL statement instead of N HTTP
 * requests. The argument `listVariantsWithPrices` makes about N+1 within one
 * product applies across products for exactly the same reason; this is that
 * function with `= ANY(...)` and a `Map` on the way out.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A product with no variants is ABSENT from the map rather than present with an
 * empty array — callers already have to handle "this product has none", and a
 * `Map#get` returning `undefined` says that once instead of at every use site.
 */
export async function listVariantsForProducts(
  db: Db,
  productIds: string[],
): Promise<Map<string, VariantWithPrice[]>> {
  const grouped = new Map<string, VariantWithPrice[]>();
  // No ids means no statement. `= ANY('{}')` is valid but a pointless round trip.
  if (productIds.length === 0) return grouped;

  const res = await db.execute(sql`
    SELECT ${sql.raw(VARIANT_COLUMNS.map((c) => `v.${c}`).join(', '))},
           pr.amount AS price_amount, pr.currency AS price_currency,
           i.on_hand - i.reserved AS available, i.backorderable,
           eo.ever_ordered
      FROM shop_variants v
      LEFT JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
      LEFT JOIN shop_inventory i ON i.variant_id = v.id
      LEFT JOIN LATERAL (
        SELECT true AS ever_ordered FROM shop_order_lines ol
         WHERE ol.variant_id = v.id LIMIT 1
      ) eo ON true
     WHERE v.product_id = ANY(${sql.param(productIds)}::text[])
     ORDER BY v.product_id ASC, v.position ASC, v.id ASC`);

  for (const row of res.rows) {
    const variant = rowToVariantWithPrice(row);
    const list = grouped.get(variant.productId);
    if (list) list.push(variant);
    else grouped.set(variant.productId, [variant]);
  }
  return grouped;
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

  /*
   * The tuple is canonicalised into the product's existing vocabulary and
   * refused when it case-collides with a sibling — BEFORE the SKU derivation,
   * so a derived SKU is built from the spelling that will actually be stored.
   */
  const options = checkedOptions(
    await existingOptionTuples(db, productId),
    input.optionValues ?? {},
  );
  const colorHex = normalizeColorHex(input.colorHex) ?? null;

  /*
   * A SUPPLIED SKU WINS, ALWAYS. A shop with an existing catalogue has codes
   * that mean something to a supplier, and silently replacing one would be
   * worse than never generating at all. Only a genuinely absent value is
   * derived — an empty string is still a 400, because a caller that sent the
   * field meant to send a value.
   */
  let sku: string;
  if (input.sku === undefined) {
    const titleRow = await db.execute(sql`
      SELECT title FROM shop_products WHERE id = ${productId}`);
    if (!titleRow.rows[0]) throw new NotFoundError(productId);
    sku = await generateSku(db, String(titleRow.rows[0].title), options);
  } else {
    sku = rejectNul(input.sku.trim(), 'sku');
    if (!sku) throw new BadRequestError('sku');
  }
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
                                   weight_grams, status, image_id, color_hex,
                                   created_at, updated_at)
        SELECT ${id}, prod.id, ${sku},
               ${JSON.stringify(options)}::jsonb, ${position},
               ${input.weightGrams ?? null}, 'active', ${input.imageId || null},
               ${colorHex}, ${now}, ${now}
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
    /*
     * The same canonicalise-and-refuse as creation, excluding this variant
     * itself — renaming `Black` to `black` must be a no-op spelling-wise, not a
     * collision with the row being edited. The read costs one extra statement
     * on exactly the patches that change identity, which is the rare path.
     */
    const owner = await db.execute(sql`
      SELECT product_id FROM shop_variants WHERE id = ${id}`);
    if (!owner.rows[0]) throw new NotFoundError(id);
    const options = checkedOptions(
      await existingOptionTuples(db, String(owner.rows[0].product_id), id),
      patch.optionValues,
    );
    assignments.push(sql`option_values = ${JSON.stringify(options)}::jsonb`);
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
  if (patch.colorHex !== undefined) {
    assignments.push(sql`color_hex = ${normalizeColorHex(patch.colorHex)}`);
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

/**
 * Hard-delete a variant that has never been ordered (issue #18).
 *
 * WHY THIS EXISTS ALONGSIDE `updateVariant`'S `status`, NOT INSTEAD OF IT. A
 * variant a customer has bought must survive as `discontinued` — an order line
 * snapshots its own sku/title/price, but it still names a `variantId`, and a
 * report or a future feature that resolves that id back to "what was this"
 * needs the row to still exist. A variant nobody has ever bought carries no
 * such obligation: it is `shop_prices` and `shop_inventory` rows and, if it is
 * unlucky, a line in someone's open cart, none of which is history.
 *
 * NO `db.transaction` — the Neon HTTP driver throws on it (contract note this
 * repo lives under). The guard against the "ordered after the check, before
 * the delete" race is therefore folded INTO the delete statement itself rather
 * than wrapped around it: `ord` is read once and every deleting CTE is gated on
 * `NOT EXISTS (SELECT 1 FROM ord)`, so if an order line lands in the gap the
 * whole statement deletes nothing rather than deleting half of a variant that
 * just got itself an order.
 *
 * CART LINES CASCADE, PRICES AND INVENTORY GO WITH THEM. This is the
 * deliberate decision from issue #18's open question: a cart line pointing at
 * a deleted variant would break every subsequent cart read for that customer,
 * and the variant is by definition never-sold and no longer for sale, so the
 * honest outcome is that it silently leaves the basket. A cart is a basket,
 * not a record — unlike an order line, which is exactly why an order line
 * blocks the delete instead of cascading the same way.
 *
 * RETURNS THE DELETED VARIANT (for the caller's response / audit use), or
 * throws `VariantPreconditionFailedError` carrying the still-live variant when
 * it has been ordered, or `NotFoundError` when there is no such row at all.
 */
export async function deleteVariant(db: Db, id: string): Promise<Variant> {
  const res = await db.execute(sql`
    WITH ord AS (
      SELECT 1 FROM shop_order_lines WHERE variant_id = ${id} LIMIT 1
    ), del_cart AS (
      DELETE FROM shop_cart_lines
       WHERE variant_id = ${id} AND NOT EXISTS (SELECT 1 FROM ord)
    ), del_price AS (
      DELETE FROM shop_prices
       WHERE variant_id = ${id} AND NOT EXISTS (SELECT 1 FROM ord)
    ), del_inv AS (
      DELETE FROM shop_inventory
       WHERE variant_id = ${id} AND NOT EXISTS (SELECT 1 FROM ord)
    ), del_var AS (
      DELETE FROM shop_variants
       WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM ord)
      RETURNING ${sql.raw(VARIANT_COLUMNS.join(', '))}
    )
    SELECT (SELECT 1 FROM ord) AS blocked,
           ${sql.raw(VARIANT_COLUMNS.map((c) => `del_var.${c}`).join(', '))}
      FROM del_var`);

  const row = res.rows[0];
  if (row) return rowToVariant(row);

  // Nothing came back from `del_var`: either the row was never there, or the
  // delete was blocked by `ord`. The two need a second, cheap read to tell
  // apart — the write statement above deliberately returns no row either way,
  // so this is not a race, it is disambiguating what already happened.
  const blocked = await db.execute(sql`
    SELECT 1 FROM shop_order_lines WHERE variant_id = ${id} LIMIT 1`);
  if (blocked.rows[0]) {
    const variant = await getVariant(db, id);
    if (!variant) throw new NotFoundError(id);
    throw new VariantPreconditionFailedError('delete', variant);
  }
  throw new NotFoundError(id);
}
