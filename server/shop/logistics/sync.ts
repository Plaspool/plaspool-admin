import type { Db } from '../../db/client';
import { loadTemplates } from '../../email/system-templates';
import { readOrder } from '../orders/repo/orders';
import { listCourierParcelsToSync, recordCourierSyncError } from '../orders/repo/courier';
import type { ResolvedLogisticsDeps } from './deps';
import { PROVIDER_LABEL } from './port';
import { accessLinkFor, applyCourierUpdate } from './service';

/**
 * THE BACKSTOP FOR A WEBHOOK THAT NEVER ARRIVED (spec §5.6).
 *
 * A webhook is the mechanism and this is the safety net, in exactly the sense
 * `orders/routes.ts#runSweep` already means it for Payments' stored events: a
 * courier's callback can be lost to a deploy, a cold start, a 500 we answered
 * while the database was asleep, or a URL nobody registered. Without this, a
 * parcel that was delivered on Tuesday still reads "Pending Pick-Up" in the
 * admin on Friday and the customer never got a shipment email.
 *
 * IT DECIDES NOTHING ABOUT STATUSES. Every answer goes through
 * `applyCourierUpdate`, which is the one place that knows what `delivered`
 * means — so the sweep, the refresh button and the two webhooks can never drift
 * into three readings of the same courier word. This file owns only WHICH
 * parcels get asked about, HOW MANY, and what happens when a courier does not
 * answer.
 *
 * BOUNDED ON PURPOSE, twice over. `listCourierParcelsToSync` already excludes
 * every parcel whose story is over (delivered, returned, cancelled, failed, and
 * a draft that was never booked), and `limit` caps what is left to one page
 * ordered oldest-sync-first — so a backlog drains across runs rather than
 * turning one run into a request that never completes. `runSweep` shares a
 * `maxDuration: 30` budget with the payment drain and the commerce sweep, and
 * Vercel does not retry a timed-out cron.
 *
 * ONE COURIER FAILING COSTS ONE PARCEL ITS UPDATE. The try/catch is per parcel
 * and it RECORDS rather than rethrows: a courier being down is not a reason for
 * the sweep that also settles payments to fail, and `provider_last_error` is
 * what puts "we asked and could not get an answer" on the operator's screen
 * instead of leaving a parcel that merely looks stale.
 */

export interface CourierSyncSummary {
  /** Parcels we asked a courier about. */
  checked: number;
  /** Of those, the ones whose raw status was not the one we already had. */
  changed: number;
  /** Of those, the ones that moved the parcel's own lifecycle. */
  transitioned: number;
  /** Of those, the ones where the courier could not be reached or is not wired. */
  failed: number;
}

/**
 * One page of parcels per run.
 *
 * Twenty because this is a BACKSTOP behind a webhook rather than the primary
 * path: at the owner's ten-minute cron cadence that is 120 parcels an hour,
 * comfortably more than a shop this size books, and each one is a network call
 * with an 8-second ceiling paid out of a 30-second function.
 */
export const COURIER_SYNC_LIMIT = 20;

export async function syncCourierStatuses(
  db: Db,
  deps: ResolvedLogisticsDeps,
  now: number,
  limit = COURIER_SYNC_LIMIT,
): Promise<CourierSyncSummary> {
  const summary: CourierSyncSummary = { checked: 0, changed: 0, transitioned: 0, failed: 0 };

  const due = await listCourierParcelsToSync(db, limit);
  /* Nothing to do is the ORDINARY answer, and it must cost nothing — an idle
     shop runs this every ten minutes forever. `loadTemplates` reads a table, so
     it is not paid for until there is a parcel that might send an email. */
  if (due.length === 0) return summary;

  /* Once per sweep and passed down as data, for the reason `runSweep` gives:
     the render happens inside a statement builder that composes SQL
     synchronously, so a per-parcel load would be twenty identical reads of a
     nine-row table. `loadTemplates` never throws — a failed read degrades to the
     built-in wording rather than stopping a sweep. */
  const templates = await loadTemplates(db);

  for (const parcel of due) {
    /* The query already guarantees both, so this is a narrowing rather than a
       filter — but a `continue` here is still cheaper than a non-null assertion
       that would be wrong the day that query changes. */
    if (!parcel.provider || !parcel.providerRef) continue;
    summary.checked += 1;

    /* THE COURIER THAT BOOKED IT, not the one currently switched on: a shop that
       has moved to Terminal still has Fez parcels out with a rider. */
    const provider = deps.providerFor(parcel.provider);
    try {
      if (!provider) {
        /* The LABEL, not the wire name. This string lands in
           `provider_last_error` and is read by an operator on the parcel — the
           vocabulary rule applies to it exactly as it does to the timeline. */
        throw new Error(`${PROVIDER_LABEL[parcel.provider]} is not set up on this server`);
      }
      const update = await provider.track(parcel.providerRef);
      const order = await readOrder(db, parcel.orderId);
      const outcome = await applyCourierUpdate(db, parcel, update, {
        now,
        /* No request exists here, so the link is built from the STOREFRONT's
           origin — `accessLinkFor` carries the argument and the shipped bug. */
        link: order ? accessLinkFor(order, now) : null,
        templates,
        label: provider.label,
      });
      if (outcome.changed) summary.changed += 1;
      if (outcome.transitioned) summary.transitioned += 1;
    } catch (err) {
      summary.failed += 1;
      /*
       * RECORDED, NEVER RETHROWN, and the message is the courier's own failure
       * text — which `LogisticsError` has already scrubbed of anything a
       * provider response body carried. The column is `left(…, 500)` at the
       * repository, so a verbose adapter cannot fill the row either.
       */
      await recordCourierSyncError(db, parcel.id, {
        now,
        message: err instanceof Error ? err.message : 'Courier status check failed',
      });
    }
  }

  return summary;
}
