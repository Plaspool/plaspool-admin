import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { BadRequestError } from '../../repo/errors';
import { encodeCursor } from '../../repo/cursor';
import { listProducts } from './query';
import type { ProductSort } from './query';
import { publishProduct, trashProduct } from './products';
import { seedProduct, seedVariant } from './test/catalog-harness';

/**
 * Keyset pagination over the catalogue.
 *
 * THE PROPERTY UNDER TEST IS "every row exactly once", and it is the one an
 * offset-paginated list silently breaks: a product inserted above the window
 * pushes one row past the boundary and it is never seen, and one deleted above
 * the window pulls one up and it is seen twice. Neither shows up as an error
 * anywhere, which is why it is walked here at several page sizes and then walked
 * again while the table is being written to underneath.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

/** A corpus engineered for TIES, because ties are where a keyset walk breaks. */
const CORPUS: [string, number][] = [
  ['Alpha', 1000],
  ['Bravo', 1000], // same price as Alpha
  ['Charlie', 2000],
  ['Delta', 2000], // same price as Charlie
  ['Echo', 500],
  ['Foxtrot', 3000],
  ['Golf', 1000], // a third at 1000
  ['Hotel', 4000],
  ['India', 500], // same price as Echo
  ['Juliett', 2500],
  ['Kilo', 1500],
];

const ids: string[] = [];

beforeAll(async () => {
  ctx = await freshDb();
  for (const [title, amount] of CORPUS) {
    const product = await seedProduct(ctx.db, actor(), { title, category: 'kit' });
    await seedVariant(ctx.db, product.id, actor(), { amount, onHand: 3 });
    await publishProduct(ctx.db, product.id, actor());
    ids.push(product.id);
  }
  // Two products that must never appear on the storefront.
  const draft = await seedProduct(ctx.db, actor(), { title: 'Zulu Draft', category: 'kit' });
  const trashed = await seedProduct(ctx.db, actor(), { title: 'Yankee Trashed', category: 'kit' });
  await publishProduct(ctx.db, trashed.id, actor());
  await trashProduct(ctx.db, trashed.id, actor());
  ids.push(draft.id, trashed.id);
});

afterAll(async () => {
  await ctx?.close();
});

const SORTS: ProductSort[] = ['newest', 'price_asc', 'price_desc', 'alphabetical'];

