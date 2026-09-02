import { sql } from 'drizzle-orm';
import { uniqueViolation } from '../db/client';
import type { Db } from '../db/client';
import type { AuthUser } from '../../shared/types';
import { rowToAuthUser } from './users';

/**
 * Handing the store to somebody else.
 *
 * ═══ THE SWAP IS ONE STATEMENT, AND THAT IS THE WHOLE DESIGN ═══
 * `shared/roles.ts` opens by saying the owner is singular BY CONSTRUCTION
 * rather than by count — `owner` is not mintable through the API, and
 * `PATCH /users/:id/role` refuses it in both directions. That property is not
 * being loosened here. What this module adds is the one path that may move it,
 * and it moves it as a swap: the recipient is promoted and the outgoing owner
 * demoted in the SAME statement, so no observer ever sees two owners or none.
 *
 * Two sequential updates could not offer that. Between them the instance would
 * hold two owners (or, in the other order, zero — at which point
 * `countActiveOwners` reads 0 and `disableUser`'s last-owner guard stops
 * protecting anybody). Neither window is long, and neither needs to be long:
 * this app runs as concurrent lambdas.
 *
 * NOT `db.transaction`, for the reason CLAUDE.md gives at length — the Neon
 * HTTP driver throws on it unconditionally while PGlite supports it, so a
 * transaction passes every test here and 500s in production.
 */

/** Seven days, matching `INVITE_TTL_MS`. A proposal nobody accepts lapses. */
export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a proposal could not be made or honoured. Each maps to one sentence. */
export type TransferRefusal =
  /** Another proposal is already live. One at a time, by unique index. */
  | 'already_pending'
  /** The recipient is disabled, gone, or already the owner. */
  | 'bad_recipient'
  /** No live proposal with that id for this caller. */
  | 'not_pending';

export interface PendingTransfer {
  id: string;
  fromUserId: string;
  fromName: string;
  fromEmail: string;
  toUserId: string;
  toName: string;
  toEmail: string;
  createdAt: number;
  expiresAt: number;
}

const SELECT_PENDING = sql`
  SELECT t.id, t.from_user_id, t.to_user_id, t.created_at, t.expires_at,
         f.display_name AS from_name, f.email AS from_email,
         u.display_name AS to_name, u.email AS to_email
    FROM ownership_transfers t
    JOIN users f ON f.id = t.from_user_id
    JOIN users u ON u.id = t.to_user_id`;

