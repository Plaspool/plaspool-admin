import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { PointsRedemptionPort } from '../../../shared/marketing/redemption';
import type { TemplateSet } from '../../email/system-templates';
import type { RefundIssuer } from '../orders/ports';
import { cancelOrder, readOrder } from '../orders/repo/orders';
import { refundPoints } from '../orders/repo/consumer';
import { restockCancelledOrder } from '../orders/repo/restock';
import { mintGuestToken } from '../orders/tokens';
import { BoxRefusedError } from './errors';
import { assignBuiltBox, listBoxFills, saveBoxFill } from './fills';
import { returnBoxItemsToStock } from './restock';
import { mysteryBoxSettings } from './settings';

/**
 * THE SHOP FILLS ITS OWN BOXES, AFTER PAYMENT (migration 1240; owner's
 * decisions 2026-09-15).
 *
 * Run by the sweep after the commerce outbox is drained, so an order paid in
 * this sweep is handled in this sweep. For every paid online order with an
 * unfilled mystery box:
 *
 *  - "I build boxes ahead": hand it the next ready box of its size.
 *  - "The shop picks at checkout": pick items from the main tick list and take
 *    them out of stock (the owner chose WHEN PAYMENT ARRIVES, not at checkout start).
 *
 * If a box can't be filled, the box's setting decides:
 *  - "Keep the order and tell me": mark the order; its screen says so.
 *  - "Fill from a backup list": try the backup tick list, then mark it if that fails too.
 *  - "Cancel and refund": refund in full through the gateway, cancel, put the stock
 *    back. AUTOMATIC, with nobody clicking — the owner said yes to that explicitly.
 *
 * "I pack it myself" does nothing here. NEVER THROWS: a failure on one order is
 * logged and the next order is still handled, because the sweep is also
 * settling payments and sending mail.
 */

export interface MysteryBoxDeps {
  refund: RefundIssuer | null;
  redemption?: (db: Db) => PointsRedemptionPort;
  templates?: TemplateSet;
  /** The storefront origin, for the customer's link in the cancellation email. */
  origin: string | null;
  now: number;
}

export interface MysteryBoxRun {
  filled: number;
  short: number;
  cancelled: number;
}

/** Ticked, usable variants on a list with stock free right now. */
async function freeOnList(db: Db, list: 'main' | 'backup'): Promise<{ variantId: string; free: number }[]> {
  const res = await db.execute(sql`
    SELECT v.id, (i.on_hand - i.reserved) AS free
      FROM shop_mystery_box_items mi
      JOIN shop_variants v ON v.id = mi.variant_id
      JOIN shop_products p ON p.id = v.product_id
      JOIN shop_inventory i ON i.variant_id = v.id
     WHERE mi.list = ${list}
       AND v.status = 'active' AND p.status = 'active' AND p.deleted_at IS NULL
       AND p.box_mode IS NULL
       AND i.on_hand - i.reserved > 0`);
  return res.rows.map((r) => ({ variantId: String(r.id), free: Number(r.free) }));
}

/**
 * Choose `count` items. Different products first, weighted by how many are on
 * the shelf, so a box doesn't get three of the same thing while there is
 * variety; repeats only once every variant has been used. Null when the list
 * holds fewer than `count` units in all.
 */
function draw(pool: { variantId: string; free: number }[], count: number): string[] | null {
  const left = new Map(pool.map((p) => [p.variantId, p.free]));
  const total = [...left.values()].reduce((n, v) => n + v, 0);
  if (total < count) return null;
  const picks: string[] = [];
  while (picks.length < count) {
    const unused = [...left].filter(([id, n]) => n > 0 && !picks.includes(id));
    const candidates = unused.length > 0 ? unused : [...left].filter(([, n]) => n > 0);
    const weight = candidates.reduce((n, [, v]) => n + v, 0);
    let roll = Math.random() * weight;
    let chosen = candidates[candidates.length - 1][0];
    for (const [id, n] of candidates) {
      roll -= n;
      if (roll <= 0) {
        chosen = id;
        break;
      }
    }
    picks.push(chosen);
    left.set(chosen, (left.get(chosen) ?? 0) - 1);
  }
  return picks;
}

/** Pick from a list and fill one box. True when the box is filled (by us or by someone else). */
async function drawAndFill(
  db: Db,
  box: { orderId: string; orderLineId: string; boxNo: number; itemCount: number },
  list: 'main' | 'backup',
  now: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const picks = draw(await freeOnList(db, list), box.itemCount);
    if (!picks) return false;
    try {
      await saveBoxFill(db, {
        orderId: box.orderId,
        orderLineId: box.orderLineId,
        boxNo: box.boxNo,
        variantIds: picks,
        expectedFilledAt: null,
        actorId: null,
        now,
        source: list === 'main' ? 'auto' : 'backup',
      });
      return true;
    } catch (err) {
      if (err instanceof BoxRefusedError && err.reason === 'box_short') continue;
      if (err instanceof BoxRefusedError) return true;
      throw err;
    }
  }
  return false;
}

