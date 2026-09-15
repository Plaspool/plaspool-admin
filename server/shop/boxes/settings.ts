import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BadRequestError, StaleWriteError } from '../../repo/errors';
import type { AuthUser, DocNode } from '../../../shared/types';
import { money } from '../../../shared/commerce/money';
import { SHOP_CURRENCY } from '../currency';
import {
  createProduct,
  getProduct,
  publishProduct,
  saveProduct,
  unpublishProduct,
} from '../catalog/products';
import { createVariant, listVariantsWithPrices } from '../catalog/variants';
import { setPrice } from '../catalog/prices';
import { boxCapacitySql, hasOpenBoxes } from './capacity';
import { boxFallback } from './fallback';
import { listBuiltBoxes } from './fills';
import type { MysteryBoxItem, MysteryBoxProduct, MysteryBoxSettings, MysteryBoxView } from './types';

/**
 * Settings → Mystery box (migration 1240; owner's decisions 2026-09-15, revised
 * the same day).
 *
 * THE BOX OWNS ITS PRODUCT. The owner does not pick an existing product: the
 * first save creates one, and this screen is the only place it is edited — its
 * name, description, pictures, one price and one number of items per box. It
 * is a real product underneath so the cart, checkout and orders need nothing
 * new, and it is left out of the Products list so nobody edits it twice.
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
  };
}

/** The settings row alone, for the sweep. */
export async function mysteryBoxSettings(db: Db) {
  return readSettings(db);
}

/**
 * The owned box product, or null. A linked product that is gone, trashed, or has
 * more than one variant is NOT the box's own — that is the shape an ordinary
 * product linked by the earlier version of this screen had — so it reads as none.
 */
