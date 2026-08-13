import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull, uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { DuplicateCodeError, StaleMarketingWriteError } from '../errors';
import { ID, newId } from '../ids';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Discount codes — the MODEL, ahead of the surface that will redeem them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS FILE EXISTS TO PROTECT: what a code is WORTH is decided
 * once, at creation, and can never be edited afterwards.
 *
 * A code is the only thing in this subsystem that leaves the building. It is
 * printed on a flyer, read out on a podcast, pasted into an email to nine
 * hundred people — and every one of those copies is a promise that was made in
 * the past tense. So `patchDiscount` has no way to write `code`, `kind`,
 * `percent_bps`, `amount_minor` or `currency`: not a guard that refuses one, but
 * a SET clause with no such column in it, behind a `.strict()` schema in
 * `routes.ts` with no such field. The same two structural walls the program
 * `key` stands behind, for the same reason and one column wider.
 *
 * What IS editable is everything that answers "does it still apply": the
 * status, the window, the redemption cap, the internal note. Turning SUMMER off
 * is honest — the customer is told the code has expired. Quietly turning it from
 * 20% into 5% is not, and there is no route that can.
 *
 * v1 SHIPS CRUD AND NOTHING ELSE. `computeTotals` never sees these rows yet and
 * `redeemed_count` is therefore always 0 — the Discounts screen is an honest
 * placeholder (spec D1). The table exists now because the shape is knowable now,
 * and because adding columns to a table with rows in it is a migration while an
 * unused table costs nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type DiscountKind = 'percent' | 'fixed_amount';
export type DiscountStatus = 'active' | 'disabled';

