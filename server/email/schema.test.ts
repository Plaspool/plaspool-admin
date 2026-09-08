/**
 * The DDL is APPLIED, not merely present in a file.
 *
 * Migration `0008_email_marketing.sql` is hand-written: these four tables are
 * declared in `server/email/schema.ts`, which `drizzle.config.ts` has never heard
 * of, so drizzle-kit cannot generate them and — the half that matters — will never
 * emit DDL to undo them either. That is the rule `server/db/migrations.test.ts`
 * states for a hand-written migration, and the price of being outside the model is
 * that NOTHING TYPECHECKS THE SQL. So this suite reads the shape back out of
 * `information_schema`, `pg_constraint` and `pg_indexes` on a migrated database and
 * compares it against the declaration — the same arrangement, for the same reason,
 * as `server/repo/categories-schema.test.ts` and `server/shop/cart/schema.test.ts`.
 *
 * Several assertions below are about BEHAVIOUR rather than about names, because a
 * name is not the property that matters. An index called
 * `email_broadcast_recipients_dedupe_uq` that is not unique would satisfy every
 * catalogue check here and would still let one press of "send" enqueue the whole
 * audience twice — which is the single most expensive mistake this feature can
 * make and the only one that cannot be taken back.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../db/client';
import { migratedDb } from '../test/harness';
import {
  emailBroadcastRecipients,
  emailBroadcasts,
  emailSubscribers,
  emailTemplates,
} from './schema';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';

let db: Db;
let close: () => Promise<void>;

const T0 = 1786600000700;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  // CASCADE reaches the recipient queue through both foreign keys.
  await db.execute(sql`TRUNCATE email_templates, email_subscribers, email_broadcasts,
                                email_broadcast_recipients CASCADE`);
});

/**
 * The database column name a drizzle column object carries.
 *
 * Read off the column rather than off the property key: the two differ by design
 * (`updatedAt` is `updated_at`), and comparing property keys against
 * `information_schema` would compare two different things and pass for the wrong
 * reason. `typeof value === 'object'` is doing real work — a drizzle table object
 * also carries METHODS (`enableRLS`), and a function has a `.name` too.
 */
function nameOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean }>> {
  const res = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${table}`);
  return new Map(
    res.rows.map((row) => [
      String(row.column_name),
      { type: String(row.data_type), nullable: row.is_nullable === 'YES' },
    ]),
  );
}

/**
 * Run a statement that must be refused, and report WHY the database refused it.
 *
 * The error arrives scrubbed — `guardDb` discards the driver error and keeps
 * SQLSTATE plus the constraint name — which is exactly what these assertions want:
 * naming the constraint proves the refusal came from the constraint under test
 * rather than from a typo somewhere else in the statement.
 */
async function refused(statement: SQL): Promise<{ code: string | null; constraint: string | null }> {
  try {
    await db.execute(statement);
  } catch (err) {
    if (err instanceof DbError) return { code: err.code, constraint: err.constraint };
    throw err;
  }
  throw new Error('the statement was accepted, and it must not be');
}

const template = (name: string, html = 'body {{unsubscribe_url}}', text = 'body {{unsubscribe_url}}'): SQL =>
  sql`INSERT INTO email_templates (name, subject, html, text, updated_at)
      VALUES (${name}, 'Subject', ${html}, ${text}, ${T0})`;

const subscriber = (id: string, email: string, token = `tok-${id}`): SQL =>
  sql`INSERT INTO email_subscribers (id, email, source, token, created_at)
      VALUES (${id}::uuid, ${email}, 'manual', ${token}, ${T0})`;

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const BROADCAST = '33333333-3333-4333-8333-333333333333';

const broadcast = (id = BROADCAST, status = 'draft'): SQL =>
  sql`INSERT INTO email_broadcasts (id, subject, html, text, status, created_at)
      VALUES (${id}::uuid, 'Subject', 'html', 'text', ${status}, ${T0})`;

describe('migration 0008 is applied', () => {
  it('creates all four tables', async () => {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('email_templates', 'email_subscribers',
                            'email_broadcasts', 'email_broadcast_recipients')`);
    expect(res.rows.map((r) => String(r.table_name)).sort()).toEqual([
      'email_broadcast_recipients',
      'email_broadcasts',
      'email_subscribers',
      'email_templates',
    ]);
  });

  it('DECLARES exactly what the database has — schema.ts is not decoration', async () => {
    /*
     * The declaration is reachable, is used for `$inferSelect`, and is NOT what
     * creates the tables — migration 0008 is. So it is exactly the kind of thing
     * that rots: correct on the day it is written, silently wrong after the first
     * migration nobody mirrors into it. This reads both sides and compares them.
     */
    const pairs: [string, object][] = [
      ['email_templates', emailTemplates],
      ['email_subscribers', emailSubscribers],
      ['email_broadcasts', emailBroadcasts],
      ['email_broadcast_recipients', emailBroadcastRecipients],
    ];
    for (const [table, declared] of pairs) {
      const names = Object.values(declared).map(nameOf).filter(Boolean).sort();
      expect(names, table).toEqual([...(await columns(table)).keys()].sort());
    }
  });

  it('stores every timestamp as bigint epoch-ms, never timestamptz', async () => {
    /*
     * The rule `server/db/schema.ts` states, and it is not stylistic: a
     * `timestamptz` reads back as a `Date` from PGlite and as a string from Neon,
     * and `toEpochMs` — the function that closes that divergence — works on
     * neither.
     */
    const cols = {
      email_templates: ['updated_at'],
      email_subscribers: ['consent_at', 'unsubscribed_at', 'created_at'],
      email_broadcasts: ['created_at', 'scheduled_at', 'started_at', 'finished_at'],
      email_broadcast_recipients: ['sent_at'],
    };
    for (const [table, names] of Object.entries(cols)) {
      const found = await columns(table);
      for (const name of names) expect(found.get(name)?.type, `${table}.${name}`).toBe('bigint');
    }
  });

  it('counters are integer with a zero default, so a drain can increment them', async () => {
    // Without the default the first `sent_count + 1` is `NULL + 1` — NULL — and the
    // progress view would show nothing for the whole of a successful send.
    const cols = await columns('email_broadcasts');
    expect(cols.get('sent_count')?.type).toBe('integer');
    expect(cols.get('failed_count')?.type).toBe('integer');
    await db.execute(broadcast());
    const row = await db.execute(sql`
      SELECT sent_count, failed_count FROM email_broadcasts WHERE id = ${BROADCAST}::uuid`);
    expect(Number(row.rows[0].sent_count)).toBe(0);
    expect(Number(row.rows[0].failed_count)).toBe(0);
  });

  it('does NOT default email_subscribers.id — the token is an HMAC of it', async () => {
    /*
     * The one column in this migration that deliberately has no default, and the
     * one most likely to be "tidied" back. `addSubscriber` mints the id so it can
     * derive the token in the same breath; with a database-side default the insert
     * would have to read the id back and issue a second UPDATE, leaving a window in
     * which a subscriber exists with no unsubscribe link.
     */
    const err = await refused(sql`
      INSERT INTO email_subscribers (email, source, token, created_at)
      VALUES ('nobody@test.local', 'manual', 'tok', ${T0})`);
    expect(err.code).toBe('23502');
  });
});

