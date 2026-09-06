/**
 * The DDL in `0160_orders_fulfillment.sql` is APPLIED, not merely present.
 *
 * Contract §8's last sentence asks for exactly this, and the reason is recorded:
 * a migration file on disk with no journal entry is never run, and a trigger that
 * silently stops existing does not fail anything loudly — the column it maintains
 * still exists, still reads, and simply stops moving, at which point the lifecycle
 * CAS pins a constant and is back to re-applying a lost intent (GAUNTLET II Part
 * 2b Round 1 #1).
 *
 * So every assertion here reads `pg_catalog` or `information_schema` on a migrated
 * database, or provokes the constraint and looks at the SQLSTATE. Nothing here
 * asserts on the text of the .sql file: `migrations.test.ts` covers that hazard
 * for the blog schema and it is the weaker of the two checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DbError } from '../../db/client';
import { migratedDb, resetOrderTables } from './test/harness';
import type { RawCtx } from './test/harness';

let ctx: RawCtx;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetOrderTables(ctx.db);
});

const OWNED_TABLES = [
  'shop_orders',
  'shop_order_lines',
  'shop_fulfillments',
  'shop_fulfillment_lines',
  'shop_order_events',
  'shop_order_email_intents',
  'shop_order_event_consumptions',
  'shop_order_add_ons',
];

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await ctx.db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}`);
  return new Map(
    res.rows.map((row) => [
      String(row.column_name),
      { type: String(row.data_type), nullable: row.is_nullable === 'YES' },
    ]),
  );
}

describe('the tables exist with the shapes brief §2 specifies', () => {
  it.each(OWNED_TABLES)('%s exists', async (table) => {
    expect((await columns(table)).size).toBeGreaterThan(0);
  });

  it('every timestamp is bigint epoch-ms, never timestamptz', async () => {
    /*
     * The rule `server/db/schema.ts` states for the blog schema and contract §4
     * repeats for commerce. Converting at the boundary instead would create two
     * representations of every date and a rounding seam between them.
     */
    for (const table of OWNED_TABLES) {
      for (const [name, column] of await columns(table)) {
        if (!/_at$/.test(name)) continue;
        expect(column.type, `${table}.${name}`).toBe('bigint');
      }
    }
  });

  it('no money column is a float', async () => {
    // Contract §10: integer minor units, always. A float that reaches a total is
    // a penny that appears at a boundary nobody can point at afterwards.
    const money = ['subtotal', 'shipping_total', 'tax_total', 'grand_total', 'refunded_total'];
    const orders = await columns('shop_orders');
    for (const name of money) expect(orders.get(name)?.type, name).toBe('integer');

    const lines = await columns('shop_order_lines');
    for (const name of ['unit_amount', 'line_total']) {
      expect(lines.get(name)?.type, name).toBe('integer');
    }
  });

  it('commerce_events carries exactly contract §6’s columns', async () => {
    /*
     * READ BACK OUT OF THE CATALOG BECAUSE 0160 CREATES IT `IF NOT EXISTS`.
     *
     * Contract §4 calls `commerce_events` shared and names no owning subsystem,
     * while §8 gives each agent a private migration range — so whichever of the
     * four lands first creates the table and the rest must not fail. `IF NOT
     * EXISTS` makes the DDL commutative, and its cost is that a DIFFERENT shape
     * created first would make 0160 a silent no-op. This is the assertion that
     * turns that into a loud failure. (Measured at the time of writing:
     * `0120_cart_checkout` creates the same table, `IF NOT EXISTS`, with an
     * identical column set.)
     */
    const found = await columns('commerce_events');
    const expected: Record<string, { type: string; nullable: boolean }> = {
      id: { type: 'text', nullable: false },
      type: { type: 'text', nullable: false },
      subject_id: { type: 'text', nullable: false },
      payload: { type: 'jsonb', nullable: false },
      occurred_at: { type: 'bigint', nullable: false },
      processed_at: { type: 'bigint', nullable: true },
      attempts: { type: 'integer', nullable: false },
      last_error: { type: 'text', nullable: true },
    };
    expect(Object.fromEntries(found)).toEqual(expected);
  });
});