function toPending(row: Record<string, unknown>): PendingTransfer {
  return {
    id: String(row.id),
    fromUserId: String(row.from_user_id),
    fromName: String(row.from_name),
    fromEmail: String(row.from_email),
    toUserId: String(row.to_user_id),
    toName: String(row.to_name),
    toEmail: String(row.to_email),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

/**
 * The live proposal, if there is one. At most one exists instance-wide — the
 * partial unique index in migration 0800 is what makes that true — so this
 * takes no arguments beyond the clock.
 *
 * EXPIRY IS APPLIED HERE AND NOT SWEPT. A lapsed row stays in the table as
 * history; what makes it stop counting is this predicate, which is the same
 * shape `listInvites` uses and for the same reason: a client comparing
 * `expiresAt` against its own clock disagrees with the server about any row
 * near the boundary.
 */
export async function pendingTransfer(db: Db, now: number): Promise<PendingTransfer | null> {
  const res = await db.execute(sql`
    ${SELECT_PENDING}
     WHERE t.accepted_at IS NULL AND t.cancelled_at IS NULL AND t.expires_at > ${now}`);
  return res.rows[0] ? toPending(res.rows[0]) : null;
}

/**
 * Propose the transfer. The caller is the owner; `toUserId` is who gets it.
 *
 * THE RECIPIENT IS RE-READ INSIDE THE INSERT rather than checked first, so a
 * teammate disabled between the route's lookup and this write cannot be handed
 * the store. `INSERT … SELECT … WHERE` is the shape that makes the predicate
 * part of the write instead of a race in front of it.
 *
 * `already_pending` comes off the unique index rather than a count, which is
 * what makes it hold when two owners' tabs propose at the same moment.
 */
export async function proposeTransfer(
  db: Db,
  a: { fromUserId: string; toUserId: string; now: number },
): Promise<{ ok: true; transfer: PendingTransfer } | { ok: false; reason: TransferRefusal }> {
  let inserted;
  try {
    inserted = await db.execute(sql`
      INSERT INTO ownership_transfers (from_user_id, to_user_id, created_at, expires_at)
      SELECT ${a.fromUserId}::uuid, ${a.toUserId}::uuid, ${a.now},
             ${a.now + TRANSFER_TTL_MS}
       WHERE EXISTS (
         SELECT 1 FROM users
          WHERE id = ${a.toUserId}::uuid
            AND disabled_at IS NULL
            AND role <> 'owner'
       )
      RETURNING id`);
  } catch (err) {
    if (uniqueViolation(err) === 'ownership_transfers_one_pending_uq') {
      return { ok: false, reason: 'already_pending' };
    }
    throw err;
  }

  const id = inserted.rows[0]?.id;
  if (!id) return { ok: false, reason: 'bad_recipient' };

  const res = await db.execute(sql`${SELECT_PENDING} WHERE t.id = ${String(id)}`);
  return { ok: true, transfer: toPending(res.rows[0]) };
}

/**
 * Withdraw a proposal — the sender cancelling, or the recipient declining.
 *
 * ONE FUNCTION FOR BOTH because the row records the same thing either way: it
 * stopped being pending without being accepted. `actorId` must be one of the
 * two parties, which is enforced in the statement so the route cannot forget.
 */
export async function cancelTransfer(
  db: Db,
  a: { id: string; actorId: string; now: number },
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE ownership_transfers
       SET cancelled_at = ${a.now}
     WHERE id = ${a.id}::uuid
       AND accepted_at IS NULL
       AND cancelled_at IS NULL
       AND (from_user_id = ${a.actorId}::uuid OR to_user_id = ${a.actorId}::uuid)
    RETURNING id`);
  return res.rows.length > 0;
}

/**
 * Accept: promote the recipient, demote the outgoing owner, spend the row —
 * all in one statement.
 *
 * READ THE CTEs IN ORDER, because each guard is load-bearing:
 *
 *  - `claim` spends the proposal, and EVERY condition that makes a transfer
 *    legal lives in its WHERE — including both parties' eligibility. A lapsed,
 *    cancelled, already-accepted or somebody-else's row claims nothing, and
 *    everything below is gated on it having returned a row.
 *  - `demote` turns the outgoing owner into a developer.
 *  - the final UPDATE promotes the recipient only `WHERE EXISTS (SELECT 1 FROM
 *    demote)`, so the promotion cannot happen without the demotion. That
 *    reference is also what forces `demote` to be evaluated: a data-modifying
 *    CTE nothing reads from is still executed by Postgres, but tying them
 *    together says the dependency out loud rather than relying on it.
 *
 * ⚠ BOTH ELIGIBILITY CHECKS BELONG IN `claim`, AND PUTTING ONE OF THEM IN THE
 * FINAL UPDATE PRODUCED AN INSTANCE WITH NO OWNER AT ALL. The first cut
 * checked `disabled_at IS NULL` on the promotion instead. A recipient revoked
 * between proposing and accepting then claimed the row and demoted the owner,
 * while the promotion matched nothing — every guard "worked", and the store
 * was left with zero owners and `disableUser`'s last-owner guard protecting
 * nobody. `ownership.test.ts` catches it; it is written down here because the
 * broken version reads as obviously correct.
 *
 * The rule the fix encodes: a swap may only begin once BOTH halves are known
 * to be possible. Anything conditional after the first write is a half-swap
 * waiting to happen.
 *
 * The CTEs all see the same snapshot, so `demote` cannot observe the promotion
 * and vice versa — which is exactly why this is safe to write as a swap rather
 * than as two ordered updates.
 *
 * @returns the new owner, or `null` when nothing was claimable.
 */
export async function acceptTransfer(
  db: Db,
  a: { id: string; actorId: string; now: number },
): Promise<AuthUser | null> {
  const res = await db.execute(sql`
    WITH claim AS (
      UPDATE ownership_transfers t
         SET accepted_at = ${a.now}
       WHERE t.id = ${a.id}::uuid
         AND t.to_user_id = ${a.actorId}::uuid
         AND t.accepted_at IS NULL
         AND t.cancelled_at IS NULL
         AND t.expires_at > ${a.now}
         AND EXISTS (
           SELECT 1 FROM users r
            WHERE r.id = t.to_user_id AND r.disabled_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM users o
            WHERE o.id = t.from_user_id AND o.role = 'owner'
         )
      RETURNING t.from_user_id, t.to_user_id
    ), demote AS (
      UPDATE users
         SET role = 'developer'
       WHERE id = (SELECT from_user_id FROM claim)
         AND role = 'owner'
      RETURNING id
    )
    UPDATE users
       SET role = 'owner'
     WHERE id = (SELECT to_user_id FROM claim)
       AND EXISTS (SELECT 1 FROM demote)
    RETURNING id, email, display_name, role`);

  return res.rows[0] ? rowToAuthUser(res.rows[0]) : null;
}