describe('templates', () => {
  it('refuses a second casing of a name, which the picker cannot tell apart', async () => {
    await db.execute(template('Welcome'));
    const err = await refused(template('welcome'));
    expect(err.code).toBe('23505');
    // Named, because `server/email/repo.ts` translates exactly this constraint into
    // a 409 and re-throws anything else. A rename of the index would turn a
    // duplicate name into a 500 with nothing failing here.
    expect(err.constraint).toBe('email_templates_name_lower_uq');
  });

  it('applies the uniqueness over lower(name), not over name', async () => {
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_templates_name_lower_uq'`);
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].indexdef)).toContain('UNIQUE');
    expect(String(res.rows[0].indexdef)).toContain('lower(name)');
  });

  it('refuses an untrimmed name, which the case-insensitive index cannot see', async () => {
    // ' Welcome' and 'Welcome' have different `lower()` values, so the unique index
    // would happily hold both — two entries that look identical in every picker.
    const err = await refused(template(' Welcome'));
    expect(err.constraint).toBe('email_templates_name_ck');
  });

  it('refuses an empty html or text part — nobody sees only one', async () => {
    expect((await refused(template('A', '', 'text'))).constraint).toBe(
      'email_templates_bodies_ck',
    );
    expect((await refused(template('B', 'html', ''))).constraint).toBe(
      'email_templates_bodies_ck',
    );
  });

  it('SET NULLs updated_by rather than deleting the template with the user', async () => {
    /*
     * Asserted rather than remembered, because CASCADE is the reflex and it is
     * wrong here: a template is the business's property, not the author's, and
     * removing an account must not remove the message the business sends.
     */
    const res = await db.execute(sql`
      SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'email_templates'::regclass AND contype = 'f'`);
    expect(res.rows.map((r) => String(r.confdeltype))).toEqual(['n']);
  });
});

describe('subscribers', () => {
  it('refuses a mixed-case address, so one person cannot become two subscribers', async () => {
    // The unique index below is over the column verbatim, so without this check
    // 'Reader@x' and 'reader@x' are two rows, two copies of every broadcast, and
    // two unsubscribe links of which one keeps working.
    const err = await refused(subscriber(ID_A, 'Reader@Test.local'));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('email_subscribers_email_ck');
  });

  it('refuses a duplicate address and a duplicate token', async () => {
    await db.execute(subscriber(ID_A, 'reader@test.local'));
    expect((await refused(subscriber(ID_B, 'reader@test.local', 'tok-other'))).constraint).toBe(
      'email_subscribers_email_uq',
    );
    // The token is the entire authority of the unsubscribe route; a duplicate would
    // make one click ambiguous between two people.
    expect((await refused(subscriber(ID_B, 'other@test.local', `tok-${ID_A}`))).constraint).toBe(
      'email_subscribers_token_uq',
    );
  });

  it('refuses a source outside the three the application knows', async () => {
    // `.$type<>()` in `schema.ts` is compile-time only; this is the runtime half.
    const err = await refused(sql`
      INSERT INTO email_subscribers (id, email, source, token, created_at)
      VALUES (${ID_A}::uuid, 'reader@test.local', 'scraped', 'tok', ${T0})`);
    expect(err.constraint).toBe('email_subscribers_source_ck');
  });

  it('indexes the keyset the list route pages on', async () => {
    // Without it, `ORDER BY created_at DESC, id DESC` is a sort of the whole table
    // on every page of an audience that is only ever going to grow.
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_subscribers_keyset_idx'`);
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].indexdef)).toContain('created_at DESC');
  });
});

