import { sql } from 'drizzle-orm';
import {
  getIntent,
  listIntentsToSync,
  markIntentSynced,
  applyIntentStatus,
  INTENT_SYNC_WINDOW_MS,
  INTENT_RECHECK_MS,
} from './intents';
import { chargeVerdict, completeCheckoutForIntent, storeEvent } from './webhook';
import type { Db } from '../../db/client';
import type { PaymentIntentRow } from './intents';
import type { PaymentsCheckoutPort } from './checkout';
import type { PaymentProvider } from './provider/types';
import type { ProviderName } from './schema';
import type { PaymentStatus } from '../../../shared/commerce/ports';

/**
 * THE BACKSTOP FOR A PAYMENT WEBHOOK THAT NEVER ARRIVED.
 *
 * `shop/logistics/sync.ts` is this file for couriers, and the argument is the
 * same one: a webhook is the MECHANISM by which a fact reaches us, and a
 * mechanism can be lost — to a deploy mid-flight, a cold start, a 500 we
 * answered while the database was asleep, a URL nobody registered, a
 * `verif-hash` somebody rotated in a dashboard. What differs is the cost of
 * losing one. A lost courier callback leaves a parcel reading "Pending Pick-Up"
 * a day too long. A lost CAPTURE leaves a shopper who has paid with no order at
 * all: the intent still reads `requires_payment`, `checkout.completed` is never
 * emitted, `shop_orders` never gets a row, and there is nothing in the admin to
 * notice — not a stuck order, not a failed email, nothing. The sale is invisible
 * on this side and settled on theirs.
 *
 * `drainPaymentEvents` DOES NOT COVER THIS, and the distinction is the whole
 * reason this file exists. That drain is the safety net for an event we STORED
 * and did not finish processing — the post-response-work gap `runSweep`'s header
 * describes. If the delivery never landed there is no row to drain, so the drain
 * runs clean and reports nothing wrong. Only asking the gateway finds it.
 *
 * ONE MECHANISM, THREE CALLERS. `reconcileIntent` below is the single path from
 * "the gateway says X" to a state change, and it is what
 * `POST /shop/payments/intents/:id/confirm` (the shopper returning from the
 * checkout page), `syncPaymentIntents` (the sweep) and
 * `POST /shop/admin/payments/intents/:id/refresh` (the admin's Refresh status
 * button) all call. That is `applyCourierUpdate`'s rule in this subsystem: the
 * place that knows what a gateway's word means must be ONE place, or three
 * callers eventually hold three readings of `captured`.
 *
 * IT INVENTS NO EVIDENCE. Every answer is written to the append-only
 * `shop_payment_events` log as `verify.<status>` before anything is applied, so
 * a dispute record distinguishes a state change we were TOLD about from one we
 * went and ASKED about — and the money guard (`chargeVerdict`) is the webhook's
 * own, unchanged, because a payment for the wrong amount or in the wrong
 * currency is exactly as unacceptable when we asked for it.
 */

/** What one gateway answer did. */
export interface ReconcileResult {
  /** What the gateway says this payment is, right now. */
  gatewayStatus: PaymentStatus;
  /** What we thought it was before asking. */
  wasStatus: PaymentStatus;
  /** True when the intent actually moved — the operator's "something happened". */
  moved: boolean;
  /**
   * True when THIS call wrote the event row.
   *
   * False on a duplicate, and false when the answer was "still unpaid" — there
   * is nothing to write for the absence of news. It exists because a caller that
   * runs a sweep afterwards must run it on exactly the occasions the confirm
   * route used to: a NEW answer, whether or not it outranked what we had.
   * `moved` is narrower than that — `completeCheckoutForIntent` can have written
   * a `checkout.completed` row on a capture the rank guard then declined to
   * re-apply, and that row still wants draining.
   */
  newEvent: boolean;
  /**
   * Set when the gateway's answer was a capture we REFUSED to count: wrong
   * currency, or short of the charged amount. Recorded on the event row and
   * applied nowhere (`chargeVerdict`).
   */
  anomaly: string | null;
  /** True when this exact answer had already been stored by another caller. */
  duplicate: boolean;
}

export interface ReconcileDeps {
  /**
   * THE GATEWAY THAT TOOK THIS PAYMENT, resolved by the caller from
   * `intent.provider` and never from the admin's active-gateway switch. Passed
   * in rather than resolved here for the reason `refunds.ts` gives at length:
   * money that has already moved must resolve to the gateway that moved it,
   * forever, whatever the switch says today.
   */
  provider: PaymentProvider;
  /** Cart's port, so a capture found here completes its checkout. */
  checkout: PaymentsCheckoutPort;
  now: number;
}

