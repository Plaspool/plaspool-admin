/**
 * The DDL of `0011_marketing.sql` is APPLIED, not merely written down.
 *
 * Migration 0011 is hand-written: these nine tables are declared in
 * `server/marketing/schema.ts`, which `drizzle.config.ts` has never heard of, so
 * drizzle-kit cannot generate them and — the half that matters — will never emit
 * DDL to undo them either. That is the rule `server/db/migrations.test.ts` states
 * for a hand-written migration, and the price of being outside the model is that
 * NOTHING TYPECHECKS THE SQL. So this suite reads the shape back out of
 * `information_schema`, `pg_constraint` and `pg_indexes` on a migrated database
 * and compares it against the declaration — the same arrangement, for the same
 * reason, as `server/email/schema.test.ts` and `server/shop/cart/schema.test.ts`.
 *
 * Most assertions below are about BEHAVIOUR rather than about names, because a
 * name is not the property that matters. An index called
 * `marketing_ledger_award_uq` that is not unique satisfies every catalogue check
 * here and still lets one return be awarded twice — points invented out of a
 * retried request, which is the one mistake in this subsystem that costs the
 * business money and cannot be taken back.
 *
 * FIXTURE LABELS ARE ABSURD ON PURPOSE ("Bottle Caps" / "canister"). Spec D11's
 * naming discipline says the product word is data, so no test may depend on the
 * seeded preset's wording; and the seed row is identified below by `seeded`, the
 * structural marker, never by its key — repeating the preset's key here would put
 * the one word `server/marketing/no-hardcoded-labels.test.ts` greps for back into
 * a file that guard reads.
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../db/client';
import { migratedDb } from '../test/harness';
import {
  marketingBalances,
  marketingBanners,
  marketingDiscountCodes,
  marketingEmailIntents,
  marketingLedger,
  marketingPrograms,
  marketingReturnEvents,
  marketingReturnRequests,
  marketingSettings,
} from './schema';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';

let db: Db;
let close: () => Promise<void>;

/** The `when` 0011 carries in the journal, reused as the fixtures' clock. */
const T0 = 1786600001000;

const MIGRATION = 'server/db/migrations/0011_marketing.sql';

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});
afterAll(() => close());

beforeEach(async () => {
  /*
   * The seeded program and the settings singleton are NOT truncated: they are
   * what the migration installs, and several assertions here are about them.
   * Programs created by a test are removed by the `seeded` flag instead, which
   * is also a small proof that the flag separates the two populations.
   */
  await db.execute(sql`TRUNCATE marketing_return_requests, marketing_return_events,
                                marketing_ledger, marketing_balances,
                                marketing_email_intents, marketing_banners,
                                marketing_discount_codes CASCADE`);
  await db.execute(sql`DELETE FROM marketing_programs WHERE seeded = false`);
});

// --------------------------------------------------------------- catalogue readers

/**
 * A drizzle column, read back as the three things the database also knows about
 * it: its column NAME, its SQL TYPE and whether it is NULLABLE.
 *
 * The name is read off the column rather than off the property key, because the
 * two differ by design (`updatedAt` is `updated_at`) and comparing property keys
 * against `information_schema` would compare two different things and pass for
 * the wrong reason. `typeof value === 'object'` is doing real work — a drizzle
 * table object also carries METHODS (`enableRLS`), and a function has a `.name`.
 *
 * `getSQLType()` happens to return exactly the vocabulary `information_schema`
 * reports (`text`, `integer`, `bigint`, `boolean`, `jsonb`, `uuid`), so the two
 * sides compare with no translation table in between — and a translation table
 * is precisely the thing that would let a drift through by being wrong itself.
 */
function columnOf(value: unknown): [string, { type: string; nullable: boolean }] | null {
  if (typeof value !== 'object' || value === null) return null;
  const col = value as { name?: unknown; notNull?: unknown; getSQLType?: unknown };
  if (typeof col.name !== 'string' || typeof col.getSQLType !== 'function') return null;
  return [col.name, { type: (col.getSQLType as () => string)(), nullable: col.notNull !== true }];
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
 * Every CHECK on a table, by name, with the expression Postgres REPARSED.
 *
 * The expression matters as much as the name. A CHECK keeps its name when its
 * predicate is weakened — `status IN ('active','paused')` edited down to
 * `status <> ''` is still `marketing_programs_status_ck` — so a suite that
 * compares only names watches a constraint be gutted and stays green.
 *
 * Whitespace is collapsed because `pg_get_constraintdef` re-emits the expression
 * from the parse tree: the formatting is Postgres's, not this file's, and it
 * wraps long predicates at a width nothing here should depend on.
 */
async function checks(table: string): Promise<Map<string, string>> {
  const res = await db.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = ${table}::regclass AND contype = 'c'`);
  return new Map(
    res.rows.map((row) => [String(row.conname), String(row.def).replace(/\s+/g, ' ')]),
  );
}

async function indexDef(name: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}`);
  return res.rows.length ? String(res.rows[0].indexdef) : null;
}

