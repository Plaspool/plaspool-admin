import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import { paymentEventId as mintPaymentEventId } from './ids';
import { applyIntentStatus, getIntent, getIntentByProviderRef } from './intents';
import { applyRefundEvent } from './refunds';
import type { Db } from '../../db/client';
import type { PaymentsCheckoutPort } from './checkout';
import type { ProviderEvent, ProviderIntentStatus, ProviderRefundStatus } from './provider/types';
import type { ProviderName } from './schema';

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
  /**
   * What the event said the charge's state now is, AS THE ADAPTER COMPUTED IT
   * AT VERIFICATION TIME — never re-derived here from `payload`. Null for an
   * event that says nothing about a charge (a refund event; an event type
   * this adapter does not recognise).
   */
  intentStatus: ProviderIntentStatus | null;
  /** Same discipline, for a refund event. Null for anything that is not one. */
  refundStatus: ProviderRefundStatus | null;
  /** The provider's OWN refund id, for a refund event. Null otherwise. */
  providerRefundId: string | null;
  payload: unknown;
  receivedAt: number;
  processedAt: number | null;
  lastError: string | null;
  anomaly: string | null;
}

const EVENT_COLUMNS = sql`id, provider_event_id, intent_id, type,
  intent_status, refund_status, provider_refund_id, payload,
  received_at, processed_at, last_error, anomaly`;

