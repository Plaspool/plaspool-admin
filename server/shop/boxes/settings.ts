import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BadRequestError, StaleWriteError } from '../../repo/errors';
import type { AuthUser } from '../../../shared/types';
import { publishProduct, unpublishProduct } from '../catalog/products';
import { boxCapacitySql, hasOpenBoxes } from './capacity';
import { listBuiltBoxes } from './fills';
import type { MysteryBoxItem, MysteryBoxSettings, MysteryBoxView } from './types';

/**
 * Settings → Mystery box (migration 1240; owner's decisions 2026-09-15).
 *
 * ONE mystery box: a switch, the product it is sold as (its variants are the
 * sizes), how many items each size holds, how contents get decided, what happens
 * when a paid box can't be filled, and the tick lists of which variants can go
 * inside. `shop_products.box_mode` stays the one fact every other part of the
 * shop reads ("is this line a box?"), and this screen is what writes it.
 */

const parsed = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

async function readSettings(db: Db): Promise<MysteryBoxSettings & { updatedBy: string | null }> {
  const res = await db.execute(sql`
    SELECT s.*, p.title AS product_title, p.status AS product_status
      FROM shop_mystery_box_settings s
      LEFT JOIN shop_products p ON p.id = s.product_id AND p.deleted_at IS NULL
     WHERE s.id = 'main'`);
  const r = res.rows[0];
  if (!r) throw new Error('shop_mystery_box_settings has no main row: migration 1240 missing');
  return {
    enabled: r.enabled === true || r.enabled === 't',
    productId: r.product_id == null ? null : String(r.product_id),
    productTitle: r.product_title == null ? null : String(r.product_title),
    productStatus: r.product_status == null ? null : String(r.product_status),
    mode: String(r.mode) as MysteryBoxSettings['mode'],
    shortfall: String(r.shortfall) as MysteryBoxSettings['shortfall'],
    revision: Number(r.revision),
    updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by == null ? null : String(r.updated_by),
  };
}

/** The settings row alone, for the sweep. */
export async function mysteryBoxSettings(db: Db) {
  return readSettings(db);
}

/** Everything the Settings screen shows. */
export async function getMysteryBox(db: Db): Promise<MysteryBoxView> {
  const settings = await readSettings(db);

  const sizes = settings.productId
    ? (
        await db.execute(sql`
          SELECT v.id, v.sku, v.option_values, v.box_item_count,
                 ${boxCapacitySql(sql`v.id`)} AS can_fill,
                 (SELECT count(*) FROM shop_box_fills f
                   WHERE f.built_state = 'ready' AND f.box_variant_id = v.id)::int AS ready
            FROM shop_variants v
           WHERE v.product_id = ${settings.productId} AND v.status = 'active'
           ORDER BY v.position, v.sku`)
      ).rows.map((r) => ({
        variantId: String(r.id),
        sku: String(r.sku),
        optionValues: parsed<Record<string, string>>(r.option_values) ?? {},
        itemCount: r.box_item_count == null ? null : Number(r.box_item_count),
        canFill: r.can_fill == null ? 0 : Number(r.can_fill),
        ready: Number(r.ready ?? 0),
      }))
    : [];

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

  const { updatedBy: _by, ...publicSettings } = settings;
  return { settings: publicSettings, sizes, items, built: await listBuiltBoxes(db) };
}

export interface SaveMysteryBoxInput {
  expectedRevision: number;
  enabled: boolean;
  productId: string | null;
  mode: MysteryBoxSettings['mode'];
  shortfall: MysteryBoxSettings['shortfall'];
  /** Items in each size. Only variants of `productId`. */
  sizes: { variantId: string; itemCount: number | null }[];
  main: string[];
  backup: string[];
}

/**
 * Save the whole screen in ONE guarded statement (CLAUDE.md §3), behind the
 * settings row's revision. Publishing or hiding the product happens after, through
 * the catalogue's own lifecycle, because that has its own CAS and history.
 */
