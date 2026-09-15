import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db } from '../../../db/client';
import type { AuthUser } from '../../../../shared/types';
import { seedSellable } from '../../catalog/test/catalog-harness';
import { commitHold, getInventory, reserve } from '../../catalog/inventory';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from '../../orders/test/fixtures';
import { sweepCommerceEvents } from '../../orders/repo/consumer';
import { markOrderPaid, readOrderByCheckout, type OrderRead } from '../../orders/repo/orders';

/**
 * Shared set-up for the mystery-box suites.
 *
 * ORDERS ARE MADE THE WAY CHECKOUT MAKES THEM — stock held for the cart,
 * committed at capture, `checkout.completed` swept into an order, then paid —
 * never by inserting rows. A raw INSERT skips the columns and defaults the real
 * path writes, which is exactly the fixture blindness CLAUDE.md §2 warns about.
 */
export const NOW = T0 + 10_000;

export interface Sellable {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
}

/** An ordinary, published product with one stocked variant, optionally tagged. */
export async function ordinary(
  db: Db,
  owner: AuthUser,
  o: { title: string; onHand: number; tags?: string[] },
): Promise<Sellable> {
  const s = await seedSellable(db, owner, { title: o.title, onHand: o.onHand, tags: o.tags });
  return { productId: s.product.id, variantId: s.variant.id, sku: s.variant.sku, title: o.title };
}

/**
 * A published mystery box whose one variant draws `itemCount` items from `tag`.
 * Set by UPDATE rather than through the routes, because the suites that use
 * this are testing what happens AFTER a box exists; the routes that make one are
 * tested on their own in `product-mode.test.ts` and `variant-pool.test.ts`.
 */
export async function box(
  db: Db,
  owner: AuthUser,
  o: { title: string; tag: string; itemCount: number; onHand?: number },
): Promise<Sellable> {
  const s = await ordinary(db, owner, { title: o.title, onHand: o.onHand ?? 100 });
  await db.execute(sql`UPDATE shop_products SET box_mode = 'pack' WHERE id = ${s.productId}`);
  await db.execute(sql`
    UPDATE shop_variants SET box_pool_tag = ${o.tag}, box_item_count = ${o.itemCount}
     WHERE id = ${s.variantId}`);
  return s;
}

/** A PAID order for these lines, made through checkout's own path. One per test. */
export async function paidOrder(
  db: Db,
  lines: { item: Sellable; qty: number }[],
  customerId: string | null = 'cus_box',
): Promise<OrderRead> {
  for (const { item, qty } of lines) {
    const id = `res_${item.sku}`;
    const held = await reserve(db, {
      reservationId: id,
      variantId: item.variantId,
      qty,
      expiresAt: Date.now() + 3_600_000,
    });
    expect(held.ok, `could not hold ${item.title}`).toBe(true);
    await commitHold(db, id);
  }
  const total = lines.reduce((n, l) => n + 1500 * l.qty, 0);
  await insertEvents(db, [
    checkoutCompleted({
      customerId,
      lines: lines.map(({ item, qty }) => ({
        variantId: item.variantId,
        sku: item.sku,
        title: item.title,
        optionValues: {},
        qty,
        unitAmount: 1500,
        lineTotal: 1500 * qty,
      })),
      subtotal: total,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: total,
    }),
  ]);
  await sweepCommerceEvents(db, { origin: null }, NOW);
  const read = (await readOrderByCheckout(db, CHECKOUT))!;
  await markOrderPaid(db, read.order.id, NOW, null, null);
  return (await readOrderByCheckout(db, CHECKOUT))!;
}

export const onHand = async (db: Db, variantId: string): Promise<number> =>
  (await getInventory(db, variantId))!.onHand;

export const setOnHand = (db: Db, variantId: string, n: number) =>
  db.execute(sql`UPDATE shop_inventory SET on_hand = ${n}, reserved = 0 WHERE variant_id = ${variantId}`);

export const lineOf = (read: OrderRead, variantId: string) =>
  read.lines.find((l) => l.variantId === variantId)!;
