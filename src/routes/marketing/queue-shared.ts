import {
  type ReturnAction,
  type ReturnCounts,
  type ReturnListItem,
  type ReturnRequest,
  type ReturnStatus,
  type ReturnsView,
} from '../../data/api-marketing';
import { ApiError, NotFoundError, OfflineError } from '../../data/errors';
import type { StageAction } from './StageForm';

/**
 * The vocabulary the returns screens share — the waiting bands, the view names,
 * the copy for a failure, and the small pure functions that turn a server answer
 * into something a person reads.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXTRACTED FROM `MarketingReturns.tsx` WHEN THE QUEUE BECAME A DESK AND A
 * BOARD, and the extraction is the point rather than a side effect: the same
 * card is now drawn on a board, in a desk row and inside a modal, and three
 * copies of "how late is this" would drift into three different reds.
 *
 * NOTHING HERE FETCHES OR RENDERS. Everything is a constant or a pure function,
 * so all of it is testable without a DOM and none of it can be the reason a
 * screen re-renders.
 * ═══════════════════════════════════════════════════════════════════════════
 */


/**
 * The returns queue — the screen somebody opens every morning.
 *
 * ONE ROW SHAPE, TWO LAYOUTS, NO SECOND RENDER. A row is a stacked card on a
 * phone and a line of columns from 720px up, and it is the same elements either
 * way (`marketing.css`, `.mktqrow`). A table-for-desktop plus cards-for-mobile
 * is two renders to keep correct and the one that is off screen is the one that
 * goes quietly wrong — a missing action, a stale count — because nobody looks at
 * it. Everything below is written once and reflows.
 *
 * THE BUTTON ON A ROW IS THE SERVER'S ANSWER, NOT THIS FILE'S GUESS.
 * `allowedActions` arrives ordered (pipeline-advancing action first — spec D4)
 * and the row renders `allowedActions[0]`. This screen deliberately owns NO
 * status→action map: a UI that computed its own would drift from the state
 * machine the moment the machine gained a branch, and it would drift silently,
 * because a button that posts an illegal transition looks exactly like one that
 * works until it is pressed. A row whose allowed actions are missing or say only
 * "note" gets a quiet "View" — never an invented write.
 *
 * NOTHING NAMES WHAT IS BEING RETURNED. Quantities go through `fmtUnits` with
 * the labels the row carried; the program's own words are the only words on
 * screen. The section's copy that would otherwise say "points" is reworded
 * instead — the currency word is configuration, and this screen has not read the
 * settings that hold it.
 *
 * Detail lives at `?id=`, in this same route: the queue's filters stay in the
 * URL while one return is open, so Back returns to the list somebody had rather
 * than to an unfiltered one (`ShopOrders`' argument, and HANDOFF §1.7's defect).
 */

export const PAGE_LIMIT = 50;
export const SEARCH_DEBOUNCE_MS = 250;

export const HOUR = 3_600_000;
/** Waiting bands. Text AND colour — `.mktage--warn` never says anything alone. */
export const WARN_MS = 48 * HOUR;
export const DANGER_MS = 96 * HOUR;

export const VIEWS: {
  key: ReturnsView;
  label: string;
  /** The real aggregate this tab stands for, out of the sidecar the list came with. */
  count: (c: ReturnCounts) => number;
}[] = [
  { key: 'needs_action', label: 'Needs action', count: (c) => c.needsAction },
  { key: 'requested', label: 'Requested', count: (c) => c.requested },
  { key: 'scheduled', label: 'Scheduled', count: (c) => c.scheduled },
  { key: 'collected', label: 'Picked up', count: (c) => c.collected },
  { key: 'received', label: 'To inspect', count: (c) => c.received },
  { key: 'done', label: 'Done', count: (c) => c.awarded + c.rejected + c.cancelled },
  {
    key: 'all',
    label: 'All',
    count: (c) =>
      c.requested + c.scheduled + c.collected + c.received + c.awarded + c.rejected + c.cancelled,
  },
];

