import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { paymentEventId as mintPaymentEventId } from './ids';
import { applyIntentStatus, getIntent, getIntentByProviderRef } from './intents';
import { applyRefundEvent } from './refunds';
import type { Db } from '../../db/client';
import type { PaymentsCheckoutPort } from './checkout';
import type { ProviderEvent } from './provider/types';
import type { PaymentStatus } from '../../../shared/commerce/ports';

/**
 * Webhook ingestion: store durably, acknowledge, then process.
 *
 * THE SPLIT BETWEEN `storeEvent` AND `processEvent` IS THE DESIGN, not an
 * organisational preference. `03-payments.md` §4: "Return 200 the instant the
 * event is durably stored. Processing happens after, from the stored row. A
 * webhook that does its work before acknowledging is a webhook the provider
 * retries because your database was slow, and now you have two in flight."
 *
 * Paystack's retry schedule is what makes that concrete: a non-200 is
 * redelivered every 3 minutes for four attempts and then hourly for 72 hours,
 * with a 30-second timeout per attempt. Any processing slower than that window
 * turns one event into a stream of duplicates, all racing each other.
 *
 * SO PROCESSING IS ALSO RE-DRIVABLE, and that is what makes acknowledging early
 * honest on serverless. A Vercel Function can be frozen the moment it responds,
 * so work scheduled "after the response" may simply not happen. The stored row
 * is the durable part; `drainPaymentEvents` picks up anything left with
 * `processed_at IS NULL`, and every apply path is idempotent on that column. An
 * instance dying mid-process costs a delay, never a lost event and never a
 * double application.
 */

export interface StoredEvent {
  id: string;
  providerEventId: string;
  intentId: string | null;
  type: string;
  payload: unknown;
  receivedAt: number;
  processedAt: number | null;
  lastError: string | null;
  anomaly: string | null;
}

const EVENT_COLUMNS = sql`id, provider_event_id, intent_id, type, payload,
  received_at, processed_at, last_error, anomaly`;

