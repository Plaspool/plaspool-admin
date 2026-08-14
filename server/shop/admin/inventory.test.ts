import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { encodeCursor } from '../../repo/cursor';
import { archiveProduct, publishProduct, trashProduct } from '../catalog/products';
import { reserve } from '../catalog/inventory';
import { seedProduct, seedVariant } from '../catalog/test/catalog-harness';
import { DEFAULT_LOW_STOCK_THRESHOLD, listInventory } from './inventory';
import type { InventoryRow } from './inventory';
import { listShopCategories } from './categories';

/**
 * The stock list and the admin category list (HANDOFF §2 A4).
 *
 * They share a suite because they share a corpus and a question: **which
 * products does an admin surface count?** The public surface answers "the
 * published ones"; both routes here answer "all of them", and the two cases that
 * prove it — an archived product's stock, a trashed product's category — are the
 * ones a reader is most likely to think are bugs.
 *
 * The corpus is built once and never written again, so every test below reads the
 * same five products. Nothing here mutates stock after `beforeAll`.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();

  // Active, well stocked, with one unit held by a cart.
  const mug = await seedProduct(ctx.db, actor(), { title: 'Mug', category: 'Mugs' });
  const mugVariant = await seedVariant(ctx.db, mug.id, actor(), { sku: 'INV-A', onHand: 11 });
  await publishProduct(ctx.db, mug.id, actor());
  await reserve(ctx.db, {
    reservationId: 'res_inv_1',
    variantId: mugVariant.id,
    qty: 1,
    expiresAt: Date.now() + 60_000,
  });

  // A DRAFT, TYPED 'mugs' — which the write path re-spells to the stored
  // 'Mugs' (catalog/fold.ts): since migration 0010 a case-twin is adopted at
  // the door, not stored as a second category.
  const draft = await seedProduct(ctx.db, actor(), { title: 'Mug Draft', category: 'mugs' });
  await seedVariant(ctx.db, draft.id, actor(), { sku: 'INV-B', onHand: 3 });

  // ARCHIVED: withdrawn from sale, and the units are still on the shelf.
  const tee = await seedProduct(ctx.db, actor(), { title: 'Tee', category: 'Tees' });
  await seedVariant(ctx.db, tee.id, actor(), { sku: 'INV-C', onHand: 0 });
  await publishProduct(ctx.db, tee.id, actor());
  await archiveProduct(ctx.db, tee.id, actor());

  // TRASHED: nobody intends to sell it, so its stock is noise on a restocking
  // screen — but its category is still selectable in the trash view.
  const binned = await seedProduct(ctx.db, actor(), { title: 'Binned', category: 'Binned' });
  await seedVariant(ctx.db, binned.id, actor(), { sku: 'INV-D', onHand: 7 });
  await trashProduct(ctx.db, binned.id, actor());

  // Uncategorised: `category` is NOT NULL and '' is what "none" looks like.
  const nameless = await seedProduct(ctx.db, actor(), { title: 'Nameless', category: '' });
  await seedVariant(ctx.db, nameless.id, actor(), { sku: 'INV-E', onHand: 6 });
});

afterAll(async () => {
  await ctx?.close();
});

const skus = (items: InventoryRow[]) => items.map((row) => row.sku);

describe('the stock list', () => {
  it('is every variant of every product that is not in the trash, lowest first', async () => {
    const { items, nextCursor } = await listInventory(ctx.db, {});
    // 0 (archived), 3 (draft), 6 (uncategorised), 10 (active, one held).
    expect(skus(items)).toEqual(['INV-C', 'INV-B', 'INV-E', 'INV-A']);
    expect(nextCursor).toBeNull();
    expect(skus(items)).not.toContain('INV-D');
  });

  it('subtracts held stock rather than reporting what is on the shelf', async () => {
    const { items } = await listInventory(ctx.db, {});
    const mug = items.find((row) => row.sku === 'INV-A')!;
    /*
     * `available` is derived in the statement, never stored — Catalog's rule, and
     * the reason it is inherited rather than recomputed here is that a second
     * definition of availability disagrees with the one `reserve` decides sales
     * on. Eleven on the shelf, one promised to a cart, ten sellable.
     */
    expect(mug).toMatchObject({ onHand: 11, reserved: 1, available: 10 });
  });

  it('carries the product each variant belongs to, in whatever state it is in', async () => {
    const { items } = await listInventory(ctx.db, {});
    expect(items.map((row) => [row.sku, row.productTitle, row.productStatus])).toEqual([
      ['INV-C', 'Tee', 'archived'],
      ['INV-B', 'Mug Draft', 'draft'],
      ['INV-E', 'Nameless', 'draft'],
      ['INV-A', 'Mug', 'active'],
    ]);
  });

  it('belowOnly cuts at the default threshold', async () => {
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
    const { items } = await listInventory(ctx.db, { belowOnly: true });
    expect(skus(items)).toEqual(['INV-C', 'INV-B']);
  });

  it('a threshold moves the line, and 0 is the sold-out list', async () => {
    expect(skus((await listInventory(ctx.db, { belowOnly: true, threshold: 0 })).items)).toEqual([
      'INV-C',
    ]);
    expect(skus((await listInventory(ctx.db, { belowOnly: true, threshold: 6 })).items)).toEqual([
      'INV-C',
      'INV-B',
      'INV-E',
    ]);
  });

  it('a threshold with no belowOnly filters nothing — the flag is what applies it', async () => {
    // Stated as a test because the alternative reading ("a threshold implies the
    // filter") is reasonable and wrong: the dashboard passes a threshold to a
    // call that always filters, and this list does not.
    const { items } = await listInventory(ctx.db, { threshold: 0 });
    expect(items).toHaveLength(4);
  });
});

