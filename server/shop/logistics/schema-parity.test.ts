import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { freshDb, type TestCtx } from '../../test/harness';
import { shopFulfillments } from '../../db/commerce-schema';
import { shopLogisticsPlaces, shopLogisticsSettings, shopLogisticsWebhooks } from './schema';

/**
 * The declaration and the applied DDL, reconciled against a real database.
 *
 * `schema.test.ts` beside this one already asserts that migration 0980 RAN —
 * the columns exist, the singleton is seeded, the CHECKs bite. This file
 * asserts the other half, which nothing else does: that
 * `server/shop/logistics/schema.ts` still DESCRIBES what ran. Neither table is
 * in `drizzle.config.ts`'s `schema` path, so drizzle-kit has never seen either
 * and nothing typechecks the declaration against the SQL; a description that
 * drifts from its authority is the failure this project keeps finding.
 *
 * Modelled on `server/shop/catalog/schema-parity.test.ts` and
 * `server/shop/settings/schema.test.ts`, and reading the shape back out of
 * `information_schema` / `pg_constraint` rather than re-reading the migration
 * file — CLAUDE.md §4's rule, and the reason the prod ledger's mixed line
 * endings cannot be trusted to tell us whether DDL applied.
 */

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(async () => {
  await ctx?.close();
});

const TABLES: [string, PgTable][] = [
  ['shop_logistics_settings', shopLogisticsSettings],
  ['shop_logistics_webhooks', shopLogisticsWebhooks],
  /* Migration 1000's cache of each courier's own place lists. Declared in the
   * same file and reconciled by the same three cases — a table added to the
   * subsystem and not to this list is a declaration nothing checks. */
  ['shop_logistics_places', shopLogisticsPlaces],
];

/**
 * Drizzle's SQL type spelling → `information_schema.columns.data_type`.
 *
 * Explicit rather than a regex, as in the catalog's parity suite: an unmapped
 * type fails loudly here instead of quietly comparing equal to itself.
 */
const DATA_TYPE: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  jsonb: 'jsonb',
  uuid: 'uuid',
  boolean: 'boolean',
};

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

