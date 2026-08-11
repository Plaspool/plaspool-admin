import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';
import type { AuthUser } from '../../../../shared/types';
import { createProduct } from '../products';
import { createVariant } from '../variants';
import { setPrice } from '../prices';
import { money } from '../../../../shared/commerce/money';
import type { Product, Variant } from '../types';

/**
 * Seeding and instrumentation shared by Catalog's suites.
 *
 * `mutating()` is the important one. It is a copy of the mutation operator in
 * `server/repo/lifecycle.test.ts` — copied rather than imported because that one
 * lives inside a test file and exports nothing, and because Catalog owns this
 * tree while it does not own that file.
 */

// ------------------------------------------------------------------- seeding

export interface SeedOptions {
  title?: string;
  category?: string;
  tags?: string[];
}

export async function seedProduct(
  db: Db,
  actor: AuthUser,
  o: SeedOptions = {},
): Promise<Product> {
  return createProduct(db, actor, {
    title: o.title ?? 'Seed Product',
    category: o.category ?? 'general',
    tags: o.tags,
  });
}

export interface SeedVariantOptions {
  sku?: string;
  onHand?: number;
  backorderable?: boolean;
  /** Minor units. Omit for a variant deliberately left unpriced. */
  amount?: number | null;
  currency?: string;
}

let skuCounter = 0;

export async function seedVariant(
  db: Db,
  productId: string,
  actor: AuthUser,
  o: SeedVariantOptions = {},
): Promise<Variant> {
  skuCounter += 1;
  const variant = await createVariant(
    db,
    productId,
    {
      sku: o.sku ?? `SKU-${skuCounter}-${Date.now().toString(36)}`,
      onHand: o.onHand ?? 0,
      backorderable: o.backorderable ?? false,
    },
    actor,
  );
  if (o.amount !== null) {
    await setPrice(db, variant.id, money(o.amount ?? 1999, o.currency ?? 'GBP'));
  }
  return variant;
}

/** A product that is on sale, with one priced, stocked variant. */
export async function seedSellable(
  db: Db,
  actor: AuthUser,
  o: SeedOptions & SeedVariantOptions = {},
): Promise<{ product: Product; variant: Variant }> {
  const product = await seedProduct(db, actor, o);
  const variant = await seedVariant(db, product.id, actor, o);
  const { publishProduct } = await import('../products');
  const published = await publishProduct(db, product.id, actor);
  return { product: published, variant };
}

// ------------------------------------------------------------------- reading

export async function countRevisions(db: Db, productId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM shop_product_revisions WHERE product_id = ${productId}`);
  return Number(res.rows[0].n);
}

export async function revisionNumbers(db: Db, productId: string): Promise<number[]> {
  const res = await db.execute(sql`
    SELECT revision FROM shop_product_revisions
     WHERE product_id = ${productId} ORDER BY revision ASC`);
  return res.rows.map((r) => Number(r.revision));
}

export async function generationOf(db: Db, productId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT lifecycle_generation FROM shop_products WHERE id = ${productId}`);
  return Number(res.rows[0].lifecycle_generation);
}

export async function rawProduct(db: Db, id: string): Promise<Record<string, unknown>> {
  const res = await db.execute(sql`SELECT * FROM shop_products WHERE id = ${id}`);
  return res.rows[0];
}

export interface EventRow {
  type: string;
  subjectId: string;
  payload: Record<string, unknown>;
}

export async function eventsFor(db: Db, subjectId: string): Promise<EventRow[]> {
  const res = await db.execute(sql`
    SELECT type, subject_id, payload FROM commerce_events
     WHERE subject_id = ${subjectId} ORDER BY id ASC`);
  return res.rows.map((r) => ({
    type: String(r.type),
    subjectId: String(r.subject_id),
    payload:
      typeof r.payload === 'string'
        ? (JSON.parse(r.payload) as Record<string, unknown>)
        : (r.payload as Record<string, unknown>),
  }));
}

export async function countEvents(db: Db): Promise<number> {
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM commerce_events`);
  return Number(res.rows[0].n);
}

// --------------------------------------------------------------- instruments

/** The rejection itself, typed — `.catch(e => e)` widens to `T | error`. */
export async function rejection<T>(promise: Promise<unknown>): Promise<T> {
  let caught: unknown;
  let resolved = false;
  await promise.then(
    () => {
      resolved = true;
    },
    (err: unknown) => {
      caught = err;
    },
  );
  if (resolved) throw new Error('expected the call to reject, but it resolved');
  return caught as T;
}

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

/**
 * A handle that rewrites the SQL on its way to the driver — the mutation
 * operator, run from inside the suite.
 *
 * WHY THIS EXISTS. GAUNTLET II Part 2b measured that replacing `deleted_at IS
 * NULL` with `true` in the blog's CAS predicates broke **none of 254 server
 * tests**, because every precondition case was decided by a JavaScript check on
 * an already-read row — the one check that cannot be trusted under concurrency,
 * and the reason the A→B→A defect survived a green suite for two rounds. A test
 * that asserts a MUTANT MISBEHAVES is the only kind that proves the original is
 * what refuses the write. Brief §4: "Assume your guards are untested until you
 * have watched the suite go red without them."
 *
 * It REBUILDS rather than string-patches: `sqlToQuery` renders the statement
 * with `$n` placeholders, the substitution is applied to that text, and the
 * placeholders are turned back into bound parameters — so nothing is inlined
 * into SQL and the mutant differs from the original in exactly one predicate.
 * Statements that do not match are passed through untouched.
 *
 * ⚠️  EVERY REBUILT VALUE GOES BACK THROUGH `sql.param`, AND THAT IS A FIX
 *     RATHER THAN A FLOURISH. The version in `server/repo/lifecycle.test.ts`
 *     re-interpolates with a bare `sql`${value}``, and Drizzle expands a bare
 *     ARRAY into a tuple — so a statement binding `text[]` came back out as
 *     `tags = ()` and failed with SQLSTATE 42601 before the mutant could prove
 *     anything. Measured here on `saveProduct`, whose SET list binds `tags` and
 *     `image_ids`; the blog's lifecycle statements bind no arrays, which is the
 *     only reason the original never hit it. `sql.param` keeps every value a
 *     single bound parameter regardless of its type.
 */
export function mutating(db: Db, find: RegExp, replacement: string): Db {
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
          i % 2 === 0
            ? sql.raw(part)
            : sql`${sql.param(built.params[Number(part) - 1])}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
}

/**
 * A handle that moves the row out from under every statement issued through it.
 *
 * The bump is applied to the RAW handle so it does not recurse, and it runs
 * BEFORE each statement rather than after, so it lands between an attempt's read
 * and that attempt's CAS. No CAS issued through this handle can ever win, which
 * is the only way to reach the give-up branch deterministically.
 */
export function alwaysMoving(db: Db, id: string): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        await execute.apply(target, [
          sql`UPDATE shop_products SET revision = revision + 1 WHERE id = ${id}`,
        ]);
        return execute.apply(target, args);
      };
    },
  });
}
