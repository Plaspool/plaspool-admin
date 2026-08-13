import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { encodeCursor, pageLimit, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import { InsufficientBalanceError } from '../errors';
import { ID, newId } from '../ids';
import { balanceUpsertFragment, ledgerInsertFragment } from './fragments';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { ReturnStatus } from '../errors';
import type { ActorType, LedgerKind } from './fragments';

/**
 * The points ledger, the balances it explains, and the customer directory that
 * reads both — contract #15-18.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `credit()` AND `debit()` ARE THE FRAGMENTS FROM `fragments.ts` WITH A
 * STATEMENT AROUND THEM, AND THAT IS THE WHOLE POINT OF THEM.
 *
 * `returns/repo.ts` chains those same builders inline off its inspect CAS,
 * because an award has to happen in the statement that closes the return.
 * Nothing else does: a manual adjustment and A8's redemption have no
 * preceding transition to hang off, so they need an executor — and the
 * alternative to wrapping the shared builders is a second implementation of
 * balance semantics. That second implementation is the one that maintains
 * `balance` and forgets `lifetime_earned`, or writes a `balance_after` computed
 * in TypeScript from a number it read a moment ago. Neither is visible until a
 * customer's history stops adding up.
 *
 * So there is ONE upsert and ONE ledger insert in this subsystem, and two
 * callers. What this file adds is the statement frame: the anchor a standalone
 * write hangs off, the read-back that turns a zero-row debit into
 * `409 insufficient_balance`, and nothing else.
 *
 * EVERY WRITE HERE IS STILL ONE STATEMENT, AND NEVER `db.transaction` — the
 * Neon HTTP driver throws on it unconditionally while PGlite supports it, so a
 * transaction would pass every test in this repository and 500 in production
 * (spec §Global constraints). A credit whose balance moved and whose ledger row
 * did not is a wallet nobody can explain.
 *
 * THE DEBIT'S GUARD IS THE RACE FIX. `WHERE balance >= amount` lives in the
 * fragment; the loser of two concurrent debits updates zero rows, its ledger
 * INSERT selects from an empty CTE and writes nothing, and this file turns that
 * into the error that quotes the live balance. There is no read-then-decide
 * anywhere in the write path, because a balance judged in TypeScript is judged
 * against a number another request has already spent.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ------------------------------------------------------------- wire shapes

/** Contract §Types `LedgerEntry`. */
export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** SIGNED — the ledger is the arithmetic. */
  delta: number;
  /** The balance as it stood AFTER this row, recorded by the statement that
   *  wrote it, so "120 → 180" needs no window function. */
  balanceAfter: number;
  /**
   * RENDER-FINAL AT WRITE TIME (spec D2d). Displayed verbatim and never
   * re-rendered through today's labels: a rename in June must not rewrite what
   * March said.
   */
  reason: string;
  programId: string | null;
  /**
   * The program's CURRENT name, joined at read time — a live pointer, NOT part
   * of the snapshot. `reason` is the frozen wording; this is "which program is
   * that, today", for a link and a grouping. A screen that rendered a history
   * row's copy out of this field instead of out of `reason` would be the
   * rename-rewrites-the-past bug wearing a join.
   */
  programName: string | null;
  returnRequestId: string | null;
  orderId: string | null;
  actorType: ActorType;
  actorId: string | null;
  createdAt: number;
}

/** Contract §Types `CustomerRow` — one line of the directory. */
export interface CustomerRow {
  /** The FOLDED address. It is this row's identity and the cursor's id. */
  email: string;
  customerId: string | null;
  displayName: string | null;
  /** `customerId === null`. Guest checkout is the default path, so this is the
   *  ordinary case rather than a degenerate one (spec D10). */
  guest: boolean;
  balance: number;
  lifetimeEarned: number;
  lastEntryAt: number | null;
  /** Enough of the newest row to say what last happened, without a second
   *  request per line. `null` for an account that has never earned anything. */
  lastEntry: { kind: LedgerKind; delta: number; reason: string } | null;
}

/** Contract §Types `CustomerSummary` — the detail header. */
export interface CustomerSummary {
  email: string;
  customerId: string | null;
  displayName: string | null;
  balance: number;
  lifetimeEarned: number;
  /** At most one by `marketing_return_requests_open_uq` (spec D4). The detail
   *  header links to it rather than making an admin search for it. */
  openReturn: { id: string; status: ReturnStatus } | null;
}

