import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import { rejectNul } from '../../../repo/cursor';
import { emitEvent, jsonbObject } from '../../catalog/events';

/**
 * Put back the goods staff chose when a PAID order was cancelled
 * (migration 1200; owner's decision 2026-09-15).
 *
 * WHY THIS EXISTS. A paid order's units left `on_hand` at capture
 * (`commitHold`), and nothing gave them back on cancel — while the Cancel
 * dialog told staff that it did. The owner chose a per-line choice over an
 * automatic restock, because only the person holding a returned parcel knows
 * whether a spool can be sold again.
 *
 * ONE STATEMENT (CLAUDE.md §3), and every half of it keys off the other:
 *  - `ln` moves `returned_qty`, and only while the new total stays within the
 *    units that never SHIPPED. A parcel that was packed but not shipped is
 *    still on the shelf, so it counts as returnable. This guard is what makes a
 *    repeat harmless: the second request finds nothing left to put back.
 *  - `inv` moves `on_hand` by exactly what `ln` moved, grouped per variant.
 *  - `ev` writes `catalog.inventory.adjusted` per variant, so the stock
 *    history shows the restock the way it shows a hand adjustment.
 *  - `note` stores why the rest stayed out, on the order, staff-only.
 * A line whose guard fails moves nothing and is reported as `refused`.
 *
 * CROSSES INTO CATALOG'S TABLE, AS `manual.ts` ALREADY DOES through
 * `adjustInventory`. Here it has to be inside the statement rather than a call
 * after it: returned_qty and on_hand moving in two statements would leave a
 * window where one is counted and the other is not.
 *
 * ONLY A CANCELLED ORDER THAT WAS PAID. An unpaid order's units were only set
 * aside for the cart, and that hold returns them when it expires.
 */
export interface RestockRequest {
  orderId: string;
  lines: { orderLineId: string; qty: number }[];
  keptOutReason: string | null;
  actorId: string;
  now: number;
}

export interface RestockResult {
  /** Units put back, across every line. */
  returned: number;
  /** Order line ids that asked for more than could go back, and moved nothing. */
  refused: string[];
}

export async function restockCancelledOrder(db: Db, req: RestockRequest): Promise<RestockResult> {
  const wanted = req.lines.filter((l) => l.qty > 0);
  const reason = rejectNul((req.keptOutReason ?? '').trim(), 'keptOutReason') || null;

  const res = await db.execute(sql`
    WITH ord AS (
      SELECT id, order_number FROM shop_orders
       WHERE id = ${req.orderId} AND status = 'cancelled' AND paid_at IS NOT NULL
    ), req AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(
        wanted.map((l) => ({ order_line_id: l.orderLineId, qty: l.qty })),
      )}::jsonb) AS r(order_line_id text, qty integer)
    ), ln AS (
      UPDATE shop_order_lines l
         SET returned_qty = l.returned_qty + req.qty
        FROM req, ord
       WHERE l.id = req.order_line_id
         AND l.order_id = ord.id
         AND l.returned_qty + req.qty <= l.qty - COALESCE((
               SELECT sum(fl.qty) FROM shop_fulfillment_lines fl
                 JOIN shop_fulfillments f ON f.id = fl.fulfillment_id
                WHERE fl.order_line_id = l.id AND f.status IN ('shipped', 'delivered')
             ), 0)
      RETURNING l.id, l.variant_id, req.qty
    ), agg AS (
      SELECT variant_id, sum(qty)::int AS qty FROM ln GROUP BY variant_id
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
        reason: sql`'Order ' || ord.order_number || ' cancelled'`,
        actorId: sql`${req.actorId}::text`,
      }),
      occurredAt: req.now,
    })}), note AS (
      UPDATE shop_orders o SET kept_out_reason = ${reason}::text
        FROM ord WHERE o.id = ord.id
      RETURNING 1
    )
    SELECT COALESCE(json_agg(json_build_object('id', ln.id, 'qty', ln.qty)), '[]'::json) AS moved
      FROM ln`);

  const moved = (
    (typeof res.rows[0]?.moved === 'string'
      ? JSON.parse(res.rows[0].moved as string)
      : res.rows[0]?.moved) as { id: string; qty: number }[] | undefined
  ) ?? [];
  const matched = new Set(moved.map((m) => m.id));
  return {
    returned: moved.reduce((n, m) => n + Number(m.qty), 0),
    refused: wanted.filter((l) => !matched.has(l.orderLineId)).map((l) => l.orderLineId),
  };
}

/** What a cancelled order put back, for the ADMIN detail only. */
export interface RestockSummary {
  lines: { orderLineId: string; returnedQty: number }[];
  keptOutReason: string | null;
}

export async function readRestock(db: Db, orderId: string): Promise<RestockSummary> {
  const [lines, order] = await Promise.all([
    db.execute(sql`
      SELECT id, returned_qty FROM shop_order_lines WHERE order_id = ${orderId} ORDER BY line_no`),
    db.execute(sql`SELECT kept_out_reason FROM shop_orders WHERE id = ${orderId}`),
  ]);
  return {
    lines: lines.rows.map((r) => ({ orderLineId: String(r.id), returnedQty: Number(r.returned_qty) })),
    keptOutReason: order.rows[0]?.kept_out_reason == null ? null : String(order.rows[0].kept_out_reason),
  };
}