export const EMPTY_COPY: Record<ReturnsView, { title: string; body: string }> = {
  needs_action: {
    title: 'Nothing is waiting on you',
    body: 'New requests and delivered returns land here. Everything else is moving without you.',
  },
  requested: {
    title: 'No requests are waiting for a date',
    body: 'Everything that has been asked for already has a pickup booked.',
  },
  scheduled: {
    title: 'No pickups are booked',
    body: 'Nothing is waiting for a driver right now.',
  },
  collected: {
    title: 'Nothing is out with a driver',
    body: 'Returns sit here between the pickup and the warehouse.',
  },
  received: {
    title: 'Nothing is waiting to be inspected',
    body: 'Returns arrive here once a driver has brought them in.',
  },
  done: {
    title: 'Nothing has been closed yet',
    body: 'Awarded, rejected and cancelled returns are kept here for good.',
  },
  all: {
    title: 'No return requests yet',
    body: 'Log one when a customer asks — the storefront form comes later.',
  },
};

/**
 * The copy for a `bad_request`, keyed by the field path the server named.
 *
 * The catalogue's treatment for a 400 is "inline, keyed by `detail`, focus the
 * field" — which needs a sentence per field, because "the qtyDeclared wasn't
 * accepted" is the server's word for a box labelled Quantity.
 */
export const FIELD_MESSAGE: Record<string, string> = {
  email: 'That doesn’t look like an email address.',
  qtyDeclared: 'Say how many are coming back.',
  qtyAccepted: 'That count wasn’t accepted.',
  qtyRejected: 'That count wasn’t accepted.',
  rejectedReason: 'Say why some were refused — the customer is told.',
  programId: 'That program can’t take this return.',
  customerName: 'That name wasn’t accepted.',
  customerPhone: 'That phone number wasn’t accepted.',
  pickupAddress: 'That address wasn’t accepted.',
  pickupAt: 'That date wasn’t accepted.',
  driverName: 'That name wasn’t accepted.',
  driverPhone: 'That phone number wasn’t accepted.',
  reason: 'That reason wasn’t accepted.',
  note: 'That note wasn’t accepted.',
};

export const fieldMessage = (field: string): string =>
  FIELD_MESSAGE[field] ?? 'That value wasn’t accepted.';

/** What a completed transition says. One per action, so none can fall through. */
export const DONE_MESSAGE: Record<StageAction, string> = {
  schedule: 'Pickup scheduled',
  collect: 'Marked as picked up',
  receive: 'Marked as received',
  reject: 'Request rejected',
  cancel: 'Return cancelled',
};

/**
 * What the quick-action dialog is called, for the same reason and in the same
 * shape as the message above.
 *
 * A map rather than the ternary chain this was, because the chain's last arm is
 * whatever is left over: this screen renders `allowedActions[0]` and does not
 * get to assume which action that is, so an order the server is entitled to
 * serve would have put "Mark as received" over a form that cancels a return.
 * The compiler now refuses a missing arm instead.
 */
export const DIALOG_TITLE: Record<StageAction, string> = {
  schedule: 'Schedule a pickup',
  collect: 'Mark as picked up',
  receive: 'Mark as received',
  reject: 'Reject this request',
  cancel: 'Cancel this return',
};

export const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** `?view=schedulled` is a typo, not an error screen. */
export function readView(params: URLSearchParams): ReturnsView {
  const raw = params.get('view');
  return VIEWS.some((v) => v.key === raw) ? (raw as ReturnsView) : 'needs_action';
}

/** The same params with the defaults dropped rather than written. */
export function withParams(
  base: URLSearchParams,
  patch: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || (key === 'view' && value === 'needs_action')) {
      next.delete(key);
    } else next.set(key, value);
  }
  return next;
}

export const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

