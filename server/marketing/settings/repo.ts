import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { StaleMarketingWriteError } from '../errors';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * The cross-program configuration layer — one row, `id = 'main'` (spec D2).
 *
 * TWO LAYERS RATHER THAN ONE, and the split is not tidiness. A program row
 * carries the words for ITS OWN surfaces. This row carries the words for the
 * surfaces that span every program — a customer's balance tile sums points earned
 * under all of them, a manual adjustment belongs to none — plus the economics of
 * spending those points, which are a property of the shop rather than of any one
 * programme.
 *
 * THE ECONOMICS ARE AN INTEGER RATIONAL, NEVER A FLOAT: `ratePoints` points are
 * worth `rateMinor` minor units, and `redemption/port.ts` converts through
 * `shared/commerce/money.ts` `scale()`. A rate stored as 0.05 is a rounding rule
 * nobody wrote down.
 *
 * AND REDEMPTION CANNOT BE ENABLED AT A ZERO RATE. The seed ships disabled with a
 * placeholder rate, so a deployment that never reviews these numbers costs the
 * shop copy rather than discounting every cart to nothing.
 * `marketing_settings_enabled_rate_ck` says it in the database; `patchSettings`
 * says it first, so the answer is a field error rather than a 500.
 */

/** Contract §Types `MarketingSettings`. The `id` is not on the wire: there is
 *  exactly one row and a client that could name it could ask for another. */
export interface MarketingSettings {
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  redemptionEnabled: boolean;
  redemptionRatePoints: number;
  redemptionRateMinor: number;
  redemptionCurrency: string;
  minRedeemPoints: number;
  /** Basis points of an order that points may pay for. 10000 = all of it. */
  maxRedeemBps: number;
  defaultReturnProgramId: string | null;
  revision: number;
  updatedAt: number;
}

/** Contract #20's body minus `expectedRevision`. */
export interface SettingsPatch {
  pointsLabelSingular?: string;
  pointsLabelPlural?: string;
  redemptionEnabled?: boolean;
  redemptionRatePoints?: number;
  redemptionRateMinor?: number;
  redemptionCurrency?: string;
  minRedeemPoints?: number;
  maxRedeemBps?: number;
  /** `null` clears it, which is a legal state: the intake route answers
   *  `409 program_paused` when there is nothing to default to. */
  defaultReturnProgramId?: string | null;
}

export interface SettingsWriteOptions {
  expectedRevision: number;
  actorId: string;
  now: number;
}

/**
 * The singleton's primary key, pinned by `marketing_settings_id_ck`.
 *
 * A CHECK-CONSTRAINED CONSTANT RATHER THAN A TABLE WITH ONE ROW BY CONVENTION:
 * "there is exactly one configuration" is then something the database enforces,
 * so a second row cannot appear and leave two answers to "what is this shop's
 * points word" for whichever query happened to sort first.
 */
const SETTINGS_ID = 'main';

const SETTINGS_COLUMNS = sql.raw(
  `points_label_singular, points_label_plural, redemption_enabled,
   redemption_rate_points, redemption_rate_minor, redemption_currency,
   min_redeem_points, max_redeem_bps, default_return_program_id, revision, updated_at`,
);

function rowToSettings(row: Record<string, unknown>): MarketingSettings {
  return {
    pointsLabelSingular: String(row.points_label_singular),
    pointsLabelPlural: String(row.points_label_plural),
    redemptionEnabled: row.redemption_enabled === true,
    // `Number` and not `toEpochMs`: `integer` columns, which PGlite and Neon
    // agree about. The divergence those helpers exist for is int8 only.
    redemptionRatePoints: Number(row.redemption_rate_points),
    redemptionRateMinor: Number(row.redemption_rate_minor),
    redemptionCurrency: String(row.redemption_currency),
    minRedeemPoints: Number(row.min_redeem_points),
    maxRedeemBps: Number(row.max_redeem_bps),
    defaultReturnProgramId:
      row.default_return_program_id == null ? null : String(row.default_return_program_id),
    revision: Number(row.revision),
    updatedAt: toEpochMs(row.updated_at),
  };
}

/** Contract #19. */
export async function getSettings(db: Db): Promise<MarketingSettings | null> {
  const res = await db.execute(sql`
    SELECT ${SETTINGS_COLUMNS} FROM marketing_settings WHERE id = ${SETTINGS_ID}`);
  return res.rows[0] ? rowToSettings(res.rows[0]) : null;
}

const PATCHABLE = {
  pointsLabelSingular: 'points_label_singular',
  pointsLabelPlural: 'points_label_plural',
  redemptionEnabled: 'redemption_enabled',
  redemptionRatePoints: 'redemption_rate_points',
  redemptionRateMinor: 'redemption_rate_minor',
  redemptionCurrency: 'redemption_currency',
  minRedeemPoints: 'min_redeem_points',
  maxRedeemBps: 'max_redeem_bps',
  defaultReturnProgramId: 'default_return_program_id',
} as const satisfies Record<keyof SettingsPatch, string>;

