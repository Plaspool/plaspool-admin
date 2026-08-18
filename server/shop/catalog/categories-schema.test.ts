import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import type { RawCtx } from '../../test/harness';

/**
 * The applied DDL, read back out of the catalog — never out of
 * `categories-schema.ts` or `0200_shop_categories.sql`, both of which can say
 * whatever they like without the database agreeing. This is the commerce
 * contract's rule: hand-written migrations are asserted against a migrated
 * database.
 *
 * The functional indexes get more than an existence check. An index that exists
 * but is not UNIQUE would pass a name assertion and fail nothing else, while
 * being precisely the defect that lets 'PLA' and 'pla' both into the table — so
 * the refusals are exercised, not just described.
 */

let ctx: RawCtx;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx?.close();
});

const insert = (values: string) =>
  ctx.db.execute(
    sql.raw(`INSERT INTO shop_categories
      (id, slug, name, blurb, accent_hex, position, created_at, updated_at)
      VALUES (${values})`),
  );

describe('shop_categories DDL', () => {
  it('has exactly the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_categories' ORDER BY column_name
    `);
    const names = rows.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).toEqual(
      [
        'accent_hex',
        'blurb',
        'created_at',
        'id',
        'name',
        'position',
        'slug',
        'updated_at',
      ].sort(),
    );
  });

  it('timestamps are bigint, never timestamptz', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'shop_categories'
        AND column_name IN ('created_at', 'updated_at')
    `);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows as { data_type: string }[]) {
      expect(r.data_type).toBe('bigint');
    }
  });

  it('carries every check constraint the schema declares', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT con.conname AS name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'shop_categories' AND con.contype = 'c'
       ORDER BY con.conname
    `);
    const names = rows.rows.map((r) => (r as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining([
        'shop_categories_accent_hex_ck',
        'shop_categories_blurb_bytes_ck',
        'shop_categories_name_bytes_ck',
        'shop_categories_name_ck',
        'shop_categories_position_ck',
        'shop_categories_slug_bytes_ck',
        'shop_categories_slug_ck',
      ]),
    );
  });

  it('declares the two unique indexes and the ordering index', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'shop_categories'
    `);
    const names = rows.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'shop_categories_name_lower_uq',
        'shop_categories_slug_uq',
        'shop_categories_position_idx',
      ]),
    );
  });
});

describe('the constraints actually refuse', () => {
  it('accepts a well-formed row', async () => {
    await expect(
      insert(`'cat_ok', 'pla', 'PLA', 'The everyday filament.', '#1b4fa8', 0, 1, 1`),
    ).resolves.toBeDefined();
  });

  /*
   * THE CONSTRAINT THE WHOLE SURFACE DEPENDS ON. The union joins on
   * `lower(name)`, the rename moves products on it and the delete counts on it —
   * two casings of one name would be two entries in every picker, two counts,
   * and a rename that fixes one of them.
   */
  it('refuses a second casing of an existing name', async () => {
    await insert(`'cat_fold', 'petg', 'PETG', '', NULL, 0, 1, 1`);
    await expect(insert(`'cat_fold2', 'petg-2', 'petg', '', NULL, 0, 1, 1`)).rejects.toThrow();
  });

  it('refuses a duplicate slug', async () => {
    await insert(`'cat_slug', 'abs', 'ABS', '', NULL, 0, 1, 1`);
    await expect(insert(`'cat_slug2', 'abs', 'ABS & ASA', '', NULL, 0, 1, 1`)).rejects.toThrow();
  });

  /* `''` is not a category, it is the ABSENCE of one — the state
   * `shop_products.category = ''` already means everywhere in this codebase. */
  it('refuses an empty or untrimmed name', async () => {
    await expect(insert(`'cat_e', 'empty', '', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_t', 'trimmed', ' TPU ', '', NULL, 0, 1, 1`)).rejects.toThrow();
  });

  /* The alphabet `slugify` emits. A slug this column accepts round-trips
   * through that function unchanged. */
  it('refuses a slug that slugify would never emit', async () => {
    await expect(insert(`'cat_s1', 'Not-Lower', 'Upper', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_s2', '-leading', 'Leading', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_s3', 'trailing-', 'Trailing', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_s4', 'dou--ble', 'Double', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_s5', 'has space', 'Space', '', NULL, 0, 1, 1`)).rejects.toThrow();
  });

  /* Spelled and checked exactly as `shop_variants.color_hex` is, so the two
   * colour columns in this schema cannot disagree about `#FFF` vs `#ffffff`. */
  it('refuses an accent that is not lowercase six-digit hex, but allows null', async () => {
    await expect(insert(`'cat_h1', 'hex-upper', 'HexUpper', '', '#1B4FA8', 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_h2', 'hex-short', 'HexShort', '', '#abc', 0, 1, 1`)).rejects.toThrow();
    await expect(insert(`'cat_h3', 'hex-none', 'HexNone', '', NULL, 0, 1, 1`)).resolves.toBeDefined();
  });

  it('refuses a negative position', async () => {
    await expect(insert(`'cat_p', 'neg', 'Neg', '', NULL, -1, 1, 1`)).rejects.toThrow();
  });

  /* Bytes, not characters: `length()` undercounts by up to 4x, which is the
   * whole reason `normaliseShopCategoryName` counts UTF-8 bytes too. */
  it('refuses an oversized name and an oversized blurb', async () => {
    const longName = 'x'.repeat(401);
    const longBlurb = 'y'.repeat(601);
    await expect(insert(`'cat_n', 'longname', '${longName}', '', NULL, 0, 1, 1`)).rejects.toThrow();
    await expect(
      insert(`'cat_b', 'longblurb', 'LongBlurb', '${longBlurb}', NULL, 0, 1, 1`),
    ).rejects.toThrow();
  });
});
