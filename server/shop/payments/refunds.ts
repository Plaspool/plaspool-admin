import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { toEpochMs, uniqueViolation } from '../../db/client';
import { ProviderError, isIndeterminate } from './provider/scrub';
import { refundId as mintRefundId, eventId as mintEventId } from './ids';
import { getIntent } from './intents';
import type { Db } from '../../db/client';
import type { PaymentProvider } from './provider/types';

/**
 * Refunds. Admin-initiated only in v1 (contract §13 — there is no customer RMA
 * flow), partial supported, and never able to exceed what was captured.
 *
 * A REFUND IS NOT A NEGATIVE CHARGE AND NOT A CANCELLATION (`03-payments.md`
 * §6). Three distinct states, three distinct code paths: cancelling touches an
 * intent that was never paid, refunding moves money that was.
 *
 * THE SUM-CHECK IS THE HARD PART, AND IT IS NOT WHERE IT LOOKS.
 *
 * The obvious implementation reads `SELECT SUM(amount) FROM shop_refunds WHERE
 * intent_id = $1`, compares it in JS, and inserts. That is wrong under
 * concurrency in the precise way Part 2b documented: two partial refunds
 * arriving together both read a total of 0, both pass, both insert, and
 * together they exceed the capture. The read is against a snapshot the other
 * writer has already invalidated. Mutation-testing that codebase showed every
 * such precondition had ZERO coverage — replacing the predicate with `true`
 * broke none of 254 tests, because every test was satisfied by the JS
 * pre-check.
 *
 * So the total is a COLUMN ON THE INTENT, and the guard is
 * `refunded_total + $new <= amount` inside an UPDATE's own WHERE. Two
 * concurrent updates to one row serialise on the row lock, and Postgres
 * re-evaluates the loser's predicate against the winner's committed row before
 * letting it proceed — so the loser sees the new total and fails. The refund
 * INSERT is fed `FROM` that UPDATE's `RETURNING`, so a failed guard produces
 * zero rows rather than a refund. One statement, no transaction (the Neon HTTP
 * driver rejects `transaction()`), and a CHECK constraint behind it that holds
 * the same invariant against SQL run by hand.
 */

export interface RefundRow {
  id: string;
  intentId: string;
  amount: number;
  currency: string;
  reason: string | null;
  providerRefundId: string | null;
  idempotencyKey: string;
  status: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

const REFUND_COLUMNS = sql`id, intent_id, amount, currency, reason, provider_refund_id,
  idempotency_key, status, created_at, updated_at, created_by`;

export function mapRefundRow(row: Record<string, unknown>): RefundRow {
  return {
    id: String(row.id),
    intentId: String(row.intent_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    reason: row.reason == null ? null : String(row.reason),
    providerRefundId: row.provider_refund_id == null ? null : String(row.provider_refund_id),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as RefundRow['status'],
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    createdBy: String(row.created_by),
  };
}

export async function listRefunds(db: Db, intentId: string): Promise<RefundRow[]> {
  const res = await db.execute(
    sql`SELECT ${REFUND_COLUMNS} FROM shop_refunds WHERE intent_id = ${intentId}
        ORDER BY created_at ASC, id ASC`,
  );
  return res.rows.map(mapRefundRow);
}

async function getRefundByKey(db: Db, key: string): Promise<RefundRow | null> {
  const res = await db.execute(
    sql`SELECT ${REFUND_COLUMNS} FROM shop_refunds WHERE idempotency_key = ${key}`,
  );
  return res.rows[0] ? mapRefundRow(res.rows[0]) : null;
}

export interface CreateRefundInput {
  intentId: string;
  /** Minor units, positive. Partial when less than what remains. */
  amount: number;
  reason?: string;
  idempotencyKey: string;
  /** `users.id` of the owner who asked for it. */
  createdBy: string;
}

export interface CreateRefundResult {
  refund: RefundRow;
  /** False when this call read through to a refund an earlier call created. */
  created: boolean;
}

export async function createRefund(
  db: Db,
  provider: PaymentProvider,
  input: CreateRefundInput,
  now: number = Date.now(),
): Promise<CreateRefundResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BadRequestError('amount');
  }

  const id = mintRefundId(now);

