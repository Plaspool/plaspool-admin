import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { DbError, uniqueViolation } from '../../db/client';
import { InvalidDocumentError, NotFoundError } from '../../repo/errors';
import { ProductPreconditionFailedError, StaleProductWriteError } from './errors';
import { docToText, slugify } from '../../../shared/doc';
import { checkPostMeta, validateDoc } from '../../../shared/validate';
import type { AuthUser, DocNode } from '../../../shared/types';
import { SLUG_ATTEMPTS, uniqueProductSlug } from './slug';
import { emitEvent, jsonbObject } from './events';
import {
  PRODUCT_COLUMNS,
  newCatalogId,
  productColumns,
  rowToProduct,
} from './mapping';
import type { Product, ProductPatch } from './types';

/**
 * The product write path — CAS, lifecycle, and the outbox, all in one statement
 * each.
 *
 * ONE STATEMENT PER MUTATION, AND NEVER `db.transaction`. The Neon HTTP driver
 * throws unconditionally on `transaction()` while PGlite supports it, so a
 * transaction here would pass every test in this repository and 500 in
 * production — the divergence spec §9 exists to eliminate, documented at length
 * in `server/repo/posts.ts`. Atomicity comes from the statement instead: the
 * revision insert and the outbox insert both SELECT FROM the update, so a CAS
 * that matches nothing structurally writes nothing at all. That is also exactly
 * what contract §6 rule 1 demands of the event — it cannot be lost while its
 * cause commits, because there is no moment at which one exists and the other
 * does not.
 *
 * The shape is `server/repo/posts.ts`'s, deliberately and almost line for line.
 * It has been through two critic rounds and 200-concurrent-write testing; a
 * second dialect of it would be a second set of the same bugs.
 */

// --------------------------------------------------------------------- reads

export async function getProduct(db: Db, id: string): Promise<Product | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(productColumns('p'))} FROM shop_products p WHERE p.id = ${id}`);
  const row = res.rows[0];
  return row ? rowToProduct(row) : null;
}

/**
 * By slug, and **only what is on sale**.
 *
 * The storefront read. `deleted_at IS NULL AND status = 'active'` is here rather
 * than in the route because it is the same predicate `quote()` enforces, and two
 * places that decide "is this on sale" is two places to disagree — which on a
 * shop means a product page that renders for something the cart then refuses.
 */
export async function getActiveProductBySlug(db: Db, slug: string): Promise<Product | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(productColumns('p'))} FROM shop_products p
     WHERE p.slug = ${slug} AND p.deleted_at IS NULL AND p.status = 'active'`);
  const row = res.rows[0];
  return row ? rowToProduct(row) : null;
}

/**
 * The same read, plus the lifecycle generation.
 *
 * `lifecycleGeneration` is deliberately NOT a field on `Product`, for the reason
 * `server/repo/posts.ts` gives about `Post`: it is a concurrency token for one
 * code path, and putting it on the domain type would ship it to a client, invite
 * a caller to compare it, and make a server-side schema decision part of
 * somebody else's compile surface for no benefit.
 */
interface LifecycleRead {
  product: Product;
  generation: number;
}

