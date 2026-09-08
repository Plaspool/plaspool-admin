import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedDb } from '../../test/harness';
import { shopNotificationSettings } from './schema';
import type { Db } from '../../db/client';

/**
 * THE DDL IS APPLIED, NOT MERELY PRESENT IN A FILE (contract §8).
 *
 * Migration 0980 is hand-written and `drizzle.config.ts` names only
 * `server/db/schema.ts`, so drizzle-kit has never seen this table: the
 * declaration in `schema.ts` and the `CREATE TABLE` in the migration were typed
 * out twice, by hand, and nothing in the build reconciles them. This suite is
 * that reconciliation — it reads the shape back out of `information_schema` and
 * `pg_constraint` and compares it with the declaration, which is the same job
 * `settings/schema.test.ts` does for 0760 and `cart/schema.test.ts` does for
 * Cart's tables, and the reason CLAUDE.md §4 says to verify a migration by
 * querying the catalog rather than by re-reading the file.
 *
 * IT ALSO COVERS THE HALF OF 0980 THAT IS NOT THIS TABLE. The migration DROPs
 * and re-ADDs `shop_order_email_intents_kind_ck` to admit `staff_new_order`,
 * and `orders/schema.test.ts` asserts only the first seven kinds — so until the
 * block at the foot of this file, nothing anywhere failed if the widening had
 * been left out or had failed halfway.
 */

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = ${table}`);
  return new Map(
    res.rows.map((row) => [
      String(row.column_name),
      { type: String(row.data_type), nullable: row.is_nullable === 'YES' },
    ]),
  );
}

async function checkNames(table: string): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = ${table} AND c.contype = 'c'
     ORDER BY c.conname`);
  return res.rows.map((row) => String(row.conname));
}