// ---------------------------------------------------------------- the email

/**
 * How long an address may be before it is refused rather than compared.
 *
 * 320 is RFC 5321's ceiling (`64 + @ + 255`), the same number and the same
 * argument as `returns/query.ts`'s search bound — written out here rather than
 * imported across two sibling subsystems for one integer, in the same spirit as
 * the mkt-prefixed duplication doctrine (spec D11). The directory's search also
 * matches customer ids, which are shorter still, so nothing longer than this can
 * match either half of the predicate.
 */
export const MAX_QUERY_LENGTH = 320;

/**
 * The address, as an identity.
 *
 * FOLDED HERE AND NOT AT THE CALL SITES. `marketing_balances`,
 * `marketing_ledger` and the open-return index all key on the lower-cased
 * address, and all three columns carry a CHECK that refuses anything else — so
 * `Dara@x` reaching a bind is not two wallets, it is SQLSTATE 23514 and a 500
 * for a perfectly ordinary input. `returns/repo.ts` folds in exactly the same
 * place and for exactly the same reason.
 */
export function foldEmail(value: string, field = 'email'): string {
  const folded = value.trim().toLowerCase();
  if (folded === '' || folded.length > MAX_QUERY_LENGTH) throw new BadRequestError(field);
  return folded;
}

// ------------------------------------------------------------- the executors

/**
 * A movement of points, in whichever direction the caller chose.
 *
 * `amount` IS A POSITIVE MAGNITUDE AND THE SIGN LIVES IN THE STATEMENT, so
 * `balance >= amount` reads as the question it is and a caller cannot express
 * "credit minus sixty". The ledger's `delta` is signed, because a ledger is
 * arithmetic; the arguments to a debit are not.
 */
export interface BalanceMoveInput {
  email: string;
  /** Positive. The direction is the function that was called. */
  amount: number;
  /** RENDER-FINAL: already interpolated from the labels of this instant. */
  reason: string;
  kind: LedgerKind;
  /** The shop's id, when the caller knows one. First writer wins on the balance
   *  row — see `balanceUpsertFragment`. */
  customerId?: string | null;
  programId?: string | null;
  returnRequestId?: string | null;
  orderId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  now: number;
}

export interface BalanceMoveResult {
  /** Minted before the statement, so it can be reported without a second read
   *  — and so A8's replay path has something to compare against. */
  entryId: string;
  /** The balance as it now stands, read off the counter rather than computed. */
  balance: number;
}

/**
 * The one-row source a standalone write hangs off.
 *
 * The fragments take a `from` because in `returns/repo.ts` it is the CAS CTE:
 * zero rows there means zero balance change, which is the structural guarantee
 * that whole design is built on. A credit that no transition gates has nothing
 * to be gated by, and `(SELECT 1)` says exactly that — this write is
 * unconditional, and it is unconditional on purpose.
 *
 * Aliased `anchor` rather than `src`, which is the name `balanceUpsertFragment`
 * gives its own inner subquery. Both would be legal — they are different scopes
 * — and a reader should not have to work that out.
 */
const ANCHOR = sql.raw('(SELECT 1) anchor');

/** A bound value, or SQL `NULL`, cast where it lands by the fragment. */
const orNull = (value: string | null | undefined): SQL => sql`${value ?? null}`;

/**
 * Both executors, minus the one line that differs.
 *
 * The direction decides the balance CTE (an upsert that creates a wallet, or a
 * guarded UPDATE that refuses to overdraw one) and the sign of `delta`.
 * Everything else — the ledger row, the id, the projection, the `balance_after`
 * read off the balance CTE — is identical, and writing it twice is how the two
 * paths eventually disagree about which columns a ledger row has.
 */
