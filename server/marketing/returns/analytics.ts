import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * WHAT A RETURNED UNIT ACTUALLY COSTS US — the one question this screen exists
 * to answer (owner's instruction, 2026-09-04, migration 0920).
 *
 * In the owner's own arithmetic: fifty units back at a hundred naira each is
 * five thousand, so we bought them at a hundred — but then a van had to fetch
 * them, and once the long leg in, the local run, the driver and the loading
 * are counted, the real figure is "three hundred and something". That gap is
 * the whole point. The headline is
 *
 *     (reward money + collection money) / units KEPT
 *
 * and every other figure below is that same fraction sliced a different way.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE DECISIONS THAT ARE NOT OBVIOUS FROM THE SQL, ALL OF THEM THE OWNER'S.
 *
 * 1. THE DIVISOR IS UNITS WE KEPT, NEVER UNITS THAT ARRIVED. A van hauls
 *    forty-eight and three are unusable: the whole cost lands on the
 *    forty-five good ones. That is what makes the number mean "what a USABLE
 *    unit costs us", and it is why a bad batch correctly pushes the average up
 *    instead of hiding in a bigger denominator.
 *
 * 2. A PICKUP THAT CAME BACK WITH NOTHING USABLE STILL COST MONEY, so its
 *    costs are in the NUMERATOR while it contributes nothing to the divisor.
 *    Every return CLOSED in the window counts — awarded and rejected alike —
 *    because the van went either way. Excluding failed pickups would quietly
 *    understate the programme by exactly the amount it wastes.
 *
 * 3. THE CLOCK IS `closed_at`, THE DAY THE RETURN WAS SETTLED. The owner chose
 *    to count the reward as spent when the points are awarded rather than when
 *    the customer eventually spends them: it is conservative, and it lines the
 *    cost up with the day the units actually reached the workshop. Spending
 *    points is not even switched on, so the alternative would read ₦0 today
 *    and then re-date years of history the moment it was.
 *
 * 4. A COST NOBODY TYPED FALLS BACK TO THE DISTRICT'S STANDARD, per line, at
 *    READ TIME — never copied onto the row (0920 argues why at length). So
 *    correcting an area's standard improves every estimate leaning on it. The
 *    price of that is that some of the headline is estimated, which is why
 *    `coverage` exists and why the screen prints it: a number nobody can tell
 *    apart from a receipt is a number nobody should trust.
 *
 * 5. THE REWARD RATE IS MONEY AND NOT POINTS. `unit_cost_minor_snapshot` is
 *    the rate frozen onto the return; when it is NULL — every row older than
 *    0920 — it falls back to the programme's CURRENT rate, which is what let
 *    that migration ship without inventing history.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE INSTANT, FOUR STATEMENTS, like `server/shop/admin/analytics.ts`. `now`
 * is read by the route and every window measured from it; `generatedAt` echoes
 * it so a reader can reconstruct each boundary from the body alone. Nothing
 * here is subtracted from anything else across statements, so a few
 * milliseconds of skew between them cannot make two figures contradict.
 *
 * DAYS ARE WAT BY FIXED OFFSET, the same constant and the same argument as the
 * shop's: West Africa Time has been UTC+1 with no daylight saving since 1919,
 * and a named-zone conversion would bet every test run on the WASM build
 * shipping a full tz database for an answer that cannot differ.
 */

export const WAT_OFFSET_MS = 60 * 60 * 1000;

/**
 * The ranges the picker offers — plus `all`, which the shop's analytics has no
 * use for and this screen genuinely does. The owner's question is "across all
 * the hundreds of returns, what are we really paying", and a programme this
 * young has most of its history inside one window anyway.
 *
 * A SET AND NOT A FREE INTEGER: every value is a scan bound, and `3650` typed
 * for `365` would be a full-table scan served with a straight face.
 */
export const RETURN_ANALYTICS_RANGES = ['30', '90', '365', 'all'] as const;
export type ReturnAnalyticsRange = (typeof RETURN_ANALYTICS_RANGES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Districts on the by-area table, best-first and capped far above any real
 *  served set — the subpage wants the whole list, not a top ten. */
export const AREA_ROWS_CAP = 500;

/** The dearest individual pickups, for the "why is the average like that"
 *  list. Short on purpose: it is a lead to click, not a report. */
export const COSTLIEST_CAP = 10;

export interface ReturnCostTotals {
  /** Returns closed in the window — awarded and rejected together. */
  returns: number;
  /** Units KEPT. The divisor of every per-unit figure on the screen. */
  unitsKept: number;
  /** Units that arrived and were refused. Not a divisor; shown so a reader can
   *  see why a period's cost per unit moved. */
  unitsRejected: number;
  /** Minor units, all of them. */
  rewardMinor: number;
  transportMinor: number;
  localMinor: number;
  driverMinor: number;
  feesMinor: number;
  /** Collection only — the four lines above, without the reward. */
  collectionMinor: number;
  /** Reward + collection. The numerator. */
  allInMinor: number;
}

export interface ReturnCostPerUnit {
  allIn: number;
  reward: number;
  transport: number;
  local: number;
  driver: number;
  fees: number;
}

export interface ReturnCostDay {
  /** YYYY-MM in WAT. MONTHS, not days: a district's van runs weekly at best,
   *  so a daily axis over a return programme is mostly gaps, and the owner's
   *  question ("in the long run") is a monthly one. */
  month: string;
  unitsKept: number;
  rewardMinor: number;
  transportMinor: number;
  localMinor: number;
  driverMinor: number;
  feesMinor: number;
  allInMinor: number;
  /** All-in over units kept, minor units, 0 when a month kept none. */
  perUnitMinor: number;
}

export interface ReturnCostArea {
  /** NULL for the out-of-area group — returns that belong to no district. It
   *  is the ABSENCE of a place, so it is not given a fabricated id. */
  areaId: string | null;
  region: string | null;
  name: string | null;
  returns: number;
  unitsKept: number;
  rewardMinor: number;
  collectionMinor: number;
  allInMinor: number;
  perUnitMinor: number;
  /** How many of this district's pickups had no typed figure at all. */
  estimated: number;
}

export interface ReturnCostRow {
  id: string;
  customerEmail: string;
  customerName: string | null;
  areaName: string | null;
  closedAt: number | null;
  unitsKept: number;
  allInMinor: number;
  perUnitMinor: number;
  /** True when NOT ONE of the four lines was typed — the whole collection cost
   *  is the district's standard. */
  estimated: boolean;
}

export interface ReturnCostCoverage {
  /** Closed returns with at least one typed cost line. */
  recorded: number;
  /** No typed line, but the district has a standard to stand in for it. */
  estimated: number;
  /** No typed line AND no standard: counted as zero, which understates the
   *  headline. The screen says so out loud rather than quietly averaging. */
  uncosted: number;
}

export interface ReturnCostAnalytics {
  generatedAt: number;
  range: ReturnAnalyticsRange;
  /** The programme's own money rates, echoed so the screen can explain the
   *  headline without a second request — and can say "nobody has set a rate"
   *  instead of printing a confident ₦0. */
  rates: {
    unitCostMinor: number | null;
    unitMarketCostMinor: number | null;
    currency: string;
  };
  totals: ReturnCostTotals;
  perUnit: ReturnCostPerUnit;
  byMonth: ReturnCostDay[];
  byArea: ReturnCostArea[];
  costliest: ReturnCostRow[];
  coverage: ReturnCostCoverage;
}

/**
 * The statuses a return can be in once the van has been and gone.
 *
 * `cancelled` IS NOT HERE and that is deliberate. A cancellation is normally a
 * customer changing their mind before anything moved, and counting a wall of
 * those as pickups that cost nothing would drag the average DOWN with events
 * that never happened. The one real case — cancelled after collection, lost in
 * transit — is rare enough that quietly diluting every figure to catch it is
 * the worse trade. `rejected` IS here, because a van did go.
 */
const CLOSED = sql`r.status IN ('awarded','rejected')`;

/**
 * The four collection lines, each resolved against its district's standard.
 *
 * COALESCE PER LINE, NOT PER ROW. A pickup with a transport figure typed and
 * nothing else still earns the district's standard for the driver and the
 * loading — the lines are independent because that is how they are recorded,
 * and an all-or-nothing fallback would throw away the one real number on the
 * row the moment somebody filled in a second box.
 *
 * The final `0` is for the out-of-area group and for districts with no
 * standard: there is nothing to estimate with, so the figure is zero and
 * `coverage.uncosted` counts the row so the screen can disclose it.
 */
const line = (column: string, std: string): SQL =>
  sql.raw(`COALESCE(r.${column}, a.${std}, 0)`);

const TRANSPORT = line('cost_transport_minor', 'std_transport_minor');
const LOCAL = line('cost_local_minor', 'std_local_minor');
const DRIVER = line('cost_driver_minor', 'std_driver_minor');
const FEES = line('cost_fees_minor', 'std_fees_minor');

const COLLECTION = sql`(${TRANSPORT} + ${LOCAL} + ${DRIVER} + ${FEES})`;

/**
 * The reward, in money: units kept × the rate this return was frozen at,
 * falling back to the programme's current rate for rows older than 0920.
 *
 * `qty_accepted` IS COALESCED TO ZERO because a rejected return has none —
 * `NULL * rate` would be NULL, and one such row would turn a whole period's
 * `sum()` into a number that silently skipped it.
 */
const REWARD = sql`(COALESCE(r.qty_accepted, 0)
                    * COALESCE(r.unit_cost_minor_snapshot, p.unit_cost_minor, 0))`;

const ALL_IN = sql`(${REWARD} + ${COLLECTION})`;

const KEPT = sql`COALESCE(r.qty_accepted, 0)`;

/** True when NOT ONE line was typed on the row — the whole collection figure
 *  is standing in for something nobody recorded. */
const NOTHING_TYPED = sql`(r.cost_transport_minor IS NULL AND r.cost_local_minor IS NULL
                           AND r.cost_driver_minor IS NULL AND r.cost_fees_minor IS NULL)`;

/** …and the district has nothing to stand in with either. */
const NO_STANDARD = sql`(a.id IS NULL OR (a.std_transport_minor IS NULL
                          AND a.std_local_minor IS NULL AND a.std_driver_minor IS NULL
                          AND a.std_fees_minor IS NULL))`;

/** `closed_at`, shifted to WAT and named as a calendar month. */
const WAT_MONTH = sql.raw(
  `to_char(to_timestamp((r.closed_at + 3600000) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM')`,
);

/**
 * `FROM` and `WHERE`, written once.
 *
 * BOTH JOINS ARE LEFT JOINS AND BOTH MATTER. The district is genuinely
 * optional — an out-of-area return is a legal row — and dropping those would
 * silently exclude money actually spent. The programme join is LEFT for the
 * defensive reason rather than a real one: `program_id` is NOT NULL with an
 * FK, but an INNER JOIN that ever failed would remove a return from the
 * numerator without removing it from any count a reader compares it against.
 */
const scan = (since: number | null): SQL => sql`
    FROM marketing_return_requests r
    LEFT JOIN marketing_service_areas a ON a.id = r.service_area_id
    LEFT JOIN marketing_programs p ON p.id = r.program_id
   WHERE ${CLOSED} AND r.closed_at IS NOT NULL
     ${since === null ? sql`` : sql`AND r.closed_at >= ${since}`}`;

export async function returnCostAnalytics(
  db: Db,
  q: { now: number; range: ReturnAnalyticsRange },
): Promise<ReturnCostAnalytics> {
  const since = q.range === 'all' ? null : q.now - Number(q.range) * DAY_MS;

  const [totals, months, areas, costliest, rates] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS returns,
             COALESCE(sum(${KEPT}), 0)::int AS units_kept,
             COALESCE(sum(COALESCE(r.qty_rejected, 0)), 0)::int AS units_rejected,
             COALESCE(sum(${REWARD}), 0)::bigint AS reward,
             COALESCE(sum(${TRANSPORT}), 0)::bigint AS transport,
             COALESCE(sum(${LOCAL}), 0)::bigint AS local_run,
             COALESCE(sum(${DRIVER}), 0)::bigint AS driver,
             COALESCE(sum(${FEES}), 0)::bigint AS fees,
             count(*) FILTER (WHERE NOT ${NOTHING_TYPED})::int AS recorded,
             count(*) FILTER (WHERE ${NOTHING_TYPED} AND NOT ${NO_STANDARD})::int AS estimated,
             count(*) FILTER (WHERE ${NOTHING_TYPED} AND ${NO_STANDARD})::int AS uncosted
        ${scan(since)}`),

    db.execute(sql`
      SELECT ${WAT_MONTH} AS month,
             COALESCE(sum(${KEPT}), 0)::int AS units_kept,
             COALESCE(sum(${REWARD}), 0)::bigint AS reward,
             COALESCE(sum(${TRANSPORT}), 0)::bigint AS transport,
             COALESCE(sum(${LOCAL}), 0)::bigint AS local_run,
             COALESCE(sum(${DRIVER}), 0)::bigint AS driver,
             COALESCE(sum(${FEES}), 0)::bigint AS fees
        ${scan(since)}
       GROUP BY 1 ORDER BY 1 ASC`),

    /* GROUPED BY THE AREA ROW, so the out-of-area group arrives as one row
     * with a NULL id rather than being dropped by the grouping key. Ordered by
     * cost per unit DESCENDING — the dearest district first is the whole point
     * of the table, and a district that kept nothing sorts last on the tie
     * rather than to the top on a division nobody performed. */
    db.execute(sql`
      SELECT a.id AS area_id, a.region, a.name,
             count(*)::int AS returns,
             COALESCE(sum(${KEPT}), 0)::int AS units_kept,
             COALESCE(sum(${REWARD}), 0)::bigint AS reward,
             COALESCE(sum(${COLLECTION}), 0)::bigint AS collection,
             count(*) FILTER (WHERE ${NOTHING_TYPED})::int AS estimated
        ${scan(since)}
       GROUP BY a.id, a.region, a.name
       ORDER BY CASE WHEN sum(${KEPT}) > 0
                     THEN sum(${ALL_IN})::numeric / sum(${KEPT}) END DESC NULLS LAST,
                a.region ASC NULLS LAST, a.name ASC NULLS LAST
       LIMIT ${AREA_ROWS_CAP}`),

    /* THE DEAREST INDIVIDUAL PICKUPS, and only ones that kept something: a
     * return with nothing accepted has no cost PER UNIT to rank by, and
     * dividing by its zero is the one arithmetic error this file can make. */
    db.execute(sql`
      SELECT r.id, r.customer_email, r.customer_name, a.name AS area_name, r.closed_at,
             ${KEPT}::int AS units_kept,
             ${ALL_IN}::bigint AS all_in,
             (${ALL_IN})::numeric / ${KEPT} AS per_unit,
             ${NOTHING_TYPED} AS estimated
        ${scan(since)}
         AND COALESCE(r.qty_accepted, 0) > 0
       ORDER BY per_unit DESC, r.closed_at DESC
       LIMIT ${COSTLIEST_CAP}`),

    /* The rates the screen explains itself with, off the DEFAULT programme —
     * the same one every intake without a named programme lands on. Read
     * through the settings singleton rather than by key, for the reason
     * `createRequest` gives: the key is the one thing nothing may match on. */
    db.execute(sql`
      SELECT p.unit_cost_minor, p.unit_market_cost_minor, s.redemption_currency
        FROM marketing_settings s
        LEFT JOIN marketing_programs p ON p.id = s.default_return_program_id
       WHERE s.id = 'main'`),
  ]);

  const t = totals.rows[0] ?? {};
  const unitsKept = Number(t.units_kept ?? 0);
  const reward = Number(t.reward ?? 0);
  const transport = Number(t.transport ?? 0);
  const local = Number(t.local_run ?? 0);
  const driver = Number(t.driver ?? 0);
  const fees = Number(t.fees ?? 0);
  const collection = transport + local + driver + fees;
  const allIn = reward + collection;

  /* Every per-unit figure divides by the SAME number and guards it once.
   * `Math.round` and never a float: these are minor units, and a screen that
   * prints ₦312.4999 has learned nothing the rounded figure does not say. */
  const per = (amount: number): number => (unitsKept === 0 ? 0 : Math.round(amount / unitsKept));

  return {
    generatedAt: q.now,
    range: q.range,
    rates: {
      unitCostMinor:
        rates.rows[0]?.unit_cost_minor == null ? null : Number(rates.rows[0].unit_cost_minor),
      unitMarketCostMinor:
        rates.rows[0]?.unit_market_cost_minor == null
          ? null
          : Number(rates.rows[0].unit_market_cost_minor),
      /* NGN unless the shop says otherwise. The redemption currency is the
       * only currency this subsystem has ever had a column for. */
      currency: String(rates.rows[0]?.redemption_currency ?? 'NGN'),
    },
    totals: {
      returns: Number(t.returns ?? 0),
      unitsKept,
      unitsRejected: Number(t.units_rejected ?? 0),
      rewardMinor: reward,
      transportMinor: transport,
      localMinor: local,
      driverMinor: driver,
      feesMinor: fees,
      collectionMinor: collection,
      allInMinor: allIn,
    },
    perUnit: {
      allIn: per(allIn),
      reward: per(reward),
      transport: per(transport),
      local: per(local),
      driver: per(driver),
      fees: per(fees),
    },
    byMonth: months.rows.map((row) => {
      const kept = Number(row.units_kept ?? 0);
      const monthReward = Number(row.reward ?? 0);
      const monthAll =
        monthReward +
        Number(row.transport ?? 0) +
        Number(row.local_run ?? 0) +
        Number(row.driver ?? 0) +
        Number(row.fees ?? 0);
      return {
        month: String(row.month),
        unitsKept: kept,
        rewardMinor: monthReward,
        transportMinor: Number(row.transport ?? 0),
        localMinor: Number(row.local_run ?? 0),
        driverMinor: Number(row.driver ?? 0),
        feesMinor: Number(row.fees ?? 0),
        allInMinor: monthAll,
        perUnitMinor: kept === 0 ? 0 : Math.round(monthAll / kept),
      };
    }),
    byArea: areas.rows.map((row) => {
      const kept = Number(row.units_kept ?? 0);
      const areaAll = Number(row.reward ?? 0) + Number(row.collection ?? 0);
      return {
        areaId: row.area_id == null ? null : String(row.area_id),
        region: row.region == null ? null : String(row.region),
        name: row.name == null ? null : String(row.name),
        returns: Number(row.returns ?? 0),
        unitsKept: kept,
        rewardMinor: Number(row.reward ?? 0),
        collectionMinor: Number(row.collection ?? 0),
        allInMinor: areaAll,
        perUnitMinor: kept === 0 ? 0 : Math.round(areaAll / kept),
        estimated: Number(row.estimated ?? 0),
      };
    }),
    costliest: costliest.rows.map((row) => ({
      id: String(row.id),
      customerEmail: String(row.customer_email),
      customerName: row.customer_name == null ? null : String(row.customer_name),
      areaName: row.area_name == null ? null : String(row.area_name),
      /* `bigint`, which the Neon driver hands back as a STRING and PGlite is
       * configured to imitate — `Number` on the raw value, never a bare cast. */
      closedAt: row.closed_at == null ? null : Number(row.closed_at),
      unitsKept: Number(row.units_kept ?? 0),
      allInMinor: Number(row.all_in ?? 0),
      perUnitMinor: Math.round(Number(row.per_unit ?? 0)),
      estimated: row.estimated === true,
    })),
    coverage: {
      recorded: Number(t.recorded ?? 0),
      estimated: Number(t.estimated ?? 0),
      uncosted: Number(t.uncosted ?? 0),
    },
  };
}