describe('shop_notification_settings (migration 0980)', () => {
  it('has exactly the columns the declaration names', async () => {
    const applied = await columns('shop_notification_settings');
    const declared = Object.values(shopNotificationSettings)
      .map((value) =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { name?: unknown }).name === 'string'
          ? String((value as { name: string }).name)
          : '',
      )
      .filter((name) => name !== '');
    for (const name of declared) expect([...applied.keys()]).toContain(name);
    /* And nothing the declaration does NOT name: a column that exists only in
       the database is one `$inferSelect` cannot see, so a later read of it is a
       compile error at best and an undefined at worst. */
    expect([...applied.keys()].sort()).toEqual(
      [
        'id',
        'notify_on_order',
        'notify_team',
        'order_recipients',
        'revision',
        'updated_at',
        'updated_by',
      ].sort(),
    );
  });

  it('stores the timestamp as bigint epoch-ms, never timestamptz', async () => {
    const applied = await columns('shop_notification_settings');
    expect(applied.get('updated_at')).toEqual({ type: 'bigint', nullable: false });
    /* `revision` is a plain integer and PGlite and Neon agree about those.
       `updated_at` is the only int8 here, which is why `rowToSettings` runs
       exactly one value through `toEpochMs`. */
    expect(applied.get('revision')?.type).toBe('integer');
  });

  it('holds the recipients as a text array, and only the author may be null', async () => {
    const applied = await columns('shop_notification_settings');
    expect(applied.get('order_recipients')).toEqual({ type: 'ARRAY', nullable: false });
    /* `ON DELETE SET NULL` on `updated_by`: a teammate can be deleted and the
       row that records their last save has to survive it. Everything else is
       NOT NULL, which is what lets `rowToSettings` read booleans as booleans. */
    expect(applied.get('updated_by')?.nullable).toBe(true);
    expect(applied.get('notify_team')).toEqual({ type: 'boolean', nullable: false });
    expect(applied.get('notify_on_order')).toEqual({ type: 'boolean', nullable: false });
  });

  it('carries the three checks the declaration names', async () => {
    expect(await checkNames('shop_notification_settings')).toEqual([
      'shop_notification_settings_id_ck',
      'shop_notification_settings_recipients_ck',
      'shop_notification_settings_revision_ck',
    ]);
  });

  /*
   * THE SEED IS THE FEATURE SWITCHED ON. The owner asked for notifications that
   * work the moment they deploy rather than a feature that sits inert until
   * somebody finds the settings screen, so both switches are seeded TRUE and an
   * empty typed list still reaches the roster. A seed that shipped `false`
   * would leave a shop believing it was being told about orders and hearing
   * nothing, which is a silence nobody investigates.
   */
  it('is seeded switched on, with nobody typed in', async () => {
    const res = await db.execute(sql`
      SELECT id, order_recipients, notify_team, notify_on_order, revision, updated_by
        FROM shop_notification_settings`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      id: 'main',
      order_recipients: [],
      notify_team: true,
      notify_on_order: true,
      updated_by: null,
    });
    expect(Number(res.rows[0]?.revision)).toBe(1);
  });

  it('refuses a second row — the singleton is the database’s rule, not a convention', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO shop_notification_settings (id, notify_team, notify_on_order, revision, updated_at)
        VALUES ('other', true, true, 1, 1)`),
    ).rejects.toThrow();
  });

  it('refuses a revision of zero — the CAS compares against a number that moves', async () => {
    await expect(
      db.execute(sql`UPDATE shop_notification_settings SET revision = 0 WHERE id = 'main'`),
    ).rejects.toThrow();
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE DELIBERATE DIFFERENCE FROM 0760, ASSERTED SO NOBODY "FIXES" IT.
   *
   * `shop_delivery_settings.served_regions` carries a cardinality clause and an
   * empty array there is refused, because an empty list would mean "serve
   * nowhere" and shut the shop with one cleared field. Here an empty list means
   * "nobody EXTRA" — the team roster is where the recipients usually come from
   * — and that is the ordinary state of most shops. A constraint forbidding it
   * would force an operator to invent an address in order to say "just the
   * team".
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('accepts an EMPTY recipient list — "nobody extra" is the ordinary state', async () => {
    await db.execute(
      sql`UPDATE shop_notification_settings
             SET order_recipients = ARRAY['ops@plaspool.com']::text[] WHERE id = 'main'`,
    );
    await db.execute(
      sql`UPDATE shop_notification_settings SET order_recipients = '{}' WHERE id = 'main'`,
    );
    const res = await db.execute(
      sql`SELECT order_recipients FROM shop_notification_settings WHERE id = 'main'`,
    );
    expect(res.rows[0]?.order_recipients).toEqual([]);
  });

  /* What IS forbidden is an element the mailer would try to send to and which
     could never be an address. Both are found with `array_position` rather than
     by unnesting, because a CHECK may not contain a subquery and `unnest` in
     one is a subquery. */
  it('refuses a blank or NULL element inside the recipient list', async () => {
    await expect(
      db.execute(
        sql`UPDATE shop_notification_settings
               SET order_recipients = ARRAY['ops@plaspool.com','']::text[] WHERE id = 'main'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`UPDATE shop_notification_settings
               SET order_recipients = ARRAY['ops@plaspool.com',NULL]::text[] WHERE id = 'main'`,
      ),
    ).rejects.toThrow();
  });
});

/**
 * The outbox's kind check, after 0980 widened it.
 *
 * READ OUT OF `pg_constraint`, NOT OUT OF THE .sql FILE, for the reason
 * `orders/schema.test.ts` gives about this same constraint: Postgres cannot
 * widen a CHECK in place, so 0980 DROPs it and re-ADDs it — and a migration
 * that runs the DROP and then fails on the ADD leaves the column with NO
 * constraint at all, accepting every kind silently while the file on disk still
 * reads correctly. `pg_get_constraintdef` is Postgres's own reparse of what
 * actually shipped, and it can tell those two apart.
 */
describe('shop_order_email_intents_kind_ck, widened by 0980', () => {
  async function constraintDef(): Promise<string> {
    const res = await db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'shop_order_email_intents'
         AND c.conname = 'shop_order_email_intents_kind_ck'`);
    expect(res.rows).toHaveLength(1);
    return String(res.rows[0].def);
  }

  it('admits staff_new_order — the first kind on this table whose reader is staff', async () => {
    expect(await constraintDef()).toContain(`'staff_new_order'::text`);
  });

  /* The full list is restated by every widening because there is no syntax for
     appending to one, so the risk each time is a kind dropped by a typo — which
     nothing notices until the day an order of that kind needs mailing. */
  it('still admits every kind the four earlier widenings added', async () => {
    const def = await constraintDef();
    for (const kind of [
      'placed',
      'confirmation',
      'shipment',
      'delivered',
      'cancellation',
      'refund',
      'refund_failed',
      'review_invite',
      'review_approved',
    ]) {
      expect(def).toContain(`'${kind}'::text`);
    }
  });
});
