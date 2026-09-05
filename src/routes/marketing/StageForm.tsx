import { useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  marketingApi,
  type ReturnAction,
  type ReturnRequest,
  type ReturnStatus,
} from '../../data/api-marketing';
import { safeFormat } from '../../data/when';
import '../marketing.css';

/**
 * The lifecycle's shared front end: the words a stage is described in, the form
 * that moves it, and the one place that knows which endpoint each move is.
 *
 * TWO SCREENS PERFORM THE SAME FIVE TRANSITIONS. The queue fires them from a
 * row, inside a dialog, one at a time; the detail panel renders the same fields
 * inline under "NEXT STEP". Written twice they drift immediately and invisibly —
 * the dialog would validate a pickup date the panel accepts, or the panel would
 * post `reason` where the dialog posts `note` — and the failure surfaces as a
 * 400 on somebody else's screen. So the fields, the client-side refusals and the
 * action→endpoint map live here, once, and the callers own only what they do
 * with the outcome (the queue regroups a row and toasts; the detail auto-heals
 * and keeps the operator's inputs).
 *
 * WHAT THIS COMPONENT DOES NOT DO: send anything. `submitStage` below is a
 * separate export for exactly that reason — the request is the caller's, because
 * the error catalogue's treatments differ per surface and a form that swallowed
 * its own 409 could not offer either of them.
 *
 * INSPECTION IS NOT HERE. It is a form with derived quantities, a live award
 * sentence and a confirmation that restates it, and it is never a quick action:
 * the queue navigates to `?id=…&act=inspect` instead. Folding it in would make
 * this component the union of two unrelated shapes.
 */

// ============================================================================
// THE WORDS
// ============================================================================

/**
 * What a stage is CALLED on screen, which is not what the wire calls it.
 *
 * `collected` reads as "Picked up" everywhere a person can see it (spec D4):
 * "collected" is warehouse-speak for a driver having the goods, and the person
 * reading the queue at 8am is asking "has it been picked up yet". The wire value
 * never changes — this map is the only place the two vocabularies meet.
 */
export const STATUS_LABEL: Record<ReturnStatus, string> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  collected: 'Picked up',
  received: 'Received',
  awarded: 'Awarded',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/**
 * The verb for each action the server may allow, used for the queue row's one
 * button AND for this form's submit.
 *
 * ONE MAP SO THE TWO CANNOT DISAGREE: a row whose button says "Mark picked up"
 * opening a dialog whose button says "Confirm collection" is two names for one
 * thing, and the second one is the one nobody recognises.
 *
 * `note` has a verb because `ReturnAction` includes it, not because the queue
 * renders it — a terminal row's only allowed action is a note, and the queue
 * shows a quiet "View" there instead (a row with nothing to advance should not
 * offer a button that writes).
 */
export const ACTION_VERB: Record<ReturnAction, string> = {
  schedule: 'Schedule pickup',
  collect: 'Mark picked up',
  receive: 'Mark received',
  inspect: 'Inspect',
  reject: 'Reject request',
  cancel: 'Cancel return',
  note: 'Add a note',
};