describe('the recipient queue', () => {
  beforeEach(async () => {
    await db.execute(broadcast(BROADCAST, 'sending'));
    await db.execute(subscriber(ID_A, 'reader@test.local'));
  });

  const enqueue = (): SQL => sql`
    INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status)
    VALUES (gen_random_uuid(), ${BROADCAST}::uuid, ${ID_A}::uuid, 'pending')`;

  it('REFUSES a second row for the same broadcast and subscriber', async () => {
    /*
     * The property the index name only claims, and the reason it exists: enqueue is
     * `INSERT … SELECT … ON CONFLICT DO NOTHING`, so this constraint is what turns a
     * second press of "send" — or a cron delivery Vercel documents as possibly
     * duplicated — into a no-op instead of a second copy of the message to
     * everybody.
     */
    await db.execute(enqueue());
    const err = await refused(enqueue());
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('email_broadcast_recipients_dedupe_uq');
  });

  it('applies the drain index PARTIALLY, on pending rows only', async () => {
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'email_broadcast_recipients_drain_idx'`);
    expect(res.rows).toHaveLength(1);
    // The predicate is the whole point: after a large send succeeds, a full index
    // would carry every delivered row forever for a query that never selects one.
    expect(String(res.rows[0].indexdef)).toContain("WHERE (status = 'pending'");
  });

  it('refuses a status outside pending|sent|failed', async () => {
    const err = await refused(sql`
      INSERT INTO email_broadcast_recipients (id, broadcast_id, subscriber_id, status)
      VALUES (gen_random_uuid(), ${BROADCAST}::uuid, ${ID_A}::uuid, 'queued')`);
    expect(err.constraint).toBe('email_broadcast_recipients_status_ck');
  });

  it('CASCADEs from both parents — a deleted broadcast owes nobody mail', async () => {
    await db.execute(enqueue());
    await db.execute(sql`DELETE FROM email_broadcasts WHERE id = ${BROADCAST}::uuid`);
    const res = await db.execute(sql`SELECT count(*) AS n FROM email_broadcast_recipients`);
    expect(Number(res.rows[0].n)).toBe(0);
  });
});

describe('broadcasts', () => {
  it('refuses a status outside draft|sending|sent|failed', async () => {
    const err = await refused(broadcast(BROADCAST, 'queued'));
    expect(err.constraint).toBe('email_broadcasts_status_ck');
  });

  it('keeps the snapshot when the template it came from is deleted', async () => {
    /*
     * The property the snapshot columns exist for, asserted end to end. "What did we
     * send in March" must stay answerable after the template has been retired, so
     * the foreign key is `ON DELETE SET NULL` and the subject, html and text are the
     * broadcast's own.
     */
    await db.execute(template('Spring'));
    const templateRow = await db.execute(sql`SELECT id FROM email_templates`);
    const templateId = String(templateRow.rows[0].id);

    await db.execute(sql`
      INSERT INTO email_broadcasts (id, template_id, subject, html, text, status, created_at)
      VALUES (${BROADCAST}::uuid, ${templateId}::uuid, 'March news', 'h', 't', 'sent', ${T0})`);
    await db.execute(sql`DELETE FROM email_templates WHERE id = ${templateId}::uuid`);

    const res = await db.execute(sql`
      SELECT template_id, subject FROM email_broadcasts WHERE id = ${BROADCAST}::uuid`);
    expect(res.rows[0].template_id).toBeNull();
    expect(String(res.rows[0].subject)).toBe('March news');
  });
});

describe('migration 0980 is applied', () => {
  it('email_broadcast_audience matches its declaration', async () => {
    const res = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'email_broadcast_audience'
       ORDER BY column_name`);
    expect(res.rows.map((r) => String(r.column_name))).toEqual(['broadcast_id', 'email']);
  });

  it('email_broadcasts carries audience_kind, defaulted to all_subscribers', async () => {
    const res = await db.execute(sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'email_broadcasts' AND column_name = 'audience_kind'`);
    expect(res.rows).toHaveLength(1);
    expect(String(res.rows[0].column_default)).toContain('all_subscribers');
    expect(String(res.rows[0].is_nullable)).toBe('NO');
  });

  it('a recipient may be skipped', async () => {
    const res = await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'email_broadcast_recipients_status_ck'`);
    expect(String(res.rows[0].def)).toContain('skipped');
  });
});