/**
 * Run a statement that must be refused, and report WHY the database refused it.
 *
 * The error arrives scrubbed — `guardDb` discards the driver error and keeps
 * SQLSTATE plus the constraint name — which is exactly what these assertions
 * want: naming the constraint proves the refusal came from the constraint under
 * test rather than from a typo elsewhere in the statement.
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

// -------------------------------------------------------------------- fixtures

const PROGRAM = 'prg_caps';
const REQUEST = 'ret_one';
const OTHER_REQUEST = 'ret_two';
const ORDER = 'ord_9001';
const EMAIL = 'dara@test.local';

const unitProgram = (id = PROGRAM, key = 'bottle-caps'): SQL => sql`
  INSERT INTO marketing_programs
    (id, key, kind, name, points_label_singular, points_label_plural,
     unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
     created_at, updated_at)
  VALUES (${id}, ${key}, 'unit_return', 'Bottle Caps', 'Bottle Cap', 'Bottle Caps',
          'canister', 'canisters', 4, 7, ${T0}, ${T0})`;

const returnRequest = (id = REQUEST, email = EMAIL, status = 'requested'): SQL => sql`
  INSERT INTO marketing_return_requests
    (id, program_id, customer_email, qty_declared, points_per_unit_snapshot, source,
     status, created_at, updated_at)
  VALUES (${id}, ${PROGRAM}, ${email}, 6, 7, 'admin', ${status}, ${T0}, ${T0})`;

const award = (id: string, requestId = REQUEST): SQL => sql`
  INSERT INTO marketing_ledger
    (id, customer_email, program_id, kind, delta, balance_after, reason,
     return_request_id, actor_type, created_at)
  VALUES (${id}, ${EMAIL}, ${PROGRAM}, 'return_award', 35, 35,
          '5 accepted × 7 = 35 Bottle Caps', ${requestId}, 'admin', ${T0})`;

const redemption = (id: string, orderId = ORDER, kind = 'redemption'): SQL => sql`
  INSERT INTO marketing_ledger
    (id, customer_email, kind, delta, balance_after, reason, order_id, actor_type, created_at)
  VALUES (${id}, ${EMAIL}, ${kind}, ${kind === 'redemption' ? -10 : 10}, 25,
          'Checkout adjustment', ${orderId}, 'system', ${T0})`;

const banner = (id: string, ctaText: string | null = null, ctaUrl: string | null = null): SQL => sql`
  INSERT INTO marketing_banners (id, title, placement, cta_text, cta_url, created_at, updated_at)
  VALUES (${id}, 'Free delivery', 'top_bar', ${ctaText}, ${ctaUrl}, ${T0}, ${T0})`;

const discount = (id: string, code: string, kind = 'percent'): SQL => sql`
  INSERT INTO marketing_discount_codes
    (id, code, kind, percent_bps, amount_minor, currency, created_at, updated_at)
  VALUES (${id}, ${code}, ${kind}, ${kind === 'percent' ? 1000 : null},
          ${kind === 'percent' ? null : 50000}, ${kind === 'percent' ? null : 'NGN'},
          ${T0}, ${T0})`;

// ------------------------------------------------------------ shape of the DDL

describe('migration 0011 is applied', () => {
  it('creates all nine tables', async () => {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'marketing_%'`);
    expect(res.rows.map((r) => String(r.table_name)).sort()).toEqual([
      'marketing_balances',
      'marketing_banners',
      'marketing_discount_codes',
      'marketing_email_intents',
      'marketing_ledger',
      'marketing_programs',
      'marketing_return_events',
      'marketing_return_requests',
      'marketing_settings',
    ]);
  });

  it('DECLARES exactly what the database has — schema.ts is not decoration', async () => {
    /*
     * The declaration is reachable, is used for `$inferSelect`, and is NOT what
     * creates the tables — migration 0011 is. So it is exactly the kind of thing
     * that rots: correct on the day it is written, silently wrong after the first
     * migration nobody mirrors into it. This reads both sides and compares them.
     *
     * NAME, TYPE AND NULLABILITY, not just name. `$inferSelect` is what the whole
     * subsystem's row types are built from, so a column declared `text` that the
     * database made `integer` — or declared nullable that the database made NOT
     * NULL — is a lie every consumer typechecks against. A name-only comparison
     * sees a matching set of strings and says nothing.
     */
    const pairs: [string, object][] = [
      ['marketing_programs', marketingPrograms],
      ['marketing_settings', marketingSettings],
      ['marketing_return_requests', marketingReturnRequests],
      ['marketing_return_events', marketingReturnEvents],
      ['marketing_ledger', marketingLedger],
      ['marketing_balances', marketingBalances],
      ['marketing_email_intents', marketingEmailIntents],
      ['marketing_banners', marketingBanners],
      ['marketing_discount_codes', marketingDiscountCodes],
    ];
    for (const [table, declared] of pairs) {
      const shape = Object.values(declared)
        .map(columnOf)
        .filter((entry) => entry !== null);
      expect(Object.fromEntries(shape), table).toEqual(
        Object.fromEntries(await columns(table)),
      );
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
      marketing_programs: ['created_at', 'updated_at'],
      marketing_settings: ['updated_at'],
      marketing_return_requests: [
        'pickup_scheduled_at',
        'scheduled_at',
        'collected_at',
        'received_at',
        'closed_at',
        'created_at',
        'updated_at',
      ],
      marketing_return_events: ['occurred_at'],
      marketing_ledger: ['created_at'],
      marketing_balances: ['updated_at'],
      marketing_email_intents: ['sent_at', 'created_at'],
      marketing_banners: ['starts_at', 'ends_at', 'created_at', 'updated_at'],
      marketing_discount_codes: ['starts_at', 'ends_at', 'created_at', 'updated_at'],
    };
    for (const [table, names] of Object.entries(cols)) {
      const found = await columns(table);
      for (const name of names) expect(found.get(name)?.type, `${table}.${name}`).toBe('bigint');
    }
  });

  it('keeps cross-domain references as TEXT with no foreign key', async () => {
    /*
     * `customer_id` (shop's), `order_id` (shop's) and `actor_id` (a `users` row)
     * are ids this subsystem stores and never joins on — spec §Global: cross-domain
     * refs are TEXT with no FK. An FK here would make a shop cleanup fail on a
     * marketing row, and would make marketing's own writes depend on a table it
     * has no ownership of.
     */
    for (const [table, column] of [
      ['marketing_return_requests', 'customer_id'],
      ['marketing_ledger', 'customer_id'],
      ['marketing_ledger', 'order_id'],
      ['marketing_ledger', 'actor_id'],
      ['marketing_balances', 'customer_id'],
      ['marketing_return_events', 'actor_id'],
    ] as const) {
      expect((await columns(table)).get(column)?.type, `${table}.${column}`).toBe('text');
    }
    const fks = await db.execute(sql`
      SELECT a.attname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'marketing_%'`);
    const constrained = fks.rows.map((row) => String(row.attname));
    for (const column of ['customer_id', 'order_id', 'actor_id']) {
      expect(constrained, column).not.toContain(column);
    }
  });

  it('carries every CHECK by name AND by predicate, exactly', async () => {
    /*
     * Exact equality per table — every name AND every expression — rather than
     * `toContain` over a list of names.
     *
     * Names alone are not the property worth pinning, and the mutation that
     * proves it is one line: edit `status IN ('active','paused')` down to
     * `status <> ''` and the constraint keeps its name, keeps its place in the
     * catalogue, and enforces nothing. Six of these CHECKs were weakened exactly
     * that way while this suite was under review and it stayed entirely green.
     * The expressions below are `pg_get_constraintdef` output — Postgres's own
     * reparse of what shipped — so this compares what the DATABASE understands,
     * not what the file appears to say.
     *
     * This is a SUPERSET of the CHECKs spec §Database names: the five
     * `*_revision_ck` guards are house hardening on the CAS columns, on the rule
     * `server/db/schema.ts` states about enum-ish and bounded columns, and a
     * revision of 0 would make `expectedRevision` ambiguous with a missing field.
     * The spec names no CHECK this file omits.
     *
     * A failure here is either a real weakening (fix the migration) or a
     * deliberate change (update the string, and know that you did).
     */
    const expected: Record<string, Record<string, string>> = {
      marketing_programs: {
        marketing_programs_key_ck:
          "CHECK (((key <> ''::text) AND (key = lower(key)) AND (key ~ '^[a-z0-9][a-z0-9_-]*$'::text)))",
        marketing_programs_kind_ck:
          "CHECK ((kind = ANY (ARRAY['unit_return'::text, 'adhoc'::text])))",
        marketing_programs_name_ck: "CHECK (((name <> ''::text) AND (name = btrim(name))))",
        marketing_programs_points_labels_ck:
          "CHECK (((points_label_singular <> ''::text) AND (points_label_plural <> ''::text)))",
        marketing_programs_min_units_ck:
          'CHECK (((min_units_per_return IS NULL) OR (min_units_per_return > 0)))',
        marketing_programs_points_per_unit_ck:
          'CHECK (((points_per_unit IS NULL) OR (points_per_unit > 0)))',
        marketing_programs_kind_fields_ck:
          "CHECK (((kind = 'unit_return'::text) = ((unit_label_singular IS NOT NULL) AND (unit_label_plural IS NOT NULL) AND (min_units_per_return IS NOT NULL) AND (points_per_unit IS NOT NULL))))",
        marketing_programs_status_ck:
          "CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))",
        marketing_programs_revision_ck: 'CHECK ((revision > 0))',
      },
      marketing_settings: {
        marketing_settings_id_ck: "CHECK ((id = 'main'::text))",
        marketing_settings_points_labels_ck:
          "CHECK (((points_label_singular <> ''::text) AND (points_label_plural <> ''::text)))",
        marketing_settings_rate_points_ck: 'CHECK ((redemption_rate_points > 0))',
        marketing_settings_rate_minor_ck: 'CHECK ((redemption_rate_minor >= 0))',
        marketing_settings_enabled_rate_ck:
          'CHECK (((NOT redemption_enabled) OR (redemption_rate_minor > 0)))',
        marketing_settings_currency_ck:
          "CHECK ((redemption_currency ~ '^[A-Z]{3}$'::text))",
        marketing_settings_min_redeem_ck: 'CHECK ((min_redeem_points >= 0))',
        marketing_settings_max_bps_ck:
          'CHECK (((max_redeem_bps >= 1) AND (max_redeem_bps <= 10000)))',
        marketing_settings_revision_ck: 'CHECK ((revision > 0))',
      },
      marketing_return_requests: {
        marketing_return_requests_email_ck:
          "CHECK (((customer_email <> ''::text) AND (customer_email = lower(customer_email))))",
        marketing_return_requests_qty_declared_ck: 'CHECK ((qty_declared > 0))',
        marketing_return_requests_qty_counts_ck:
          'CHECK ((((qty_accepted IS NULL) OR (qty_accepted >= 0)) AND ((qty_rejected IS NULL) OR (qty_rejected >= 0))))',
        marketing_return_requests_points_snapshot_ck:
          'CHECK ((points_per_unit_snapshot > 0))',
        marketing_return_requests_points_awarded_ck:
          'CHECK (((points_awarded IS NULL) OR (points_awarded >= 0)))',
        marketing_return_requests_source_ck:
          "CHECK ((source = ANY (ARRAY['customer'::text, 'admin'::text])))",
        marketing_return_requests_status_ck:
          "CHECK ((status = ANY (ARRAY['requested'::text, 'scheduled'::text, 'collected'::text, 'received'::text, 'awarded'::text, 'rejected'::text, 'cancelled'::text])))",
        marketing_return_requests_award_ck:
          "CHECK (((status <> 'awarded'::text) OR ((qty_accepted >= 1) AND (qty_rejected IS NOT NULL) AND (points_awarded = (qty_accepted * points_per_unit_snapshot)))))",
        marketing_return_requests_revision_ck: 'CHECK ((revision > 0))',
      },
      marketing_return_events: {
        marketing_return_events_type_ck:
          "CHECK ((type = ANY (ARRAY['requested'::text, 'scheduled'::text, 'collected'::text, 'received'::text, 'inspected'::text, 'rejected'::text, 'cancelled'::text, 'note'::text])))",
        marketing_return_events_actor_ck:
          "CHECK ((actor_type = ANY (ARRAY['admin'::text, 'customer'::text, 'system'::text])))",
      },
      marketing_ledger: {
        marketing_ledger_email_ck:
          "CHECK (((customer_email <> ''::text) AND (customer_email = lower(customer_email))))",
        marketing_ledger_kind_ck:
          "CHECK ((kind = ANY (ARRAY['return_award'::text, 'manual'::text, 'redemption'::text, 'redemption_release'::text])))",
        marketing_ledger_delta_ck: 'CHECK ((delta <> 0))',
        marketing_ledger_balance_after_ck: 'CHECK ((balance_after >= 0))',
        marketing_ledger_reason_ck: "CHECK ((reason <> ''::text))",
        marketing_ledger_actor_ck:
          "CHECK ((actor_type = ANY (ARRAY['admin'::text, 'customer'::text, 'system'::text])))",
        marketing_ledger_award_link_ck:
          "CHECK (((kind = 'return_award'::text) = (return_request_id IS NOT NULL)))",
        marketing_ledger_order_link_ck:
          "CHECK (((kind <> ALL (ARRAY['redemption'::text, 'redemption_release'::text])) OR (order_id IS NOT NULL)))",
        marketing_ledger_award_sign_ck:
          "CHECK (((kind <> 'return_award'::text) OR ((delta > 0) AND (program_id IS NOT NULL))))",
        marketing_ledger_redemption_sign_ck:
          "CHECK (((kind <> 'redemption'::text) OR (delta < 0)))",
        marketing_ledger_release_sign_ck:
          "CHECK (((kind <> 'redemption_release'::text) OR (delta > 0)))",
      },
      marketing_balances: {
        marketing_balances_email_ck:
          "CHECK (((customer_email <> ''::text) AND (customer_email = lower(customer_email))))",
        marketing_balances_balance_ck: 'CHECK ((balance >= 0))',
        marketing_balances_lifetime_ck: 'CHECK ((lifetime_earned >= 0))',
      },
      marketing_email_intents: {
        marketing_email_intents_kind_ck:
          "CHECK ((kind = ANY (ARRAY['return_awarded'::text, 'return_rejected'::text])))",
        marketing_email_intents_bodies_ck:
          "CHECK (((to_email <> ''::text) AND (subject <> ''::text) AND (text <> ''::text) AND (html <> ''::text)))",
        marketing_email_intents_attempts_ck: 'CHECK ((attempts >= 0))',
      },
      marketing_banners: {
        marketing_banners_title_ck: "CHECK (((title <> ''::text) AND (title = btrim(title))))",
        marketing_banners_cta_url_ck:
          "CHECK (((cta_url IS NULL) OR (cta_url ~ '^(https?://|/)'::text)))",
        marketing_banners_cta_pair_ck: 'CHECK (((cta_text IS NULL) = (cta_url IS NULL)))',
        marketing_banners_placement_ck:
          "CHECK ((placement = ANY (ARRAY['top_bar'::text, 'popup'::text, 'section'::text])))",
        marketing_banners_status_ck:
          "CHECK ((status = ANY (ARRAY['draft'::text, 'live'::text, 'archived'::text])))",
        marketing_banners_window_ck:
          'CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (ends_at > starts_at)))',
        marketing_banners_revision_ck: 'CHECK ((revision > 0))',
      },
      marketing_discount_codes: {
        marketing_discount_codes_code_ck:
          "CHECK (((code = upper(code)) AND (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'::text)))",
        marketing_discount_codes_kind_ck:
          "CHECK ((kind = ANY (ARRAY['percent'::text, 'fixed_amount'::text])))",
        marketing_discount_codes_percent_ck:
          'CHECK (((percent_bps IS NULL) OR ((percent_bps >= 1) AND (percent_bps <= 10000))))',
        marketing_discount_codes_amount_ck:
          'CHECK (((amount_minor IS NULL) OR (amount_minor > 0)))',
        marketing_discount_codes_currency_ck:
          "CHECK (((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text)))",
        marketing_discount_codes_kind_fields_ck:
          "CHECK ((((kind = 'percent'::text) = (percent_bps IS NOT NULL)) AND ((kind = 'fixed_amount'::text) = ((amount_minor IS NOT NULL) AND (currency IS NOT NULL)))))",
        marketing_discount_codes_status_ck:
          "CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))",
        marketing_discount_codes_window_ck:
          'CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (ends_at > starts_at)))',
        marketing_discount_codes_max_redemptions_ck:
          'CHECK (((max_redemptions IS NULL) OR (max_redemptions > 0)))',
        marketing_discount_codes_redeemed_count_ck: 'CHECK ((redeemed_count >= 0))',
        marketing_discount_codes_revision_ck: 'CHECK ((revision > 0))',
      },
    };
    for (const [table, defs] of Object.entries(expected)) {
      expect(Object.fromEntries(await checks(table)), table).toEqual(defs);
    }
  });
});