/**
 * Ask one gateway about one intent and apply the answer.
 *
 * THE ORDER OF THE LAST THREE STEPS IS LOAD-BEARING and is the webhook's, not a
 * new one: complete the checkout BEFORE moving the intent, because
 * `applyIntentStatus` is what emits `payment.captured` to the outbox and Orders'
 * consumer parks that event on its `checkout.completed` predecessor. Doing it
 * the other way round leaves a parked event for the next pass to clear — which
 * works, and wastes a sweep.
 */
export async function reconcileIntent(
  db: Db,
  intent: PaymentIntentRow,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  /* The caller is responsible for this — `listIntentsToSync` filters on it and
     both routes read the row first — so it is a narrowing, not a check. */
  if (!intent.providerIntentId) {
    return {
      gatewayStatus: intent.status,
      wasStatus: intent.status,
      moved: false,
      newEvent: false,
      anomaly: null,
      duplicate: false,
    };
  }

  const truth = await deps.provider.fetchIntent(intent.providerIntentId);

  /*
   * NOTHING TO RECORD FOR "STILL UNPAID", and this is the ordinary answer.
   * Storing a `verify.requires_payment` event every fifteen minutes for every
   * abandoned cart would fill an append-only money log with the absence of
   * news, and `storeEvent`'s dedupe key would collapse them into one row
   * anyway — so the honest reading is that we learned nothing.
   */
  if (truth.status === 'requires_payment') {
    return {
      gatewayStatus: 'requires_payment',
      wasStatus: intent.status,
      moved: false,
      newEvent: false,
      anomaly: null,
      duplicate: false,
    };
  }

  /*
   * A SYNTHETIC EVENT ROW, in the same append-only log the webhook writes to,
   * with `type = 'verify.<status>'` so the provenance of this state change is
   * recorded as "we asked" rather than "they told us". The dedupe key carries
   * the FETCHED status for the reason `flutterwaveEventIdOf` gives: keyed on a
   * claimed status, a single reference could mint unlimited distinct keys.
   */
  const stored = await storeEvent(
    db,
    {
      providerEventId: `verify:${intent.providerIntentId}:${truth.status}`,
      type: `verify.${truth.status}`,
      providerIntentId: intent.providerIntentId,
      providerRefundId: null,
      intentStatus: truth.status,
      refundStatus: null,
      failureReason: truth.failureReason,
      amount: truth.amount,
      currency: truth.currency,
      payload: { source: 'fetchIntent', status: truth.status },
    },
    intent.provider,
  );

  /*
   * THE WEBHOOK'S OWN MONEY GUARD, unchanged: money counts only in the charged
   * currency and at least the charged amount. A capture that fails it is
   * written down on its event row and applied NOWHERE — the shopper keeps an
   * unpaid intent and the operator gets a named anomaly to work out, which is
   * the only honest outcome for "they paid, but not what we asked for".
   */
  const verdict =
    truth.status === 'captured' || truth.status === 'authorized'
      ? chargeVerdict(intent, truth.amount, truth.currency)
      : null;

  if (verdict) {
    if (!stored.duplicate) {
      await db.execute(sql`
        UPDATE shop_payment_events SET processed_at = ${deps.now}, anomaly = ${verdict}
         WHERE id = ${stored.rowId} AND processed_at IS NULL`);
    }
    return {
      gatewayStatus: truth.status,
      wasStatus: intent.status,
      moved: false,
      newEvent: !stored.duplicate,
      anomaly: verdict,
      duplicate: stored.duplicate,
    };
  }

  if (stored.duplicate) {
    return {
      gatewayStatus: truth.status,
      wasStatus: intent.status,
      moved: false,
      newEvent: false,
      anomaly: null,
      duplicate: true,
    };
  }

  if (truth.status === 'captured') {
    await completeCheckoutForIntent(db, intent.id, { checkout: deps.checkout });
  }
  const applied = await applyIntentStatus(db, {
    eventRowId: stored.rowId,
    intentId: intent.id,
    next: truth.status,
    providerIntentId: intent.providerIntentId,
    failureReason: truth.failureReason,
  });

  return {
    gatewayStatus: truth.status,
    wasStatus: intent.status,
    moved: applied.moved,
    newEvent: true,
    anomaly: null,
    duplicate: false,
  };
}

/** What one sweep's worth of asking found. */
export interface PaymentSyncSummary {
  /** Intents we asked a gateway about. */
  checked: number;
  /** Of those, the ones whose status the gateway disagreed with. */
  changed: number;
  /** Of those, the ones that turned out to be PAID — the recovery this is for. */
  captured: number;
  /** Of those, the ones where the gateway could not be reached or is not wired. */
  failed: number;
}

