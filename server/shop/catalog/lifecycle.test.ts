import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import type { Db } from '../../db/client';
import { ProductPreconditionFailedError, StaleProductWriteError } from './errors';
import {
  archiveProduct,
  getProduct,
  publishProduct,
  restoreProduct,
  saveProduct,
  trashProduct,
  unarchiveProduct,
  unpublishProduct,
} from './products';
import {
  alwaysMoving,
  countRevisions,
  eventsFor,
  generationOf,
  mutating,
  rawProduct,
  rejection,
  seedProduct,
  seedVariant,
} from './test/catalog-harness';
import type { Product } from './types';
import { SHOP_CURRENCY } from '../currency';

let ctx: TestCtx;
const actor = () => ctx.users.owner;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

describe('the transitions', () => {
  it('publish sets status, publishedAt, clears the trash and writes a status revision', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Publish Me' });
    const published = await publishProduct(ctx.db, product.id, actor());

    expect(published).toMatchObject({ status: 'active', revision: product.revision + 1 });
    expect(published.publishedAt).not.toBeNull();
    expect(await countRevisions(ctx.db, product.id)).toBe(2);

    const res = await ctx.db.execute(sql`
      SELECT kind, note, status FROM shop_product_revisions
       WHERE product_id = ${product.id} ORDER BY revision DESC LIMIT 1`);
    expect(res.rows[0]).toMatchObject({ kind: 'status', note: 'Published', status: 'active' });
  });

  it('publish preserves the ORIGINAL publishedAt on a re-publish', async () => {
    // The date a product first went on sale. A seasonal withdrawal and return is
    // not a new product.
    const product = await seedProduct(ctx.db, actor(), { title: 'Seasonal' });
    const first = await publishProduct(ctx.db, product.id, actor());
    await unpublishProduct(ctx.db, product.id, actor());
    const again = await publishProduct(ctx.db, product.id, actor());
    expect(again.publishedAt).toBe(first.publishedAt);
  });

  it('publish also untrashes, on purpose', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Trashed Then Published' });
    await trashProduct(ctx.db, product.id, actor());
    const published = await publishProduct(ctx.db, product.id, actor());
    // "Publish this" cannot sensibly mean "publish it and leave it in the bin".
    expect(published).toMatchObject({ status: 'active', deletedAt: null });
  });

  it('unarchive goes to DRAFT, not straight back on sale', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Archived' });
    await publishProduct(ctx.db, product.id, actor());
    await archiveProduct(ctx.db, product.id, actor());
    const restored = await unarchiveProduct(ctx.db, product.id, actor());
    // Coming out of the archive is a decision to work on it, not to sell it —
    // going straight to active would re-list at whatever price it carried when
    // it was withdrawn.
    expect(restored.status).toBe('draft');
  });
});

