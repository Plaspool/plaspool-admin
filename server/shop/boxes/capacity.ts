import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * How many mystery boxes can still be sold (migrations 1220 and 1240).
 *
 * THE POOL IS THE SETTINGS TICK LIST since migration 1240: the variants on
 * `shop_mystery_box_items`, list 'main' (and 'backup' where the box is set to
 * use it). There is ONE mystery box, so every box variant draws on the same
 * lists.
 */

/**
 * Units of an order line that owe the pool nothing any more: filled, or already
 * shipped, whichever is more. The SHIPPED half keeps an order placed before this
 * product became the box, an ordinary line nobody will ever fill, from counting
 * as an open box for ever.
 */
const settledUnits = (line: SQL) => sql`GREATEST(
  (SELECT count(*) FROM shop_box_fills f WHERE f.order_line_id = ${line}.id),
  ${line}.fulfilled_qty)`;

/**
 * Whether any paid order still has a box of this product that nobody has
 * filled. Changing which product is the box, under such an order, would turn its
 * unfilled boxes into ordinary lines that ship empty.
 */
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

/**
 * Boxes of one size that somebody is owed or holding: paid and not yet filled or
 * sent, plus boxes sitting in a checkout right now. While any exist, the size's
 * item count is fixed and the size can't be removed, because a box is filled to
 * the count its variant says at the time.
 */
export const owedBoxesSql = (variant: SQL) => sql`((
  SELECT COALESCE(sum(GREATEST(ol.qty - ${settledUnits(sql`ol`)}, 0)), 0)
    FROM shop_order_lines ol JOIN shop_orders o ON o.id = ol.order_id
   WHERE ol.variant_id = ${variant} AND o.status IN ('paid', 'partially_refunded'))
  + (SELECT COALESCE(sum(h.qty), 0) FROM shop_inventory_holds h
      WHERE h.state = 'held' AND h.variant_id = ${variant}))::int`;

/**
 * A pool member on a list: an active variant of an active, untrashed, ORDINARY
 * product that is ticked on that list. Never the box itself.
 */
const onList = (list: SQL) => sql`
  pv.status = 'active' AND pp.status = 'active' AND pp.deleted_at IS NULL
  AND pp.box_mode IS NULL
  AND EXISTS (SELECT 1 FROM shop_mystery_box_items mi
               WHERE mi.variant_id = pv.id AND mi.list = ${list})
  AND (${list} = 'main' OR ${productNotOnMain(sql`pv`)})`;

/**
 * THE BACKUP IS A DIFFERENT PRODUCT, NEVER MORE OF THE SAME ONE (owner's decision
 * 2026-09-15). A backup variant counts only while no variant of its product is
 * on the main list. The same product on both lists had made "boxes can be
 * bought" count its stock twice, and a backup of the same filament backs up
 * nothing. Settings refuses the overlap on save; this keeps a list saved before
 * that rule honest, in the capacity and in the shop's own picking (auto.ts).
 */
export const productNotOnMain = (variant: SQL) => sql`NOT EXISTS (
  SELECT 1 FROM shop_mystery_box_items mm
    JOIN shop_variants mv ON mv.id = mm.variant_id
   WHERE mm.list = 'main' AND mv.product_id = ${variant}.product_id)`;

/**
 * Free units on a list: on the shelf, minus what the pool already owes.
 *
 * WHAT IS OWED. A box in a cart holds the BOX variant, not the pool, so each held
 * box owes its item count. Once paid, the order line owes it until the box is
 * filled or shipped. A built-ahead box owes nothing: its items already left the
 * shelf when it was packed. Owed units are charged to the MAIN list only; the
 * backup is what is left over when the main list runs out.
 *
 * A SOFT NUMBER. Between capture and the sweep that creates the order a sold box
 * is owed by neither, and nothing holds pool stock. Two carts can see the last box.
 */
