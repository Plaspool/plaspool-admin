/**
 * Migration 1220 — mystery boxes, read back out of the catalog rather than
 * believed from the file (CLAUDE.md §4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb, type RawCtx } from '../../test/harness';
import { DbError } from '../../db/client';

let ctx: RawCtx;
beforeAll(async () => {
  ctx = await migratedDb();
});
afterAll(async () => {
  await ctx.close();
});

const columns = async (table: string) =>
  (
    await ctx.db.execute(sql`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_name = ${table} ORDER BY column_name`)
  ).rows.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`);

describe('migration 1220 — mystery boxes', () => {
  it('adds a nullable box mode to products and a pool + count to variants', async () => {
    expect(await columns('shop_products')).toContain('box_mode:text:YES');
    const v = await columns('shop_variants');
    expect(v).toContain('box_pool_tag:text:YES');
    expect(v).toContain('box_item_count:integer:YES');
  });

  it('creates the fills and fill items tables with bigint times', async () => {
    expect(await columns('shop_box_fills')).toEqual([
      'box_no:integer:YES',
      'box_variant_id:text:YES',
      'built_state:text:YES',
      'filled_at:bigint:NO',
      'filled_by:uuid:YES',
      'fulfillment_id:text:YES',
      'id:text:NO',
      'order_line_id:text:YES',
      'source:text:NO',
    ]);
    expect(await columns('shop_box_fill_items')).toEqual([
      'fill_id:text:NO',
      'id:text:NO',
      'image_id:text:YES',
      'option_values:jsonb:NO',
      'position:integer:NO',
      'returned_to_stock_at:bigint:YES',
      'sku:text:NO',
      'title:text:NO',
      'variant_id:text:NO',
    ]);
  });

  it('refuses a box mode it does not know, a count of zero, and a count without a pool', async () => {
    const names = (
      await ctx.db.execute(sql`
        SELECT conname FROM pg_constraint
         WHERE conname IN ('shop_products_box_mode_ck', 'shop_variants_box_item_count_ck',
                           'shop_box_fills_source_ck',
                           'shop_box_fills_box_no_ck', 'shop_box_fills_line_box_uq')
         ORDER BY conname`)
    ).rows.map((r) => r.conname);
    expect(names).toEqual([
      'shop_box_fills_box_no_ck',
      'shop_box_fills_line_box_uq',
      'shop_box_fills_source_ck',
      'shop_products_box_mode_ck',
      'shop_variants_box_item_count_ck',
    ]);
  });

  it('aborts a whole statement, carrying the reason in the SQLSTATE', async () => {
    /* The message is scrubbed by the driver guard before any caller sees it,
       so the code is the only part of the error that can carry the reason. */
    const short = await ctx.db.execute(sql`SELECT shop_box_abort('box_short')`).catch((e: unknown) => e);
    expect(short).toBeInstanceOf(DbError);
    expect((short as DbError).code).toBe('BOX01');
    const changed = await ctx.db.execute(sql`SELECT shop_box_abort('box_changed')`).catch((e: unknown) => e);
    expect((changed as DbError).code).toBe('BOX02');
  });
});
