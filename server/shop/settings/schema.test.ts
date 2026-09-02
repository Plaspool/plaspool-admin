import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb } from '../../test/harness';
import { shopDeliverySettings } from './schema';
import type { Db } from '../../db/client';

/**
 * THE DDL IS APPLIED, NOT MERELY PRESENT IN A FILE (contract §8).
 *
 * Migrations 0760 and 0780 are hand-written and drizzle-kit has never seen
 * either table, so nothing typechecks the SQL. This suite reads the shape back
 * out of `information_schema` and `pg_constraint` and compares it against the
 * declarations — the same job `server/shop/cart/schema.test.ts` does for Cart's
 * tables, and the reason CLAUDE.md §4 says to verify a migration by querying
 * the catalog rather than by re-reading the file.
 */

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = ${table}`);
  return new Map(
    res.rows.map((row) => [
      String(row.column_name),
      { type: String(row.data_type), nullable: row.is_nullable === 'YES' },
    ]),
  );
}

async function checkNames(table: string): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = ${table} AND c.contype = 'c'
     ORDER BY c.conname`);
  return res.rows.map((row) => String(row.conname));
}

describe('shop_delivery_settings (migration 0760)', () => {
  it('has exactly the columns the declaration names', async () => {
    const applied = await columns('shop_delivery_settings');
    const declared = Object.values(shopDeliverySettings)
      .map((value) =>
        typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string'
          ? String((value as { name: string }).name)
          : '',
      )
      .filter((name) => name !== '');
    for (const name of declared) expect([...applied.keys()]).toContain(name);
    expect([...applied.keys()].sort()).toEqual(
      [
        'address_mode',
        'id',
        'location_offered',
        'revision',
        'served_regions',
        'updated_at',
        'updated_by',
      ].sort(),
    );
  });

  it('stores the timestamp as bigint epoch-ms, never timestamptz', async () => {
    const applied = await columns('shop_delivery_settings');
    expect(applied.get('updated_at')?.type).toBe('bigint');
  });

  it('carries a check on every enum-ish column', async () => {
    expect(await checkNames('shop_delivery_settings')).toEqual([
      'shop_delivery_settings_id_ck',
      'shop_delivery_settings_mode_ck',
      'shop_delivery_settings_regions_ck',
      'shop_delivery_settings_revision_ck',
    ]);
  });

  it('is seeded with today’s behaviour — districts, no prompt, no restriction', async () => {
    const res = await db.execute(sql`
      SELECT id, address_mode, location_offered, served_regions, revision
        FROM shop_delivery_settings`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      id: 'main',
      address_mode: 'district',
      location_offered: false,
      served_regions: null,
    });
  });

  it('refuses a second row — the singleton is the database’s rule, not a convention', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO shop_delivery_settings (id, address_mode, location_offered, revision, updated_at)
        VALUES ('other', 'simple', false, 1, 1)`),
    ).rejects.toThrow();
  });

  it('refuses an unknown mode', async () => {
    await expect(
      db.execute(sql`UPDATE shop_delivery_settings SET address_mode = 'gps' WHERE id = 'main'`),
    ).rejects.toThrow();
  });

  /*
   * THE ONE THAT MATTERS MOST. "Serve nowhere" and "serve everywhere" are one
   * keystroke apart in a settings screen, and only one of them shuts the shop.
   * NULL is the second; `{}` must not be reachable at all.
   */
  it('refuses an EMPTY served_regions — closing the shop must not be one keystroke', async () => {
    await expect(
      db.execute(sql`UPDATE shop_delivery_settings SET served_regions = '{}' WHERE id = 'main'`),
    ).rejects.toThrow();
  });

  it('refuses a blank or NULL element inside served_regions', async () => {
    await expect(
      db.execute(
        sql`UPDATE shop_delivery_settings SET served_regions = ARRAY['Lagos','']::text[] WHERE id = 'main'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`UPDATE shop_delivery_settings SET served_regions = ARRAY['Lagos',NULL]::text[] WHERE id = 'main'`,
      ),
    ).rejects.toThrow();
  });

  it('accepts NULL — no restriction is a legal, meaningful state', async () => {
    await db.execute(sql`UPDATE shop_delivery_settings SET served_regions = NULL WHERE id = 'main'`);
    const res = await db.execute(sql`SELECT served_regions FROM shop_delivery_settings`);
    expect(res.rows[0]?.served_regions).toBeNull();
  });
});