export function freeUnitsSql(list: 'main' | 'backup'): SQL {
  const l = sql`${list}::text`;
  const owed =
    list === 'main'
      ? sql`
    - (SELECT COALESCE(sum(h.qty * hv.box_item_count), 0)
         FROM shop_inventory_holds h
         JOIN shop_variants hv ON hv.id = h.variant_id
         JOIN shop_products hp ON hp.id = hv.product_id
        WHERE h.state = 'held' AND hp.box_mode IN ('pack', 'auto'))
    - (SELECT COALESCE(sum(GREATEST(ol.qty - ${settledUnits(sql`ol`)}, 0) * ov.box_item_count), 0)
         FROM shop_order_lines ol
         JOIN shop_orders o ON o.id = ol.order_id
         JOIN shop_variants ov ON ov.id = ol.variant_id
         JOIN shop_products op ON op.id = ov.product_id
        WHERE o.status IN ('paid', 'partially_refunded') AND op.box_mode IN ('pack', 'auto'))`
      : sql``;
  return sql`(
    (SELECT COALESCE(sum(GREATEST(pi.on_hand - pi.reserved, 0)), 0)
       FROM shop_inventory pi
       JOIN shop_variants pv ON pv.id = pi.variant_id
       JOIN shop_products pp ON pp.id = pv.product_id
      WHERE ${onList(l)})
    ${owed}
  )::int`;
}

/**
 * How many more boxes of this size can be sold. NULL for an ordinary variant,
 * so every caller can say "no box rule applies"; 0 for a size with no item
 * count set.
 *
 *  - BUILT AHEAD: the ready boxes of this size, minus ones already in carts or
 *    paid for and not yet handed a box.
 *  - PACK / SHOP PICKS: floor(free units / item count), counting the backup list
 *    too when the box is set to fill from it.
 */
/**
 * How many of a variant a shopper can still buy, given its own stock and what
 * the box can fill (canFill, null for an ordinary variant).
 *
 * THE SETTINGS BOX KEEPS NO STOCK OF ITS OWN: its one variant sits at 0 with
 * backorders on, so its own number is 0 or below and means nothing. Taking the
 * smaller of that and canFill showed the box as sold out forever while checkout
 * (which honours backorders) went on selling it. A backorderable box is capped
 * by canFill alone.
 */
export function boxAvailable(
  available: number | null,
  backorderable: boolean,
  canFill: number | null,
): number | null {
  if (canFill === null) return available;
  if (backorderable || available === null) return canFill;
  return Math.min(available, canFill);
}

export function boxCapacitySql(variantId: SQL): SQL {
  return sql`(
    SELECT CASE
             WHEN bp.box_mode IS NULL THEN NULL
             WHEN bv.box_item_count IS NULL THEN 0
             WHEN bp.box_mode = 'built' THEN GREATEST(0,
               (SELECT count(*) FROM shop_box_fills rf
                 WHERE rf.built_state = 'ready' AND rf.box_variant_id = bv.id)
               - (SELECT COALESCE(sum(h.qty), 0) FROM shop_inventory_holds h
                   WHERE h.state = 'held' AND h.variant_id = bv.id)
               - (SELECT COALESCE(sum(GREATEST(ol.qty - ${settledUnits(sql`ol`)}, 0)), 0)
                    FROM shop_order_lines ol JOIN shop_orders o ON o.id = ol.order_id
                   WHERE ol.variant_id = bv.id AND o.status IN ('paid', 'partially_refunded')))::int
             ELSE GREATEST(0, floor((
               ${freeUnitsSql('main')}
               + CASE WHEN ms.shortfall = 'backup' THEN ${freeUnitsSql('backup')} ELSE 0 END
             )::numeric / bv.box_item_count))::int
           END
      FROM shop_variants bv
      JOIN shop_products bp ON bp.id = bv.product_id
      CROSS JOIN shop_mystery_box_settings ms
     WHERE bv.id = ${variantId} AND ms.id = 'main'
  )`;
}
