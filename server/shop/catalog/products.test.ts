import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { InvalidDocumentError, NotFoundError } from '../../repo/errors';
import { StaleProductWriteError } from './errors';
import {
  createProduct,
  getActiveProductBySlug,
  getProduct,
  publishProduct,
  saveProduct,
} from './products';
import {
  alwaysMoving,
  countRevisions,
  mutating,
  rejection,
  revisionNumbers,
  seedProduct,
} from './test/catalog-harness';
import type { DocNode } from '../../../shared/types';

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('createProduct', () => {
  it('writes the product and its first revision in one statement', async () => {
    const product = await createProduct(ctx.db, actor(), {
      title: 'Navy Tee',
      description: doc('A good tee.'),
      category: 'apparel',
      tags: ['tee', 'navy'],
    });

    expect(product).toMatchObject({
      title: 'Navy Tee',
      slug: 'navy-tee',
      status: 'draft',
      category: 'apparel',
      tags: ['tee', 'navy'],
      revision: 1,
      publishedAt: null,
      deletedAt: null,
    });
    expect(await revisionNumbers(ctx.db, product.id)).toEqual([1]);
  });

  it('derives description_text on write, and never ships it', async () => {
    const product = await createProduct(ctx.db, actor(), {
      title: 'Derived',
      description: doc('the searchable words'),
    });
    const res = await ctx.db.execute(
      sql`SELECT description_text FROM shop_products WHERE id = ${product.id}`,
    );
    expect(String(res.rows[0].description_text)).toContain('the searchable words');
    // A storage detail, exactly as `posts.content_text` is.
    expect(product).not.toHaveProperty('descriptionText');
  });

  it('holds NULL rather than an empty slug for an untitled product', async () => {
    /*
     * `slug` is UNIQUE. Postgres permits many NULLs but exactly ONE empty
     * string, so if `''` were stored the SECOND untitled draft would fail with a
     * raw 23505 nobody expects — the identical hazard `normaliseSlug` handles
     * for posts.
     */
    const a = await createProduct(ctx.db, actor(), {});
    const b = await createProduct(ctx.db, actor(), {});
    expect(a.slug).toBeNull();
    expect(b.slug).toBeNull();
  });

  it('SLUGIFIES A SUPPLIED SLUG rather than storing it verbatim', async () => {
    /*
     * GAUNTLET II Part 2a found `createPost` storing `../../admin` straight into
     * the column that becomes a URL path. A slug that ARRIVES is held to the
     * same charset as one that is DERIVED.
     */
    const product = await createProduct(ctx.db, actor(), {
      title: 'Path Traversal',
      slug: '../../admin',
    });
    expect(product.slug).toBe('admin');
    expect(product.slug).not.toContain('/');
    expect(product.slug).not.toContain('.');
  });

  it('refuses an invalid description as a 422 and writes nothing', async () => {
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_products`);
    await expect(
      createProduct(ctx.db, actor(), {
        title: 'Bad',
        description: { type: 'doc', content: [{ type: 'iframe' }] } as unknown as DocNode,
      }),
    ).rejects.toBeInstanceOf(InvalidDocumentError);
    const after = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_products`);
    expect(after.rows[0].n).toEqual(before.rows[0].n);
  });

  it('refuses oversized metadata as a 422, naming the field', async () => {
    const err = await rejection<InvalidDocumentError>(
      createProduct(ctx.db, actor(), { title: 'x'.repeat(3000) }),
    );
    expect(err).toBeInstanceOf(InvalidDocumentError);
    expect(err.path).toBe('title');
  });
});