async function columnsOf(table: string): Promise<ColumnRow[]> {
  const res = await ctx.db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY column_name`);
  return res.rows as unknown as ColumnRow[];
}

async function namesOf(query: ReturnType<typeof sql>): Promise<string[]> {
  const res = await ctx.db.execute(query);
  return res.rows.map((row) => String(row.name)).sort();
}

describe('the 0980 declaration and the applied DDL agree', () => {
  it.each(TABLES)('%s: every column, type, nullability and default', async (name, table) => {
    const declared = getTableConfig(table).columns;
    const actual = await columnsOf(name);
    const byName = new Map(actual.map((row) => [row.column_name, row]));

    /* Both directions. A column the migration created that nobody declared is
     * as much a drift as a declared one that was never created — and only the
     * second of those ever produces a runtime error, which is exactly why the
     * first is the one that survives unnoticed. */
    expect(
      actual.map((row) => row.column_name).sort(),
      `${name}: column sets differ between schema.ts and 0980_logistics.sql`,
    ).toEqual(declared.map((column) => column.name).sort());

    for (const column of declared) {
      const row = byName.get(column.name);
      expect(row, `${name}.${column.name} is declared but not created`).toBeDefined();
      if (!row) continue;

      const sqlType = column.getSQLType();
      const expectedType = DATA_TYPE[sqlType];
      expect(expectedType, `unmapped SQL type ${sqlType} — extend DATA_TYPE`).toBeDefined();
      expect(row.data_type, `${name}.${column.name} type`).toBe(expectedType);
      expect(row.is_nullable, `${name}.${column.name} nullability`).toBe(
        column.notNull ? 'NO' : 'YES',
      );

      /* Presence, not text: Postgres re-spells a default expression on the way
       * in, so comparing the rendered string would fail on formatting and pass
       * on substance. A declared default that was never created is the drift
       * that bites — an INSERT omitting the column becomes a 23502. */
      expect(row.column_default !== null, `${name}.${column.name} has a default`).toBe(
        column.hasDefault,
      );
    }
  });

  it.each(TABLES)('%s: the declared CHECKs are exactly the applied ones', async (name, table) => {
    const declared = getTableConfig(table)
      .checks.map((c) => c.name)
      .sort();
    /* Filtered to this codebase's `_ck` naming, so a NOT NULL constraint some
     * Postgres version materialises into `pg_constraint` cannot turn an honest
     * comparison red. Every hand-written CHECK in 0980 is named. */
    const actual = (
      await namesOf(sql`
        SELECT conname AS name FROM pg_constraint
         WHERE conrelid = ${`public.${name}`}::regclass AND contype = 'c'`)
    ).filter((n) => n.endsWith('_ck'));

    expect(actual, `${name}: the declared CHECKs and the applied CHECKs differ`).toEqual(declared);
  });

  it.each(TABLES)('%s: every declared index is present', async (name, table) => {
    const config = getTableConfig(table);
    const declared = [
      ...config.indexes.map((i) => i.config.name),
      ...config.uniqueConstraints.map((u) => u.name),
    ]
      .filter((n): n is string => typeof n === 'string')
      .sort();
    const actual = await namesOf(sql`
      SELECT indexname AS name FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = ${name}`);
    expect(actual, `${name}: a declared index is missing`).toEqual(
      expect.arrayContaining(declared),
    );
  });

  /**
   * The place cache is keyed by BOTH columns, and that is the whole design: one
   * row per courier per country, so switching courier reads a different row
   * rather than a list the live courier has never heard of, and a refresh
   * REPLACES rather than accumulating. A primary key on `provider` alone would
   * make a second country overwrite the first.
   */
  it('shop_logistics_places is keyed by courier AND country together', async () => {
    const declared = getTableConfig(shopLogisticsPlaces).primaryKeys;
    expect(declared).toHaveLength(1);
    expect(declared[0]!.columns.map((c) => c.name)).toEqual(['provider', 'country']);

    const res = await ctx.db.execute(sql`
      SELECT a.attname AS name
        FROM pg_constraint c
        JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.shop_logistics_places'::regclass AND c.contype = 'p'
       ORDER BY k.ord`);
    expect(res.rows.map((row) => String(row.name))).toEqual(['provider', 'country']);
  });

  /**
   * Not a name comparison: the migration leaves the foreign key unnamed, so
   * Postgres calls it `…_fkey` while drizzle would call it `…_fk`. What is
   * worth pinning is the DELETE action, which is a product decision — a
   * teammate removed from the admin must not take the courier configuration
   * they last saved down with them.
   */
  it('shop_logistics_settings.updated_by is a users FK that survives a deleted teammate', async () => {
    expect(getTableConfig(shopLogisticsSettings).foreignKeys).toHaveLength(1);
    const res = await ctx.db.execute(sql`
      SELECT c.confdeltype, a.attname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.conrelid = 'public.shop_logistics_settings'::regclass AND c.contype = 'f'`);
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0]!.attname)).toBe('updated_by');
    // 'n' is ON DELETE SET NULL; 'c' would be CASCADE and would delete the row.
    expect(String(res.rows[0]!.confdeltype)).toBe('n');
  });

  /**
   * The third table 0980 touched, which Orders owns.
   *
   * Checked here rather than in `server/shop/orders/schema.test.ts` because the
   * migration that added these objects is this subsystem's, and because nothing
   * else reconciles `shopFulfillments`'s DECLARATION against the catalog at all
   * — the orders suite reads `pg_catalog` directly. Two of the four CHECKs and
   * both indexes were missing from the declaration when this was written, which
   * is precisely the drift that goes unnoticed until somebody trusts the
   * declaration to say what is storable.
   */
  it('shop_fulfillments: the 0980 courier columns, CHECKs and indexes are all declared', async () => {
    const config = getTableConfig(shopFulfillments);
    const declaredColumns = config.columns.map((c) => c.name);
    const applied = await columnsOf('shop_fulfillments');
    const appliedNames = applied.map((row) => row.column_name);

    for (const column of [
      'provider', 'provider_ref', 'provider_status', 'courier_state', 'tracking_url',
      'label_url', 'provider_cost_minor', 'provider_synced_at', 'provider_last_error',
    ]) {
      expect(appliedNames, `${column} is missing from the database`).toContain(column);
      expect(declaredColumns, `${column} is applied but not declared`).toContain(column);
    }

    const checks = config.checks.map((c) => c.name);
    expect(checks).toEqual(
      expect.arrayContaining([
        'shop_fulfillments_provider_ck',
        'shop_fulfillments_courier_state_ck',
        'shop_fulfillments_provider_ref_ck',
        'shop_fulfillments_provider_cost_ck',
      ]),
    );
    const appliedChecks = await namesOf(sql`
      SELECT conname AS name FROM pg_constraint
       WHERE conrelid = 'public.shop_fulfillments'::regclass AND contype = 'c'`);
    expect(appliedChecks, 'a declared CHECK is missing from the database').toEqual(
      expect.arrayContaining(checks),
    );

    const declaredIndexes = [
      ...config.indexes.map((i) => i.config.name),
      ...config.uniqueConstraints.map((u) => u.name),
    ].filter((n): n is string => typeof n === 'string');
    expect(declaredIndexes).toEqual(
      expect.arrayContaining([
        'shop_fulfillments_provider_ref_uq',
        'shop_fulfillments_courier_sync_idx',
      ]),
    );
    const appliedIndexes = await namesOf(sql`
      SELECT indexname AS name FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'shop_fulfillments'`);
    expect(appliedIndexes, 'a declared index is missing').toEqual(
      expect.arrayContaining(declaredIndexes),
    );

    /* Both are PARTIAL, and both would be wrong as total indexes: the unique
     * one would let two hand-shipped parcels collide on NULL, and the sweep's
     * one would carry the whole shipping history. */
    const defs = await ctx.db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'shop_fulfillments'
         AND indexname IN ('shop_fulfillments_provider_ref_uq', 'shop_fulfillments_courier_sync_idx')`);
    expect(defs.rows).toHaveLength(2);
    for (const row of defs.rows) {
      expect(String(row.indexdef), String(row.indexname)).toContain('provider_ref IS NOT NULL');
    }
  });

  it('stores both timestamps as bigint epoch-ms, never timestamptz', async () => {
    const settings = await columnsOf('shop_logistics_settings');
    const webhooks = await columnsOf('shop_logistics_webhooks');
    expect(settings.find((c) => c.column_name === 'updated_at')?.data_type).toBe('bigint');
    expect(webhooks.find((c) => c.column_name === 'received_at')?.data_type).toBe('bigint');
  });
});
