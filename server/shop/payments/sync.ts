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
  /**
   * WHICH GATEWAY ANSWERS THIS CALLER IS WILLING TO ACT ON.
   *
   * `'money'` — the DEFAULT for everything that asks on its own initiative (the
   * sweep, the admin's Refresh status button): act only when the gateway says
   * the money arrived (`captured`, `authorized`). Any other answer is REPORTED
   * and applied nowhere.
   *
   * WHY THAT IS NOT TIMIDITY. Paystack maps `abandoned` to `failed`, and an
   * abandoned checkout is the ordinary end of most checkouts. `payment.failed`
   * is not an informational event in this system — Orders' consumer CANCELS the
   * order on it, releases its reservations and emails the customer. So a sweep
   * that applied every answer would, every ten minutes and unprompted:
   *
   * - cancel any order still waiting for payment and email its customer that it
   *   was cancelled, on the strength of a gateway word the customer may be about
   *   to act on — they can still pay an abandoned Paystack reference, which is
   *   exactly why `paymentStatusRank` puts `failed` BELOW `captured`; and
   * - for the far commoner case where no order exists at all, emit a
   *   `payment.failed` that parks forever, because the consumer has no order to
   *   cancel and parks awaiting a checkout that will never complete. One parked
   *   row per abandoned cart, permanently — which also destroys the
   *   `commerce_events WHERE processed_at IS NULL` count the owner reads as this
   *   pipeline's health.
   *
   * The owner asked for one thing: find the payments that SUCCEEDED and that we
   * missed. Cancelling orders is a different decision, with a customer-visible
   * consequence, and it stays a deliberate act on the order screen rather than a
   * side effect of a button labelled Refresh status. The operator is told what
   * the gateway said (`gatewayStatus` on the response), so they can act on it.
   *
   * `'any'` — the STOREFRONT'S CONFIRM ROUTE, and only it. A customer who has
   * just come back from a payment that failed must be shown that it failed; that
   * is what the route is for, and it is the behaviour it already had before this
   * file existed. Widening the sweep to `'any'` would be an owner's decision, not
   * a tidy-up.
   */
  applyWhen?: 'money' | 'any';
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
   * AN ANSWER THIS CALLER WILL NOT ACT ON — reported, and nothing written.
   *
   * NOT STORED, and that is the whole mechanism rather than a shortcut: an event
   * row left unprocessed is picked up by `drainPaymentEvents` on the very next
   * pass and applied there instead, so "store but do not apply" would apply it a
   * few seconds later through a different door. Taking no action means writing
   * nothing. `provider_synced_at` still advances at the caller, so the queue
   * moves on, and `gatewayStatus` carries the answer back to whoever asked.
   *
   * See `ReconcileDeps.applyWhen` for why a recovery sweep must not act on
   * `failed`: in this system that word cancels an order and emails a customer.
   */
  if ((deps.applyWhen ?? 'money') === 'money' && truth.status !== 'captured' && truth.status !== 'authorized') {
    return {
      gatewayStatus: truth.status,
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
  /**
   * Set when the pass could not even work out WHICH payments to ask about — the
   * candidate query itself failed.
   *
   * IT EXISTS SO THIS PASS CANNOT TAKE THE SWEEP DOWN WITH IT. Everything else
   * here is guarded per intent, but `listIntentsToSync` is one statement outside
   * that loop, and this pass runs FIRST in `runSweep` — so an unhandled throw
   * would cost the invocation its payment drain, its commerce events, its
   * mystery boxes, its mail and its courier updates. A database that has not had
   * migration 1320 applied is the concrete way that happens: `provider_synced_at`
   * is missing, the SELECT is a `42703`, and the entire money pipeline stops on a
   * deployment where everything else would have worked.
   *
   * REPORTED RATHER THAN SWALLOWED, because `checked: 0` with no error means "we
   * looked and there was nothing to ask about" — a completely different fact, and
   * one an operator reading the sweep's answer must not be handed instead of
   * this.
   */
  error?: string;
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

/**
 * How long this pass may spend STARTING gateway calls before it leaves the rest
 * for the next one.
 *
 * WHY A WALL CLOCK AND NOT JUST A PAGE SIZE. Both adapters default to a
 * ten-second per-call timeout, so a page of ten against a gateway that is
 * hanging is a hundred seconds of work inside a function `vercel.json` caps at
 * `maxDuration: 30` — and Vercel does not retry what it kills. The page size
 * bounds how MANY calls; only a clock bounds how LONG.
 *
 * IT MATTERS MORE HERE THAN FOR THE COURIER SWEEP, which has the same exposure
 * and no such budget, because of WHERE the two sit: couriers are asked LAST, so
 * a hang there costs only the courier updates — the payments, the commerce
 * events and the mail have already been done. This pass runs FIRST, on purpose
 * (`runSweep`), so without a budget one hanging gateway would starve the drain,
 * the outbox and the mail run of the entire invocation. That would make the
 * sweep less reliable than it was before this feature existed, which is not a
 * trade any recovery path gets to make.
 *
 * SIX SECONDS, and the arithmetic is deliberate: the check happens BEFORE a call
 * starts, so the worst case is a call begun at 5.9s running its full ten — about
 * sixteen seconds — which still leaves the rest of the sweep more than a third of
 * the budget. Stopping mid-call is not on the table: the database writes that
 * follow a gateway answer have to complete, and abandoning one half-done is how
 * a capture gets recorded without its checkout being completed.
 *
 * WHAT IS LEFT BEHIND IS NOT LOST. `provider_synced_at` advances only for the
 * intents actually asked about, and the queue is ordered oldest-asked-first, so
 * the ones this pass skipped sort to the FRONT of the next one.
 */
export const PAYMENT_SYNC_BUDGET_MS = 6_000;

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
  budgetMs = PAYMENT_SYNC_BUDGET_MS,
): Promise<PaymentSyncSummary> {
  const summary: PaymentSyncSummary = { checked: 0, changed: 0, captured: 0, failed: 0 };

  /* THE ONE STATEMENT OUTSIDE THE PER-INTENT GUARD, so it gets its own — see
     `PaymentSyncSummary.error`. This pass runs first in the sweep, and a throw
     here would cost the invocation everything that comes after it. */
  let due: PaymentIntentRow[];
  try {
    due = await listIntentsToSync(db, { now, limit });
  } catch (cause) {
    // eslint-disable-next-line no-console -- a sweep that cannot ask is an
    // operator's to fix, and this is the only place it is visible.
    console.error(
      '[payments] could not work out which payments to ask about',
      JSON.stringify({ error: cause instanceof Error ? cause.name : typeof cause }),
    );
    return { ...summary, error: 'candidates_failed' };
  }
  /* Nothing to ask about is the ORDINARY answer and must cost nothing — an idle
     shop runs this every ten minutes forever. */
  if (due.length === 0) return summary;

  /*
   * THE WALL CLOCK, NOT `now`. `now` is one logical timestamp for the whole
   * sweep — it is what gets written to rows, and it does not advance — so
   * measuring elapsed time with it would compare a number against itself and
   * never trip. `Date.now()` is the only thing here that moves.
   */
  const startedAt = Date.now();

  for (const intent of due) {
    /* Checked BEFORE the call, so the budget bounds what we START. See
       `PAYMENT_SYNC_BUDGET_MS`: what is left behind sorts to the front of the
       next pass, because its `provider_synced_at` was never advanced. */
    if (summary.checked > 0 && Date.now() - startedAt >= budgetMs) break;
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