function mapEventRow(row: Record<string, unknown>): StoredEvent {
  return {
    id: String(row.id),
    providerEventId: String(row.provider_event_id),
    intentId: row.intent_id == null ? null : String(row.intent_id),
    type: String(row.type),
    intentStatus: row.intent_status == null ? null : (row.intent_status as ProviderIntentStatus),
    refundStatus: row.refund_status == null ? null : (row.refund_status as ProviderRefundStatus),
    providerRefundId: row.provider_refund_id == null ? null : String(row.provider_refund_id),
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
 *
 * `event.intentStatus`, `event.refundStatus` AND `event.providerRefundId` ARE
 * PERSISTED HERE, NOT JUST `type` AND `payload` (task-9). `parseWebhook`
 * already computed all three from a VERIFIED body before this function ever
 * saw them; discarding them meant `processEvent` had to re-derive the same
 * decisions later by re-reading `payload` with Paystack's own field names —
 * which matched nothing for a gateway with different field names
 * (Flutterwave), and which trusted the raw body for a gateway whose webhook
 * signal does not cryptographically verify it (Flutterwave's `verif-hash`,
 * unlike Paystack's HMAC). See `processEvent`'s own comment for the full
 * account. `payload` is kept exactly as it was: evidence, not a source of
 * decisions.
 *
 * `providerName` IS AN EXPLICIT ARGUMENT — never read off `event`, which
 * carries no such field, and never guessed from `event.type`. A real caller
 * knows which adapter's `parseWebhook` produced this event, because it is the
 * one that called it, and that is the one place this fact can be known
 * honestly.
 *
 * @deprecated THE `= 'paystack'` DEFAULT — not this function. Exists ONLY so
 * `server/shop/composition.test.ts`'s pre-existing two-argument call (predating
 * this task, and one this project's mode change forbids editing right now)
 * keeps compiling and keeps meaning what it always meant — the identical
 * reason `intents.ts`'s legacy `createIntent` overload gives for its own
 * `@deprecated` default. It is not a shape to copy: both webhook routes name
 * the gateway explicitly today (`routes.ts`'s `createWebhookRoutes`, bound
 * per-route to `'paystack'`/`'flutterwave'`), and any future caller must too.
 */
export async function storeEvent(
  db: Db,
  event: ProviderEvent,
  providerName: ProviderName = 'paystack',
  now: number = Date.now(),
): Promise<StoreEventResult> {
  const intent = event.providerIntentId
    ? await getIntentByProviderRef(db, event.providerIntentId)
    : null;

  const inserted = await db.execute(sql`
    INSERT INTO shop_payment_events
      (id, provider_event_id, intent_id, type, provider,
       intent_status, refund_status, provider_refund_id, payload, received_at)
    VALUES (${mintPaymentEventId(now)}, ${event.providerEventId}, ${intent?.id ?? null},
            ${event.type}, ${providerName},
            ${event.intentStatus}, ${event.refundStatus}, ${event.providerRefundId},
            ${JSON.stringify(event.payload)}::jsonb, ${now})
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
): Promise<CompletionOutcome> {
  const port = deps.checkout;
  if (!port || !intentId) return 'settled';
  try {
    const intent = await getIntent(db, intentId);
    if (!intent) return 'settled';
    const outcome = await port.complete(db, intent.checkoutId);
    if (outcome === 'retry-later') return 'retry';
    if (outcome === 'unavailable') {
      // eslint-disable-next-line no-console -- a capture whose cart is gone is
      // an operator's problem, and this is the only place it is visible.
      console.warn(
        '[payments] captured a checkout that cannot be completed',
        JSON.stringify({ intentId, checkoutId: intent.checkoutId }),
      );
    }
    return 'settled';
  } catch (err: unknown) {
    // NAMES ONLY. This is the same discipline `recordIntentError` follows: a
    // message can quote a value, and this line goes to a log.
    // eslint-disable-next-line no-console -- see the doc comment: swallowing
    // silently would make a stuck pipeline invisible.
    console.error(
      '[payments] completing the checkout failed; recording the payment anyway',
      JSON.stringify({ intentId, error: err instanceof Error ? err.name : typeof err }),
    );
    /*
     * `settled`, NOT `retry`. An unknown failure is not known to be transient —
     * an unwired port rejects every single time — so re-driving on it would turn
     * a misconfiguration into a row this drain picks up for ever. The capture is
     * still recorded, the outbox still holds it, and the parked
     * `payment.captured` plus this log line are what an operator acts on.
     */
    return 'settled';
  }
}

/**
 * Whether the provider event row may be marked processed.
 *
 * `retry` is reserved for the ONE case known to be transient — a lost write race
 * inside `completeCheckout`, which the port reports as `retry-later`. Everything
 * else settles, including the failures, for the reason given above.
 */
export type CompletionOutcome = 'settled' | 'retry';

/**
 * Un-gate a provider event row so the next drain re-drives it.
 *
 * ORDER IS THE WHOLE POINT: this runs AFTER `applyIntentStatus`, so the capture
 * is already recorded and money safety is untouched. Only the row's
 * `processed_at` is put back, because `drainPaymentEvents` selects on
 * `processed_at IS NULL` and that column is the only thing standing between a
 * half-finished capture and a retry.
 *
 * RE-DRIVING IS SAFE, NOT MERELY TOLERABLE. The second pass calls
 * `completeCheckoutForIntent` again — which is idempotent, and this time wins the
 * race — and then `applyIntentStatus` again, where the rank guard sees the intent
 * already at `captured`, moves nothing and emits no second `payment.captured`.
 * The re-drive costs one statement and completes the checkout that was lost.
 *
 * `last_error` AND NOT `anomaly`: the two columns exist separately so that "we
 * tried and failed" and "we chose not to act" stay distinguishable at 2am. This
 * is the first.
 */
async function reopenForRetry(db: Db, rowId: string, now: number): Promise<void> {
  await db.execute(sql`
    UPDATE shop_payment_events
       SET processed_at = NULL,
           last_error = 'checkout_completion_lost_race'
     WHERE id = ${rowId} AND processed_at = ${now}`);
}

/**
 * Process one stored event.
 *
 * DISPATCHES ON `row.intentStatus` / `row.refundStatus` / `row.providerRefundId`
 * — VALUES `storeEvent` PERSISTED FROM THE VERIFIED `ProviderEvent`, NEVER ON
 * `row.type` AND NEVER BY RE-READING `row.payload` (task-9; the plan-defect
 * this closes is recorded at length in `progress.md` under Task 6/7's entry).
 * The previous shape dispatched on `row.type === 'charge.success'` and read
 * `data.status`/`data.reference`/a refund's id straight out of the raw stored
 * body, using Paystack's own field names. Three things were wrong with that,
 * all specific to a gateway that is not Paystack:
 *
 * 1. **A gateway with different field names never matches.** Flutterwave's
 *    charge event is `charge.completed`, so `row.type === 'charge.success'`
 *    was never true for it and every Flutterwave payment fell through to
 *    `unhandled_type` — captured at the gateway, never captured here.
 * 2. **Re-reading `payload` for a decision is only as safe as the gateway's
 *    signature scheme.** Paystack HMACs the whole body, so trusting
 *    `data.status`/`data.reference` from a row that verified is sound.
 *    Flutterwave's `verif-hash` is a static secret echoed back — it proves
 *    the sender knows a value, never that the body is unmodified — so a
 *    consumer that reads decisions out of `payload` is one gateway swap away
 *    from acting on an attacker's own bytes. `refundStatus`/`providerRefundId`
 *    are computed once, by the adapter, at verification time, and read from
 *    nowhere else afterwards; a gateway with no trustworthy way to learn one
 *    (Flutterwave has no refund webhook yet) simply reports `null` and this
 *    function does nothing with it, rather than a payload-sniffing fallback
 *    quietly trusting whatever a forger put in `data.status`.
 * 3. The captured reference was read from `data.reference`, a Paystack-only
 *    field name Flutterwave never sends.
 *
 * `payload` ITSELF IS UNCHANGED BY ANY OF THIS — still stored verbatim, still
 * evidence for a dispute. It has simply stopped being read for a decision.
 *
 * THE ONE FALLBACK THAT REMAINS, AND WHY IT IS NOT A REOPENING OF #2 ABOVE.
 * A row with `intent_status IS NULL` and `type = 'charge.success'` is read as
 * `'captured'`, exactly as this function has always treated that one literal.
 * Reaching `processEvent` at all already means either (a) `storeEvent` wrote
 * this row from a signature that verified moments ago, in which case it wrote
 * a non-null `intent_status` too — Paystack's own `parseWebhook` always
 * populates it for this exact type, so this arm never actually fires for a
 * row `storeEvent` produced — or (b) the row was placed directly in the
 * database, which needs a stronger trust boundary (write access to the
 * database) than sending an HTTP request. There is no equivalent fallback for
 * the refund arm below, on purpose: that is the branch a forged body could
 * turn into a fabricated payout, so it reads ONLY the stored, adapter-verified
 * columns.
 *
 * UNKNOWN EVENT TYPES ARE LOGGED AND IGNORED, NEVER AN ERROR (contract §6 rule
 * 4, `03-payments.md` §4). Paystack publishes two dozen event types and adds
 * more; a `subscription.create` or a `transfer.success` reaching this endpoint
 * is harmless and expected. Throwing on one would return a non-200 for
 * something that needs no action, and the visible result is a provider-side
 * delivery-failure alarm at 3am about nothing at all. They are still STORED —
 * the raw log is append-only and complete — and then marked processed with the
 * anomaly naming why. An event that carries neither an `intentStatus` nor a
 * `refundStatus` — Flutterwave's own `flutterwave.unrecognized_event`
 * sentinel included, when its `fetchIntent` could not resolve it, and any
 * Paystack type outside the charge/refund families — falls through to
 * exactly this path.
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

  if (row.refundStatus !== null) {
    const providerRefundId = row.providerRefundId;
    if (!providerRefundId) return ignore(db, rowId, 'refund_without_id', now);
    const applied = await applyRefundEvent(
      db,
      { eventRowId: rowId, providerRefundId, status: row.refundStatus },
      now,
    );
    return {
      outcome: applied.unresolved ? 'unresolved' : applied.settled ? 'applied' : 'ignored',
      emittedEventId: applied.emittedEventId,
    };
  }

  // See this function's own comment for why this one literal is read as
  // 'captured' even with no recorded `intentStatus` — a row `storeEvent`
  // itself wrote never needs it, because Paystack's `parseWebhook` already
  // sets `intentStatus` for this exact type.
  const intentStatus: ProviderIntentStatus | null =
    row.intentStatus ?? (row.type === 'charge.success' ? 'captured' : null);

  if (intentStatus !== null) {
    const next = intentStatus;

    /*
     * COMPLETE THE CHECKOUT FIRST, CAPTURE SECOND (admin#27) — AND ONLY FOR AN
     * ACTUAL CAPTURE. Never the other way round: see `completeCheckoutForIntent`
     * for both halves of why — the `occurred_at` ordering that lets one sweep
     * produce the order, and the fact that this call cannot throw past this
     * line. Gated on `next === 'captured'` because, unlike Paystack (whose
     * `intentStatus` is only ever `'captured'` or `null` — there is no
     * `charge.failed` webhook), a gateway that reports its true status on
     * every delivery (Flutterwave: "the webhook is a TRIGGER telling this
     * adapter to go look", `flutterwave.ts`) can legitimately report
     * `'requires_payment'`, `'failed'` or `'cancelled'` here too, and
     * completing a checkout for a payment that did NOT succeed would create an
     * order for money nobody paid.
     */
    const completion =
      next === 'captured' ? await completeCheckoutForIntent(db, row.intentId, deps) : 'settled';

    const applied = await applyIntentStatus(
      db,
      {
        eventRowId: rowId,
        intentId: row.intentId,
        next,
        /*
         * `null`, NOT read from `payload`. The old code read `data.reference`
         * here — a Paystack-only field name — to defensively backfill
         * `shop_payment_intents.provider_intent_id` via `COALESCE` when it was
         * somehow still NULL. That backfill was already unreachable in
         * practice: `row.intentId` is only non-null because `storeEvent`
         * resolved it with `getIntentByProviderRef`, which searches BY
         * `provider_intent_id` — so a resolved row's intent already has that
         * column set to this same value by construction, and `null` here
         * changes nothing that COALESCE would not have left alone anyway.
         */
        providerIntentId: null,
        /*
         * `null`. This function has no stored failure reason to report —
         * Part 2 of task 9 added `intent_status`/`refund_status`/
         * `provider_refund_id` to `shop_payment_events`, not `failure_reason`
         * — so a `next === 'failed'` reaching here through a real webhook
         * (only possible for a future gateway; Paystack never sends one)
         * records no specific reason, same as this line already did for
         * every Paystack event before this change. `applyIntentStatus`
         * reports it as `'unknown'` in the outbox, which is a known,
         * intentionally out-of-scope limitation — see this task's report.
         */
        failureReason: null,
      },
      now,
    );
    /*
     * A LOST RACE LEAVES THIS ROW UNPROCESSED, so the next drain finishes the
     * job — and it happens HERE, after the capture is recorded, never instead of
     * recording it. Money safety is unchanged: the intent is already `captured`
     * and `payment.captured` is already in the outbox by the time this runs.
     *
     * Without it the design's one supposedly-recoverable failure was not
     * recoverable at all: the completion is swallowed, `applyIntentStatus` marks
     * this row processed, `drainPaymentEvents` only selects rows where
     * `processed_at IS NULL`, and so nothing ever calls `complete()` for that
     * cart again. `checkout.completed` is never emitted and the capture parks
     * twenty times and is abandoned.
     */
    if (completion === 'retry') await reopenForRetry(db, rowId, now);

    return {
      outcome: applied.moved ? 'applied' : 'ignored',
      emittedEventId: applied.emittedEventId,
    };
  }

  return ignore(db, rowId, `unhandled_type:${row.type}`, now);
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
