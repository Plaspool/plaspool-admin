import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../../test/harness';

let ctx: TestCtx;
beforeAll(async () => { ctx = await freshDb(); });
afterAll(async () => { await ctx.close(); });

const columns = async (table: string): Promise<string[]> => {
  const res = await ctx.db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`);
  return res.rows.map((r) => String(r.column_name));
};

describe('migration 0960_logistics', () => {
  it('adds the courier columns to shop_fulfillments', async () => {
    const cols = await columns('shop_fulfillments');
    for (const c of ['provider', 'provider_ref', 'provider_status', 'courier_state', 'tracking_url',
      'label_url', 'provider_cost_minor', 'provider_synced_at', 'provider_last_error']) {
      expect(cols, c).toContain(c);
    }
  });

  it('seeds one manual settings row and refuses a second id', async () => {
    const res = await ctx.db.execute(sql`SELECT id, provider, revision, packaging FROM shop_logistics_settings`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ id: 'main', provider: 'manual', revision: 1 });
    expect(res.rows[0]!.packaging).toMatchObject({ name: 'Spool box', lengthCm: 22, widthCm: 22, heightCm: 8, weightKg: 0.25 });
    await expect(
      ctx.db.execute(sql`INSERT INTO shop_logistics_settings (id, provider, updated_at) VALUES ('other', 'manual', 1)`),
    ).rejects.toThrow();
  });

  it('refuses an unknown provider, courier state, or timeline type', async () => {
    await expect(ctx.db.execute(sql`UPDATE shop_logistics_settings SET provider = 'dhl' WHERE id = 'main'`)).rejects.toThrow();
    const res = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'shop_order_events_type_ck'`);
    expect(String(res.rows[0]!.def)).toContain('courier_booked');
    expect(String(res.rows[0]!.def)).toContain('courier_update');
    expect(String(res.rows[0]!.def)).toContain('courier_cancelled');
    const state = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'shop_fulfillments_courier_state_ck'`);
    expect(String(state.rows[0]!.def)).toContain('in_transit');
  });

  it('keeps one parcel per provider reference and has the webhook log', async () => {
    const idx = await ctx.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'shop_fulfillments_provider_ref_uq'`);
    expect(String(idx.rows[0]!.indexdef)).toMatch(/UNIQUE/);
    expect(await columns('shop_logistics_webhooks')).toEqual(
      ['id', 'provider', 'provider_ref', 'raw_status', 'verified', 'applied', 'payload', 'received_at'],
    );
  });
});