async function markShort(db: Db, orderId: string, now: number): Promise<void> {
  await db.execute(sql`
    UPDATE shop_orders SET box_short_at = ${now} WHERE id = ${orderId} AND box_short_at IS NULL`);
}

/**
 * Cancel and refund in full, then put everything back on the shelf. Falls back
 * to "keep the order and tell me" when it cannot safely run: no refund wiring,
 * no payment on record, or nobody to record the refund against.
 */
async function cancelAndRefund(
  db: Db,
  orderId: string,
  refundedBy: string | null,
  deps: MysteryBoxDeps,
): Promise<boolean> {
  const read = await readOrder(db, orderId);
  if (!read || read.order.status !== 'paid') return false;
  const amount = read.order.grandTotal - read.order.refundedTotal;
  if (!deps.refund || !refundedBy || !read.order.paymentIntentId || amount <= 0) {
    await markShort(db, orderId, deps.now);
    return false;
  }

  await deps.refund(db, {
    intentId: read.order.paymentIntentId,
    amount,
    reason: 'Mystery box could not be filled',
    idempotencyKey: `mystery-box-short:${orderId}:${amount}`,
    createdBy: refundedBy,
  });

  await cancelOrder(
    db,
    orderId,
    {
      reason: 'admin',
      actorId: null,
      link: deps.origin
        ? {
            origin: deps.origin,
            token: mintGuestToken({ orderNumber: read.order.orderNumber, email: read.order.email }, deps.now),
          }
        : null,
      templates: deps.templates,
      refundedAmount: amount,
    },
    deps.now,
    null,
  );

  await refundPoints(db, deps.redemption, orderId, read.order.orderNumber, 'mystery box could not be filled');

  /* Nothing has shipped: the order was paid moments ago. Every unit goes back,
     and so does anything the shop had already packed into another box. */
  await restockCancelledOrder(db, {
    orderId,
    lines: read.lines.map((l) => ({ orderLineId: l.id, qty: l.qty - l.fulfilledQty })),
    keptOutReason: null,
    actorId: refundedBy,
    now: deps.now,
  });
  const packed = (await listBoxFills(db, orderId)).flatMap((f) => f.items.map((i) => i.id));
  await returnBoxItemsToStock(db, { orderId, itemIds: packed, actorId: refundedBy, now: deps.now });
  return true;
}

export async function processMysteryBoxes(db: Db, deps: MysteryBoxDeps): Promise<MysteryBoxRun> {
  const run: MysteryBoxRun = { filled: 0, short: 0, cancelled: 0 };
  let settings;
  try {
    settings = await mysteryBoxSettings(db);
  } catch (cause) {
    console.error('mystery box: could not read settings', cause);
    return run;
  }
  if (settings.mode === 'pack') return run;

  const open = await db.execute(sql`
    SELECT o.id AS order_id, ol.id AS line_id, ol.qty, ol.variant_id, v.box_item_count
      FROM shop_order_lines ol
      JOIN shop_orders o ON o.id = ol.order_id
      JOIN shop_variants v ON v.id = ol.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE o.status = 'paid' AND o.source = 'online' AND o.box_short_at IS NULL
       AND p.box_mode IS NOT NULL
       AND ol.qty > (SELECT count(*) FROM shop_box_fills f WHERE f.order_line_id = ol.id)
     ORDER BY o.paid_at, o.id, ol.line_no
     LIMIT 50`);

  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const r of open.rows) {
    const id = String(r.order_id);
    byOrder.set(id, [...(byOrder.get(id) ?? []), r]);
  }

  for (const [orderId, lines] of byOrder) {
    try {
      let short = false;
      const filled = await listBoxFills(db, orderId);
      for (const line of lines) {
        const itemCount = line.box_item_count == null ? null : Number(line.box_item_count);
        for (let boxNo = 1; boxNo <= Number(line.qty) && !short; boxNo += 1) {
          if (filled.some((f) => f.orderLineId === String(line.line_id) && f.boxNo === boxNo)) continue;
          const box = { orderId, orderLineId: String(line.line_id), boxNo, itemCount: itemCount ?? 0 };
          let ok = false;
          if (itemCount === null) {
            ok = false;
          } else if (settings.mode === 'built') {
            ok = await assignBuiltBox(db, { ...box, sizeVariantId: String(line.variant_id) });
          } else {
            ok = await drawAndFill(db, box, 'main', deps.now);
          }
          if (!ok && itemCount !== null && settings.shortfall === 'backup') {
            ok = await drawAndFill(db, box, 'backup', deps.now);
          }
          if (ok) run.filled += 1;
          else short = true;
        }
        if (short) break;
      }

      if (short) {
        if (settings.shortfall === 'cancel_refund') {
          if (await cancelAndRefund(db, orderId, settings.updatedBy, deps)) run.cancelled += 1;
          else run.short += 1;
        } else {
          await markShort(db, orderId, deps.now);
          run.short += 1;
        }
      }
    } catch (cause) {
      console.error('mystery box: could not handle order', orderId, cause);
      try {
        await markShort(db, orderId, deps.now);
      } catch {
        /* The next sweep tries again. */
      }
    }
  }
  return run;
}