async function move(
  db: Db,
  direction: 'credit' | 'debit',
  input: BalanceMoveInput,
): Promise<BalanceMoveResult> {
  const email = foldEmail(input.email);
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new BadRequestError('amount');
  }
  /*
   * TRIMMED HERE AND STORED TRIMMED, one rule for every caller. A blank is not a
   * value: `marketing_ledger_reason_ck` only refuses the empty string, so a
   * field of spaces would satisfy it and render as nothing in the one column
   * that explains why a balance moved. The routes' zod trims too — this is the
   * backstop for anything reaching the executors from somewhere else, which by
   * A8 is the checkout seam.
   */
  const reason = input.reason.trim();
  if (reason === '') throw new BadRequestError('reason');

  const entryId = newId(ID.ledger);
  const amount = sql`${input.amount}`;

  const balance =
    direction === 'credit'
      ? balanceUpsertFragment({
          direction: 'credit',
          from: ANCHOR,
          email: sql`${email}`,
          customerId: orNull(input.customerId),
          amount,
          now: input.now,
        })
      : balanceUpsertFragment({
          direction: 'debit',
          from: ANCHOR,
          email: sql`${email}`,
          amount,
          now: input.now,
        });

  const res = await db.execute(sql`
    WITH bal AS (
      ${balance}
    ), led AS (
      ${ledgerInsertFragment({
        /* THE BALANCE CTE, so `balance_after` is the number the counter now
         * holds rather than one this process computed from a stale read. It is
         * also what makes a refused debit write nothing: no balance row, no
         * ledger row, one statement. */
        from: sql`bal`,
        id: entryId,
        email: sql`bal.customer_email`,
        /* Bound rather than read off `bal`: the debit CTE returns the email and
         * the balance and deliberately not the wallet's `customer_id`, because a
         * debit must not re-stamp it. What the caller knows about this spender
         * still belongs on the ledger row that records the spend. */
        customerId: orNull(input.customerId),
        programId: orNull(input.programId),
        kind: input.kind,
        delta: direction === 'credit' ? amount : sql`${-input.amount}`,
        balanceAfter: sql`bal.balance`,
        reason,
        returnRequestId: orNull(input.returnRequestId),
        orderId: orNull(input.orderId),
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        now: input.now,
      })}
    )
    SELECT entry_id, balance_after FROM led`);

  const row = res.rows[0];
  if (!row) {
    /*
     * A CREDIT CANNOT GET HERE — its balance CTE is an upsert with no predicate
     * — so zero rows is always the debit's guard, and the guard has exactly one
     * meaning: there was not enough. That covers the address with no wallet at
     * all, which is the same answer from the customer's side.
     *
     * The balance is RE-READ rather than reported from anything this function
     * held, because the number the caller was showing is by definition stale —
     * the refusal proves something moved after it was read — and the client's
     * copy quotes it ("this customer has 40").
     */
    throw new InsufficientBalanceError(await readBalance(db, email));
  }

  return { entryId: String(row.entry_id), balance: Number(row.balance_after) };
}

/**
 * Points in. Creates the wallet if this is the customer's first ever.
 *
 * EVERY CREDIT MOVES `lifetime_earned`, including A8's `redemption_release`,
 * because `balanceUpsertFragment` maintains it for all of them and there is
 * deliberately no per-kind branch. That is the spec's own definition — "counts
 * credits only" — and the alternative is the drift a shared builder exists to
 * prevent: one caller that remembers the counter and one that does not.
 */
export const credit = (db: Db, input: BalanceMoveInput): Promise<BalanceMoveResult> =>
  move(db, 'credit', input);

/**
 * Points out, and never below zero.
 *
 * Throws `InsufficientBalanceError` carrying the live balance. It reports a
 * refusal that ALREADY HAPPENED in the `WHERE balance >= amount` of the
 * statement rather than performing a check of its own — which is what makes two
 * concurrent debits of 60 against 100 resolve to exactly one row instead of a
 * negative wallet and a CHECK violation.
 */
export const debit = (db: Db, input: BalanceMoveInput): Promise<BalanceMoveResult> =>
  move(db, 'debit', input);

/** The counter, or zero. A customer with no history HAS a zero balance — there
 *  is no such thing as an unknown wallet here (spec D10). */
