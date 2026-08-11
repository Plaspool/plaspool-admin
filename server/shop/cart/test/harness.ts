/**
 * The Cart + Checkout test harness.
 *
 * A THIN WRAPPER OVER `server/test/harness.ts`, NOT A SECOND ONE. The existing
 * harness is what runs `migrateWithReplayCheck` — heal, migrate, reconcile — so
 * every commerce suite pays the same database-level replay check the blog
 * suites do (GAUNTLET II Part 2a Round 1 #3: migration 0002 was silently
 * skipped on an already-migrated database while `db:migrate` exited 0).
 * Building a second one here would be a second seam, and this codebase's whole
 * failure history is seams.
 *
 * What it adds is the commerce seed: a store currency and a customer, so a
 * cart suite does not have to know how a customer row is shaped.
 */
import { sql } from 'drizzle-orm';
import { freshDb, migratedDb, SEED_PASSWORD } from '../../../test/harness';
import type { Db } from '../../../db/client';
import type { TestCtx, RawCtx } from '../../../test/harness';

export { freshDb, migratedDb, SEED_PASSWORD };
export type { TestCtx, RawCtx };

/**
 * The currency every test cart is denominated in.
 *
 * One store currency in v1 (contract §13). It is a constant here rather than an
 * inline literal so a currency-mismatch test has something to be different from.
 */
export const TEST_CURRENCY = 'USD';

/** Truncate every table this subsystem owns, so one PGlite can serve a whole suite. */
export async function resetShopTables(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE shop_reservations, shop_addresses, shop_cart_lines, shop_carts,
             shop_customer_sessions, shop_customers, commerce_events,
             shop_cart_event_consumptions
    RESTART IDENTITY CASCADE`);
}