// ------------------------------------------------------------------- programs

describe('programs — the rename-safety wall, in the database', () => {
  it('refuses a key that is not a lowercase slug', async () => {
    /*
     * `key` is the ONE stable handle a storefront or a support conversation can
     * refer to (spec D2a): the PATCH schema has no `key` field at all, so it is
     * un-editable through the API, and this CHECK is what stops a hand-written
     * INSERT from creating the mixed-case twin the unique index cannot see.
     */
    expect((await refused(unitProgram('prg_a', 'Bottle-Caps'))).constraint).toBe(
      'marketing_programs_key_ck',
    );
    expect((await refused(unitProgram('prg_b', '-leading-dash'))).constraint).toBe(
      'marketing_programs_key_ck',
    );
    expect((await refused(unitProgram('prg_c', ''))).constraint).toBe(
      'marketing_programs_key_ck',
    );
  });

  it('refuses a duplicate key, by the named constraint the route translates', async () => {
    await db.execute(unitProgram('prg_a', 'bottle-caps'));
    const err = await refused(unitProgram('prg_b', 'bottle-caps'));
    expect(err.code).toBe('23505');
    // Named, because A3 turns exactly this constraint into
    // `409 duplicate_program_key {key}` and re-throws anything else. A rename of
    // the constraint would turn a taken key into a 500 with nothing failing here.
    expect(err.constraint).toBe('marketing_programs_key_uq');
  });

  it('couples kind to the four columns a unit-return program cannot work without', async () => {
    /*
     * A `unit_return` program with no `points_per_unit` is a program the inspect
     * statement cannot price, and a `adhoc` program carrying a `min_units_per_return`
     * is a rule nothing will ever read. Both are the same CHECK, stated as an
     * equality between "is a return program" and "has return columns".
     */
    const missingRules = await refused(sql`
      INSERT INTO marketing_programs
        (id, key, kind, name, points_label_singular, points_label_plural, created_at, updated_at)
      VALUES ('prg_a', 'bottle-caps', 'unit_return', 'Bottle Caps', 'Bottle Cap', 'Bottle Caps',
              ${T0}, ${T0})`);
    expect(missingRules.constraint).toBe('marketing_programs_kind_fields_ck');

    const adhocWithRules = await refused(sql`
      INSERT INTO marketing_programs
        (id, key, kind, name, points_label_singular, points_label_plural,
         unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
         created_at, updated_at)
      VALUES ('prg_b', 'goodwill', 'adhoc', 'Goodwill', 'Bottle Cap', 'Bottle Caps',
              'canister', 'canisters', 4, 7, ${T0}, ${T0})`);
    expect(adhocWithRules.constraint).toBe('marketing_programs_kind_fields_ck');
  });

  it('refuses a zero or negative rate, which would promise nothing per unit', async () => {
    const err = await refused(sql`
      INSERT INTO marketing_programs
        (id, key, kind, name, points_label_singular, points_label_plural,
         unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
         created_at, updated_at)
      VALUES ('prg_a', 'bottle-caps', 'unit_return', 'Bottle Caps', 'Bottle Cap', 'Bottle Caps',
              'canister', 'canisters', 4, 0, ${T0}, ${T0})`);
    expect(err.constraint).toBe('marketing_programs_points_per_unit_ck');
  });

  it('defaults a newly created program to seeded = false', async () => {
    // The "Seeded preset" chip derives from THIS column and never from matching
    // the preset's key — key-matching is precisely what
    // `no-hardcoded-labels.test.ts` greps for and forbids (spec D2c). A default
    // of `true` would badge every program.
    await db.execute(unitProgram());
    const res = await db.execute(sql`
      SELECT seeded, status, conditions, revision FROM marketing_programs WHERE id = ${PROGRAM}`);
    expect(res.rows[0].seeded).toBe(false);
    expect(String(res.rows[0].status)).toBe('active');
    expect(res.rows[0].conditions).toEqual({});
    expect(Number(res.rows[0].revision)).toBe(1);
  });
});

