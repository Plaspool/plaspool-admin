/**
 * Ship-time carrier/tracking, the details-only edit, and tracking on the
 * customer surface (owner's 2026-08-31 batch).
 *
 * Every test drives the REAL application (`ordersClient` → `createApp()`), per
 * CLAUDE.md §2: the origin guard, the session middleware and the error table
 * are all in the path, because the seam between the repository and HTTP is
 * where this batch's defects would live.
 *
 * THE PROPERTY THAT MATTERS MOST HERE: the shipment email intent is written by
 * the SAME statement as the ship transition, so the values the operator
 * confirms in the ship dialog are the values the customer is told. That is
 * asserted by reading the intent row, not by trusting the render.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { json } from '../../test/http';
import { TEST_ORIGIN } from '../../test/http';
import { ordersClient, resetOrdersDeps, type OrdersClient } from './test/app';
import { resetOrderTables } from './test/harness';
import { CHECKOUT, CUSTOMER_A, T0, checkoutCompleted, insertEvents } from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import { markOrderPaid, readOrder, readOrderByCheckout, type OrderRead } from './repo/orders';
import { listIntents } from './repo/emails';
import { mintGuestToken } from './tokens';
import type { AuthUser } from '../../../shared/types';

let ctx: TestCtx;
const NOW = T0 + 10_000;
const DEPS: ConsumerDeps = { origin: TEST_ORIGIN };

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  resetOrdersDeps();
  await resetOrderTables(ctx.db);
  /* Login is rate limited per (ip, email) IN POSTGRES (see routes.test.ts) —
   * without this a suite that logs in per test starts answering 429. */
  await ctx.db.execute(sql`DELETE FROM auth_attempts`);
  await ctx.db.execute(sql`DELETE FROM sessions`);
});

function client(deps = {}): OrdersClient {
  return ordersClient(ctx.db, { now: () => NOW, ...deps });
}

async function login(user: AuthUser, deps = {}): Promise<OrdersClient> {
  const c = client(deps);
  await c.signIn(user);
  return c;
}

/** One paid order belonging to `CUSTOMER_A`. */
async function paidOrder(customerId: string | null = CUSTOMER_A): Promise<OrderRead> {
  await insertEvents(ctx.db, [
    { ...checkoutCompleted({ customerId }), id: `evt_chk_${customerId ?? 'guest'}` },
  ]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
  await markOrderPaid(ctx.db, read.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read.order.id))!;
}

/** One parcel over the first line, created through the real route. */
async function createParcel(
  admin: OrdersClient,
  read: OrderRead,
  details: { carrier?: string | null; trackingNumber?: string | null } = {},
): Promise<{ id: string }> {
  const res = await admin.post(`/api/shop/admin/orders/${read.order.id}/fulfillments`, {
    lines: [{ orderLineId: read.lines[0].id, qty: 1 }],
    ...details,
  });
  expect(res.status).toBe(201);
  return (await json<{ fulfillment: { id: string } }>(res)).fulfillment;
}

/** The parcel's row, straight from the table — the record the email freezes. */
async function parcelRow(id: string) {
  const res = await ctx.db.execute(sql`
    SELECT status, carrier, tracking_number, revision FROM shop_fulfillments WHERE id = ${id}`);
  const row = res.rows[0]!;
  return {
    status: String(row.status),
    carrier: row.carrier == null ? null : String(row.carrier),
    trackingNumber: row.tracking_number == null ? null : String(row.tracking_number),
    revision: Number(row.revision),
  };
}

// ================================================== shipping with tracking

