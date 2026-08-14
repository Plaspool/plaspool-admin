import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { fmtUnits } from '../../../shared/marketing/copy';
import {
  AlreadyAwardedError,
  BelowMinimumError,
  InvalidTransitionError,
  OutsideServiceAreaError,
  ProgramPausedError,
  ProgramTypeMismatchError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from '../errors';
import { requireServedArea, servedNames } from '../areas/repo';
import { ID, newId } from '../ids';
import { resolveLabels } from '../labels';
import { balanceUpsertFragment, ledgerInsertFragment } from '../ledger/fragments';
import {
  TIMELINE_COLUMNS,
  emailIntentFragment,
  renderReturnAwarded,
  renderReturnRejected,
  timelineEntryFragment,
} from './events';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { ProgramLabels } from '../../../shared/marketing/copy';
import type { ReturnAction, ReturnStatus } from '../errors';
import type { ActorType } from '../ledger/fragments';
import type { ReturnEventType } from './events';

/**
 * The return lifecycle — `requested → scheduled → collected → received →
 * awarded`, with `rejected` and `cancelled` as the two ways out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY TRANSITION IS ONE STATEMENT, AND NEVER `db.transaction`.
 *
 * The Neon HTTP driver throws unconditionally on `transaction()` while PGlite
 * supports it, so a transaction here would pass every test in this repository
 * and 500 on every production call — the divergence `server/repo/posts.ts`
 * documents and spec §Global constraints forbids. Atomicity is a single
 * statement of chained data-modifying CTEs instead: the CAS `UPDATE` is one CTE
 * and the timeline entry, the balance, the ledger row and the notification all
 * `SELECT … FROM` it, so a CAS that matches nothing structurally writes nothing
 * at all. There is no instant in which a return is `awarded` and the customer has
 * not been paid, or has been paid and the history does not say why.
 *
 * THE `WHERE` CLAUSE IS THE ONLY AUTHORITY ON WHETHER A TRANSITION MAY PROCEED.
 * Every function below reads the row first, and NONE of them decides anything
 * with what it read: a precondition judged in TypeScript is judged against a row
 * that has already been read, i.e. against exactly the stale value a CAS exists
 * to distrust (`server/shop/orders/repo/orders.ts` measured what that costs — an
 * A→B→A interleaving re-applied a lost intent through six transitions). The read
 * exists to answer the questions a predicate cannot: which words this program
 * uses, and — after zero rows come back — WHICH HALF SAID NO, so the caller gets
 * `invalid_transition` / `stale_write` / `gone` rather than one blunt 409.
 *
 * THE AWARD IS THE ONE OPERATION HERE THAT COSTS MONEY AND CANNOT BE TAKEN BACK,
 * so it is guarded three deep and only one of the three is code: the CAS refuses
 * a second inspection, `marketing_return_requests_award_ck` refuses arithmetic
 * nobody can reconstruct from the row, and `marketing_ledger_award_uq` refuses a
 * second credit for one return with every application guard deleted (spec D3).
 * `mutate.test.ts` neutralises each in turn and asserts a named test goes red.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Contract §Types `ReturnDetail.request`, plus `programId` — which the wire
 *  carries under `program` and which every caller here needs by itself. */
export interface ReturnRow {
  id: string;
  programId: string;
  status: ReturnStatus;
  revision: number;
  customerEmail: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  pickupAddress: string | null;
  /** Which board this is on. NULL is the out-of-area footer — a legal state, and
   *  an unrewardable one. */
  serviceAreaId: string | null;
  qtyDeclared: number;
  qtyAccepted: number | null;
  qtyRejected: number | null;
  /** The rate the customer was PROMISED. Copied at creation, never re-read
   *  through the FK — see `createRequest`. */
  pointsPerUnitSnapshot: number;
  pointsAwarded: number | null;
  rejectedReason: string | null;
  cancelReason: string | null;
  source: 'customer' | 'admin';
  pickupScheduledAt: number | null;
  driverName: string | null;
  driverPhone: string | null;
  scheduledAt: number | null;
  collectedAt: number | null;
  receivedAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Contract §Types `ReturnEvent`. Append-only: nothing edits or deletes one. */
export interface ReturnEventRow {
  id: string;
  type: ReturnEventType;
  actorType: ActorType;
  actorId: string | null;
  note: string | null;
  data: Record<string, unknown> | null;
  occurredAt: number;
}

/** The program half of contract §Types `ReturnDetail.program`, as the row has
 *  it. The labels are derived from this, never from anything in source. */
export interface ProgramSnapshot {
  id: string;
  status: 'active' | 'paused';
  kind: 'unit_return' | 'adhoc';
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
  minUnitsPerReturn: number | null;
  pointsPerUnit: number | null;
}

export interface ReturnRead {
  request: ReturnRow;
  program: ProgramSnapshot;
  /** The words this return's surfaces are rendered in, resolved once. */
  labels: ProgramLabels;
}

// ------------------------------------------------------------ allowed actions

/**
 * What may legally be done to a return next — SERVED, NEVER GUESSED (spec D4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER IS PART OF THE CONTRACT. The queue renders exactly one button per
 * row and renders `allowedActions[0]`, so the pipeline-advancing action is first
 * in every list; the rest run reject → cancel → note, which is the order the
 * detail panel's secondaries appear in. `repo.test.ts` pins each array by
 * EQUALITY rather than by membership for that reason — a reordering is a
 * different button on the busiest screen in the section.
 *
 * `scheduled` CARRIES BOTH `collect` AND `schedule`: contract #8 makes schedule
 * legal from `scheduled` as a RESCHEDULE, which emits a fresh `scheduled` event
 * rather than silently editing the old one. It sits second because the pipeline
 * still advances by collecting; the detail panel lists "Reschedule…" first among
 * the secondaries, which is the same order.
 *
 * `collected` HAS NO `reject`: contract #12 makes reject legal pre-receipt only.
 * Once a driver has the goods, refusing them is an INSPECTION with zero accepted
 * — which records the quantities — and not a status flip that loses them.
 * `received` HAS NO `cancel` for the mirror reason: once the goods are in hand
 * somebody must inspect them. `collected` keeps `cancel` deliberately, as the
 * lost-in-transit escape.
 *
 * EVERY STATUS INCLUDING THE TERMINAL ONES CARRIES `note`, because notes append
 * in any state and bump nothing. The queue's terminal rows still render a ghost
 * "View" — that is a display decision in the client's verb map, not a claim that
 * a closed return has no legal writes.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const ALLOWED_ACTIONS: Record<ReturnStatus, readonly ReturnAction[]> = {
  requested: ['schedule', 'reject', 'cancel', 'note'],
  scheduled: ['collect', 'schedule', 'reject', 'cancel', 'note'],
  collected: ['receive', 'cancel', 'note'],
  received: ['inspect', 'note'],
  awarded: ['note'],
  rejected: ['note'],
  cancelled: ['note'],
};

/** A COPY, so a caller that mutates its own list cannot rewrite the table for
 *  every later request in the same process. */
export function allowedActionsFor(status: ReturnStatus): ReturnAction[] {
  return [...ALLOWED_ACTIONS[status]];
}

// -------------------------------------------------------------------- reading

const REQUEST_COLUMN_NAMES = [
  'id',
  'program_id',
  'customer_id',
  'customer_email',
  'customer_name',
  'customer_phone',
  'pickup_address',
  'service_area_id',
  'qty_declared',
  'qty_accepted',
  'qty_rejected',
  'points_per_unit_snapshot',
  'points_awarded',
  'rejected_reason',
  'cancel_reason',
  'source',
  'status',
  'pickup_scheduled_at',
  'driver_name',
  'driver_phone',
  'scheduled_at',
  'collected_at',
  'received_at',
  'closed_at',
  'revision',
  'created_at',
  'updated_at',
];

/** Bare names, so one list serves an `INSERT … RETURNING` and a `SELECT` off a
 *  CTE alike. */
const REQUEST_COLUMNS = sql.raw(REQUEST_COLUMN_NAMES.join(', '));

/** Qualified, for the statements that join — the program's `id` and the
 *  request's would otherwise both arrive as `id`. */
const requestColumns = (alias: string): SQL =>
  sql.raw(REQUEST_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(', '));

/**
 * The program's columns under names that cannot collide with the request's.
 *
 * Prefixed rather than selected with `p.*`, because two `id` columns in one
 * result set is one row object with one `id` in it, and which one survives is up
 * to the driver.
 */
const PROGRAM_COLUMNS = sql.raw(
  `p.id AS prog_id, p.status AS prog_status, p.kind AS prog_kind, p.name AS prog_name,
   p.points_label_singular AS prog_points_one, p.points_label_plural AS prog_points_other,
   p.unit_label_singular AS prog_unit_one, p.unit_label_plural AS prog_unit_other,
   p.min_units_per_return AS prog_min_units, p.points_per_unit AS prog_points_per_unit`,
);

function rowToRequest(row: Record<string, unknown>): ReturnRow {
  return {
    id: String(row.id),
    programId: String(row.program_id),
    status: row.status as ReturnStatus,
    revision: Number(row.revision),
    customerEmail: String(row.customer_email),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    customerName: row.customer_name == null ? null : String(row.customer_name),
    customerPhone: row.customer_phone == null ? null : String(row.customer_phone),
    pickupAddress: row.pickup_address == null ? null : String(row.pickup_address),
    serviceAreaId: row.service_area_id == null ? null : String(row.service_area_id),
    qtyDeclared: Number(row.qty_declared),
    qtyAccepted: row.qty_accepted == null ? null : Number(row.qty_accepted),
    qtyRejected: row.qty_rejected == null ? null : Number(row.qty_rejected),
    pointsPerUnitSnapshot: Number(row.points_per_unit_snapshot),
    pointsAwarded: row.points_awarded == null ? null : Number(row.points_awarded),
    rejectedReason: row.rejected_reason == null ? null : String(row.rejected_reason),
    cancelReason: row.cancel_reason == null ? null : String(row.cancel_reason),
    source: row.source as ReturnRow['source'],
    // `toEpochMsOrNull` and not `Number`: these are `bigint` columns, which the
    // Neon driver returns as STRINGS and PGlite is configured to imitate.
    pickupScheduledAt: toEpochMsOrNull(row.pickup_scheduled_at),
    driverName: row.driver_name == null ? null : String(row.driver_name),
    driverPhone: row.driver_phone == null ? null : String(row.driver_phone),
    scheduledAt: toEpochMsOrNull(row.scheduled_at),
    collectedAt: toEpochMsOrNull(row.collected_at),
    receivedAt: toEpochMsOrNull(row.received_at),
    closedAt: toEpochMsOrNull(row.closed_at),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

function rowToProgram(row: Record<string, unknown>): ProgramSnapshot {
  return {
    id: String(row.prog_id),
    status: row.prog_status as ProgramSnapshot['status'],
    kind: row.prog_kind as ProgramSnapshot['kind'],
    name: String(row.prog_name),
    pointsLabelSingular: String(row.prog_points_one),
    pointsLabelPlural: String(row.prog_points_other),
    unitLabelSingular: row.prog_unit_one == null ? null : String(row.prog_unit_one),
    unitLabelPlural: row.prog_unit_other == null ? null : String(row.prog_unit_other),
    minUnitsPerReturn: row.prog_min_units == null ? null : Number(row.prog_min_units),
    pointsPerUnit: row.prog_points_per_unit == null ? null : Number(row.prog_points_per_unit),
  };
}

function rowToEvent(row: Record<string, unknown>): ReturnEventRow {
  return {
    id: String(row.id),
    type: row.type as ReturnEventType,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id == null ? null : String(row.actor_id),
    note: row.note == null ? null : String(row.note),
    data: (row.data ?? null) as Record<string, unknown> | null,
    occurredAt: toEpochMs(row.occurred_at),
  };
}

/**
 * `resolveLabels` takes the cross-program fallback as its second argument, for
 * the surfaces that span every program. A RETURN ALWAYS HAS ONE —
 * `program_id` is NOT NULL with an FK — so that branch is unreachable from this
 * file, and the program row is handed over for it too: it satisfies the same
 * two-property shape, which keeps this statement from joining a settings row it
 * would never read.
 */
const labelsOf = (program: ProgramSnapshot): ProgramLabels => resolveLabels(program, program);

/**
 * One return, its program, and the words to say it in.
 *
 * The program is joined rather than fetched separately because every consumer
 * needs both — the detail panel renders the program's rules, and every statement
 * here renders a customer-facing string out of its labels — and two reads would
 * give two different instants.
 */
export async function readReturn(db: Db, id: string): Promise<ReturnRead | null> {
  const res = await db.execute(sql`
    SELECT ${requestColumns('r')}, ${PROGRAM_COLUMNS}
      FROM marketing_return_requests r
      JOIN marketing_programs p ON p.id = r.program_id
     WHERE r.id = ${id}`);
  const row = res.rows[0];
  if (!row) return null;
  const program = rowToProgram(row);
  return { request: rowToRequest(row), program, labels: labelsOf(program) };
}

/**
 * The timeline, OLDEST FIRST — the order the index
 * `marketing_return_events_request_idx` already holds them in.
 *
 * The detail panel renders it newest-first, and reverses it there: an ordering
 * chosen for one screen's reading direction would make the next consumer (an
 * export, a support tool) re-sort a list it was handed backwards.
 */
export async function listEvents(db: Db, requestId: string): Promise<ReturnEventRow[]> {
  const res = await db.execute(sql`
    SELECT ${TIMELINE_COLUMNS}
      FROM marketing_return_events
     WHERE request_id = ${requestId}
     ORDER BY occurred_at ASC, id ASC`);
  return res.rows.map(rowToEvent);
}

// -------------------------------------------------------------------- writing

/** One clock reading per write, PASSED IN rather than taken here, so a row's
 *  `updated_at` and the event's `occurred_at` cannot differ by a millisecond of
 *  scheduling (the `WriteOptions` rule in `programs/repo.ts`). */
interface Clocked {
  now: number;
}

/** Who is doing this. Transitions are `requireAuth` staff work (spec D12's role
 *  matrix), so the actor is an admin and the id is the signed-in user's. */
interface Acting extends Clocked {
  actorId?: string | null;
}

interface Cas extends Acting {
  expectedRevision: number;
}

/**
 * `status IN (…)`, built from the SAME list the refusal path explains with.
 *
 * DERIVED RATHER THAN WRITTEN TWICE: a guard in SQL and a legality list in
 * TypeScript that disagree is a transition that either refuses what it should
 * allow or — worse — reports the wrong reason for a refusal it made correctly.
 * One list, two readers.
 */
function statusIn(statuses: readonly ReturnStatus[]): SQL {
  return sql`status IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

/**
 * A typed pickup address, or nothing at all.
 *
 * A BLANK IS NOT AN ADDRESS, and normalising it to `undefined` in one place is
 * what keeps the two readers of the field agreeing. `SCHEDULE`'s `COALESCE`
 * only defends against NULL: left as whitespace, `pickupAddress: '   '` is not
 * `undefined`, so it would skip `schedule`'s "on the row or in the body" check
 * AND overwrite the address the customer actually gave — a driver dispatched to
 * a blank doorstep, with the good address gone from the row. Every other human
 * string in this file is trimmed at this layer (`reject`'s reason, `addNote`'s
 * note, `createRequest`'s email) for the same reason: A5's zod is the first
 * caller, not the only one.
 */
function address(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * What a 409 carries: the row that is actually there, plus what may be done to
 * it.
 *
 * `allowedActions` is included because spec D7's auto-heal re-renders the true
 * stage STRAIGHT OUT OF THE PAYLOAD — a screen that had to refetch to learn
 * which buttons are legal would show a third state (the one true at the time of
 * that second read) as though it were what the write lost to.
 */
function conflictPayload(row: ReturnRow): Record<string, unknown> {
  return { ...row, allowedActions: allowedActionsFor(row.status) };
}

/**
 * Zero rows came back. Read the row and say which half refused.
 *
 * STATUS IS TESTED FIRST, and the order is a decision: when another admin has
 * advanced the return, both halves are false and `invalid_transition` is the
 * more actionable of the two — it names the stage the row is really in, which is
 * what the auto-heal re-renders. `stale_write` is what remains: the status still
 * allows the action and somebody else wrote the row first (a reschedule racing a
 * reschedule is the realistic case).
 *
 * The third branch — the status allows it AND the revision matches — is
 * unreachable by construction, because `revision` only ever increments and every
 * write bumps it. It falls through to `stale_write` rather than inventing a code
 * the catalogue does not have.
 */
async function refuse(
  db: Db,
  id: string,
  action: ReturnAction,
  legal: readonly ReturnStatus[],
  expectedRevision: number,
): Promise<never> {
  const read = await readReturn(db, id);
  if (!read) throw new NotFoundError(id);
  const { request } = read;
  if (!legal.includes(request.status)) {
    throw new InvalidTransitionError(request.status, action, conflictPayload(request));
  }
  throw new StaleMarketingWriteError(
    expectedRevision,
    request.revision,
    'request',
    conflictPayload(request),
  );
}

interface Transition<A> {
  /** Named in the `invalid_transition` payload, so the client can say what it
   *  was trying to do. */
  action: ReturnAction;
  /** The statuses this is legal from. `statusIn` turns it into the CAS
   *  predicate; `refuse` explains with it. */
  from: readonly ReturnStatus[];
  set(arg: A, now: number): SQL;
  event(arg: A): {
    type: ReturnEventType;
    note: string | null;
    data: Record<string, unknown> | null;
  };
}

/**
 * The CAS, its timeline entry, and nothing else — one statement.
 *
 * `rows.length`, never `affectedRows`: measured to be 0 even on a winning CAS
 * (`server/repo/posts.ts`).
 */
async function runTransition<A extends Cas>(
  db: Db,
  id: string,
  transition: Transition<A>,
  arg: A,
): Promise<ReturnRow> {
  const entry = transition.event(arg);
  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE marketing_return_requests
         SET ${transition.set(arg, arg.now)},
             revision = revision + 1,
             updated_at = ${arg.now}
       WHERE id = ${id}
         AND ${statusIn(transition.from)}
         AND revision = ${arg.expectedRevision}
      RETURNING ${REQUEST_COLUMNS}
    ), evt AS (
      ${timelineEntryFragment({
        from: sql`upd`,
        id: newId(ID.timeline),
        requestId: sql`upd.id`,
        type: entry.type,
        actorType: 'admin',
        actorId: arg.actorId ?? null,
        note: entry.note,
        data: entry.data,
        occurredAt: arg.now,
      })}
    )
    SELECT ${REQUEST_COLUMNS} FROM upd`);

  const row = res.rows[0];
  if (!row) return refuse(db, id, transition.action, transition.from, arg.expectedRevision);
  return rowToRequest(row);
}

// -------------------------------------------------------------------- create

export interface CreateReturnInput extends Clocked {
  email: string;
  qtyDeclared: number;
  /** Absent means "whatever the shop's default is" — contract #5. */
  programId?: string;
  /**
   * WHICH BOARD THIS LANDS ON — an area id, its key, or any spelling of its name
   * the alias list forgives. CHOSEN, NEVER PARSED (there is no geocoding here).
   *
   * Absent is legal for the admin path and means "out of area": a phone-in from
   * out of town is a real request, and it lands in the switcher's footer where
   * it can be closed with a reason. It can never be AWARDED —
   * `marketing_return_requests_area_award_ck` sees to that — which is why the
   * public intake requires one and the route, not this function, enforces that.
   */
  serviceAreaId?: string;
  customerName?: string;
  customerPhone?: string;
  pickupAddress?: string;
  note?: string;
  /** `customer` for the public intake, `admin` for the staff dialog. It decides
   *  who the first timeline entry is attributed to. */
  source: 'customer' | 'admin';
  actorId?: string | null;
}

const OPEN_RETURN_UQ = 'marketing_return_requests_open_uq';

/** The four statuses the partial unique index treats as "in flight". */
const OPEN_STATUSES: readonly ReturnStatus[] = [
  'requested',
  'scheduled',
  'collected',
  'received',
];

async function readProgramFor(db: Db, programId: string | undefined) {
  const res = await db.execute(
    programId === undefined
      ? /* No program named: the shop's default, through the settings singleton.
         * A NULL pointer there selects nothing, which the caller answers with
         * `program_paused` — the catalogue's "or no active default". */
        sql`SELECT ${PROGRAM_COLUMNS}
              FROM marketing_programs p
              JOIN marketing_settings s ON s.default_return_program_id = p.id
             WHERE s.id = 'main'`
      : sql`SELECT ${PROGRAM_COLUMNS} FROM marketing_programs p WHERE p.id = ${programId}`,
  );
  const row = res.rows[0];
  return row ? rowToProgram(row) : null;
}

/**
 * Contract #5 and #6 — the row every later transition moves.
 *
 * `points_per_unit_snapshot` IS COPIED HERE AND NEVER RE-READ THROUGH THE FK
 * (spec D4). A customer told "ten a unit" on Monday is paid ten a unit on Friday
 * even if the shop repriced on Wednesday; repricing mid-flight is done by
 * cancelling and recreating, and the timeline records both halves. That is an
 * honest-promise rule, and `marketing_return_requests_award_ck` makes it
 * arithmetic the database checks rather than a convention.
 *
 * ONE OPEN RETURN PER EMAIL IS THE INDEX'S JOB, NOT A PRIOR `SELECT`. A read
 * that decided whether to insert would be evaluated against a snapshot a
 * concurrent request has already invalidated — two drivers sent to one doorstep.
 * The 23505 is translated below into the error that LINKS to the request that
 * already exists, so the admin lands on it instead of dead-ending.
 */
export async function createRequest(db: Db, input: CreateReturnInput): Promise<ReturnRow> {
  /*
   * Lowercased and trimmed HERE, because this is where an address becomes an
   * identity: the balance, the ledger and the open-return index all key on it,
   * and `Dara@x` reaching one of them as itself is two wallets for one customer.
   * `marketing_return_requests_email_ck` refuses the un-lowered form outright, so
   * the alternative to doing it here is a 500 on a perfectly ordinary input.
   */
  const email = input.email.trim().toLowerCase();
  if (email === '') throw new BadRequestError('email');
  if (!Number.isInteger(input.qtyDeclared)) throw new BadRequestError('qtyDeclared');

  const program = await readProgramFor(db, input.programId);
  if (!program) {
    /*
     * A NAMED program that does not exist is a FIELD error, not a missing page —
     * the same call contract #20 makes for `defaultReturnProgramId`: the shape
     * this arrives in is a Select whose options were fetched a moment ago and
     * whose value raced, and `gone` would render a whole-screen "no longer
     * exists" with a back link in place of one inline message. With no program
     * named there is no field to blame and nothing accepting returns, which is
     * what `program_paused` says.
     */
    if (input.programId !== undefined) throw new BadRequestError('programId');
    throw new ProgramPausedError();
  }

  /*
   * KIND BEFORE STATUS. An `adhoc` program can never take returns — there are no
   * units to count and no rate to price them at — while `paused` is a state
   * somebody can change in one click. Reporting the temporary condition for a
   * permanent one would send an admin to a status toggle that will not help.
   */
  if (program.kind !== 'unit_return') throw new ProgramTypeMismatchError();
  if (program.status !== 'active') throw new ProgramPausedError();

  /* Non-null by `marketing_programs_kind_fields_ck` once the kind is
   * `unit_return`; read defensively so a widened CHECK cannot make this a
   * `null * n` award of NaN. */
  const { minUnitsPerReturn, pointsPerUnit } = program;
  if (minUnitsPerReturn === null || pointsPerUnit === null) {
    throw new BadRequestError('programId');
  }
  if (input.qtyDeclared < minUnitsPerReturn) throw new BelowMinimumError(minUnitsPerReturn);

  /*
   * THE GATE, RESOLVED BEFORE THE INSERT AND ENFORCED INSIDE IT.
   *
   * `requireServedArea` turns whatever spelling arrived into a served row or
   * throws the refusal that names the places we do collect from. That read is
   * for the ERROR MESSAGE, not for permission — by the time the INSERT runs the
   * flag could have been switched off — so the statement below selects the area
   * again `WHERE active`, and an area retired in between makes the whole insert
   * write nothing rather than book a van nobody will send.
   */
  const area =
    input.serviceAreaId === undefined
      ? null
      : await requireServedArea(db, input.serviceAreaId);

  const id = newId(ID.return);
  /* The public intake's first entry is the CUSTOMER's, the dialog's is staff's.
   * A history that attributes every request to whoever happened to be signed in
   * is a history that cannot answer "did they ask, or did we log it for them". */
  const actorType: ActorType = input.source === 'customer' ? 'customer' : 'admin';

  try {
    /*
     * `status` AND `revision` ARE ABSENT FROM THE COLUMN LIST ON PURPOSE — each
     * takes its column default (`'requested'`, `1`), which is the only way either
     * is ever written. `createProgram` omits its own defaults for the same
     * reason: a column a route can set is a column a route can set wrongly.
     */
    const res = await db.execute(sql`
      WITH ins AS (
        INSERT INTO marketing_return_requests
          (id, program_id, customer_email, customer_name, customer_phone, pickup_address,
           qty_declared, points_per_unit_snapshot, source, service_area_id,
           created_at, updated_at)
        ${
          /*
           * TWO SHAPES, ASSEMBLED — never one statement with a disabled arm. An
           * out-of-area return has no area to select FROM and inserts NULL
           * unconditionally; an in-area one selects the row `WHERE active`, so a
           * district switched off between the read above and this write produces
           * zero rows and writes nothing at all. The `inspect` statement takes
           * the same approach to its optional CTEs and for the same reason.
           */
          area === null
            ? sql`VALUES (${id}, ${program.id}, ${email}, ${input.customerName ?? null},
                    ${input.customerPhone ?? null}, ${address(input.pickupAddress) ?? null},
                    ${input.qtyDeclared}, ${pointsPerUnit}, ${input.source}, NULL,
                    ${input.now}, ${input.now})`
            : sql`SELECT ${id}, ${program.id}, ${email}, ${input.customerName ?? null},
                    ${input.customerPhone ?? null}, ${address(input.pickupAddress) ?? null},
                    ${input.qtyDeclared}, ${pointsPerUnit}, ${input.source}, a.id,
                    ${input.now}, ${input.now}
                    FROM marketing_service_areas a
                   WHERE a.id = ${area.id} AND a.active`
        }
        RETURNING ${REQUEST_COLUMNS}
      ), evt AS (
        ${timelineEntryFragment({
          from: sql`ins`,
          id: newId(ID.timeline),
          requestId: sql`ins.id`,
          type: 'requested',
          actorType,
          actorId: input.source === 'customer' ? null : (input.actorId ?? null),
          note: input.note ?? null,
          data: { qtyDeclared: input.qtyDeclared, source: input.source },
          occurredAt: input.now,
        })}
      )
      SELECT ${REQUEST_COLUMNS} FROM ins`);
    const row = res.rows[0];
    /* Zero rows can mean exactly one thing here: the `WHERE a.active` above
     * matched nothing, i.e. the district was retired between the resolve and the
     * write. The honest answer is the one the customer would have got a
     * millisecond earlier, with the served list as it now stands. */
    if (!row) throw new OutsideServiceAreaError(await servedNames(db));
    return rowToRequest(row);
  } catch (err) {
    if (uniqueViolation(err) === OPEN_RETURN_UQ) {
      const open = await readOpenReturn(db, email);
      /* The index fired, so a row IS there; the read is how its id reaches the
       * client. If it has closed in between, the honest answer is to let the
       * caller retry rather than to invent an id for a link that would 404. */
      if (open) throw new ReturnAlreadyOpenError(open.id, open.status);
    }
    throw err;
  }
}

async function readOpenReturn(
  db: Db,
  email: string,
): Promise<{ id: string; status: ReturnStatus } | null> {
  const res = await db.execute(sql`
    SELECT id, status FROM marketing_return_requests
     WHERE customer_email = ${email} AND ${statusIn(OPEN_STATUSES)}`);
  const row = res.rows[0];
  return row ? { id: String(row.id), status: row.status as ReturnStatus } : null;
}

// --------------------------------------------------------------- transitions

export interface ScheduleInput extends Cas {
  /** When the driver is due, epoch-ms. */
  pickupAt: number;
  driverName?: string;
  driverPhone?: string;
  pickupAddress?: string;
  note?: string;
}

const SCHEDULE: Transition<ScheduleInput> = {
  action: 'schedule',
  /* `scheduled → scheduled` IS THE RESCHEDULE (contract #8). It emits a second
   * `scheduled` event rather than editing the first, so a customer who was told
   * Tuesday and then Thursday can see both — a silent edit makes the shop's
   * record disagree with the customer's memory and gives nobody a way to tell
   * who is right. */
  from: ['requested', 'scheduled'],
  /*
   * THE DRIVER FIELDS ARE PLAIN ASSIGNMENTS, NOT `COALESCE`. A schedule states
   * the WHOLE pickup arrangement, and a driver silently carried over from an
   * arrangement that has just been replaced is worse than an empty field —
   * somebody would ring the courier who is no longer coming.
   *
   * The address is the one exception, because contract #8 puts it there: "pickup
   * address must exist on row or in body", so a reschedule that names only a new
   * time keeps the address the customer already gave.
   */
  set: (arg, now) => sql`
    status = 'scheduled',
    scheduled_at = ${now},
    pickup_scheduled_at = ${arg.pickupAt},
    driver_name = ${arg.driverName ?? null},
    driver_phone = ${arg.driverPhone ?? null},
    pickup_address = COALESCE(${arg.pickupAddress ?? null}::text, pickup_address)`,
  event: (arg) => ({
    type: 'scheduled',
    note: arg.note ?? null,
    data: {
      pickupAt: arg.pickupAt,
      driverName: arg.driverName ?? null,
      driverPhone: arg.driverPhone ?? null,
    },
  }),
};

/** Contract #8. */
export async function schedule(db: Db, id: string, input: ScheduleInput): Promise<ReturnRow> {
  const arg: ScheduleInput = { ...input, pickupAddress: address(input.pickupAddress) };
  /*
   * "Pickup address must exist on row or in body" (contract #8), refused as a
   * FIELD error rather than left to a driver who arrives with no address. This
   * is a question about the merged row and not about the request, so it needs
   * the read — the same shape as `patchSettings`'s zero-rate rule, and like that
   * one it never decides the race.
   */
  if (arg.pickupAddress === undefined) {
    const read = await readReturn(db, id);
    if (!read) throw new NotFoundError(id);
    if (read.request.pickupAddress === null) throw new BadRequestError('pickupAddress');
  }
  return runTransition(db, id, SCHEDULE, arg);
}

export interface StepInput extends Cas {
  note?: string;
}

const COLLECT: Transition<StepInput> = {
  action: 'collect',
  from: ['scheduled'],
  set: (_arg, now) => sql`status = 'collected', collected_at = ${now}`,
  event: (arg) => ({ type: 'collected', note: arg.note ?? null, data: null }),
};

/** Contract #9. The wire value is `collect`; the UI reads it "Picked up". */
export const collect = (db: Db, id: string, input: StepInput): Promise<ReturnRow> =>
  runTransition(db, id, COLLECT, input);

const RECEIVE: Transition<StepInput> = {
  action: 'receive',
  from: ['collected'],
  set: (_arg, now) => sql`status = 'received', received_at = ${now}`,
  event: (arg) => ({ type: 'received', note: arg.note ?? null, data: null }),
};

/** Contract #10. */
export const receive = (db: Db, id: string, input: StepInput): Promise<ReturnRow> =>
  runTransition(db, id, RECEIVE, input);

export interface RejectInput extends Cas {
  /** Required: a refusal a customer cannot be given a reason for is a support
   *  conversation nobody has the record for. */
  reason: string;
}

const REJECT: Transition<RejectInput> = {
  action: 'reject',
  /* PRE-RECEIPT ONLY (contract #12). After the goods arrive the refusal is an
   * inspection with zero accepted, which RECORDS THE QUANTITIES — a status flip
   * at that point would close a return over a pile of goods nobody counted. */
  from: ['requested', 'scheduled'],
  set: (arg, now) => sql`
    status = 'rejected', rejected_reason = ${arg.reason}, closed_at = ${now}`,
  /* The reason travels as the event's `note` rather than inside `data`: it is a
   * sentence a human wrote and the timeline prints sentences. */
  event: (arg) => ({ type: 'rejected', note: arg.reason, data: null }),
};

/** Contract #12. */
export async function reject(db: Db, id: string, input: RejectInput): Promise<ReturnRow> {
  if (input.reason.trim() === '') throw new BadRequestError('reason');
  return runTransition(db, id, REJECT, input);
}

export interface CancelInput extends Cas {
  reason?: string;
}

const CANCEL: Transition<CancelInput> = {
  action: 'cancel',
  /* `collected` IS CANCELLABLE ON PURPOSE — the lost-in-transit escape (spec
   * D4). `received` is not: once the goods are in hand somebody must inspect
   * them, and a cancel there would lose the count of what actually arrived. */
  from: ['requested', 'scheduled', 'collected'],
  set: (arg, now) => sql`
    status = 'cancelled', cancel_reason = ${arg.reason ?? null}, closed_at = ${now}`,
  event: (arg) => ({ type: 'cancelled', note: arg.reason ?? null, data: null }),
};

/** Contract #13. */
export const cancel = (db: Db, id: string, input: CancelInput): Promise<ReturnRow> =>
  runTransition(db, id, CANCEL, input);

// ------------------------------------------------------------------- the note

export interface NoteInput extends Clocked {
  note: string;
  /** Explicit, unlike the transitions: a note can come from the customer's
   *  reply or from a system process as well as from staff. */
  actorType: ActorType;
  actorId?: string | null;
}

/**
 * Contract #14 — an entry in the history, and NOTHING ELSE.
 *
 * No CAS, no revision bump, no `updated_at`: a note is not a change to the
 * return, and bumping the row would invalidate every open editor's token for a
 * write that moved nothing. It is legal in every status, including the terminal
 * ones, which is why `allowedActionsFor` carries `note` everywhere.
 *
 * The request is the statement's FROM clause rather than a bound id, so an
 * unknown return writes nothing instead of writing an orphan the FK would have
 * to catch.
 */
export async function addNote(db: Db, id: string, input: NoteInput): Promise<ReturnEventRow> {
  if (input.note.trim() === '') throw new BadRequestError('note');
  const res = await db.execute(sql`
    WITH evt AS (
      ${timelineEntryFragment({
        from: sql`(SELECT id FROM marketing_return_requests WHERE id = ${id}) src`,
        id: newId(ID.timeline),
        requestId: sql`src.id`,
        type: 'note',
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        note: input.note,
        data: null,
        occurredAt: input.now,
      })}
    )
    SELECT ${TIMELINE_COLUMNS} FROM evt`);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  return rowToEvent(row);
}

// ---------------------------------------------------------------- the inspect

export interface InspectInput extends Cas {
  qtyAccepted: number;
  /**
   * DERIVED IN THE UI (`received − accepted`) AND TYPED BY NOBODY, which is what
   * makes the classic sum-mismatch validation error impossible. It arrives here
   * as a number because the database records what happened, not what the form
   * looked like.
   */
  qtyRejected: number;
  rejectedReason?: string;
  note?: string;
  /**
   * A discretionary top-up on this inspection — OWNER-ONLY, enforced at the
   * route (`routes.ts`), because minting points outside the programme's rate is
   * money rather than warehouse work.
   *
   * IT IS A SECOND LEDGER ROW AND NEVER A BIGGER AWARD.
   * `marketing_return_requests_award_ck` pins `points_awarded = qty_accepted *
   * points_per_unit_snapshot`, and that equality is what makes the arithmetic
   * unforgeable — a number anybody can recompute from the row. Folding a bonus
   * into it would force that check to be relaxed, and the one thing in this
   * subsystem that cannot be taken back would stop being checkable.
   */
  bonusPoints?: number;
  /** Required iff `bonusPoints` is present. Stored verbatim and forever: a
   *  discretionary credit nobody explained is an argument with no record. */
  bonusReason?: string;
}

export interface InspectOutcome {
  row: ReturnRow;
  /** `null` when nothing was accepted — a rejection writes no ledger row and no
   *  balance, so there is no award to report.
   *
   *  `points` IS THE AWARD ALONE (quantity × the promised rate), matching the
   *  row's own `points_awarded`; `balance` is what the customer now holds, which
   *  INCLUDES any bonus. Two different questions, two different numbers. */
  award: { points: number; balance: number } | null;
  /** The top-up, when there was one. Reported separately so the success copy can
   *  say "120 + 25" rather than a 145 nobody can decompose. */
  bonus: { points: number; reason: string } | null;
}

const INSPECT_FROM: readonly ReturnStatus[] = ['received'];

/**
 * Contract #11, and THE write of this subsystem (spec D5).
 *
 * In ONE statement: CAS `received → awarded` (or `→ rejected` when nothing was
 * accepted), the quantities, the arithmetic, the balance, the ledger row with
 * its `balance_after`, the timeline entry carrying the label snapshot, and the
 * notification with its body already rendered.
 *
 * RECEIVED-VERSUS-DECLARED MAY DIFFER, and no constraint anywhere says
 * otherwise: the customer said six, the driver came back with five, and a
 * database that refuses to record that forces staff to lie to it. What IS pinned
 * is the money — `marketing_return_requests_award_ck`.
 *
 * A REPLAY IS A SUCCESS, NOT AN ERROR. An admin taps "Record & award" on a flaky
 * connection and the request lands twice; the second CAS matches nothing, the
 * ledger row from the first is found, and the caller gets `already_awarded` with
 * the entry id — which the client treats as success. That is the whole reason
 * retrying an inspection is safe to offer.
 */
export async function inspect(
  db: Db,
  id: string,
  input: InspectInput,
): Promise<InspectOutcome> {
  if (!Number.isInteger(input.qtyAccepted) || input.qtyAccepted < 0) {
    throw new BadRequestError('qtyAccepted');
  }
  if (!Number.isInteger(input.qtyRejected) || input.qtyRejected < 0) {
    throw new BadRequestError('qtyRejected');
  }
  /*
   * REQUIRED IFF SOMETHING WAS REJECTED, both ways. A rejection nobody explained
   * is a dispute with no record; a reason stored against a return where nothing
   * was rejected is a history that says "Damaged" about goods that were all
   * accepted. The UI renders the Select only when the derived count is above
   * zero, so neither direction is reachable from the screen — this is the
   * backstop for everything else that can POST.
   */
  const reason = input.rejectedReason?.trim() ?? '';
  if (input.qtyRejected > 0 && reason === '') throw new BadRequestError('rejectedReason');
  if (input.qtyRejected === 0 && reason !== '') throw new BadRequestError('rejectedReason');

  /*
   * THE BONUS, AND ITS THREE RULES.
   *
   * A REASON IS REQUIRED BOTH WAYS, exactly as the rejection reason above is: a
   * discretionary credit nobody explained is an argument with no record, and a
   * reason stored where nothing was granted is a history that describes a
   * payment that never happened.
   *
   * AND IT NEEDS SOMETHING TO SIT BESIDE. With nothing accepted there is no
   * award, no ledger row and no balance change — a "bonus" there would be a
   * manual credit wearing an inspection's clothes, which is the one shape that
   * would let money be minted on a screen built for counting goods. The owner
   * has a manual adjustment for that, under its own name, on its own route.
   */
  const bonus = input.bonusPoints;
  const bonusReason = input.bonusReason?.trim() ?? '';
  if (bonus !== undefined) {
    if (!Number.isInteger(bonus) || bonus < 1) throw new BadRequestError('bonusPoints');
    if (bonusReason === '') throw new BadRequestError('bonusReason');
    if (input.qtyAccepted < 1) throw new BadRequestError('bonusPoints');
  } else if (bonusReason !== '') {
    throw new BadRequestError('bonusReason');
  }

  const read = await readReturn(db, id);
  if (!read) throw new NotFoundError(id);
  const { labels } = read;

  /*
   * THE READ IS FOR WORDS, NOT FOR PERMISSION. `pointsPerUnitSnapshot` is
   * immutable once written — no statement in this file updates it — and the CAS
   * below refuses any row whose revision has moved, so the copy rendered from it
   * cannot describe a different award from the one the database performs. The
   * arithmetic itself is done IN SQL against the row's own column, and the
   * database checks it.
   */
  const perUnit = read.request.pointsPerUnitSnapshot;
  const points = input.qtyAccepted * perUnit;
  const awarded = input.qtyAccepted >= 1;
  const storedReason = reason === '' ? null : reason;

  const view = {
    customerEmail: read.request.customerEmail,
    qtyAccepted: input.qtyAccepted,
    qtyRejected: input.qtyRejected,
    pointsPerUnitSnapshot: perUnit,
    rejectedReason: storedReason,
  };
  const mail = awarded ? renderReturnAwarded(view, labels) : renderReturnRejected(view, labels);

  /*
   * THE CTE LIST IS ASSEMBLED, NOT TEMPLATED WITH DISABLED ARMS. The
   * alternative — one fixed statement whose unused halves are switched off by
   * `WHERE false` — binds NULLs into NOT NULL columns and asks Postgres to infer
   * their types from an INSERT that will never run, and makes every statement
   * claim to do things this inspection does not do. A rejection simply has no
   * balance CTE and no ledger CTE, which is also the assertion the test makes:
   * nothing was written, rather than something was written and reversed.
   *
   * `points_awarded` IS COMPUTED FROM THE ROW'S OWN COLUMN, so the value
   * `marketing_return_requests_award_ck` verifies and the value the ledger
   * credits are one expression rather than two computations that agree today.
   */
  const ctes: SQL[] = [
    sql`upd AS (
      UPDATE marketing_return_requests
         SET status = ${awarded ? sql`'awarded'` : sql`'rejected'`},
             qty_accepted = ${input.qtyAccepted},
             qty_rejected = ${input.qtyRejected},
             points_awarded = ${input.qtyAccepted}::integer * points_per_unit_snapshot,
             rejected_reason = ${storedReason},
             closed_at = ${input.now},
             revision = revision + 1,
             updated_at = ${input.now}
       WHERE id = ${id}
         AND ${statusIn(INSPECT_FROM)}
         AND revision = ${input.expectedRevision}
      RETURNING ${REQUEST_COLUMNS}
    )`,
  ];

  const topUp = awarded ? (bonus ?? 0) : 0;

  if (awarded) {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * ONE BALANCE UPDATE FOR BOTH LEDGER ROWS, AND IT HAS TO BE ONE.
     *
     * The obvious shape — a second `bal` CTE crediting the bonus — CANNOT WORK,
     * and it fails in the loudest possible way: `balanceUpsertFragment`'s credit
     * is an `ON CONFLICT … DO UPDATE`, and Postgres refuses to let one command
     * touch a row twice through that path. Measured against this schema: SQLSTATE
     * 21000, "cannot affect row a second time". Every inspection carrying a bonus
     * would 500.
     *
     * The general rule underneath is worse than the error: a data-modifying CTE
     * sees the snapshot from BEFORE the statement, so even where two writes are
     * permitted the second cannot read what the first did. There is no
     * arrangement of two counter updates in one statement that adds up.
     *
     * So the counter moves ONCE, by the award plus the top-up, and the two ledger
     * rows split that movement between them. The arithmetic stays reconstructible
     * from the rows because each carries its own `balance_after`.
     * ═══════════════════════════════════════════════════════════════════════
     */
    ctes.push(sql`bal AS (${balanceUpsertFragment({
      direction: 'credit',
      from: sql`upd`,
      email: sql`upd.customer_email`,
      customerId: sql`upd.customer_id`,
      amount: sql`upd.points_awarded + ${topUp}::integer`,
      now: input.now,
    })})`);
    ctes.push(sql`led AS (${ledgerInsertFragment({
      /* JOINED TO THE BALANCE CTE so `balance_after` is the number the counter
       * now holds — the "120 → 180" the ledger renders without a window
       * function over the customer's whole history. */
      from: sql`upd JOIN bal ON bal.customer_email = upd.customer_email`,
      id: newId(ID.ledger),
      email: sql`upd.customer_email`,
      customerId: sql`upd.customer_id`,
      programId: sql`upd.program_id`,
      kind: 'return_award',
      delta: sql`upd.points_awarded`,
      /*
       * THE BALANCE BEFORE THE BONUS. The counter has already moved by both, so
       * the award's own "before → after" is the final figure minus the top-up —
       * which is exactly the order the two rows are read in, and exactly what
       * the ledger would show if they had been written a second apart.
       */
      balanceAfter: sql`bal.balance - ${topUp}::integer`,
      /* Render-final: the ledger's own words, in this program's nouns, frozen
       * at this instant. A rename in June must not rewrite what March said. */
      reason: `${labels.name}: ${fmtUnits(input.qtyAccepted, labels)} accepted`,
      returnRequestId: sql`upd.id`,
      orderId: sql`NULL`,
      actorType: 'admin',
      actorId: input.actorId ?? null,
      now: input.now,
    })})`);

    if (topUp > 0) {
      ctes.push(sql`bon AS (${ledgerInsertFragment({
        from: sql`upd JOIN bal ON bal.customer_email = upd.customer_email`,
        id: newId(ID.ledger),
        email: sql`upd.customer_email`,
        customerId: sql`upd.customer_id`,
        /*
         * NO PROGRAM. A bonus is discretionary money, not points earned at the
         * programme's rate — and `awardedTotal` on the programs screen sums the
         * ledger by program, so tagging it here would quietly inflate "lifetime
         * awarded" with credits the rate never produced. The return it belongs
         * to is recorded in `return_request_id`, which is the honest link and
         * the one `marketing_ledger_bonus_uq` makes unrepeatable.
         */
        programId: sql`NULL`,
        kind: 'manual',
        delta: sql`${topUp}::integer`,
        balanceAfter: sql`bal.balance`,
        /* The owner's own words, verbatim and forever. */
        reason: bonusReason,
        returnRequestId: sql`upd.id`,
        orderId: sql`NULL`,
        actorType: 'admin',
        actorId: input.actorId ?? null,
        now: input.now,
      })})`);
    }
  }

  ctes.push(sql`evt AS (${timelineEntryFragment({
    from: sql`upd`,
    id: newId(ID.timeline),
    requestId: sql`upd.id`,
    type: 'inspected',
    actorType: 'admin',
    actorId: input.actorId ?? null,
    note: input.note ?? null,
    /*
     * THE FOUR LABEL VALUES AS THEY READ AT THIS INSTANT (spec D2d), beside the
     * counts. That is what makes a rename change the future and never the past:
     * open a return from March and the timeline still says what the customer was
     * told in March. `pointsPerUnit` travels with them so the client can rebuild
     * the exact award sentence through the shared `awardSentence` — the snapshot
     * is the labels, and the phrase is one function, so the timeline, the toast
     * and the customer's mail cannot word it differently.
     */
    data: {
      qtyAccepted: input.qtyAccepted,
      qtyRejected: input.qtyRejected,
      pointsAwarded: points,
      outcome: awarded ? 'awarded' : 'rejected',
      /* The top-up and the words that justified it, snapshotted like the labels
       * beside them — so the modal can render "120 + 25 bonus" from the history
       * a year later without re-reading a ledger row that may have been filtered
       * out of view. */
      bonusPoints: topUp > 0 ? topUp : null,
      bonusReason: topUp > 0 ? bonusReason : null,
      pointsPerUnit: perUnit,
      pointsLabelSingular: read.program.pointsLabelSingular,
      pointsLabelPlural: read.program.pointsLabelPlural,
      unitLabelSingular: read.program.unitLabelSingular,
      unitLabelPlural: read.program.unitLabelPlural,
    },
    occurredAt: input.now,
  })})`);

  ctes.push(sql`mail AS (${emailIntentFragment({
    from: sql`upd`,
    id: newId(ID.emailIntent),
    kind: awarded ? 'return_awarded' : 'return_rejected',
    requestId: sql`upd.id`,
    toEmail: sql`upd.customer_email`,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    createdAt: input.now,
  })})`);

  /* LEFT JOINs so a balance CTE that somehow wrote nothing still returns the
   * request — the mismatch is then something this function can detect and refuse
   * to report as an award, rather than an empty result set that looks exactly
   * like a lost CAS. */
  const projection = awarded
    ? sql`SELECT ${requestColumns('upd')}, bal.balance AS new_balance, led.entry_id
            FROM upd LEFT JOIN bal ON true LEFT JOIN led ON true`
    : sql`SELECT ${REQUEST_COLUMNS} FROM upd`;

  const res = await runInspectStatement(db, id, sql`WITH ${sql.join(ctes, sql`, `)} ${projection}`);

  const row = res.rows[0];
  if (!row) {
    const existing = await awardEntryId(db, id);
    if (existing) throw new AlreadyAwardedError(existing);
    return refuse(db, id, 'inspect', INSPECT_FROM, input.expectedRevision);
  }

  const request = rowToRequest(row);
  if (!awarded) return { row: request, award: null, bonus: null };

  if (row.new_balance == null || row.entry_id == null || request.pointsAwarded === null) {
    /*
     * Unreachable: the balance CTE is an upsert that cannot match zero rows once
     * `upd` produced one, and the ledger insert either writes or raises. It is
     * checked because the alternative is reporting `NaN` points to a screen that
     * will show them to a customer — a plain `Error` becomes a 500 with a
     * requestId, which is the correct answer to "the database did something this
     * code cannot explain".
     */
    throw new Error('marketing: the award moved the request without writing the credit');
  }

  return {
    row: request,
    award: { points: request.pointsAwarded, balance: Number(row.new_balance) },
    bonus: topUp > 0 ? { points: topUp, reason: bonusReason } : null,
  };
}

/**
 * Run the inspect statement, translating THE STRUCTURAL BACKSTOP into the same
 * success the CAS path reports.
 *
 * `marketing_ledger_award_uq` is what makes double-awarding impossible with
 * every guard above it deleted (spec D3), so reaching it means one of them was —
 * and the honest answer is still "this return has already been paid, here is the
 * entry", not a 500 the client retries five times. The single statement is
 * atomic, so the refused second credit took the whole second inspection with it.
 */
async function runInspectStatement(db: Db, id: string, statement: SQL) {
  try {
    return await db.execute(statement);
  } catch (err) {
    if (uniqueViolation(err) === 'marketing_ledger_award_uq') {
      const existing = await awardEntryId(db, id);
      if (existing) throw new AlreadyAwardedError(existing);
    }
    throw err;
  }
}

/** The ledger row a completed award left behind, if there is one. */
async function awardEntryId(db: Db, requestId: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT id FROM marketing_ledger
     WHERE return_request_id = ${requestId} AND kind = 'return_award'`);
  const row = res.rows[0];
  return row ? String(row.id) : null;
}