// ------------------------------------------------------------------- settings

describe('settings — a singleton that cannot be enabled without a rate', () => {
  it('refuses a second settings row', async () => {
    // `id = 'main'` is the singleton, as a CHECK rather than as a convention:
    // two settings rows is two answers to "what is a point worth".
    const err = await refused(sql`
      INSERT INTO marketing_settings
        (id, points_label_singular, points_label_plural, redemption_rate_points,
         redemption_rate_minor, redemption_currency, updated_at)
      VALUES ('other', 'Bottle Cap', 'Bottle Caps', 100, 0, 'NGN', ${T0})`);
    expect(err.constraint).toBe('marketing_settings_id_ck');
  });

  it('refuses enabling redemption while a point is worth zero money', async () => {
    /*
     * The CHECK that makes a forgotten review cost COPY rather than MONEY: the
     * seed ships disabled at 100 points / 0 minor, so switching redemption on
     * before somebody sets a real rate is refused by the database rather than
     * quietly discounting every cart to zero.
     */
    const err = await refused(sql`
      UPDATE marketing_settings SET redemption_enabled = true WHERE id = 'main'`);
    expect(err.constraint).toBe('marketing_settings_enabled_rate_ck');
  });

  it('refuses a redeem ceiling outside 1..10000 basis points', async () => {
    expect(
      (await refused(sql`UPDATE marketing_settings SET max_redeem_bps = 10001 WHERE id = 'main'`))
        .constraint,
    ).toBe('marketing_settings_max_bps_ck');
    expect(
      (await refused(sql`UPDATE marketing_settings SET max_redeem_bps = 0 WHERE id = 'main'`))
        .constraint,
    ).toBe('marketing_settings_max_bps_ck');
  });

  it('refuses a currency that is not an ISO-4217 code', async () => {
    const err = await refused(sql`
      UPDATE marketing_settings SET redemption_currency = 'ngn' WHERE id = 'main'`);
    expect(err.constraint).toBe('marketing_settings_currency_ck');
  });
});

