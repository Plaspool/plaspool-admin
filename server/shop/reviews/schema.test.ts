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

/**
 * The 0620 tables, on the same terms as `shop_reviews` above: read out of the
 * catalog, never out of the migration file or `schema.ts`, both of which can
 * say whatever they like without the database agreeing.
 */
describe('shop_review_replies DDL', () => {
  it('has exactly the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_review_replies' ORDER BY column_name
    `);
    expect(rows.rows.map((r) => (r as { column_name: string }).column_name)).toEqual([
      'author_kind',
      'author_name',
      'body',
      'created_at',
      'customer_id',
      'depth',
      'id',
      'moderated_at',
      'moderated_by',
      'parent_id',
      'review_id',
      'staff_user_id',
      'status',
      'updated_at',
    ]);
  });

  it('pairs depth with parentage, so a broken thread is unstorable', async () => {
    /*
     * The check that matters most. Either column alone is satisfiable by a row
     * that makes no sense — a depth-0 row carrying a parent, a depth-1 orphan —
     * and both render as a broken thread rather than as an error.
     */
    const rows = await ctx.db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'shop_review_replies'::regclass AND contype = 'c'
      ORDER BY conname
    `);
    const names = rows.rows.map((r) => (r as { conname: string }).conname);
    expect(names).toContain('shop_review_replies_depth_parent_ck');
    expect(names).toContain('shop_review_replies_depth_ck');
    expect(names).toContain('shop_review_replies_author_ck');
  });

  it('REFUSES a depth-1 row with no parent', async () => {
    // Behavioural, not by presence: "the constraint exists" and "the constraint
    // does what it is for" are different claims and only the second is useful.
    await expect(
      ctx.db.execute(sql`
        INSERT INTO shop_review_replies
          (id, review_id, parent_id, depth, body, author_kind, author_name,
           status, created_at, updated_at)
        VALUES ('rpl_bad', 'rev_x', NULL, 1, 'orphan', 'customer', 'X',
                'pending', 1, 1)`),
    ).rejects.toThrow();
  });

  it('REFUSES an owner reply with no staff attribution', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO shop_review_replies
          (id, review_id, parent_id, depth, body, author_kind, author_name,
           staff_user_id, status, created_at, updated_at)
        VALUES ('rpl_bad2', 'rev_x', NULL, 0, 'unattributed', 'owner', 'PlaSpool',
                NULL, 'approved', 1, 1)`),
    ).rejects.toThrow();
  });
});

describe('shop_review_reactions DDL', () => {
  it('has exactly the declared columns', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_review_reactions' ORDER BY column_name
    `);
    expect(rows.rows.map((r) => (r as { column_name: string }).column_name)).toEqual([
      'created_at',
      'customer_id',
      'kind',
      'review_id',
      'updated_at',
    ]);
  });

  it('makes one-vote-per-customer the PRIMARY KEY, not an application rule', async () => {
    /*
     * The whole anti-abuse story rests on this. A check-then-insert in a route
     * is a race, and the race is two tabs turning one person into two votes.
     */
    const rows = await ctx.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'shop_review_reactions'::regclass AND contype = 'p'
    `);
    expect(String((rows.rows[0] as { def: string }).def)).toBe(
      'PRIMARY KEY (review_id, customer_id)',
    );
  });

  it('has NO denormalised counter on shop_reviews to drift from it', async () => {
    // 0620 deliberately adds no `helpful_count` column and no trigger: the
    // counts are aggregated on read and therefore cannot disagree with the rows.
    const rows = await ctx.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shop_reviews' AND column_name LIKE '%count%'
    `);
    expect(rows.rows).toEqual([]);
  });
});
