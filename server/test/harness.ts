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

/**
 * A migrated database with no rows at all.
 *
 * Separate from `freshDb()` because the schema suite is testing the `users`
 * table among others — seeding users before asserting on their constraints
 * would be circular — and because Task 3's own tests create their users
 * through `createUser`, which is the thing under test.
 */
export interface RawCtx {
  db: Db;
  close(): Promise<void>;
}

export async function migratedDb(): Promise<RawCtx> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: 'server/db/migrations' });
  return { db, close: () => client.close() };
}

export async function freshDb(): Promise<TestCtx> {
  const { db, close } = await migratedDb();
  const users = await seedUsers(db);
  return { db, users, close };
}

/**
 * Replaced with the real implementation in Task 3. It throws rather than
 * returning nulls so a task that depends on it fails loudly instead of
 * producing a TypeError three layers down.
 */
async function seedUsers(_db: Db): Promise<TestCtx['users']> {
  throw new Error('seedUsers not implemented until Task 3');
}