async function readBox(db: Db, productId: string | null): Promise<MysteryBoxProduct | null> {
  if (!productId) return null;
  const product = await getProduct(db, productId);
  if (!product || product.deletedAt !== null) return null;
  const variants = await listVariantsWithPrices(db, productId);
  if (variants.length !== 1) return null;
  const variant = variants[0];
  const stats = await db.execute(sql`
    SELECT ${boxCapacitySql(sql`${variant.id}::text`)} AS can_buy,
           (SELECT count(*) FROM shop_box_fills f
             WHERE f.built_state = 'ready' AND f.box_variant_id = ${variant.id})::int AS ready`);
  return {
    productId,
    variantId: variant.id,
    slug: product.slug,
    status: product.status,
    name: product.title,
    description: product.description,
    coverImageId: product.coverImageId,
    imageIds: product.imageIds,
    priceMinor: variant.price?.amount ?? null,
    currency: variant.price?.currency ?? SHOP_CURRENCY,
    itemCount: variant.boxItemCount,
    canBuy: stats.rows[0]?.can_buy == null ? 0 : Number(stats.rows[0].can_buy),
    ready: Number(stats.rows[0]?.ready ?? 0),
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

export interface SaveMysteryBoxInput {
  expectedRevision: number;
  enabled: boolean;
  mode: MysteryBoxSettings['mode'];
  shortfall: MysteryBoxSettings['shortfall'];
  name: string;
  /** A TipTap document, or null to leave the stored one alone. */
  description: unknown | null;
  coverImageId: string | null;
  imageIds: string[];
  /** Minor units, or null for not set yet. */
  priceMinor: number | null;
  itemCount: number | null;
  main: string[];
  backup: string[];
}

/**
 * Save the whole screen. The settings row's revision is claimed FIRST, in one
 * guarded statement with the tick lists and the box flags, so two tabs can't
 * both save; the product's own name, pictures and price then go through the
 * catalogue's functions, which keep its revision history and price log.
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

  if (input.priceMinor !== null && (!Number.isInteger(input.priceMinor) || input.priceMinor < 0)) {
    throw new BadRequestError('priceMinor');
  }
  if (input.itemCount !== null && (!Number.isInteger(input.itemCount) || input.itemCount < 1)) {
    throw new BadRequestError('itemCount');
  }
  if (input.enabled && (!name || input.priceMinor === null || input.itemCount === null)) {
    throw new BadRequestError('box_incomplete');
  }

  /* Only ordinary, ACTIVE products can go inside — never a draft, and never the box. */
  const listed = [...new Set([...input.main, ...input.backup])];
  if (listed.length > 0) {
    const ok = await db.execute(sql`
      SELECT count(*)::int AS n FROM shop_variants v JOIN shop_products p ON p.id = v.product_id
       WHERE v.id = ANY(${sql.param(listed)}::text[])
         AND p.status = 'active' AND p.deleted_at IS NULL
         AND p.id IS DISTINCT FROM ${before.productId}::text`);
    if (Number(ok.rows[0]?.n) !== listed.length) throw new BadRequestError('items');
  }

  /*
   * THE BOX'S OWN PRODUCT. Created on the first save; re-created if the linked
   * one is not the box's own (the earlier version of this screen could link an
   * ordinary product, and that product is released back to being ordinary below).
   */
  let box = await readBox(db, before.productId);
  if (before.productId && !box && (await hasOpenBoxes(db, before.productId))) {
    throw new BadRequestError('box_has_open_orders');
  }
  if (!box) {
    const product = await createProduct(db, actor, { title: name || 'Mystery box' });
    await createVariant(
      db,
      product.id,
      { sku: `MYSTERY-BOX-${product.id.slice(-6).toUpperCase()}`, onHand: 0, backorderable: true },
      actor,
    );
    box = await readBox(db, product.id);
    if (!box) throw new Error('mystery box product could not be created');
  }

  const items = [
    ...[...new Set(input.main)].map((variant_id) => ({ variant_id, list: 'main' })),
    ...[...new Set(input.backup)].map((variant_id) => ({ variant_id, list: 'backup' })),
  ];

  const res = await db.execute(sql`
    WITH s AS (
      UPDATE shop_mystery_box_settings
         SET enabled = ${input.enabled}, product_id = ${box.productId}, mode = ${input.mode},
             shortfall = ${input.shortfall}, updated_by = ${actor.id}::uuid, updated_at = ${now},
             revision = revision + 1
       WHERE id = 'main' AND revision = ${input.expectedRevision}
      RETURNING id
    ), off AS (
      UPDATE shop_products SET box_mode = NULL
       WHERE box_mode IS NOT NULL AND id <> ${box.productId} AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), onp AS (
      UPDATE shop_products SET box_mode = ${input.mode}, bulk_discount_enabled = false
       WHERE id = ${box.productId} AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), cnt AS (
      UPDATE shop_variants SET box_item_count = ${input.itemCount}::int
       WHERE id = ${box.variantId} AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), inv AS (
      /* The box's own stock number is not a limit: what can be filled is. */
      UPDATE shop_inventory SET backorderable = true
       WHERE variant_id = ${box.variantId} AND EXISTS (SELECT 1 FROM s)
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

  /* The product's own words and pictures, through the catalogue's save. */
  const product = await getProduct(db, box.productId);
  if (product) {
    await saveProduct(
      db,
      box.productId,
      {
        title: name || product.title,
        coverImageId: input.coverImageId,
        imageIds: input.imageIds,
        ...(input.description === null ? {} : { description: input.description as DocNode }),
      },
      { actor, baseRevision: product.revision, note: 'Mystery box settings' },
    );
  }
  if (input.priceMinor !== null && input.priceMinor !== box.priceMinor) {
    await setPrice(db, box.variantId, money(input.priceMinor, SHOP_CURRENCY), 'Mystery box settings');
  }

  /*
   * THE SWITCH SHOWS OR HIDES THE BOX (owner's decision): on publishes it, off
   * takes it off the shop. Existing orders can still be filled either way,
   * because box_mode stays set. Best effort: a state the lifecycle refuses is
   * logged and the screen shows the product's real status.
   */
  const status = (await getProduct(db, box.productId))?.status;
  try {
    if (input.enabled && status === 'draft') await publishProduct(db, box.productId, actor);
    if (!input.enabled && status === 'active') await unpublishProduct(db, box.productId, actor);
  } catch (cause) {
    console.error('mystery box: could not change the product status', box.productId, cause);
  }

  return getMysteryBox(db);
}
