import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { migratedDb } from '../../test/harness';
import type { Db } from '../../db/client';
import {
  shopAddOns,
  shopBulkTiers,
  shopInventory,
  shopInventoryHolds,
  shopPrices,
  shopProductRevisions,
  shopProducts,
  shopVariants,
} from './schema';
import {
  shopBoxFillItems,
  shopBoxFills,
  shopMysteryBoxItems,
  shopMysteryBoxSettings,
} from '../boxes/schema';

/**
 * The declaration and the DDL, reconciled against a real database.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A FILE-LEVEL CHECK. Contract §8 requires "a
 * test that the DDL is actually applied, not merely present in the file", and
 * GAUNTLET II Part 2a Round 1 #3 is the reason it is phrased that way: migration
 * 0002 was silently skipped on an already-migrated database while `db:migrate`
 * printed success and exited 0, and the test that was supposed to catch it
 * asserted the JOURNAL FILE was monotonic — a property of the file, blind to the
 * file-versus-database relationship that decides what actually runs.
 *
 * There is a second, sharper reason here. `server/shop/catalog/schema.ts` is NOT
 * in the `schema` path of `drizzle.config.ts` (see the note there), so nothing
 * typechecks it against `0100_catalog.sql`. It is a description, the migration
 * is the authority, and a description that drifts from its authority is the
 * failure this project keeps finding — "a validator and a database disagreeing
 * about what is storable". So the two are reconciled here, column by column,
 * constraint by constraint, index by index, against a PGlite built from the real
 * migrations through the same `migrateWithReplayCheck` production runs.
 *
 * And three of the objects are asserted BEHAVIOURALLY rather than by presence,
 * because "the trigger row exists in `pg_trigger`" and "the trigger does what it
 * is for" are different claims and only the second one is worth having.
 */

let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});

afterAll(async () => {
  // Tolerant on purpose: if `beforeAll` threw, the setup error is the one worth
  // reading, not a "close is not a function" on top of it.
  await close?.();
});

const TABLES: [string, PgTable][] = [
  ['shop_products', shopProducts],
  /* Migration 0600. Registered here so the declaration is reconciled against the
     real DDL column by column — without this line the table is simply not
     checked, which is the quiet way a description drifts from its authority. */
  ['shop_bulk_tiers', shopBulkTiers],
  ['shop_product_revisions', shopProductRevisions],
  ['shop_variants', shopVariants],
  ['shop_prices', shopPrices],
  ['shop_inventory', shopInventory],
  ['shop_inventory_holds', shopInventoryHolds],
  /* Migration 1220. The mystery-box tables live in their own module. */
  ['shop_box_fills', shopBoxFills],
  ['shop_box_fill_items', shopBoxFillItems],
  /* Migration 1240. */
  ['shop_mystery_box_settings', shopMysteryBoxSettings],
  ['shop_mystery_box_items', shopMysteryBoxItems],
  /* Migration 0940. The add-on model — see the same note above about what an
     unregistered table quietly loses. */
  ['shop_add_ons', shopAddOns],
];

/**
 * Drizzle's SQL type spelling → `information_schema.columns.data_type`.
 *
 * The two vocabularies genuinely differ (`text[]` is reported as `ARRAY`), so
 * the mapping is explicit rather than a regex: an unlisted type fails loudly
 * here instead of silently comparing equal to itself.
 */