describe('shop_addresses location columns (migration 0780)', () => {
  it('adds five nullable columns, the coordinate as integer micro-degrees', async () => {
    const applied = await columns('shop_addresses');
    expect(applied.get('location_lat_e6')).toEqual({ type: 'integer', nullable: true });
    expect(applied.get('location_lng_e6')).toEqual({ type: 'integer', nullable: true });
    expect(applied.get('location_accuracy_m')).toEqual({ type: 'integer', nullable: true });
    expect(applied.get('location_source')).toEqual({ type: 'text', nullable: true });
    // epoch-ms, like every other timestamp in this schema.
    expect(applied.get('location_captured_at')).toEqual({ type: 'bigint', nullable: true });
  });

  it('carries the five checks', async () => {
    const names = await checkNames('shop_addresses');
    expect(names).toContain('shop_addresses_location_ck');
    expect(names).toContain('shop_addresses_location_lat_ck');
    expect(names).toContain('shop_addresses_location_lng_ck');
    expect(names).toContain('shop_addresses_location_accuracy_ck');
    expect(names).toContain('shop_addresses_location_source_ck');
  });

  async function insertAddress(location: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO shop_carts (id, currency, status, created_at, updated_at, expires_at, revision)
      VALUES ('cart_loc', 'NGN', 'open', 1, 1, 9999999999999, 1)
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`
      DELETE FROM shop_addresses WHERE cart_id = 'cart_loc'`);
    await db.execute(
      sql`INSERT INTO shop_addresses
            (id, cart_id, kind, name, line1, city, country_code,
             location_lat_e6, location_lng_e6, location_accuracy_m,
             location_source, location_captured_at)
          VALUES ('addr_loc', 'cart_loc', 'shipping', 'A Shopper', '1 Street', 'Abuja', 'NG',
                  ${sql.raw(location)})`,
    );
  }

  it('accepts a whole pin', async () => {
    await insertAddress("9057850, 7495080, 32, 'device', 1788220800000");
    const res = await db.execute(sql`
      SELECT location_lat_e6 FROM shop_addresses WHERE id = 'addr_loc'`);
    expect(Number(res.rows[0]?.location_lat_e6)).toBe(9057850);
  });

  it('accepts a hand-dropped pin with no accuracy figure', async () => {
    await insertAddress("9057850, 7495080, NULL, 'pin', 1788220800000");
    const res = await db.execute(sql`
      SELECT location_source FROM shop_addresses WHERE id = 'addr_loc'`);
    expect(res.rows[0]?.location_source).toBe('pin');
  });

  it('refuses half a pin — a coordinate with no capturedAt is a fix of unknown age', async () => {
    await expect(insertAddress("9057850, 7495080, 32, 'device', NULL")).rejects.toThrow();
    await expect(insertAddress("9057850, NULL, 32, 'device', 1788220800000")).rejects.toThrow();
  });

  /*
   * The swapped-coordinate catch. `7.49508, 9.05785` is a legal pair of numbers
   * and a spot in the Gulf of Guinea; a latitude bound at 90 catches the swap
   * for every point outside the tropics — which is where the bound earns its
   * keep, not here.
   */
  it('refuses an out-of-range coordinate', async () => {
    await expect(insertAddress("990000000, 7495080, 32, 'device', 1")).rejects.toThrow();
    await expect(insertAddress("9057850, 990000000, 32, 'device', 1")).rejects.toThrow();
  });

  it('refuses an unknown source and a negative accuracy', async () => {
    await expect(insertAddress("9057850, 7495080, 32, 'guess', 1")).rejects.toThrow();
    await expect(insertAddress("9057850, 7495080, -1, 'device', 1")).rejects.toThrow();
  });
});
