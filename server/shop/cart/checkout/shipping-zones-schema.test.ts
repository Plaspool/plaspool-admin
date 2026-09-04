import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../../test/harness';
import type { RawCtx } from '../../../test/harness';

/**
 * The applied DDL for `shop_shipping_zones` / `shop_shipping_options`
 * (migration 0240, admin#19), read back out of the catalog — never trusted
 * from the `.sql` file itself.
 */

let ctx: RawCtx;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx?.close();
});

describe('shop_shipping_zones DDL', () => {
  it('has the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_shipping_zones' ORDER BY column_name
    `);
    const names = rows.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).toEqual(
      [
        'id',
        'label',
        'countries',
        'regions',
        'tax_rate_bps',
        'tax_label',
        'shipping_taxable',
        'is_fallback',
        'position',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('timestamps are bigint, never timestamptz', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'shop_shipping_zones'
        AND column_name IN ('created_at', 'updated_at')
    `);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows as { data_type: string }[]) {
      expect(r.data_type).toBe('bigint');
    }
  });

  it('carries the declared check constraints', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT con.conname AS name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'shop_shipping_zones' AND con.contype = 'c'
       ORDER BY con.conname
    `);
    const names = rows.rows.map((r) => (r as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining([
        'shop_shipping_zones_label_ck',
        'shop_shipping_zones_tax_rate_bps_ck',
        'shop_shipping_zones_position_ck',
      ]),
    );
  });

  it('declares the exactly-one-fallback partial unique index', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'shop_shipping_zones'
    `);
    const idx = rows.rows.find(
      (r) => (r as { indexname: string }).indexname === 'shop_shipping_zones_fallback_uq',
    ) as { indexdef: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx?.indexdef).toMatch(/UNIQUE/i);
    expect(idx?.indexdef).toMatch(/is_fallback/i);
  });

  /*
   * FOUR ZONES SINCE MIGRATION 0900, and the change of fallback is the point of
   * this assertion rather than an incidental edit to it.
   *
   * Until 0900 the catch-all was `zone_rest_of_nigeria`, whose `countries` was
   * empty — which per 0240 means "every country no other zone claims", so a
   * London address was priced as domestic Nigerian delivery and charged
   * Nigerian VAT. 0900 gives that zone the country it is named after and hands
   * the fallback to `zone_international`.
   *
   * Both halves are pinned below: Rest of Nigeria must still exist AND must no
   * longer be the fallback, because a regression that merely dropped the new
   * zone would otherwise silently restore the old mispricing.
   */
  it('seeded the three Nigerian zones plus the international catch-all', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT id, label, is_fallback, countries FROM shop_shipping_zones ORDER BY position
    `);
    expect(rows.rows.map((r) => (r as { id: string }).id)).toEqual([
      'zone_abuja',
      'zone_lagos',
      'zone_rest_of_nigeria',
      'zone_international',
    ]);

    const fallbacks = rows.rows.filter((r) => (r as { is_fallback: boolean }).is_fallback);
    expect(fallbacks).toHaveLength(1);
    expect((fallbacks[0] as { id: string }).id).toBe('zone_international');

    // Rest of Nigeria now matches by COUNTRY, which is what stops it catching
    // the world. An empty array here would be the old bug, exactly.
    const restOfNigeria = rows.rows.find((r) => (r as { id: string }).id === 'zone_rest_of_nigeria');
    expect((restOfNigeria as { countries: string[] }).countries).toEqual(['NG']);
    expect((fallbacks[0] as { countries: string[] }).countries).toEqual([]);
  });

  it('refuses a second fallback zone via the partial unique index', async () => {
    await expect(
      ctx.db.execute(sql`
        UPDATE shop_shipping_zones SET is_fallback = true WHERE id = 'zone_abuja'
      `),
    ).rejects.toThrow();
  });
});

describe('shop_shipping_options DDL', () => {
  it('has the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_shipping_options' ORDER BY column_name
    `);
    const names = rows.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).toEqual(
      [
        'id',
        'zone_id',
        'label',
        'amount_minor',
        // Migration 0900. NULL means "derive it from the rate in
        // shop_currency_settings"; set, it overrides for this option.
        'amount_usd_minor',
        'estimate',
        'position',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('refuses a negative amount_minor', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO shop_shipping_options
          (id, zone_id, label, amount_minor, estimate, position, created_at, updated_at)
        VALUES ('ship_bad', 'zone_abuja', 'Bad', -1, '', 0, 1, 1)
      `),
    ).rejects.toThrow();
  });

  it('seeded the three real minor-unit rates: 300000 / 1000000 / 1000000', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT zone_id, amount_minor FROM shop_shipping_options ORDER BY id
    `);
    const byZone = Object.fromEntries(
      rows.rows.map((r) => [(r as { zone_id: string }).zone_id, Number((r as { amount_minor: unknown }).amount_minor)]),
    );
    expect(byZone.zone_abuja).toBe(300_000);
    expect(byZone.zone_lagos).toBe(1_000_000);
    expect(byZone.zone_rest_of_nigeria).toBe(1_000_000);
  });
});
