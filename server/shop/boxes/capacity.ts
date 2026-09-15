import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { PoolPreview } from './types';

/**
 * Whether any paid order still has a box of this product that nobody has
 * filled (migration 1220). Switching a product's box mode off under such an
 * order would turn its unfilled boxes into ordinary lines that can be sent out
 * empty.
 *
 * A READ, NOT A GUARD IN THE WRITE: box settings are an owner's configuration
 * edit, and the race — an order paid in the millisecond between this read and
 * the save — leaves an order a person can still see and fix.
 */
/**
 * Units of an order line that owe the pool nothing any more: filled, or already
 * shipped, whichever is more. The SHIPPED half is what keeps an order placed
 * before this product became a box — an ordinary line nobody will ever fill —
 * from counting as an open box for ever. A real box cannot ship unfilled, so for
 * one the filled count is always the larger.
 */
const settledUnits = (line: SQL) => sql`GREATEST(
  (SELECT count(*) FROM shop_box_fills f WHERE f.order_line_id = ${line}.id),
  ${line}.fulfilled_qty)`;

export async function hasOpenBoxes(db: Db, productId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM shop_order_lines ol
      JOIN shop_orders o ON o.id = ol.order_id
      JOIN shop_variants v ON v.id = ol.variant_id
     WHERE v.product_id = ${productId}
       AND o.status IN ('paid', 'partially_refunded')
       AND ol.qty > ${settledUnits(sql`ol`)}
     LIMIT 1`);
  return res.rows.length > 0;
}

// ------------------------------------------------------------ pool capacity

/**
 * A pool member: an active variant of an active, untrashed, ORDINARY product
 * carrying the tag. Never another box.
 */
const eligible = (tag: SQL) => sql`
  pv.status = 'active' AND pp.status = 'active' AND pp.deleted_at IS NULL
  AND pp.box_mode IS NULL AND ${tag} = ANY(pp.tags)`;

/**
 * Free units in a pool: what is on the shelf, minus what is already promised.
 *
 * TWO KINDS OF PROMISE, AND NEITHER IS COUNTED TWICE.
 *  - A box in a cart holds the BOX variant (a held row in shop_inventory_holds),
 *    not the pool, so each held box owes its item count in pool units.
 *  - Once paid, that hold is committed and the ORDER LINE is what owes: every
 *    box on a paid line not yet filled owes its item count. A pending order is
 *    left out because its hold is still held and already counted above.
 * A filled box owes nothing: its items have already left on_hand.
 *
 * COMPUTED ON READ, NEVER STORED, for the reason inventory.ts gives about
 * `available`: two numbers that must agree are two ways to disagree.
 *
 * A SOFT NUMBER, said plainly. Between capture and the sweep that creates the
 * order (up to ten minutes) a sold box is owed by neither a held hold nor a paid
 * line, and nothing holds pool stock at all in pack mode. Two carts can see the
 * last box. The fill screen is where that becomes visible.
 */
export function freeUnitsForTagSql(tag: SQL): SQL {
  return sql`(
    (SELECT COALESCE(sum(GREATEST(pi.on_hand - pi.reserved, 0)), 0)
       FROM shop_inventory pi
       JOIN shop_variants pv ON pv.id = pi.variant_id
       JOIN shop_products pp ON pp.id = pv.product_id
      WHERE ${eligible(tag)})
    - (SELECT COALESCE(sum(h.qty * hv.box_item_count), 0)
         FROM shop_inventory_holds h
         JOIN shop_variants hv ON hv.id = h.variant_id
        WHERE h.state = 'held' AND hv.box_pool_tag = ${tag})
    - (SELECT COALESCE(sum(GREATEST(ol.qty - ${settledUnits(sql`ol`)}, 0) * ov.box_item_count), 0)
         FROM shop_order_lines ol
         JOIN shop_orders o ON o.id = ol.order_id
         JOIN shop_variants ov ON ov.id = ol.variant_id
        WHERE o.status IN ('paid', 'partially_refunded') AND ov.box_pool_tag = ${tag})
  )::int`;
}

/**
 * How many more boxes of this variant the pool can fill. NULL for an ordinary
 * variant, so every caller can say "no box rule applies"; 0 for a box variant
 * that names no pool; otherwise floor(free / count), never below zero.
 */
export function boxCapacitySql(variantId: SQL): SQL {
  return sql`(
    SELECT CASE
             WHEN bp.box_mode IS NULL THEN NULL
             WHEN bv.box_pool_tag IS NULL THEN 0
             ELSE GREATEST(0, floor(${freeUnitsForTagSql(sql`bv.box_pool_tag`)}::numeric
                                    / bv.box_item_count))::int
           END
      FROM shop_variants bv
      JOIN shop_products bp ON bp.id = bv.product_id
     WHERE bv.id = ${variantId}
  )`;
}

const parsed = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** The admin's view of one pool: what is in it now, and how many units are free. */
export async function poolPreview(db: Db, tag: string): Promise<PoolPreview> {
  const t = sql`${tag}::text`;
  const [items, free] = await Promise.all([
    db.execute(sql`
      SELECT pv.id AS variant_id, pp.title AS product_title, pv.sku, pv.option_values,
             pv.color_hex, pv.image_id, (pi.on_hand - pi.reserved) AS available
        FROM shop_inventory pi
        JOIN shop_variants pv ON pv.id = pi.variant_id
        JOIN shop_products pp ON pp.id = pv.product_id
       WHERE ${eligible(t)} AND pi.on_hand - pi.reserved > 0
       ORDER BY available DESC, pp.title, pv.sku`),
    db.execute(sql`SELECT ${freeUnitsForTagSql(t)} AS free`),
  ]);
  return {
    tag,
    freeUnits: Math.max(0, Number(free.rows[0]?.free ?? 0)),
    items: items.rows.map((r) => ({
      variantId: String(r.variant_id),
      productTitle: String(r.product_title),
      sku: String(r.sku),
      optionValues: parsed<Record<string, string>>(r.option_values) ?? {},
      colorHex: r.color_hex == null ? null : String(r.color_hex),
      imageId: r.image_id == null ? null : String(r.image_id),
      available: Number(r.available),
    })),
  };
}
