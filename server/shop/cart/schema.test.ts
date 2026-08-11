/**
 * The DDL is APPLIED, not merely present in a file (contract §8).
 *
 * Migration `0120` is hand-written: none of these tables is declared in
 * `server/db/schema.ts`, so drizzle-kit has never seen them and never will.
 * That is deliberate and it is in-rule — `drizzle.config.ts` states that a
 * hand-written migration may only touch objects drizzle-kit cannot model, and
 * an object outside the configured `schema` file is exactly that. The cost of
 * being outside the model is that nothing typechecks the SQL, so this suite
 * reads the shape back out of `information_schema` and `pg_constraint` and
 * compares it against `server/db/commerce-schema.ts`.
 *
 * Contract §4's two non-optional rules are asserted here rather than trusted:
 * timestamps are `bigint` epoch-milliseconds and never `timestamptz`, and every
 * enum-ish column carries a `check()` because `.$type<>()` is compile-time only.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb } from './test/harness';
import {
  shopAddresses,
  shopCartLines,
  shopCarts,
  shopCustomerSessions,
  shopCustomers,
  shopReservations,
} from './schema';
import type { Db } from '../../db/client';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

/** Every table this subsystem owns, plus the shared outbox. */
const CART_TABLES = [
  'shop_customers',
  'shop_customer_sessions',
  'shop_carts',
  'shop_cart_lines',
  'shop_reservations',
  'shop_addresses',
  'commerce_events',
];

/**
 * The database column name a drizzle column object carries.
 *
 * Read off the column rather than off the property key: the two differ by
 * design (`shippingOptionId` is `shipping_option_id`), and comparing property
 * keys against `information_schema` would compare two different things and pass
 * for the wrong reason.
 */
