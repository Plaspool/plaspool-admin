import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { allowedActionsFor } from '../returns/repo';
import { listBanners } from '../banners/repo';
import type { Db } from '../../db/client';
import type { Banner } from '../banners/repo';
import type { LedgerEntry } from '../ledger/repo';
import type { ReturnListItem } from '../returns/query';
import type { ReturnStatus } from '../errors';

/**
 * The Overview's one read — contract #28.
 *
 * WHY THIS EXISTS AS A ROUTE RATHER THAN AS SIX CALLS FROM THE SCREEN. The
 * Overview answers one question ("what is waiting on somebody this morning")
 * out of four tables, and every one of its figures is an aggregate over rows
 * the client has no other reason to hold. Six list requests would ship the
 * queue, the ledger and the banner table to a screen that renders four numbers
 * and thirteen lines out of them, and would make the first paint wait for the
 * slowest of six round trips.
 *
 * IT IS ALL READS AND NOTHING HERE IS A TRANSACTION. Five independent
 * statements, run together, whose numbers may each be a few milliseconds apart
 * — which is correct for a dashboard and would be wrong for a total somebody
 * reconciles. Nothing on this screen is subtracted from anything else on it, so
 * there is no pair of figures a skew here could make contradict each other.
 *
 * THE CLOCK IS AN ARGUMENT, like every other repository in this subsystem: an
 * age of "two days" and a thirty-day window are both answers about NOW, and a
 * test that cannot name the instant can only assert that a number exists.
 */

/** Contract §Types `MarketingSummary.tiles`. */
export interface SummaryTiles {
  needsScheduling: { count: number; oldestAgeMs: number | null };
  outForPickup: { count: number; nextPickupAt: number | null };
  toInspect: { count: number; oldestAgeMs: number | null };
  awarded30d: { points: number; returns: number };
}

