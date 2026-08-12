/**
 * Fulfilments, and the invariant brief §2 says to "enforce in SQL": **the sum per order
 * line can never exceed the line's qty.**
 *
 * WHY THE MUTATION TESTS HERE DROP DDL RATHER THAN REWRITE SQL. The bound is a `CHECK` on
 * a counter maintained by a trigger, so there is no predicate in any statement to
 * neutralise — `mutating()` has nothing to match. Dropping the constraint, and separately
 * dropping the trigger that feeds it, is the same operator one level down, and it is
 * stronger: it removes the guarantee from the DATABASE rather than from one statement's
 * text. If either mutant stops producing an over-fulfilled line, the enforcement has moved
 * into TypeScript — which is a read-then-write decided against a snapshot a concurrent
 * fulfilment has already invalidated, i.e. GAUNTLET II Part 2b again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DbError } from '../../db/client';
import { BadRequestError, PreconditionFailedError } from '../../repo/errors';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';
import { rejection } from './test/mutate';
import { CHECKOUT, T0, checkoutCompleted, insertEvents } from './test/fixtures';
import { sweepCommerceEvents, type ConsumerDeps } from './repo/consumer';
import {
  cancelOrder,
  markOrderPaid,
  readOrder,
  readOrderByCheckout,
  type OrderRead,
} from './repo/orders';
import {
  OVER_FULFILMENT_CONSTRAINT,
  cancelFulfillment,
  createFulfillment,
  listFulfillments,
  shipFulfillment,
} from './repo/fulfillments';

let ctx: RawCtx;
const DEPS: ConsumerDeps = { origin: null };
const NOW = T0 + 10_000;
const ACTOR = 'usr_owner';

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

/** A paid order: line 0 is qty 2, line 1 is qty 1. */
async function paidOrder(): Promise<OrderRead> {
  await insertEvents(ctx.db, [checkoutCompleted()]);
  await sweepCommerceEvents(ctx.db, DEPS, NOW);
  const read = await readOrderByCheckout(ctx.db, CHECKOUT);
  await markOrderPaid(ctx.db, read!.order.id, NOW, null, null);
  return (await readOrder(ctx.db, read!.order.id))!;
}

const fulfil = (read: OrderRead, lineIndex: number, qty: number) =>
  createFulfillment(
    ctx.db,
    read.order.id,
    { lines: [{ orderLineId: read.lines[lineIndex].id, qty }], carrier: 'DHL', trackingNumber: 'T' },
    ACTOR,
    NOW,
  );

