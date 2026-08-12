import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { resetOrderTables } from '../orders/test/harness';
import { BadRequestError } from '../../repo/errors';
import { encodeCursor } from '../../repo/cursor';
import { listBuyers } from './customers';
import type { Buyer } from './customers';
import { S0, seedCustomer, seedOrder } from './test/seed';

/**
 * Buyers, which are not accounts (HANDOFF §1.9, §2 A4).
 *
 * **THE CENTRAL PROPERTY OF THIS FILE IS THAT A GUEST WHO HAS NEVER SIGNED IN
 * APPEARS ON THE CUSTOMER LIST.** Contract §7 makes guest checkout the default
 * path, so a list read off `shop_customers` is a list of the people who created
 * an account — which on a shop where most orders are guest orders is a screen
 * that is mostly empty while the till is busy. Half the cases below exist to
 * make that failure impossible to reintroduce.
 *
 * The other half are about the aggregates surviving pagination, which is the
 * subtler defect: a keyset over a grouped query filtered in the wrong clause
 * paginates perfectly and reports smaller numbers on later pages, with nothing
 * anywhere to say so.
 */

let ctx: TestCtx;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
  /*
   * DELETE and not TRUNCATE: `shop_carts.customer_id` references this table with
   * ON DELETE SET NULL, and TRUNCATE refuses a table another one references
   * unless every referencing table is truncated in the same statement — which
   * would mean this suite quietly emptying Cart's tables. `resetOrderTables`
   * makes the same argument about naming its tables rather than using CASCADE.
   */
  await ctx.db.execute(sql`DELETE FROM shop_customers`);
});

describe('a buyer is an email that has ordered, not a row in shop_customers', () => {
  it('lists a guest who has no account at all', async () => {
    await seedOrder(ctx.db, { email: 'guest@example.test', customerId: null, grandTotal: 1200 });

    const { items } = await listBuyers(ctx.db, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      email: 'guest@example.test',
      customerId: null,
      displayName: null,
      orderCount: 1,
      paidCount: 1,
      totalSpent: 1200,
      currency: 'GBP',
    });
  });

  it('joins the account on when there is one, without needing customer_id on the order', async () => {
    /*
     * The order carries `customer_id: null` — a guest checkout — while an account
     * with the same address exists. The join is on the ADDRESS, so the two are
     * recognised as one person. Joining on `shop_orders.customer_id` instead
     * would show the same human twice: once as a named account with no orders,
     * once as an anonymous buyer.
     */
    await seedCustomer(ctx.db, { id: 'cus_ada', email: 'ada@example.test', displayName: 'Ada L.' });
    await seedOrder(ctx.db, { email: 'ada@example.test', customerId: null });

    const { items } = await listBuyers(ctx.db, {});
    expect(items[0]).toMatchObject({
      email: 'ada@example.test',
      customerId: 'cus_ada',
      displayName: 'Ada L.',
      orderCount: 1,
    });
  });

  it('folds case: one person, not two rows', async () => {
    await seedOrder(ctx.db, { email: 'Buyer@Example.test', grandTotal: 1000, placedAt: S0 });
    await seedOrder(ctx.db, { email: 'buyer@example.test', grandTotal: 2000, placedAt: S0 + HOUR });

    const { items } = await listBuyers(ctx.db, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      email: 'buyer@example.test',
      orderCount: 2,
      totalSpent: 3000,
    });
  });

  it('an account that has never ordered is not a buyer', async () => {
    /*
     * The deliberate asymmetry. This list answers "who has bought", so somebody
     * who signed up and left is absent — and that is the price of the aggregate
     * being over orders. Recorded as a test rather than left for someone to
     * report as a missing row.
     */
    await seedCustomer(ctx.db, { email: 'lurker@example.test', displayName: 'Lurker' });
    expect((await listBuyers(ctx.db, {})).items).toEqual([]);
  });
});

