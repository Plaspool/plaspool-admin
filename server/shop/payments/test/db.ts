import { sql } from 'drizzle-orm';
import type { Db } from '../../../db/client';

/**
 * Empty every table Payments writes, between tests.
 *
 * WHY NOT `freshDb()` PER TEST, which is what the older server suites do.
 * Booting PGlite and replaying the migration folder cost about two seconds when
 * this subsystem was started and about ten by the time the other three commerce
 * agents had landed their migrations — the folder is shared and grows with all
 * four. At ten seconds a boot, a thirty-test suite spends five minutes creating
 * databases and a few seconds testing, and `vitest.config.ts` already documents
 * what happens next: the file dies in `beforeAll` with every test reported as
 * SKIPPED, which is a red bar with no failing assertion anywhere to explain it.
 *
 * So the database is booted once per FILE and emptied between tests. What that
 * trades away is honest to state: a test can no longer assume a virgin
 * `__drizzle_migrations`, and anything that alters the schema (the mutation test
 * that drops a CHECK constraint) must put it back. What it keeps is the part
 * that matters — every suite still runs against a real Postgres built from the
 * real migrations, which is contract §9's evidence rule.
 *
 * ONE STATEMENT, listing all four tables. `shop_refunds` references
 * `shop_payment_intents`, so truncating them separately would need CASCADE or a
 * particular order; naming them together makes Postgres handle the dependency
 * and keeps this from breaking when a fifth table arrives.
 *
 * `users` IS NOT TRUNCATED. `freshDb()` seeds an owner and a writer,
 * `shop_refunds.created_by` references them, and re-seeding per test would put
 * two scrypt hashes back on the per-test cost this exists to remove.
 */
export async function resetPayments(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE shop_refunds, shop_payment_events, shop_payment_intents, commerce_events`,
  );
}