export async function saveMysteryBox(
  db: Db,
  input: SaveMysteryBoxInput,
  actor: AuthUser,
  now: number,
): Promise<MysteryBoxView> {
  const before = await readSettings(db);

  if (input.enabled && !input.productId) throw new BadRequestError('productId');

  /* Changing which product is the box would turn the old one's unfilled paid
     boxes into ordinary lines that ship empty. */
  if (before.productId && before.productId !== input.productId && (await hasOpenBoxes(db, before.productId))) {
    throw new BadRequestError('box_has_open_orders');
  }

  if (input.productId) {
    const p = await db.execute(sql`
      SELECT id FROM shop_products WHERE id = ${input.productId} AND deleted_at IS NULL`);
    if (p.rows.length === 0) throw new BadRequestError('productId');
  }

  const sizeIds = input.sizes.map((s) => s.variantId);
  if (sizeIds.length > 0) {
    const own = await db.execute(sql`
      SELECT count(*)::int AS n FROM shop_variants
       WHERE id = ANY(${sql.param(sizeIds)}::text[]) AND product_id = ${input.productId}::text`);
    if (Number(own.rows[0]?.n) !== new Set(sizeIds).size) throw new BadRequestError('sizes');
  }
  for (const s of input.sizes) {
    if (s.itemCount !== null && (!Number.isInteger(s.itemCount) || s.itemCount < 1)) {
      throw new BadRequestError('sizes.itemCount');
    }
  }

  const listed = [...new Set([...input.main, ...input.backup])];
  if (listed.length > 0) {
    const ok = await db.execute(sql`
      SELECT count(*)::int AS n FROM shop_variants v
       WHERE v.id = ANY(${sql.param(listed)}::text[])
         AND v.product_id IS DISTINCT FROM ${input.productId}::text`);
    if (Number(ok.rows[0]?.n) !== listed.length) throw new BadRequestError('items');
  }

  const items = [
    ...[...new Set(input.main)].map((variant_id) => ({ variant_id, list: 'main' })),
    ...[...new Set(input.backup)].map((variant_id) => ({ variant_id, list: 'backup' })),
  ];
  const sizes = input.sizes.map((s) => ({ variant_id: s.variantId, item_count: s.itemCount }));

  const res = await db.execute(sql`
    WITH s AS (
      UPDATE shop_mystery_box_settings
         SET enabled = ${input.enabled}, product_id = ${input.productId}::text, mode = ${input.mode},
             shortfall = ${input.shortfall}, updated_by = ${actor.id}::uuid, updated_at = ${now},
             revision = revision + 1
       WHERE id = 'main' AND revision = ${input.expectedRevision}
      RETURNING id
    ), off AS (
      UPDATE shop_products SET box_mode = NULL
       WHERE box_mode IS NOT NULL AND id IS DISTINCT FROM ${input.productId}::text
         AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), onp AS (
      /* A box is already priced as a deal, so bulk discounts go off the first
         time a product becomes the box. They can be switched back on after. */
      UPDATE shop_products
         SET box_mode = ${input.mode},
             bulk_discount_enabled = CASE WHEN box_mode IS NULL THEN false ELSE bulk_discount_enabled END
       WHERE id = ${input.productId}::text AND EXISTS (SELECT 1 FROM s)
      RETURNING 1
    ), sz AS (
      UPDATE shop_variants v SET box_item_count = x.item_count
        FROM s, jsonb_to_recordset(${JSON.stringify(sizes)}::jsonb) AS x(variant_id text, item_count int)
       WHERE v.id = x.variant_id
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
   * THE SWITCH SHOWS OR HIDES THE PRODUCT (owner's decision): on publishes it,
   * off takes it off the shop. Existing orders can still be filled either way,
   * because box_mode stays set. Best effort: a product that is archived or in a
   * state the lifecycle refuses is left as it is, and the screen shows its status.
   */
  if (input.productId) {
    const status = await db.execute(sql`SELECT status FROM shop_products WHERE id = ${input.productId}`);
    const current = String(status.rows[0]?.status ?? '');
    try {
      if (input.enabled && current === 'draft') await publishProduct(db, input.productId, actor);
      if (!input.enabled && current === 'active') await unpublishProduct(db, input.productId, actor);
    } catch (cause) {
      console.error('mystery box: could not change the product status', input.productId, cause);
    }
  }

  return getMysteryBox(db);
}