describe('ON DELETE RESTRICT, not CASCADE (brief §2)', () => {
  /**
   * THE ONE THAT MATTERS MOST IN THIS FILE.
   *
   * Cascade is right everywhere else in this codebase. Here it is wrong: GAUNTLET
   * II Part 2b's worst finding ended with `ON DELETE CASCADE` taking every
   * revision of a destroyed post. An order is a financial record, so a delete has
   * to be refused rather than propagated — and `RESTRICT` is what refuses it.
   */
  it.each([
    ['shop_order_lines', 'order_id'],
    ['shop_fulfillments', 'order_id'],
    ['shop_order_events', 'order_id'],
    ['shop_order_email_intents', 'order_id'],
    ['shop_fulfillment_lines', 'fulfillment_id'],
    ['shop_fulfillment_lines', 'order_line_id'],
  ])('%s.%s is RESTRICT', async (table, column) => {
    const res = await ctx.db.execute(sql`
      SELECT c.confdeltype
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND t.relname = ${table} AND a.attname = ${column}`);
    expect(res.rows).toHaveLength(1);
    // 'r' = RESTRICT, 'c' = CASCADE, 'a' = NO ACTION.
    expect(res.rows[0].confdeltype).toBe('r');
  });

  it('and it is not decoration: deleting an order with lines is refused', async () => {
    await seedOrder('ord_restrict');
    const err = await rejection(
      ctx.db.execute(sql`DELETE FROM shop_orders WHERE id = 'ord_restrict'`),
    );
    expect(err).toBeInstanceOf(DbError);
    /*
     * `23001` — restrict_violation — AND NOT `23503`, and the difference is the
     * whole assertion. Measured, not assumed: Postgres raises 23503
     * (foreign_key_violation) for the DEFAULT `NO ACTION`, and 23001 only when a
     * declared RESTRICT action refuses. So this SQLSTATE distinguishes
     * `ON DELETE RESTRICT` from a table that merely forgot to say CASCADE, which
     * `confdeltype` above can only claim and this can prove.
     */
    expect((err as DbError).code).toBe('23001');
    const still = await ctx.db.execute(sql`SELECT 1 FROM shop_orders WHERE id = 'ord_restrict'`);
    expect(still.rows).toHaveLength(1);
  });
});

describe('the order line snapshot is immutable, in the database', () => {
  it('a snapshot column cannot be updated', async () => {
    await seedOrder('ord_imm');
    const err = await rejection(
      ctx.db.execute(sql`UPDATE shop_order_lines SET title = 'Renamed' WHERE order_id = 'ord_imm'`),
    );
    expect((err as DbError).code).toBe('ORD01');
  });

  it('a line cannot be deleted', async () => {
    await seedOrder('ord_del');
    const err = await rejection(
      ctx.db.execute(sql`DELETE FROM shop_order_lines WHERE order_id = 'ord_del'`),
    );
    expect((err as DbError).code).toBe('ORD01');
  });

  it('but fulfilled_qty may move, or the bound could not be a CHECK', async () => {
    await seedOrder('ord_ok');
    await ctx.db.execute(
      sql`UPDATE shop_order_lines SET fulfilled_qty = 1 WHERE order_id = 'ord_ok'`,
    );
    const res = await ctx.db.execute(
      sql`SELECT fulfilled_qty FROM shop_order_lines WHERE order_id = 'ord_ok'`,
    );
    expect(Number(res.rows[0].fulfilled_qty)).toBe(1);
  });

  it('and the CHECK is what bounds it — not the application', async () => {
    // `qty` is 2 in the seed. Written straight to the column, bypassing every
    // line of TypeScript this subsystem has.
    await seedOrder('ord_over');
    const err = await rejection(
      ctx.db.execute(sql`UPDATE shop_order_lines SET fulfilled_qty = 3 WHERE order_id = 'ord_over'`),
    );
    expect((err as DbError).code).toBe('23514');
    expect((err as DbError).constraint).toBe('shop_order_lines_fulfilled_ck');
  });
});

