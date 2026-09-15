/**
 * Cancelling a paid order puts back what staff choose, line by line
 * (migration 1200).
 *
 * THROUGH THE REAL APPLICATION, like `routes.test.ts` and `manual.test.ts`,
 * because this is stock moving on a money path (CLAUDE.md §2). Before this,
 * the Cancel dialog said "Cancelling puts the stock back" while nothing did:
 * the units a paid order took at capture (`commitHold`) stayed taken, and the
 * `order.cancelled` event that might have returned them is ignored by the only
 * consumer that sees it. Measured on a clean master before writing this file:
 * on_hand 8 before a paid cancel, 8 after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from './test/app';
import { resetOrderTables } from './test/harness';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from './test/fixtures';
import { sweepCommerceEvents } from './repo/consumer';
import { markOrderPaid, readOrderByCheckout, type OrderRead } from './repo/orders';
import { createFulfillment, shipFulfillment } from './repo/fulfillments';
import { seedSellable } from '../catalog/test/catalog-harness';
import { commitHold, getInventory, reserve } from '../catalog/inventory';

let ctx: TestCtx;
let owner: OrdersClient;
const spool = { variantId: '', sku: '' };
const mug = { variantId: '', sku: '' };
const NOW = T0 + 10_000;

beforeAll(async () => {
  ctx = await freshDb();
  const a = await seedSellable(ctx.db, ctx.users.owner, { title: 'PLA Silk Gold', onHand: 10 });
  spool.variantId = a.variant.id;
  spool.sku = a.variant.sku;
  const b = await seedSellable(ctx.db, ctx.users.owner, { title: 'Spool mug', onHand: 10 });
  mug.variantId = b.variant.id;
  mug.sku = b.variant.sku;
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM shop_inventory_holds`);
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
  await ctx.db.execute(sql`UPDATE shop_inventory SET on_hand = 10, reserved = 0`);
  owner = ordersClient(ctx.db, { now: () => NOW });
  await owner.signIn(ctx.users.owner);
});

const onHand = async (variantId: string) => (await getInventory(ctx.db, variantId))!.onHand;

const line = (v: { variantId: string; sku: string }, title: string, qty: number) => ({
  variantId: v.variantId,
  sku: v.sku,
  title,
  optionValues: {},
  qty,
  unitAmount: 1500,
  lineTotal: 1500 * qty,
});

/**
 * A PAID order exactly as checkout makes one: the units are held for the cart,
 * committed at capture (on_hand drops), then the order is created and paid.
 * Spool ×3, mug ×2 — on_hand starts at 10, so 7 and 8 once paid.
 */
async function paidOrder(): Promise<OrderRead> {
  for (const [v, qty] of [
    [spool, 3],
    [mug, 2],
  ] as const) {
    const id = `res_${v.sku}`;
    expect((await reserve(ctx.db, { reservationId: id, variantId: v.variantId, qty, expiresAt: Date.now() + 3_600_000 })).ok).toBe(true);
    await commitHold(ctx.db, id);
  }
  await insertEvents(ctx.db, [
    checkoutCompleted({
      lines: [line(spool, 'PLA Silk Gold', 3), line(mug, 'Spool mug', 2)],
      subtotal: 7500,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal: 7500,
    }),
  ]);
  await sweepCommerceEvents(ctx.db, { origin: null }, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrderByCheckout(ctx.db, CHECKOUT))!;
}

const lineOf = (read: OrderRead, variantId: string) => read.lines.find((l) => l.variantId === variantId)!;

const cancel = (orderId: string, body: Record<string, unknown>) =>
  owner.post(`/api/shop/admin/orders/${orderId}/cancel`, body);

