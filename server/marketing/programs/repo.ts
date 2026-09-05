import { sql } from 'drizzle-orm';
import { toEpochMs, uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { DuplicateProgramKeyError, StaleMarketingWriteError } from '../errors';
import { ID, newId } from '../ids';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Rewards programs — the rows every customer-facing noun in this subsystem is
 * read out of (spec D2).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS FILE EXISTS TO PROTECT: a program's WORDS are editable and
 * its IDENTITY is not.
 *
 * `key` is the only stable handle a program has. Return requests, ledger rows
 * and the settings' default pointer all hang off the `id` it identifies, and the
 * public rewards endpoint renders a storefront page out of the labels. So
 * `patchProgram` has no way to write `key` or `kind` — not a guard that refuses
 * one, but a SET clause that has no such column in it, behind a `.strict()`
 * schema in `routes.ts` that has no such field. Two structural walls rather than
 * one check, because a check is a line somebody can delete while the tests stay
 * green (`routes.test.ts` pins both).
 *
 * Everything else — the name, both points words, both unit words, the two rule
 * numbers, the status — is a rename away from being something else entirely, and
 * nothing in this codebase may match on any of them.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Contract §Types `Program`, and the frozen wire shape of every route here. */
export interface Program {
  id: string;
  /** Immutable. See the header. */
  key: string;
  kind: 'unit_return' | 'adhoc';
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  /** Null on `adhoc`: points granted by hand count no units. */
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
  minUnitsPerReturn: number | null;
  pointsPerUnit: number | null;
  /**
   * WHAT ONE ACCEPTED UNIT COSTS US, minor units (0920) — the reward side of
   * the cost-per-unit figure, and deliberately NOT derived from
   * `pointsPerUnit`. What a point is worth lives in `marketing_settings` as a
   * redemption rate that ships as a placeholder at zero; costing the programme
   * through it would print nothing but zeroes until somebody set it and then
   * re-price all of history the day they did.
   *
   * NULL means nobody has said. The analytics screen reports that as missing
   * rather than as a confident ₦0.
   */
  unitCostMinor: number | null;
  /** What buying one NEW costs, minor units — the benchmark the saving is
   *  measured against. Live rather than snapshotted onto returns: it is a
   *  comparison against today's market, and the screen says so. */
  unitMarketCostMinor: number | null;
  status: 'active' | 'paused';
  /** The reserved extension point, pinned to `{}` in v1 by the create schema
   *  simply having no such field. */
  conditions: Record<string, never>;
  /** True only for rows migration 0011 installed — the sole input to the UI's
   *  "Seeded preset" chip, which may never be derived by matching a key. */
  seeded: boolean;
  /** Lifetime points awarded under this program. */
  awardedTotal: number;
  /** Return requests not yet awarded, rejected or cancelled. */
  openReturns: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Contract #2's body, after validation. The union is the shape, not a check —
 *  see `routes.ts`. */
export interface ProgramDraft {
  key: string;
  kind: 'unit_return' | 'adhoc';
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular?: string;
  unitLabelPlural?: string;
  minUnitsPerReturn?: number;
  pointsPerUnit?: number;
  /** Optional at creation: a programme is complete without a money rate, it
   *  just cannot be costed until one is set. */
  unitCostMinor?: number;
  unitMarketCostMinor?: number;
}

/** Contract #3's body minus `expectedRevision`. NOTE WHAT IS ABSENT: `key`,
 *  `kind`, `conditions`, `seeded`. */
export interface ProgramPatch {
  name?: string;
  pointsLabelSingular?: string;
  pointsLabelPlural?: string;
  unitLabelSingular?: string;
  unitLabelPlural?: string;
  minUnitsPerReturn?: number;
  pointsPerUnit?: number;
  /** `null` CLEARS the rate — "we have not decided what a unit costs us",
   *  which is a different statement from "it costs nothing" and the only way
   *  to undo a figure typed by mistake. */
  unitCostMinor?: number | null;
  unitMarketCostMinor?: number | null;
  status?: 'active' | 'paused';
}

export interface WriteOptions {
  /** The signed-in owner. Recorded as `created_by` on the row it creates. */
  actorId: string;
  /** ONE clock reading per write, passed in rather than taken here, so a row's
   *  `created_at` and `updated_at` cannot differ by a millisecond of scheduling. */
  now: number;
}

/** The index whose violation is somebody choosing a taken key rather than a bug. */
const PROGRAM_KEY_UQ = 'marketing_programs_key_uq';

/** Bare names, so one list serves a `SELECT` and a `RETURNING`. */
const PROGRAM_COLUMNS = sql.raw(
  `id, key, kind, name, points_label_singular, points_label_plural,
   unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
   unit_cost_minor, unit_market_cost_minor,
   status, conditions, seeded, revision, created_at, updated_at`,
);

/**
 * The statuses that make a return "open" — the ones an admin still owes work on.
 *
 * The same four the partial unique index uses for one-open-return-per-customer
 * (migration 0011). Written out rather than derived, because they are a business
 * definition ("still in flight") that happens to coincide with the index's, and
 * the day the two diverge should be a decision rather than a surprise.
 */
const OPEN_STATUSES = ['requested', 'scheduled', 'collected', 'received'] as const;

/**
 * `awardedTotal` and `openReturns` as two correlated sub-selects over a program
 * row.
 *
 * SUB-SELECTS AND NOT A `GROUP BY`, for the reason `email/repo.ts` gives about
 * `recipient_count`: a grouped join would need two LEFT JOINs to two tables with
 * different grains and would multiply the award rows by the request rows —
 * `count(DISTINCT …)` to unpick something that was never a join in the first
 * place. Two scalar subqueries are what the question actually is, and they run
 * unchanged over a CTE, which is what lets the create and patch statements return
 * a complete `Program` without a second round trip.
 *
 * `alias` is written a few lines above every call site and never comes from a
 * request — the `emitEvent` rule for the one thing that cannot be a bound
 * parameter, an identifier. Every VALUE below still is one.
 */
function aggregates(alias: string): SQL {
  const programId = sql.raw(`${alias}.id`);
  const open = sql.join(
    OPEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`
    (SELECT coalesce(sum(l.delta), 0) FROM marketing_ledger l
      WHERE l.program_id = ${programId} AND l.kind = ${'return_award'}) AS awarded_total,
    (SELECT count(*) FROM marketing_return_requests r
      WHERE r.program_id = ${programId} AND r.status IN (${open})) AS open_returns`;
}

function rowToProgram(row: Record<string, unknown>): Program {
  return {
    id: String(row.id),
    key: String(row.key),
    kind: row.kind as Program['kind'],
    name: String(row.name),
    pointsLabelSingular: String(row.points_label_singular),
    pointsLabelPlural: String(row.points_label_plural),
    unitLabelSingular: row.unit_label_singular == null ? null : String(row.unit_label_singular),
    unitLabelPlural: row.unit_label_plural == null ? null : String(row.unit_label_plural),
    minUnitsPerReturn:
      row.min_units_per_return == null ? null : Number(row.min_units_per_return),
    pointsPerUnit: row.points_per_unit == null ? null : Number(row.points_per_unit),
    unitCostMinor: row.unit_cost_minor == null ? null : Number(row.unit_cost_minor),
    unitMarketCostMinor:
      row.unit_market_cost_minor == null ? null : Number(row.unit_market_cost_minor),
    status: row.status as Program['status'],
    conditions: (row.conditions ?? {}) as Record<string, never>,
    /*
     * `=== true` rather than a cast. Both drivers return a real boolean here, but
     * this is the field the "Seeded preset" chip renders from, and a truthy
     * string would light it up for every row.
     */
    seeded: row.seeded === true,
    /*
     * `Number`, and the reason is the driver divergence `server/test/harness.ts`
     * pins: `sum()` over an integer and `count(*)` are both int8, which PGlite
     * hands back as a number and `@neondatabase/serverless` as a STRING. Left
     * alone, `awardedTotal` would be `"35"` in production and the UI's
     * `.toLocaleString()` would render it, silently, as a string that sorts
     * wrong. `toEpochMs` would be the wrong function for a value that is not a
     * timestamp, even though today it is the same call.
     */
    awardedTotal: Number(row.awarded_total),
    openReturns: Number(row.open_returns),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

/**
 * Contract #1.
 *
 * ORDERED BY CREATION, OLDEST FIRST, and that is a choice about a CONFIG table.
 * `updated_at DESC` — the ordering a queue wants — would make a list reshuffle
 * itself under the cursor every time somebody saved a row, on the one screen
 * where the reader is editing the rows they are looking at. Creation order never
 * moves, so a row stays where its reader last saw it.
 *
 * IT DOES NOT PROMISE THE SEEDED PRESET IS FIRST, and an earlier draft of this
 * comment claimed it did. Migration 0011 stamps that row with a fixed
 * authoring-time constant rather than a clock read (deliberately — a seed dated
 * `now()` makes two databases disagree about when the shop opened), so whether it
 * sorts above a program created today depends on nothing more than which side of
 * that constant the clock is on. The UI finds the preset by the `seeded` flag,
 * which is the only handle that is true whatever the clock says — and is the same
 * flag the "Seeded preset" chip already reads.
 */
export async function listPrograms(db: Db): Promise<Program[]> {
  const res = await db.execute(sql`
    SELECT ${PROGRAM_COLUMNS}, ${aggregates('p')}
      FROM marketing_programs p
     ORDER BY p.created_at ASC, p.id ASC`);
  return res.rows.map(rowToProgram);
}

export async function getProgram(db: Db, id: string): Promise<Program | null> {
  const res = await db.execute(sql`
    SELECT ${PROGRAM_COLUMNS}, ${aggregates('p')}
      FROM marketing_programs p
     WHERE p.id = ${id}`);
  return res.rows[0] ? rowToProgram(res.rows[0]) : null;
}

/**
 * Contract #2.
 *
 * `status`, `conditions`, `seeded` AND `revision` ARE ABSENT FROM THE COLUMN
 * LIST ON PURPOSE — each takes its column default, which is the only way any of
 * them is ever written. `seeded` is the sharp one: it is what the "Seeded preset"
 * chip derives from, so a route that could set it would let anybody mint the
 * badge that says "the migration installed this".
 */
export async function createProgram(
  db: Db,
  draft: ProgramDraft,
  opts: WriteOptions,
): Promise<Program> {
  const id = newId(ID.program);
  try {
    const res = await db.execute(sql`
      WITH ins AS (
        INSERT INTO marketing_programs
          (id, key, kind, name, points_label_singular, points_label_plural,
           unit_label_singular, unit_label_plural, min_units_per_return, points_per_unit,
           unit_cost_minor, unit_market_cost_minor,
           created_at, updated_at, created_by)
        VALUES (${id}, ${draft.key}, ${draft.kind}, ${draft.name},
                ${draft.pointsLabelSingular}, ${draft.pointsLabelPlural},
                ${draft.unitLabelSingular ?? null}, ${draft.unitLabelPlural ?? null},
                ${draft.minUnitsPerReturn ?? null}, ${draft.pointsPerUnit ?? null},
                ${draft.unitCostMinor ?? null}::integer,
                ${draft.unitMarketCostMinor ?? null}::integer,
                ${opts.now}, ${opts.now}, ${opts.actorId}::uuid)
        RETURNING ${PROGRAM_COLUMNS}
      )
      SELECT ${PROGRAM_COLUMNS}, ${aggregates('ins')} FROM ins`);
    return rowToProgram(res.rows[0]);
  } catch (err) {
    /*
     * Translated rather than left to become a 500. Choosing a key somebody
     * already used is an ordinary thing to do and a PERMANENT condition, so it
     * has to be a refusal the form can act on — and it has to be told apart from
     * "that key has a capital letter in it", which is a different sentence in a
     * different place. Anything else is a real fault and re-thrown.
     */
    if (uniqueViolation(err) === PROGRAM_KEY_UQ) throw new DuplicateProgramKeyError(draft.key);
    throw err;
  }
}

/**
 * The patchable columns, as a map from wire field to column name.
 *
 * THE COLUMN NAMES COME FROM HERE AND NEVER FROM THE REQUEST. A SET clause is
 * built by walking this table and testing whether the patch carries the key, so
 * the identifier that reaches SQL is a literal written in this file — the same
 * rule `emitEvent` states for its `from` clause. The values stay bound
 * parameters.
 *
 * AND NOTE WHAT IS NOT IN IT: `key`, `kind`, `seeded`, `conditions`, `revision`.
 * The zod schema in `routes.ts` refuses each of those by name with a 400; this
 * map is the second wall, so a widened schema still could not move a program's
 * identity.
 */
const PATCHABLE = {
  name: 'name',
  pointsLabelSingular: 'points_label_singular',
  pointsLabelPlural: 'points_label_plural',
  unitLabelSingular: 'unit_label_singular',
  unitLabelPlural: 'unit_label_plural',
  minUnitsPerReturn: 'min_units_per_return',
  pointsPerUnit: 'points_per_unit',
  unitCostMinor: 'unit_cost_minor',
  unitMarketCostMinor: 'unit_market_cost_minor',
  status: 'status',
} as const satisfies Record<keyof ProgramPatch, string>;

/** The two money fields, whose NULLs need an explicit cast: a bound `null` in
 *  a SET has no target column to infer from and is SQLSTATE 42P18 at run time
 *  rather than at build time. */
const MONEY_FIELDS = new Set<keyof ProgramPatch>(['unitCostMinor', 'unitMarketCostMinor']);

/** The four columns `marketing_programs_kind_fields_ck` ties to `kind`. */
const UNIT_ONLY_FIELDS = [
  'unitLabelSingular',
  'unitLabelPlural',
  'minUnitsPerReturn',
  'pointsPerUnit',
] as const;

/**
 * Contract #3 — CAS, and the words move while the identity does not.
 *
 * THE `WHERE revision = $expected` IS THE ONLY AUTHORITY ON WHO WON. The read
 * above it exists to answer 404 and to know the program's `kind`; it never
 * decides whether the write may proceed, because a precondition judged in
 * TypeScript is judged against a row that has already been read — exactly the
 * stale value a CAS exists to distrust (`server/shop/catalog/products.ts`
 * measured what that costs). Zero rows means the CAS lost and NOTHING happened.
 */
export async function patchProgram(
  db: Db,
  id: string,
  patch: ProgramPatch,
  opts: WriteOptions & { expectedRevision: number },
): Promise<Program> {
  const current = await getProgram(db, id);
  if (!current) throw new NotFoundError(id);

  /*
   * A RULE FIELD ON AN `adhoc` PROGRAM IS A 400, NOT A 23514.
   *
   * `marketing_programs_kind_fields_ck` ties the four unit columns to the kind,
   * and `kind` is not patchable — so on this row those fields do not exist and
   * never will. Left to the database it is a CHECK violation, which has no row in
   * the error table and answers 500: a status the client's retry policy re-sends
   * five times for a body that can never be accepted. Named here it is an inline
   * error on an input that should not have been rendered in the first place (the
   * editor hides the rules panel for `adhoc`), which is what makes it a
   * backstop rather than a workflow.
   *
   * The opposite direction needs no guard: the patch schema types the unit labels
   * as strings rather than nullable, so a `unit_return` program cannot be stripped
   * of the words that make it one.
   */
  if (current.kind === 'adhoc') {
    const offending = UNIT_ONLY_FIELDS.find((field) => patch[field] !== undefined);
    if (offending) throw new BadRequestError(offending);
  }

  /*
   * The revision and the clock are appended rather than conditional: a PATCH
   * carrying only `expectedRevision` still bumps both. It is a touch rather than
   * a no-op, and treating it as one would mean a caller whose 200 did not
   * invalidate the token it just used.
   */
  const assignments = (Object.keys(PATCHABLE) as (keyof ProgramPatch)[])
    .filter((field) => patch[field] !== undefined)
    .map((field) =>
      MONEY_FIELDS.has(field)
        ? sql`${sql.raw(PATCHABLE[field])} = ${patch[field]}::integer`
        : sql`${sql.raw(PATCHABLE[field])} = ${patch[field]}`,
    );
  assignments.push(sql`revision = revision + 1`, sql`updated_at = ${opts.now}`);

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE marketing_programs
         SET ${sql.join(assignments, sql`, `)}
       WHERE id = ${id} AND revision = ${opts.expectedRevision}
      RETURNING ${PROGRAM_COLUMNS}
    )
    SELECT ${PROGRAM_COLUMNS}, ${aggregates('upd')} FROM upd`);

  /*
   * `rows.length`, never `affectedRows` — measured to be 0 even on a winning CAS
   * (`server/repo/posts.ts`). The row is re-read rather than reported from the
   * copy above, because the whole value of this 409 to the client is that it
   * carries the row that WON: spec D7's conflict notice renders "Load theirs"
   * straight out of the payload instead of spending a second round trip to
   * discover a third state.
   */
  if (res.rows.length === 0) {
    const actual = await getProgram(db, id);
    if (!actual) throw new NotFoundError(id);
    throw new StaleMarketingWriteError(
      opts.expectedRevision,
      actual.revision,
      'program',
      actual,
    );
  }

  return rowToProgram(res.rows[0]);
}
