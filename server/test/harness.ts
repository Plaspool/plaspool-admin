import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
import { hashPassword } from '../repo/password';

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
 * The password every seeded user has, so an auth-route suite can log in as
 * `ctx.users.owner` without knowing anything else about the seed.
 */
export const SEED_PASSWORD = 'seed-password';

/**
 * Seeded with a REAL hash at deliberately cheap parameters, not a dummy
 * string. Two hashes at the production cost would add ~450 ms to every server
 * suite, and the production parameters are already pinned by
 * `password.test.ts` — but a hash that cannot be verified would make every
 * later login test build its own users instead.
 *
 * `verifyPassword` reads N, r and p out of the stored value, so a cheap hash
 * verifies cheaply through exactly the production code path.
 */
const SEED_COST_LOG2 = 4;

async function seedUsers(db: Db): Promise<TestCtx['users']> {
  const mk = async (email: string, displayName: string, role: 'owner' | 'writer') => {
    const passwordHash = await hashPassword(SEED_PASSWORD, SEED_COST_LOG2);
    const res = await db.execute(sql`
      INSERT INTO users (email, password_hash, display_name, role, created_at)
      VALUES (${email}, ${passwordHash}, ${displayName}, ${role}, ${Date.now()})
      RETURNING id, email, display_name, role`);
    const row = res.rows[0];
    return {
      id: String(row.id),
      email: String(row.email),
      displayName: String(row.display_name),
      role: row.role as 'owner' | 'writer',
    } satisfies AuthUser;
  };

  return {
    owner: await mk('owner@test.local', 'Owner', 'owner'),
    writer: await mk('writer@test.local', 'Writer', 'writer'),
  };
}