/** "3h", "4d" — coarse on purpose: nobody schedules a driver by the minute. */
export function ago(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const CLOSED: ReturnStatus[] = ['awarded', 'rejected', 'cancelled'];
export const isClosed = (status: ReturnStatus): boolean => CLOSED.includes(status);

/**
 * The one action a row offers, or null for "there is nothing to advance".
 *
 * `note` counts as nothing: it is the only action a closed return allows, and a
 * queue button that added a note would be a write where the operator expected
 * to look at something.
 *
 * The RETURN TYPE says so as well as the body, and that is load-bearing: the
 * caller hands what is left — minus `inspect`, which navigates — straight to a
 * form that performs the five transitions, and `note` is not one of them. Typed
 * as the whole `ReturnAction`, the compiler could not tell the two apart and
 * the exhaustive things downstream stop being exhaustive.
 */
export function primaryOf(row: { allowedActions?: ReturnAction[] }): Exclude<ReturnAction, 'note'> | null {
  const first = row.allowedActions?.[0];
  return first === undefined || first === 'note' ? null : first;
}

/** A discretionary top-up decided in `ReturnModal`'s stepper, carried across the
 *  navigation to the full inspection screen. */
export interface BonusIntent {
  points: number;
  reason: string;
}

/**
 * Reads back what `ReturnModal`'s "Count what arrived…" wrote into `?bonus=` and
 * `?bonusWhy=` — see `ReturnsScreen.tsx`, the only place that writes them.
 *
 * THIS USED TO GO NOWHERE. Both params landed in the URL and nothing on the full
 * screen ever read them back: the bonus a person typed and clicked through was
 * silently dropped before a request naming it was ever built, for every role and
 * every return — the actual shape of "I set a bonus and nothing happened", which
 * had nothing to do with who was signed in or what status the return was in.
 *
 * MALFORMED INPUT READS AS "NO BONUS" RATHER THAN AS AN ERROR — a tampered link,
 * a `bonus` with no `bonusWhy` — because the inspection itself is legal without
 * one and a link this screen cannot fully honour should not block the write it
 * still can make.
 */
export function bonusFromParams(params: URLSearchParams): BonusIntent | null {
  const raw = params.get('bonus');
  if (raw === null) return null;
  const points = Number(raw);
  const reason = (params.get('bonusWhy') ?? '').trim();
  if (!Number.isInteger(points) || points < 1 || reason === '') return null;
  return { points, reason };
}

/** Everything after the primary that this screen can actually perform: the
 *  server's own list, minus the one already rendered, minus the two that are
 *  not a form here (`note` has its own composer, `inspect` its own panel). */
export const isStageAction = (action: ReturnAction): action is StageAction =>
  action !== 'note' && action !== 'inspect';

export function explainLoad(err: unknown, fallback = 'The queue didn’t load.'): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'This deployment has no returns route yet.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to read this.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return fallback;
}

/** A write's failures, minus the ones the catalogue says to render inline. */
export function explainWrite(err: unknown): string {
  if (err instanceof OfflineError) return 'The request didn’t reach the server.';
  if (err instanceof NotFoundError) return 'That return no longer exists.';
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account isn’t allowed to do that.';
    if (err.status === 429) return 'Too many changes too quickly — wait a moment and try again.';
    if (err.status >= 500) {
      return err.requestId === undefined
        ? 'Something went wrong on the server.'
        : `Something went wrong on the server — reference ${err.requestId}.`;
    }
  }
  return 'That didn’t go through.';
}

/** The 409 payloads carry the re-read entity; this is how to get at it safely. */
export function carriedRequest(err: unknown): ReturnRequest | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body === null || typeof body !== 'object') return null;
  const request = (body as { request?: unknown }).request;
  if (request === null || typeof request !== 'object') return null;
  const row = request as Partial<ReturnRequest>;
  return typeof row.id === 'string' && typeof row.status === 'string'
    ? (request as ReturnRequest)
    : null;
}

/**
 * A list row, brought up to date from a request the server handed back with a
 * 409.
 *
 * The row keeps its embedded program labels: a conflict payload carries the
 * REQUEST, not the program, and a row that lost its words would render "6
 * units" the moment somebody lost a race.
 */
export function healed(row: ReturnListItem, fresh: ReturnRequest): ReturnListItem {
  return {
    ...row,
    status: fresh.status,
    revision: fresh.revision,
    allowedActions: fresh.allowedActions,
    qtyDeclared: fresh.qtyDeclared,
    qtyAccepted: fresh.qtyAccepted,
    qtyRejected: fresh.qtyRejected,
    pointsAwarded: fresh.pointsAwarded,
    pickupScheduledAt: fresh.pickupScheduledAt,
    pickupAddress: fresh.pickupAddress,
    updatedAt: fresh.updatedAt,
  };
}


/** Which band a wait falls in. Closed rows are handed 0 — nothing is waiting. */
export function ageModifier(ms: number): string {
  if (ms >= DANGER_MS) return ' mktage--danger';
  if (ms >= WARN_MS) return ' mktage--warn';
  return '';
}
