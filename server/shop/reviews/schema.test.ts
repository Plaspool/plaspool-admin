import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../../test/harness';
import type { RawCtx } from '../../test/harness';

/**
 * The applied DDL, read back out of the catalog — never out of
 * `schema.ts` or `0180_reviews.sql`, both of which can say whatever they
 * like without the database agreeing. This is the commerce contract's rule:
 * hand-written migrations are asserted against a migrated database.
 */

let ctx: RawCtx;

beforeAll(async () => {
  ctx = await migratedDb();
});

afterAll(async () => {
  await ctx?.close();
});

describe('shop_reviews DDL', () => {
  it('has exactly the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_reviews' ORDER BY column_name
    `);
    const names = rows.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).toEqual(
      [
        'author_email',
        'author_name',
        'body',
        'created_at',
        'customer_id',
        'id',
        'moderated_at',
        'moderated_by',
        'order_id',
        'product_slug',
        'rating',
        'sentiment_label',
        'sentiment_score',
        'status',
        'title',
        'updated_at',
      ].sort(),
    );
  });

  it('timestamps are bigint, never timestamptz', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'shop_reviews'
        AND column_name IN ('created_at', 'updated_at', 'moderated_at')
    `);
    for (const r of rows.rows as { data_type: string }[]) {
      expect(r.data_type).toBe('bigint');
    }
  });

  const insert = (over: Record<string, unknown>) =>
    ctx.db.execute(sql`
      INSERT INTO shop_reviews
        (id, product_slug, rating, body, author_name, author_email,
         status, sentiment_label, sentiment_score, created_at, updated_at)
      VALUES
        (${over.id ?? 'rev_test1'}, 'pla-basic', ${over.rating ?? 5}, 'body text here',
         'Test', 't@example.com', ${over.status ?? 'pending'},
         ${over.sentiment ?? 'neutral'}, 0, 1, 1)
    `);

  it('the rating check is applied, not just declared', async () => {
    await expect(insert({ id: 'rev_bad_r', rating: 6 })).rejects.toThrow(/shop_reviews_rating_ck/);
    await expect(insert({ id: 'rev_bad_r0', rating: 0 })).rejects.toThrow(/shop_reviews_rating_ck/);
  });

  it('the status and sentiment checks are applied', async () => {
    await expect(insert({ id: 'rev_bad_s', status: 'live' })).rejects.toThrow(
      /shop_reviews_status_ck/,
    );
    await expect(insert({ id: 'rev_bad_l', sentiment: 'mixed' })).rejects.toThrow(
      /shop_reviews_sentiment_ck/,
    );
  });

  it('status defaults to pending', async () => {
    await ctx.db.execute(sql`
      INSERT INTO shop_reviews
        (id, product_slug, rating, body, author_name, author_email,
         sentiment_label, sentiment_score, created_at, updated_at)
      VALUES ('rev_default', 'pla-basic', 4, 'body text here', 'T', 't@example.com',
              'neutral', 0, 1, 1)
    `);
    const rows = await ctx.db.execute(
      sql`SELECT status FROM shop_reviews WHERE id = 'rev_default'`,
    );
    expect((rows.rows[0] as { status: string }).status).toBe('pending');
  });
});