  /*
   * THE ROW IS CLAIMED BEFORE THE PROVIDER IS CALLED, and on this provider that
   * ordering is the entire protection against a double refund. Paystack's
   * `POST /refund` has NO idempotency key: calling it twice creates two refunds
   * and pays the customer twice. So winning the UNIQUE `idempotency_key` is
   * what earns the right to make the call, and a retry loses the insert and
   * read-throughs instead of issuing a second one. Reverse these two and the
   * bug is invisible in every test that does not run them concurrently.
   */
  let inserted;
  try {
    inserted = await db.execute(sql`
      WITH claim AS (
        UPDATE shop_payment_intents
           SET refunded_total = shop_payment_intents.refunded_total + ${input.amount},
               updated_at = ${now},
               revision = shop_payment_intents.revision + 1
         WHERE shop_payment_intents.id = ${input.intentId}
           AND shop_payment_intents.status IN ('captured', 'partially_refunded')
           AND shop_payment_intents.refunded_total + ${input.amount}
               <= shop_payment_intents.amount
        RETURNING id, currency
      )
      INSERT INTO shop_refunds
        (id, intent_id, amount, currency, reason, idempotency_key, status,
         created_at, updated_at, created_by)
      SELECT ${id}, c.id, ${input.amount}, c.currency, ${input.reason ?? null},
             ${input.idempotencyKey}, 'pending', ${now}, ${now}, ${input.createdBy}
        FROM claim c
      RETURNING ${REFUND_COLUMNS}`);
  } catch (err) {
    /*
     * A UNIQUE violation on `idempotency_key` is the read-through path, and it
     * is reached by the CONSTRAINT firing rather than by a prior SELECT (§5).
     *
     * Note what Postgres does for us here and why it matters: the whole
     * statement is atomic, so when the INSERT raises, the `claim` CTE's
     * increment of `refunded_total` is rolled back with it. A retry therefore
     * does not silently consume more of the refundable balance every time it is
     * attempted — which it would if the reservation and the insert were two
     * statements.
     */
    if (uniqueViolation(err) === 'shop_refunds_idempotency_key_unique') {
      const existing = await getRefundByKey(db, input.idempotencyKey);
      if (existing) return { refund: existing, created: false };
    }
    throw err;
  }

  if (!inserted.rows[0]) {
    /*
     * Zero rows means the guard refused. Which guard, told apart by a read —
     * and all three answers are 400, because all three are PERMANENT. Contract
     * §10: a 500 is retried five times with backoff, so a refund that can never
     * be accepted must not be one.
     */
    const intent = await getIntent(db, input.intentId);
    if (!intent) throw new NotFoundError(input.intentId);
    throw new BadRequestError(
      intent.status === 'captured' || intent.status === 'partially_refunded'
        ? 'amount' // would exceed what was captured
        : 'status', // nothing was captured to refund
    );
  }

  const refund = mapRefundRow(inserted.rows[0]);
  const intent = await getIntent(db, input.intentId);
  if (!intent?.providerIntentId) throw new BadRequestError('provider_intent_id');

  try {
    const providerRefund = await provider.refund(
      {
        providerIntentId: intent.providerIntentId,
        amount: refund.amount,
        currency: refund.currency,
        merchantNote: input.reason,
      },
      input.idempotencyKey,
    );
    const updated = await db.execute(sql`
      UPDATE shop_refunds
         SET provider_refund_id = ${providerRefund.providerRefundId},
             status = ${providerRefund.status},
             updated_at = ${now}
       WHERE id = ${refund.id} AND provider_refund_id IS NULL
      RETURNING ${REFUND_COLUMNS}`);
    return {
      refund: updated.rows[0] ? mapRefundRow(updated.rows[0]) : refund,
      created: true,
    };
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'unknown';
    /*
     * THE DISTINCTION THAT DECIDES WHETHER A CUSTOMER IS PAID TWICE.
     *
     * A KNOWN failure (the provider understood and refused) means no money
     * moved, so the reservation is released and the refund is marked failed —
     * the balance becomes refundable again, which is correct and necessary.
     *
     * An INDETERMINATE failure (timeout, connection reset) means WE DO NOT KNOW.
     * The refund may well have been created. Releasing the reservation there
     * would let an operator refund the same money again and only find out from
     * the bank. So the row stays `pending` with its amount still reserved, and
     * the truth arrives from the provider's own webhook or from reconciliation
     * — which is exactly the case `03-payments.md` §5 says only a key makes
     * recoverable.
     */
    if (isIndeterminate(code)) return { refund, created: true };
    await failRefundLocally(db, refund.id, now);
    throw err;
  }
}

/**
 * Mark a refund failed and give its reservation back, in one statement.
 *
 * Gated on `status = 'pending'` so that a concurrent webhook that already
 * settled it cannot be undone, and so the release cannot happen twice — a
 * double release would understate `refunded_total` and let the same money be
 * refunded again.
 */
