import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { emitEvent, jsonbObject } from '../catalog/events';

/**
 * Put the chosen ITEMS of a cancelled order's filled boxes back on the shelf
 * (migration 1220). It rides the cancel's existing per-line restock (migration
 * 1200): that one puts back the box variants themselves, this one puts back
 * what was packed inside them. The "why the rest stayed out" note is the
 * order's, already stored by 1200.
 *
 * ONE STATEMENT, and idempotent: an item already returned is never returned
 * twice, so a double click is harmless. Only items whose box is in no parcel, or
 * in a pending or cancelled one — a shipped box's contents are not on the shelf.
 * Only a CANCELLED order that was PAID: an unpaid order has no fills.
 *
 * The stock history gets a `catalog.inventory.adjusted` per variant, the same
 * way 1200's restock writes one.
 */
export async function returnBoxItemsToStock(
  db: Db,
  req: { orderId: string; itemIds: string[]; actorId: string; now: number },
): Promise<number> {
  if (req.itemIds.length === 0) return 0;
  const res = await db.execute(sql`
    WITH ord AS (
      SELECT id, order_number FROM shop_orders
       WHERE id = ${req.orderId} AND status = 'cancelled' AND paid_at IS NOT NULL
    ), picked AS (
      UPDATE shop_box_fill_items it
         SET returned_to_stock_at = ${req.now}
        FROM shop_box_fills f
        JOIN shop_order_lines ol ON ol.id = f.order_line_id
        JOIN ord ON ord.id = ol.order_id
        LEFT JOIN shop_fulfillments pf ON pf.id = f.fulfillment_id
       WHERE it.fill_id = f.id
         AND it.id = ANY(${sql.param(req.itemIds)}::text[])
         AND it.returned_to_stock_at IS NULL
         AND (f.fulfillment_id IS NULL OR pf.status IN ('pending', 'cancelled'))
      RETURNING it.variant_id
    ), agg AS (
      SELECT variant_id, count(*)::int AS qty FROM picked GROUP BY variant_id
    ), inv AS (
      UPDATE shop_inventory i
         SET on_hand = i.on_hand + agg.qty, updated_at = ${req.now}
        FROM agg
       WHERE i.variant_id = agg.variant_id
      RETURNING i.variant_id, i.on_hand, agg.qty
    ), ev AS (${emitEvent({
      from: sql`inv, ord`,
      type: 'catalog.inventory.adjusted',
      subjectId: sql`inv.variant_id`,
      payload: jsonbObject({
        variantId: sql`inv.variant_id`,
        delta: sql`inv.qty`,
        onHand: sql`inv.on_hand`,
        reason: sql`'Mystery box in order ' || ord.order_number || ' cancelled'`,
        actorId: sql`${req.actorId}::text`,
      }),
      occurredAt: req.now,
    })})
    SELECT (SELECT count(*) FROM picked)::int AS returned`);
  return Number(res.rows[0]?.returned ?? 0);
}