describe('keyset pagination over the stock list', () => {
  it('walks every row exactly once, at every page size', async () => {
    const all = skus((await listInventory(ctx.db, {})).items);

    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const at: string | null = cursor;
        const page: { items: InventoryRow[]; nextCursor: string | null } = await listInventory(
          ctx.db,
          { limit, cursor: at ?? undefined },
        );
        seen.push(...skus(page.items));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor !== null);

      expect(seen, `limit ${limit}`).toEqual(all);
    }
  });

  it('a cursor minted under another ordering is a 400, not a wrong page', async () => {
    const foreign = encodeCursor('placed', [0], 'var_x');
    await expect(listInventory(ctx.db, { cursor: foreign })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('a limit out of range is rejected rather than clamped', async () => {
    await expect(listInventory(ctx.db, { limit: 5000 })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('the admin category list', () => {
  it('includes drafts, archived AND trashed products — the public rule inverted', async () => {
    const items = await listShopCategories(ctx.db);
    /*
     * 'Binned' comes from a TRASHED product, and the DRAFT that typed 'mugs'
     * counts under 'Mugs' — adopted at write time, folded at read time. Both
     * are here because `?status=trash&category=Binned` is a real query somebody
     * makes when they are looking for the thing they deleted last week, and a
     * picker that cannot offer the value cannot express it.
     */
    expect(Object.fromEntries(items.map((row) => [row.name, row.count]))).toEqual({
      Binned: 1,
      Mugs: 2,
      Tees: 1,
    });
  });

  it('folds case, because the product list filter folds too (migration 0010)', async () => {
    /*
     * THE INVERSE OF WHAT THIS TEST ASSERTED BEFORE 0010, and the old reasoning
     * is worth keeping because it was correct: while `listProducts` compared
     * `p.category = $1` exactly, a folded list would have offered 'Mugs' with a
     * product spelled 'mugs' hiding behind it. The two sides fold TOGETHER now
     * — `lower(p.category) = lower($1)` in the filter, one grouped row here,
     * spelling-adoption at the write door, and 0010 merging what was already
     * stored. Either spelling typed into the filter reaches every product in
     * the group, so one row is the honest answer at last.
     */
    const names = (await listShopCategories(ctx.db)).map((row) => row.name);
    expect(names).toContain('Mugs');
    expect(names).not.toContain('mugs');
  });

  it('omits the empty category, which is not a name', async () => {
    // `''` is what an uncategorised product carries, and `listProducts` treats an
    // empty `?category=` as "no filter" — so an '' option could not be selected.
    expect((await listShopCategories(ctx.db)).map((row) => row.name)).not.toContain('');
  });

  it('is ordered case-insensitively', async () => {
    const names = (await listShopCategories(ctx.db)).map((row) => row.name);
    // The two mug spellings tie on `lower(...)` and their relative order is the
    // database's collation to decide, so only the unambiguous ends are pinned.
    expect(names[0]).toBe('Binned');
    expect(names[names.length - 1]).toBe('Tees');
  });
});