describe('PATCH { status: shipped } with carrier/tracking', () => {
  it('writes the details with the transition, and the shipment email carries the NEW values', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    /* Created with placeholder details, shipped with real ones — the case the
     * dialog exists for. The email must carry what was confirmed at SHIP time,
     * not what somebody guessed at parcel creation. */
    const parcel = await createParcel(owner, read, { carrier: 'TBD', trackingNumber: 'OLD-1' });

    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      status: 'shipped',
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-123',
    });
    expect(res.status).toBe(200);
    const body = await json<{
      fulfillment: { status: string; carrier: string | null; trackingNumber: string | null };
    }>(res);
    expect(body.fulfillment).toMatchObject({
      status: 'shipped',
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-123',
    });

    // The columns, read back independently of the response.
    expect(await parcelRow(parcel.id)).toMatchObject({
      status: 'shipped',
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-123',
    });

    /*
     * THE EMAIL, written by the same statement as the transition. Both parts —
     * the text body and the authored HTML — must carry the confirmed tracking
     * number, and neither may carry the placeholder it replaced.
     */
    const shipments = (await listIntents(ctx.db, read.order.id)).filter(
      (intent) => intent.kind === 'shipment',
    );
    expect(shipments).toHaveLength(1);
    expect(shipments[0].body).toContain('GIG-123');
    expect(shipments[0].body).toContain('GIG Logistics');
    expect(shipments[0].html).toContain('GIG-123');
    expect(shipments[0].body).not.toContain('OLD-1');
    expect(shipments[0].html).not.toContain('OLD-1');
  });

  it('a bare { status: shipped } keeps the stored details — absent means keep', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read, { carrier: 'DHL', trackingNumber: 'KEEP-1' });

    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      status: 'shipped',
    });
    expect(res.status).toBe(200);

    expect(await parcelRow(parcel.id)).toMatchObject({
      carrier: 'DHL',
      trackingNumber: 'KEEP-1',
    });
    const shipments = (await listIntents(ctx.db, read.order.id)).filter(
      (intent) => intent.kind === 'shipment',
    );
    expect(shipments[0].body).toContain('KEEP-1');
  });

  it('delivered and cancelled REFUSE the detail fields, naming the field', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read);
    await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, { status: 'shipped' });

    const delivered = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      status: 'delivered',
      carrier: 'DHL',
    });
    expect(delivered.status).toBe(400);
    expect(await json(delivered)).toMatchObject({ error: 'bad_request', detail: 'carrier' });

    const cancelled = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      status: 'cancelled',
      trackingNumber: 'X',
    });
    expect(cancelled.status).toBe(400);
    expect(await json(cancelled)).toMatchObject({
      error: 'bad_request',
      detail: 'trackingNumber',
    });

    // Neither refusal touched the row.
    expect((await parcelRow(parcel.id)).status).toBe('shipped');
  });
});

// ==================================================== the details-only edit

describe('PATCH with no status — a details-only edit', () => {
  it('updates a pending parcel without transitioning it, and writes no timeline entry', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read);

    const eventsBefore = await ctx.db.execute(
      sql`SELECT count(*) AS n FROM shop_order_events WHERE order_id = ${read.order.id}`,
    );

    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      carrier: 'DHL',
      trackingNumber: 'T-77',
    });
    expect(res.status).toBe(200);
    const body = await json<Record<string, unknown>>(res);
    expect(body.fulfillment).toMatchObject({
      status: 'pending',
      carrier: 'DHL',
      trackingNumber: 'T-77',
      shippedAt: null,
    });
    /* No transition happened, so there is no settlement to report — the shape
     * matches delivered/cancelled: no order key at all. */
    expect('order' in body).toBe(false);

    // The CAS bumped the revision (created at 1), and the status held.
    expect(await parcelRow(parcel.id)).toMatchObject({
      status: 'pending',
      carrier: 'DHL',
      trackingNumber: 'T-77',
      revision: 2,
    });

    /* A tracking typo fixed before anything shipped is not an event in the
     * order's customer-visible history. */
    const eventsAfter = await ctx.db.execute(
      sql`SELECT count(*) AS n FROM shop_order_events WHERE order_id = ${read.order.id}`,
    );
    expect(Number(eventsAfter.rows[0].n)).toBe(Number(eventsBefore.rows[0].n));
  });

  it('per field: absent keeps, explicit null clears', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read, { carrier: 'DHL', trackingNumber: 'T-77' });

    // Only the carrier travels: cleared. The tracking number is untouched.
    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      carrier: null,
    });
    expect(res.status).toBe(200);
    expect(await parcelRow(parcel.id)).toMatchObject({
      carrier: null,
      trackingNumber: 'T-77',
    });
  });

  it('is a 409 precondition_failed on a shipped parcel — the email already told the customer', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read, { trackingNumber: 'SENT-1' });
    await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, { status: 'shipped' });

    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      trackingNumber: 'REWRITE-1',
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      error: 'precondition_failed',
      operation: 'edit_tracking',
    });
    // The frozen record survived the attempt.
    expect((await parcelRow(parcel.id)).trackingNumber).toBe('SENT-1');
  });

  it('an empty body is a 400, not a silent no-op', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read);
    const res = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {});
    expect(res.status).toBe(400);
  });
});

