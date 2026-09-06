/**
 * `shop_add_ons` as a reference in the orphan collector's walk (migration 0940,
 * task 6).
 *
 * THE SAME BUG THE VARIANT AND PRODUCT SUITES ALREADY PIN, ONE MORE TABLE.
 * `shop_add_ons.image_id` names a row in the very same `images` table, exactly
 * as `shop_products.cover_image_id` and `shop_variants.image_id` do — so an
 * image uploaded for an add-on and placed in no post, no product and no
 * variant would be "unreferenced" from the moment it was committed: the mark
 * pass would stamp its clock, and the delete pass would remove it 24 hours
 * later, whether or not the add-on that names it is still a draft somebody is
 * about to switch on.
 *
 * `server/repo/images.ts#REFERENCE_SET` unions `shop_add_ons.image_id` (both
 * bare and with its optional `asset:`/`idb:` scheme stripped) for exactly this
 * reason, and this suite is the one assertion that the union entry is actually
 * there: an image named only by an add-on survives a mark pass, and one named
 * by nothing at all still gets its clock started.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { markUnreferenced } from './images';
import { createAddOn } from '../shop/catalog/add-ons/repo';
import type { AuthUser } from '../../shared/types';

const HOUR = 60 * 60 * 1000;

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM shop_add_ons`);
  // `shop_product_revisions` is ON DELETE CASCADE from `shop_products`, so the
  // product delete takes its history with it.
  await ctx.db.execute(sql`DELETE FROM shop_products`);
  await ctx.db.execute(sql`DELETE FROM revisions`);
  await ctx.db.execute(sql`DELETE FROM images`);
  await ctx.db.execute(sql`DELETE FROM posts`);
});

const owner = (): AuthUser => ctx.users.owner;

interface SeedImage {
  id: string;
  /** Milliseconds before now that the slot was minted AND committed. */
  ageMs?: number;
  /** A clock a previous mark pass had already started, in ms before now. */
  unreferencedForMs?: number | null;
}

/**
 * A committed image placed anywhere in time, written directly.
 *
 * `createSlot`/`commitImage` stamp `Date.now()`, and every property under test
 * here is an interval measured in hours; faking the clock would fake it for the
 * statement too. Placing the ROW is the honest way to ask the question — the
 * same reasoning `server/repo/images.test.ts` records for its own seeder.
 */
async function seedImage(seed: SeedImage): Promise<void> {
  const user = owner();
  const at = Date.now() - (seed.ageMs ?? 48 * HOUR);
  const clock =
    seed.unreferencedForMs == null ? null : Date.now() - seed.unreferencedForMs;
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    VALUES (${seed.id}, ${user.id}::uuid, ${`images/${user.id}/${seed.id}`},
            'image/png', NULL, NULL, 1000, NULL, ${at}, ${at}, ${clock})`);
}

async function unreferencedSince(id: string): Promise<number | null> {
  const res = await ctx.db.execute(
    sql`SELECT unreferenced_since FROM images WHERE id = ${id}`,
  );
  const value = res.rows[0]?.unreferenced_since;
  return value == null ? null : Number(value);
}

describe('markUnreferenced sees add-ons', () => {
  it('an image named only by an add-on is referenced; one named by nothing is marked', async () => {
    await seedImage({ id: 'img_box' });
    await seedImage({ id: 'img_loose' });
    await createAddOn(ctx.db, { title: 'Box', imageId: 'img_box', priceMinor: 1, currency: 'NGN', rules: [{ when: [], then: 'ask' }] }, Date.now());
    await markUnreferenced(ctx.db);
    expect(await unreferencedSince('img_box')).toBeNull();
    expect(await unreferencedSince('img_loose')).not.toBeNull();
  });
});