async function failRefundLocally(db: Db, id: string, now: number): Promise<void> {
  await db.execute(sql`
    WITH failed AS (
      UPDATE shop_refunds SET status = 'failed', updated_at = ${now}
       WHERE id = ${id} AND status = 'pending'
      RETURNING intent_id, amount
    )
    UPDATE shop_payment_intents i
       SET refunded_total = i.refunded_total - f.amount, updated_at = ${now}
      FROM failed f
     WHERE i.id = f.intent_id`);
}

export interface ApplyRefundResult {
  claimed: boolean;
  settled: boolean;
  emittedEventId: string | null;
  /** The refund could not be matched; the event is left for a later drain. */
  unresolved: boolean;
}

/**
 * Apply a verified `refund.*` webhook.
 *
 * `payment.refunded` IS EMITTED HERE AND NOT AT CREATION, because a refund is
 * asynchronous on this provider: Paystack answers `POST /refund` with
 * `pending` and settles later. Announcing "refunded" when the request was
 * merely accepted would tell Orders money had moved that may still fail.
 *
 * `payment.refund_failed` IS EMITTED HERE TOO (task-d4), on the opposite
 * settlement. Until this existed, a refund the provider ACCEPTED and later
 * failed to settle unwound perfectly on this side — the refund row, the
 * reservation, the intent's status — and told nobody: the `emitted` CTE below
 * only matched `succeeded`. That was inert while nothing acted on an
 * accepted-but-unsettled refund; it stopped being inert once cancelling a paid
 * order started refunding first and cancelling on anything short of a thrown
 * error (`b9051ab`), which meant a provider's ordinary `pending` could be
 * followed by a `failed` against an order already gone. `emitted_failed`
 * mirrors `emitted`'s shape with the opposite `WHERE`, so a redelivered
 * settlement is exactly as inert as the succeeded arm already was.
 *
 * THE INTENT'S NEW STATUS IS DERIVED FROM `refunded_total`, AND IS THE ONE
 * TRANSITION IN THIS SUBSYSTEM THAT IS NOT RANK-GUARDED. Everywhere else,
 * `shop_payment_status_rank` refuses a move that would pull an intent
 * backwards, because webhooks arrive out of order. Here that guard would be
 * actively wrong: this is not a transition, it is a FUNCTION of a column that
 * is authoritative and moves in BOTH directions — a failed refund gives its
 * reservation back. Rank-guarded, an intent whose only refund later failed
 * would be pinned at `refunded` forever.
 *
 * AN UNRESOLVED REFUND IS LEFT UNPROCESSED ON PURPOSE, and this differs from
 * the intent path deliberately. A `refund.pending` webhook can genuinely beat
 * our own `UPDATE … SET provider_refund_id` by a few milliseconds, so the row
 * we need may exist a moment later — marking the event processed would discard
 * a real event over a race. An intent event cannot have that race (the intent
 * is written before the reference can be paid), so there the unresolved case is
 * terminal and IS marked. The cost here is that an event that never resolves
 * stays pending forever with `last_error = 'unresolved_refund'`, which is one
 * cheap UPDATE per drain and a monitorable condition rather than silent loss.
 */