describe('the lifecycle generation is owned by the database', () => {
  /**
   * The property an application-maintained counter cannot have, and the reason
   * Part 2b's prescribed fix did not pass its own reproduction: raw `UPDATE`
   * statements never go through the transition function. Reinstating a
   * wrongly-cancelled order, correcting a status after a dispute and importing
   * historical orders are all hand-run SQL.
   */
  it('shop_orders: an UPDATE cannot set it, and a bare UPDATE cannot skip it', async () => {
    await seedOrder('ord_gen');
    expect(await generation('shop_orders', 'ord_gen')).toBe(0);

    // Setting it directly is ignored — the trigger recomputes from OLD.
    await ctx.db.execute(
      sql`UPDATE shop_orders SET lifecycle_generation = 99 WHERE id = 'ord_gen'`,
    );
    expect(await generation('shop_orders', 'ord_gen')).toBe(0);

    // A hand-written lifecycle change moves it anyway.
    await ctx.db.execute(sql`UPDATE shop_orders SET status = 'paid' WHERE id = 'ord_gen'`);
    expect(await generation('shop_orders', 'ord_gen')).toBe(1);

    // A write that touches none of the five watched columns leaves it alone.
    await ctx.db.execute(
      sql`UPDATE shop_orders SET revision = revision + 1 WHERE id = 'ord_gen'`,
    );
    expect(await generation('shop_orders', 'ord_gen')).toBe(1);

    // Every watched column moves it, one at a time.
    for (const set of [
      sql`paid_at = 5`,
      sql`fulfilled_at = 6`,
      sql`cancelled_at = 7`,
      sql`refunded_total = 8`,
    ]) {
      const before = await generation('shop_orders', 'ord_gen');
      await ctx.db.execute(sql`UPDATE shop_orders SET ${set} WHERE id = 'ord_gen'`);
      expect(await generation('shop_orders', 'ord_gen')).toBe(before + 1);
    }
  });

  it('shop_fulfillments: the same, watching status, shipped_at and delivered_at', async () => {
    await seedOrder('ord_ful');
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
      VALUES ('ful_1', 'ord_ful', 'pending', 1, 1)`);
    expect(await generation('shop_fulfillments', 'ful_1')).toBe(0);

    await ctx.db.execute(
      sql`UPDATE shop_fulfillments SET lifecycle_generation = 99 WHERE id = 'ful_1'`,
    );
    expect(await generation('shop_fulfillments', 'ful_1')).toBe(0);

    await ctx.db.execute(sql`UPDATE shop_fulfillments SET status = 'shipped' WHERE id = 'ful_1'`);
    expect(await generation('shop_fulfillments', 'ful_1')).toBe(1);

    await ctx.db.execute(sql`UPDATE shop_fulfillments SET carrier = 'DHL' WHERE id = 'ful_1'`);
    expect(await generation('shop_fulfillments', 'ful_1')).toBe(1);
  });
});

describe('a fulfillment cannot reach across orders', () => {
  it('is refused by the database, not by the route that builds the request', async () => {
    /*
     * Nothing in the two foreign keys says the order line belongs to the
     * fulfilment's own order — both would be satisfied. Left to the application
     * this is one mistyped id away from shipping customer A's item against
     * customer B's order, and it would look correct in every query.
     */
    await seedOrder('ord_a');
    await seedOrder('ord_b');
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
      VALUES ('ful_a', 'ord_a', 'pending', 1, 1)`);

    const foreign = await ctx.db.execute(
      sql`SELECT id FROM shop_order_lines WHERE order_id = 'ord_b'`,
    );
    const err = await rejection(
      ctx.db.execute(sql`
        INSERT INTO shop_fulfillment_lines (id, fulfillment_id, order_line_id, qty)
        VALUES ('fl_x', 'ful_a', ${String(foreign.rows[0].id)}, 1)`),
    );
    expect((err as DbError).code).toBe('ORD04');
  });
});