describe('preconditions', () => {
  /**
   * A lifecycle op whose precondition is already false is REFUSED, and refused
   * BY THE DATABASE: the product is already in the state being asked for, so
   * applying it again would bump the revision, write a duplicate history entry
   * and — for trash — overwrite the timestamp of whoever actually put it there.
   *
   * `ProductPreconditionFailedError`, not a stale write. Nothing is stale here;
   * the request is simply refused. Collapsed into one, the refusal arrives with
   * `expected === actual`, which no conflict banner can render.
   */
  const cases: [string, (db: Db, p: Product) => Promise<unknown>, string, string][] = [
    ['publish an already active product', (db, p) => publishProduct(db, p.id, actor()), 'publish', 'active'],
    ['unpublish a draft', (db, p) => unpublishProduct(db, p.id, actor()), 'unpublish', 'draft'],
    ['archive an archived product', (db, p) => archiveProduct(db, p.id, actor()), 'archive', 'archived'],
    ['unarchive a draft', (db, p) => unarchiveProduct(db, p.id, actor()), 'unarchive', 'draft'],
  ];

  it.each(cases)('refuses to %s, changing nothing', async (_name, run, op, status) => {
    const product = await seedProduct(ctx.db, actor(), { title: `Precondition ${op}` });
    await ctx.db.execute(
      sql`UPDATE shop_products SET status = ${status} WHERE id = ${product.id}`,
    );
    const before = await rawProduct(ctx.db, product.id);

    const err = await rejection<ProductPreconditionFailedError>(
      run(ctx.db, product) as Promise<unknown>,
    );

    expect(err).toBeInstanceOf(ProductPreconditionFailedError);
    expect(err.operation).toBe(op);
    expect(err.product.id).toBe(product.id);
    expect(await rawProduct(ctx.db, product.id)).toEqual(before);
    expect(await countRevisions(ctx.db, product.id)).toBe(1);
  });

  it('refuses to trash a product already in the trash, and to restore one that is not', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Trash Precondition' });
    await expect(restoreProduct(ctx.db, product.id, actor())).rejects.toBeInstanceOf(
      ProductPreconditionFailedError,
    );
    await trashProduct(ctx.db, product.id, actor());
    const deletedAt = (await getProduct(ctx.db, product.id))?.deletedAt;
    await expect(trashProduct(ctx.db, product.id, actor())).rejects.toBeInstanceOf(
      ProductPreconditionFailedError,
    );
    // The clock a retention sweep reads before destroying a product was NOT
    // overwritten by the refused second trash.
    expect((await getProduct(ctx.db, product.id))?.deletedAt).toBe(deletedAt);
  });

  it('THE GUARD IS LOAD-BEARING: neutralised, an already-trashed product is re-trashed', async () => {
    /*
     * THE MUTATION TEST GAUNTLET II Part 2b's finding demanded.
     * `deleted_at IS NULL` in the CAS predicate replaced by `true`, nothing else
     * changed. Against the real predicate the second trash is refused; against
     * the mutant it succeeds and overwrites the timestamp.
     *
     * If this ever starts passing BY THROWING, the precondition has drifted back
     * into TypeScript — judged on a row that has already been read, which is
     * exactly the check the CAS exists because it cannot trust.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Mutant Trash' });
    await trashProduct(ctx.db, product.id, actor());
    const original = (await getProduct(ctx.db, product.id))?.deletedAt;

    const mutant = mutating(ctx.db, /deleted_at IS NULL/i, 'true');
    const retrashed = await trashProduct(mutant, product.id, actor());

    expect(retrashed.deletedAt).not.toBe(original);
    expect(await countRevisions(ctx.db, product.id)).toBe(3);
  });

  it('THE STATUS GUARD IS LOAD-BEARING: neutralised, an active product is re-published', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Mutant Publish' });
    await publishProduct(ctx.db, product.id, actor());
    const revisions = await countRevisions(ctx.db, product.id);

    const mutant = mutating(ctx.db, /status <> 'active'/i, 'true');
    await publishProduct(mutant, product.id, actor());

    expect(await countRevisions(ctx.db, product.id)).toBe(revisions + 1);
    // And the real predicate refuses it.
    await expect(publishProduct(ctx.db, product.id, actor())).rejects.toBeInstanceOf(
      ProductPreconditionFailedError,
    );
  });
});

describe('the lifecycle generation pin — GAUNTLET II Part 2b finding #1', () => {
  it('a CONTENT save does not move the generation, so a publish still wins', async () => {
    /*
     * The half that must NOT 409. `saveProduct`'s SET list omits `status`,
     * `published_at` and `deleted_at`, so the trigger leaves the generation
     * alone — and a publish that merely raced an ordinary edit re-derives from
     * the newer text rather than refusing at a human.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Content Race' });
    const before = await generationOf(ctx.db, product.id);
    await saveProduct(ctx.db, product.id, { title: 'Edited' }, { actor: actor() });
    expect(await generationOf(ctx.db, product.id)).toBe(before);

    const published = await publishProduct(ctx.db, product.id, actor());
    expect(published.status).toBe('active');
    expect(published.title).toBe('Edited');
  });

  it('A→B→A: the pin refuses a retry that would re-apply a lost intent', async () => {
    /*
     * THE DEFECT THE COLUMN EXISTS FOR, reproduced in Catalog's own tree.
     *
     * A `trash` reads the row, loses its CAS, and retries. Between the read and
     * the retry, somebody deliberately trashes and then RESTORES the product.
     * The precondition `deleted_at IS NULL` is TRUE again, so a predicate over
     * current state alone accepts the retry and the product goes back in the bin
     * somebody had just taken it out of. On `posts` that was measured through to
     * the end: `emptyTrash` then hard-deleted it and CASCADE took every revision.
     *
     * `alwaysMoving` makes every CAS lose, so the retry loop runs to exhaustion
     * — and the A→B→A below moves the generation twice, so the pin can never
     * match again and the caller is told, rather than silently winning.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'A to B to A' });
    const pinned = await generationOf(ctx.db, product.id);

    // Somebody else's deliberate trash-then-restore. Two lifecycle changes, so
    // the generation moves twice while the STATE returns to where it started.
    await trashProduct(ctx.db, product.id, actor());
    await restoreProduct(ctx.db, product.id, actor());
    expect(await generationOf(ctx.db, product.id)).toBe(pinned + 2);
    expect((await getProduct(ctx.db, product.id))?.deletedAt).toBeNull();

    // A trash whose CAS keeps losing must NOT eventually win against a
    // generation that has moved.
    const moving = alwaysMoving(ctx.db, product.id);
    const err = await rejection<StaleProductWriteError>(
      trashProduct(moving, product.id, actor()),
    );
    expect(err).toBeInstanceOf(StaleProductWriteError);
    expect(
      (await getProduct(ctx.db, product.id))?.deletedAt,
      'the retry re-applied a trash that a human had deliberately undone',
    ).toBeNull();
  });

  it('THE PIN IS LOAD-BEARING: neutralised, the A→B→A retry wins and re-trashes', async () => {
    /*
     * The mutation that proves the pin is what refuses it. `lifecycle_generation
     * = $n` replaced by `true`; everything else, including the `deleted_at IS
     * NULL` precondition, is untouched — and that is the point: the precondition
     * is TRUE after the restore, so it cannot be what saves the product.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Mutant Pin' });
    await trashProduct(ctx.db, product.id, actor());
    await restoreProduct(ctx.db, product.id, actor());

    const mutant = mutating(ctx.db, /lifecycle_generation = \$\d+/, 'true');
    const trashed = await trashProduct(mutant, product.id, actor());

    expect(
      trashed.deletedAt,
      'without the pin, a retry re-applies an intent a human undid',
    ).not.toBeNull();
  });

  it('gives up after three lost races rather than hanging', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Never Settles' });
    const moving = alwaysMoving(ctx.db, product.id);
    const err = await rejection<StaleProductWriteError>(
      publishProduct(moving, product.id, actor()),
    );
    expect(err).toBeInstanceOf(StaleProductWriteError);
    /*
     * `expected` is the revision the FIRST read derived from, not the last one
     * tried — that is the version the caller's request was actually about, and
     * it is what makes `expected !== actual` true here and only here. It is not
     * `product.revision`: `alwaysMoving` bumps the row before every statement
     * INCLUDING the first read, which is exactly what makes every CAS lose.
     */
    expect(err.actual).toBeGreaterThan(err.expected);
    expect(err.expected).toBeGreaterThanOrEqual(product.revision);
  });
});

