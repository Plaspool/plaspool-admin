import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { getEnv } from '../env';

/**
 * The one definition of "a database handle". Every server function takes
 * `db: Db`; nothing else declares its own.
 *
 * Driver-agnostic on purpose: PGlite in tests, Neon HTTP in production.
 * Deliberately NOT `NodePgDatabase` — that is the node-postgres type and would
 * pull in a `pg` dependency this project does not install.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;
  cached = drizzleNeon(neon(getEnv().DATABASE_URL), { schema }) as unknown as Db;
  return cached;
}

export { drizzlePglite };
