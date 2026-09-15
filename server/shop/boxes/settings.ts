import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BadRequestError, StaleWriteError } from '../../repo/errors';
import { committedImageIds } from '../../repo/images';
import { normalizeBlobId } from '../../repo/public-projection';
import type { AuthUser, DocNode } from '../../../shared/types';
import { money } from '../../../shared/commerce/money';
import { readBoxPage, type BoxPage } from '../../../shared/commerce/mystery-box';
import { SHOP_CURRENCY } from '../currency';
import {
  createProduct,
  getProduct,
  publishProduct,
  saveProduct,
  unpublishProduct,
} from '../catalog/products';
import { DuplicateSkuError, createVariant, deleteVariant, listVariantsWithPrices } from '../catalog/variants';
import { VariantPreconditionFailedError } from '../catalog/errors';
import { fold } from '../catalog/fold';
import { setPrice } from '../catalog/prices';
import { boxCapacitySql, hasOpenBoxes, owedBoxesSql } from './capacity';
import { boxFallback } from './fallback';
import { listBuiltBoxes } from './fills';
import type { MysteryBoxItem, MysteryBoxProduct, MysteryBoxSettings, MysteryBoxView } from './types';

/**
 * Settings → Mystery box (migration 1240; owner's decisions 2026-09-15, revised
 * the same day).
 *
 * THE BOX OWNS ITS PRODUCT. The owner does not pick an existing product: the
 * first save creates one, and this screen is the only place it is edited — its
 * name, description, pictures and its SIZES. It is a real product underneath so
 * the cart, checkout and orders need nothing new, and it is left out of the
 * Products list so nobody edits it twice.
 *
 * SIZES ARE THE PRODUCT'S VARIANTS ("5kg" and "10kg"): each has its own name
 * (the Size option), items per box, price, weight, shipping weight and photo.
 * All of them draw on the same tick lists, so they share the stock.
 *
 * `shop_products.box_mode` stays the one fact the rest of the shop reads ("is
 * this line a box?"); the settings row's `product_id` points at the owned product.
 */

const parsed = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

