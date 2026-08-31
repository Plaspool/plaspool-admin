import { PGlite, types } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { guardDb } from '../db/client';
import { migrateWithReplayCheck } from '../db/replay';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
import { hashPassword } from '../repo/password';

/**
 * A real Postgres per suite, in-process. PGlite is Postgres compiled to WASM,
 * so CTEs, jsonb, generated columns and constraints are exercised for real.
 */
export interface TestCtx {
  db: Db;
  /** One seed per role (migration 0680). `owner` and `writer` predate the
   * others and most suites use only those two. */
  users: {
    owner: AuthUser;
    writer: AuthUser;
    developer: AuthUser;
    supplyChain: AuthUser;
    support: AuthUser;
    marketing: AuthUser;
  };
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

/**
 * Make the test driver behave like the production one.
 *
 * PGlite parses int8 into a JS number; `@neondatabase/serverless` returns it as
 * a string. Left alone, every bigint read is correct in the suite and wrong in
 * production — `row.expires_at <= now` becomes a string comparison, and
 * `row.created_at + TTL` becomes concatenation. Overriding the int8 parser to
 * pass the raw string through makes PGlite the stricter of the two, so
 * `toEpochMs` is exercised for real rather than trusted (spec §9).
 *
 * Do not "fix" a test by removing this. A test that only passes with PGlite's
 * numeric int8 is a test that documents a production 500.
 */
const NEON_LIKE_PARSERS = { [types.INT8]: (value: string) => value };

export async function migratedDb(): Promise<RawCtx> {
  const client = new PGlite({ parsers: NEON_LIKE_PARSERS });
  // Guarded exactly as `getDb()` guards the production handle, so a driver
  // error that would leak query parameters fails the suite instead of shipping.
  const db = guardDb(drizzle(client, { schema }) as unknown as Db);
  // The same sequence `npm run db:migrate` runs, so every server suite pays the
  // database-level replay check: if the journal and the applied set stop
  // reconciling, every suite that boots a database says so, rather than the
  // schema quietly differing from the one production has.
  await migrateWithReplayCheck(db, 'server/db/migrations', migrate);
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
  /* The column list deliberately omits `two_factor_email`, so every seed gets
   * the DDL default (false) and login stays single-step in every suite —
   * migration 0700's header carries the argument. The 2FA suite flips the
   * column on the rows it needs. */
  const mk = async (
    email: string,
    displayName: string,
    role: import('../../shared/roles').Role,
  ) => {
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
      role: row.role as import('../../shared/roles').Role,
    } satisfies AuthUser;
  };

  return {
    owner: await mk('owner@test.local', 'Owner', 'owner'),
    writer: await mk('writer@test.local', 'Writer', 'writer'),
    developer: await mk('developer@test.local', 'Developer', 'developer'),
    supplyChain: await mk('supply@test.local', 'Supply', 'supply_chain'),
    support: await mk('support@test.local', 'Support', 'support'),
    marketing: await mk('marketing@test.local', 'Marketing', 'marketing'),
  };
}
