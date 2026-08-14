import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { encodeCursor, pageLimit, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import { allowedActionsFor } from './repo';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { ReturnAction, ReturnStatus } from '../errors';

/**
 * Reading the queue — contract #4's page, its `counts` sidecar, and the mail
 * state the detail panel reports.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE DECISIONS THIS FILE MAKES THAT THE CONTRACT LEAVES OPEN, WRITTEN DOWN
 * HERE BECAUSE EACH IS VISIBLE ON A SCREEN.
 *
 * **1. The page is OLDEST FIRST.** Every other list in this application is
 * newest-first, and this one is not, because it is a work queue rather than a
 * feed: the aging bands the queue renders (`--warn` at 48h, `--danger` at 96h)
 * exist to surface the return nobody has dealt with, and a newest-first page
 * buries exactly that row three pages down. The spec's own pager copy says so
 * out loud — "Show more · 50 of 132 — oldest first". The cost is recorded
 * rather than hidden: the `done` view inherits the same ordering, so the
 * archive reads oldest-first too. One ordering for one list beats two that a
 * cursor has to be told apart.
 *
 * **2. The rows are NOT ordered by stage.** The queue draws group headers in
 * pipeline order, and it builds them itself — `MarketingReturns.tsx` filters
 * the accumulated items per status — so a server-side stage rank would be a
 * second ordering with a second cursor component, deciding nothing the client
 * does not already decide. Age alone is what a page boundary needs to be
 * stable.
 *
 * **3. `counts` SHARES THE ROW FILTERS AND IGNORES THE VIEW.** That is what
 * makes counted tabs honest here rather than the decoration `shop.css:178`
 * objects to: a tab reading "3" lists three rows when it is clicked, under
 * whatever search and program filter are active, and the pager's "50 of 132"
 * is the real size of the filtered view rather than of the table. The
 * consequence is named: while a search is typed the rail badge fed by
 * `counts.needsAction` describes the SEARCH's needs-action count, not the
 * shop's. A badge that is briefly narrower is a smaller lie than a tab strip
 * whose numbers do not match the list under it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The embedded program every row carries — contract §Types `EmbeddedProgram`,
 *  the shape `api-marketing.ts` froze and `labelsOf()` adapts client-side.
 *
 *  FLAT COLUMNS RATHER THAN THE NESTED `ProgramLabels`, because a row is what
 *  the database has and the client owns the adaptation: `labelsOf(row.program)`
 *  is one call at the one place a quantity is formatted, and a server that
 *  nested them would be pre-shaping every response for one consumer's
 *  convenience. */
export interface EmbeddedProgram {
  id: string;
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
}

/** Contract §Types `ReturnListItem`. */
export interface ReturnListItem {
  id: string;
  status: ReturnStatus;
  /** ON THE LIST, not only on the detail: the queue fires schedule/collect/
   *  receive straight from a row, and every one of them is a CAS write. */
  revision: number;
  customerEmail: string;
  customerName: string | null;
  qtyDeclared: number;
  qtyAccepted: number | null;
  qtyRejected: number | null;
  /**
   * THE RATE THIS CUSTOMER WAS PROMISED, copied onto the row at creation.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * ADDED FOR THE BOARD, AND IT HAD TO BE THE SNAPSHOT RATHER THAN THE
   * PROGRAM'S CURRENT RATE.
   *
   * A card shows what a return is WORTH — quantity times rate — so an operator
   * can see that a twelve-unit return is worth ten times a small one before
   * deciding whose van to fill. The client already holds the programs, so it
   * could multiply by `program.pointsPerUnit` and skip this field entirely.
   *
   * That would be wrong in exactly the way `points_per_unit_snapshot` exists to
   * prevent: a shop that repriced on Wednesday would see every Monday card
   * silently restated at the new rate, on the screen where somebody decides what
   * to collect. The promise is the snapshot, so the board renders the snapshot.
   * ═══════════════════════════════════════════════════════════════════════
   */
  pointsPerUnitSnapshot: number;
  pointsAwarded: number | null;
  pickupScheduledAt: number | null;
  /** Also on the list, and for the same reason as `revision`: contract #8 needs
   *  an address on the row or in the body, so a queue-inline schedule has to
   *  know which it is without fetching the detail first. */
  pickupAddress: string | null;
  /** ORDERED — the pipeline-advancing action first (spec D4). The queue renders
   *  exactly one button and renders `allowedActions[0]`. */
  allowedActions: ReturnAction[];
  /**
   * WHICH BOARD THIS CARD IS ON, with the name it should be drawn under.
   *
   * `null` IS THE OUT-OF-AREA FOOTER, not a missing field: a return from
   * somewhere we do not collect is a real row that no board can hold.
   *
   * THE NAME TRAVELS BESIDE THE ID because the desk is whole-of-city and its
   * Area column has to say which board each row lives on — and a client that
   * had to look every id up in the switcher's response would render blanks for
   * the one minute after an owner renamed a district. It is a SNAPSHOT of the
   * name at read time, like every other display field in this subsystem.
   */
  serviceArea: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  program: EmbeddedProgram;
}

/** Contract §Types `ReturnCounts` — one number per status, plus the one the
 *  rail badges. */
export interface ReturnCounts {
  requested: number;
  scheduled: number;
  collected: number;
  received: number;
  awarded: number;
  rejected: number;
  cancelled: number;
  /** `requested + received` — the two stages where the ADMIN is the blocker.
   *  Scheduled and collected are waiting on a driver, not on anybody here. */
  needsAction: number;
}

/** The mail state contract §Types calls `emailIntents` — never the bodies. The
 *  detail panel says "queued" or "sent Aug 15 09:12" or shows the failure, and
 *  a rendered subject and two rendered bodies per return are a payload nothing
 *  on that screen reads. */
export interface EmailIntentState {
  kind: string;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
}

export type ReturnView =
  | 'needs_action'
  | 'requested'
  | 'scheduled'
  | 'collected'
  | 'received'
  | 'done'
  | 'all';

/**
 * The board the list is scoped to.
 *
 * `'none'` IS A REAL VALUE AND NOT AN ABSENT ONE — it is the out-of-area
 * footer's list, `service_area_id IS NULL`. Absent means every board at once,
 * which is what the desk above the boards asks for.
 */
export const OUT_OF_AREA = 'none';

export interface ReturnListQuery {
  view: ReturnView;
  /** An email prefix, or an exact `ret_` id. */
  q?: string;
  programId?: string;
  /** An area id, or `'none'` for the returns that belong to no board. */
  district?: string;
  cursor?: string;
  limit?: number;
}

export interface ReturnPage {
  items: ReturnListItem[];
  nextCursor: string | null;
  /** On EVERY response, not from a second request. */
  counts: ReturnCounts;
}

/**
 * The seven statuses in pipeline order — the order the queue draws its group
 * headers in and the order `counts` is declared in.
 *
 * `ALL_STATUSES` is the `all` view and is also what the counts map is seeded
 * from, so a status added to the column CHECK and forgotten here shows up as a
 * missing tab rather than as a count that is silently short.
 */
const OPEN_STATUSES: readonly ReturnStatus[] = [
  'requested',
  'scheduled',
  'collected',
  'received',
];
const CLOSED_STATUSES: readonly ReturnStatus[] = ['awarded', 'rejected', 'cancelled'];
const ALL_STATUSES: readonly ReturnStatus[] = [...OPEN_STATUSES, ...CLOSED_STATUSES];

/**
 * `view` → the statuses it holds (contract #4).
 *
 * `needs_action` IS `requested + received` AND NOT "everything open". The four
 * open statuses are not equally the admin's problem: `scheduled` and
 * `collected` are waiting on a driver, and a queue that listed them as work
 * would be a queue nobody could empty.
 */
export const VIEW_STATUSES: Record<ReturnView, readonly ReturnStatus[]> = {
  needs_action: ['requested', 'received'],
  requested: ['requested'],
  scheduled: ['scheduled'],
  collected: ['collected'],
  received: ['received'],
  done: CLOSED_STATUSES,
  all: ALL_STATUSES,
};

/**
 * The ordering a cursor is bound to, and the reason it is a constant rather
 * than a literal at the two call sites.
 *
 * `requireCursor` refuses a cursor minted under a different ordering, which is
 * what stops a page boundary from silently skipping rows when a list's sort
 * changes. This list has exactly one ordering, so the name is arbitrary — what
 * matters is that the minting call and the spending call use the same one, and
 * a constant is how that stays true.
 */
const SORT_KEY = 'queue';

/**
 * How long a search term may be.
 *
 * 320 is the longest address RFC 5321 allows (`64 + @ + 255`) and a return id
 * is 25 characters, so nothing longer can match either side of the predicate —
 * bounding it here means a 4 kB query string is refused before it is bound
 * rather than after it has been compared against every row. The same number,
 * for the same reason, as `server/shop/admin/orders.ts`'s search.
 */
export const MAX_SEARCH_LENGTH = 320;

const LIST_COLUMNS = sql.raw(
  `r.id, r.status, r.revision, r.customer_email, r.customer_name, r.qty_declared,
   r.qty_accepted, r.qty_rejected, r.points_per_unit_snapshot, r.points_awarded,
   r.pickup_scheduled_at, r.pickup_address, r.service_area_id, r.created_at, r.updated_at,
   p.id AS prog_id, p.name AS prog_name,
   p.points_label_singular AS prog_points_one, p.points_label_plural AS prog_points_other,
   p.unit_label_singular AS prog_unit_one, p.unit_label_plural AS prog_unit_other,
   a.name AS area_name`,
);

/**
 * NARROWER THAN THE DETAIL'S SELECT, deliberately — the `LIST_POST_COLUMNS`
 * rule. A queue row renders an email, a quantity, an age and one button; the
 * driver's name and phone, the four timestamps and the rejection reason are
 * bytes shipped to be discarded. The alias prefix on the program's columns is
 * the one `readReturn` uses, so a reader moving between the two files does not
 * have to learn a second naming.
 */
function rowToListItem(row: Record<string, unknown>): ReturnListItem {
  const status = row.status as ReturnStatus;
  return {
    id: String(row.id),
    status,
    revision: Number(row.revision),
    customerEmail: String(row.customer_email),
    customerName: row.customer_name == null ? null : String(row.customer_name),
    qtyDeclared: Number(row.qty_declared),
    qtyAccepted: row.qty_accepted == null ? null : Number(row.qty_accepted),
    qtyRejected: row.qty_rejected == null ? null : Number(row.qty_rejected),
    pointsPerUnitSnapshot: Number(row.points_per_unit_snapshot),
    pointsAwarded: row.points_awarded == null ? null : Number(row.points_awarded),
    // `toEpochMsOrNull` and not `Number`: these are `bigint` columns, which the
    // Neon driver hands back as STRINGS and which the test harness configures
    // PGlite to imitate.
    pickupScheduledAt: toEpochMsOrNull(row.pickup_scheduled_at),
    pickupAddress: row.pickup_address == null ? null : String(row.pickup_address),
    /*
     * SERVED, NEVER GUESSED (spec D4). The same pure function the transitions
     * and the 409 payloads answer with, so the button a row offers and the
     * transition the server will accept cannot drift apart.
     */
    allowedActions: allowedActionsFor(status),
    /* Both halves or neither. The join is LEFT — an out-of-area return has no
     * area row — so a name with no id would mean the join matched something the
     * column does not point at, which is a bug rather than a card. */
    serviceArea:
      row.service_area_id == null
        ? null
        : { id: String(row.service_area_id), name: String(row.area_name) },
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    program: {
      id: String(row.prog_id),
      name: String(row.prog_name),
      pointsLabelSingular: String(row.prog_points_one),
      pointsLabelPlural: String(row.prog_points_other),
      unitLabelSingular: row.prog_unit_one == null ? null : String(row.prog_unit_one),
      unitLabelPlural: row.prog_unit_other == null ? null : String(row.prog_unit_other),
    },
  };
}

function statusIn(statuses: readonly ReturnStatus[]): SQL {
  return sql`r.status IN (${sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  )})`;
}

/**
 * The filters that describe WHICH RETURNS, as opposed to which stage of them.
 *
 * SEPARATE FROM THE VIEW BECAUSE `counts` REUSES EXACTLY THESE and nothing
 * else. That is the whole mechanism behind decision 3 in this file's header:
 * the tab strip's numbers are computed over the same rows the list is drawn
 * from, minus the one predicate the tabs are choosing between.
 */
function rowFilters(q: ReturnListQuery): SQL[] {
  const where: SQL[] = [sql`true`];

  if (q.programId !== undefined) where.push(sql`r.program_id = ${q.programId}`);

  /*
   * THE BOARD, AND IT IS A ROW FILTER RATHER THAN A VIEW ONE — which is the
   * whole reason it lives here.
   *
   * `rowFilters` is what `counts` reuses, so a board's tab strip reads "3
   * requested" and lists exactly those three when clicked. Put anywhere else,
   * the switcher would badge Maitama with the city's numbers.
   *
   * `'none'` IS `IS NULL` AND NOT AN EQUALITY. `service_area_id = 'none'`
   * matches nothing and silently answers "the out-of-area list is empty", which
   * is the most dangerous possible lie here: those are exactly the returns
   * nobody can award, and they would vanish from the one surface built to find
   * them.
   */
  if (q.district !== undefined) {
    where.push(
      q.district === OUT_OF_AREA
        ? sql`r.service_area_id IS NULL`
        : sql`r.service_area_id = ${q.district}`,
    );
  }

  const term = q.q?.trim() ?? '';
  if (term !== '') {
    /*
     * ONE PREDICATE FOR BOTH HALVES OF "email prefix or exact `ret_` id", and
     * no branch on the shape of the term. A branch would have to decide what
     * `ret_` alone means, and would be wrong for the address that legitimately
     * starts with it; OR-ing the two costs one equality test against a primary
     * key and cannot mis-route anything.
     *
     * `starts_with` RATHER THAN `LIKE`, the `server/domain/slug.ts` rule: `_`
     * and `%` are pattern metacharacters, and a search box is the one input
     * where a customer's address containing an underscore is ordinary. The
     * column is lower-case by CHECK, so only the term is folded.
     *
     * A PREFIX AND NOT A SUBSTRING, the `server/shop/admin/orders.ts` stance:
     * `LIKE '%bob%'` is a sequential scan for every keystroke of a debounced
     * box AND lets one customer's address be discovered by typing fragments.
     * This box finds the return you were given; it does not browse.
     */
    where.push(
      sql`(r.id = ${term} OR starts_with(r.customer_email, ${term.toLowerCase()}))`,
    );
  }

  return where;
}

function emptyCounts(): ReturnCounts {
  return {
    requested: 0,
    scheduled: 0,
    collected: 0,
    received: 0,
    awarded: 0,
    rejected: 0,
    cancelled: 0,
    needsAction: 0,
  };
}

/**
 * Every status's count in ONE grouped statement, not seven.
 *
 * `needsAction` is DERIVED from the two it sums rather than counted a second
 * time, so the rail badge and the "Needs action" tab cannot disagree — they are
 * the same addition.
 */
async function readCounts(db: Db, q: ReturnListQuery): Promise<ReturnCounts> {
  const res = await db.execute(sql`
    SELECT r.status, count(*)::int AS n
      FROM marketing_return_requests r
     WHERE ${sql.join(rowFilters(q), sql` AND `)}
     GROUP BY r.status`);

  const counts = emptyCounts();
  for (const row of res.rows) {
    const status = String(row.status) as ReturnStatus;
    // A status the column CHECK allows and this file has not heard of is
    // dropped rather than added to a total it does not belong in.
    if (status in counts) counts[status] = Number(row.n);
  }
  counts.needsAction = counts.requested + counts.received;
  return counts;
}

/**
 * Contract #4 — the page and its counts.
 *
 * TWO STATEMENTS AND NOT ONE. A single statement carrying the counts as
 * window functions beside every row would ship seven numbers per row to
 * describe the whole table once, and would make the count depend on the page's
 * `LIMIT` the moment somebody edited the frame. Two reads against the same
 * filters is the honest shape, and it is the shape the counts' independence
 * from `view` demands anyway.
 */
export async function listReturns(db: Db, q: ReturnListQuery): Promise<ReturnPage> {
  const size = pageLimit(q.limit);
  const where = rowFilters(q);

  /*
   * `all` ADDS NO PREDICATE rather than listing every status: `status IN (…all
   * seven…)` is a tautology that no index can use and that would have to be
   * kept in step with the CHECK forever.
   */
  if (q.view !== 'all') where.push(statusIn(VIEW_STATUSES[q.view]));

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    // The payload is base64 JSON, so a hand-made cursor can name the right
    // ordering and still carry the wrong shape.
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const at = Number(cursor.sortValues[0]);
    if (!Number.isFinite(at)) throw new BadRequestError('cursor');
    /*
     * The lexicographic "strictly after this row" predicate of
     * `server/shop/catalog/query.ts`, specialised to one ascending component.
     * THE ID TIEBREAK IS WHAT MAKES THE ORDER TOTAL: two returns logged in the
     * same millisecond — an import, a burst — would otherwise be returned twice
     * or skipped entirely across a page boundary, with no error anywhere.
     */
    where.push(sql`(r.created_at > ${at} OR (r.created_at = ${at} AND r.id > ${cursor.id}))`);
  }

  const res = await db.execute(sql`
    SELECT ${LIST_COLUMNS}
      FROM marketing_return_requests r
      JOIN marketing_programs p ON p.id = r.program_id
      /* LEFT, because out-of-area is a legal state and an inner join would
       * silently drop exactly the rows the footer exists to surface. */
      LEFT JOIN marketing_service_areas a ON a.id = r.service_area_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const rows = res.rows.slice(0, size);
  const items = rows.map(rowToListItem);
  const last = items[items.length - 1];
  const more = res.rows.length > size;

  return {
    items,
    nextCursor:
      more && last ? encodeCursor(SORT_KEY, [last.createdAt], last.id) : null,
    counts: await readCounts(db, q),
  };
}

/**
 * One row, in exactly the shape the list ships it in.
 *
 * THE SAME COLUMNS AND THE SAME MAPPER AS THE PAGE, so a card a bulk action just
 * moved is byte-identical to the card the next refresh draws. `POST
 * /returns/bulk` reports a per-item `request` and the board re-renders that card
 * from it without refetching; a second projection here — even a correct one —
 * would be a second place the card's shape has to be kept in step, and the drift
 * would show up as one card in fifty rendering differently from its neighbours.
 *
 * `null` for an id that is not there, which is what a bulk item whose return was
 * deleted mid-flight looks like.
 */
export async function readListItem(db: Db, id: string): Promise<ReturnListItem | null> {
  const res = await db.execute(sql`
    SELECT ${LIST_COLUMNS}
      FROM marketing_return_requests r
      JOIN marketing_programs p ON p.id = r.program_id
      LEFT JOIN marketing_service_areas a ON a.id = r.service_area_id
     WHERE r.id = ${id}`);
  const row = res.rows[0];
  return row ? rowToListItem(row) : null;
}

/**
 * What this return owes the customer by mail, and how that is going.
 *
 * OLDEST FIRST, like the timeline: an awarded return has one intent and a
 * rejected one has one, but a return that was rejected and later reopened by
 * hand would have both, and the order they were written in is the order they
 * happened in.
 */
export async function listEmailIntents(
  db: Db,
  requestId: string,
): Promise<EmailIntentState[]> {
  const res = await db.execute(sql`
    SELECT kind, sent_at, attempts, last_error
      FROM marketing_email_intents
     WHERE return_request_id = ${requestId}
     ORDER BY created_at ASC, id ASC`);

  return res.rows.map((row) => ({
    kind: String(row.kind),
    sentAt: toEpochMsOrNull(row.sent_at),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
  }));
}