describe('the outbox — contract §6 rule 1', () => {
  it('publish emits one catalog.variant.published PER SELLABLE VARIANT, with the price', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Two Variants' });
    const a = await seedVariant(ctx.db, product.id, actor(), { amount: 1999 });
    const b = await seedVariant(ctx.db, product.id, actor(), { amount: 2499 });

    await publishProduct(ctx.db, product.id, actor());

    const eventsA = await eventsFor(ctx.db, a.id);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].type).toBe('catalog.variant.published');
    expect(eventsA[0].payload).toMatchObject({
      variantId: a.id,
      productId: product.id,
      sku: a.sku,
      // The price rides along rather than being looked up: a consumer that had
      // to call back would read whatever is true NOW, which differs from what
      // was true when the event was written exactly when it matters.
      price: { amount: 1999, currency: SHOP_CURRENCY },
    });
    expect((await eventsFor(ctx.db, b.id))[0].payload).toMatchObject({
      price: { amount: 2499, currency: SHOP_CURRENCY },
    });
  });

  it('an unpriced variant is still announced, carrying price: null', async () => {
    // Dropping it would make the event stream disagree with the catalogue about
    // which variants exist — and a consumer that never heard of a variant cannot
    // later be told it was unpublished.
    const product = await seedProduct(ctx.db, actor(), { title: 'Unpriced' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { amount: null });
    await publishProduct(ctx.db, product.id, actor());

    const events = await eventsFor(ctx.db, variant.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.price).toBeNull();
  });

  it('a discontinued variant is announced by NEITHER publish nor unpublish', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Discontinued' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { amount: 1000 });
    await ctx.db.execute(
      sql`UPDATE shop_variants SET status = 'discontinued' WHERE id = ${variant.id}`,
    );

    await publishProduct(ctx.db, product.id, actor());
    await unpublishProduct(ctx.db, product.id, actor());
    expect(await eventsFor(ctx.db, variant.id)).toEqual([]);
  });

  it('unpublish, archive and trash each emit an unpublished event with their reason', async () => {
    const cases: [string, (db: Db, id: string) => Promise<unknown>, string][] = [
      ['unpublish', (db, id) => unpublishProduct(db, id, actor()), 'unpublished'],
      ['archive', (db, id) => archiveProduct(db, id, actor()), 'archived'],
      ['trash', (db, id) => trashProduct(db, id, actor()), 'deleted'],
    ];
    for (const [name, run, reason] of cases) {
      const product = await seedProduct(ctx.db, actor(), { title: `Reason ${name}` });
      const variant = await seedVariant(ctx.db, product.id, actor(), { amount: 500 });
      await publishProduct(ctx.db, product.id, actor());
      await run(ctx.db, product.id);

      const events = await eventsFor(ctx.db, variant.id);
      expect(events.map((e) => e.type)).toEqual([
        'catalog.variant.published',
        'catalog.variant.unpublished',
      ]);
      expect(events[1].payload).toMatchObject({ variantId: variant.id, reason });
    }
  });

  it('A REFUSED TRANSITION EMITS NOTHING — the event cannot outlive its cause', async () => {
    /*
     * Contract §6 rule 1, from the other side. The event is a data-modifying CTE
     * that SELECTs FROM the update, so a CAS matching nothing has no rows to
     * insert from — the event and the state change are the same statement and
     * neither can exist without the other.
     */
    const product = await seedProduct(ctx.db, actor(), { title: 'Refused' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { amount: 500 });
    await publishProduct(ctx.db, product.id, actor());
    const after = await eventsFor(ctx.db, variant.id);

    // Publishing again is refused by the precondition.
    await expect(publishProduct(ctx.db, product.id, actor())).rejects.toBeInstanceOf(
      ProductPreconditionFailedError,
    );
    expect(await eventsFor(ctx.db, variant.id)).toEqual(after);
  });

  it('a lifecycle op that LOST ITS CAS emits nothing either', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Lost CAS' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { amount: 500 });
    const moving = alwaysMoving(ctx.db, product.id);

    await expect(publishProduct(moving, product.id, actor())).rejects.toBeInstanceOf(
      StaleProductWriteError,
    );
    expect(
      await eventsFor(ctx.db, variant.id),
      'an event was written for a publish that never happened',
    ).toEqual([]);
  });

  it('restore emits NOTHING, because a restored product is not necessarily on sale', async () => {
    const product = await seedProduct(ctx.db, actor(), { title: 'Restore Silent' });
    const variant = await seedVariant(ctx.db, product.id, actor(), { amount: 500 });
    await trashProduct(ctx.db, product.id, actor());
    const before = await eventsFor(ctx.db, variant.id);
    await restoreProduct(ctx.db, product.id, actor());
    // Emitting `published` here would tell every consumer to start quoting a
    // draft. A restore that should re-list goes through `publish`.
    expect(await eventsFor(ctx.db, variant.id)).toEqual(before);
  });
});
