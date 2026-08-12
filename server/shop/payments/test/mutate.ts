import type { Db } from '../../../db/client';

/**
 * Rewrite a SQL predicate on its way to the driver, so a guard can be watched
 * failing.
 *
 * WHY THIS EXISTS. Contract §10: "Every CAS predicate and every state guard
 * needs a mutation test — Part 2b found that replacing `deleted_at IS NULL`
 * with `true` broke *none* of 254 server tests, because every precondition test
 * was satisfied by a JS pre-check on a stale read. Assume your guards are
 * untested until you have watched the suite go red without them."
 *
 * That finding is the reason this subsystem's guards live in SQL rather than in
 * JavaScript — and it is also the reason a test that merely exercises the happy
 * path proves nothing about them. `git stash`-style manual mutation does not
 * survive into CI; this does, as `server/repo/lifecycle.test.ts` already
 * established for the lifecycle generation pin.
 *
 * HOW IT WORKS. Drizzle's `sql` template produces an object whose `queryChunks`
 * are the literal fragments between interpolations, and the bound parameters
 * are separate objects that are never touched here. So the rewrite can only
 * change SQL TEXT, never a value — a mutation cannot smuggle a parameter in,
 * which is what keeps this from being a hole in the tests that use it.
 *
 * IT DOES NOT ASSERT THAT IT MATCHED, on purpose. A mutation test written
 * against this must assert an OBSERVABLE BEHAVIOUR CHANGE — an intent that
 * moves backwards, a second outbox row, a refund that should have been refused.
 * If the pattern never matched, the behaviour is unchanged and the test fails.
 * A helper that threw on a missed pattern would be checking its own plumbing;
 * this way the test checks the guard.
 */

interface ChunkLike {
  value?: unknown;
  queryChunks?: unknown[];
}

/** Depth-bounded so a self-referential chunk cannot spin on a test path. */
function rewriteChunks(node: unknown, from: string, to: string, depth = 0): void {
  if (depth > 20 || node === null || typeof node !== 'object') return;

  const chunk = node as ChunkLike;

  if (Array.isArray(chunk.value)) {
    for (let i = 0; i < chunk.value.length; i += 1) {
      const part = chunk.value[i] as unknown;
      if (typeof part === 'string') chunk.value[i] = part.split(from).join(to);
    }
  }

  if (Array.isArray(chunk.queryChunks)) {
    for (const child of chunk.queryChunks) rewriteChunks(child, from, to, depth + 1);
  }
}

/**
 * A `Db` whose `execute` rewrites `from` to `to` in the statement text.
 *
 * Wraps the handle the caller passes, which in every suite is the one
 * `server/test/harness.ts` already put behind `guardDb` — so the driver-error
 * scrub still applies and a mutation that produces a malformed statement fails
 * the way production would rather than leaking the query.
 */
export function mutateSql(db: Db, from: string, to: string): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      return (query: unknown, ...rest: unknown[]) => {
        rewriteChunks(query, from, to);
        return (value as (...args: unknown[]) => unknown).apply(target, [query, ...rest]);
      };
    },
  });
}
