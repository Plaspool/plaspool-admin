import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';

/**
 * The mutation operator, run from inside the suite.
 *
 * WHY THIS EXISTS. GAUNTLET II Part 2b measured that replacing `deleted_at IS NULL` or
 * `status <> 'published'` with `true` broke **none of 254 server tests**, because every
 * precondition case was decided by a JavaScript check on an already-read row — the one
 * check that cannot be trusted under concurrency, and the reason the A→B→A defect
 * survived a green suite. A test that asserts a MUTANT MISBEHAVES is the only kind that
 * proves the original is what refuses the write.
 *
 * A COPY OF `mutating()` IN `server/repo/lifecycle.test.ts`, AND DELIBERATELY SO.
 * That one is a module-private function in a file contract §2 R1 puts out of reach:
 * exporting it would be an amendment to somebody else's test file for a twenty-line
 * helper. The copy is confined to this subsystem's own test directory, and
 * `mutate.test.ts` pins its behaviour so a divergence between the two is caught here
 * rather than in whichever suite happens to notice.
 *
 * IT REBUILDS RATHER THAN STRING-PATCHES. `sqlToQuery` renders the statement with `$n`
 * placeholders, the substitution is applied to that text, and the placeholders are turned
 * back into bound parameters — so nothing is inlined into SQL, the mutant differs from
 * the original in exactly one predicate, and a statement that does not match is passed
 * through untouched.
 */
interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

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
          i % 2 === 0 ? sql.raw(part) : sql`${built.params[Number(part) - 1]}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
}

/**
 * A handle that counts how many statements a mutant actually rewrote.
 *
 * A MUTATION TEST THAT REWRITES NOTHING PASSES FOR THE WRONG REASON. If a regex stops
 * matching — a predicate reworded, a column renamed, `sql.raw` used where a parameter was
 * — the "mutant" is the original, and a test asserting the original's behaviour goes
 * green while proving nothing at all. Every mutation test in this subsystem asserts this
 * counter is non-zero, which is the only defence against that.
 */
export function countingMutant(
  db: Db,
  find: RegExp,
  replacement: string,
): { db: Db; rewritten: () => number } {
  let rewritten = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) => {
        const built = (target as unknown as Dialecty).dialect.sqlToQuery(args[0]);
        if (!find.test(built.sql)) return execute.apply(target, args);
        rewritten += 1;
        const parts = built.sql.replace(find, replacement).split(/\$(\d+)/);
        const chunks = parts.map((part, i) =>
          i % 2 === 0 ? sql.raw(part) : sql`${built.params[Number(part) - 1]}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
  return { db: proxy, rewritten: () => rewritten };
}

/** The predicates this subsystem's CAS statements carry, as they render. */
export const PREDICATE = {
  /** `AND lifecycle_generation = ${pinned}` — on either table. */
  generationPin: /lifecycle_generation = \$\d+/,
  /** `AND revision = ${base}` — the ordinary CAS token. */
  revisionCas: /revision = \$\d+\s*$/m,
  orderIsPending: /status = 'pending'/,
  orderIsCancellable: /status IN \('pending', 'paid'\)/,
  orderIsRefundable: /status IN \('paid', 'fulfilled', 'partially_refunded', 'refunded'\)/,
  orderIsPaid: /status = 'paid'/,
  orderIsFulfillable: /status IN \('paid', 'partially_refunded'\)/,
  /** The coverage half of the `paid → fulfilled` guard. */
  nothingUnshipped: /NOT EXISTS \(\s*SELECT 1 FROM shop_order_lines[\s\S]*?\n\)/,
  fulfillmentIsPending: /status = 'pending'/,
  fulfillmentIsShipped: /status = 'shipped'/,
  fulfillmentIsCancellable: /status IN \('pending', 'shipped'\)/,
} as const;

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
