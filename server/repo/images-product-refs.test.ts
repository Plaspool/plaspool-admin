/**
 * `shop_products` as a reference in the orphan collector's walk (HANDOFF §1.10,
 * §2 A5.1).
 *
 * WHAT WAS WRONG, AND WHY THIS SUITE IS SHAPED THE WAY IT IS.
 *
 * `REFERENCE_SET` walked `posts` and `revisions` and nothing else, while
 * `shop_products.cover_image_id` and `shop_products.image_ids` hold ids of rows
 * in the very same `images` table. An image uploaded for a product and placed in
 * no post was therefore "unreferenced" from the moment it was committed: the mark
 * pass stamped its clock, and 24 hours later the delete pass destroyed the row
 * and returned the storage key for an R2 delete that cannot be undone. Nothing
 * reported it — `{collected: n}` reads identically whether the n rows were
 * abandoned uploads or a shop's entire catalogue photography.
 *
 * SO A GREEN BAR IS NOT THE ASSERTION HERE. Adding the CTE and watching "the
 * image survives" pass proves nothing on its own: it also passes if the delete
 * pass is broken, if the image is too young, if the clock never started, or if
 * the corpus never put the image at risk. `withoutProductRefs()` below removes
 * exactly the union entry this task added and re-runs the SAME mark and sweep
 * through the SAME functions — and the image is collected. That pair is the
 * claim: the image was genuinely one pass away from deletion, and the new CTE is
 * the only thing standing between it and the bucket.
 *
 * The project's ledger is why: a round of this codebase was mutation-tested and
 * replacing every CAS guard with `true` broke none of 254 tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { createPost } from './posts';
import {
  ORPHAN_AGE_FLOOR_MS,
  QUARANTINE_MS,
  collectOrphans,
  committedImageIds,
  markUnreferenced,
  previewOrphans,
} from './images';
import type { Db } from '../db/client';
import type { AuthUser, DocNode } from '../../shared/types';

const HOUR = 60 * 60 * 1000;

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
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

/**
 * A product row written with raw SQL rather than through `createProduct`.
 *
 * `createProduct` now REFUSES an id that names no committed image, which is the
 * other half of this task — so building the corpus through it would make every
 * case here depend on the validator it is not testing, and would make the
 * "already-collected id" cases unwritable at all.
 */
interface SeedProduct {
  id: string;
  coverImageId?: string | null;
  imageIds?: string[];
  status?: 'draft' | 'active' | 'archived';
  deletedAt?: number | null;
}