/**
 * Does the merged row satisfy `marketing_settings_enabled_rate_ck`?
 *
 * MERGED, AND THAT IS THE WHOLE SUBTLETY. The rule is a property of the STORED
 * SETTINGS — "never enabled while a point is worth nothing" — not of the request,
 * so switching redemption on and pricing it in one save is legal (and is what the
 * editor actually sends), while zeroing the rate on a row that is already switched
 * on is the same forbidden state reached backwards. Testing the body alone would
 * accept the second and refuse the first.
 */
function refusesZeroRate(current: MarketingSettings, patch: SettingsPatch): boolean {
  const enabled = patch.redemptionEnabled ?? current.redemptionEnabled;
  const rateMinor = patch.redemptionRateMinor ?? current.redemptionRateMinor;
  return enabled && rateMinor <= 0;
}

/**
 * Contract #20 — CAS over the singleton.
 *
 * THE `WHERE revision = $expected` IS THE ONLY AUTHORITY ON WHO WON, as in
 * `programs/repo.ts`; the read above it exists to answer the two questions a
 * predicate cannot (is this row here, and would the merged row be legal) and
 * never to decide the race.
 */
export async function patchSettings(
  db: Db,
  patch: SettingsPatch,
  opts: SettingsWriteOptions,
): Promise<MarketingSettings> {
  const current = await getSettings(db);
  if (current === null) throw new NotFoundError(SETTINGS_ID);

  /*
   * A 400 NAMING THE RATE, not the switch. `redemptionRateMinor` is what has to
   * change for the request to succeed — the switch is already where the caller
   * wants it — and the editor gates its enable control on the same field, so the
   * inline error lands under the input the admin has to fill in. Unrendered this
   * is SQLSTATE 23514, which has no row in the error table and answers 500: five
   * retries for a switch that can never be flipped on its own.
   */
  if (refusesZeroRate(current, patch)) throw new BadRequestError('redemptionRateMinor');

  /*
   * An unknown default program is a FIELD error (contract #20 is explicit that it
   * is 400 and NOT `gone`): the shape this arrives in is a Select whose options
   * were fetched a moment ago and whose value raced, so the treatment is an inline
   * error beside the control — `gone` would render a whole-screen "no longer
   * exists" with a back link, which is the wrong page for one input.
   *
   * A READ FOLLOWED BY A WRITE, and it is advisory in the same way
   * `checkImageRefs` is: strictly, a program could vanish between the two. In
   * practice it cannot — there is no DELETE route for a program anywhere in this
   * subsystem (spec §UI Rewards: "NO delete — programs pause forever", because
   * ledger rows reference them), and the column's own FK is `ON DELETE SET NULL`,
   * so even a hand-run delete degrades this pointer to NULL rather than leaving a
   * dangling one. It is not written as a SQL predicate because a zero-row result
   * from the statement below already means "the CAS lost", and adding a second
   * reason for zero rows would make a mistyped id look like a lost race.
   */
  if (patch.defaultReturnProgramId != null) {
    const found = await db.execute(sql`
      SELECT 1 FROM marketing_programs WHERE id = ${patch.defaultReturnProgramId}`);
    if (found.rows.length === 0) throw new BadRequestError('defaultReturnProgramId');
  }

  const assignments: SQL[] = (Object.keys(PATCHABLE) as (keyof SettingsPatch)[])
    .filter((field) => patch[field] !== undefined)
    .map((field) => sql`${sql.raw(PATCHABLE[field])} = ${patch[field]}`);
  assignments.push(
    sql`revision = revision + 1`,
    sql`updated_at = ${opts.now}`,
    /* WHO changed the shop's economics. `ON DELETE SET NULL` in the migration:
     * removing an account must not remove the record that it was configured. */
    sql`updated_by = ${opts.actorId}::uuid`,
  );

  const res = await db.execute(sql`
    UPDATE marketing_settings
       SET ${sql.join(assignments, sql`, `)}
     WHERE id = ${SETTINGS_ID} AND revision = ${opts.expectedRevision}
    RETURNING ${SETTINGS_COLUMNS}`);

  if (res.rows.length === 0) {
    const actual = await getSettings(db);
    if (actual === null) throw new NotFoundError(SETTINGS_ID);
    /*
     * Under `settings` — the entity name is part of the payload contract, because
     * marketing has five revisioned entities and the conflict notice renders
     * "Load theirs" out of whichever one it asked about. Carrying the row is what
     * saves the client a second fetch that would show a THIRD state as though it
     * were what the write lost to (spec D7).
     */
    throw new StaleMarketingWriteError(
      opts.expectedRevision,
      actual.revision,
      'settings',
      actual,
    );
  }

  return rowToSettings(res.rows[0]);
}