export async function readBalance(db: Db, email: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT balance FROM marketing_balances WHERE customer_email = ${email}`);
  const row = res.rows[0];
  return row ? Number(row.balance) : 0;
}

// ------------------------------------------------------------- adjustments

export interface AdjustmentInput {
  email: string;
  /** SIGNED, unlike the executors': this is what an admin typed, and the sign
   *  is the Credit/Debit control they chose. */
  delta: number;
  reason: string;
  programId?: string;
  customerId?: string;
  actorId: string;
  now: number;
}

export interface Adjustment {
  entry: LedgerEntry;
  balance: number;
}

/**
 * Contract #18 — the walk-in credit, and the correction for the one that was
 * wrong.
 *
 * KIND `manual`, WHICH IS THE ONLY KIND WITH NO STRUCTURAL COUNTERPART. An
 * award points at the return it paid for and a redemption points at the order it
 * discounted, and the partial uniques make each of them happen once. A manual
 * adjustment points at a person's judgement — so `reason` is REQUIRED, and it is
 * the only record of why the number moved.
 *
 * OWNER-ONLY AT THE ROUTE (spec D12's frozen role matrix): processing a return
 * is any staff member's work, and minting points from nothing is not.
 */
export async function adjust(db: Db, input: AdjustmentInput): Promise<Adjustment> {
  /*
   * `delta <> 0` IS ALSO `marketing_ledger_delta_ck`, and reaching the CHECK
   * would be SQLSTATE 23514 — a 500 the client retries five times for a number
   * that can never be accepted. Named here it is an inline error on the amount
   * input, which is where the fix is. The field name is `delta` and not `amount`
   * because that is what the body calls it.
   */
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new BadRequestError('delta');
  if (input.reason.trim() === '') throw new BadRequestError('reason');

  /*
   * An unknown program is a FIELD error, not a 500 — the same call contract #20
   * makes for `defaultReturnProgramId`, and for the same shape of mistake: the
   * value came from a Select whose options were fetched a moment ago. Left to
   * the database it is `marketing_ledger_program_id_fkey`, SQLSTATE 23503, which
   * has no row in the error table.
   *
   * Advisory rather than a predicate, exactly as `patchSettings`'s is: there is
   * no DELETE route for a program anywhere in this subsystem (programs pause
   * forever, because ledger rows reference them) and the FK is `ON DELETE
   * RESTRICT`, so the window this read cannot close is one nothing can open.
   */
  if (input.programId !== undefined) {
    const found = await db.execute(sql`
      SELECT 1 FROM marketing_programs WHERE id = ${input.programId}`);
    if (found.rows.length === 0) throw new BadRequestError('programId');
  }

  const write: BalanceMoveInput = {
    email: input.email,
    amount: Math.abs(input.delta),
    /* `move` trims and refuses a blank; the check above is here so the field
     * error names `reason` before anything else about the body is judged. */
    reason: input.reason,
    kind: 'manual',
    customerId: input.customerId ?? null,
    programId: input.programId ?? null,
    /* `admin`, always. A manual adjustment is by definition somebody's decision,
     * and `actorId` is who to ask about it. */
    actorType: 'admin',
    actorId: input.actorId,
    now: input.now,
  };

  const { entryId, balance } =
    input.delta > 0 ? await credit(db, write) : await debit(db, write);

  /*
   * A SECOND STATEMENT, AND IT IS A READ. The write above is atomic on its own;
   * this fetches the row back for the wire — with the program's current name,
   * which the insert had no reason to join. It cannot be folded into the write:
   * a data-modifying CTE's siblings see the snapshot from the start of the
   * statement, so `SELECT … FROM marketing_ledger` beside the INSERT would not
   * see the row the INSERT just wrote.
   */
  const entry = await getEntry(db, entryId);
  if (!entry) {
    /* Unreachable: the INSERT either wrote the row or raised. Checked because
     * the alternative is a 201 with a null body on the screen that has just told
     * an admin the points were moved. */
    throw new Error('marketing: the adjustment was written and cannot be read back');
  }
  return { entry, balance };
}

// ------------------------------------------------------------------ reading

const LEDGER_COLUMNS = sql.raw(
  `l.id, l.kind, l.delta, l.balance_after, l.reason, l.program_id,
   l.return_request_id, l.order_id, l.actor_type, l.actor_id, l.created_at`,
);

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    id: String(row.id),
    kind: row.kind as LedgerKind,
    // `Number` and not `toEpochMs`: `delta` and `balance_after` are `integer`
    // columns, which both drivers agree about. Only `created_at` is int8.
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    reason: String(row.reason),
    programId: row.program_id == null ? null : String(row.program_id),
    programName: row.program_name == null ? null : String(row.program_name),
    returnRequestId: row.return_request_id == null ? null : String(row.return_request_id),
    orderId: row.order_id == null ? null : String(row.order_id),
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id == null ? null : String(row.actor_id),
    createdAt: toEpochMs(row.created_at),
  };
}

/** One entry, with the program's current name. `null` for an id that is not
 *  there — this is a lookup, and the callers all have their own answer for a
 *  miss. */
export async function getEntry(db: Db, id: string): Promise<LedgerEntry | null> {
  const res = await db.execute(sql`
    SELECT ${LEDGER_COLUMNS}, p.name AS program_name
      FROM marketing_ledger l
      LEFT JOIN marketing_programs p ON p.id = l.program_id
     WHERE l.id = ${id}`);
  return res.rows[0] ? rowToEntry(res.rows[0]) : null;
}

/**
 * Contract #17's `?kind=` — a VIEW over the history, not a column value.
 *
 * `redemptions` IS BOTH SIDES OF A REDEMPTION. A cancelled order that was paid
 * for with points has a debit and the credit that undid it, and a filter that
 * showed one without the other would make a customer's spend look permanent
 * when it had been refunded. `all` adds no predicate rather than listing every
 * kind, which would be a tautology to keep in step with the CHECK forever.
 */
export type LedgerFilter = 'awards' | 'manual' | 'redemptions' | 'all';

const FILTER_KINDS: Record<LedgerFilter, readonly LedgerKind[] | null> = {
  awards: ['return_award'],
  manual: ['manual'],
  redemptions: ['redemption', 'redemption_release'],
  all: null,
};

export interface LedgerQuery {
  kind?: LedgerFilter;
  cursor?: string;
  limit?: number;
}

export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

/**
 * The cursor's sort key.
 *
 * ONE ORDERING, so a cursor can never be spent against the wrong column.
 * `requireCursor` binds the token to the name, and `server/repo/cursor.ts`
 * measured both of the things that happen when it is not: a type error the
 * client retries five times, and a page that silently returned 2 of 8 rows.
 */
const LEDGER_SORT = 'ledger';

/**
 * Contract #17 — one customer's history, NEWEST FIRST.
 *
 * The opposite direction from the returns queue, and deliberately: this is a
 * statement, not a work queue. It is also the order
 * `marketing_ledger_customer_idx` is built in — `(customer_email, created_at
 * DESC, id DESC)` — so the page is an index range scan rather than a sort.
 *
 * THE ID TIEBREAK IS WHAT MAKES THE ORDER TOTAL. Two rows written in the same
 * millisecond — an award and the adjustment correcting it — would otherwise be
 * returned twice or skipped entirely across a page boundary, with no error
 * anywhere.
 */
export async function listLedger(
  db: Db,
  email: string,
  q: LedgerQuery = {},
): Promise<LedgerPage> {
  const size = pageLimit(q.limit);
  const where: SQL[] = [sql`l.customer_email = ${email}`];

  const kinds = FILTER_KINDS[q.kind ?? 'all'];
  if (kinds) {
    where.push(
      sql`l.kind IN (${sql.join(
        kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    );
  }

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, LEDGER_SORT);
    // The payload is base64 JSON, so a hand-made cursor can name the right
    // ordering and still carry the wrong shape.
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const at = Number(cursor.sortValues[0]);
    if (!Number.isFinite(at)) throw new BadRequestError('cursor');
    where.push(
      sql`(l.created_at < ${at} OR (l.created_at = ${at} AND l.id < ${cursor.id}))`,
    );
  }

  const res = await db.execute(sql`
    SELECT ${LEDGER_COLUMNS}, p.name AS program_name
      FROM marketing_ledger l
      LEFT JOIN marketing_programs p ON p.id = l.program_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const items = res.rows.slice(0, size).map(rowToEntry);
  const last = items[items.length - 1];
  const more = res.rows.length > size;

  return {
    items,
    nextCursor: more && last ? encodeCursor(LEDGER_SORT, [last.createdAt], last.id) : null,
  };
}

// ---------------------------------------------------------- the directory

/**
 * The account row for an address, at most one.
 *
 * A LATERAL WITH `LIMIT 1` RATHER THAN A PLAIN `LEFT JOIN`, and the reason is a
 * real hazard rather than style: `shop_customers_email_uq` is UNIQUE on the RAW
 * column, so `Dara@x` and `dara@x` are two legal rows that both match
 * `lower(email) = $folded`. A plain join would emit the same customer twice —
 * two identical directory lines, one of them spending a slot of the page limit
 * and the pager quietly counting it. `server/shop/admin/customers.ts` closes the
 * same hole with `max(c.id)` on the other side of the boundary.
 *
 * READ BY SQL AND NEVER BY IMPORT. `shop_customers` belongs to the shop, and
 * spec D9/D10 forbid marketing importing its code; this is a read-only prefix
 * search over a table, which is the whole of the coupling.
 */
const accountLateral = (email: SQL): SQL => sql`
  LEFT JOIN LATERAL (
    SELECT c.id, c.display_name
      FROM shop_customers c
     WHERE c.email IS NOT NULL AND lower(c.email) = ${email}
     ORDER BY c.id
     LIMIT 1
  ) acc ON true`;

/** The four statuses `marketing_return_requests_open_uq` treats as in flight. */
const OPEN_STATUSES: readonly ReturnStatus[] = [
  'requested',
  'scheduled',
  'collected',
  'received',
];

const openStatusIn = (): SQL =>
  sql`status IN (${sql.join(
    OPEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )})`;

/**
 * Contract #16 — ZEROS FOR AN UNKNOWN ADDRESS, NEVER A 404.
 *
 * A customer with no history IS a zero balance (spec D10), and the screen that
 * asks this question is reached from the no-match empty state's owner-only
 * "Credit <typed email> anyway →". Answering `gone` there would render a
 * whole-screen "no longer exists" for a person the admin is about to create a
 * wallet for — which is the walk-in the brief exists to support.
 *
 * ONE STATEMENT, hung off a one-row source, so the balance, the account and the
 * open return are read at one instant instead of three. `LEFT JOIN` everywhere
 * means the row always comes back.
 */
export async function getCustomerSummary(db: Db, email: string): Promise<CustomerSummary> {
  const res = await db.execute(sql`
    SELECT b.customer_id AS wallet_customer_id, b.balance, b.lifetime_earned,
           acc.id AS account_id, acc.display_name,
           r.id AS return_id, r.status AS return_status
      FROM (SELECT ${email}::text AS email) src
      LEFT JOIN marketing_balances b ON b.customer_email = src.email
      ${accountLateral(sql`src.email`)}
      LEFT JOIN LATERAL (
        SELECT id, status
          FROM marketing_return_requests
         WHERE customer_email = src.email AND ${openStatusIn()}
         ORDER BY created_at DESC, id DESC
         LIMIT 1
      ) r ON true`);

  /* The one-row source guarantees exactly one row whatever the LEFT JOINs find,
   * so this is read defensively rather than because a miss is expected. */
  const row: Record<string, unknown> = res.rows[0] ?? {};
  return {
    email,
    /*
     * THE WALLET'S SNAPSHOT FIRST, THE LIVE ACCOUNT SECOND. The id on the
     * balance row is the one that was true when the points were earned; the join
     * answers "does this address have an account today", which is what the
     * "Guest — no account" chip is actually asking. A guest who earned points and
     * signed up later stops being a guest here, which is the truthful answer and
     * the one spec D10's later merge backfill wants.
     */
    customerId:
      row.wallet_customer_id != null
        ? String(row.wallet_customer_id)
        : row.account_id == null
          ? null
          : String(row.account_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    balance: row.balance == null ? 0 : Number(row.balance),
    lifetimeEarned: row.lifetime_earned == null ? 0 : Number(row.lifetime_earned),
    openReturn:
      row.return_id == null
        ? null
        : { id: String(row.return_id), status: row.return_status as ReturnStatus },
  };
}

export interface CustomerQuery {
  /** An email prefix OR a customer-id prefix. Empty means "recently active". */
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface CustomerPage {
  items: CustomerRow[];
  nextCursor: string | null;
}

const CUSTOMER_SORT = 'customers';

/**
 * When this address last moved — the ordering, written once and read three
 * times (the projection, the keyset and the ORDER BY).
 *
 * `coalesce` BECAUSE THE UNION HAS TWO GRAINS. A wallet's recency is its newest
 * ledger row; an account with no points has none, so it falls back to when the
 * account appeared. Both are true answers to "when did anything last happen at
 * this address", and a NULL here would need `NULLS LAST` in the ORDER BY and a
 * three-armed keyset predicate to page past it.
 *
 * A balance row with no ledger row is structurally impossible today — the
 * counter and the ledger insert are one statement — so the fallback is reached
 * only by the directory arm. It is written anyway, because "impossible" is a
 * claim about code that A8 and a future importer will also be writing.
 */
const RECENCY = sql.raw('coalesce(le.created_at, p.moved_at)');

/**
 * "Email prefix OR customer-id prefix", over whichever pair of columns.
 *
 * `starts_with` RATHER THAN `LIKE`, the `server/domain/slug.ts` rule: `_` and
 * `%` are pattern metacharacters, and a search box is the one input where an
 * address containing an underscore is ordinary.
 *
 * A PREFIX AND NOT A SUBSTRING, the `server/shop/admin/orders.ts` stance:
 * `LIKE '%bob%'` is a sequential scan for every keystroke of a debounced box AND
 * lets one customer's address be discovered by typing fragments. This box finds
 * the customer you were given.
 *
 * THE ADDRESS IS FOLDED AND THE ID IS NOT. Both stored columns are already
 * lower-case by CHECK, so only the term needs folding; a customer id is an
 * opaque handle that was minted with its own case, and lower-casing the term for
 * it would make a legitimate id unfindable.
 */
function matches(email: SQL, customerId: SQL, term: string): SQL {
  return sql`(starts_with(${email}, ${term.toLowerCase()})
              OR starts_with(${customerId}, ${term}))`;
}

/**
 * A WALLET IS ALSO FOUND BY THE ID OF THE ACCOUNT BEHIND ITS ADDRESS, not only
 * by the id it happened to snapshot.
 *
 * `marketing_balances.customer_id` is filled in only when a writer knew one, and
 * the writer that fills most wallets is an AWARD — contract #5/#6 accept no
 * `customerId` at all, so a customer who earned every point they have by sending
 * things back has a wallet whose id column is NULL. Matching that column alone
 * made `?query=cus_…` answer "no customers" for a person this same function
 * renders WITH that id the moment the address is typed instead: `accountLateral`
 * resolves the account on the way out, and nothing consulted it on the way in.
 * Spec D10 describes this arm as balances LEFT JOINed to the account for exactly
 * that reason.
 *
 * AN `EXISTS` RATHER THAN A SECOND JOIN. The account is wanted as a predicate
 * here — the projection already has one, through the lateral whose `LIMIT 1`
 * collapses the two-rows-differing-only-in-case pair — and joining again would
 * put that duplicate row back. The cost is a semi-join over `shop_customers`,
 * the same table the directory arm already scans, and only when something has
 * been typed.
 */
const walletMatches = (term: string): SQL => sql`(
    ${matches(sql`b.customer_email`, sql`b.customer_id`, term)}
    OR EXISTS (
      SELECT 1 FROM shop_customers c
       WHERE c.email IS NOT NULL AND lower(c.email) = b.customer_email
         AND starts_with(c.id, ${term})
    ))`;

function rowToCustomer(row: Record<string, unknown>): CustomerRow {
  const customerId = row.customer_id == null ? null : String(row.customer_id);
  return {
    email: String(row.email),
    customerId,
    displayName: row.display_name == null ? null : String(row.display_name),
    guest: customerId === null,
    balance: Number(row.balance),
    lifetimeEarned: Number(row.lifetime_earned),
    lastEntryAt: toEpochMsOrNull(row.last_entry_at),
    lastEntry:
      row.last_kind == null
        ? null
        : {
            kind: row.last_kind as LedgerKind,
            delta: Number(row.last_delta),
            /* VERBATIM, like every other history string in this subsystem: the
             * directory's summary line is the reason as it was written, not one
             * re-rendered from today's labels. */
            reason: String(row.last_reason),
          },
  };
}

/**
 * Contract #15 — the customer directory.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A UNION OF TWO POPULATIONS, AND THE SECOND ONE IS THE POINT.
 *
 * `marketing_balances` holds everyone who has ever earned a point. The brief
 * says an admin must be able to credit "any customer for whatever reason", and a
 * buyer who has never returned anything is not in that table — so the search
 * also runs a read-only prefix scan over `shop_customers` and shows the matches
 * with a zero balance. Without it the walk-in customer at the counter is
 * unfindable, and the only way to credit them is to type their address into a
 * URL.
 *
 * EMPTY QUERY IS THE WALLETS ALONE (contract #15: "the Recently active list").
 * The second arm is not built at all rather than filtered to nothing, because
 * "show me everyone who has ever had an account" is not a question this screen
 * asks and the answer would be a scan of the shop's customer table on every
 * idle page load.
 *
 * ONE ORDERING FOR BOTH MODES — recency, newest first. The spec calls the search
 * result "the same table, filtered", and an alphabetical search view would mean
 * a second sort key, a second cursor shape, and a cursor minted in one mode that
 * silently skips rows when spent in the other. The cost is recorded rather than
 * hidden: a search does not read alphabetically, so a hunt through many matches
 * is a hunt through recency. Prefix search over a small shop rarely returns
 * many.
 *
 * NULL-EMAIL ACCOUNTS ARE SKIPPED (spec D10). `shop_customers.email` is
 * nullable — a session that has not identified itself yet — and this subsystem
 * keys on the address, so a row with no address is a row with no wallet to show.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function listCustomers(db: Db, q: CustomerQuery = {}): Promise<CustomerPage> {
  const size = pageLimit(q.limit);
  const term = q.query?.trim() ?? '';
  if (term.length > MAX_QUERY_LENGTH) throw new BadRequestError('query');

  const arms: SQL[] = [
    sql`SELECT b.customer_email AS email, b.customer_id AS customer_id,
               b.balance AS balance, b.lifetime_earned AS lifetime_earned,
               b.updated_at AS moved_at
          FROM marketing_balances b
         WHERE ${term === '' ? sql`true` : walletMatches(term)}`,
  ];

  if (term !== '') {
    arms.push(sql`
      SELECT lower(c.email) AS email, NULL::text AS customer_id,
             0 AS balance, 0 AS lifetime_earned,
             min(c.created_at) AS moved_at
        FROM shop_customers c
       WHERE c.email IS NOT NULL
         AND ${matches(sql`lower(c.email)`, sql`c.id`, term)}
         /* Only the ones the first arm does not already have — a customer with a
          * wallet is a wallet row, with their real balance on it. */
         AND NOT EXISTS (
           SELECT 1 FROM marketing_balances b WHERE b.customer_email = lower(c.email)
         )
       /* Two shop_customers rows differing only in the case of the address are
        * legal (the UNIQUE is on the raw column), and they are ONE customer here.
        * Folded and grouped, they are one line. */
       GROUP BY lower(c.email)`);
  }

  const keyset: SQL[] = [sql`true`];
  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, CUSTOMER_SORT);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const at = Number(cursor.sortValues[0]);
    if (!Number.isFinite(at)) throw new BadRequestError('cursor');
    keyset.push(
      sql`(${RECENCY} < ${at} OR (${RECENCY} = ${at} AND p.email < ${cursor.id}))`,
    );
  }

  const res = await db.execute(sql`
    WITH people AS (
      ${sql.join(arms, sql` UNION ALL `)}
    )
    SELECT p.email,
           /* The wallet's snapshot id first, the live account second — see
            * getCustomerSummary for the argument. The directory arm carries no
            * id of its own, so its rows resolve entirely through the join. */
           coalesce(p.customer_id, acc.id) AS customer_id,
           acc.display_name,
           p.balance, p.lifetime_earned,
           le.kind AS last_kind, le.delta AS last_delta, le.reason AS last_reason,
           le.created_at AS last_entry_at,
           ${RECENCY} AS recency
      FROM people p
      ${accountLateral(sql`p.email`)}
      LEFT JOIN LATERAL (
        SELECT l.kind, l.delta, l.reason, l.created_at
          FROM marketing_ledger l
         WHERE l.customer_email = p.email
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 1
      ) le ON true
     WHERE ${sql.join(keyset, sql` AND `)}
     ORDER BY ${RECENCY} DESC, p.email DESC
     LIMIT ${size + 1}`);

  const rows = res.rows.slice(0, size);
  const items = rows.map(rowToCustomer);
  const last = rows[rows.length - 1];
  const more = res.rows.length > size;

  return {
    items,
    nextCursor:
      more && last
        ? encodeCursor(CUSTOMER_SORT, [toEpochMs(last.recency)], String(last.email))
        : null,
  };
}
