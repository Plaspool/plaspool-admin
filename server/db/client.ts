import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Assume } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { getEnv } from '../env';

/**
 * The shape `db.execute(sql`...`)` resolves to.
 *
 * The plan's `PgDatabase<PgQueryResultHKT, typeof schema>` typechecks on its
 * own but leaves `execute()` returning `unknown`, because the bare HKT's
 * `type` member is `unknown` — so `rows.rows.length`, which the CAS write path
 * depends on, is a TS18046 at every call site. Widening the HKT (rather than
 * the whole database to `any`) keeps the row typing and states the one thing
 * both drivers genuinely agree on: a `rows` array.
 *
 * Only `rows` is declared on purpose. PGlite reports `affectedRows` and Neon
 * reports `rowCount`, and `affectedRows` is 0 even on a winning CAS — so the
 * write path must count `rows.length` and nothing here should tempt it
 * otherwise.
 */
interface RowsOnly<TRow> {
  rows: TRow[];
}

interface DbQueryResultHKT extends PgQueryResultHKT {
  type: RowsOnly<Assume<this['row'], Record<string, unknown>>>;
}

/**
 * The one definition of "a database handle". Every server function takes
 * `db: Db`; nothing else declares its own.
 *
 * Driver-agnostic on purpose: PGlite in tests, Neon HTTP in production.
 * Deliberately NOT `NodePgDatabase` — that is the node-postgres type and would
 * pull in a `pg` dependency this project does not install.
 */
export type Db = PgDatabase<DbQueryResultHKT, typeof schema>;

// ------------------------------------------------------- bigint coercion

/**
 * Coerce a driver-supplied `bigint` column to a JS number.
 *
 * PGlite parses int8 into a JS **number**; `@neondatabase/serverless` hands it
 * back as a **string**. Code that reads `row.created_at` directly is therefore
 * correct on PGlite and silently wrong on Neon — arithmetic on a string
 * concatenates, and `expires_at <= now` compares lexicographically.
 *
 * Two halves close that seam and both are load-bearing: every bigint read goes
 * through here, and `server/test/harness.ts` configures PGlite to return int8
 * as a string so the test driver behaves like production instead of hiding the
 * divergence (spec §9).
 */
export function toEpochMs(value: unknown): number {
  return Number(value);
}

/** As `toEpochMs`, for the nullable timestamp columns. */
export function toEpochMsOrNull(value: unknown): number | null {
  return value == null ? null : Number(value);
}

// ------------------------------------------------------- error scrubbing

/**
 * A driver failure with every value removed.
 *
 * The problem this exists for: Drizzle wraps a failed statement in a
 * `DrizzleQueryError` whose own `message` is
 * `Failed query: INSERT INTO users (...)\nparams: alice@example.com,scrypt$32768$…`
 * — the interpolated parameters, verbatim, in the message AND in the stack. An
 * ordinary `console.error(err)` on any 500 path therefore writes an
 * offline-crackable password hash and the account email into the log. It is
 * reached by a completely ordinary sequence: invite an address that already has
 * an account, the invitee accepts, `users_email_unique` fires.
 *
 * Note what does NOT fix it. `err.detail` and `err.parameters` do not exist on
 * the `DrizzleQueryError` at all — verified by execution, its own properties are
 * exactly `stack`, `message`, `query`, `params`, `cause`. `detail` lives on
 * `err.cause` (the pg error, carrying `Key (email)=(alice@example.com) already
 * exists.`), and the parameter array is spelled `params`, not `parameters`.
 * Deleting `err.detail`/`err.parameters` from the thrown error changes nothing.
 *
 * So the original error is not sanitised, it is **discarded**: no `cause`, no
 * `query`, no `params`. What survives is schema metadata — SQLSTATE, relation,
 * constraint, column — which is what a log actually needs to identify the
 * failure and which cannot contain a user value. The pg `message` is dropped
 * too, because messages like `invalid input syntax for type uuid: "…"` quote
 * the offending value.
 */
export class DbError extends Error {
  /** SQLSTATE, e.g. `23505` for unique_violation. */
  readonly code: string | null;
  readonly constraint: string | null;
  readonly table: string | null;
  readonly column: string | null;

