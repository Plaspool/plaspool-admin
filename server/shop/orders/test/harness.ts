/**
 * The Orders + Fulfillment test harness.
 *
 * A THIN WRAPPER OVER `server/test/harness.ts`, NOT A SECOND ONE. That harness is
 * what runs `migrateWithReplayCheck` — heal, migrate, reconcile — so every
 * commerce suite pays the same database-level replay check the blog suites do
 * (GAUNTLET II Part 2a Round 1 #3: migration 0002 was silently skipped on an
 * already-migrated database while `db:migrate` exited 0). It is also what
 * configures PGlite to hand int8 back as a STRING like Neon does, which is the
 * only reason a bigint read here is exercised rather than trusted.
 *
 * Building a second harness would be a second seam, and this repository's whole
 * failure history is seams.
 */
import { sql } from 'drizzle-orm';
import { freshDb, migratedDb } from '../../../test/harness';
import type { Db } from '../../../db/client';
import type { RawCtx, TestCtx } from '../../../test/harness';

export { freshDb, migratedDb };
export type { RawCtx, TestCtx };

/** One store currency in v1 (contract §13). Named so a mismatch test has something to be. */
export const TEST_CURRENCY = 'USD';

/**
 * Truncate every table this subsystem owns, so one PGlite serves a whole suite.
 *
 * TRUNCATE AND NOT DELETE, AND THAT IS LOAD-BEARING. `shop_order_lines` and
 * `shop_fulfillment_lines` both carry a `BEFORE DELETE` trigger that refuses
 * unconditionally — an order is a financial record — and `ON DELETE RESTRICT`
 * would refuse the parent anyway. TRUNCATE fires TRUNCATE triggers only, of which
 * there are none, so it is the one statement that can empty these tables. A suite
 * that could clean up with `DELETE` would be a suite whose immutability triggers
 * were not actually installed.
 *
 * Every referencing table is NAMED rather than reached with `CASCADE`: cascade
 * here would silently empty whatever a concurrently-built subsystem happens to
 * have pointed at `commerce_events`, and a test helper that quietly truncates
 * another agent's tables is a cross-subsystem failure with no error message.
 */
export async function resetOrderTables(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE shop_box_fill_items, shop_box_fills,
             shop_fulfillment_lines, shop_fulfillments, shop_order_email_intents,
             shop_order_events, shop_order_lines, shop_order_add_ons, shop_order_revisions, shop_orders,
             shop_order_event_consumptions, commerce_events`);
  /*
   * A standalone sequence is not owned by any table, so `RESTART IDENTITY` on the
   * TRUNCATE above does not touch it. Restarted explicitly so order numbers are
   * deterministic per test rather than depending on how many ran before.
   */
  await db.execute(sql`ALTER SEQUENCE shop_order_number_seq RESTART`);
}
