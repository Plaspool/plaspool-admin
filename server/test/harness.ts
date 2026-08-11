import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';

/**
 * A real Postgres per suite, in-process. PGlite is Postgres compiled to WASM,
 * so CTEs, jsonb, generated columns and constraints are exercised for real.
 */
export interface TestCtx {
  db: Db;
  users: { owner: AuthUser; writer: AuthUser };
  close(): Promise<void>;
}

export async function freshDb(): Promise<TestCtx> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: 'server/db/migrations' });
  const users = await seedUsers(db);
  return { db, users, close: () => client.close() };
}

/**
 * Replaced with the real implementation in Task 3. It throws rather than
 * returning nulls so a task that depends on it fails loudly instead of
 * producing a TypeError three layers down.
 */
async function seedUsers(_db: Db): Promise<TestCtx['users']> {
  throw new Error('seedUsers not implemented until Task 3');
}