// ------------------------------------------------------------ return requests

describe('return requests', () => {
  beforeEach(async () => {
    await db.execute(unitProgram());
  });

  it('refuses a mixed-case address, so one customer cannot become two', async () => {
    // Balances, ledger and the open-return index all key on this column verbatim.
    // Without the check, 'Dara@x' and 'dara@x' are two balances and two open
    // returns for one person.
    const err = await refused(returnRequest(REQUEST, 'Dara@Test.local'));
    expect(err.constraint).toBe('marketing_return_requests_email_ck');
  });

  it('allows ONE open return per email and refuses the second', async () => {
    /*
     * The partial unique, and the business rule it is (spec D4): a second
     * in-flight return for one address is two drivers dispatched to one address
     * and two awards for one pile of goods. A4 turns the 23505 into
     * `409 return_already_open {existingId, status}` so the admin UI links to the
     * request that already exists instead of dead-ending.
     */
    await db.execute(returnRequest(REQUEST, EMAIL, 'scheduled'));
    const err = await refused(returnRequest(OTHER_REQUEST, EMAIL, 'requested'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('marketing_return_requests_open_uq');
  });

  it('stops guarding once the first return is closed', async () => {
    // The predicate is what makes the rule survivable: a customer who returned
    // last month must be able to return again, and two CLOSED returns for one
    // address must not collide either.
    await db.execute(returnRequest(REQUEST, EMAIL, 'cancelled'));
    await db.execute(returnRequest(OTHER_REQUEST, EMAIL, 'requested'));
    await db.execute(returnRequest('ret_three', EMAIL, 'rejected'));
    const res = await db.execute(sql`
      SELECT count(*) AS n FROM marketing_return_requests WHERE customer_email = ${EMAIL}`);
    expect(Number(res.rows[0].n)).toBe(3);
  });

  it('applies the open-return uniqueness PARTIALLY, on the four live statuses', async () => {
    const def = await indexDef('marketing_return_requests_open_uq');
    expect(def).not.toBeNull();
    expect(def).toContain('UNIQUE');
    for (const status of ['requested', 'scheduled', 'collected', 'received']) {
      expect(def, status).toContain(`'${status}'`);
    }
  });

  it('pins the award arithmetic in the database, not only in the statement', async () => {
    /*
     * `points_awarded = qty_accepted * points_per_unit_snapshot` is computed by
     * A4's single inspect statement. This CHECK is what makes a future edit to
     * that statement — or a hand-run UPDATE during an incident — unable to award
     * a number nobody can reconstruct from the row.
     */
    await db.execute(returnRequest(REQUEST, EMAIL, 'received'));
    const wrongMath = await refused(sql`
      UPDATE marketing_return_requests
         SET status = 'awarded', qty_accepted = 5, qty_rejected = 1, points_awarded = 100
       WHERE id = ${REQUEST}`);
    expect(wrongMath.constraint).toBe('marketing_return_requests_award_ck');

    const noAcceptance = await refused(sql`
      UPDATE marketing_return_requests
         SET status = 'awarded', qty_accepted = 0, qty_rejected = 6, points_awarded = 0
       WHERE id = ${REQUEST}`);
    expect(noAcceptance.constraint).toBe('marketing_return_requests_award_ck');

    await db.execute(sql`
      UPDATE marketing_return_requests
         SET status = 'awarded', qty_accepted = 5, qty_rejected = 1, points_awarded = 35,
             closed_at = ${T0}
       WHERE id = ${REQUEST}`);
    const row = await db.execute(sql`
      SELECT points_awarded FROM marketing_return_requests WHERE id = ${REQUEST}`);
    expect(Number(row.rows[0].points_awarded)).toBe(35);
  });

  it('accepts fewer units than were declared — a driver collects what is there', async () => {
    // Deliberately NOT `qty_accepted + qty_rejected = qty_declared`: the customer
    // says six, the driver comes back with five, and a database that refuses to
    // record that forces staff to lie to it (spec D5).
    await db.execute(returnRequest(REQUEST, EMAIL, 'received'));
    await db.execute(sql`
      UPDATE marketing_return_requests
         SET status = 'awarded', qty_accepted = 4, qty_rejected = 1, points_awarded = 28
       WHERE id = ${REQUEST}`);
    const row = await db.execute(sql`
      SELECT qty_declared, qty_accepted, qty_rejected
        FROM marketing_return_requests WHERE id = ${REQUEST}`);
    expect(Number(row.rows[0].qty_declared)).toBe(6);
    expect(Number(row.rows[0].qty_accepted)).toBe(4);
  });

  it('refuses a status outside the seven the state machine knows', async () => {
    const err = await refused(returnRequest(REQUEST, EMAIL, 'in_transit'));
    expect(err.constraint).toBe('marketing_return_requests_status_ck');
  });

  it('indexes the keyset the queue pages on', async () => {
    const def = await indexDef('marketing_return_requests_keyset_idx');
    expect(def).not.toBeNull();
    expect(def).toContain('created_at DESC');
  });
});

// ------------------------------------------------------------- timeline events

describe('return events', () => {
  beforeEach(async () => {
    await db.execute(unitProgram());
    await db.execute(returnRequest());
  });

  const event = (id: string, type: string, actorType = 'admin'): SQL => sql`
    INSERT INTO marketing_return_events (id, request_id, type, actor_type, data, occurred_at)
    VALUES (${id}, ${REQUEST}, ${type}, ${actorType}, ${'{"qtyAccepted":5}'}::jsonb, ${T0})`;

  it('refuses a type or an actor the timeline cannot render', async () => {
    expect((await refused(event('mev_a', 'refunded'))).constraint).toBe(
      'marketing_return_events_type_ck',
    );
    expect((await refused(event('mev_b', 'note', 'robot'))).constraint).toBe(
      'marketing_return_events_actor_ck',
    );
  });

  it('keeps event data as jsonb, which is what carries the label snapshot', async () => {
    // The `inspected` event stores the four label values AS WRITTEN (spec D2d), so
    // a rename changes the future and never the history. That is a document, not
    // a string.
    await db.execute(event('mev_a', 'inspected'));
    expect((await columns('marketing_return_events')).get('data')?.type).toBe('jsonb');
    const res = await db.execute(sql`SELECT data FROM marketing_return_events WHERE id = 'mev_a'`);
    expect(res.rows[0].data).toEqual({ qtyAccepted: 5 });
  });

  it('indexes the timeline read', async () => {
    expect(await indexDef('marketing_return_events_request_idx')).toContain('request_id');
  });
});

// --------------------------------------------------------------------- ledger

describe('ledger — idempotency lives in partial uniques, not in code', () => {
  beforeEach(async () => {
    await db.execute(unitProgram());
    await db.execute(returnRequest());
  });

  it('REFUSES a second award for the same return', async () => {
    /*
     * The single most expensive mistake this subsystem can make: a retried
     * inspect that awards a customer twice for one pile of goods. Every guard
     * above it could be deleted and this would still be a 23505 — which is why
     * A4 reads it back as `409 already_awarded {entryId}` and the client treats
     * that as success.
     */
    await db.execute(award('pts_a'));
    const err = await refused(award('pts_b'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('marketing_ledger_award_uq');
  });

  it('REFUSES a second redemption, and a second release, for the same order', async () => {
    await db.execute(redemption('pts_a'));
    expect((await refused(redemption('pts_b'))).constraint).toBe('marketing_ledger_redemption_uq');

    // Separate index, separate row: a release is a compensating CREDIT for an
    // order that was already debited, so both must be able to exist for one order
    // and neither may exist twice.
    await db.execute(redemption('pts_c', ORDER, 'redemption_release'));
    expect((await refused(redemption('pts_d', ORDER, 'redemption_release'))).constraint).toBe(
      'marketing_ledger_release_uq',
    );
  });

  it('applies all three ledger uniques PARTIALLY, scoped to their kind', async () => {
    // Without the predicate, `UNIQUE (order_id)` would make a redemption and its
    // release collide, and `UNIQUE (return_request_id)` would forbid a manual
    // adjustment ever mentioning a return.
    for (const [name, predicate] of [
      ['marketing_ledger_award_uq', "kind = 'return_award'"],
      ['marketing_ledger_redemption_uq', "kind = 'redemption'"],
      ['marketing_ledger_release_uq', "kind = 'redemption_release'"],
    ] as const) {
      const def = await indexDef(name);
      expect(def, name).toContain('UNIQUE');
      expect(def, name).toContain(predicate);
    }
  });

  it('couples every kind to the columns that make it readable', async () => {
    // A `return_award` with no return is an award nobody can audit; a redemption
    // with no order is a debit nobody can refund.
    const awardWithoutRequest = await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, program_id, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('pts_a', ${EMAIL}, ${PROGRAM}, 'return_award', 35, 35, 'why', 'admin', ${T0})`);
    expect(awardWithoutRequest.constraint).toBe('marketing_ledger_award_link_ck');

    const redemptionWithoutOrder = await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('pts_b', ${EMAIL}, 'redemption', -10, 25, 'why', 'system', ${T0})`);
    expect(redemptionWithoutOrder.constraint).toBe('marketing_ledger_order_link_ck');
  });

  it('pins the sign of every kind', async () => {
    // An award that subtracts, or a redemption that adds, is a bug that reads as
    // a legitimate row forever afterwards.
    const negativeAward = await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, program_id, kind, delta, balance_after, reason,
         return_request_id, actor_type, created_at)
      VALUES ('pts_a', ${EMAIL}, ${PROGRAM}, 'return_award', -35, 0, 'why', ${REQUEST},
              'admin', ${T0})`);
    expect(negativeAward.constraint).toBe('marketing_ledger_award_sign_ck');

    const positiveRedemption = await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, order_id, actor_type, created_at)
      VALUES ('pts_b', ${EMAIL}, 'redemption', 10, 35, 'why', ${ORDER}, 'system', ${T0})`);
    expect(positiveRedemption.constraint).toBe('marketing_ledger_redemption_sign_ck');

    // The third sign, and the one it is easiest to leave unpinned: a RELEASE is
    // the compensating credit for a cancelled order, so a negative one debits a
    // customer a second time for a purchase that never happened.
    const negativeRelease = await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, order_id, actor_type, created_at)
      VALUES ('pts_c', ${EMAIL}, 'redemption_release', -10, 15, 'why', ${ORDER}, 'system', ${T0})`);
    expect(negativeRelease.constraint).toBe('marketing_ledger_release_sign_ck');
  });

  it('refuses a zero delta, an empty reason and a negative running balance', async () => {
    // A zero-delta row is a ledger entry that changes nothing and still has to be
    // explained to a customer; `balance_after` is what the UI renders as
    // "120 → 180", so a negative one is a screen nobody can act on.
    expect(
      (
        await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('pts_a', ${EMAIL}, 'manual', 0, 35, 'why', 'admin', ${T0})`)
      ).constraint,
    ).toBe('marketing_ledger_delta_ck');

    expect(
      (
        await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('pts_b', ${EMAIL}, 'manual', 10, 35, '', 'admin', ${T0})`)
      ).constraint,
    ).toBe('marketing_ledger_reason_ck');

    expect(
      (
        await refused(sql`
      INSERT INTO marketing_ledger
        (id, customer_email, kind, delta, balance_after, reason, actor_type, created_at)
      VALUES ('pts_c', ${EMAIL}, 'manual', -10, -10, 'why', 'admin', ${T0})`)
      ).constraint,
    ).toBe('marketing_ledger_balance_after_ck');
  });

  it('indexes a customer’s ledger in the order the page reads it', async () => {
    expect(await indexDef('marketing_ledger_customer_idx')).toContain('created_at DESC');
  });
});

// ------------------------------------------------------------------- balances

describe('balances — the O(1) counter, floored at zero', () => {
  it('refuses a negative balance, which no debit may ever produce', async () => {
    /*
     * The backstop under spec D3's guarded debit
     * (`UPDATE … SET balance = balance - $x WHERE balance >= $x`). The guard is
     * what makes the concurrent-debit race unwinnable; this is what makes a
     * FUTURE debit written without the guard fail loudly instead of handing a
     * customer a negative wallet.
     */
    await db.execute(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES (${EMAIL}, 50, 50, ${T0})`);
    const err = await refused(sql`
      UPDATE marketing_balances SET balance = balance - 60 WHERE customer_email = ${EMAIL}`);
    expect(err.constraint).toBe('marketing_balances_balance_ck');
  });

  it('keys on the lowercase address, one row per customer', async () => {
    await db.execute(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES (${EMAIL}, 50, 50, ${T0})`);
    expect(
      (
        await refused(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES (${EMAIL}, 10, 10, ${T0})`)
      ).code,
    ).toBe('23505');
    expect(
      (
        await refused(sql`
      INSERT INTO marketing_balances (customer_email, balance, lifetime_earned, updated_at)
      VALUES ('Dara@Test.local', 10, 10, ${T0})`)
      ).constraint,
    ).toBe('marketing_balances_email_ck');
  });
});