/** Contract §Types `MarketingSummary`. */
export interface MarketingSummary {
  tiles: SummaryTiles;
  /** ≤5, oldest first — the same ordering and the same row shape as the queue. */
  oldestOpen: ReturnListItem[];
  /** ≤8. Carries the address because the Overview is not scoped to a customer. */
  latestLedger: (LedgerEntry & { customerEmail: string })[];
  /** Non-archived only; the client derives each one's display status. */
  banners: Banner[];
  /** Queued mail, so a sweep nobody fired is visible rather than silent (D6). */
  pendingEmailIntents: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** The four statuses a return can be in while it is still somebody's problem. */
const OPEN: readonly ReturnStatus[] = ['requested', 'scheduled', 'collected', 'received'];

const openList = sql.join(
  OPEN.map((status) => sql`${status}`),
  sql`, `,
);

/**
 * The four tiles, in ONE grouped statement plus one for the awarded window.
 *
 * `FILTER (WHERE …)` rather than four scans: every tile is an aggregate over
 * the same table with a different predicate, which is exactly what the filtered
 * aggregate is for, and PGlite and Postgres agree on it.
 *
 * The ages are computed HERE rather than shipped as timestamps because the tile
 * renders "oldest 2d" — a duration. Sending `min(created_at)` would make every
 * client subtract from a clock that is not the one the count was taken against.
 */
async function readTiles(db: Db, now: number): Promise<SummaryTiles> {
  const res = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'requested')::int AS needs_scheduling,
      min(created_at) FILTER (WHERE status = 'requested') AS needs_scheduling_oldest,
      count(*) FILTER (WHERE status IN ('scheduled', 'collected'))::int AS out_for_pickup,
      min(pickup_scheduled_at) FILTER (
        WHERE status IN ('scheduled', 'collected') AND pickup_scheduled_at IS NOT NULL
      ) AS next_pickup_at,
      count(*) FILTER (WHERE status = 'received')::int AS to_inspect,
      -- Since it ARRIVED, not since it was asked for: a box on a shelf has been
      -- waiting on an inspection only since it landed.
      min(coalesce(received_at, created_at)) FILTER (WHERE status = 'received') AS to_inspect_oldest,
      count(*) FILTER (WHERE status = 'awarded' AND closed_at >= ${now - THIRTY_DAYS_MS})::int
        AS awarded_returns,
      coalesce(
        sum(points_awarded) FILTER (WHERE status = 'awarded' AND closed_at >= ${now - THIRTY_DAYS_MS}),
        0
      )::int AS awarded_points
      FROM marketing_return_requests`);

  const row = res.rows[0] ?? {};
  const age = (at: unknown): number | null => {
    const ms = toEpochMsOrNull(at);
    // Never negative: a row stamped a few milliseconds into the future by a
    // clock skew would otherwise render as a negative age.
    return ms === null ? null : Math.max(0, now - ms);
  };

  return {
    needsScheduling: {
      count: Number(row.needs_scheduling ?? 0),
      oldestAgeMs: age(row.needs_scheduling_oldest),
    },
    outForPickup: {
      count: Number(row.out_for_pickup ?? 0),
      nextPickupAt: toEpochMsOrNull(row.next_pickup_at),
    },
    toInspect: {
      count: Number(row.to_inspect ?? 0),
      oldestAgeMs: age(row.to_inspect_oldest),
    },
    awarded30d: {
      points: Number(row.awarded_points ?? 0),
      returns: Number(row.awarded_returns ?? 0),
    },
  };
}

/**
 * The five returns that have been waiting longest — the same shape the queue's
 * rows have, so the panel can render the server's own next action on each.
 *
 * OLDEST FIRST AND OPEN ONLY, which is what makes the panel a worklist rather
 * than a recent-activity feed. `allowedActions` is served here for the reason
 * it is served everywhere in this subsystem (spec D4): the panel offers one
 * button per row and it must be the button the state machine will accept.
 */
async function readOldestOpen(db: Db, limit: number): Promise<ReturnListItem[]> {
  const res = await db.execute(sql`
    SELECT r.id, r.status, r.revision, r.customer_email, r.customer_name, r.qty_declared,
           r.qty_accepted, r.qty_rejected, r.points_per_unit_snapshot, r.points_awarded,
           r.pickup_scheduled_at, r.pickup_address, r.service_area_id,
           r.created_at, r.updated_at,
           p.id AS prog_id, p.name AS prog_name,
           p.points_label_singular AS prog_points_one, p.points_label_plural AS prog_points_other,
           p.unit_label_singular AS prog_unit_one, p.unit_label_plural AS prog_unit_other,
           a.name AS area_name
      FROM marketing_return_requests r
      JOIN marketing_programs p ON p.id = r.program_id
      /* LEFT, because a return from outside the served set is a legal row and
       * the Overview's "oldest open" panel is exactly where an operator should
       * meet one — an inner join would hide the returns nobody can award. */
      LEFT JOIN marketing_service_areas a ON a.id = r.service_area_id
     WHERE r.status IN (${openList})
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT ${limit}`);

  return res.rows.map((row) => {
    const status = String(row.status) as ReturnStatus;
    return {
      id: String(row.id),
      status,
      revision: Number(row.revision),
      customerEmail: String(row.customer_email),
      customerName: row.customer_name == null ? null : String(row.customer_name),
      qtyDeclared: Number(row.qty_declared),
      qtyAccepted: row.qty_accepted == null ? null : Number(row.qty_accepted),
      qtyRejected: row.qty_rejected == null ? null : Number(row.qty_rejected),
      /* The rate the customer was PROMISED, so the Overview's oldest-open panel
       * and a board card price the same return identically. */
      pointsPerUnitSnapshot: Number(row.points_per_unit_snapshot),
      pointsAwarded: row.points_awarded == null ? null : Number(row.points_awarded),
      pickupScheduledAt: toEpochMsOrNull(row.pickup_scheduled_at),
      pickupAddress: row.pickup_address == null ? null : String(row.pickup_address),
      allowedActions: allowedActionsFor(status),
      /* The same shape the queue ships, so one row renderer draws a card on the
       * Overview and on a board. Null is the out-of-area footer. */
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
  });
}

/**
 * The most recent ledger rows across every customer.
 *
 * `reason` IS SHIPPED AS STORED and the screen prints it verbatim — it was
 * rendered in the labels of the day it was written, and re-rendering it through
 * today's would let a rename rewrite what March said (spec D2d). `programName`
 * beside it is the live pointer, for a link and nothing else.
 */
async function readLatestLedger(
  db: Db,
  limit: number,
): Promise<(LedgerEntry & { customerEmail: string })[]> {
  const res = await db.execute(sql`
    SELECT l.id, l.kind, l.delta, l.balance_after, l.reason, l.program_id,
           p.name AS program_name, l.return_request_id, l.order_id,
           l.actor_type, l.actor_id, l.created_at, l.customer_email
      FROM marketing_ledger l
      LEFT JOIN marketing_programs p ON p.id = l.program_id
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ${limit}`);

  return res.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as LedgerEntry['kind'],
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    reason: String(row.reason),
    programId: row.program_id == null ? null : String(row.program_id),
    programName: row.program_name == null ? null : String(row.program_name),
    returnRequestId: row.return_request_id == null ? null : String(row.return_request_id),
    orderId: row.order_id == null ? null : String(row.order_id),
    actorType: String(row.actor_type) as LedgerEntry['actorType'],
    actorId: row.actor_id == null ? null : String(row.actor_id),
    createdAt: toEpochMs(row.created_at),
    customerEmail: String(row.customer_email),
  }));
}

/** Mail written but not yet delivered — the ops line, and the reason a dropped
 *  fire-and-forget sweep is visible instead of silent. */
async function readPendingIntents(db: Db): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM marketing_email_intents WHERE sent_at IS NULL`);
  return Number(res.rows[0]?.n ?? 0);
}

export const OLDEST_OPEN_LIMIT = 5;
export const LATEST_LEDGER_LIMIT = 8;

export async function readSummary(db: Db, now: number): Promise<MarketingSummary> {
  /*
   * Concurrently, because they are five independent reads and the screen waits
   * for all of them — sequential awaits would make the slowest the sum rather
   * than the maximum. Nothing here writes, so there is no ordering to respect.
   */
  const [tiles, oldestOpen, latestLedger, banners, pendingEmailIntents] = await Promise.all([
    readTiles(db, now),
    readOldestOpen(db, OLDEST_OPEN_LIMIT),
    readLatestLedger(db, LATEST_LEDGER_LIMIT),
    listBanners(db),
    readPendingIntents(db),
  ]);

  return {
    tiles,
    oldestOpen,
    latestLedger,
    // Archived banners are history the Banners screen still lists; on a panel
    // that says what the site is showing they are noise.
    banners: banners.filter((banner) => banner.status !== 'archived'),
    pendingEmailIntents,
  };
}