async function fulfilledQty(orderLineId: string): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT fulfilled_qty FROM shop_order_lines WHERE id = ${orderLineId}`,
  );
  return Number(res.rows[0].fulfilled_qty);
}

// ------------------------------------------------------------ partial fulfilment

describe('partial fulfilment is real (brief §2)', () => {
  it('one line can be covered by two fulfilments', async () => {
    const read = await paidOrder();
    await fulfil(read, 0, 1);
    await fulfil(read, 0, 1);

    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
    expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(2);
  });

  it('the counter is maintained by the DATABASE, not by the caller', async () => {
    const read = await paidOrder();
    expect(await fulfilledQty(read.lines[0].id)).toBe(0);
    // A raw insert — nothing in TypeScript involved — still moves the counter.
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
      VALUES ('ful_raw', ${read.order.id}, 'pending', ${NOW}, 1)`);
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillment_lines (id, fulfillment_id, order_line_id, qty)
      VALUES ('fll_raw', 'ful_raw', ${read.lines[0].id}, 2)`);
    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
  });
});

// --------------------------------------------------------- the over-fulfilment bound

describe('the sum per order line can never exceed its qty', () => {
  it('a single request for more than the line holds is refused', async () => {
    const read = await paidOrder();
    const err = await rejection<PreconditionFailedError>(fulfil(read, 0, 3));

    /*
     * A 409 AND NOT A 500. Untranslated this is SQLSTATE 23514, which scrubs to a
     * `DbError`, has no row in spec §8's table, and answers `{"error":"internal"}` — a
     * status the client's policy retries five times over ~30 seconds for the most ordinary
     * admin typo there is.
     */
    expect(err).toBeInstanceOf(PreconditionFailedError);
    expect(err.operation).toBe('fulfill');
    expect(await fulfilledQty(read.lines[0].id)).toBe(0);
    expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(0);
  });

  it('a second request that would tip it over is refused, and the first survives', async () => {
    const read = await paidOrder();
    await fulfil(read, 0, 2);
    await expect(fulfil(read, 0, 1)).rejects.toBeInstanceOf(PreconditionFailedError);

    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
    expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(1);
  });

  it('CONCURRENT over-fulfilment attempts: exactly one wins', async () => {
    /*
     * Both calls read the order, both see `fulfilled_qty = 0`, and both decide 2 fits. The
     * COUNTER UPDATE inside the trigger takes a row lock, so the second re-evaluates
     * against the first's committed value and the CHECK refuses it. A read-then-decide
     * implementation would let both through and ship the goods twice.
     */
    const read = await paidOrder();
    const results = await Promise.allSettled([fulfil(read, 0, 2), fulfil(read, 0, 2)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
    expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(1);
  });

  it('four concurrent single-unit attempts on a qty-2 line settle at exactly 2', async () => {
    const read = await paidOrder();
    const results = await Promise.allSettled([
      fulfil(read, 0, 1),
      fulfil(read, 0, 1),
      fulfil(read, 0, 1),
      fulfil(read, 0, 1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
  });

  it('THE CHECK IS LOAD-BEARING: dropped, the line is over-fulfilled', async () => {
    const read = await paidOrder();
    await ctx.db.execute(
      sql`ALTER TABLE shop_order_lines DROP CONSTRAINT ${sql.raw(OVER_FULFILMENT_CONSTRAINT)}`,
    );
    try {
      await fulfil(read, 0, 2);
      await fulfil(read, 0, 2);
      // Four units shipped against a line for two: the defect, reproduced on demand.
      expect(await fulfilledQty(read.lines[0].id)).toBe(4);
    } finally {
      await resetOrderTables(ctx.db);
      await ctx.db.execute(sql`
        ALTER TABLE shop_order_lines ADD CONSTRAINT shop_order_lines_fulfilled_ck
          CHECK (fulfilled_qty >= 0 AND fulfilled_qty <= qty)`);
    }
  });

  it('THE COUNTER TRIGGER IS LOAD-BEARING: dropped, the CHECK has nothing to check', async () => {
    /*
     * The other half. A `CHECK` cannot aggregate across rows, so without the trigger the
     * counter never moves, the constraint is trivially satisfied, and the bound is gone —
     * even though the constraint is still in the schema and would still show up in every
     * catalog query. Two mutants, because there are two mechanisms.
     */
    const read = await paidOrder();
    await ctx.db.execute(sql`DROP TRIGGER shop_fulfillment_lines_apply ON shop_fulfillment_lines`);
    try {
      await fulfil(read, 0, 2);
      await fulfil(read, 0, 2);
      expect(await fulfilledQty(read.lines[0].id)).toBe(0);
      // Two fulfilments exist for a line of two: four units, recorded as none.
      expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(2);
    } finally {
      await resetOrderTables(ctx.db);
      await ctx.db.execute(sql`
        CREATE TRIGGER shop_fulfillment_lines_apply
          AFTER INSERT ON shop_fulfillment_lines
          FOR EACH ROW EXECUTE FUNCTION shop_fulfillment_lines_apply_qty()`);
    }
  });
});

// ---------------------------------------------------------------- release on cancel

describe('cancelling a fulfilment gives the quantity back', () => {
  it('and the lines can then be fulfilled again', async () => {
    const read = await paidOrder();
    const first = await fulfil(read, 0, 2);
    expect(await fulfilledQty(read.lines[0].id)).toBe(2);

    await cancelFulfillment(ctx.db, first.id, NOW, ACTOR);
    expect(await fulfilledQty(read.lines[0].id)).toBe(0);

    // A mis-keyed carrier must not strand the goods permanently.
    const second = await fulfil(read, 0, 2);
    expect(second.status).toBe('pending');
    expect(await fulfilledQty(read.lines[0].id)).toBe(2);
  });

  it('a cancelled fulfilment is terminal, refused by the database', async () => {
    const read = await paidOrder();
    const fulfillment = await fulfil(read, 0, 1);
    await cancelFulfillment(ctx.db, fulfillment.id, NOW, ACTOR);

    const err = await rejection<DbError>(
      ctx.db.execute(sql`UPDATE shop_fulfillments SET status = 'pending' WHERE id = ${fulfillment.id}`),
    );
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe('ORD05');
  });

  it('cancelling twice does not double-release', async () => {
    const read = await paidOrder();
    const fulfillment = await fulfil(read, 0, 2);
    await cancelFulfillment(ctx.db, fulfillment.id, NOW, ACTOR);
    // The guard refuses the second, so `fulfilled_qty` cannot be driven negative — which
    // `shop_order_lines_fulfilled_ck`'s `>= 0` half would catch anyway.
    await expect(cancelFulfillment(ctx.db, fulfillment.id, NOW, ACTOR)).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    expect(await fulfilledQty(read.lines[0].id)).toBe(0);
  });
});

// ------------------------------------------------------------------ what is refused

describe('what a fulfilment may not do', () => {
  it('an order line from ANOTHER order is a 400, and the trigger is the backstop', async () => {
    /*
     * Both foreign keys are satisfied by a line belonging to a different order, so nothing
     * declarative stops customer A's item being shipped against customer B's order. The
     * route-level check makes the ordinary typo a legible 400; the trigger is what makes it
     * impossible.
     */
    const first = await paidOrder();

    await ctx.db.execute(sql`
      INSERT INTO shop_orders (id, order_number, email, currency, subtotal, shipping_total,
                               tax_total, grand_total, status, shipping_address, billing_address,
                               placed_at, revision, source_event_id, checkout_id)
      VALUES ('ord_other', '2026-999999-A', 'other@test.local', 'USD', 100, 0, 0, 100, 'paid',
              '{}'::jsonb, '{}'::jsonb, ${NOW}, 1, 'evt_other', 'chk_other')`);
    await ctx.db.execute(sql`
      INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title, option_values,
                                    qty, unit_amount, line_total)
      VALUES ('oln_other', 'ord_other', 0, 'var_x', 'SKU-X', 'X', '{}'::jsonb, 1, 100, 100)`);

    const err = await rejection<BadRequestError>(
      createFulfillment(
        ctx.db,
        first.order.id,
        { lines: [{ orderLineId: 'oln_other', qty: 1 }], carrier: null, trackingNumber: null },
        ACTOR,
        NOW,
      ),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('lines.orderLineId');

    // And with the route-level check bypassed entirely, the DATABASE still refuses.
    const raw = await rejection<DbError>(
      ctx.db.execute(sql`
        WITH ful AS (
          INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
          VALUES ('ful_cross', ${first.order.id}, 'pending', ${NOW}, 1) RETURNING id
        )
        INSERT INTO shop_fulfillment_lines (id, fulfillment_id, order_line_id, qty)
        SELECT 'fll_cross', ful.id, 'oln_other', 1 FROM ful`),
    );
    expect(raw.code).toBe('ORD04');
  });

  it('a cancelled order cannot be fulfilled', async () => {
    const read = await paidOrder();
    await cancelOrder(ctx.db, read.order.id, { reason: 'admin', actorId: ACTOR, link: null }, NOW, null);
    await expect(fulfil(read, 0, 1)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await listFulfillments(ctx.db, read.order.id)).toHaveLength(0);
  });

  it('a PENDING order cannot be fulfilled — nobody has paid', async () => {
    await insertEvents(ctx.db, [checkoutCompleted()]);
    await sweepCommerceEvents(ctx.db, DEPS, NOW);
    const read = (await readOrderByCheckout(ctx.db, CHECKOUT))!;
    expect(read.order.status).toBe('pending');
    await expect(fulfil(read, 0, 1)).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('a partially refunded order CAN be fulfilled — the goods still owe', async () => {
    const read = await paidOrder();
    await ctx.db.execute(sql`
      UPDATE shop_orders SET status = 'partially_refunded', refunded_total = 400
       WHERE id = ${read.order.id}`);
    const fresh = (await readOrder(ctx.db, read.order.id))!;
    const fulfillment = await createFulfillment(
      ctx.db,
      fresh.order.id,
      { lines: [{ orderLineId: fresh.lines[0].id, qty: 1 }], carrier: null, trackingNumber: null },
      ACTOR,
      NOW,
    );
    expect(fulfillment.status).toBe('pending');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('a %s quantity is a 400', async (_name, qty) => {
    const read = await paidOrder();
    await expect(fulfil(read, 0, qty)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('an empty line list is a 400', async () => {
    const read = await paidOrder();
    await expect(
      createFulfillment(ctx.db, read.order.id, { lines: [], carrier: null, trackingNumber: null }, ACTOR, NOW),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('a fulfilment line is append-only, refused by the database', async () => {
    const read = await paidOrder();
    const fulfillment = await fulfil(read, 0, 1);
    for (const statement of [
      sql`UPDATE shop_fulfillment_lines SET qty = 2 WHERE fulfillment_id = ${fulfillment.id}`,
      sql`DELETE FROM shop_fulfillment_lines WHERE fulfillment_id = ${fulfillment.id}`,
    ]) {
      const err = await rejection<DbError>(ctx.db.execute(statement));
      expect(err.code).toBe('ORD02');
    }
  });
});

// ------------------------------------------------------------------- shipping flow

describe('the shipment flow', () => {
  it('records the carrier and tracking on the fulfilment, not on the order', async () => {
    const read = await paidOrder();
    const fulfillment = await createFulfillment(
      ctx.db,
      read.order.id,
      {
        lines: [{ orderLineId: read.lines[0].id, qty: 2 }],
        carrier: 'Royal Mail',
        trackingNumber: 'RM123',
      },
      ACTOR,
      NOW,
    );
    const shipped = await shipFulfillment(ctx.db, fulfillment.id, NOW + 1, null, ACTOR);
    expect(shipped).toMatchObject({
      status: 'shipped',
      carrier: 'Royal Mail',
      trackingNumber: 'RM123',
      shippedAt: NOW + 1,
    });
    // Three parcels can carry three trackings, which an order-level column could not hold.
    expect((await readOrder(ctx.db, read.order.id))!.order.fulfilledAt).toBeNull();
  });
});
