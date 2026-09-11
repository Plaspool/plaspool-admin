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

describe('migration 0980_logistics', () => {
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
    const def = String(res.rows[0]!.def);
    /* The FULL fourteen — eleven prior (0360) plus the three courier additions
     * — not just the three. Asserting only the additions would still pass a
     * narrowing DROP-then-ADD that lost an old member on the way past. */
    const types = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types.sort()).toEqual(
      [
        'placed', 'payment_authorized', 'payment_failed', 'paid',
        'fulfillment_created', 'shipped', 'delivered', 'fulfillment_cancelled',
        'cancelled', 'refunded', 'refund_failed',
        'courier_booked', 'courier_update', 'courier_cancelled',
        // Migration 1110: a manual order's edit is a timeline event too.
        'edited',
      ].sort(),
    );
    const state = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'shop_fulfillments_courier_state_ck'`);
    expect(String(state.rows[0]!.def)).toContain('in_transit');
  });

  it('keeps one parcel per provider reference and has the webhook log', async () => {
    const idx = await ctx.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'shop_fulfillments_provider_ref_uq'`);
    expect(String(idx.rows[0]!.indexdef)).toMatch(/UNIQUE/);
    /* PARTIAL — a parcel shipped by hand has provider_ref NULL, and two NULLs
     * must not collide the way two equal non-NULL refs do. */
    expect(String(idx.rows[0]!.indexdef)).toContain('provider_ref IS NOT NULL');
    expect(await columns('shop_logistics_webhooks')).toEqual(
      ['id', 'provider', 'provider_ref', 'raw_status', 'verified', 'applied', 'payload', 'received_at'],
    );
  });

  it('refuses a provider_ref with no provider, and a negative provider_cost_minor', async () => {
    const orderId = 'ord_test_0960';
    const fulfillmentId = 'ful_test_0960';
    await ctx.db.execute(sql`
      INSERT INTO shop_orders (
        id, order_number, email, currency, subtotal, shipping_total, tax_total, grand_total,
        status, shipping_address, billing_address, placed_at, revision, source_event_id, checkout_id
      ) VALUES (
        ${orderId}, '2026-000001-T', 'buyer@test.local', 'NGN', 100000, 0, 0, 100000,
        'pending', '{}'::jsonb, '{}'::jsonb, 1, 1, 'evt_test_0960', 'chk_test_0960'
      )`);
    await ctx.db.execute(sql`
      INSERT INTO shop_fulfillments (id, order_id, status, created_at, revision)
      VALUES (${fulfillmentId}, ${orderId}, 'pending', 1, 1)`);

    /* The migration declares this bigint, not integer like the rest of the
     * table's money-ish columns — a courier fee needs the wider range. */
    const dt = await ctx.db.execute(sql`
      SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shop_fulfillments'
         AND column_name = 'provider_cost_minor'`);
    expect(String(dt.rows[0]!.data_type)).toBe('bigint');

    // shop_fulfillments_provider_ref_ck: a reference with no provider makes no sense.
    await expect(
      ctx.db.execute(sql`UPDATE shop_fulfillments SET provider_ref = 'FEZ-1' WHERE id = ${fulfillmentId}`),
    ).rejects.toThrow();

    // shop_fulfillments_provider_cost_ck: what a courier charged us cannot be negative.
    await expect(
      ctx.db.execute(sql`UPDATE shop_fulfillments SET provider_cost_minor = -100 WHERE id = ${fulfillmentId}`),
    ).rejects.toThrow();
  });
});