/**
 * One page of intents per run.
 *
 * TEN, against the courier sweep's twenty, because these calls sit in front of
 * the same `maxDuration: 30` budget and behind more of it: `runSweep` pays for
 * this, then the payment drain, then a five-pass commerce loop, then mystery
 * boxes, then the mail run, then twenty courier calls. Ten gateway calls is the
 * slice that leaves the rest of that intact, and at the owner's ten-minute
 * cadence it is sixty intents an hour — far more than a shop this size starts.
 */
export const PAYMENT_SYNC_LIMIT = 10;

export interface IntentSyncDeps {
  /** Resolve the gateway an intent was created under. `null` = not wired here. */
  providerFor: (name: ProviderName) => PaymentProvider | null;
  checkout: PaymentsCheckoutPort;
}

/**
 * Ask the gateways about every payment that could still have taken money.
 *
 * BOUNDED THREE WAYS, because unlike the courier sweep's candidate set this one
 * grows with every abandoned cart the shop ever has: a three-day window on
 * `created_at`, a fifteen-minute re-check floor per intent, and a page of ten
 * ordered oldest-asked-first. `listIntentsToSync` holds all three and says why.
 *
 * ONE GATEWAY FAILING COSTS ONE INTENT ITS ANSWER. The try/catch is per intent
 * and it RECORDS rather than rethrows — Paystack being down is not a reason for
 * the sweep that also drains the outbox and sends the mail to fail, and
 * `last_error` is what puts "we asked and got nothing" on the operator's screen
 * instead of leaving an intent that merely looks abandoned.
 *
 * `markIntentSynced` RUNS IN A `finally`, so an intent that threw still advances
 * the page. Without that, one permanently-failing reference at the front of the
 * queue would starve every candidate behind it on every pass forever.
 */
export async function syncPaymentIntents(
  db: Db,
  deps: IntentSyncDeps,
  now: number,
  limit = PAYMENT_SYNC_LIMIT,
): Promise<PaymentSyncSummary> {
  const summary: PaymentSyncSummary = { checked: 0, changed: 0, captured: 0, failed: 0 };

  const due = await listIntentsToSync(db, { now, limit });
  /* Nothing to ask about is the ORDINARY answer and must cost nothing — an idle
     shop runs this every ten minutes forever. */
  if (due.length === 0) return summary;

  for (const intent of due) {
    summary.checked += 1;
    let failure: string | undefined;
    try {
      const provider = deps.providerFor(intent.provider);
      if (!provider) {
        /* Not an error in the gateway's sense: an intent created under a gateway
           whose keys this deployment does not hold. Recorded so it is visible,
           because the alternative — skipping quietly — is how a whole gateway's
           worth of payments stops being checked with nothing to show it. */
        throw new Error(`${intent.provider} is not set up on this server`);
      }
      const out = await reconcileIntent(db, intent, { provider, checkout: deps.checkout, now });
      if (out.moved) summary.changed += 1;
      if (out.moved && out.gatewayStatus === 'captured') summary.captured += 1;
    } catch (cause) {
      summary.failed += 1;
      failure = cause instanceof Error && cause.message ? cause.message : 'sync_failed';
    } finally {
      await markIntentSynced(db, intent.id, { now, message: failure }).catch(() => undefined);
    }
  }

  return summary;
}

/**
 * Ask about ONE named intent, for an operator who is looking at it.
 *
 * Skips the window and the re-check floor on purpose — both exist to ration
 * unattended gateway calls across a growing candidate set, and neither has
 * anything to say about a person who has pressed a button. It still writes
 * `provider_synced_at`, so a manual check also advances the sweep's page rather
 * than leaving the same intent at the front of it.
 *
 * Re-reads the intent AFTER applying, because the answer the caller renders must
 * be the row's state and not this function's belief about it.
 */
export async function refreshIntentNow(
  db: Db,
  intentId: string,
  deps: ReconcileDeps,
): Promise<{ result: ReconcileResult; intent: PaymentIntentRow }> {
  const intent = await getIntent(db, intentId);
  if (!intent) throw new Error(`no such intent: ${intentId}`);
  try {
    const result = await reconcileIntent(db, intent, deps);
    return { result, intent: (await getIntent(db, intentId)) ?? intent };
  } finally {
    await markIntentSynced(db, intentId, { now: deps.now }).catch(() => undefined);
  }
}

export { INTENT_SYNC_WINDOW_MS, INTENT_RECHECK_MS };
