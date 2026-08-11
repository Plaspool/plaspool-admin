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
 * The seam. Every `Db` in this codebase — production and test — is built here
 * or in `server/test/harness.ts`, and both wrap the handle, so no call site has
 * to remember to catch. Scrubbing at each `try`/`catch` would be one forgotten
 * `throw err` away from re-opening the leak.
 *
 * Only `execute` is intercepted: it is the sole path every repo uses (the plan
 * mandates raw SQL for the CAS write path and enumerated column lists), and
 * narrowing the trap keeps Drizzle's own internals untouched. The wrapper
 * resolves Drizzle's lazy `PgRaw` thenable into a real promise, which is
 * invisible to `await` — the only way this codebase consumes it.
 */
export function guardDb(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        try {
          return Promise.resolve(execute.apply(target, args)).catch((err: unknown) => {
            throw scrubDriverError(err);
          });
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