export async function applyRefundEvent(
  db: Db,
  args: {
    eventRowId: string;
    providerRefundId: string;
    status: 'pending' | 'succeeded' | 'failed';
  },
  now: number = Date.now(),
): Promise<ApplyRefundResult> {
  const outboxId = mintEventId(now);

  if (args.status === 'pending') {
    // Nothing to settle. Acknowledge it so the provider stops redelivering.
    const res = await db.execute(sql`
      UPDATE shop_payment_events SET processed_at = ${now}
       WHERE id = ${args.eventRowId} AND processed_at IS NULL
      RETURNING id`);
    return {
      claimed: res.rows.length > 0,
      settled: false,
      emittedEventId: null,
      unresolved: false,
    };
  }

  const target = args.status === 'succeeded' ? 'succeeded' : 'failed';

  const res = await db.execute(sql`
    WITH cur AS (
      SELECT id, intent_id, amount FROM shop_refunds
       WHERE provider_refund_id = ${args.providerRefundId}
    ),
    claimed AS (
      -- The casts are load-bearing. A bound parameter arrives with no declared
      -- type, so CASE WHEN ... THEN $1 ELSE NULL END resolves to text, and
      -- assigning that to a bigint column is SQLSTATE 42804. Measured, not
      -- predicted: five tests in this file failed exactly that way first.
      UPDATE shop_payment_events
         SET processed_at = CASE WHEN EXISTS (SELECT 1 FROM cur)
                                 THEN ${now}::bigint ELSE NULL::bigint END,
             last_error = CASE WHEN EXISTS (SELECT 1 FROM cur) THEN NULL::text
                               ELSE 'unresolved_refund'::text END
       WHERE id = ${args.eventRowId} AND processed_at IS NULL
      RETURNING id
    ),
    settled AS (
      UPDATE shop_refunds r
         SET status = ${target}, updated_at = ${now}
       WHERE r.id = (SELECT id FROM cur)
         AND r.status = 'pending'
         AND EXISTS (SELECT 1 FROM claimed)
         AND EXISTS (SELECT 1 FROM cur)
      RETURNING r.id, r.intent_id, r.amount
    ),
    intent AS (
      UPDATE shop_payment_intents i
         SET refunded_total = CASE WHEN ${target}::text = 'failed'
                                   THEN i.refunded_total - (SELECT amount FROM settled)
                                   ELSE i.refunded_total END,
             -- Derived from the total, and deliberately NOT rank-guarded.
             -- See the note above this function.
             status = CASE
               WHEN ${target}::text = 'failed' AND i.refunded_total - (SELECT amount FROM settled) <= 0
                 THEN 'captured'
               WHEN ${target}::text = 'failed'
                 THEN 'partially_refunded'
               WHEN i.refunded_total >= i.amount THEN 'refunded'
               ELSE 'partially_refunded'
             END,
             updated_at = ${now},
             revision = i.revision + 1
       WHERE i.id = (SELECT intent_id FROM settled)
      RETURNING i.id, i.checkout_id, i.amount, i.currency, i.refunded_total
    ),
    emitted AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, 'payment.refunded', i.id,
             jsonb_build_object(
               'intentId', i.id,
               'checkoutId', i.checkout_id,
               'amount', i.amount,
               'currency', i.currency,
               'occurredAt', ${now}::bigint,
               'refundId', s.id,
               'refundedAmount', s.amount,
               'refundedTotal', i.refunded_total,
               'remainingBalance', i.amount - i.refunded_total
             ),
             ${now}, 0
        FROM intent i JOIN settled s ON s.intent_id = i.id
       WHERE ${target}::text = 'succeeded'
      RETURNING id
    ),
    -- task-d4: THE OTHER HALF OF emitted, AND THE WHOLE POINT OF THIS TASK.
    --
    -- SQL comments here, not a JS block comment: this whole WITH clause is
    -- one tagged template literal, and an unescaped backtick in a JS-style
    -- comment placed inside it would close the template early. Every note
    -- below stays backtick-free for the same reason.
    --
    -- Same shape, same intent/settled join, opposite WHERE -- a pure
    -- addition sitting beside the succeeded arm rather than a change to it.
    -- outboxId is safely reused: target is one value for the whole
    -- statement, so exactly one of emitted/emitted_failed ever produces a
    -- row per call and there is never a collision.
    --
    -- Payments unwinds itself correctly on a failed settlement -- settled
    -- marks the refund row failed, intent gives the reservation back -- and
    -- until this arm existed it told nobody. That was harmless while nothing
    -- downstream acted on an accepted-but-unsettled refund; it stopped being
    -- harmless when cancelling a paid order (b9051ab) started refunding
    -- FIRST and cancelling on anything short of a thrown error, including
    -- the provider's ordinary pending. A refund accepted and later failed
    -- left a cancelled order and no signal the money never moved.
    --
    -- refundedTotal here is the POST-UNWIND figure, not a total that grew:
    -- i.refunded_total was read AFTER the intent CTE's own CASE already
    -- subtracted this failed amount back out, so a consumer is told the
    -- balance as it now stands, not as it stood before the failure.
    emitted_failed AS (
      INSERT INTO commerce_events (id, type, subject_id, payload, occurred_at, attempts)
      SELECT ${outboxId}, 'payment.refund_failed', i.id,
             jsonb_build_object(
               'intentId', i.id,
               'checkoutId', i.checkout_id,
               'amount', i.amount,
               'currency', i.currency,
               'occurredAt', ${now}::bigint,
               'refundId', s.id,
               'failedAmount', s.amount,
               'refundedTotal', i.refunded_total
             ),
             ${now}, 0
        FROM intent i JOIN settled s ON s.intent_id = i.id
       WHERE ${target}::text = 'failed'
      RETURNING id
    )
    SELECT (SELECT count(*) FROM claimed)::int AS claimed,
           (SELECT count(*) FROM settled)::int AS settled,
           (SELECT count(*) FROM cur)::int AS resolved,
           COALESCE((SELECT id FROM emitted), (SELECT id FROM emitted_failed)) AS emitted_id`);

  const row = res.rows[0] ?? {};
  return {
    claimed: Number(row.claimed) > 0,
    settled: Number(row.settled) > 0,
    emittedEventId: row.emitted_id == null ? null : String(row.emitted_id),
    unresolved: Number(row.resolved) === 0,
  };
}
