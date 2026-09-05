import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';

interface Dialecty {
  dialect: { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
}

/**
 * A handle that rewrites the SQL on its way to the driver — the mutation
 * operator, run from inside the suite.
 *
 * LIFTED VERBATIM FROM `server/repo/lifecycle.test.ts`, deliberately, and moved
 * into a module because this subsystem has several guards to prove rather than
 * two. Copying the *technique* while re-implementing it slightly differently is
 * how two mutation harnesses end up disagreeing about what they proved.
 *
 * WHY IT EXISTS, in the words of the finding that produced it: replacing
 * `deleted_at IS NULL` with `true` broke NONE of 254 server tests, because every
 * precondition case was decided by a JavaScript check on an already-read row —
 * the one check that cannot be trusted under concurrency. A test that asserts a
 * mutant MISBEHAVES is the only kind that proves the original predicate is what
 * refuses the write.
 *
 * It rebuilds rather than string-patches: `sqlToQuery` renders the statement
 * with `$n` placeholders, the substitution is applied to that text, and the
 * placeholders are turned back into bound parameters — so nothing is inlined
 * into SQL and the mutant differs from the original in exactly one predicate.
 * Statements that do not match are passed through untouched.
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
          i % 2 === 0 ? sql.raw(part) : sql`${built.params[Number(part) - 1]}`,
        );
        return execute.apply(target, [sql.join(chunks, sql``)]);
      };
    },
  });
}

/**
 * How the guards this subsystem depends on RENDER, so a mutation test names one
 * thing rather than repeating a regex that has to agree with the SQL.
 *
 * Drizzle lower-cases nothing and upper-cases nothing — the rendered text is
 * whatever the template held — so each of these is written to match what the
 * corresponding statement actually produces, and a test that stops matching is
 * a test that has stopped mutating anything. Every mutation test below asserts
 * a CHANGED OUTCOME, so a regex that silently stopped matching fails rather than
 * passing vacuously.
 */
export const GUARDS = {
  /** `shop_carts.revision = $n` — the cart CAS. */
  cartCas: /revision = \$\d+/,
  /** `status = 'open'` — the "you may still edit this cart" precondition. */
  cartOpen: /status = 'open'/,
  /**
   * `status = 'converting'` — the THAW's precondition, and the only guard that
   * stands between "give the shopper their basket back" and reopening a cart
   * that has already become an order.
   *
   * Note that `thawCheckout`'s statement also SETS `status = 'open'`, so
   * `cartOpen` matches it too and would rewrite the assignment rather than a
   * predicate. Nothing collides today — a thaw runs only on a converting cart
   * and the `cartOpen` mutation tests all drive open ones — but a future test
   * that mutates `cartOpen` across a thaw is mutating the wrong clause and will
   * be measuring nothing.
   */
  cartConverting: /status = 'converting'/,
  /**
   * `state = 'held'` — the reservation transition guard, both directions.
   *
   * The optional `r.` qualifier is not cosmetic. The sweeper's SELECT gained a
   * table alias when it also gained the "has this checkout been paid for?"
   * subquery, and an unqualified pattern then rewrote `r.state = 'held'` into
   * `r.true` — SQLSTATE 42703, a mutation test failing because the MUTANT was
   * malformed rather than because the guard was doing its job. A mutation
   * operator that produces invalid SQL proves nothing at all.
   */
  reservationHeld: /(?:\w+\.)?state = 'held'/,
} as const;
