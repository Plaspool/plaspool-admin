/**
 * SKU derivation.
 *
 * The property under test is not "the code looks nice" — it is that a person
 * never has to invent an identifier before they can describe a colour, and that
 * `shop_variants_sku_unique` is still satisfied when they do not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { generateSku, skuCandidate } from './sku';
import { createVariant } from './variants';
import { createProduct } from './products';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE shop_products, shop_variants, shop_inventory CASCADE`);
});

describe('the candidate', () => {
  it('reads as the thing it names', () => {
    // The first word plus the spec digits — what somebody writing these by
    // hand produces, and what the seeded catalogue already uses.
    expect(skuCandidate('PLA+ Filament 1.75 mm — 1 kg', { Colour: 'Black' })).toBe(
      'PLA-175-BLACK',
    );
  });

  it('keeps a decimal together rather than splitting it into fragments', () => {
    // `1.75 mm` is one measurement. Splitting on the point yields `1` and `75`,
    // which are two numbers that mean nothing.
    expect(skuCandidate('Rod 1.75', {})).toBe('ROD-175');
  });

  it('keeps both words of a two-word option value', () => {
    // `NATURAL` alone would collide with every other Natural-something.
    expect(skuCandidate('Filament', { Colour: 'Natural Birch' })).toBe('FILAMENT-NATBIR');
  });

  it('is stable whatever order the axes arrive in', () => {
    /*
     * The form renders switches in whatever order somebody flipped them, and
     * the same physical variant reaching two different SKUs depending on that
     * is exactly the picking error the unique constraint exists to prevent.
     */
    const a = skuCandidate('Tee', { Colour: 'Red', Size: 'L' });
    const b = skuCandidate('Tee', { Size: 'L', Colour: 'Red' });
    expect(a).toBe(b);
  });

  it('uses the values and not the axis names', () => {
    // `COLOUR-BLACK` says it twice; the value alone is what identifies it.
    const sku = skuCandidate('Tee', { Colour: 'Black' });
    expect(sku).toContain('BLACK');
    expect(sku).not.toContain('COLOUR');
  });

  it('strips accents, so two spellings cannot become two codes', () => {
    expect(skuCandidate('Cafe', { X: 'Creme' })).toBe(skuCandidate('Café', { X: 'Crème' }));
  });

  it('survives a title with nothing usable in it', () => {
    expect(skuCandidate('!!! ???', {})).toBe('ITEM');
  });
});

describe('generateSku', () => {
  it('climbs a ladder rather than colliding', async () => {
    // A REAL user id: `shop_products.author_id` is an FK, and a random uuid is
    // a 23503 rather than a product.
    const seeded = await ctx.db.execute(sql`SELECT id FROM users LIMIT 1`);
    const authorId = String(seeded.rows[0].id);
    await ctx.db.execute(sql`
      INSERT INTO shop_products (id, slug, title, description, description_text, status,
                                 category, tags, image_ids, created_at, updated_at,
                                 author_id, revision)
      VALUES ('p_1', 'tee', 'Tee', '{}'::jsonb, '', 'draft', '', '{}', '{}',
              1, 1, ${authorId}, 1)`);

    const first = await generateSku(ctx.db, 'Tee', { Colour: 'Red' });
    await ctx.db.execute(sql`
      INSERT INTO shop_variants (id, product_id, sku, option_values, position, status,
                                 created_at, updated_at)
      VALUES ('v_1', 'p_1', ${first}, '{}'::jsonb, 0, 'active', 1, 1)`);

    const second = await generateSku(ctx.db, 'Tee', { Colour: 'Red' });
    expect(second).not.toBe(first);
    expect(second).toBe(`${first}-1`);
  });
});

describe('creating a variant', () => {
  const owner = { id: '', email: 'o@test.local', displayName: 'O', role: 'owner' as const };

  it('needs no SKU at all, and derives a usable one', async () => {
    /*
     * THE POINT OF THE WHOLE CHANGE. The form used to demand an identifier
     * before it would accept anything a person actually knows about the thing
     * they are selling.
     */
    const seeded = await ctx.db.execute(sql`SELECT id FROM users LIMIT 1`);
    const actor = { ...owner, id: String(seeded.rows[0].id) };
    const product = await createProduct(ctx.db, actor, { title: 'Enamel Mug' });

    const variant = await createVariant(
      ctx.db,
      product.id,
      { optionValues: { Colour: 'Blue' } },
      actor,
    );

    expect(variant.sku).toBe('ENAMEL-BLUE');
    expect(variant.optionValues).toEqual({ Colour: 'Blue' });
  });

  it('never overwrites a SKU somebody supplied', async () => {
    // A shop with an existing catalogue has codes a supplier knows.
    const seeded = await ctx.db.execute(sql`SELECT id FROM users LIMIT 1`);
    const actor = { ...owner, id: String(seeded.rows[0].id) };
    const product = await createProduct(ctx.db, actor, { title: 'Enamel Mug' });

    const variant = await createVariant(ctx.db, product.id, { sku: 'LEGACY-0001' }, actor);
    expect(variant.sku).toBe('LEGACY-0001');
  });

  it('still refuses an empty string, which is a caller bug rather than an absence', async () => {
    const seeded = await ctx.db.execute(sql`SELECT id FROM users LIMIT 1`);
    const actor = { ...owner, id: String(seeded.rows[0].id) };
    const product = await createProduct(ctx.db, actor, { title: 'Enamel Mug' });

    await expect(createVariant(ctx.db, product.id, { sku: '   ' }, actor)).rejects.toThrow();
  });

  it('derives distinct SKUs for a family of colours', async () => {
    const seeded = await ctx.db.execute(sql`SELECT id FROM users LIMIT 1`);
    const actor = { ...owner, id: String(seeded.rows[0].id) };
    const product = await createProduct(ctx.db, actor, { title: 'Enamel Mug' });

    const made = [];
    for (const colour of ['Blue', 'Red', 'Blue']) {
      made.push(await createVariant(ctx.db, product.id, { optionValues: { Colour: colour } }, actor));
    }
    // Two "Blue" variants is a real thing somebody can do by accident, and the
    // second must not collide — it gets the next rung.
    expect(new Set(made.map((v) => v.sku)).size).toBe(3);
    expect(made[2].sku).toBe('ENAMEL-BLUE-1');
  });
});