describe('the money on a buyer row', () => {
  it('counts every order but only spends the paid ones, net of refunds', async () => {
    const email = 'mixed@example.test';
    await seedOrder(ctx.db, { email, status: 'paid', grandTotal: 4000, placedAt: S0 });
    await seedOrder(ctx.db, {
      email,
      status: 'partially_refunded',
      grandTotal: 3000,
      refundedTotal: 500,
      placedAt: S0 + HOUR,
    });
    // Placed, never paid: it is an order, and it is not spend.
    await seedOrder(ctx.db, {
      email,
      status: 'pending',
      grandTotal: 9999,
      paidAt: null,
      placedAt: S0 + 2 * HOUR,
    });

    const { items } = await listBuyers(ctx.db, {});
    expect(items[0]).toMatchObject({
      orderCount: 3,
      paidCount: 2,
      totalSpent: 4000 + 3000 - 500,
    });
  });

  it('names the last order, with the ordering the page is sorted by', async () => {
    const email = 'repeat@example.test';
    await seedOrder(ctx.db, { email, placedAt: S0 });
    const newest = await seedOrder(ctx.db, {
      email,
      status: 'fulfilled',
      placedAt: S0 + 5 * HOUR,
    });
    await seedOrder(ctx.db, { email, placedAt: S0 + HOUR });

    const { items } = await listBuyers(ctx.db, {});
    expect(items[0]).toMatchObject({
      lastOrderId: newest.id,
      lastOrderNumber: newest.orderNumber,
      lastOrderStatus: 'fulfilled',
      lastOrderAt: S0 + 5 * HOUR,
    });
  });
});

describe('keyset pagination over a grouped query', () => {
  /** Three buyers, one of whom has three orders spread over the window. */
  async function corpus(): Promise<void> {
    await seedOrder(ctx.db, { email: 'a@example.test', grandTotal: 100, placedAt: S0 + 10 * HOUR });
    for (const [i, at] of [S0, S0 + HOUR, S0 + 6 * HOUR].entries()) {
      await seedOrder(ctx.db, { email: 'b@example.test', grandTotal: 200 + i, placedAt: at });
    }
    await seedOrder(ctx.db, { email: 'c@example.test', grandTotal: 300, placedAt: S0 + 2 * HOUR });
  }

  it('orders by last purchase, newest first', async () => {
    await corpus();
    const { items, nextCursor } = await listBuyers(ctx.db, {});
    expect(items.map((buyer) => buyer.email)).toEqual([
      'a@example.test', // 10h
      'b@example.test', // 6h
      'c@example.test', // 2h
    ]);
    expect(nextCursor).toBeNull();
  });

  it('walks every buyer exactly once, with the SAME aggregates on every page', async () => {
    /*
     * THE DEFECT THIS EXISTS FOR. The sort key is `max(o.placed_at)`, so the
     * keyset has to be a HAVING over the grouped rows. Written as a WHERE over
     * `o.placed_at` it would filter the ORDERS before grouping — the walk would
     * still terminate, still return each buyer once, and buyer `b` would report
     * `orderCount: 1` and `totalSpent: 200` on its page instead of 3 and 603,
     * because the two older orders were filtered out before the sum ran.
     */
    await corpus();
    const single = await listBuyers(ctx.db, {});
    const expected = new Map(single.items.map((buyer) => [buyer.email, buyer]));

    const seen: Buyer[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const at: string | null = cursor;
      const page: { items: Buyer[]; nextCursor: string | null } = await listBuyers(ctx.db, {
        limit: 1,
        cursor: at ?? undefined,
      });
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(seen.map((buyer) => buyer.email)).toEqual([...expected.keys()]);
    for (const buyer of seen) expect(buyer).toEqual(expected.get(buyer.email));
  });

  it('ties on the last-order instant are broken by the address', async () => {
    // Without the tiebreak two buyers whose newest orders land in the same
    // millisecond can be returned twice or skipped entirely across a boundary,
    // and neither shows up as an error anywhere.
    await seedOrder(ctx.db, { email: 'zoe@example.test', placedAt: S0 });
    await seedOrder(ctx.db, { email: 'amy@example.test', placedAt: S0 });

    const first = await listBuyers(ctx.db, { limit: 1 });
    expect(first.items[0].email).toBe('amy@example.test');
    const second = await listBuyers(ctx.db, { limit: 1, cursor: first.nextCursor! });
    expect(second.items[0].email).toBe('zoe@example.test');
    expect(second.nextCursor).toBeNull();
  });

  it('a cursor minted under another ordering is a 400, not a wrong page', async () => {
    await corpus();
    const foreign = encodeCursor('placed', [S0], 'ord_x');
    await expect(listBuyers(ctx.db, { cursor: foreign })).rejects.toBeInstanceOf(BadRequestError);
  });

  it('a cursor carrying a non-numeric sort value is a 400, not a 500', async () => {
    // The payload is base64 JSON anybody can write. Bound as-is against a bigint
    // it is SQLSTATE 22P02 — a 500 the client retries five times for nothing.
    const handMade = encodeCursor('buyer_last_order', ['not-a-number'], 'a@example.test');
    await expect(listBuyers(ctx.db, { cursor: handMade })).rejects.toBeInstanceOf(BadRequestError);
  });
});