  constructor(meta: {
    code?: string | null;
    constraint?: string | null;
    table?: string | null;
    column?: string | null;
  }) {
    const bits = [`database error ${meta.code ?? 'unknown'}`];
    if (meta.table) bits.push(`table=${meta.table}`);
    if (meta.constraint) bits.push(`constraint=${meta.constraint}`);
    if (meta.column) bits.push(`column=${meta.column}`);
    super(bits.join(' '));
    this.name = 'DbError';
    this.code = meta.code ?? null;
    this.constraint = meta.constraint ?? null;
    this.table = meta.table ?? null;
    this.column = meta.column ?? null;
    Error.captureStackTrace?.(this, DbError);
  }
}

interface PgErrorish {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  column?: unknown;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Walk the `cause` chain to the driver error underneath. Bounded, because a
 * self-referential `cause` would otherwise spin forever on an error path.
 */
function pgErrorOf(err: unknown): PgErrorish | null {
  let cur: unknown = err;
  for (let hops = 0; hops < 8 && cur != null; hops += 1) {
    const code = (cur as PgErrorish).code;
    // SQLSTATE is five alphanumerics. Both the PGlite and the Neon error
    // objects report it under `code`, alongside `constraint`/`table`/`column`.
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return cur as PgErrorish;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Turn a driver failure into a `DbError`. Anything that is not a driver
 * failure — a `TypeError` from a bug in a repo, an `InviteError` — is returned
 * untouched, so this can sit on a hot path without swallowing real errors.
 */
export function scrubDriverError(err: unknown): unknown {
  if (err instanceof DbError) return err;
  const pg = pgErrorOf(err);
  if (!pg && !(err instanceof DrizzleQueryError)) return err;
  return new DbError({
    code: nonEmpty(pg?.code),
    constraint: nonEmpty(pg?.constraint),
    table: nonEmpty(pg?.table),
    column: nonEmpty(pg?.column),
  });
}

/**
 * The constraint name of a unique violation, or `null` if the error is
 * something else. Works on a scrubbed `DbError` and on a raw driver error
 * alike, so a repo that translates `23505` into a domain error stays correct
 * even if it is ever handed an unguarded handle.
 */
export function uniqueViolation(err: unknown): string | null {
  if (err instanceof DbError) return err.code === '23505' ? err.constraint : null;
  const pg = pgErrorOf(err);
  if (!pg || pg.code !== '23505') return null;
  return nonEmpty(pg.constraint);
}

/**
 * Every Drizzle entry point on a `Db` that can reach the driver.
 *
 * Guarding `execute` alone was one method wide. `db.insert(users).values(...)`
 * rejects with the same `DrizzleQueryError` — `Failed query: insert into
 * "users" ...\nparams: victim@example.com,scrypt$32768$...` — and it went
 * straight past the proxy, so the account email and a live hash were still one
 * `console.error` from the log. Measured against this schema before the fix:
 * `select`, `insert`, `update`, `delete`, `query.*` and `transaction` all
 * leaked; only `execute` did not.
 *
 * `transaction` is in the list for completeness even though spec §4.3a forbids
 * it on the hot path (the Neon HTTP driver rejects it unconditionally): it
 * works on PGlite, so an unguarded one would leak in tests. It is handled
 * separately below because the handle to scrub arrives as a callback argument
 * rather than as a return value.
 */
const GUARDED_METHODS: ReadonlySet<string> = new Set([
  'execute',
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'with',
  '$count',
  'refreshMaterializedView',
]);

type AnyFn = (...args: unknown[]) => unknown;
type Rejector = (reason: unknown) => unknown;

/**
 * Wrap a lazy Drizzle builder so that whatever it eventually rejects with is
 * scrubbed, without collapsing it into a promise.
 *
 * `Promise.resolve(builder)` is not an option here. `db.insert(t)` returns a
 * `PgInsertBuilder` with no `.then` at all — resolving it would hand back a
 * useless promise wrapping the builder and `.values()` would be gone. And the
 * builders that *are* thenable (`PgSelectBase`, `PgInsertBase`, …) are still
 * chainable after the fact: `Promise.resolve(db.select().from(t))` executes
 * immediately and loses `.where`, `.orderBy`, `.limit`.
 *
 * So the wrapper preserves the whole surface instead, lazily:
 *
 * - a method call is forwarded to the raw target (so Drizzle's internals never
 *   see the proxy and `this` stays correct) and its result re-wrapped, which is
 *   what keeps a chain guarded end to end;
 * - `then` is the only place a driver error can surface, so the rejection
 *   handler is what gets wrapped. `catch`/`finally` are re-expressed through
 *   that same guarded `then` — Drizzle's `QueryPromise.catch` delegates to
 *   `this.then`, i.e. the *raw* one, so intercepting `then` alone would leave a
 *   `.catch(...)` call unscrubbed;
 * - a plain object is wrapped too, which is what carries the guard down
 *   `db.query` → `db.query.users` → `.findMany()`;
 * - a resolved value is never wrapped. `onFulfilled` is passed through
 *   untouched, so `(await db.execute(...)).rows` is the same array it always
 *   was.
 */
function guardLazy<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }

  const scrubbingRejector = (onRejected?: Rejector | null): Rejector => {
    return (err: unknown) => {
      const scrubbed = scrubDriverError(err);
      if (onRejected) return onRejected(scrubbed);
      throw scrubbed;
    };
  };

  const proxy = new Proxy(value as object, {
    get(target, prop) {
      const inner: unknown = Reflect.get(target, prop);
      if (typeof inner !== 'function') return guardLazy(inner);
      const method = inner as AnyFn;

      if (prop === 'then') {
        return (onFulfilled?: unknown, onRejected?: Rejector | null) =>
          method.call(target, onFulfilled, scrubbingRejector(onRejected));
      }
      if (prop === 'catch') {
        return (onRejected?: Rejector | null) =>
          (proxy as PromiseLike<unknown>).then(undefined, onRejected ?? undefined);
      }
      if (prop === 'finally') {
        return (onFinally?: (() => void) | null) =>
          (proxy as PromiseLike<unknown>).then(
            (v: unknown) => {
              onFinally?.();
              return v;
            },
            (err: unknown) => {
              onFinally?.();
              throw err;
            },
          );
      }

      return (...args: unknown[]) => {
        try {
          return guardLazy(method.apply(target, args));
        } catch (err) {
          throw scrubDriverError(err);
        }
      };
    },
  });

  return proxy as T;
}

/**
 * The seam. Every `Db` in this codebase — production and test — is built here
 * or in `server/test/harness.ts`, and both wrap the handle, so no call site has
 * to remember to catch. Scrubbing at each `try`/`catch` would be one forgotten
 * `throw err` away from re-opening the leak.
 *
 * The guard covers every driver-reaching entry point (`GUARDED_METHODS` plus
 * the `query` getter and `transaction`), not just `execute`, and each one is
 * pinned by its own case in `client.test.ts` so a later task cannot quietly
 * reopen one of them. Drizzle's own internals are untouched: every forwarded
 * call is applied to the raw handle, and only what is handed back to the caller
 * is wrapped.
 */
export function guardDb(db: Db): Db {
  return new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);

      // `db.query.users.findMany()` — a plain object of relational builders, so
      // there is no call to intercept on the way in.
      if (prop === 'query') return guardLazy(value);

      if (typeof value !== 'function') return value;
      const method = value as AnyFn;

      // The transacted handle arrives as the callback's argument, so it is
      // guarded on the way in rather than on the way out.
      if (prop === 'transaction') {
        return (callback: (tx: Db) => unknown, ...rest: unknown[]) =>
          guardLazy(
            method.apply(target, [(tx: Db) => callback(guardDb(tx)), ...rest]),
          );
      }

      if (typeof prop !== 'string' || !GUARDED_METHODS.has(prop)) return value;

      return (...args: unknown[]) => {
        try {
          return guardLazy(method.apply(target, args));
        } catch (err) {
          throw scrubDriverError(err);
        }
      };
    },
  });
}

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;
  cached = guardDb(drizzleNeon(neon(getEnv().DATABASE_URL), { schema }) as unknown as Db);
  return cached;
}

export { drizzlePglite };