describe('saveProduct — the CAS write path', () => {
  it('bumps the revision and writes exactly one revision row', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'CAS Base' });
    const saved = await saveProduct(
      ctx.db,
      product.id,
      { title: 'CAS Changed' },
      { actor: actor(), baseRevision: product.revision },
    );

    expect(saved.revision).toBe(product.revision + 1);
    expect(saved.title).toBe('CAS Changed');
    expect(await revisionNumbers(ctx.db, product.id)).toEqual([1, 2]);
  });

  it('refuses a stale baseRevision and carries the CURRENT PRODUCT with it', async () => {
    /*
     * Brief §4: the loss raises an error carrying `expected`, `actual`, "and the
     * full current product from a single re-read, so a client's 'load theirs'
     * needs no second request".
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Conflict' });
    await saveProduct(ctx.db, product.id, { title: 'Theirs' }, { actor: actor() });

    const err = await rejection<StaleProductWriteError>(
      saveProduct(
        ctx.db,
        product.id,
        { title: 'Mine' },
        { actor: actor(), baseRevision: product.revision },
      ),
    );

    expect(err).toBeInstanceOf(StaleProductWriteError);
    expect(err.expected).toBe(product.revision);
    expect(err.actual).toBe(product.revision + 1);
    expect(err.product?.title).toBe('Theirs');
  });

  it('THE CAS PREDICATE IS LOAD-BEARING: neutralised, a stale write wins', async () => {
    /*
     * THE MUTATION TEST. `revision = $base` in the CAS predicate replaced by
     * `true`, and nothing else changed.
     *
     * REACHING THE CAS AT ALL IS THE HARD PART, and getting it wrong is how a
     * mutation test passes for the wrong reason. `saveProduct` refuses an
     * explicitly stale `baseRevision` in JavaScript before the statement runs,
     * so a stale number never gets near the predicate; and a base that MATCHES
     * the read succeeds under mutant and original alike, which proves nothing.
     * The first version of this test did exactly that and was green against a
     * mutation that never applied.
     *
     * `alwaysMoving` is what closes it: it bumps the revision before every
     * statement, so the base is fresh when read and stale when the CAS runs —
     * the real race, not a simulation of it. Under the real predicate every
     * attempt loses; under the mutant every attempt wins.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Mutant CAS' });

    // The real predicate refuses a write whose base moved under it.
    await expect(
      saveProduct(alwaysMoving(ctx.db, product.id), product.id, { title: 'Real' }, {
        actor: actor(),
      }),
    ).rejects.toBeInstanceOf(StaleProductWriteError);
    expect((await getProduct(ctx.db, product.id))?.title).toBe('Mutant CAS');

    // Neutralised, the identical call overwrites the concurrent writer.
    const mutant = mutating(alwaysMoving(ctx.db, product.id), /revision = \$\d+/, 'true');
    const saved = await saveProduct(mutant, product.id, { title: 'Mine' }, { actor: actor() });
    expect(saved.title).toBe('Mine');
    expect((await getProduct(ctx.db, product.id))?.title).toBe('Mine');
  });

  it('a losing CAS writes NOTHING — no revision bump, no revision row', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Loser' });
    await saveProduct(ctx.db, product.id, { title: 'Winner' }, { actor: actor() });
    const revisionsBefore = await countRevisions(ctx.db, product.id);

    await expect(
      saveProduct(
        ctx.db,
        product.id,
        { title: 'Loser Again' },
        { actor: actor(), baseRevision: product.revision },
      ),
    ).rejects.toBeInstanceOf(StaleProductWriteError);

    const stored = await getProduct(ctx.db, product.id);
    expect(stored?.title).toBe('Winner');
    expect(await countRevisions(ctx.db, product.id)).toBe(revisionsBefore);
  });

  it('validates the PATCH, never the merge', async () => {
    /*
     * A product whose stored description is already invalid must stay editable.
     * Validating the merge instead would make one pre-existing violation — from
     * an import, or from a later tightening of these rules — permanently
     * unsavable, and every edit from then on is lost. GAUNTLET II Part 2a Round
     * 1 #1 in its general form.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Legacy' });
    await ctx.db.execute(sql`
      UPDATE shop_products
         SET description = '{"type":"doc","content":[{"type":"iframe"}]}'::jsonb
       WHERE id = ${product.id}`);

    const saved = await saveProduct(ctx.db, product.id, { title: 'Still Editable' }, {
      actor: actor(),
    });
    expect(saved.title).toBe('Still Editable');
  });

  it('assigns a slug on the first titled save and never rewrites it', async () => {
    const product = await createProduct(ctx.db, actor(), {});
    expect(product.slug).toBeNull();

    const titled = await saveProduct(ctx.db, product.id, { title: 'First Name' }, {
      actor: actor(),
    });
    expect(titled.slug).toBe('first-name');

    // A published URL is a promise, not a value that follows the heading around.
    const renamed = await saveProduct(ctx.db, product.id, { title: 'Second Name' }, {
      actor: actor(),
    });
    expect(renamed.slug).toBe('first-name');
  });

  it('404s for a product that does not exist', async () => {
    await expect(
      saveProduct(ctx.db, 'prd_nope', { title: 'x' }, { actor: actor() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('concurrency', () => {
  it('50 overlapping saves from one base: exactly one wins, one revision row added', async () => {
    /*
     * WHAT THIS PROVES AND WHAT IT DOES NOT. PGlite is single-threaded WASM
     * Postgres with one connection and a FIFO statement queue, so these execute
     * deterministically as 50 reads followed by 50 CAS attempts. That genuinely
     * proves the CAS DECISION LOGIC — one winner, 49 losers, no spurious
     * revision rows — and it can never be flaky. It does NOT exercise row-lock
     * blocking or READ COMMITTED EvalPlanQual recheck, which is what real
     * Postgres does under true parallelism; there the backstop is
     * `UNIQUE (product_id, revision)`, enforced at any degree of parallelism.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Race' });
    const before = await countRevisions(ctx.db, product.id);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        saveProduct(
          ctx.db,
          product.id,
          { title: `writer ${i}` },
          { actor: actor(), baseRevision: product.revision },
        ),
      ),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);
    for (const r of lost) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StaleProductWriteError);
    }

    expect(await countRevisions(ctx.db, product.id)).toBe(before + 1);
    expect((await getProduct(ctx.db, product.id))?.revision).toBe(product.revision + 1);
  });

  it('50 sequential saves produce 50 revisions with NO duplicate or skipped number', async () => {
    /*
     * The other half of brief §8's revision-integrity requirement. The
     * overlapping test proves the loser writes nothing; this proves the winner's
     * numbering is a dense, gapless sequence — which is what makes
     * `UNIQUE (product_id, revision)` a real backstop rather than a constraint
     * that happens never to fire.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Sequence' });
    for (let i = 0; i < 49; i += 1) {
      await saveProduct(ctx.db, product.id, { title: `v${i}` }, { actor: actor() });
    }
    const numbers = await revisionNumbers(ctx.db, product.id);
    expect(numbers).toHaveLength(50);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(50);
  });

  it('N concurrent products sharing one title all get a distinct slug', async () => {
    /*
     * GAUNTLET II Part 2a Round 1 #2, ported. Every in-flight writer reads the
     * same taken set and picks the same next candidate, so a retry that only
     * re-derives admits one writer per round: measured on posts, N=10 left seven
     * with a raw 23505 that a route renders as a 500. The ladder in
     * `catalog/slug.ts` diversifies at attempt 2 and ends in a random suffix.
     */
    const n = 25;
    const settled = await Promise.allSettled(
      Array.from({ length: n }, () =>
        createProduct(ctx.db, actor(), { title: 'Shared Product Title' }),
      ),
    );

    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => String((r as PromiseRejectedResult).reason)),
      'a unique_violation from a concurrent insert is retried, never surfaced',
    ).toEqual([]);

    const slugs = settled.map((r) => (r as PromiseFulfilledResult<{ slug: string | null }>).value.slug);
    expect(new Set(slugs).size).toBe(n);
    for (const slug of slugs) expect(slug).toMatch(/^shared-product-title(-|$)/);
  });
});

describe('getActiveProductBySlug — the storefront read', () => {
  it('sees an active product and hides a draft, an archived one and the trash', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Storefront Visibility' });
    // A draft is invisible even though it has a slug.
    expect(await getActiveProductBySlug(ctx.db, product.slug!)).toBeNull();

    await publishProduct(ctx.db, product.id, actor());
    expect((await getActiveProductBySlug(ctx.db, product.slug!))?.id).toBe(product.id);

    await ctx.db.execute(
      sql`UPDATE shop_products SET deleted_at = ${Date.now()} WHERE id = ${product.id}`,
    );
    expect(
      await getActiveProductBySlug(ctx.db, product.slug!),
      'a trashed product is still `active` by status — the trash is a separate axis',
    ).toBeNull();
  });
});