describe('a cancelled fulfillment is terminal', () => {
  it('un-cancelling is refused: the quantity may already be held elsewhere', async () => {
    await seedOrder('ord_term');
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
      VALUES ('ful_t', 'ord_term', 'cancelled', 1, 1)`);
    const err = await rejection(
      ctx.db.execute(sql`UPDATE shop_fulfillments SET status = 'pending' WHERE id = 'ful_t'`),
    );
    expect((err as DbError).code).toBe('ORD05');
  });
});

/**
 * The email kinds the lifecycle is allowed to write.
 *
 * READ OUT OF `pg_constraint`, NOT OUT OF THE .sql FILE, for this file's own
 * stated reason and for one specific to a widened CHECK: `0380` DROPs the
 * constraint and re-ADDs it, because Postgres cannot widen one in place, and a
 * migration that runs the DROP and then fails on the ADD leaves the column with
 * NO constraint at all — a table that accepts every kind, silently, while the
 * file on disk still reads correctly. `pg_get_constraintdef` is Postgres's own
 * reparse of what actually shipped, so it can tell those two apart and the file
 * cannot.
 */
describe('the email intent kinds, as the database understands them', () => {
  it('shop_order_email_intents_kind_ck admits every kind the mailer can render', async () => {
    const res = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'shop_order_email_intents'
         AND c.conname = 'shop_order_email_intents_kind_ck'`);
    expect(res.rows).toHaveLength(1);
    const def = String(res.rows[0].def);
    for (const kind of [
      'placed',
      'confirmation',
      'shipment',
      'delivered',
      'cancellation',
      'refund',
      'refund_failed',
    ]) {
      expect(def).toContain(`'${kind}'::text`);
    }
  });

  it('and a refund_failed intent is actually insertable', async () => {
    await seedOrder('ord_kind_ok');
    await seedIntent('ord_kind_ok', 'refund_failed');
    const res = await ctx.db.execute(
      sql`SELECT kind FROM shop_order_email_intents WHERE order_id = 'ord_kind_ok'`,
    );
    expect(res.rows.map((r) => r.kind)).toEqual(['refund_failed']);
  });

  it('but the widening did not turn the CHECK into a formality', async () => {
    // The half a DROP-that-never-re-ADDed would fail: a kind nobody defined is
    // still refused, so the constraint is wider and still a constraint.
    await seedOrder('ord_kind_bad');
    const err = await rejection(seedIntent('ord_kind_bad', 'not_a_kind'));
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe('23514');
    expect((err as DbError).constraint).toBe('shop_order_email_intents_kind_ck');
  });
});

describe('the order number sequence', () => {
  it('is a sequence, so two callers never see one value (brief §3)', async () => {
    const first = await ctx.db.execute(sql`SELECT nextval('shop_order_number_seq') AS n`);
    const second = await ctx.db.execute(sql`SELECT nextval('shop_order_number_seq') AS n`);
    expect(Number(second.rows[0].n)).toBe(Number(first.rows[0].n) + 1);
  });
});

// ------------------------------------------------------------------- helpers

/** The minimum row set: one order, one line of qty 2. */
async function seedOrder(id: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO shop_orders (id, order_number, email, currency, subtotal, shipping_total,
                             tax_total, grand_total, status, shipping_address, billing_address,
                             placed_at, revision, source_event_id, checkout_id)
    VALUES (${id}, ${`no-${id}`}, 'buyer@test.local', 'USD', 2000, 0, 0, 2000, 'pending',
            '{}'::jsonb, '{}'::jsonb, 1, 1, ${`evt-${id}`}, ${`chk-${id}`})`);
  await ctx.db.execute(sql`
    INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title, option_values,
                                  qty, unit_amount, line_total)
    VALUES (${`oln-${id}`}, ${id}, 0, 'var_1', 'SKU-1', 'Thing', '{}'::jsonb, 2, 1000, 2000)`);
}

/** One email intent, written straight to the column so no TypeScript is consulted. */
async function seedIntent(orderId: string, kind: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject, body,
                                          created_at, dedupe_key)
    VALUES (${`eml-${orderId}`}, ${orderId}, ${kind}, 'buyer@test.local', 'Subject', 'Body',
            1, ${`dedupe-${orderId}`})`);
}

async function generation(table: 'shop_orders' | 'shop_fulfillments', id: string): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT lifecycle_generation FROM ${sql.raw(table)} WHERE id = ${id}`,
  );
  return Number(res.rows[0].lifecycle_generation);
}

/** The rejection itself, typed — `.catch(e => e)` widens to `T | error`. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  let resolved = false;
  await promise.then(
    () => {
      resolved = true;
    },
    (err: unknown) => {
      caught = err;
    },
  );
  if (resolved) throw new Error('expected the statement to be refused, but it succeeded');
  return caught;
}
