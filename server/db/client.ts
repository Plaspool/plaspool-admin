import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
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

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;
  cached = drizzleNeon(neon(getEnv().DATABASE_URL), { schema }) as unknown as Db;
  return cached;
}

export { drizzlePglite };