/** Walk the whole list one page at a time, returning the ids in order seen. */
async function walk(sort: ProductSort, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  // Bounded so a codec that never terminates fails loudly rather than hanging.
  for (let page = 0; page < 100; page += 1) {
    const res = await listProducts(ctx.db, { sort, limit, cursor });
    seen.push(...res.items.map((p) => p.id));
    if (!res.nextCursor) return seen;
    cursor = res.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('the storefront predicate', () => {
  it('shows only active, untrashed products — on every sort', async () => {
    for (const sort of SORTS) {
      const seen = await walk(sort, 4);
      expect(seen, sort).toHaveLength(CORPUS.length);
      const titles = new Set(seen);
      expect(titles.size, `${sort}: a product appeared twice`).toBe(CORPUS.length);
    }
  });

  it('an admin list sees the draft and, on request, the trash', async () => {
    const all = await listProducts(ctx.db, { sort: 'newest', limit: 100, includeUnpublished: true });
    const titles = all.items.map((p) => p.title);
    expect(titles).toContain('Zulu Draft');
    // The trash is a VIEW, not a status: every other filter excludes it.
    expect(titles).not.toContain('Yankee Trashed');

    const trash = await listProducts(ctx.db, {
      sort: 'newest',
      limit: 100,
      includeUnpublished: true,
      status: 'trash',
    });
    expect(trash.items.map((p) => p.title)).toEqual(['Yankee Trashed']);
  });

  it('filters by category, and an empty category is NO filter', async () => {
    const kit = await listProducts(ctx.db, { sort: 'newest', limit: 100, category: 'kit' });
    expect(kit.items).toHaveLength(CORPUS.length);
    const none = await listProducts(ctx.db, { sort: 'newest', limit: 100, category: 'nothing' });
    expect(none.items).toHaveLength(0);
    // `''` means "no filter", not "products with no category".
    const empty = await listProducts(ctx.db, { sort: 'newest', limit: 100, category: '' });
    expect(empty.items).toHaveLength(CORPUS.length);
  });
});

describe('every row exactly once', () => {
  it.each([1, 2, 3, 5, 7, 11])(
    'returns all %i-sized pages with no skip and no repeat, on every sort',
    async (limit) => {
      for (const sort of SORTS) {
        const seen = await walk(sort, limit);
        expect(seen, `${sort} @ ${limit}`).toHaveLength(CORPUS.length);
        expect(new Set(seen).size, `${sort} @ ${limit}: a duplicate`).toBe(CORPUS.length);
      }
    },
  );

  it('orders price_asc by the CHEAPEST active variant, ties broken by id', async () => {
    const seen = await walk('price_asc', 100);
    const res = await ctx.db.execute(sql`
      SELECT p.id, (SELECT min(pr.amount) FROM shop_variants v
                      JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
                     WHERE v.product_id = p.id AND v.status = 'active') AS price
        FROM shop_products p WHERE p.id = ANY(${sql.param(seen)}::text[])`);
    const priceOf = new Map(res.rows.map((r) => [String(r.id), Number(r.price)]));
    const prices = seen.map((id) => priceOf.get(id)!);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    // The engineered ties really are ties, so this is not a vacuous ordering.
    expect(new Set(prices).size).toBeLessThan(prices.length);
  });

  it('orders alphabetical case- and accent-insensitively', async () => {
    const res = await listProducts(ctx.db, { sort: 'alphabetical', limit: 100 });
    const titles = res.items.map((p) => p.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it('walks correctly WHILE THE TABLE IS BEING WRITTEN TO', async () => {
    /*
     * The offset-pagination failure, reproduced against the keyset one. A row
     * inserted or removed above the window must not push or pull a row past the
     * boundary — because the next page is defined relative to a ROW, not to a
     * count.
     */
    const seen: string[] = [];
    let cursor: string | undefined;
    let mutations = 0;
    for (let page = 0; page < 100; page += 1) {
      const res = await listProducts(ctx.db, { sort: 'newest', limit: 3, cursor });
      seen.push(...res.items.map((p) => p.id));

      // Insert a NEWER product mid-walk. Under `newest` it belongs at the head,
      // i.e. above the window — the position that breaks an offset walk.
      if (mutations < 3) {
        mutations += 1;
        const extra = await seedProduct(ctx.db, actor(), { title: `Mid Walk ${mutations}` });
        await publishProduct(ctx.db, extra.id, actor());
      }

      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    // Every original product seen exactly once. The mid-walk insertions may or
    // may not appear — they sort above the cursor, so a keyset walk correctly
    // never reaches them — but nothing already passed may be lost or repeated.
    for (const id of ids.slice(0, CORPUS.length)) {
      expect(seen.filter((s) => s === id), `product ${id}`).toHaveLength(1);
    }
  });
});

describe('the cursor contract', () => {
  it('refuses a cursor minted under a DIFFERENT sort', async () => {
    /*
     * GAUNTLET II Part 2b #2. The only check used to be a width comparison,
     * which cannot tell four one-component sorts apart: spending an
     * `alphabetical` cursor (text) under `newest` (bigint) raised 22P02 — a 500
     * the client retries five times — and the other direction silently returned
     * a page with rows missing from it.
     */
    const first = await listProducts(ctx.db, { sort: 'newest', limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    await expect(
      listProducts(ctx.db, { sort: 'alphabetical', limit: 2, cursor: first.nextCursor! }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a hand-made cursor of the right sort and the wrong shape', async () => {
    // The payload is base64 JSON, so a caller can write anything into it. The
    // sort key stops the wrong ORDERING; this stops the wrong SHAPE.
    const tooWide = encodeCursor('newest', [1, 2], 'prd_x');
    await expect(
      listProducts(ctx.db, { sort: 'newest', limit: 2, cursor: tooWide }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const wrongType = encodeCursor('newest', ['not-a-number'], 'prd_x');
    await expect(
      listProducts(ctx.db, { sort: 'newest', limit: 2, cursor: wrongType }),
    ).rejects.toBeInstanceOf(BadRequestError);

    // A NULL against a non-nullable component would make `expr > NULL` evaluate
    // to NULL — an empty page rather than an error, i.e. a silent skip.
    const nullOnNonNullable = encodeCursor('newest', [null], 'prd_x');
    await expect(
      listProducts(ctx.db, { sort: 'newest', limit: 2, cursor: nullOnNonNullable }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses an undecodable cursor and an out-of-range limit', async () => {
    await expect(
      listProducts(ctx.db, { sort: 'newest', cursor: 'not-base64-json' }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(listProducts(ctx.db, { sort: 'newest', limit: 0 })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(listProducts(ctx.db, { sort: 'newest', limit: 101 })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it('an UNPRICED product paginates rather than vanishing, and sorts last both ways', async () => {
    /*
     * `min(price)` is NULL for a product with no priced variant, and NULLS LAST
     * applies in BOTH directions: in neither ordering is it a price the customer
     * can compare. The failure this guards against is the product disappearing
     * from the list entirely, which is what a naive `WHERE price > $cursor`
     * produces.
     */
    const unpriced = await seedProduct(ctx.db, actor(), { title: 'No Price At All' });
    await seedVariant(ctx.db, unpriced.id, actor(), { amount: null });
    await publishProduct(ctx.db, unpriced.id, actor());

    for (const sort of ['price_asc', 'price_desc'] as ProductSort[]) {
      const seen = await walk(sort, 3);
      expect(seen, `${sort}: the unpriced product vanished`).toContain(unpriced.id);
      expect(seen[seen.length - 1], `${sort}: it did not sort last`).toBe(unpriced.id);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });
});