// -------------------------------------------------------------- email intents

describe('email intents — the outbox', () => {
  beforeEach(async () => {
    await db.execute(unitProgram());
    await db.execute(returnRequest());
  });

  const intent = (id: string, kind = 'return_awarded', key = `${kind}:${REQUEST}`): SQL => sql`
    INSERT INTO marketing_email_intents
      (id, kind, return_request_id, dedupe_key, to_email, subject, text, html, created_at)
    VALUES (${id}, ${kind}, ${REQUEST}, ${key}, ${EMAIL}, 'You earned 35 Bottle Caps',
            'body', '<p>body</p>', ${T0})`;

  it('REFUSES a second intent for the same kind and request', async () => {
    // The intent is inserted in the SAME statement as the transition that owes
    // it, with `ON CONFLICT (dedupe_key) DO NOTHING` — so this constraint is what
    // turns a replayed inspect into a no-op instead of a second mail to a
    // customer telling them they earned points twice.
    await db.execute(intent('mmi_a'));
    const err = await refused(intent('mmi_b'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('marketing_email_intents_dedupe_uq');
  });

  it('refuses an empty subject or body — nobody sees only one part', async () => {
    // `server/mail/port.ts` states the rule: text and html are both required.
    const err = await refused(sql`
      INSERT INTO marketing_email_intents
        (id, kind, return_request_id, dedupe_key, to_email, subject, text, html, created_at)
      VALUES ('mmi_a', 'return_awarded', ${REQUEST}, 'k', ${EMAIL}, 'Subject', '', '<p>x</p>',
              ${T0})`);
    expect(err.constraint).toBe('marketing_email_intents_bodies_ck');
  });

  it('applies the sweep index PARTIALLY, on unsent rows only', async () => {
    // After a year of awards the unsent rows are a vanishing fraction of the
    // table, and a full index would carry every delivered row forever for a
    // predicate that never selects one.
    const def = await indexDef('marketing_email_intents_pending_idx');
    expect(def).toContain('WHERE (sent_at IS NULL)');
  });
});

// -------------------------------------------------------------------- banners

describe('banners', () => {
  it('refuses a call to action that is only half written', async () => {
    // A CTA with a label and no destination renders as a dead button on the
    // storefront; a destination with no label renders as nothing at all.
    expect((await refused(banner('bnr_a', 'Shop now', null))).constraint).toBe(
      'marketing_banners_cta_pair_ck',
    );
    expect((await refused(banner('bnr_b', null, '/shop'))).constraint).toBe(
      'marketing_banners_cta_pair_ck',
    );
    await db.execute(banner('bnr_c', 'Shop now', '/shop'));
    await db.execute(banner('bnr_d', 'Shop now', 'https://example.test/shop'));
  });

  it('refuses a CTA destination that is neither absolute http(s) nor site-relative', async () => {
    // `javascript:` on a banner the public endpoint serves is a stored XSS with a
    // publish button in front of it.
    const err = await refused(banner('bnr_a', 'Shop now', 'javascript:alert(1)'));
    expect(err.constraint).toBe('marketing_banners_cta_url_ck');
  });

  it('refuses a schedule window that ends before it starts', async () => {
    // The public route's read-time predicate is `starts_at <= now AND ends_at >
    // now`; an inverted window is a banner that can never satisfy both and that
    // nobody can tell from a banner that simply is not live yet.
    const err = await refused(sql`
      INSERT INTO marketing_banners (id, title, placement, starts_at, ends_at, created_at, updated_at)
      VALUES ('bnr_a', 'Free delivery', 'top_bar', ${T0 + 1000}, ${T0}, ${T0}, ${T0})`);
    expect(err.constraint).toBe('marketing_banners_window_ck');
  });

  it('starts life as a draft with an empty body and zero priority', async () => {
    await db.execute(banner('bnr_a'));
    const res = await db.execute(sql`
      SELECT status, body, priority, revision FROM marketing_banners WHERE id = 'bnr_a'`);
    expect(String(res.rows[0].status)).toBe('draft');
    expect(String(res.rows[0].body)).toBe('');
    expect(Number(res.rows[0].priority)).toBe(0);
    expect(Number(res.rows[0].revision)).toBe(1);
  });

  it('indexes the public read', async () => {
    const def = await indexDef('marketing_banners_live_idx');
    expect(def).toContain('priority DESC');
  });
});

// ------------------------------------------------------------------ discounts

describe('discount codes', () => {
  it('refuses a code that is not already uppercase', async () => {
    // The route uppercases before validating, so a lowercase row can only arrive
    // from a hand-written statement — and 'SUMMER' and 'summer' as two rows is a
    // customer typing one and being told it does not exist.
    const err = await refused(discount('dsc_a', 'summer10'));
    expect(err.constraint).toBe('marketing_discount_codes_code_ck');
  });

  it('refuses a duplicate code, by the named constraint the route translates', async () => {
    await db.execute(discount('dsc_a', 'SUMMER10'));
    const err = await refused(discount('dsc_b', 'SUMMER10'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('marketing_discount_codes_code_uq');
  });

  it('couples kind to the value columns it is priced from', async () => {
    // A percent discount with an amount, or a fixed amount with no currency, is a
    // discount `computeTotals` cannot apply.
    const percentWithAmount = await refused(sql`
      INSERT INTO marketing_discount_codes
        (id, code, kind, percent_bps, amount_minor, currency, created_at, updated_at)
      VALUES ('dsc_a', 'SUMMER10', 'percent', 1000, 50000, 'NGN', ${T0}, ${T0})`);
    expect(percentWithAmount.constraint).toBe('marketing_discount_codes_kind_fields_ck');

    const fixedWithoutCurrency = await refused(sql`
      INSERT INTO marketing_discount_codes
        (id, code, kind, amount_minor, created_at, updated_at)
      VALUES ('dsc_b', 'FLAT500', 'fixed_amount', 50000, ${T0}, ${T0})`);
    expect(fixedWithoutCurrency.constraint).toBe('marketing_discount_codes_kind_fields_ck');

    await db.execute(discount('dsc_c', 'FLAT500', 'fixed_amount'));
  });
});

// ---------------------------------------------------------------------- seeds

describe('the seeds migration 0011 installs', () => {
  it('installs exactly one preset program, flagged seeded', async () => {
    /*
     * Identified by `seeded`, NOT by its key. The whole design says the preset's
     * wording is data a shop can rename on day one (spec D2), and the UI's
     * "Seeded preset" chip derives from this column for the same reason — so a
     * test that pinned the preset's name would be the one piece of key-matching
     * the naming guards exist to forbid, just relocated into a test file.
     *
     * What IS pinned is everything a consumer depends on: it is a unit-return
     * program, it is active, its rules are the numbers the owner was asked to
     * review, and its labels are non-empty in all four slots.
     */
    const res = await db.execute(sql`
      SELECT id, key, kind, name, points_label_singular, points_label_plural,
             unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
             status, conditions, revision, created_at
        FROM marketing_programs WHERE seeded = true`);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(String(row.kind)).toBe('unit_return');
    expect(String(row.status)).toBe('active');
    expect(Number(row.min_units_per_return)).toBe(5);
    expect(Number(row.points_per_unit)).toBe(10);
    expect(row.conditions).toEqual({});
    // `revision === 1` is what drives the Overview first-run checklist's "review
    // the preset naming" item, so an untouched seed has to read as untouched.
    expect(Number(row.revision)).toBe(1);
    for (const column of [
      'name',
      'points_label_singular',
      'points_label_plural',
      'unit_label_singular',
      'unit_label_plural',
    ]) {
      expect(String(row[column]).length, column).toBeGreaterThan(0);
    }
    // The key is the one un-editable handle (D2a): shaped by the CHECK, and
    // therefore safe to hand a storefront.
    expect(String(row.key)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    // A fixed authoring-time constant, not `now()`: a migration that stamps the
    // wall clock makes two databases disagree about when the shop opened.
    expect(Number(row.created_at)).toBe(T0);
  });

  it('installs the settings singleton, disabled, pointing at the preset', async () => {
    const res = await db.execute(sql`
      SELECT s.id, s.redemption_enabled, s.redemption_rate_points, s.redemption_rate_minor,
             s.redemption_currency, s.min_redeem_points, s.max_redeem_bps, s.revision,
             p.seeded AS default_is_seeded
        FROM marketing_settings s
        LEFT JOIN marketing_programs p ON p.id = s.default_return_program_id`);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(String(row.id)).toBe('main');
    // Ships OFF at a zero money rate: the CHECK then forbids enabling it until
    // somebody sets a real one, so a forgotten review costs copy, never money.
    expect(row.redemption_enabled).toBe(false);
    expect(Number(row.redemption_rate_minor)).toBe(0);
    expect(Number(row.redemption_rate_points)).toBeGreaterThan(0);
    expect(String(row.redemption_currency)).toMatch(/^[A-Z]{3}$/);
    expect(Number(row.max_redeem_bps)).toBe(10000);
    expect(Number(row.min_redeem_points)).toBe(0);
    // Resolved through the FK — the admin intake route defaults its program from
    // here, so a dangling pointer is every new return failing.
    expect(row.default_is_seeded).toBe(true);
  });

  it('re-running 0011’s seed statements changes nothing', async () => {
    /*
     * `ON CONFLICT DO NOTHING`, asserted rather than assumed. `db:migrate` is run
     * by hand against a live database (nothing applies migrations on deploy), and
     * a healed or replayed ledger can re-issue a file that already ran. A seed
     * without the conflict clause would fail the whole migration the second time;
     * a seed with `DO UPDATE` would resurrect the preset's original wording over
     * a rename the shop made months ago (spec D2b).
     *
     * The statements are read out of the migration rather than restated here, so
     * this cannot drift from what actually ships — and so the preset's wording
     * stays confined to the one file allowed to hold it.
     */
    const before = await db.execute(sql`
      SELECT (SELECT count(*) FROM marketing_programs) AS programs,
             (SELECT count(*) FROM marketing_settings) AS settings,
             (SELECT name FROM marketing_programs WHERE seeded = true) AS preset_name`);
    await db.execute(sql`UPDATE marketing_programs SET name = 'Renamed By The Shop'
                          WHERE seeded = true`);

    const seeds = readFileSync(MIGRATION, 'utf8')
      .split('--> statement-breakpoint')
      .filter((statement) => /\bINSERT\s+INTO\b/i.test(statement));
    expect(seeds.length, 'no seed statements found in the migration').toBeGreaterThanOrEqual(2);
    for (const statement of seeds) await db.execute(sql.raw(statement));

    const after = await db.execute(sql`
      SELECT (SELECT count(*) FROM marketing_programs) AS programs,
             (SELECT count(*) FROM marketing_settings) AS settings,
             (SELECT name FROM marketing_programs WHERE seeded = true) AS preset_name`);
    expect(Number(after.rows[0].programs)).toBe(Number(before.rows[0].programs));
    expect(Number(after.rows[0].settings)).toBe(Number(before.rows[0].settings));
    // The rename survives the replay — the half `DO UPDATE` would break.
    expect(String(after.rows[0].preset_name)).toBe('Renamed By The Shop');

    await db.execute(sql`UPDATE marketing_programs SET name = ${String(before.rows[0].preset_name)}
                          WHERE seeded = true`);
  });
});