async function seedProductRow(seed: SeedProduct): Promise<void> {
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO shop_products (id, slug, title, description, description_text, status,
                               category, tags, cover_image_id, image_ids,
                               created_at, updated_at, published_at, deleted_at,
                               author_id, revision)
    VALUES (${seed.id}, ${seed.id}, 'A Product', '{"type":"doc","content":[]}'::jsonb, '',
            ${seed.status ?? 'active'}, '', '{}'::text[],
            ${seed.coverImageId ?? null}, ${sql.param(seed.imageIds ?? [])},
            ${now}, ${now}, NULL, ${seed.deletedAt ?? null}, ${owner().id}::uuid, 1)`);
}

async function idsInStore(): Promise<string[]> {
  const res = await ctx.db.execute(sql`SELECT id FROM images ORDER BY id`);
  return res.rows.map((row) => String(row.id));
}

async function clockOf(id: string): Promise<number | null> {
  const res = await ctx.db.execute(
    sql`SELECT unreferenced_since FROM images WHERE id = ${id}`,
  );
  const value = res.rows[0]?.unreferenced_since;
  return value == null ? null : Number(value);
}

// ---------------------------------------------------------------- the mutant

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

/**
 * A handle that rewrites the SQL on its way to the driver.
 *
 * COPIED FROM `server/repo/lifecycle.test.ts` RATHER THAN IMPORTED, for the
 * reason `server/shop/catalog/test/catalog-harness.ts` gives about its own copy:
 * that one lives inside a test file and exports nothing. This copy takes
 * catalog-harness's fix with it — every rebuilt value goes back through
 * `sql.param`, because a bare `sql\`${value}\`` expands a JS ARRAY into a tuple
 * and the statements mutated here bind `text[]`.
 *
 * It REBUILDS rather than string-patches: `sqlToQuery` renders the statement with
 * `$n` placeholders, the substitution is applied to that text, and the
 * placeholders become bound parameters again — so nothing is inlined into SQL and
 * the mutant differs from the original in exactly one clause. Statements that do
 * not match pass through untouched.
 */
function mutating(db: Db, find: RegExp, replacement: string): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => {
        const built = (target as unknown as Dialecty).dialect.sqlToQuery(args[0]);
        if (!find.test(built.sql)) return execute.apply(target, args);
        const parts = built.sql.replace(find, replacement).split(/\$(\d+)/);
        const chunks = parts.map((part, i) =>
          i % 2 === 0 ? sql.raw(part) : sql`${sql.param(built.params[Number(part) - 1])}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
}

/**
 * The union entry this task added to `referenced`, as it renders.
 *
 * Removing THIS rather than gutting the `product_refs` CTE itself is deliberate:
 * it is precisely the line whose absence was the defect, so a mutant built this
 * way is the code as it shipped before the fix, not an invented weakening.
 */
const PRODUCT_UNION = /select id from product_refs where id is not null/i;

function withoutProductRefs(): Db {
  return mutating(ctx.db, PRODUCT_UNION, 'SELECT id FROM product_refs WHERE false');
}

// ------------------------------------------------------------- the mark pass

describe('markUnreferenced sees products', () => {
  it('leaves the clock unstamped for an image that is only a product COVER', async () => {
    await seedImage({ id: 'img_cover' });
    await seedProductRow({ id: 'prd_cover', coverImageId: 'img_cover' });

    const result = await markUnreferenced(ctx.db);

    expect(result).toMatchObject({ unreferenced: 0, cleared: 1, blocked: false });
    expect(await clockOf('img_cover')).toBeNull();
  });

  it('leaves the clock unstamped for an image that is only in the GALLERY', async () => {
    // The `unnest(image_ids)` half — a `text[]`, not a scalar column.
    await seedImage({ id: 'img_gallery' });
    await seedProductRow({
      id: 'prd_gallery',
      imageIds: ['img_other', 'img_gallery', 'img_third'],
    });

    await markUnreferenced(ctx.db);

    expect(await clockOf('img_gallery')).toBeNull();
  });

  it('normalises the asset:/idb: prefix on both columns', async () => {
    /*
     * The column is plain `text` and has never been normalised on write, so a
     * client may store either form — exactly the reason `cover_refs` reads the
     * post cover both ways. A walk that matched only the bare form would collect
     * every image any client had written with a scheme.
     */
    await seedImage({ id: 'img_prefixed_cover' });
    await seedImage({ id: 'img_prefixed_gallery' });
    await seedProductRow({
      id: 'prd_prefixed',
      coverImageId: 'asset:img_prefixed_cover',
      imageIds: ['idb:img_prefixed_gallery'],
    });

    await markUnreferenced(ctx.db);

    expect(await clockOf('img_prefixed_cover')).toBeNull();
    expect(await clockOf('img_prefixed_gallery')).toBeNull();
  });

  it('counts a DRAFT, an ARCHIVED and a TRASHED product as references', async () => {
    /*
     * Rule 4 applied to the shop. A trashed product is one `restoreProduct` can
     * bring back and a draft is one `publishProduct` can put on sale; collecting
     * their photographs while they wait yields a product page full of dangling
     * images, and byte deletion is the half of that pair that is irreversible.
     *
     * This is also the exact place the collector and
     * `server/repo/public-images.ts` point in OPPOSITE directions: the same three
     * products make an image KEEPABLE here and NOT SERVABLE there.
     */
    await seedImage({ id: 'img_draft' });
    await seedImage({ id: 'img_archived' });
    await seedImage({ id: 'img_trashed' });
    await seedProductRow({ id: 'prd_draft', status: 'draft', coverImageId: 'img_draft' });
    await seedProductRow({
      id: 'prd_archived',
      status: 'archived',
      coverImageId: 'img_archived',
    });
    await seedProductRow({
      id: 'prd_trashed',
      deletedAt: Date.now(),
      coverImageId: 'img_trashed',
    });

    const result = await markUnreferenced(ctx.db);

    expect(result.unreferenced).toBe(0);
    expect(await clockOf('img_draft')).toBeNull();
    expect(await clockOf('img_archived')).toBeNull();
    expect(await clockOf('img_trashed')).toBeNull();
  });

  it('still stamps an image no product and no post names', async () => {
    // The control. Without it every assertion above is satisfied by a mark pass
    // that has simply stopped stamping anything.
    await seedImage({ id: 'img_loose' });
    await seedProductRow({ id: 'prd_empty' });

    const result = await markUnreferenced(ctx.db);

    expect(result.unreferenced).toBe(1);
    expect(await clockOf('img_loose')).not.toBeNull();
  });

  it('clears a clock a previous pass started, once a product picks the image up', async () => {
    /*
     * The clearing half of rule 2, through the new CTE. An image committed on
     * Monday and attached to a product on Wednesday arrives at this pass already
     * carrying a two-day-old clock — and if the pass does not clear it, the very
     * next delete pass takes it, because the quarantine window elapsed while
     * nothing was pointing at it.
     */
    await seedImage({ id: 'img_adopted', unreferencedForMs: 48 * HOUR });
    await seedProductRow({ id: 'prd_adopting', coverImageId: 'img_adopted' });

    const result = await markUnreferenced(ctx.db);

    expect(result.changed).toBe(1);
    expect(await clockOf('img_adopted')).toBeNull();
  });
});

// ----------------------------------------------------- the full mark + sweep

describe('a product-only image survives a full mark and sweep', () => {
  /**
   * An image old enough and quarantined long enough that ONLY the reference set
   * can save it: both age predicates in `doomed` are already satisfied.
   */
  async function seedDoomedButReferenced(): Promise<void> {
    await seedImage({
      id: 'img_at_risk',
      ageMs: ORPHAN_AGE_FLOOR_MS + HOUR,
      unreferencedForMs: QUARANTINE_MS + HOUR,
    });
    await seedProductRow({
      id: 'prd_at_risk',
      coverImageId: 'img_at_risk',
      imageIds: ['img_at_risk'],
    });
  }

  it('marks it referenced, previews nothing, and collects nothing', async () => {
    await seedDoomedButReferenced();

    const marked = await markUnreferenced(ctx.db);
    expect(marked.cleared).toBe(1);

    const preview = await previewOrphans(ctx.db);
    expect(preview.collected).toEqual([]);
    expect(preview.unreferenced).toBe(0);

    const collected = await collectOrphans(ctx.db);
    expect(collected.collected).toEqual([]);
    expect(await idsInStore()).toEqual(['img_at_risk']);
  });

  it('IS collected once the product union is removed — the fix is what saves it', async () => {
    /*
     * The same corpus, the same two functions, one line of SQL different. This is
     * the assertion the suite exists for: it proves the image was one pass from
     * the bucket and that `product_refs` is the only thing that stopped it.
     */
    await seedDoomedButReferenced();
    const db = withoutProductRefs();

    const marked = await markUnreferenced(db);
    expect(marked.unreferenced).toBe(1);
    // The clock was already old, so the pass writes nothing — it simply agrees
    // with what the row already said, which is what keeps the quarantine running
    // across passes.
    expect(await clockOf('img_at_risk')).not.toBeNull();

    const collected = await collectOrphans(db);
    expect(collected.collected.map((c) => c.id)).toEqual(['img_at_risk']);
    expect(await idsInStore()).toEqual([]);
  });

  it('the product is what saves it, not the post walk', async () => {
    /*
     * A second control on the mutant. If some unrelated post in the corpus were
     * quietly referencing `img_at_risk`, the test above would pass for the wrong
     * reason — so this asserts the ONLY thing in the store besides the image is a
     * post that names something else entirely.
     */
    await seedDoomedButReferenced();
    const unrelated: DocNode = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_somewhere_else' } }],
    } as DocNode;
    await createPost(ctx.db, owner(), { title: 'Unrelated', content: unrelated });

    await markUnreferenced(withoutProductRefs());
    const collected = await collectOrphans(withoutProductRefs());
    expect(collected.collected.map((c) => c.id)).toEqual(['img_at_risk']);
  });
});

// --------------------------------------------------------- committedImageIds

describe('committedImageIds', () => {
  it('returns only ids that name a COMMITTED image', async () => {
    await seedImage({ id: 'img_committed' });
    await ctx.db.execute(sql`
      INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                          byte_size, checksum, created_at, committed_at,
                          unreferenced_since)
      VALUES ('img_open', ${owner().id}::uuid, 'images/open', 'image/png', NULL, NULL,
              10, NULL, ${Date.now()}, NULL, NULL)`);

    const known = await committedImageIds(ctx.db, [
      'img_committed',
      'img_open',
      'img_absent',
    ]);

    expect([...known].sort()).toEqual(['img_committed']);
  });

  it('normalises the scheme prefix and ignores empty ids', async () => {
    await seedImage({ id: 'img_scheme' });
    const known = await committedImageIds(ctx.db, ['asset:img_scheme', 'idb:img_scheme', '']);
    // Both forms answer the same row, and the empty string names nothing at all
    // rather than becoming an `id = ''` the driver has to bind.
    expect([...known]).toEqual(['img_scheme']);
  });

  it('is an empty set — and issues no statement — for an empty list', async () => {
    /*
     * `id = ANY('{}')` is a perfectly good statement that matches nothing, so the
     * short circuit is about the round trip rather than the answer: the create
     * path calls this on every product write and the overwhelming majority carry
     * no images at all.
     */
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM images`);
    expect(await committedImageIds(ctx.db, [])).toEqual(new Set());
    expect(await committedImageIds(ctx.db, ['', ''])).toEqual(new Set());
    expect(before.rows[0].n).toBe(0);
  });

  it('is not owner-scoped: a writer may name an image the owner uploaded', async () => {
    // Reads are universal in this deployment (`getImage` documents why). Scoping
    // this would make a product built from a colleague's photograph unsavable
    // with no way to explain the refusal.
    await seedImage({ id: 'img_owners' });
    expect(await committedImageIds(ctx.db, ['img_owners'])).toEqual(new Set(['img_owners']));
  });
});