function mapEventRow(row: Record<string, unknown>): StoredEvent {
  return {
    id: String(row.id),
    providerEventId: String(row.provider_event_id),
    intentId: row.intent_id == null ? null : String(row.intent_id),
    type: String(row.type),
    payload: row.payload,
    receivedAt: toEpochMs(row.received_at),
    processedAt: toEpochMsOrNull(row.processed_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    anomaly: row.anomaly == null ? null : String(row.anomaly),
  };
}

export interface StoreEventResult {
  /** The row id — present whether this delivery was the first or a repeat. */
  rowId: string;
  /** True when this exact `providerEventId` was already stored. */
  duplicate: boolean;
}

/**
 * Store a VERIFIED event, exactly once.
 *
 * `ON CONFLICT (provider_event_id) DO NOTHING` IS THE DEDUPE, and it is the
 * database's answer rather than ours. `03-payments.md` §4 is explicit that this
 * must be a unique constraint and not a prior read: providers redeliver, three
 * copies can be in flight at the same instant, and a `SELECT … WHERE
 * provider_event_id = $1` is evaluated against a snapshot taken before the
 * other two arrived. Under concurrency exactly one INSERT returns a row.
 *
 * The intent is resolved HERE, at store time, from the provider's reference —
 * so the raw log is useful in a dispute without a join through a reference
 * nobody remembers. Failing to resolve is not failing to store (§4): the column
 * is nullable and carries no foreign key precisely so that a verified event we
 * cannot place is still evidence.
 */
export async function storeEvent(
  db: Db,
  event: ProviderEvent,
  now: number = Date.now(),
): Promise<StoreEventResult> {
  const intent = event.providerIntentId
    ? await getIntentByProviderRef(db, event.providerIntentId)
    : null;

  const inserted = await db.execute(sql`
    INSERT INTO shop_payment_events
      (id, provider_event_id, intent_id, type, payload, received_at)
    VALUES (${mintPaymentEventId(now)}, ${event.providerEventId}, ${intent?.id ?? null},
            ${event.type}, ${JSON.stringify(event.payload)}::jsonb, ${now})
    ON CONFLICT (provider_event_id) DO NOTHING
    RETURNING id`);

  if (inserted.rows[0]) return { rowId: String(inserted.rows[0].id), duplicate: false };

  const existing = await db.execute(
    sql`SELECT id FROM shop_payment_events WHERE provider_event_id = ${event.providerEventId}`,
  );
  return { rowId: String(existing.rows[0]?.id ?? ''), duplicate: true };
}

export async function getStoredEvent(db: Db, id: string): Promise<StoredEvent | null> {
  const res = await db.execute(
    sql`SELECT ${EVENT_COLUMNS} FROM shop_payment_events WHERE id = ${id}`,
  );
  return res.rows[0] ? mapEventRow(res.rows[0]) : null;
}

/** The provider's event-derived status → our ladder. */
const INTENT_STATUS: Record<string, PaymentStatus> = {
  requires_payment: 'requires_payment',
  authorized: 'authorized',
  captured: 'captured',
  failed: 'failed',
  cancelled: 'cancelled',
};

export interface ProcessResult {
  /** `ignored` covers both unknown types and events with nothing to apply. */
  outcome: 'applied' | 'ignored' | 'duplicate' | 'unresolved';
  emittedEventId: string | null;
}

/**
 * What processing a capture needs beyond the database.
 *
 * OPTIONAL, AND ABSENT MEANS "DO NOT COMPLETE THE CHECKOUT" rather than "fail".
 * `drainPaymentEvents` and `processEvent` are called from an owner route, from a
 * cron and from tests that care about nothing but the intent's status ladder;
 * making the port mandatory would turn every one of those into a wiring chore
 * and, worse, into a place where somebody passes a stub. The composition root
 * (`server/index.ts`) passes the real port to the paths that matter, and
 * `composition.test.ts` drives capture → order through THAT, not through a test
 * app with its own ports — which is the specific hole both this bug and the
 * earlier Orders 401 fell through.
 */
export interface CaptureDeps {
  /** Cart's port. Injected — Payments must not import `server/shop/cart/`. */
  checkout?: PaymentsCheckoutPort;
}

/**
 * Complete the checkout that this intent belongs to, BEFORE the capture is
 * recorded — and never let it break the capture (admin#27).
 *
 * ═══ WHY BEFORE ═══
 * `checkout.completed` must exist for `payment.captured` to do anything:
 * Orders' consumer parks a capture whose order does not exist yet with
 * "awaiting predecessor: checkout.completed". Its sweep processes candidates
 * `ORDER BY occurred_at ASC`, so emitting the completion first — with a strictly
 * earlier `occurred_at` than the `payment.captured` written by
 * `applyIntentStatus` a moment later — lets a SINGLE sweep apply both, in order,
 * and the customer's order exists seconds after they pay rather than after a
 * second sweep.
 *
 * THE GUARANTEE BEING RELIED ON IS NOT THAT ORDERING, THOUGH. `consumer.ts`'s
 * "a parked row is retried on every sweep" is what makes this safe: if this call
 * loses its race, or is skipped entirely because no port was injected, or fails,
 * the capture parks and a LATER `checkout.completed` unparks it on a subsequent
 * sweep. The ordering above buys latency, not correctness. That distinction is
 * why the failure below can be swallowed at all.
 *
 * ═══ WHY THE FAILURE IS SWALLOWED ═══
 * A payment recorded with no order is recoverable — a sweep, or an operator,
 * turns it into one. A payment NOT recorded because completing the checkout
 * threw is money received and forgotten, and no later process can discover it
 * because nothing wrote it down. So this runs first for latency, and its failure
 * cannot stop `applyIntentStatus` from running. RECORDING THE PAYMENT IS THE
 * MORE IMPORTANT OF THE TWO AND THE CODE SAYS SO BY CONSTRUCTION.
 *
 * ═══ DUPLICATES ═══
 * A redelivered `charge.success` reaches here again and the port answers
 * `already-completed`: no second `checkout.completed`, no error, no duplicate
 * order. `unavailable` (no such cart, never frozen) is the same — recorded in a
 * log line and otherwise ignored, because the payment still has to be recorded.
 */
export async function completeCheckoutForIntent(
  db: Db,
  intentId: string | null,
  deps: CaptureDeps,
): Promise<void> {
  const port = deps.checkout;
  if (!port || !intentId) return;
  try {
    const intent = await getIntent(db, intentId);
    if (!intent) return;
    const outcome = await port.complete(db, intent.checkoutId);
    if (outcome === 'unavailable') {
      // eslint-disable-next-line no-console -- a capture whose cart is gone is
      // an operator's problem, and this is the only place it is visible.
      console.warn(
        '[payments] captured a checkout that cannot be completed',
        JSON.stringify({ intentId, checkoutId: intent.checkoutId }),
      );
    }
  } catch (err: unknown) {
    // NAMES ONLY. This is the same discipline `recordIntentError` follows: a
    // message can quote a value, and this line goes to a log.
    // eslint-disable-next-line no-console -- see the doc comment: swallowing
    // silently would make a stuck pipeline invisible.
    console.error(
      '[payments] completing the checkout failed; recording the payment anyway',
      JSON.stringify({ intentId, error: err instanceof Error ? err.name : typeof err }),
    );
  }
}

/**
 * Process one stored event.
 *
 * UNKNOWN EVENT TYPES ARE LOGGED AND IGNORED, NEVER AN ERROR (contract §6 rule
 * 4, `03-payments.md` §4). Paystack publishes two dozen event types and adds
 * more; a `subscription.create` or a `transfer.success` reaching this endpoint
 * is harmless and expected. Throwing on one would return a non-200 for
 * something that needs no action, and the visible result is a provider-side
 * delivery-failure alarm at 3am about nothing at all. They are still STORED —
 * the raw log is append-only and complete — and then marked processed with the
 * anomaly naming why.
 */
export async function processEvent(
  db: Db,
  rowId: string,
  now: number = Date.now(),
  deps: CaptureDeps = {},
): Promise<ProcessResult> {
  const row = await getStoredEvent(db, rowId);
  if (!row) return { outcome: 'ignored', emittedEventId: null };
  if (row.processedAt !== null) return { outcome: 'duplicate', emittedEventId: null };

  const payload = (row.payload ?? {}) as { data?: Record<string, unknown> };
  const data = payload.data ?? {};

  if (row.type.startsWith('refund.')) {
    const providerRefundId = refundIdOf(data);
    if (!providerRefundId) return ignore(db, rowId, 'refund_without_id', now);
    const status =
      data.status === 'processed' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    const applied = await applyRefundEvent(db, { eventRowId: rowId, providerRefundId, status }, now);
    return {
      outcome: applied.unresolved ? 'unresolved' : applied.settled ? 'applied' : 'ignored',
      emittedEventId: applied.emittedEventId,
    };
  }

  /*
   * `charge.success` is the only charge event Paystack publishes — there is no
   * `charge.failed` — so a decline is learned by asking (`fetchIntent`) rather
   * than by waiting for a webhook that never comes. Anything else on the
   * `charge.` prefix is ignored rather than guessed at.
   */
  if (row.type === 'charge.success') {
    const next = INTENT_STATUS.captured;

    /*
     * COMPLETE THE CHECKOUT FIRST, CAPTURE SECOND (admin#27). Never the other
     * way round: see `completeCheckoutForIntent` for both halves of why — the
     * `occurred_at` ordering that lets one sweep produce the order, and the fact
     * that this call cannot throw past this line.
     */
    await completeCheckoutForIntent(db, row.intentId, deps);

    const applied = await applyIntentStatus(
      db,
      {
        eventRowId: rowId,
        intentId: row.intentId,
        next,
        providerIntentId: typeof data.reference === 'string' ? data.reference : null,
        failureReason: null,
      },
      now,
    );
    return {
      outcome: applied.moved ? 'applied' : 'ignored',
      emittedEventId: applied.emittedEventId,
    };
  }

  return ignore(db, rowId, `unhandled_type:${row.type}`, now);
}

function refundIdOf(data: Record<string, unknown>): string | null {
  const id = data.id;
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  if (typeof id === 'string' && id.length > 0) return id;
  return typeof data.refund_reference === 'string' && data.refund_reference.length > 0
    ? data.refund_reference
    : null;
}

/**
 * Acknowledge an event we will not act on, and say why in `anomaly`.
 *
 * `anomaly` AND NOT `last_error`, because this is not an error: the two columns
 * exist separately so that "we chose not to act" and "we tried and failed" are
 * distinguishable at 2am. A drain retries the second and must not retry the
 * first.
 */
async function ignore(
  db: Db,
  rowId: string,
  reason: string,
  now: number,
): Promise<ProcessResult> {
  await db.execute(sql`
    UPDATE shop_payment_events SET processed_at = ${now}, anomaly = ${reason}
     WHERE id = ${rowId} AND processed_at IS NULL`);
  return { outcome: 'ignored', emittedEventId: null };
}

/**
 * Process whatever is still pending, oldest first.
 *
 * THE SAFETY NET UNDER "ACKNOWLEDGE THEN PROCESS". Anything that was stored and
 * not processed — because the function froze after responding, because the
 * process died, because a refund event beat our own write by a millisecond — is
 * picked up here. Called at the head of each webhook request (cheap, bounded)
 * and exposed as an owner-only route for a cron.
 *
 * BOUNDED BY `limit`, and it must be: an unbounded drain on a request path is a
 * request whose duration is a function of how long the queue is, which is how a
 * backlog turns into a timeout that makes the backlog worse.
 */
export async function drainPaymentEvents(
  db: Db,
  limit = 10,
  now: number = Date.now(),
  deps: CaptureDeps = {},
): Promise<ProcessResult[]> {
  const pending = await db.execute(sql`
    SELECT id FROM shop_payment_events
     WHERE processed_at IS NULL
     ORDER BY received_at ASC, id ASC
     LIMIT ${limit}`);

  const results: ProcessResult[] = [];
  for (const row of pending.rows) {
    results.push(await processEvent(db, String(row.id), now, deps));
  }
  return results;
}
