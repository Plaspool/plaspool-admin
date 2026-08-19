import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';

describe('shop_auth_assertions', () => {
  it('exists with the columns and types the bridge relies on', async () => {
    const { db } = await migratedDb();
    const res = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'shop_auth_assertions'
       ORDER BY ordinal_position`);
    expect(res.rows).toEqual([
      { column_name: 'jti', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'used_at', data_type: 'bigint', is_nullable: 'NO' },
    ]);
  });

  it('makes jti the primary key, which is what stops a replay', async () => {
    const { db } = await migratedDb();
    const res = await db.execute(sql`
      SELECT conname, contype FROM pg_constraint
       WHERE conrelid = 'shop_auth_assertions'::regclass AND contype = 'p'`);
    expect(res.rows).toHaveLength(1);
  });
});
