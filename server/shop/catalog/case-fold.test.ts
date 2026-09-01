import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json } from '../../test/http';
import type { HttpClient } from '../../test/http';
import { BadRequestError } from '../../repo/errors';
import { canonicalCategory, canonicalTags, canonicalizeOptions, foldedTupleKey } from './fold';
import { createProduct, saveProduct } from './products';
import { listProducts } from './query';
import { createVariant, updateVariant, DuplicateOptionsError } from './variants';
import { listShopCategoriesUnion as listShopCategories } from './categories';
import { listShopTags } from '../admin/tags';
import { rejection, seedProduct } from './test/catalog-harness';

/**
 * Case-folded vocabulary (migration 0010's living half).
 *
 * The catalogue these tests guard against is real: `PLA`, `pla`, `Pla` and
 * `pLA` as four tags, `Colour Black` and `Colour black` as two variants of one
 * product. The migration merged the stored twins; everything asserted here is
 * what stops the mess growing back — folded reads, spelling-adopting writes,
 * and a duplicate-combination refusal.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

/** Plant a legacy spelling the write path would have canonicalised away. */
async function mangleCategory(id: string, category: string): Promise<void> {
  await ctx.db.execute(sql`UPDATE shop_products SET category = ${category} WHERE id = ${id}`);
}

async function mangleTags(id: string, tags: string[]): Promise<void> {
  await ctx.db.execute(sql`UPDATE shop_products SET tags = ${sql.param(tags)} WHERE id = ${id}`);
}

describe('the fold helpers', () => {
  it('foldedTupleKey is one identity across case and key order', () => {
    const a = foldedTupleKey({ Colour: 'Black', Size: 'M' });
    expect(foldedTupleKey({ size: 'm', colour: 'BLACK' })).toBe(a);
    expect(foldedTupleKey({ Colour: 'Navy', Size: 'M' })).not.toBe(a);
    expect(foldedTupleKey({})).toBe('[]');
  });

  it('canonicalizeOptions adopts the majority spelling, alphabetical on a tie', () => {
    expect(
      canonicalizeOptions(
        [{ Colour: 'Black' }, { Colour: 'Navy' }, { colour: 'Red' }],
        { colour: 'black' },
      ),
    ).toEqual({ Colour: 'Black' });
    // One of each spelling: the tie goes alphabetically, whatever order the
    // existing tuples arrive in — the tally is complete before the pick.
    expect(canonicalizeOptions([{ colour: 'x' }, { Colour: 'y' }], { COLOUR: 'z' })).toEqual({
      Colour: 'z',
    });
  });

  it('refuses tuples with no storable form', () => {
    // Two incoming keys collapsing onto one axis.
    expect(canonicalizeOptions([], { Colour: 'a', colour: 'b' })).toBeNull();
    // Empty key or value after trimming.
    expect(canonicalizeOptions([], { '  ': 'a' })).toBeNull();
    expect(canonicalizeOptions([], { Colour: ' ' })).toBeNull();
  });
});