const DATA_TYPE: Record<string, string> = {
  text: 'text',
  'text[]': 'ARRAY',
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
  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}
     ORDER BY column_name`);
  return res.rows as unknown as ColumnRow[];
}

async function namesOf(query: ReturnType<typeof sql>): Promise<string[]> {
  const res = await db.execute(query);
  return res.rows.map((row) => String(row.name)).sort();
}

describe('migration 0100 is APPLIED, not merely written', () => {
  it.each(TABLES.map(([name]) => name))('%s exists in the migrated database', async (table) => {
    const res = await db.execute(sql`SELECT to_regclass(${`public.${table}`}) AS t`);
    expect(res.rows[0].t, `${table} is missing — 0100 did not run`).not.toBeNull();
  });

  it('is recorded in the ledger, so the next migration is not skipped', async () => {
    /*
     * `migratedDb()` runs `migrateWithReplayCheck`, which calls
     * `assertJournalApplied` — so a journal entry with no ledger row already
     * fails the whole suite in `beforeAll`. This asserts the positive directly
     * anyway: the count is what stops a later migration being silently skipped
     * because the high-water mark is wrong, and a green `beforeAll` proves that
     * only as a side effect.
     */
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    // Five blog migrations plus one per commerce subsystem that has landed.
    expect(Number(res.rows[0].n)).toBeGreaterThanOrEqual(6);
  });
});

describe('the declaration and the DDL agree', () => {
  it.each(TABLES)('%s: every column, type, nullability and default', async (name, table) => {
    const declared = getTableConfig(table).columns;
    const actual = await columnsOf(name);
    const byName = new Map(actual.map((row) => [row.column_name, row]));

    // Same SET of columns, in both directions: a column in the migration that
    // nobody declared is as much a drift as a declared one that was never
    // created, and only the second would ever produce a runtime error.
    expect(
      actual.map((row) => row.column_name).sort(),
      `${name}: column sets differ between schema.ts and 0100_catalog.sql`,
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

      /*
       * DEFAULTS ARE COMPARED AS PRESENCE, NOT AS TEXT. Postgres normalises a
       * default expression on the way in — `'{}'::text[]` comes back as
       * `'{}'::text[]` but `false` comes back as `false` and `0` as `0`, and any
       * future `now()`-shaped default would come back re-spelled entirely.
       * Comparing the rendered text would make this test fail on a formatting
       * difference and pass on a semantic one, which is the wrong way round. A
       * declared default that was never created IS the drift that bites: an
       * INSERT omitting the column becomes a 23502 instead of taking the value.
       */
      expect(row.column_default !== null, `${name}.${column.name} has a default`).toBe(
        column.hasDefault,
      );
    }
  });

  it.each(TABLES)('%s: every CHECK constraint declared is present', async (name, table) => {
    const declared = getTableConfig(table)
      .checks.map((c) => c.name)
      .sort();
    const actual = await namesOf(sql`
      SELECT conname AS name FROM pg_constraint
       WHERE conrelid = ${`public.${name}`}::regclass AND contype = 'c'`);
    /*
     * `arrayContaining` rather than `toEqual`: Postgres synthesises a NOT NULL
     * check for some column definitions in some versions, and this assertion's
     * subject is "the checks I wrote are real", not "there are no others". A
     * missing one is the failure that matters — `.$type<>()` is compile-time
     * only, so a dropped check means a bug anywhere can persist
     * `status = 'live'` into a column the whole system reads (contract §4).
     */
    expect(actual, `${name}: a declared CHECK is missing from the database`).toEqual(
      expect.arrayContaining(declared),
    );
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
});

describe('the hand-appended DDL does its job, not merely exist', () => {
  /**
   * Three objects drizzle-kit cannot express, so three that nothing but this
   * file checks. Each is asserted by BEHAVIOUR: `pg_trigger` having a row and
   * the trigger maintaining the column are different claims, and a migration
   * that created the function but not the trigger would satisfy the first.
   */

  async function seedProduct(id: string): Promise<void> {
    const user = await db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at)
      VALUES (${`${id}@parity.test`}, 'scrypt$x', 'Parity', 'owner', ${Date.now()})
      RETURNING id`);
    await db.execute(sql`
      INSERT INTO shop_products (id, slug, title, description, description_text, status,
                                 category, created_at, updated_at, author_id, revision)
      VALUES (${id}, NULL, 'Parity', '{"type":"doc","content":[]}'::jsonb, '', 'draft',
              '', ${Date.now()}, ${Date.now()}, ${String(user.rows[0].id)}, 1)`);
  }

  async function generationOf(id: string): Promise<number> {
    const res = await db.execute(
      sql`SELECT lifecycle_generation FROM shop_products WHERE id = ${id}`,
    );
    return Number(res.rows[0].lifecycle_generation);
  }

  it('the lifecycle trigger moves on status/published_at/deleted_at AND ONLY THOSE', async () => {
    const id = 'prd_trigger_parity';
    await seedProduct(id);
    expect(await generationOf(id)).toBe(0);

    // A CONTENT edit must leave it alone, or a lifecycle op that merely raced an
    // ordinary save would 409 instead of re-deriving from the newer text.
    await db.execute(sql`UPDATE shop_products SET title = 'Renamed' WHERE id = ${id}`);
    expect(await generationOf(id), 'a content edit moved the generation').toBe(0);

    // Each of the three lifecycle columns moves it, once.
    await db.execute(sql`UPDATE shop_products SET status = 'active' WHERE id = ${id}`);
    expect(await generationOf(id)).toBe(1);
    await db.execute(sql`UPDATE shop_products SET published_at = 123 WHERE id = ${id}`);
    expect(await generationOf(id)).toBe(2);
    await db.execute(sql`UPDATE shop_products SET deleted_at = 456 WHERE id = ${id}`);
    expect(await generationOf(id)).toBe(3);

    // Writing the SAME values is not a lifecycle change. `IS DISTINCT FROM`, not
    // `<>`, so a NULL on either side compares correctly rather than yielding
    // NULL and falling through to the ELSE branch by accident.
    await db.execute(sql`UPDATE shop_products SET status = 'active', deleted_at = 456 WHERE id = ${id}`);
    expect(await generationOf(id), 'a no-op lifecycle write moved the generation').toBe(3);
  });

  it('the trigger is UNSETTABLE from outside, which is why it is a trigger', async () => {
    /*
     * The whole argument for a trigger over an application counter (GAUNTLET II
     * Part 2b): a counter the repository increments is only honest about writes
     * that went through the repository, and a CAS predicate must not depend on
     * that. Here even a deliberate hand-written UPDATE cannot set it.
     */
    const id = 'prd_trigger_unsettable';
    await seedProduct(id);
    await db.execute(
      sql`UPDATE shop_products SET lifecycle_generation = 99, title = 'x' WHERE id = ${id}`,
    );
    expect(await generationOf(id)).toBe(0);
  });

  it('the partial unique index permits many superseded prices and one current', async () => {
    const id = 'prd_price_parity';
    await seedProduct(id);
    await db.execute(sql`
      INSERT INTO shop_variants (id, product_id, sku, option_values, position, status,
                                 created_at, updated_at)
      VALUES ('var_price_parity', ${id}, 'SKU-PARITY', '{}'::jsonb, 0, 'active',
              ${Date.now()}, ${Date.now()})`);

    const price = (idSuffix: string, from: number, to: number | null) => db.execute(sql`
      INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from, effective_to, created_at)
      VALUES (${`prc_${idSuffix}`}, 'var_price_parity', 1000, 'GBP', ${from}, ${to}, ${Date.now()})`);

    // Any number of CLOSED rows: the price history is unbounded, which is the
    // entire point of effective-dating (brief §2).
    await price('a', 1, 2);
    await price('b', 2, 3);
    await price('c', 3, 4);
    // Exactly one OPEN row.
    await price('d', 4, null);
    await expect(price('e', 5, null)).rejects.toThrow();

    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM shop_prices WHERE variant_id = 'var_price_parity'`);
    expect(Number(res.rows[0].n)).toBe(4);
  });

  it('the `shop_prices` window check refuses a backwards effective range', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from, effective_to, created_at)
        VALUES ('prc_backwards', 'var_price_parity', 1000, 'GBP', 100, 50, ${Date.now()})`),
    ).rejects.toThrow();
  });

  it('`shop_inventory` refuses a negative count but PERMITS reserved > on_hand', async () => {
    await db.execute(sql`
      INSERT INTO shop_inventory (variant_id, on_hand, reserved, backorderable, updated_at)
      VALUES ('var_price_parity', 0, 0, true, ${Date.now()})`);

    await expect(
      db.execute(sql`UPDATE shop_inventory SET on_hand = -1 WHERE variant_id = 'var_price_parity'`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE shop_inventory SET reserved = -1 WHERE variant_id = 'var_price_parity'`),
    ).rejects.toThrow();

    /*
     * AND THE ONE THAT MUST NOT BE REFUSED. A backorderable variant is
     * deliberately sold past zero available, so `reserved > on_hand` is a legal
     * state. A check demanding otherwise would look like prudence and would
     * refuse the feature.
     */
    await db.execute(
      sql`UPDATE shop_inventory SET reserved = 5 WHERE variant_id = 'var_price_parity'`,
    );
    const res = await db.execute(
      sql`SELECT on_hand, reserved FROM shop_inventory WHERE variant_id = 'var_price_parity'`,
    );
    expect(res.rows[0]).toMatchObject({ on_hand: 0, reserved: 5 });
  });

  it('`shop_products.status` is enforced by the database, not by TypeScript', async () => {
    // `.$type<>()` is compile-time only (contract §4). Without the check, a bug
    // anywhere could persist `status = 'live'` into a column the storefront
    // filters on.
    const id = 'prd_status_check';
    await seedProduct(id);
    await expect(
      db.execute(sql`UPDATE shop_products SET status = 'live' WHERE id = ${id}`),
    ).rejects.toThrow();
  });
});
