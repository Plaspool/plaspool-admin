/**
 * Manual orders (migration 1110): a sale made outside the online checkout,
 * recorded complete by the owner, editable with every save kept.
 *
 * Through the REAL application, like `routes.test.ts`, because the properties
 * that matter are cross-surface: the order counts in analytics, sits on the
 * board as delivered, stays out of the buyers list without an email, and never
 * shows a customer what the staff wrote about it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { ordersClient, resetOrdersDeps, CUSTOMER_HEADER, type OrdersClient } from './test/app';
import { resetOrderTables } from './test/harness';
import { seedSellable, seedVariant } from '../catalog/test/catalog-harness';
import { getInventory } from '../catalog/inventory';
import { soldAtFromDate } from './routes';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
let mug: { variantId: string; productId: string };
let cap: { variantId: string };
let unpriced: { variantId: string };

const BASE = '/api/shop/admin/orders';
const WAT = 3_600_000;

/** A day before today in WAT, as the form sends it. */
function daysAgo(n: number): string {
  return new Date(Date.now() + WAT - n * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  ctx = await freshDb();
  const owner = ctx.users.owner;
  const a = await seedSellable(ctx.db, owner, { title: 'Spool mug', amount: 500_000, onHand: 20 });
  mug = { variantId: a.variant.id, productId: a.product.id };
  const b = await seedSellable(ctx.db, owner, { title: 'Spool cap', amount: 250_000, onHand: 10 });
  cap = { variantId: b.variant.id };
  const c = await seedVariant(ctx.db, a.product.id, owner, { amount: null, onHand: 5 });
  unpriced = { variantId: c.id };
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

async function as(user: AuthUser): Promise<OrdersClient> {
  const c = ordersClient(ctx.db);
  await c.signIn(user);
  return c;
}

async function onHand(variantId: string): Promise<number> {
  return (await getInventory(ctx.db, variantId))!.onHand;
}

interface Detail {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    source: string;
    revision: number;
    subtotal: number;
    grandTotal: number;
    paidAt: number | null;
    placedAt: number;
  };
  lines: Array<{ variantId: string; qty: number; unitAmount: number; fulfilledQty: number }>;
  manual: {
    paymentMethod: string;
    paymentReference: string | null;
    salesChannel: string | null;
    note: string | null;
    stockTaken: boolean;
    customer: { name: string | null; email: string | null; phone: string | null };
  } | null;
  stock?: { failed: Array<{ variantId: string; reason: string }> };
}

async function record(c: OrdersClient, body: Record<string, unknown> = {}): Promise<Detail> {
  const res = await c.post(`${BASE}/manual`, {
    soldAt: daysAgo(2),
    lines: [{ variantId: mug.variantId, qty: 2 }],
    paymentMethod: 'bank_transfer',
    ...body,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<Detail>(res);
}

describe('recording a manual order', () => {
  it('writes it complete: sent out, paid on the day sold, priced from the catalogue', async () => {
    const c = await as(ctx.users.owner);
    const before = await onHand(mug.variantId);
    const d = await record(c, { paymentReference: 'FLW-123' });

    expect(d.order.source).toBe('manual');
    expect(d.order.status).toBe('fulfilled');
    expect(d.order.subtotal).toBe(1_000_000);
    expect(d.order.grandTotal).toBe(1_000_000);
    expect(d.order.paidAt).toBe(soldAtFromDate(daysAgo(2)));
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].fulfilledQty).toBe(2);
    expect(d.manual).toMatchObject({ paymentMethod: 'bank_transfer', paymentReference: 'FLW-123', stockTaken: true });
    expect(d.stock?.failed).toEqual([]);
    expect(await onHand(mug.variantId)).toBe(before - 2);
  });

  it('takes a typed price and the advanced details, and leaves stock alone when asked', async () => {
    const c = await as(ctx.users.owner);
    const before = await onHand(cap.variantId);
    const d = await record(c, {
      lines: [{ variantId: cap.variantId, qty: 1, unitAmount: 200_000 }],
      paymentMethod: 'flutterwave_link',
      takeFromStock: false,
      advanced: {
        customer: { name: 'Ada', email: 'Ada@Example.test', phone: '0801' },
        salesChannel: 'whatsapp',
        shippingAmount: 150_000,
        discountAmount: 50_000,
        note: 'Paid half upfront',
      },
    });
    expect(d.order.grandTotal).toBe(200_000 + 150_000 - 50_000);
    expect(d.manual).toMatchObject({
      salesChannel: 'whatsapp',
      note: 'Paid half upfront',
      stockTaken: false,
      customer: { name: 'Ada', email: 'Ada@Example.test', phone: '0801' },
    });
    expect(await onHand(cap.variantId)).toBe(before);
  });

  it('refuses a variant with no price unless one is typed', async () => {
    const c = await as(ctx.users.owner);
    const res = await c.post(`${BASE}/manual`, {
      soldAt: daysAgo(1),
      lines: [{ variantId: unpriced.variantId, qty: 1 }],
      paymentMethod: 'cash',
    });
    expect(res.status).toBe(400);
    await record(c, { lines: [{ variantId: unpriced.variantId, qty: 1, unitAmount: 1_000 }], paymentMethod: 'cash' });
  });

  it('refuses a day that has not happened, an unknown variant, and a missing payment method', async () => {
    const c = await as(ctx.users.owner);
    const tomorrow = new Date(Date.now() + WAT + 86_400_000).toISOString().slice(0, 10);
    const bad = [
      { soldAt: tomorrow, lines: [{ variantId: mug.variantId, qty: 1 }], paymentMethod: 'cash' },
      { soldAt: daysAgo(1), lines: [{ variantId: 'var_nope', qty: 1 }], paymentMethod: 'cash' },
      { soldAt: daysAgo(1), lines: [{ variantId: mug.variantId, qty: 1 }] },
      { soldAt: daysAgo(1), lines: [], paymentMethod: 'cash' },
    ];
    for (const body of bad) expect((await c.post(`${BASE}/manual`, body)).status).toBe(400);
    const count = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_orders`);
    expect(count.rows[0].n).toBe(0);
  });

  it('filters the list by where the order came from', async () => {
    const c = await as(ctx.users.owner);
    const manual = await record(c);
    // An online order to be excluded by the same filter.
    await ctx.db.execute(sql`
      INSERT INTO shop_orders (id, order_number, email, currency, subtotal, shipping_total,
                               tax_total, grand_total, status, shipping_address, billing_address,
                               placed_at, revision, source_event_id, checkout_id, source)
      VALUES ('ord_online_filter', '2026-000999-Z', 'shopper@example.test', 'NGN', 1000, 0,
              0, 1000, 'paid', '{}'::jsonb, '{}'::jsonb, ${Date.now()}, 1,
              'evt_filter', 'chk_filter', 'online')`);

    const ids = async (query: string) =>
      (await json<{ items: Array<{ order: { id: string } }> }>(await c.get(`${BASE}${query}`))).items.map(
        (i) => i.order.id,
      );
    expect((await ids('')).sort()).toEqual([manual.order.id, 'ord_online_filter'].sort());
    expect(await ids('?source=manual')).toEqual([manual.order.id]);
    expect(await ids('?source=online')).toEqual(['ord_online_filter']);
    expect((await c.get(`${BASE}?source=elsewhere`)).status).toBe(400);
  });

  it('shows on the list and as delivered on the day it was sold', async () => {
    const c = await as(ctx.users.owner);
    const d = await record(c);
    const res = await c.get(`${BASE}/${d.order.id}`);
    const detail = await json<{ order: { deliveredAt: number | null }; manual: unknown }>(res);
    expect(res.status).toBe(200);
    expect(detail.order.deliveredAt).toBe(d.order.paidAt);
    expect(detail.manual).not.toBeNull();
    const list = await json<{ items: Array<{ order: { id: string } }> }>(await c.get(BASE));
    expect(list.items.map((i) => i.order.id)).toContain(d.order.id);
  });
});

describe('the figures', () => {
  it('counts in analytics, and a void takes it back out', async () => {
    const c = await as(ctx.users.owner);
    const d = await record(c);
    const read = async () =>
      (await json<{ totals: { orders: number; sales: number } }>(await c.get('/api/shop/admin/analytics?days=30')))
        .totals;
    expect(await read()).toMatchObject({ orders: 1, sales: 1_000_000 });

    const v = await c.post(`${BASE}/${d.order.id}/void`, { baseRevision: d.order.revision, reason: 'Typed twice' });
    expect(v.status, await v.clone().text()).toBe(200);
    expect(await read()).toMatchObject({ orders: 0, sales: 0 });
  });

  it('keeps a sale with no email out of the buyers list, and joins one with an email', async () => {
    const c = await as(ctx.users.owner);
    await record(c);
    await record(c, { advanced: { customer: { email: 'ada@example.test' } } });
    const buyers = await json<{ items: Array<{ email: string; paidCount: number }> }>(
      await c.get('/api/shop/admin/customers'),
    );
    expect(buyers.items).toEqual([expect.objectContaining({ email: 'ada@example.test', paidCount: 1 })]);
  });
});

describe('editing', () => {
  it('replaces the lines, moves stock by the difference, and keeps every save', async () => {
    const c = await as(ctx.users.owner);
    const mugBefore = await onHand(mug.variantId);
    const capBefore = await onHand(cap.variantId);
    const d = await record(c, { lines: [{ variantId: mug.variantId, qty: 3 }] });
    expect(await onHand(mug.variantId)).toBe(mugBefore - 3);

    const res = await c.put(`${BASE}/${d.order.id}/manual`, {
      baseRevision: d.order.revision,
      soldAt: daysAgo(3),
      lines: [
        { variantId: mug.variantId, qty: 1 },
        { variantId: cap.variantId, qty: 2 },
      ],
      paymentMethod: 'cash',
      paymentReference: 'receipt 9',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const e = await json<Detail>(res);
    expect(e.order.revision).toBe(d.order.revision + 1);
    expect(e.order.subtotal).toBe(500_000 + 500_000);
    expect(e.lines.map((l) => [l.variantId, l.qty])).toEqual([
      [mug.variantId, 1],
      [cap.variantId, 2],
    ]);
    expect(e.order.paidAt).toBe(soldAtFromDate(daysAgo(3)));
    expect(e.manual).toMatchObject({ paymentMethod: 'cash', paymentReference: 'receipt 9' });
    expect(await onHand(mug.variantId)).toBe(mugBefore - 1);
    expect(await onHand(cap.variantId)).toBe(capBefore - 2);

    const revs = await json<{ items: Array<{ revision: number; kind: string; editedBy: { name: string } | null; snapshot: { paymentMethod: string } }> }>(
      await c.get(`${BASE}/${d.order.id}/revisions`),
    );
    expect(revs.items.map((r) => [r.kind, r.snapshot.paymentMethod])).toEqual([
      ['edited', 'cash'],
      ['created', 'bank_transfer'],
    ]);
    expect(revs.items[0].editedBy?.name).toBe(ctx.users.owner.displayName);

    const events = await ctx.db.execute(sql`
      SELECT type FROM shop_order_events WHERE order_id = ${d.order.id} ORDER BY occurred_at, type`);
    expect(events.rows.map((r) => r.type)).toEqual(expect.arrayContaining(['placed', 'edited']));
  });

  it('answers 409 to an edit made against an old revision', async () => {
    const c = await as(ctx.users.owner);
    const d = await record(c);
    const body = { soldAt: daysAgo(1), lines: [{ variantId: mug.variantId, qty: 1 }], paymentMethod: 'cash' };
    expect((await c.put(`${BASE}/${d.order.id}/manual`, { ...body, baseRevision: d.order.revision })).status).toBe(200);
    expect((await c.put(`${BASE}/${d.order.id}/manual`, { ...body, baseRevision: d.order.revision })).status).toBe(409);
  });

  it('turning stock-taking off on an edit puts the items back', async () => {
    const c = await as(ctx.users.owner);
    const before = await onHand(mug.variantId);
    const d = await record(c);
    await c.put(`${BASE}/${d.order.id}/manual`, {
      baseRevision: d.order.revision,
      soldAt: daysAgo(2),
      lines: [{ variantId: mug.variantId, qty: 2 }],
      paymentMethod: 'bank_transfer',
      takeFromStock: false,
    });
    expect(await onHand(mug.variantId)).toBe(before);
  });
});

describe('voiding', () => {
  it('cancels it, puts stock back, and refuses to edit or void it again', async () => {
    const c = await as(ctx.users.owner);
    const before = await onHand(mug.variantId);
    const d = await record(c);
    const res = await c.post(`${BASE}/${d.order.id}/void`, { baseRevision: d.order.revision });
    const v = await json<Detail>(res);
    expect(v.order.status).toBe('cancelled');
    expect(v.order.paidAt).toBeNull();
    expect(await onHand(mug.variantId)).toBe(before);

    const again = await c.post(`${BASE}/${d.order.id}/void`, { baseRevision: v.order.revision });
    expect(again.status).toBe(400);
    const edit = await c.put(`${BASE}/${d.order.id}/manual`, {
      baseRevision: v.order.revision,
      soldAt: daysAgo(1),
      lines: [{ variantId: mug.variantId, qty: 1 }],
      paymentMethod: 'cash',
    });
    expect(edit.status).toBe(400);

    const revs = await json<{ items: Array<{ kind: string }> }>(await c.get(`${BASE}/${d.order.id}/revisions`));
    expect(revs.items.map((r) => r.kind)).toEqual(['voided', 'created']);
  });

  it('is an admin action', async () => {
    const owner = await as(ctx.users.owner);
    const d = await record(owner);
    const support = await as(ctx.users.supplyChain);
    const res = await support.post(`${BASE}/${d.order.id}/void`, { baseRevision: d.order.revision });
    expect([401, 403]).toContain(res.status);
  });
});

describe('online orders are not manual ones', () => {
  it('refuses to edit or void an order that came through the checkout', async () => {
    const c = await as(ctx.users.owner);
    const d = await record(c);
    await ctx.db.execute(sql`UPDATE shop_orders SET source = 'online', payment_method = NULL, email = 'x@example.test' WHERE id = ${d.order.id}`);
    const edit = await c.put(`${BASE}/${d.order.id}/manual`, {
      baseRevision: d.order.revision,
      soldAt: daysAgo(1),
      lines: [{ variantId: mug.variantId, qty: 1 }],
      paymentMethod: 'cash',
    });
    expect(edit.status).toBe(400);
    expect((await c.post(`${BASE}/${d.order.id}/void`, { baseRevision: d.order.revision })).status).toBe(400);
  });

  it('keeps the append-only guard on online order lines', async () => {
    const c = await as(ctx.users.owner);
    const d = await record(c);
    await ctx.db.execute(sql`UPDATE shop_orders SET source = 'online', payment_method = NULL, email = 'x@example.test' WHERE id = ${d.order.id}`);
    await expect(
      ctx.db.execute(sql`DELETE FROM shop_order_lines WHERE order_id = ${d.order.id}`),
    ).rejects.toThrow();
  });
});

describe('what the customer sees', () => {
  it('shows the buyer their order without the staff note or the payment reference', async () => {
    await ctx.db.execute(sql`
      INSERT INTO shop_customers (id, email, display_name, created_at)
      VALUES ('cus_manual_ada', 'ada@example.test', 'Ada', ${Date.now()})
      ON CONFLICT DO NOTHING`);
    const c = await as(ctx.users.owner);
    await record(c, {
      paymentReference: 'SECRET-REF-42',
      advanced: { customer: { email: 'ada@example.test' }, note: 'SECRET staff note' },
    });
    const res = await c.get('/api/shop/orders', { headers: { [CUSTOMER_HEADER]: 'cus_manual_ada' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).items).toHaveLength(1);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('bank_transfer');
  });

  it('keeps who recorded, edited or voided it, and why, off the customer timeline', async () => {
    await ctx.db.execute(sql`
      INSERT INTO shop_customers (id, email, display_name, created_at)
      VALUES ('cus_manual_ada', 'ada@example.test', 'Ada', ${Date.now()})
      ON CONFLICT DO NOTHING`);
    const c = await as(ctx.users.owner);
    const d = await record(c, { advanced: { customer: { email: 'ada@example.test' } } });
    const edited = await json<Detail>(
      await c.put(`${BASE}/${d.order.id}/manual`, {
        baseRevision: d.order.revision,
        soldAt: daysAgo(2),
        lines: [{ variantId: mug.variantId, qty: 1 }],
        paymentMethod: 'cash',
        advanced: { customer: { email: 'ada@example.test' } },
      }),
    );
    await c.post(`${BASE}/${d.order.id}/void`, { baseRevision: edited.order.revision, reason: 'SECRET suspected fraud' });

    const mine = await c.get(`/api/shop/orders/${d.order.orderNumber}/events`, {
      headers: { [CUSTOMER_HEADER]: 'cus_manual_ada' },
    });
    expect(mine.status).toBe(200);
    const text = await mine.text();
    expect(JSON.parse(text).events.map((e: { type: string }) => e.type)).toEqual(['placed', 'edited', 'cancelled']);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain(ctx.users.owner.displayName);
    expect(text).not.toContain('actorName');

    // The admin timeline names who did each step.
    const admin = await json<{ timeline: Array<{ actorName: string | null }> }>(await c.get(`${BASE}/${d.order.id}`));
    expect(admin.timeline.map((e) => e.actorName)).toEqual(Array(3).fill(ctx.users.owner.displayName));
  });
});

describe('soldAtFromDate', () => {
  const now = Date.UTC(2026, 8, 11, 15, 30);
  it('is noon WAT on a past day, and now on today', () => {
    expect(soldAtFromDate('2026-09-01', now)).toBe(Date.UTC(2026, 8, 1, 11));
    expect(soldAtFromDate('2026-09-11', now)).toBe(now);
  });
  it('refuses the future, impossible dates and the distant past', () => {
    for (const day of ['2026-09-12', '2026-02-30', '1999-12-31']) {
      expect(() => soldAtFromDate(day, now)).toThrow();
    }
  });
});