describe('categories fold together', () => {
  it('the admin list groups spellings under one canonical row', async () => {
    const a = await seedProduct(ctx.db, actor(), { title: 'Fold A', category: 'Foldables' });
    const b = await seedProduct(ctx.db, actor(), { title: 'Fold B' });
    const c = await seedProduct(ctx.db, actor(), { title: 'Fold C' });
    await mangleCategory(a.id, 'Foldables');
    await mangleCategory(b.id, 'Foldables');
    await mangleCategory(c.id, 'foldables');

    const rows = (await listShopCategories(ctx.db)).filter(
      (r) => r.name.toLowerCase() === 'foldables',
    );
    /*
     * The full row, not just name and count, because migration 0200 turned this
     * list into a UNION and the null half is the half worth pinning: a value
     * typed into `shop_products.category` with no managed row behind it is "in
     * use, not managed" — no id, no slug, and therefore nothing the storefront
     * can route to until somebody adopts it.
     */
    expect(rows).toEqual([
      {
        id: null,
        slug: null,
        name: 'Foldables',
        blurb: '',
        accentHex: null,
        position: 0,
        count: 3,
        managed: false,
      },
    ]);
  });

  it('the product list filter matches every spelling of the category', async () => {
    const a = await seedProduct(ctx.db, actor(), { title: 'Case A' });
    const b = await seedProduct(ctx.db, actor(), { title: 'Case B' });
    await mangleCategory(a.id, 'Trimmings');
    await mangleCategory(b.id, 'trimmings');

    const page = await listProducts(ctx.db, {
      sort: 'newest',
      category: 'TRIMMINGS',
      includeUnpublished: true,
    });
    const ids = page.items.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('a save adopts the stored spelling instead of minting a case-twin', async () => {
    const first = await seedProduct(ctx.db, actor(), { title: 'Speller' });
    await mangleCategory(first.id, 'Specialty Filament');

    const created = await createProduct(ctx.db, actor(), {
      title: 'Adopts on create',
      category: 'specialty filament',
    });
    expect(created.category).toBe('Specialty Filament');

    const saved = await saveProduct(
      ctx.db,
      created.id,
      { category: 'SPECIALTY FILAMENT' },
      { actor: actor() },
    );
    expect(saved.category).toBe('Specialty Filament');
  });

  it('a genuinely new category keeps the typed spelling, trimmed', async () => {
    const created = await createProduct(ctx.db, actor(), {
      title: 'New vocab',
      category: '  Resin Accessories ',
    });
    expect(created.category).toBe('Resin Accessories');
  });
});

describe('tags fold together', () => {
  it('a save case-dedupes within the list and adopts stored spellings', async () => {
    const holder = await seedProduct(ctx.db, actor(), { title: 'Tag holder' });
    await mangleTags(holder.id, ['PLA', 'wood-fill']);

    const created = await createProduct(ctx.db, actor(), {
      title: 'Tagged',
      tags: ['pla', 'PLA', 'Wood-Fill', 'brand-new', ' brand-new '],
    });
    // `pla` and `PLA` are one tag (first position kept), spelled the stored
    // way; `Wood-Fill` adopts `wood-fill`; the new tag keeps its own spelling.
    expect(created.tags).toEqual(['PLA', 'wood-fill', 'brand-new']);
  });

  it('empty and whitespace tags are dropped rather than stored as blank chips', async () => {
    const created = await createProduct(ctx.db, actor(), {
      title: 'Blank tags',
      tags: ['', '  ', 'real'],
    });
    expect(created.tags).toEqual(['real']);
  });

  it('the tag vocabulary route groups spellings under one canonical row', async () => {
    const a = await seedProduct(ctx.db, actor(), { title: 'Vocab A' });
    const b = await seedProduct(ctx.db, actor(), { title: 'Vocab B' });
    const c = await seedProduct(ctx.db, actor(), { title: 'Vocab C' });
    await mangleTags(a.id, ['Matte']);
    await mangleTags(b.id, ['Matte']);
    await mangleTags(c.id, ['matte']);

    const rows = (await listShopTags(ctx.db)).filter((r) => r.name.toLowerCase() === 'matte');
    expect(rows).toEqual([{ name: 'Matte', count: 3 }]);
  });
});

describe('variant combinations fold together', () => {
  it('a new tuple adopts the product’s existing key and value spellings', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Spool' });
    await createVariant(ctx.db, product.id, { optionValues: { Colour: 'Walnut' } }, actor());
    const second = await createVariant(
      ctx.db,
      product.id,
      { optionValues: { colour: 'Ebony' } },
      actor(),
    );
    expect(second.optionValues).toEqual({ Colour: 'Ebony' });
  });

  it('the same combination in a different case is refused, naming the stored one', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Twin spool' });
    await createVariant(ctx.db, product.id, { optionValues: { Colour: 'Black' } }, actor());

    const err = await rejection<DuplicateOptionsError>(
      createVariant(ctx.db, product.id, { optionValues: { colour: 'black' } }, actor()),
    );
    expect(err).toBeInstanceOf(DuplicateOptionsError);
    expect(err.summary).toBe('Colour Black');
  });

  it('several option-less variants per product stay a supported shape', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Plain thing' });
    await createVariant(ctx.db, product.id, {}, actor());
    // A second `{}` variant must NOT be a duplicate — SKU-only families are
    // real, and three suites in this repo create them.
    await expect(createVariant(ctx.db, product.id, {}, actor())).resolves.toBeTruthy();
  });

  it('an update can respell ITSELF deliberately, and cannot become a sibling', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Rename me' });
    const black = await createVariant(
      ctx.db,
      product.id,
      { optionValues: { Colour: 'Black' } },
      actor(),
    );
    await createVariant(ctx.db, product.id, { optionValues: { Colour: 'Navy' } }, actor());

    /*
     * The vocabulary excludes the variant being edited, so when NO SIBLING
     * shares the value, a retype in a different case is the one place a
     * deliberate respelling is expressible — the key still folds to the
     * majority axis, the value keeps the typed case, and it is not a
     * collision with itself.
     */
    const respelled = await updateVariant(ctx.db, black.id, {
      optionValues: { colour: 'BLACK' },
    });
    expect(respelled.optionValues).toEqual({ Colour: 'BLACK' });

    // But it cannot case-shift onto a sibling's combination…
    const err = await rejection<DuplicateOptionsError>(
      updateVariant(ctx.db, black.id, { optionValues: { colour: 'navy' } }),
    );
    expect(err).toBeInstanceOf(DuplicateOptionsError);

    // …and when a sibling DOES share the value, its spelling is adopted:
    // per-variant respelling would put two casings of one colour on one page.
    const sizedM = await createVariant(
      ctx.db,
      product.id,
      { optionValues: { Colour: 'Rust', Size: 'M' } },
      actor(),
    );
    await createVariant(
      ctx.db,
      product.id,
      { optionValues: { Colour: 'Rust', Size: 'L' } },
      actor(),
    );
    const adopted = await updateVariant(ctx.db, sizedM.id, {
      optionValues: { colour: 'RUST', size: 'M' },
    });
    expect(adopted.optionValues).toEqual({ Colour: 'Rust', Size: 'M' });
  });
});