async function readSettings(db: Db): Promise<MysteryBoxSettings & { updatedBy: string | null; productId: string | null }> {
  const res = await db.execute(sql`SELECT * FROM shop_mystery_box_settings WHERE id = 'main'`);
  const r = res.rows[0];
  if (!r) throw new Error('shop_mystery_box_settings has no main row: migration 1240 missing');
  return {
    enabled: r.enabled === true || r.enabled === 't',
    mode: String(r.mode) as MysteryBoxSettings['mode'],
    shortfall: String(r.shortfall) as MysteryBoxSettings['shortfall'],
    revision: Number(r.revision),
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by == null ? null : String(r.updated_by),
    productId: r.product_id == null ? null : String(r.product_id),
    page: readBoxPage(r.page),
    onSaleSince: r.on_sale_since == null ? null : Number(r.on_sale_since),
  };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Boxes of this variant paid for in the last 24 hours, for the "selling fast"
 * cue. Cancelled and refunded orders don't count.
 */
export async function boxesSoldSince(db: Db, variantId: string, since: number): Promise<number> {
  const res = await db.execute(sql`
    SELECT COALESCE(sum(ol.qty), 0)::int AS n
      FROM shop_order_lines ol
      JOIN shop_orders o ON o.id = ol.order_id
     WHERE ol.variant_id = ${variantId}
       AND o.paid_at IS NOT NULL AND o.paid_at >= ${since}
       AND o.status IN ('paid', 'fulfilled', 'partially_refunded')`);
  return Number(res.rows[0]?.n ?? 0);
}

/** A size's name is its variant's Size option. */
const SIZE_OPTION = 'Size';
/** Every variant the box owns is made here, under this SKU prefix. */
const SKU_PREFIX = 'MYSTERY-BOX-';
export const MAX_BOX_SIZES = 10;
const MAX_GRAMS = 10_000_000;

/** The settings row alone, for the sweep. */
export async function mysteryBoxSettings(db: Db) {
  return readSettings(db);
}

/**
 * The owned box product and its sizes, or null.
 *
 * A linked product whose variants were NOT made here (the earlier version of
 * this screen could link an ordinary product) is not the box's own, so it reads
 * as none and is released on the next save. A box with no variants yet IS its
 * own: a first save that failed half way reuses it rather than minting another.
 */
async function readBox(db: Db, productId: string | null): Promise<MysteryBoxProduct | null> {
  if (!productId) return null;
  const product = await getProduct(db, productId);
  if (!product || product.deletedAt !== null) return null;
  const variants = await listVariantsWithPrices(db, productId);
  if (variants.some((v) => !v.sku.startsWith(SKU_PREFIX))) return null;

  const active = variants
    .filter((v) => v.status === 'active')
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const stats =
    active.length === 0
      ? []
      : (
          await db.execute(sql`
            SELECT v.id,
                   ${boxCapacitySql(sql`v.id`)} AS can_buy,
                   (SELECT count(*) FROM shop_box_fills f
                     WHERE f.built_state = 'ready' AND f.box_variant_id = v.id)::int AS ready,
                   ${owedBoxesSql(sql`v.id`)} AS owed,
                   (SELECT COALESCE(sum(ol.qty), 0) FROM shop_order_lines ol
                      JOIN shop_orders o ON o.id = ol.order_id
                     WHERE ol.variant_id = v.id
                       AND o.paid_at IS NOT NULL AND o.paid_at >= ${Date.now() - DAY}
                       AND o.status IN ('paid', 'fulfilled', 'partially_refunded'))::int AS sold
              FROM shop_variants v
             WHERE v.id = ANY(${sql.param(active.map((v) => v.id))}::text[])`)
        ).rows;
  const byId = new Map(stats.map((r) => [String(r.id), r]));

  return {
    productId,
    slug: product.slug,
    status: product.status,
    name: product.title,
    description: product.description,
    overview: product.overview,
    overviewFallback: product.overviewFallback,
    coverImageId: product.coverImageId,
    imageIds: product.imageIds,
    currency: active[0]?.price?.currency ?? SHOP_CURRENCY,
    sizes: active.map((v) => {
      const r = byId.get(v.id);
      const label = v.optionValues[SIZE_OPTION]?.trim();
      return {
        variantId: v.id,
        size: label ? label : null,
        itemCount: v.boxItemCount,
        priceMinor: v.price?.amount ?? null,
        weightGrams: v.weightGrams,
        shippingWeightGrams: v.shippingWeightGrams,
        imageId: v.imageId,
        canBuy: r?.can_buy == null ? 0 : Number(r.can_buy),
        ready: Number(r?.ready ?? 0),
        owed: Number(r?.owed ?? 0),
        soldLast24Hours: Number(r?.sold ?? 0),
        everOrdered: v.everOrdered,
      };
    }),
  };
}

/** Everything the Settings screen shows. */
export async function getMysteryBox(db: Db): Promise<MysteryBoxView> {
  const settings = await readSettings(db);

  const items: MysteryBoxItem[] = (
    await db.execute(sql`
      SELECT mi.variant_id, mi.list, v.product_id, p.title AS product_title, v.sku,
             v.option_values, v.color_hex, v.image_id,
             GREATEST(COALESCE(i.on_hand - i.reserved, 0), 0) AS available,
             (v.status = 'active' AND p.status = 'active' AND p.deleted_at IS NULL
              AND p.box_mode IS NULL) AS usable
        FROM shop_mystery_box_items mi
        JOIN shop_variants v ON v.id = mi.variant_id
        JOIN shop_products p ON p.id = v.product_id
        LEFT JOIN shop_inventory i ON i.variant_id = v.id
       ORDER BY mi.list, p.title, v.position, v.sku`)
  ).rows.map((r) => ({
    variantId: String(r.variant_id),
    list: String(r.list) as MysteryBoxItem['list'],
    productId: String(r.product_id),
    productTitle: String(r.product_title),
    sku: String(r.sku),
    optionValues: parsed<Record<string, string>>(r.option_values) ?? {},
    colorHex: r.color_hex == null ? null : String(r.color_hex),
    imageId: r.image_id == null ? null : String(r.image_id),
    available: Number(r.available ?? 0),
    usable: r.usable === true || r.usable === 't',
  }));

  const { updatedBy: _by, productId, ...publicSettings } = settings;
  return {
    settings: publicSettings,
    box: await readBox(db, productId),
    fallback: await boxFallback(db),
    items,
    built: await listBuiltBoxes(db),
  };
}

/** One size as the screen saves it. The array's order is the order on the shop. */
export interface SaveBoxSize {
  /** Null for a size added on this save. */
  variantId: string | null;
  /** "5kg". Needed as soon as there is more than one size. */
  size: string;
  itemCount: number | null;
  /** Minor units, or null for not set yet. */
  priceMinor: number | null;
  weightGrams: number | null;
  /** Null means "use the weight". */
  shippingWeightGrams: number | null;
  imageId: string | null;
}

export interface SaveMysteryBoxInput {
  expectedRevision: number;
  enabled: boolean;
  mode: MysteryBoxSettings['mode'];
  shortfall: MysteryBoxSettings['shortfall'];
  name: string;
  /** A TipTap document, or null to leave the stored one alone. */
  description: unknown | null;
  /** The owner's overview; blank lets the shop derive it from the description. */
  overview: string;
  /** How it works, and the cues. Already validated by the route. */
  page: BoxPage;
  coverImageId: string | null;
  imageIds: string[];
  sizes: SaveBoxSize[];
  main: string[];
  backup: string[];
}

const newSku = (productId: string) =>
  `${SKU_PREFIX}${productId.slice(-6).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;

/**
 * Save the whole screen.
 *
 * EVERYTHING THAT CAN REFUSE IS CHECKED BEFORE ANYTHING IS WRITTEN: the sizes'
 * shapes and names, their photos, which sizes are locked, and the tick lists.
 * Then the settings row's revision is claimed in one guarded statement with the
 * tick lists and the box flags, so two tabs can't both save, and only then do
 * the sizes, the product's words and the prices change.
 */
export async function saveMysteryBox(
  db: Db,
  input: SaveMysteryBoxInput,
  actor: AuthUser,
  now: number,
): Promise<MysteryBoxView> {
  const before = await readSettings(db);
  /* Refuse a stale save BEFORE anything is created, so a losing tab never leaves
     an orphan box product behind. The statement below still guards the race. */
  if (before.revision !== input.expectedRevision) {
    throw new StaleWriteError(input.expectedRevision, before.revision, null);
  }
  const name = input.name.trim();

  /* ── The sizes' own shapes ── */
  const sizes = input.sizes.map((s) => ({ ...s, size: s.size.trim(), imageId: s.imageId || null }));
  if (sizes.length < 1 || sizes.length > MAX_BOX_SIZES) throw new BadRequestError('sizes');
  for (const s of sizes) {
    if (s.priceMinor !== null && (!Number.isInteger(s.priceMinor) || s.priceMinor < 0)) {
      throw new BadRequestError('priceMinor');
    }
    if (s.itemCount !== null && (!Number.isInteger(s.itemCount) || s.itemCount < 1)) {
      throw new BadRequestError('itemCount');
    }
    for (const grams of [s.weightGrams, s.shippingWeightGrams]) {
      if (grams !== null && (!Number.isInteger(grams) || grams < 0 || grams > MAX_GRAMS)) {
        throw new BadRequestError('weightGrams');
      }
    }
  }
  /* Two sizes the shopper can't tell apart are one size; with one size a name is optional. */
  const names = sizes.map((s) => fold(s.size));
  if (sizes.length > 1 && (names.some((n) => n === '') || new Set(names).size !== names.length)) {
    throw new BadRequestError('size_names');
  }
  const keptIds = sizes.map((s) => s.variantId).filter((id): id is string => id !== null);
  if (new Set(keptIds).size !== keptIds.length) throw new BadRequestError('sizes');
  if (input.enabled && (!name || sizes.some((s) => s.priceMinor === null || s.itemCount === null))) {
    throw new BadRequestError('box_incomplete');
  }
  const photoIds = [...new Set(sizes.map((s) => s.imageId).filter((id): id is string => id !== null))];
  if (photoIds.length > 0) {
    const known = await committedImageIds(db, photoIds);
    if (photoIds.some((id) => !known.has(normalizeBlobId(id)))) throw new BadRequestError('imageId');
  }

  /* ── The tick lists ── */
  const mainIds = [...new Set(input.main)];
  let backupIds = [...new Set(input.backup)];
  /* Only ordinary, ACTIVE products can go inside — never a draft, and never the box. */
  const listed = [...new Set([...mainIds, ...backupIds])];
  if (listed.length > 0) {
    const rows = (
      await db.execute(sql`
        SELECT v.id, v.product_id FROM shop_variants v JOIN shop_products p ON p.id = v.product_id
         WHERE v.id = ANY(${sql.param(listed)}::text[])
           AND p.status = 'active' AND p.deleted_at IS NULL
           AND p.id IS DISTINCT FROM ${before.productId}::text`)
    ).rows;
    if (rows.length !== listed.length) throw new BadRequestError('items');
    /* THE BACKUP IS A DIFFERENT PRODUCT (owner's decision): a product with any
       variant on the main list can't also be on the backup list. The screen
       never sends one; a list saved before the rule loses it here. */
    const productOf = new Map(rows.map((r) => [String(r.id), String(r.product_id)]));
    const mainProducts = new Set(mainIds.map((id) => productOf.get(id)));
    backupIds = backupIds.filter((id) => !mainProducts.has(productOf.get(id)));
  }

  /* ── The box's own product, and which sizes may change ── */
  const box = await readBox(db, before.productId);
  if (before.productId && !box && (await hasOpenBoxes(db, before.productId))) {
    throw new BadRequestError('box_has_open_orders');
  }
  const existing = new Map((box?.sizes ?? []).map((s) => [s.variantId, s]));
  for (const s of sizes) {
    if (s.variantId === null) continue;
    const was = existing.get(s.variantId);
    if (!was) throw new BadRequestError('sizes');
    /* A box is filled to the count its size says at the time, so the count can't
       move under a paid box waiting to be packed, a checkout, or a packed box. */
    if (was.itemCount !== s.itemCount && (was.owed > 0 || was.ready > 0)) {
      throw new BadRequestError('size_count_locked');
    }
  }
  const removed = [...existing.values()].filter((s) => !keptIds.includes(s.variantId));
  if (removed.some((s) => s.owed > 0 || s.ready > 0)) throw new BadRequestError('size_in_use');

  const productId = box?.productId ?? (await createProduct(db, actor, { title: name || 'Mystery box' })).id;

  const items = [
    ...mainIds.map((variant_id) => ({ variant_id, list: 'main' })),
    ...backupIds.map((variant_id) => ({ variant_id, list: 'backup' })),
  ];

  const res = await db.execute(sql`
    WITH s AS (
      UPDATE shop_mystery_box_settings
         SET enabled = ${input.enabled}, product_id = ${productId}, mode = ${input.mode},
             shortfall = ${input.shortfall}, updated_by = ${actor.id}::uuid, updated_at = ${now},
             page = ${JSON.stringify(input.page)}::jsonb,
             /* SET sees the row as it was, so "enabled" here is the old switch:
                off -> on starts the clock, on stays on keeps it, off clears it. */
             on_sale_since = CASE
               WHEN NOT ${input.enabled} THEN NULL
               WHEN enabled AND on_sale_since IS NOT NULL THEN on_sale_since
               ELSE ${now}::bigint
             END,
             revision = revision + 1
       WHERE id = 'main' AND revision = ${input.expectedRevision}
      RETURNING id
    ), off AS (
      UPDATE shop_products SET box_mode = NULL
       WHERE box_mode IS NOT NULL AND id <> ${productId} AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), onp AS (
      UPDATE shop_products SET box_mode = ${input.mode}, bulk_discount_enabled = false
       WHERE id = ${productId} AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), inv AS (
      /* A size's own stock number is not a limit: what can be filled is. */
      UPDATE shop_inventory SET backorderable = true
       WHERE variant_id IN (SELECT id FROM shop_variants WHERE product_id = ${productId})
         AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), del AS (
      DELETE FROM shop_mystery_box_items mi
       WHERE EXISTS (SELECT 1 FROM s)
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(variant_id text, list text)
            WHERE x.variant_id = mi.variant_id AND x.list = mi.list)
      RETURNING 1
    ), ins AS (
      INSERT INTO shop_mystery_box_items (variant_id, list)
      SELECT x.variant_id, x.list
        FROM s, jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(variant_id text, list text)
      ON CONFLICT (variant_id, list) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM s)::int AS saved`);

  if (Number(res.rows[0]?.saved ?? 0) === 0) {
    const current = await readSettings(db);
    throw new StaleWriteError(input.expectedRevision, current.revision, null);
  }

  /*
   * ── Sizes that go ──
   * Never bought: deleted. Bought before: RETIRED, so past orders keep pointing at
   * it (they carry their own copy of the name anyway), and renamed "(removed)" so
   * the name is free for a new size.
   */
  for (const gone of removed) {
    let retire = gone.everOrdered;
    if (!retire) {
      try {
        await deleteVariant(db, gone.variantId);
      } catch (cause) {
        /* Bought between the read and now: retire it instead. */
        if (!(cause instanceof VariantPreconditionFailedError)) throw cause;
        retire = true;
      }
    }
    if (retire) {
      await db.execute(sql`
        UPDATE shop_variants
           SET status = 'discontinued',
               option_values = ${JSON.stringify({ [SIZE_OPTION]: `${gone.size ?? 'Size'} (removed)` })}::jsonb,
               updated_at = ${now}
         WHERE id = ${gone.variantId} AND product_id = ${productId}`);
    }
  }

  /*
   * ── Sizes that stay ──
   * One statement for all of them, so renaming two sizes into each other's names
   * never trips over itself half way. The item count is guarded again here: if a
   * paid box arrived since the check above, the count it is owed stays.
   */
  const kept = sizes
    .map((s, position) => ({ ...s, position }))
    .filter((s) => s.variantId !== null)
    .map((s) => ({
      id: s.variantId,
      position: s.position,
      options: s.size ? { [SIZE_OPTION]: s.size } : {},
      item_count: s.itemCount,
      weight: s.weightGrams,
      ship: s.shippingWeightGrams,
      image: s.imageId,
    }));
  if (kept.length > 0) {
    await db.execute(sql`
      UPDATE shop_variants v
         SET option_values = x.options,
             position = x.position,
             weight_grams = x.weight,
             shipping_weight_grams = x.ship,
             image_id = x.image,
             box_item_count = CASE
               WHEN ${owedBoxesSql(sql`v.id`)} > 0
                 OR EXISTS (SELECT 1 FROM shop_box_fills rf
                             WHERE rf.built_state = 'ready' AND rf.box_variant_id = v.id)
               THEN v.box_item_count
               ELSE x.item_count
             END,
             updated_at = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(kept)}::jsonb)
             AS x(id text, position int, options jsonb, item_count int, weight int, ship int, image text)
       WHERE v.id = x.id AND v.product_id = ${productId}`);
  }
  for (const s of sizes) {
    if (s.variantId === null || s.priceMinor === null) continue;
    if (s.priceMinor !== existing.get(s.variantId)?.priceMinor) {
      await setPrice(db, s.variantId, money(s.priceMinor, SHOP_CURRENCY), 'Mystery box settings');
    }
  }

  /* ── Sizes that are new ── */
  for (const [position, s] of sizes.entries()) {
    if (s.variantId !== null) continue;
    const optionValues: Record<string, string> = s.size ? { [SIZE_OPTION]: s.size } : {};
    const fields = {
      optionValues,
      position,
      weightGrams: s.weightGrams,
      shippingWeightGrams: s.shippingWeightGrams,
      imageId: s.imageId,
      onHand: 0,
      backorderable: true,
    };
    const created = await createVariant(db, productId, { ...fields, sku: newSku(productId) }, actor).catch(
      (cause: unknown) => {
        /* Six random characters colliding is one retry, not an error for the owner. */
        if (cause instanceof DuplicateSkuError) return createVariant(db, productId, { ...fields, sku: newSku(productId) }, actor);
        throw cause;
      },
    );
    await db.execute(sql`
      UPDATE shop_variants SET box_item_count = ${s.itemCount}::int WHERE id = ${created.id}`);
    if (s.priceMinor !== null) {
      await setPrice(db, created.id, money(s.priceMinor, SHOP_CURRENCY), 'Mystery box settings');
    }
  }

  /* The product's own words and pictures, through the catalogue's save. */
  const product = await getProduct(db, productId);
  if (product) {
    await saveProduct(
      db,
      productId,
      {
        title: name || product.title,
        coverImageId: input.coverImageId,
        imageIds: input.imageIds,
        overview: input.overview,
        ...(input.description === null ? {} : { description: input.description as DocNode }),
      },
      { actor, baseRevision: product.revision, note: 'Mystery box settings' },
    );
  }

  /*
   * THE SWITCH SHOWS OR HIDES THE BOX (owner's decision): on publishes it, off
   * takes it off the shop. Existing orders can still be filled either way,
   * because box_mode stays set. Best effort: a state the lifecycle refuses is
   * logged and the screen shows the product's real status.
   */
  const status = (await getProduct(db, productId))?.status;
  try {
    if (input.enabled && status === 'draft') await publishProduct(db, productId, actor);
    if (!input.enabled && status === 'active') await unpublishProduct(db, productId, actor);
  } catch (cause) {
    console.error('mystery box: could not change the product status', productId, cause);
  }

  return getMysteryBox(db);
}