/** The heading a group of rows sits under: the stage, then what it is waiting for. */
export const GROUP_HEADING: Record<ReturnStatus, string> = {
  requested: 'Requested — schedule a pickup',
  scheduled: 'Scheduled — waiting for the driver',
  collected: 'Picked up — on its way in',
  received: 'Received — inspect and award',
  awarded: 'Awarded',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/**
 * The pipeline, in order, which is the order the queue groups by and the order
 * `.stagepath` walks. Terminal stages come last because that is where they end.
 */
export const PIPELINE: ReturnStatus[] = [
  'requested',
  'scheduled',
  'collected',
  'received',
  'awarded',
  'rejected',
  'cancelled',
];

// ============================================================================
// THE WIRE
// ============================================================================

/** The five moves that are a form. `inspect` is its own screen; `note` is not a transition. */
export type StageAction = 'schedule' | 'collect' | 'receive' | 'reject' | 'cancel';

/**
 * What a submitted form hands back: the action, and the exact body that
 * action's endpoint takes.
 *
 * A discriminated union rather than one loose bag of optional fields, so
 * `submitStage` can be exhaustive and a body that is missing `pickupAt` cannot
 * reach `/schedule` at all.
 */
export type StageSubmission =
  | { action: 'schedule'; body: { expectedRevision: number; pickupAt: number; driverName?: string; driverPhone?: string; pickupAddress?: string; note?: string } }
  | { action: 'collect'; body: { expectedRevision: number; note?: string } }
  | { action: 'receive'; body: { expectedRevision: number; note?: string } }
  | { action: 'reject'; body: { expectedRevision: number; reason?: string } }
  | { action: 'cancel'; body: { expectedRevision: number; reason?: string } };

/**
 * The action→endpoint map, in one switch both callers use.
 *
 * The alternative is each screen remembering that "mark picked up" is `/collect`
 * and "mark received" is `/receive` — two verbs one letter apart in meaning,
 * pointing at two different stages, where a transposition is not a type error
 * and answers `409 invalid_transition` rather than anything that reads as a bug.
 */
export function submitStage(id: string, submission: StageSubmission): Promise<ReturnRequest> {
  switch (submission.action) {
    case 'schedule':
      return marketingApi.schedule(id, submission.body);
    case 'collect':
      return marketingApi.collect(id, submission.body);
    case 'receive':
      return marketingApi.receive(id, submission.body);
    case 'reject':
      return marketingApi.reject(id, submission.body);
    case 'cancel':
      return marketingApi.cancel(id, submission.body);
  }
}

// ============================================================================
// THE FORM
// ============================================================================

/**
 * The part of a return this form needs. Both `ReturnListItem` and
 * `ReturnRequest` satisfy it, which is what lets the queue open the form from a
 * list row with no detail fetch — the contract puts `revision` and
 * `pickupAddress` on list items for exactly this.
 */
export interface StageTarget {
  id: string;
  status: ReturnStatus;
  revision: number;
  customerEmail: string;
  pickupAddress: string | null;
  pickupScheduledAt: number | null;
}

/**
 * A refusal, and the field it belongs under.
 *
 * `field: null` means the whole form — a state conflict, a 500. Everything else
 * names an input, because the error catalogue's treatment for `bad_request` is
 * "inline, keyed by `detail`, never a toast on its own", and `detail` is a
 * field path the server chose.
 */
export interface StageProblem {
  field: string | null;
  message: string;
}

/** `1786600000000` → `2026-08-13T06:46`, in the operator's own timezone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function StageForm({
  action,
  target,
  busy,
  problem,
  banner,
  formId,
  onSubmit,
  onCancel,
}: {
  action: StageAction;
  target: StageTarget;
  /** Disables the submit while the request is in flight. */
  busy: boolean;
  /** The caller's refusal — a server one. Client-side refusals are this form's own. */
  problem: StageProblem | null;
  /**
   * Names the `<form>` so a button OUTSIDE it can submit it (`form=` on the
   * button). The return detail's mobile action bar is fixed to the bottom of
   * the viewport and cannot be a descendant of the panel it acts on, and the
   * bar MIRRORS the inline submit rather than owning a second code path — one
   * `handleSubmit`, so the client-side refusals below run whichever button was
   * pressed. Omitted everywhere the form's own submit is the only one.
   */
  formId?: string;
  /**
   * Anything the caller must say ABOVE the fields: the stale-write conflict band
   * with its "Load theirs", the collected stage's note about when points are
   * computed. A slot rather than a prop per message, because every one of them
   * is the caller's sentence written in the caller's own labels.
   */
  banner?: ReactNode;
  onSubmit: (submission: StageSubmission) => void;
  /** Omitted when the form is inline in a panel there is already a way out of. */
  onCancel?: () => void;
}) {
  const uid = useId();
  const [pickupAt, setPickupAt] = useState(() =>
    target.pickupScheduledAt === null ? '' : toLocalInput(target.pickupScheduledAt),
  );
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [address, setAddress] = useState(target.pickupAddress ?? '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  /**
   * This form's own refusals, which outrank the caller's until the next attempt.
   * Cleared at the top of every submit, so a server problem is never hidden
   * behind a client one the operator has already fixed.
   */
  const [local, setLocal] = useState<StageProblem | null>(null);

  const shown = local ?? problem;
  const errorFor = (field: string): string | null =>
    shown !== null && shown.field === field ? shown.message : null;

  const danger = action === 'reject' || action === 'cancel';

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    setLocal(null);
    const expectedRevision = target.revision;

    if (action === 'schedule') {
      /*
       * `datetime-local` gives back a wall-clock string with no zone, which is
       * what the operator means — "Thursday at nine" is nine where the driver
       * is. `new Date(…)` on that string parses it as local time, and the wire
       * takes epoch-ms (spec: bigint epoch-ms, never a zoned string).
       */
      const at = pickupAt === '' ? Number.NaN : new Date(pickupAt).getTime();
      if (!Number.isFinite(at)) {
        setLocal({ field: 'pickupAt', message: 'Pick a date and time for the pickup.' });
        return;
      }
      if (at < Date.now()) {
        // Checked here as well as by the input's `min`, because `min` is advice
        // a keyboard can walk straight past and a paste ignores entirely.
        setLocal({ field: 'pickupAt', message: 'The pickup can’t be booked in the past.' });
        return;
      }
      const where = address.trim();
      if (where === '' && target.pickupAddress === null) {
        // The route refuses this too (#8: the address must exist on the row or
        // in the body). Refusing it here saves a round trip and puts the message
        // under the empty box rather than in a toast above it.
        setLocal({ field: 'pickupAddress', message: 'The driver needs an address to go to.' });
        return;
      }
      onSubmit({
        action: 'schedule',
        body: {
          expectedRevision,
          pickupAt: at,
          driverName: driverName.trim() || undefined,
          driverPhone: driverPhone.trim() || undefined,
          pickupAddress: where || undefined,
          note: note.trim() || undefined,
        },
      });
      return;
    }

    if (action === 'reject') {
      /* THE REASON IS OPTIONAL since 2026-09-03 (owner's instruction), and is
       * omitted rather than sent blank — the same shape 'cancel' below has
       * always used, and the one the route's `.min(1)` inside `.optional()`
       * expects. The label still says the customer is told. */
      onSubmit({ action: 'reject', body: { expectedRevision, reason: reason.trim() || undefined } });
      return;
    }

    if (action === 'cancel') {
      onSubmit({ action: 'cancel', body: { expectedRevision, reason: reason.trim() || undefined } });
      return;
    }

    onSubmit({ action, body: { expectedRevision, note: note.trim() || undefined } });
  }

  return (
    <form id={formId} className="mktform" onSubmit={handleSubmit} noValidate>
      {banner}

      {action === 'schedule' && (
        <>
          <div className="mktform__field">
            <label className="label" htmlFor={`${uid}-at`}>
              Pickup date and time
            </label>
            <input
              id={`${uid}-at`}
              className="input"
              type="datetime-local"
              value={pickupAt}
              min={toLocalInput(Date.now())}
              onChange={(e) => setPickupAt(e.target.value)}
            />
            {errorFor('pickupAt') ? (
              <p className="mktform__error">{errorFor('pickupAt')}</p>
            ) : (
              <p className="mktform__hint">
                {target.pickupScheduledAt === null
                  ? 'When the driver is going.'
                  : 'Moving the slot records a second pickup rather than editing the first.'}
              </p>
            )}
          </div>

          <div className="mktform__split">
            <div className="mktform__field">
              <label className="label" htmlFor={`${uid}-driver`}>
                Driver
              </label>
              <input
                id={`${uid}-driver`}
                className="input"
                value={driverName}
                maxLength={300}
                placeholder="Optional"
                onChange={(e) => setDriverName(e.target.value)}
              />
              {errorFor('driverName') && (
                <p className="mktform__error">{errorFor('driverName')}</p>
              )}
            </div>
            <div className="mktform__field">
              <label className="label" htmlFor={`${uid}-phone`}>
                Driver’s phone
              </label>
              <input
                id={`${uid}-phone`}
                className="input"
                value={driverPhone}
                maxLength={300}
                placeholder="Optional"
                onChange={(e) => setDriverPhone(e.target.value)}
              />
              {errorFor('driverPhone') && (
                <p className="mktform__error">{errorFor('driverPhone')}</p>
              )}
            </div>
          </div>

          <div className="mktform__field">
            <label className="label" htmlFor={`${uid}-address`}>
              Pickup address
            </label>
            <input
              id={`${uid}-address`}
              className="input"
              value={address}
              maxLength={2000}
              onChange={(e) => setAddress(e.target.value)}
            />
            {errorFor('pickupAddress') && (
              <p className="mktform__error">{errorFor('pickupAddress')}</p>
            )}
          </div>
        </>
      )}

      {(action === 'collect' || action === 'receive') && (
        <div className="mktkv">
          <span className="mktkv__k">Customer</span>
          <span className="mktkv__v">{target.customerEmail}</span>
          <span className="mktkv__k">Pickup</span>
          <span className="mktkv__v">
            {target.pickupScheduledAt === null
              ? 'No slot recorded'
              : safeFormat(WHEN, target.pickupScheduledAt)}
          </span>
          <span className="mktkv__k">Address</span>
          <span className="mktkv__v">{target.pickupAddress ?? 'None on the request'}</span>
        </div>
      )}

      {danger && (
        <div className="mktform__field">
          <label className="label" htmlFor={`${uid}-reason`}>
            {action === 'reject' ? 'Why it was refused (optional)' : 'Why it was called off'}
          </label>
          <textarea
            id={`${uid}-reason`}
            className="input"
            rows={3}
            value={reason}
            maxLength={2000}
            placeholder={
              action === 'reject' ? 'Told to the customer, if you give one' : 'Optional'
            }
            onChange={(e) => setReason(e.target.value)}
          />
          {errorFor('reason') && <p className="mktform__error">{errorFor('reason')}</p>}
        </div>
      )}

      {action !== 'reject' && (
        <div className="mktform__field">
          <label className="label" htmlFor={`${uid}-note`}>
            Note
          </label>
          <textarea
            id={`${uid}-note`}
            className="input"
            rows={2}
            value={note}
            maxLength={2000}
            placeholder="Optional — kept on the timeline"
            onChange={(e) => setNote(e.target.value)}
          />
          {errorFor('note') && <p className="mktform__error">{errorFor('note')}</p>}
        </div>
      )}

      {shown !== null && shown.field === null && (
        <p className="mktform__error" role="alert">
          {shown.message}
        </p>
      )}

      <div className="mktform__actions">
        <button
          type="submit"
          className={danger ? 'btn btn--danger' : 'btn btn--primary'}
          disabled={busy}
        >
          {ACTION_VERB[action]}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            {/* "Cancel" beside "Cancel return" is two meanings for one word, and
                the destructive one is the one that would get clicked. */}
            {danger ? 'Never mind' : 'Cancel'}
          </button>
        )}
      </div>
    </form>
  );
}