async function readLifecycle(db: Db, id: string): Promise<LifecycleRead | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(productColumns('p'))}, p.lifecycle_generation
      FROM shop_products p WHERE p.id = ${id}`);
  const row = res.rows[0];
  if (!row) return null;
  return { product: rowToProduct(row), generation: Number(row.lifecycle_generation) };
}

// -------------------------------------------------------------------- create

export interface CreateProductInput extends ProductPatch {
  /** Accepted, normalised, and never trusted — see the note below. */
  slug?: string | null;
}

/**
 * A new product and its first revision, in one statement.
 *
 * A SUPPLIED SLUG IS NORMALISED IN SHAPE, NOT ONLY IN UNIQUENESS. GAUNTLET II
 * Part 2a found `createPost` storing `../../admin` verbatim into the column that
 * becomes a URL path. `slugify` is the same function the title path uses, so a
 * slug that ARRIVES is held to the same charset as one that is DERIVED, and the
 * uniqueness walk then decides whether it is free.
 *
 * `''` IS NOT A SLUG. `slug` is UNIQUE and Postgres permits many NULLs but
 * exactly one empty string, so the SECOND untitled draft would fail with a raw
 * 23505 nobody expects. Normalised at the write boundary rather than trusting
 * any caller — the identical hazard `normaliseSlug` handles for posts.
 */
export async function createProduct(
  db: Db,
  author: AuthUser,
  input: CreateProductInput = {},
): Promise<Product> {
  const now = Date.now();
  const id = newCatalogId('prd_');
  const revId = newCatalogId('prv_');

  const description = validatedOrThrow(input.description ?? { type: 'doc', content: [] });
  checkMeta({ title: input.title, category: input.category, tags: input.tags });

  const title = input.title ?? '';
  const supplied = input.slug ? input.slug : null;
  // A titled product gets an address on creation; an untitled one holds NULL
  // until it earns one, exactly as a draft post does.
  const base = supplied !== null ? slugify(supplied) : title ? slugify(title) : null;

  const row = await withSlugRetry(async (attempt) => {
    const slug = base ? await uniqueProductSlug(db, base, id, attempt) : null;
    const res = await db.execute(sql`
      WITH ins AS (
        INSERT INTO shop_products (id, slug, title, description, description_text, status,
                                   category, tags, cover_image_id, image_ids,
                                   created_at, updated_at, published_at, deleted_at,
                                   author_id, revision)
        VALUES (${id}, ${slug}, ${title}, ${JSON.stringify(description)}::jsonb,
                ${docToText(description)}, 'draft',
                ${input.category ?? ''}, ${sql.param(input.tags ?? [])},
                ${input.coverImageId ?? null}, ${sql.param(input.imageIds ?? [])},
                ${now}, ${now}, NULL, NULL, ${author.id}, 1)
        RETURNING ${sql.raw(PRODUCT_COLUMNS.join(', '))}
      ), rev AS (
        INSERT INTO shop_product_revisions (id, product_id, revision, created_at, author_id,
                                            title, description, status, kind, note)
        SELECT ${revId}, ins.id, ins.revision, ${now}, ${author.id},
               ins.title, ins.description, ins.status, 'edit', NULL
          FROM ins
        RETURNING 1
      )
      SELECT ${sql.raw(PRODUCT_COLUMNS.join(', '))} FROM ins`);
    return res.rows[0];
  });

  return rowToProduct(row);
}

// ---------------------------------------------------------------------- save

export interface SaveProductOptions {
  actor: AuthUser;
  /** When set, refuse the write if the stored product has moved on. */
  baseRevision?: number;
  /** Human-readable summary for the revision this save writes. */
  note?: string;
}

/**
 * The single mutation path for a product's content and metadata.
 *
 * 1. Read current. Absent → `NotFoundError`.
 * 2. `baseRevision` present and ≠ stored → `StaleWriteError` immediately. The
 *    cheap path only; the CAS is what is authoritative.
 * 3. Merge by NAMING each patchable field, so a system field cannot be smuggled
 *    in at all rather than being spread in and then overwritten.
 * 4. Validate `patch.description` — IT, never the merged document. See below.
 * 5. Derive, and assign a slug if titled and unslugged.
 * 6. CAS on `baseRevision ?? current.revision`.
 *
 * ONLY `patch.description` IS VALIDATED, NEVER THE MERGE. Validating the merge
 * would mean a single pre-existing violation — an import, or a later tightening
 * of these rules — makes that product permanently unsavable, and every edit
 * from then on is lost. That is GAUNTLET II Part 2a Round 1 #1 in its general
 * form: a validator narrower than what a client can emit turns a 422 into a
 * permanent stop, and the client's retry policy drops the write.
 *
 * NOTE WHAT THE SET LIST OMITS: `status`, `published_at`, `deleted_at`. That is
 * what stops a PATCH body smuggling a lifecycle change past the lifecycle rules,
 * and it is also what keeps the generation trigger meaningful — an ordinary save
 * leaves the generation alone, so a publish that merely raced a save still wins
 * and re-derives rather than 409ing at a human.
 */
export async function saveProduct(
  db: Db,
  id: string,
  patch: ProductPatch,
  opts: SaveProductOptions,
): Promise<Product> {
  const current = await getProduct(db, id);
  if (!current) throw new NotFoundError(id);

  const base = opts.baseRevision ?? current.revision;
  if (opts.baseRevision != null && opts.baseRevision !== current.revision) {
    throw new StaleProductWriteError(opts.baseRevision, current.revision, current);
  }

  const description =
    patch.description !== undefined ? validatedOrThrow(patch.description) : current.description;
  checkMeta({ title: patch.title, category: patch.category, tags: patch.tags });

  const next = {
    title: patch.title ?? current.title,
    category: patch.category ?? current.category,
    tags: patch.tags ?? current.tags,
    coverImageId:
      patch.coverImageId !== undefined ? patch.coverImageId : current.coverImageId,
    imageIds: patch.imageIds ?? current.imageIds,
  };

  const now = Date.now();
  const revId = newCatalogId('prv_');

  const rows = await withSlugRetry(async (attempt) => {
    /*
     * Slugs are derived, never supplied — `ProductPatch` has no `slug` key.
     * Assigned on the first save that has a title and never rewritten
     * afterwards: a published URL is a promise, not a value that follows the
     * heading around.
     *
     * Inside the retry and carrying the attempt index. `uniqueProductSlug`
     * reads, then this statement writes, and between the two another writer can
     * take the candidate — the loop is an optimisation and the UNIQUE index is
     * the authority. The index is what makes the NEXT candidate different
     * rather than the same one every racer just lost.
     */
    let slug = current.slug;
    if (!slug && next.title) slug = await uniqueProductSlug(db, slugify(next.title), id, attempt);

    const res = await db.execute(sql`
      WITH upd AS (
        UPDATE shop_products
           SET title = ${next.title},
               description = ${JSON.stringify(description)}::jsonb,
               description_text = ${docToText(description)},
               slug = ${slug},
               category = ${next.category},
               tags = ${sql.param(next.tags)},
               cover_image_id = ${next.coverImageId},
               image_ids = ${sql.param(next.imageIds)},
               revision = revision + 1, updated_at = ${now}
         WHERE id = ${id} AND revision = ${base}
        RETURNING ${sql.raw(PRODUCT_COLUMNS.join(', '))}
      ), rev AS (
        INSERT INTO shop_product_revisions (id, product_id, revision, created_at, author_id,
                                            title, description, status, kind, note)
        SELECT ${revId}, upd.id, upd.revision, ${now}, ${opts.actor.id},
               upd.title, upd.description, upd.status, 'edit', ${opts.note ?? null}
          FROM upd
        RETURNING 1
      )
      SELECT ${sql.raw(PRODUCT_COLUMNS.join(', '))} FROM upd`);
    return res.rows;
  }).catch(async (err: unknown) => {
    /*
     * The `UNIQUE (product_id, revision)` backstop. Unreachable through the CAS
     * as written — the revision row is inserted by `SELECT … FROM upd`, so a
     * losing CAS inserts nothing — but it is what holds under REAL parallelism,
     * where two writers can reach the same revision number even though the
     * row-level CAS decided one of them lost. That IS a lost CAS whichever layer
     * notices it, so it maps onto the same 409 rather than escaping as a 500.
     */
    if (isRevisionCollision(err)) {
      const actual = await getProduct(db, id);
      if (!actual) throw new NotFoundError(id);
      throw new StaleProductWriteError(base, actual.revision, actual);
    }
    throw err;
  });

  /*
   * `rows.length`, never `affectedRows` — measured to be 0 even on a winning CAS
   * (`server/repo/posts.ts`). Zero rows means the CAS lost and NOTHING happened:
   * no bumped revision and no revision row, because `INSERT … SELECT FROM upd`
   * had no rows to insert.
   */
  if (rows.length === 0) {
    const actual = await getProduct(db, id);
    if (!actual) throw new NotFoundError(id);
    throw new StaleProductWriteError(base, actual.revision, actual);
  }

  return rowToProduct(rows[0]);
}

// ----------------------------------------------------------------- lifecycle

/**
 * Publish, unpublish, archive, unarchive, trash, restore.
 *
 * THE SHAPE, AND WHY EVERY PART OF IT IS LOAD-BEARING (GAUNTLET II Part 2b #1,
 * the single most important finding in this repository's history):
 *
 * - **No client base revision, so a bounded internal retry.** There is no human
 *   decision to surface here; the derivation simply needs a fresh row. Three
 *   attempts, then 409.
 * - **The retry re-bases on the row it just read, and PINS THE LIFECYCLE
 *   GENERATION it first read.** Retry answers "the row moved under me". It must
 *   never answer "someone did the opposite thing on purpose". A predicate over
 *   current state alone cannot tell "never left draft" from "was archived and
 *   restored to draft" — the row looks identical — so a concurrent INVERSE op
 *   returns the row to a state the precondition accepts and the retry silently
 *   re-applies an intent a human had deliberately undone. On `posts` that was
 *   measured end to end: a re-applied trash put the post back in the bin,
 *   `emptyTrash` destroyed it, and CASCADE took every revision.
 * - **The CAS predicate is the ONLY authority.** No JS check short-circuits it.
 *   A precondition judged in TypeScript is judged against a row that has already
 *   been read, i.e. against exactly the stale value the CAS exists to distrust —
 *   and mutation testing on `posts` showed those JS pre-checks made the SQL
 *   guards entirely untested. `holds()` is consulted only to CLASSIFY a
 *   predicate that has already matched nothing, on a row read after the fact.
 */
export const LIFECYCLE_ATTEMPTS = 3;

interface Transition {
  /** For the refusal message — `publish`, `trash`, … */
  name: string;
  /**
   * The precondition. Used only to explain a CAS that matched nothing, never to
   * decide whether the write may proceed — see `guard`.
   */
  holds(product: Product): boolean;
  /** The same precondition, in the CAS predicate — this is the authoritative one. */
  guard: SQL;
  note: string;
  /** What the transition assigns, beyond `revision` and `updated_at`. */
  set(product: Product, now: number): SQL;
  /**
   * The outbox CTE, or `null` for a transition nobody downstream cares about.
   *
   * Contract §6's fixed type list has `catalog.variant.published` and
   * `catalog.variant.unpublished` and nothing at product level, which is the
   * right granularity: the VARIANT is the sellable unit, so a consumer warming a
   * price cache or indexing a search catalogue is acting on something with a SKU.
   */
  event(now: number): SQL | null;
}

/**
 * `catalog.variant.published`, one per sellable variant of the product `upd`
 * just activated.
 *
 * The LEFT JOIN to `shop_prices` is deliberate: a variant with no current price
 * still gets an event, carrying `price: null`. Dropping it instead would make
 * the event stream disagree with the catalogue about which variants exist, and a
 * consumer that never heard of a variant cannot later be told it was unpublished.
 */
function variantPublishedEvent(now: number): SQL {
  return emitEvent({
    from: sql`upd
      JOIN shop_variants v ON v.product_id = upd.id AND v.status = 'active'
      LEFT JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL`,
    type: 'catalog.variant.published',
    subjectId: sql`v.id`,
    payload: jsonbObject({
      variantId: sql`v.id`,
      productId: sql`upd.id`,
      sku: sql`v.sku`,
      price: sql`CASE WHEN pr.id IS NULL THEN NULL::jsonb
                      ELSE jsonb_build_object('amount', pr.amount, 'currency', pr.currency) END`,
    }),
    occurredAt: now,
  });
}

/** The inverse, with the reason the variant stopped being sellable. */
function variantUnpublishedEvent(now: number, reason: string): SQL {
  return emitEvent({
    from: sql`upd JOIN shop_variants v ON v.product_id = upd.id AND v.status = 'active'`,
    type: 'catalog.variant.unpublished',
    subjectId: sql`v.id`,
    payload: jsonbObject({
      variantId: sql`v.id`,
      productId: sql`upd.id`,
      sku: sql`v.sku`,
      reason: sql`${reason}::text`,
    }),
    occurredAt: now,
  });
}

async function transition(
  db: Db,
  id: string,
  actor: AuthUser,
  t: Transition,
): Promise<Product> {
  let read = await readLifecycle(db, id);
  if (!read) throw new NotFoundError(id);

  /*
   * READ ONCE, ON THE FIRST ATTEMPT, AND PINNED FOR THE REST. Re-reading it per
   * attempt would defeat the whole point: the retry would adopt whatever
   * generation the concurrent lifecycle op left behind and win against it, which
   * is the original defect with an extra column.
   */
  const pinned = read.generation;
  const derivedFrom = read.product.revision;

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const current = read.product;
    // Re-based every attempt, unlike the generation: a concurrent ordinary SAVE
    // must not 409 a publish, it must be re-derived from.
    const base = current.revision;
    const now = Date.now();
    const revId = newCatalogId('prv_');
    const event = t.event(now);

    const row = await db
      .execute(sql`
        WITH upd AS (
          UPDATE shop_products
             SET ${t.set(current, now)},
                 revision = revision + 1, updated_at = ${now}
           WHERE id = ${id} AND revision = ${base}
             AND lifecycle_generation = ${pinned}
             AND ${t.guard}
          RETURNING ${sql.raw(PRODUCT_COLUMNS.join(', '))}
        ), rev AS (
          INSERT INTO shop_product_revisions (id, product_id, revision, created_at, author_id,
                                              title, description, status, kind, note)
          SELECT ${revId}, upd.id, upd.revision, ${now}, ${actor.id},
                 upd.title, upd.description, upd.status, 'status', ${t.note}
            FROM upd
          RETURNING 1
        )${event ? sql`, ev AS (${event})` : sql``}
        SELECT ${sql.raw(PRODUCT_COLUMNS.join(', '))} FROM upd`)
      .then((res) => res.rows[0])
      .catch((err: unknown) => {
        /*
         * Under real parallelism two writers can reach the same revision number
         * even though the row-level CAS decided one lost — which means exactly
         * what a lost CAS means, so it re-enters the loop rather than escaping
         * as a 500.
         */
        if (isRevisionCollision(err)) return undefined;
        throw err;
      });

    // `rows[0]`, never `affectedRows` — measured to be 0 even on a winning CAS.
    // Undefined means the CAS matched nothing, so nothing at all was written:
    // neither the revision row nor the event had rows to insert.
    if (row) return rowToProduct(row);

    /*
     * The predicate matched nothing. Read the row back to find out which half of
     * it said no — and note that this read is the ONLY thing `holds()` is ever
     * consulted about.
     *
     * Generation unchanged means no lifecycle op has happened since the first
     * read at all, so a false precondition NOW was already false THEN: the
     * request is refused, not lost, and retrying twice more would only cost two
     * more statements to reach the same answer. Anything else — a moved
     * revision, a moved generation — is a genuine race, so it re-bases.
     */
    const after = await readLifecycle(db, id);
    if (!after) throw new NotFoundError(id);
    if (after.generation === pinned && !t.holds(after.product)) {
      throw new ProductPreconditionFailedError(t.name, after.product);
    }
    read = after;
  }

  /*
   * Three attempts, three lost races. Bounded on purpose — an unbounded retry
   * against a row that never settles is a hung request, not a resilient one.
   *
   * `expected` is the revision the FIRST read derived from, not the last one
   * tried: that is the version the caller's request was actually about.
   */
  throw new StaleProductWriteError(derivedFrom, read.product.revision, read.product);
}

/**
 * PUBLISH ALSO UNTRASHES, ON PURPOSE — the same decision `publishPost` makes.
 *
 * `deleted_at = NULL` is in the SET list while the guard is only
 * `status <> 'active'`, so publishing a trashed product takes it out of the
 * trash without RESTORE's precondition ever being consulted. "Publish this"
 * cannot sensibly mean "publish it and leave it in the bin".
 *
 * `published_at` is preserved on republish: it is the date the product FIRST
 * went on sale, and a re-publish after a seasonal withdrawal is not a new
 * product.
 */
const PUBLISH: Transition = {
  name: 'publish',
  holds: (p) => p.status !== 'active',
  guard: sql`status <> 'active'`,
  note: 'Published',
  set: (p, now) => sql`
    status = 'active',
    published_at = ${p.publishedAt ?? now},
    deleted_at = NULL`,
  event: (now) => variantPublishedEvent(now),
};

const UNPUBLISH: Transition = {
  name: 'unpublish',
  holds: (p) => p.status === 'active',
  guard: sql`status = 'active'`,
  note: 'Moved back to draft',
  set: () => sql`status = 'draft'`,
  event: (now) => variantUnpublishedEvent(now, 'unpublished'),
};

const ARCHIVE: Transition = {
  name: 'archive',
  holds: (p) => p.status !== 'archived',
  guard: sql`status <> 'archived'`,
  note: 'Archived',
  set: () => sql`status = 'archived'`,
  /*
   * Emitted even when the product was already a draft, i.e. when nothing
   * downstream was quoting it anyway. A spurious unpublish is idempotent for
   * every consumer (they stop offering something they were not offering); a
   * MISSING one leaves a consumer quoting a product that has been withdrawn.
   * The asymmetry decides the direction.
   */
  event: (now) => variantUnpublishedEvent(now, 'archived'),
};

const UNARCHIVE: Transition = {
  name: 'unarchive',
  holds: (p) => p.status === 'archived',
  guard: sql`status = 'archived'`,
  note: 'Restored from archive',
  /*
   * To DRAFT, not to active. Coming out of the archive is a decision to work on
   * it again, not a decision to sell it — and going straight to sellable would
   * make one click re-list a product at whatever price it carried when it was
   * withdrawn.
   */
  set: () => sql`status = 'draft'`,
  event: () => null,
};

/** Soft delete. The row and every revision stay intact. */
const TRASH: Transition = {
  name: 'trash',
  holds: (p) => p.deletedAt == null,
  guard: sql`deleted_at IS NULL`,
  note: 'Moved to trash',
  set: (_p, now) => sql`deleted_at = ${now}`,
  event: (now) => variantUnpublishedEvent(now, 'deleted'),
};

const RESTORE: Transition = {
  name: 'restore',
  holds: (p) => p.deletedAt != null,
  guard: sql`deleted_at IS NOT NULL`,
  note: 'Restored from trash',
  set: () => sql`deleted_at = NULL`,
  /*
   * NO EVENT. Restoring from the trash returns the product to whatever status it
   * had, which for anything that was in the trash is not necessarily `active` —
   * and emitting `variant.published` for a product that comes back as a draft
   * would tell every consumer to start quoting something that is not for sale.
   * A restore that should re-list goes through `publish`, which does emit.
   */
  event: () => null,
};

export const publishProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, PUBLISH);
export const unpublishProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, UNPUBLISH);
export const archiveProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, ARCHIVE);
export const unarchiveProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, UNARCHIVE);
export const trashProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, TRASH);
export const restoreProduct = (db: Db, id: string, actor: AuthUser): Promise<Product> =>
  transition(db, id, actor, RESTORE);

// ------------------------------------------------------------------- helpers

function validatedOrThrow(description: unknown): DocNode {
  const result = validateDoc(description);
  if (!result.ok) throw new InvalidDocumentError(result.violation);
  return result.doc;
}

/**
 * The metadata bounds, reused rather than re-derived.
 *
 * `checkPostMeta` bounds title, category and tags in UTF-8 BYTES, which is what
 * makes it correct for multibyte text — GAUNTLET II Part 1 Round 2 records the
 * prescribed `left(content_text, N)` fix being wrong because it counts
 * characters. `shop_products` has no generated tsvector, so the 54000 cliff that
 * motivated those bounds on `posts` does not exist here; the bounds are still
 * worth having, because a 1.2 MB title is a 500 on some other statement sooner
 * or later and a 422 that names the field is the answer either way.
 *
 * `subtitle` and `excerpt` are simply absent from the input, so those two rules
 * never fire.
 */
function checkMeta(meta: { title?: unknown; category?: unknown; tags?: unknown }): void {
  const violation = checkPostMeta(meta);
  if (violation) throw new InvalidDocumentError(violation);
}

function isSlugCollision(err: unknown): boolean {
  return uniqueViolation(err) === 'shop_products_slug_unique';
}

function isRevisionCollision(err: unknown): boolean {
  return uniqueViolation(err) === 'shop_product_revisions_uq';
}

/** Present so a caller can distinguish a real driver failure in a test. */
export function isDbError(err: unknown): err is DbError {
  return err instanceof DbError;
}

/**
 * The slug ladder's retry, and THE ATTEMPT INDEX IS THE WHOLE FIX.
 *
 * Re-running the same closure re-derives the same candidate from the same taken
 * set, so every writer in a crowd collides again on the same slug and each round
 * admits exactly one of them — measured on `posts`, ten concurrent writers left
 * seven with a raw `23505`. `uniqueProductSlug` takes the index and climbs a
 * ladder that ends in a random suffix, so the loop terminates in success rather
 * than in an exhausted counter.
 *
 * Retrying is safe precisely because the mutation is ONE statement: a constraint
 * violation rolls the whole thing back, so a failed attempt wrote neither the
 * product nor its revision nor an event.
 */
async function withSlugRetry<T>(
  attempt: (index: number) => Promise<T>,
  attempts = SLUG_ATTEMPTS,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt(i);
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
      last = err;
    }
  }
  throw last;
}
