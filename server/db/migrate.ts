/**
 * Apply the checked-in migrations to the configured database. `npm run db:migrate`.
 *
 * Nothing else applies them. Before this file the schema existed only inside
 * PGlite, rebuilt from `server/db/migrations/` by every test run — so the suite
 * was green against a schema no real database had ever seen.
 *
 * Two deliberate choices:
 *
 * - **`drizzle-orm/neon-http/migrator`, not `drizzle-kit migrate`.** The
 *   neon-http migrator applies each statement on its own, because the HTTP
 *   driver throws unconditionally on `transaction()`. The generic pg-core
 *   migrator wraps the run in `session.transaction(...)`, which is exactly the
 *   PGlite-passes / production-500 divergence spec §9 exists to stop. Running
 *   the same driver production runs is the point.
 * - **`generate` then `migrate`, never `push`.** See the warning in
 *   `drizzle.config.ts`: `push` diffs against `meta/0000_snapshot.json`, which
 *   does not know about the hand-appended search DDL, and would drop it.
 *
 * The full application environment must be present — this goes through
 * `getEnv()` rather than reading `process.env.DATABASE_URL` directly, so a
 * migration cannot be run against a deployment whose configuration would fail
 * to boot.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import * as schema from './schema';
import { getEnv } from '../env';

/** The one folder. `server/test/harness.ts` migrates PGlite from the same path. */
export const MIGRATIONS_FOLDER = 'server/db/migrations';

const db = drizzle(neon(getEnv().DATABASE_URL), { schema });
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
// eslint-disable-next-line no-console -- this is a CLI entrypoint
console.log(`applied migrations from ${MIGRATIONS_FOLDER}`);