/** Contract §Types `Discount`, and the frozen wire shape of #24-26. */
export interface Discount {
  id: string;
  /** Uppercase at rest. The route normalises before it validates — see `routes.ts`. */
  code: string;
  kind: DiscountKind;
  /** Basis points off the total, 1..10000. Null on a `fixed_amount` code. */
  percentBps: number | null;
  /** Minor units off the total. Null on a `percent` code. */
  amountMinor: number | null;
  /** ISO 4217, and only meaningful beside `amountMinor`: "500 off" is not a
   *  price until it says 500 of what. */
  currency: string | null;
  status: DiscountStatus;
  /** Epoch ms. Null means "from the moment it is active". */
  startsAt: number | null;
  /** Epoch ms, EXCLUSIVE — the banner window's convention, so the two surfaces
   *  do not disagree about the last minute of a campaign. */
  endsAt: number | null;
  /** Null means unlimited. */
  maxRedemptions: number | null;
  /** Maintained by the surface that will redeem these, which does not exist
   *  yet: 0 on every row in v1, and no route here can write it. */
  redeemedCount: number;
  note: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Contract #25's body, after validation.
 *
 * A DISCRIMINATED UNION RATHER THAN FIVE OPTIONAL FIELDS, so the pairing that
 * `marketing_discount_codes_kind_fields_ck` enforces is unrepresentable here
 * rather than merely unvalidated. Written flat, `createDiscount` below would
 * read `draft.amountMinor ?? null` on a percent code and the mistake — a
 * fixed-amount price on a percentage discount, i.e. two answers to "how much
 * off" — would reach the database as SQLSTATE 23514: a 500 for a body that can
 * never be accepted. `routes.ts` mirrors this union in zod; this is the half
 * TypeScript checks.
 */
export type DiscountDraft = {
  code: string;
  startsAt?: number | null;
  endsAt?: number | null;
  maxRedemptions?: number | null;
  note?: string | null;
} & (
  | { kind: 'percent'; percentBps: number }
  | { kind: 'fixed_amount'; amountMinor: number; currency: string }
);

/**
 * Contract #26's body minus `expectedRevision`.
 *
 * NOTE WHAT IS ABSENT: `code`, `kind`, `percentBps`, `amountMinor`, `currency`.
 * See the header — those five are the promise, and the promise was made before
 * this request. Everything here answers "does it still apply", which is a
 * question about now.
 *
 * ALL FOUR ARE NULLABLE, which is not the same as optional said twice:
 * `undefined` means "leave it alone" and `null` means "clear it". Removing an
 * end date is how a campaign is extended indefinitely and removing a cap is how
 * it becomes unlimited; a patch that could only ever SET them would leave the
 * only way out of a schedule being a code nobody can extend.
 */
export interface DiscountPatch {
  status?: DiscountStatus;
  startsAt?: number | null;
  endsAt?: number | null;
  maxRedemptions?: number | null;
  note?: string | null;
}

export interface WriteOptions {
  /** The signed-in owner. Recorded as `created_by`. */
  actorId: string;
  /** ONE clock reading per write, passed in rather than taken here, so a row's
   *  `created_at` and `updated_at` cannot differ by a millisecond of scheduling. */
  now: number;
}

/** The index whose violation is somebody choosing a taken code rather than a bug. */
const CODE_UQ = 'marketing_discount_codes_code_uq';

/** Bare names, so one list serves a `SELECT` and a `RETURNING`. */
const DISCOUNT_COLUMNS = sql.raw(
  `id, code, kind, percent_bps, amount_minor, currency, status,
   starts_at, ends_at, max_redemptions, redeemed_count, note,
   revision, created_at, updated_at`,
);

function rowToDiscount(row: Record<string, unknown>): Discount {
  return {
    id: String(row.id),
    code: String(row.code),
    kind: row.kind as DiscountKind,
    percentBps: row.percent_bps == null ? null : Number(row.percent_bps),
    amountMinor: row.amount_minor == null ? null : Number(row.amount_minor),
    currency: row.currency == null ? null : String(row.currency),
    status: row.status as DiscountStatus,
    // `toEpochMsOrNull` and not `Number`: these are `bigint` columns, which the
    // Neon driver hands back as STRINGS and PGlite is configured to imitate. A
    // `"1786600001000" > now` comparison in the client is a string comparison.
    startsAt: toEpochMsOrNull(row.starts_at),
    endsAt: toEpochMsOrNull(row.ends_at),
    // `integer`, which both drivers agree about.
    maxRedemptions: row.max_redemptions == null ? null : Number(row.max_redemptions),
    redeemedCount: Number(row.redeemed_count),
    note: row.note == null ? null : String(row.note),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

// ---------------------------------------------------------------- the window

/** The two fields the window rule is about, on a MERGED row. Named `Schedule`
 *  and not `Window`, which is a DOM global this file would be shadowing. */
interface Schedule {
  startsAt: number | null;
  endsAt: number | null;
}

/**
 * The window rule, judged on the row as it WILL BE.
 *
 * NOT IN THE ZOD SCHEMA, AND THAT IS THE WHOLE REASON THIS FUNCTION EXISTS —
 * the argument `banners/repo.ts#assertCoherent` sets out at length, reached
 * again here because the column carries the same CHECK. The rule is about two
 * fields and a PATCH usually carries one of them: setting `endsAt` on a code
 * whose `startsAt` has been stored since last week is the ordinary edit, and a
 * schema can only ever see half of it. Left to the database it is
 * `marketing_discount_codes_window_ck` — SQLSTATE 23514, which has no row in
 * the error table and answers 500 for a date that can never be accepted.
 *
 * `endsAt === startsAt` IS REFUSED TOO. A window of zero length is a campaign
 * that cannot run for an instant, and it looks exactly like one that has not
 * started yet — the same half-open convention the banner predicate uses, so the
 * two schedules in this subsystem mean the same thing by "until".
 *
 * THE DETAIL NAMES THE END, because that is the field the editor renders the
 * error under and the one a human almost always mistyped: the start is usually
 * "today" and the end is the date being chosen.
 */
function assertWindow(merged: Schedule): void {
  if (merged.startsAt !== null && merged.endsAt !== null && merged.endsAt <= merged.startsAt) {
    throw new BadRequestError('endsAt');
  }
}

/** `undefined` leaves the stored value alone; `null` clears it. A local copy of
 *  the sibling in `banners/repo.ts` — one line, and importing it would couple
 *  two subsystems through a helper neither owns. */
function merge<T>(patched: T | undefined, current: T): T {
  return patched === undefined ? current : patched;
}

// -------------------------------------------------------------------- reads

/**
 * Contract #24 — every code, whatever its status, newest first.
 *
 * BOTH STATUSES IN ONE ANSWER, and the screen groups them. There is no delete
 * here either: `redeemed_count` is a record of what a code was worth to the
 * people who used it, so a spent campaign is disabled rather than removed, and
 * a status filter on this route would be a second request for the same page.
 *
 * NEWEST FIRST, the `listBanners` choice rather than `listPrograms`'. Programs
 * are a handful of configuration rows a reader edits in place, so they are
 * ordered oldest-first and never move. Codes accumulate one campaign at a time
 * and the one being worked on is the one just created, so the useful end of the
 * list is the new end.
 *
 * NOT PAGINATED, matching contract #24's `{ discounts }`. A shop runs campaigns
 * in single figures per season; a cursor over a list that short is a control
 * that never appears.
 */
export async function listDiscounts(db: Db): Promise<Discount[]> {
  const res = await db.execute(sql`
    SELECT ${DISCOUNT_COLUMNS} FROM marketing_discount_codes
     ORDER BY created_at DESC, id DESC`);
  return res.rows.map(rowToDiscount);
}

export async function getDiscount(db: Db, id: string): Promise<Discount | null> {
  const res = await db.execute(sql`
    SELECT ${DISCOUNT_COLUMNS} FROM marketing_discount_codes WHERE id = ${id}`);
  return res.rows[0] ? rowToDiscount(res.rows[0]) : null;
}

// ------------------------------------------------------------------- writes

/**
 * Contract #25.
 *
 * `status`, `redeemed_count` AND `revision` ARE ABSENT FROM THE COLUMN LIST ON
 * PURPOSE — each takes its column default. `redeemed_count` is the sharp one: it
 * is the count of promises already kept, so a route that could set it would let
 * a create invent a history.
 *
 * THE DEFAULT STATUS IS `active`, unlike a banner's `draft`, and the difference
 * is deliberate rather than an oversight of the DDL. A banner is words shown to
 * every visitor whether they asked or not, so it is written, previewed and only
 * then switched on. A code does nothing until somebody types it — and in v1
 * nothing redeems one at all — so a create that landed disabled would be a
 * two-step for a row that cannot spend money either way.
 */
export async function createDiscount(
  db: Db,
  draft: DiscountDraft,
  opts: WriteOptions,
): Promise<Discount> {
  const startsAt = draft.startsAt ?? null;
  const endsAt = draft.endsAt ?? null;
  assertWindow({ startsAt, endsAt });

  /*
   * The three value columns, read through the discriminant. This is where the
   * union pays for itself: there is no expression here that could put an amount
   * on a percentage code, so `marketing_discount_codes_kind_fields_ck` is a
   * backstop rather than a thing this function has to remember.
   */
  const percentBps = draft.kind === 'percent' ? draft.percentBps : null;
  const amountMinor = draft.kind === 'fixed_amount' ? draft.amountMinor : null;
  const currency = draft.kind === 'fixed_amount' ? draft.currency : null;

  const id = newId(ID.discount);
  try {
    const res = await db.execute(sql`
      INSERT INTO marketing_discount_codes
        (id, code, kind, percent_bps, amount_minor, currency,
         starts_at, ends_at, max_redemptions, note,
         created_at, updated_at, created_by)
      VALUES (${id}, ${draft.code}, ${draft.kind}, ${percentBps}, ${amountMinor},
              ${currency}, ${startsAt}, ${endsAt}, ${draft.maxRedemptions ?? null},
              ${draft.note ?? null}, ${opts.now}, ${opts.now}, ${opts.actorId}::uuid)
      RETURNING ${DISCOUNT_COLUMNS}`);
    return rowToDiscount(res.rows[0]);
  } catch (err) {
    /*
     * Translated rather than left to become a 500. Choosing a code somebody
     * already used is an ordinary thing to do and a PERMANENT condition, so it
     * has to be a refusal the form can act on — and it has to be told apart from
     * "that code has a space in it", which is a different sentence in a
     * different place (`DuplicateProgramKeyError` records the same measurement).
     *
     * IT CATCHES THE CASE-FOLDED COLLISION FOR FREE, which is the whole point of
     * uppercasing before validating: `save10` and `SAVE10` are one row, so the
     * second one is this error rather than a second code that a customer typing
     * either would be told does not exist.
     *
     * Anything else is a real fault and re-thrown.
     */
    if (uniqueViolation(err) === CODE_UQ) throw new DuplicateCodeError(draft.code);
    throw err;
  }
}

/**
 * The patchable columns, as a map from wire field to column name.
 *
 * THE COLUMN NAMES COME FROM HERE AND NEVER FROM THE REQUEST. The SET clause is
 * built by walking this table and asking whether the patch carries the key, so
 * the identifier that reaches SQL is a literal written in this file — the rule
 * `emitEvent` states for the one thing that cannot be a bound parameter. Every
 * VALUE still is one.
 *
 * AND NOTE WHAT IS NOT IN IT: `code`, `kind`, `percent_bps`, `amount_minor`,
 * `currency`, `redeemed_count`, `revision`, `created_at`, `created_by`. The zod
 * schema in `routes.ts` refuses the first five by name with a 400; this map is
 * the second wall, so a widened schema still could not change what a code
 * already promised.
 */
const PATCHABLE = {
  status: 'status',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  maxRedemptions: 'max_redemptions',
  note: 'note',
} as const satisfies Record<keyof DiscountPatch, string>;

/**
 * Contract #26 — CAS, and only the fields that answer "does it still apply".
 *
 * THE `WHERE revision = $expected` IS THE ONLY AUTHORITY ON WHO WON. The read
 * above it exists to answer 404 and to know the stored half of the window rule;
 * it never decides whether the write may proceed, because a precondition judged
 * in TypeScript is judged against a row that has already been read — exactly the
 * stale value a CAS exists to distrust (`programs/repo.ts` and
 * `server/shop/catalog/products.ts` both measured what that costs).
 *
 * THERE IS NO GUARD AGAINST LOWERING `max_redemptions` BELOW `redeemed_count`,
 * and that is a decision rather than an omission. Nothing increments the count
 * in v1, so the state cannot arise yet; when the redeeming surface lands it will
 * have to choose between refusing the edit and letting a cap mean "no more from
 * now on", and that choice belongs to the code that knows what a redemption is.
 * Inventing the rule here would freeze the wrong answer into a contract.
 */
export async function patchDiscount(
  db: Db,
  id: string,
  patch: DiscountPatch,
  opts: WriteOptions & { expectedRevision: number },
): Promise<Discount> {
  const current = await getDiscount(db, id);
  if (!current) throw new NotFoundError(id);

  assertWindow({
    startsAt: merge(patch.startsAt, current.startsAt),
    endsAt: merge(patch.endsAt, current.endsAt),
  });

  /*
   * `!== undefined`, NEVER a truthiness test: `null` clears a field and `''`
   * would be a legal note if the route did not normalise it. A filter written as
   * `patch[field] ? …` would silently drop the clear — the end date an admin had
   * just emptied on purpose to extend a campaign.
   *
   * The revision and the clock are appended rather than conditional, so a PATCH
   * carrying only `expectedRevision` still bumps both. It is a touch rather than
   * a no-op, and treating it as one would hand the caller a 200 that did not
   * invalidate the token it just spent.
   */
  const assignments: SQL[] = (Object.keys(PATCHABLE) as (keyof DiscountPatch)[])
    .filter((field) => patch[field] !== undefined)
    .map((field) => sql`${sql.raw(PATCHABLE[field])} = ${patch[field]}`);
  assignments.push(sql`revision = revision + 1`, sql`updated_at = ${opts.now}`);

  const res = await db.execute(sql`
    UPDATE marketing_discount_codes
       SET ${sql.join(assignments, sql`, `)}
     WHERE id = ${id} AND revision = ${opts.expectedRevision}
    RETURNING ${DISCOUNT_COLUMNS}`);

  /*
   * `rows.length`, never `affectedRows` — measured to be 0 even on a winning
   * CAS (`server/repo/posts.ts`). The row is re-read rather than reported from
   * the copy above, because the whole value of this 409 to the client is that it
   * carries the row that WON: spec D7's conflict notice renders "Load theirs"
   * straight out of the payload instead of spending a second round trip to
   * discover a third state.
   */
  if (res.rows.length === 0) {
    const actual = await getDiscount(db, id);
    if (!actual) throw new NotFoundError(id);
    throw new StaleMarketingWriteError(
      opts.expectedRevision,
      actual.revision,
      'discount',
      actual,
    );
  }

  return rowToDiscount(res.rows[0]);
}