function nameOf(value: unknown): string {
  // `typeof value === 'object'` is doing real work: a drizzle table object also
  // carries METHODS (`enableRLS`), and a function has a `.name` too — so a
  // looser check silently added "enableRLS" to the declared column list.
  if (typeof value !== 'object' || value === null) return '';
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

const columns_ = (table: string) => columns(table);

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await db.execute(sql`
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

async function constraintNames(): Promise<Set<string>> {
  const res = await db.execute(sql`SELECT conname FROM pg_constraint`);
  return new Set(res.rows.map((row) => String(row.conname)));
}

describe('migration 0120 is applied', () => {
  it('creates every table the cart subsystem owns', async () => {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'`);
    const present = new Set(res.rows.map((row) => String(row.table_name)));
    for (const table of CART_TABLES) expect(present, table).toContain(table);
  });

  it('stores every timestamp as bigint epoch-ms, never timestamptz', async () => {
    /*
     * Contract §4, carried over from `server/db/schema.ts`. A `timestamptz`
     * column would read back as a `Date` from PGlite and as a string from Neon,
     * and `toEpochMs` — the function that closes that divergence — only works
     * on a number-or-numeric-string. One `timestamptz` here would reopen spec
     * §9's seam for the whole subsystem.
     */
    for (const table of CART_TABLES) {
      for (const [name, meta] of await columns(table)) {
        if (!/_at$|^expires_at$|^occurred_at$/.test(name)) continue;
        expect(meta.type, `${table}.${name}`).toBe('bigint');
      }
    }
  });

  it('carries a CHECK on every enum-ish column, because $type<> is compile-time only', async () => {
    const names = await constraintNames();
    for (const check of [
      'shop_carts_status_ck',
      'shop_reservations_state_ck',
      'shop_addresses_kind_ck',
    ]) {
      expect(names, check).toContain(check);
    }
  });

  it('bounds the quantity columns at the database, not only in TypeScript', async () => {
    const names = await constraintNames();
    expect(names).toContain('shop_cart_lines_qty_ck');
    expect(names).toContain('shop_reservations_qty_ck');
    expect(names).toContain('shop_carts_revision_ck');
  });

  it('holds one line per variant per cart', async () => {
    const names = await constraintNames();
    expect(names).toContain('shop_cart_lines_cart_variant_uq');
  });

  it('has NO foreign key from a cart line to a catalog table', async () => {
    /*
     * Contract §2 R3 and brief §3, asserted rather than remembered. A
     * cross-subsystem FK turns a catalog cleanup into a cart failure, and
     * `ON DELETE CASCADE` across the boundary would let Catalog silently empty
     * somebody's basket. This test is what stops a later "helpful" migration
     * adding one.
     */
    const res = await db.execute(sql`
      SELECT c.conname, cl.relname AS child, pr.relname AS parent
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_class pr ON pr.oid = c.confrelid
       WHERE c.contype = 'f'
         AND cl.relname::text = ANY(${sql.param(CART_TABLES)}::text[])`);
    /*
     * SCOPED TO THE TABLES CART OWNS. The first version of this test scanned
     * every `shop_%` table and failed on Catalog's own `shop_inventory →
     * shop_variants`, which is not a cross-subsystem key at all — it is Catalog
     * referencing itself, which R3 has nothing to say about. What R3 forbids is
     * a key from one subsystem's table INTO another's.
     */
    const crossing = res.rows.filter(
      (row) => !CART_TABLES.includes(String(row.parent)),
    );
    expect(crossing).toEqual([]);
  });

  it('cascades cart lines, reservations and addresses from their cart', async () => {
    const res = await db.execute(sql`
      SELECT cl.relname AS child, c.confdeltype
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_class pr ON pr.oid = c.confrelid
       WHERE c.contype = 'f' AND pr.relname = 'shop_carts'`);
    const byChild = new Map(res.rows.map((r) => [String(r.child), String(r.confdeltype)]));
    // 'c' is ON DELETE CASCADE in pg_constraint.
    expect(byChild.get('shop_cart_lines')).toBe('c');
    expect(byChild.get('shop_reservations')).toBe('c');
    expect(byChild.get('shop_addresses')).toBe('c');
  });

  it('cascades customer sessions from their customer', async () => {
    const res = await db.execute(sql`
      SELECT c.confdeltype FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_class pr ON pr.oid = c.confrelid
       WHERE c.contype = 'f' AND cl.relname = 'shop_customer_sessions'
         AND pr.relname = 'shop_customers'`);
    expect(res.rows.map((r) => String(r.confdeltype))).toEqual(['c']);
  });

  it('lets a cart carry no customer at all — guest checkout is the default path', async () => {
    // Contract §7. A cart exists before any identity does, so `customer_id`
    // must be nullable; a NOT NULL here would make an anonymous cart
    // unstorable and force an account before a purchase.
    expect((await columns('shop_carts')).get('customer_id')?.nullable).toBe(true);
    expect((await columns('shop_customers')).get('email')?.nullable).toBe(true);
  });

  it('DECLARES exactly what the database has — commerce-schema is not decoration', async () => {
    /*
     * The declaration in `server/shop/cart/schema.ts` is reachable from
     * `server/db/commerce-schema.ts` (contract §4) but is NOT what creates these
     * tables — migration 0120 is, and drizzle-kit has never seen either. So the
     * declaration is exactly the kind of thing that rots: correct on the day it
     * is written, silently wrong after the first migration nobody mirrors into
     * it, and used for `$inferSelect` types the whole time.
     *
     * This reads both sides and compares them, which turns "one place to see the
     * shape" from a claim into a checked invariant.
     */
    const declared: Array<[string, string[]]> = [
      ['shop_customers', Object.values(shopCustomers).map(nameOf)],
      ['shop_customer_sessions', Object.values(shopCustomerSessions).map(nameOf)],
      ['shop_carts', Object.values(shopCarts).map(nameOf)],
      ['shop_cart_lines', Object.values(shopCartLines).map(nameOf)],
      ['shop_reservations', Object.values(shopReservations).map(nameOf)],
      ['shop_addresses', Object.values(shopAddresses).map(nameOf)],
    ];

    for (const [table, columns] of declared) {
      const actual = [...(await columns_(table)).keys()].sort();
      expect(columns.filter(Boolean).sort(), table).toEqual(actual);
    }
  });

  it('stores NO price on a cart line', async () => {
    /*
     * Brief §3, and it is a schema-level guarantee rather than a convention:
     * with no column to write to, a later "cache the price" patch has to change
     * the migration and trip this test. A price on a cart line is a third
     * source of truth that goes stale and that nobody notices going stale.
     */
    const line = await columns('shop_cart_lines');
    for (const name of line.keys()) {
      expect(name, `shop_cart_lines.${name}`).not.toMatch(/price|amount|unit|currency|total/);
    }
  });
});