describe('the colour code', () => {
  it('is lowercased on the way in, readable back, and clearable', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Coloured' });
    const variant = await createVariant(
      ctx.db,
      product.id,
      { optionValues: { Colour: 'Rust' }, colorHex: '#AB12CD' },
      actor(),
    );
    expect(variant.colorHex).toBe('#ab12cd');

    const cleared = await updateVariant(ctx.db, variant.id, { colorHex: null });
    expect(cleared.colorHex).toBeNull();

    const set = await updateVariant(ctx.db, variant.id, { colorHex: '#8B5A2B' });
    expect(set.colorHex).toBe('#8b5a2b');
  });

  it('refuses a code that is not #rrggbb, naming the field', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Badly coloured' });
    const err = await rejection<BadRequestError>(
      createVariant(
        ctx.db,
        product.id,
        { optionValues: { Colour: 'Odd' }, colorHex: '#abc' },
        actor(),
      ),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.detail).toBe('colorHex');
  });
});

describe('on the wire', () => {
  let http: HttpClient;

  beforeAll(async () => {
    http = httpClient(ctx.db);
    await http.signIn({ email: 'owner@test.local' });
  });

  it('a duplicate combination is a 409 naming what it collided with', async () => {
    const created = await http.post('/api/shop/admin/products', { title: 'Wire spool' });
    expect(created.status).toBe(201);
    const { product } = await json<{ product: { id: string } }>(created);

    const first = await http.post(`/api/shop/admin/products/${product.id}/variants`, {
      optionValues: { Colour: 'Black' },
      colorHex: '#000000',
    });
    expect(first.status).toBe(201);

    const twin = await http.post(`/api/shop/admin/products/${product.id}/variants`, {
      optionValues: { colour: 'BLACK' },
    });
    expect(twin.status).toBe(409);
    expect(await json(twin)).toMatchObject({
      error: 'duplicate_options',
      detail: 'optionValues',
      summary: 'Colour Black',
    });
  });

  it('a malformed colour code is a 400 that names the field', async () => {
    const created = await http.post('/api/shop/admin/products', { title: 'Wire colour' });
    const { product } = await json<{ product: { id: string } }>(created);

    const res = await http.post(`/api/shop/admin/products/${product.id}/variants`, {
      optionValues: { Colour: 'Teal' },
      colorHex: 'teal',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ detail: 'colorHex' });
  });

  it('GET /admin/tags answers the folded vocabulary and refuses stray params', async () => {
    const ok = await http.get('/api/shop/admin/tags');
    expect(ok.status).toBe(200);
    const body = await json<{ items: { name: string; count: number }[] }>(ok);
    expect(Array.isArray(body.items)).toBe(true);

    const stray = await http.get('/api/shop/admin/tags?limit=10');
    expect(stray.status).toBe(400);
  });
});
