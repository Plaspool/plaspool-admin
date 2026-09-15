import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

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
export async function hasOpenBoxes(db: Db, productId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM shop_order_lines ol
      JOIN shop_orders o ON o.id = ol.order_id
      JOIN shop_variants v ON v.id = ol.variant_id
     WHERE v.product_id = ${productId}
       AND o.status IN ('paid', 'partially_refunded')
       AND ol.qty > (SELECT count(*) FROM shop_box_fills f WHERE f.order_line_id = ol.id)
     LIMIT 1`);
  return res.rows.length > 0;
}