// ============================================== tracking on the customer API

describe('the customer order lookup carries a SAFE fulfilments projection', () => {
  /** Ship one parcel with tracking, so the projection has something to say. */
  async function shippedOrder(): Promise<OrderRead> {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read, {
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-123',
    });
    const shipped = await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, {
      status: 'shipped',
    });
    expect(shipped.status).toBe(200);
    return read;
  }

  interface CustomerParcel {
    id: string;
    status: string;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: number | null;
    deliveredAt: number | null;
    createdAt: number;
  }

  function expectSafeParcel(parcel: CustomerParcel): void {
    /* AN EXACT KEY SET, not a contains: the projection is an allow-list, and
     * the leak this pins against is the next field somebody adds to the row —
     * revision, lifecycle internals, order-line ids.
     *
     * `trackingUrl` joined the list with the courier columns (migration 0960)
     * and is the ONLY one of the nine that did. The reference, the waybill,
     * the courier's raw status, what it cost us and the last sync error are
     * all on the row and all stay off this projection — which is the whole
     * argument for pinning the key set exactly rather than spreading the row
     * and deleting what looks private today. */
    expect(Object.keys(parcel).sort()).toEqual([
      'carrier',
      'createdAt',
      'deliveredAt',
      'id',
      'shippedAt',
      'status',
      'trackingNumber',
      'trackingUrl',
    ]);
    expect(parcel).toMatchObject({
      status: 'shipped',
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-123',
      /* Shipped by hand, so there is no courier page to link — the field is
       * present and null rather than absent, so a storefront reads one shape. */
      trackingUrl: null,
      shippedAt: NOW,
      deliveredAt: null,
    });
  }

  it('for the customer session path', async () => {
    const read = await shippedOrder();
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const res = await c.get(`/api/shop/orders/${read.order.orderNumber}`);
    expect(res.status).toBe(200);
    const body = await json<{ fulfillments: CustomerParcel[] }>(res);
    expect(body.fulfillments).toHaveLength(1);
    expectSafeParcel(body.fulfillments[0]);
  });

  it('for the guest-token path, identically', async () => {
    const read = await shippedOrder();
    const token = mintGuestToken(
      { orderNumber: read.order.orderNumber, email: read.order.email },
      NOW,
    );
    const res = await client().get(
      `/api/shop/orders/${read.order.orderNumber}?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const body = await json<{ fulfillments: CustomerParcel[] }>(res);
    expect(body.fulfillments).toHaveLength(1);
    expectSafeParcel(body.fulfillments[0]);
  });

  it('a cancelled parcel is not in the projection — an internal re-plan, never announced', async () => {
    const read = await paidOrder();
    const owner = await login(ctx.users.owner);
    const parcel = await createParcel(owner, read, { trackingNumber: 'NEVER-SENT' });
    await owner.patch(`/api/shop/admin/fulfillments/${parcel.id}`, { status: 'cancelled' });

    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const body = await json<{ fulfillments: unknown[] }>(
      await c.get(`/api/shop/orders/${read.order.orderNumber}`),
    );
    expect(body.fulfillments).toEqual([]);

    // The admin view still shows it — the record is for the operator.
    const admin = await json<{ fulfillments: { status: string }[] }>(
      await owner.get(`/api/shop/admin/orders/${read.order.id}`),
    );
    expect(admin.fulfillments.map((f) => f.status)).toEqual(['cancelled']);
  });

  it('the customer LIST stays lean: no fulfillments key on its rows', async () => {
    await shippedOrder();
    const c = client();
    c.asCustomer({ id: CUSTOMER_A });
    const body = await json<{ items: Record<string, unknown>[] }>(
      await c.get('/api/shop/orders'),
    );
    expect(body.items).toHaveLength(1);
    /* ABSENT, not an empty array — the list does not fetch parcels, and an
     * empty array would read as "nothing has shipped", which the detail
     * endpoint would then contradict. */
    expect('fulfillments' in body.items[0]).toBe(false);
  });
});