describe('cancelling a paid order puts back what staff choose', () => {
  it('puts back exactly the chosen quantity of each line, and records it as a stock change', async () => {
    const read = await paidOrder();
    expect(await onHand(spool.variantId)).toBe(7);
    expect(await onHand(mug.variantId)).toBe(8);

    const res = await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: {
        lines: [
          { orderLineId: lineOf(read, spool.variantId).id, qty: 2 },
          { orderLineId: lineOf(read, mug.variantId).id, qty: 2 },
        ],
        keptOutReason: 'One spool arrived back with a broken seal',
      },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ order: { status: 'cancelled' }, restock: { returned: 4 } });

    expect(await onHand(spool.variantId)).toBe(9);
    expect(await onHand(mug.variantId)).toBe(10);

    const events = await ctx.db.execute(sql`
      SELECT subject_id, payload FROM commerce_events
       WHERE type = 'catalog.inventory.adjusted' ORDER BY subject_id`);
    expect(events.rows.map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: spool.variantId, delta: 2, onHand: 9, actorId: ctx.users.owner.id }),
        expect.objectContaining({ variantId: mug.variantId, delta: 2, onHand: 10 }),
      ]),
    );
    expect(String((events.rows[0].payload as { reason: string }).reason)).toContain(read.order.orderNumber);
  });

  it('shows staff what went back and why the rest stayed out, and never shows the customer', async () => {
    const read = await paidOrder();
    await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [{ orderLineId: lineOf(read, spool.variantId).id, qty: 1 }], keptOutReason: 'Opened' },
    });

    const detail = await json<{ restock: unknown }>(await owner.get(`/api/shop/admin/orders/${read.order.id}`));
    expect(detail.restock).toEqual({
      lines: expect.arrayContaining([
        { orderLineId: lineOf(read, spool.variantId).id, returnedQty: 1 },
        { orderLineId: lineOf(read, mug.variantId).id, returnedQty: 0 },
      ]),
      keptOutReason: 'Opened',
    });

    const customer = ordersClient(ctx.db, { now: () => NOW });
    customer.asCustomer({ id: read.order.customerId! });
    const customerRes = await customer.get(`/api/shop/orders/${read.order.orderNumber}`);
    expect(customerRes.status).toBe(200);
    const view = JSON.stringify(await json(customerRes));
    expect(view).toContain('PLA Silk Gold');
    expect(view).not.toContain('Opened');
    expect(view).not.toContain('returnedQty');
    expect(view).not.toContain('keptOut');
  });

  it('stores a blank reason as NULL, never as an empty string', async () => {
    const read = await paidOrder();
    await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [], keptOutReason: '   ' },
    });
    const row = await ctx.db.execute(sql`SELECT kept_out_reason FROM shop_orders WHERE id = ${read.order.id}`);
    expect(row.rows[0].kept_out_reason).toBeNull();
  });

  it('refuses to put back units already on their way, and puts nothing back for that line', async () => {
    const read = await paidOrder();
    const spoolLine = lineOf(read, spool.variantId);
    const parcel = await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: spoolLine.id, qty: 2 }], carrier: null, trackingNumber: null },
      ctx.users.owner.id,
      NOW,
    );
    await shipFulfillment(ctx.db, parcel.id, NOW, null, ctx.users.owner.id);

    const res = await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [{ orderLineId: spoolLine.id, qty: 2 }] },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ restock: { returned: 0, refused: [spoolLine.id] } });
    expect(await onHand(spool.variantId)).toBe(7);

    /* One unit of three was never shipped, and that one CAN go back. */
    const { restockCancelledOrder } = await import('./repo/restock');
    const again = await restockCancelledOrder(ctx.db, {
      orderId: read.order.id,
      lines: [{ orderLineId: spoolLine.id, qty: 1 }],
      keptOutReason: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });
    expect(again).toEqual({ returned: 1, refused: [] });
    expect(await onHand(spool.variantId)).toBe(8);
  });

  it('counts a parcel that was packed but not shipped as still on the shelf', async () => {
    const read = await paidOrder();
    const mugLine = lineOf(read, mug.variantId);
    await createFulfillment(
      ctx.db,
      read.order.id,
      { lines: [{ orderLineId: mugLine.id, qty: 2 }], carrier: null, trackingNumber: null },
      ctx.users.owner.id,
      NOW,
    );
    const res = await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [{ orderLineId: mugLine.id, qty: 2 }] },
    });
    expect(await json(res)).toMatchObject({ restock: { returned: 2 } });
    expect(await onHand(mug.variantId)).toBe(10);
  });

  it('never puts back more than was taken, however often it is asked', async () => {
    const read = await paidOrder();
    const spoolLine = lineOf(read, spool.variantId);
    await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [{ orderLineId: spoolLine.id, qty: 3 }] },
    });
    const { restockCancelledOrder } = await import('./repo/restock');
    const repeat = await restockCancelledOrder(ctx.db, {
      orderId: read.order.id,
      lines: [{ orderLineId: spoolLine.id, qty: 3 }],
      keptOutReason: null,
      actorId: ctx.users.owner.id,
      now: NOW,
    });
    expect(repeat).toEqual({ returned: 0, refused: [spoolLine.id] });
    expect(await onHand(spool.variantId)).toBe(10);
  });

  it('refuses a restock list on an order that was never paid — its stock was only set aside', async () => {
    const r = await reserve(ctx.db, { reservationId: 'res_unpaid', variantId: spool.variantId, qty: 3, expiresAt: Date.now() + 3_600_000 });
    expect(r.ok).toBe(true);
    await insertEvents(ctx.db, [
      checkoutCompleted({ lines: [line(spool, 'PLA Silk Gold', 3)], subtotal: 4500, shippingTotal: 0, taxTotal: 0, grandTotal: 4500 }),
    ]);
    await sweepCommerceEvents(ctx.db, { origin: null }, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;

    const res = await cancel(read.order.id, {
      restock: { lines: [{ orderLineId: read.lines[0].id, qty: 3 }] },
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'restock' });
    expect(await onHand(spool.variantId)).toBe(10);
  });

  it('refuses a line that belongs to another order, before cancelling anything', async () => {
    const read = await paidOrder();
    const res = await cancel(read.order.id, {
      refund: { kind: 'none' },
      restock: { lines: [{ orderLineId: 'oln_somebody_elses', qty: 1 }] },
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'restock.orderLineId' });
    const status = await ctx.db.execute(sql`SELECT status FROM shop_orders WHERE id = ${read.order.id}`);
    expect(status.rows[0].status).toBe('paid');
  });

  it('answers exactly as before when no restock list is sent', async () => {
    const read = await paidOrder();
    const body = await json<Record<string, unknown>>(await cancel(read.order.id, { refund: { kind: 'none' } }));
    expect(Object.keys(body)).toEqual(['order']);
    expect(await onHand(spool.variantId)).toBe(7);
  });
});
