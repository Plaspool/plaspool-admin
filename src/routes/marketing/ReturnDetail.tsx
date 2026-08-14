import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Award,
  Ban,
  Calendar,
  Inbox,
  MessageSquare,
  PackageCheck,
  RotateCcw,
  Truck,
  XCircle,
} from 'lucide-react';
import {
  awardSentence,
  fmtPoints,
  fmtUnits,
  labelsOf,
  marketingApi,
  type EmailIntentState,
  type InspectDraft,
  type ProgramLabels,
  type ReturnAction,
  type ReturnDetail as ReturnDetailPayload,
  type ReturnEvent,
  type ReturnRequest,
  type ReturnStatus,
} from '../../data/api-marketing';
import { ApiError, NotFoundError, StaleWriteError } from '../../data/errors';
import { useToast } from '../../components/Toast';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { QtyStepper } from '../../components/QtyStepper';
import { Select } from '../../components/ui/Select';
import { Skeleton } from '../../components/ui/Feedback';
import { useDelayed } from '../../components/ui/useDelayed';
import {
  ACTION_VERB,
  STATUS_LABEL,
  StageForm,
  submitStage,
  type StageAction,
  type StageProblem,
  type StageSubmission,
} from './StageForm';
import { DONE_MESSAGE, WHEN, fieldMessage, asSearch, isStageAction, withParams, primaryOf, explainLoad, explainWrite, carriedRequest } from './queue-shared';


/**
 * ONE RETURN, AND THE ONE THING TO DO WITH IT NEXT.
 *
 * The screen is built around a single claim: at any moment there is exactly one
 * legal next step, the SERVER says what it is (`allowedActions`, ordered — spec
 * D4), and this screen renders the form for it and nothing else. Everything is
 * arranged around that: the stage path above says where the return is, the
 * details beside it say what it is, the timeline says how it got here.
 *
 * INSPECTION IS THE WRITE THIS SCREEN EXISTS FOR — the only action that creates
 * value, in one server statement that moves the status, awards the points,
 * writes the ledger row and queues the customer's mail. So it is the one stage
 * whose panel is not `StageForm`: staff type Received and Accepted, and
 * REJECTED IS DERIVED AND NEVER TYPED (spec D5 — with no third box there is
 * nothing for the numbers to disagree with, so the classic "these don't add up"
 * refusal cannot happen). The sentence under the boxes is `awardSentence()` from
 * `shared/marketing/copy.ts`: the SAME string the confirmation restates, the
 * toast repeats, the timeline keeps and the customer's email carries. One
 * source, so a dispute reads identically from whichever surface it is quoted.
 *
 * GUARD ERRORS HEAL RATHER THAN SCOLD. Every 409 here carries the re-read
 * entity, so "somebody else got there first" is answered by re-rendering the
 * true stage from the payload — no second fetch, and, crucially, WITHOUT wiping
 * a half-counted inspection. An operator who counted six canisters must not have
 * to count them again over a race they did not cause, so the panel freezes on
 * the form that lost and the band above it says what actually happened.
 *
 * HISTORY IS READ IN ITS OWN WORDS. The `inspected` event carries the four label
 * values as they were written; the timeline formats through THOSE and never
 * through the program's current ones. A rename changes the future — it may not
 * rewrite what a customer was already told.
 */

/** The five dots. The two terminal branches are not step six — they replace the
 *  path with a band, because rejected is a different ending, not a later one. */
const STAGE_PATH: ReturnStatus[] = ['requested', 'scheduled', 'collected', 'received', 'awarded'];

/**
 * What a SECONDARY action is called, which is not always its verb: `schedule`
 * offered by a return that already has a slot is a RE-schedule, and the server
 * serves exactly that (`scheduled → scheduled` is legal and emits a second
 * event, spec D4). The ellipsis is the house signal that a dialog follows.
 */
const SECONDARY_LABEL: Record<StageAction, string> = {
  schedule: 'Reschedule…',
  collect: 'Mark picked up…',
  receive: 'Mark received…',
  reject: 'Reject request…',
  cancel: 'Cancel return…',
};

/** A mark per kind, because a long timeline is skimmed rather than read. */
const EVENT_ICON: Record<ReturnEvent['type'], ComponentType<{ className?: string }>> = {
  requested: Inbox,
  scheduled: Calendar,
  collected: Truck,
  received: PackageCheck,
  inspected: Award,
  rejected: XCircle,
  cancelled: Ban,
  note: MessageSquare,
};

const EVENT_WHAT: Record<ReturnEvent['type'], string> = {
  requested: 'Return requested',
  scheduled: 'Pickup scheduled',
  collected: 'Picked up by the driver',
  received: 'Received at the warehouse',
  inspected: 'Inspected',
  rejected: 'Request rejected',
  cancelled: 'Return cancelled',
  note: 'Note added',
};

const MAIL_WHAT: Record<string, string> = {
  return_awarded: 'Award notification',
  return_rejected: 'Rejection notification',
};

/**
 * Why some of what arrived was refused.
 *
 * The LABEL is what gets stored, not a code. `rejectedReason` is render-final at
 * write time (spec D2d) — read back verbatim on the timeline, in the ledger and
 * in the customer's email — so a `not_ours` would have to be translated again by
 * every one of those, and would go stale the first time this list was reworded.
 */
const REJECT_REASONS = ['Damaged', 'Not ours', 'Contaminated', 'Other'];

/**
 * "Nothing picked yet" is an OPTION rather than an empty value, because Radix
 * treats `''` as "no selection" and refuses it as an item's value outright — so
 * the unchosen state needs a value of its own or the control comes up blank with
 * nothing to name it. It is also the honest shape: a reason is required once
 * anything has been refused, and a picker that opened on "Damaged" would let an
 * inspection assert damage nobody looked for.
 */
const UNCHOSEN = 'unchosen';

const REJECT_OPTIONS = [
  { value: UNCHOSEN, label: 'Pick a reason…' },
  ...REJECT_REASONS.map((reason) => ({ value: reason, label: reason })),
];

/** One id, so the mobile bar's button can submit the panel's own form. */
const ACTION_FORM_ID = 'mkt-stage-form';

const isTerminal = (status: ReturnStatus): boolean =>
  status === 'rejected' || status === 'cancelled';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The labels an event was written under, or null when it carried none.
 *
 * The `inspected` event's data holds the four label values AS WRITTEN beside the
 * quantities (spec D5). Formatting that row through the program's CURRENT words
 * is the rename-rewrites-the-past bug the snapshot rule exists to prevent, and
 * it stays invisible until somebody renames a program — which is a thing this
 * section invites them to do on their first day.
 */
function snapshotLabels(data: Record<string, unknown> | null): ProgramLabels | null {
  if (data === null) return null;
  const one = text(data.pointsLabelSingular);
  const other = text(data.pointsLabelPlural);
  if (one === null || other === null) return null;
  const unitOne = text(data.unitLabelSingular);
  const unitOther = text(data.unitLabelPlural);
  return {
    name: '',
    points: { one, other },
    unit: unitOne !== null && unitOther !== null ? { one: unitOne, other: unitOther } : null,
  };
}

/**
 * The line under a timeline entry's heading, in whichever words that entry owns.
 *
 * `labels` is the FALLBACK, not the source: only `inspected` carries a snapshot,
 * and everything else is a structural fact — a date, a driver, a reason somebody
 * typed — that no rename touches.
 */
function eventLine(event: ReturnEvent, labels: ProgramLabels): string | null {
  const data = event.data;
  if (data === null) return null;

  if (event.type === 'inspected') {
    const accepted = num(data.qtyAccepted);
    const rejected = num(data.qtyRejected);
    const points = num(data.pointsAwarded);
    if (accepted === null || rejected === null || points === null) return null;
    const said = snapshotLabels(data) ?? labels;
    return accepted === 0
      ? `Nothing accepted — ${fmtUnits(rejected, said)} refused`
      : `${fmtUnits(accepted, said)} accepted · ${rejected} rejected · ${fmtPoints(points, said)} awarded`;
  }

  const reason = text(data.reason);
  if (reason !== null) return reason;

  if (event.type === 'scheduled') {
    const at = num(data.pickupAt);
    const driver = text(data.driverName);
    const parts = [
      at === null ? null : WHEN.format(new Date(at)),
      driver === null ? null : `driver ${driver}`,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join(' · ');
  }

  if (event.type === 'requested') {
    const qty = num(data.qtyDeclared);
    return qty === null ? null : `${fmtUnits(qty, labels)} declared`;
  }

  return null;
}

/**
 * What a queued notification is honestly allowed to claim.
 *
 * NOTHING SCHEDULES THE SWEEP — both of the deployment's daily slots are spent —
 * so an intent with no `sentAt` is the NORMAL state seconds after an inspection,
 * and "sending…" would describe a process that is not running. "Handed to the
 * mailer" rather than "sent" is `ShopOrders`' distinction, held here for its
 * reason: the row is proof of a hand-off, never of a delivery.
 */
function mailLine(intent: EmailIntentState): string {
  if (intent.sentAt !== null) {
    return `Handed to the mailer ${WHEN.format(new Date(intent.sentAt))}`;
  }
  if (intent.attempts > 0) {
    return `${intent.attempts} failed ${intent.attempts === 1 ? 'attempt' : 'attempts'} — still queued`;
  }
  return 'Queued — sends with the next sweep';
}

/** What is being counted, while it is being counted. */
interface Counting {
  received: number;
  accepted: number;
  /** One of `REJECT_REASONS`, or `UNCHOSEN` before anything has been picked. */
  reason: string;
  note: string;
}

/**
 * The reason as it will be STORED, read back and mailed: the chosen heading plus
 * whatever was typed beside it, in one string. `rejectedReason` is a sentence a
 * customer reads, not a code and a note for each surface to reassemble its own
 * way — and it is written once, at inspection, never re-rendered.
 */
function rejectionText(counting: Counting): string {
  const said = counting.note.trim();
  return said === '' ? counting.reason : `${counting.reason} — ${said}`;
}

/**
 * A write that lost, and the form it lost from.
 *
 * `action` is what the PANEL's own form was doing, or null when the write came
 * from a secondary dialog — and that difference decides the treatment. A dialog
 * keeps its inputs by simply staying open; the panel would re-key to the
 * return's new stage and throw a half-counted inspection away. So while a
 * `moved` conflict from the panel is showing, the panel stays frozen on
 * `action` with the band above it saying where the return actually went.
 */
interface Conflict {
  kind: 'moved' | 'stale';
  action: Exclude<ReturnAction, 'note'> | null;
  fresh: ReturnRequest;
}

export function ReturnDetail({ id }: { id: string }) {
  const [params] = useSearchParams();
  const { notify } = useToast();

  const [detail, setDetail] = useState<ReturnDetailPayload | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const showSkeletons = useDelayed(loading);

  const [busy, setBusy] = useState(false);
  const [stageProblem, setStageProblem] = useState<StageProblem | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /**
   * The 501 the sweep answered with. A banner for the rest of the visit and
   * NEVER a retry: the intents stay queued, the Overview counts them, and a
   * client that re-asked would only produce the same 501 on a loop.
   */
  const [mailUnconfigured, setMailUnconfigured] = useState(false);

  /*
   * Both dialogs carry `seq` so a re-open REMOUNTS them — the queue's argument:
   * a form that came back holding the last attempt's answers is worse than one
   * that comes back empty. `open` is separate from the contents so a close still
   * has something to animate, and each is absent from the DOM until it has been
   * opened once: a confirmation restating an award that nobody is making is a
   * sentence in the accessibility tree claiming something untrue.
   */
  const [secondary, setSecondary] = useState<
    { action: StageAction; open: boolean; seq: number } | null
  >(null);
  const [confirming, setConfirming] = useState<{ open: boolean; seq: number } | null>(null);

  const [counted, setCounted] = useState<Counting | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noting, setNoting] = useState(false);

  const actionRef = useRef<HTMLElement>(null);
  /** The deep link aims the cursor ONCE. A refetch must not steal it back. */
  const aimed = useRef(false);

  const backTo = {
    pathname: '/marketing/returns',
    search: asSearch(withParams(params, { id: null, act: null })),
  };

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return marketingApi
        .getReturn(id, signal)
        .then((next) => {
          if (signal?.aborted) return;
          setDetail(next);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          // The catalogue's `gone` is permanent: an `.empty` and a way back,
          // never a Try again that cannot succeed.
          if (err instanceof NotFoundError) setGone(true);
          else setProblem(explainLoad(err, 'This return didn’t load.'));
          setLoading(false);
        });
    },
    [id],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const request = detail?.request ?? null;
  const declared = request?.qtyDeclared ?? 0;

  /*
   * DERIVED UNTIL SOMEBODY COUNTS, then held. Received starts at what the
   * customer said they were sending — usually right, and a warehouse should not
   * have to retype it — and once anything has been typed, every later refetch
   * (including the one after a lost race) keeps it. A `useEffect` that seeded
   * state instead would render one frame of a form with no numbers in it.
   */
  const counting: Counting = counted ?? {
    received: declared,
    accepted: declared,
    reason: UNCHOSEN,
    note: '',
  };

  const wantsInspect = params.get('act') === 'inspect';
  useEffect(() => {
    if (!wantsInspect || aimed.current || request === null) return;
    const panel = actionRef.current;
    if (panel === null) return;
    aimed.current = true;
    panel.scrollIntoView({ block: 'center' });
    // By its accessible name rather than an id: `QtyStepper` names its own input
    // from `label`, and a second id here would be a second thing to keep in step.
    panel.querySelector<HTMLInputElement>('input[aria-label="Received"]')?.focus();
  }, [wantsInspect, request]);

  // --------------------------------------------------------------- derived
  const labels = detail === null ? null : labelsOf(detail.program);
  const primary = request === null ? null : primaryOf(request);
  const secondaries = (request?.allowedActions ?? []).slice(1).filter(isStageAction);

  const panelConflict = conflict !== null && conflict.action !== null ? conflict : null;
  const dialogConflict = conflict !== null && conflict.action === null ? conflict : null;
  /** Frozen: the panel keeps drawing the form that lost, so its entries survive. */
  const frozen = panelConflict !== null && panelConflict.kind === 'moved';
  const panelAction = frozen ? panelConflict.action : primary;

  const rejected = Math.max(0, counting.received - counting.accepted);
  const points = request === null ? 0 : counting.accepted * request.pointsPerUnitSnapshot;
  /**
   * THE SENTENCE THAT TRAVELS. Priced from `pointsPerUnitSnapshot` — the rate
   * frozen onto the request when it was made — and never from the program's
   * current one: repricing a program may not change what a customer was already
   * promised (spec D4), and this line is that promise read back to them.
   */
  const sentence =
    request === null || labels === null
      ? ''
      : awardSentence(
          labels,
          counting.accepted,
          request.pointsPerUnitSnapshot,
          request.customerEmail,
        );
  const inspectLabel =
    counting.accepted > 0 && labels !== null
      ? `Record & award ${fmtPoints(points, labels)}`
      : 'Record — nothing to award';

  /** Refused here rather than by the server: both boxes are on screen together,
   *  so the contradiction between them is visible as it is created. */
  const localProblem: StageProblem | null =
    counting.accepted > counting.received
      ? { field: 'qtyAccepted', message: 'Accepted can’t be more than received.' }
      : null;

  const dialogOpen = (secondary !== null && secondary.open) || (confirming?.open ?? false);
  /** The bar carries the stage's primary and nothing else — and unrenders while
   *  a dialog owns the screen, and on a stage with nothing left to do. */
  const bar = primary !== null && !dialogOpen && !frozen ? primary : null;

  // ---------------------------------------------------------------- writes
  /**
   * The sweep nothing schedules.
   *
   * Fire-and-forget by design (spec D6): the customer's mail leaves on the back
   * of the admin's own click, and a failure here is NOT a failure of the
   * inspection that already landed. So nothing is awaited, nothing is retried,
   * and the one answer a person can act on is the only one surfaced.
   */
  function sweepQuietly(): void {
    if (mailUnconfigured) return;
    void marketingApi.sweep().catch((err: unknown) => {
      if (err instanceof ApiError && err.code === 'mail_not_configured') {
        setMailUnconfigured(true);
      }
    });
  }

  function adopt(fresh: ReturnRequest): void {
    setDetail((prev) => (prev === null ? prev : { ...prev, request: fresh }));
  }

  /**
   * Every write's failures in one place, because the catalogue's treatments are
   * per-CODE and not per-endpoint. `from` is the panel's action when the panel
   * raised it and null when a dialog did — see `Conflict`.
   */
  function absorb(
    err: unknown,
    from: Exclude<ReturnAction, 'note'> | null,
    retry: () => void,
  ): void {
    const fresh = carriedRequest(err);

    if (err instanceof StaleWriteError && fresh !== null) {
      // A lost CAS, not an illegal move: the entries are still valid against the
      // revision the band offers, so nothing is adopted until it is asked for.
      setConflict({ kind: 'stale', action: from, fresh });
    } else if (err instanceof ApiError && err.code === 'invalid_transition' && fresh !== null) {
      adopt(fresh);
      setConflict({ kind: 'moved', action: from, fresh });
      notify(`That return is now ${STATUS_LABEL[fresh.status]}.`, { tone: 'danger' });
    } else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined) {
      setStageProblem({ field: err.detail, message: fieldMessage(err.detail) });
    } else if (err instanceof NotFoundError) {
      setGone(true);
    } else {
      notify(explainWrite(err), { tone: 'danger', action: { label: 'Try again', run: retry } });
    }
  }

  async function runStage(
    submission: StageSubmission,
    from: Exclude<ReturnAction, 'note'> | null,
  ): Promise<void> {
    if (request === null) return;
    setBusy(true);
    setStageProblem(null);
    setConflict(null);
    try {
      await submitStage(request.id, submission);
      notify(DONE_MESSAGE[submission.action]);
      setSecondary((prev) => (prev === null ? null : { ...prev, open: false }));
      // A refusal owes the customer a letter, and this is the click that sends it.
      if (submission.action === 'reject') sweepQuietly();
      await load();
    } catch (err) {
      absorb(err, from, () => void runStage(submission, from));
    } finally {
      // In a `finally` because the success path needs it too — see the queue's
      // note: left set, the next form opens with its submit already disabled.
      setBusy(false);
    }
  }

  async function runInspect(): Promise<void> {
    if (request === null) return;
    const draft: InspectDraft = {
      expectedRevision: request.revision,
      qtyAccepted: counting.accepted,
      // Derived, never typed — see the header note and spec D5.
      qtyRejected: rejected,
      rejectedReason: rejected > 0 ? rejectionText(counting) : undefined,
      note: counting.note.trim() || undefined,
    };
    const said = sentence;
    setBusy(true);
    setStageProblem(null);
    setConflict(null);
    try {
      await marketingApi.inspect(request.id, draft);
      notify(`Recorded — ${said}`);
      sweepQuietly();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_awarded') {
        /*
         * SUCCESS, NOT A CONFLICT. It means the first attempt landed and its
         * answer was lost on the way back — exactly what a dropped warehouse
         * connection produces. Treated as anything else, a retry would tell an
         * operator their inspection failed while the customer's points were
         * already in the ledger.
         *
         * AND IT SWEEPS, for the same reason. The attempt that landed inserted
         * the customer's mail intent and then lost its answer — so it is
         * precisely the attempt whose fire-and-forget never fired. Nothing
         * schedules the sweep (spec D6), so skipping it here is how a letter
         * ends up queued for good over a dropped connection.
         */
        notify('That inspection was already recorded.');
        sweepQuietly();
        await load();
        return;
      }
      absorb(err, 'inspect', () => void runInspect());
    } finally {
      setBusy(false);
    }
  }

  function submitInspection(): void {
    // The live refusal is already under the box; a confirmation on top of it
    // would be a dialog about numbers the form has said it will not take.
    if (localProblem !== null) return;
    if (rejected > 0 && counting.reason === UNCHOSEN) {
      setStageProblem({
        field: 'rejectedReason',
        message: 'Pick a reason for the ones being refused.',
      });
      return;
    }
    setStageProblem(null);
    setConfirming((prev) => ({ open: true, seq: (prev?.seq ?? 0) + 1 }));
  }

  async function addNote(): Promise<void> {
    const said = noteDraft.trim();
    if (said === '' || request === null) return;
    setNoting(true);
    try {
      const event = await marketingApi.addNote(request.id, said);
      // Appended rather than refetched: the response IS the event, and a note
      // bumps nothing else on the return (spec D4).
      setDetail((prev) => (prev === null ? prev : { ...prev, events: [...prev.events, event] }));
      setNoteDraft('');
    } catch (err) {
      notify(explainWrite(err), { tone: 'danger' });
    } finally {
      setNoting(false);
    }
  }

  const closeSecondary = (): void =>
    setSecondary((prev) => (prev === null ? null : { ...prev, open: false }));

  const resolveConflict = (): void => {
    if (conflict === null) return;
    // No second fetch — the 409 carried the whole entity.
    adopt(conflict.fresh);
    setConflict(null);
  };

  // ----------------------------------------------------------------- views
  if (gone) {
    return (
      <div className="mktscr">
        <div className="mktscr__body">
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <RotateCcw />
            </div>
            <h2 className="empty__title">That return no longer exists</h2>
            <p className="empty__body">
              It may have been opened from a stale link, or removed since the queue was loaded.
            </p>
            <Link className="btn btn--outline" to={backTo}>
              Back to the queue
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (detail === null || request === null || labels === null) {
    return (
      <div className="mktscr">
        <header className="mktscr__head">
          <Link className="btn btn--ghost btn--sm" to={backTo}>
            <ArrowLeft className="ui-ic" aria-hidden="true" />
            Back to the queue
          </Link>
        </header>
        <div className="mktscr__body">
          {problem !== null ? (
            <div className="notice notice--danger" role="alert">
              <div>{problem}</div>
              <div className="notice__actions">
                <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            </div>
          ) : showSkeletons ? (
            <div className="mktpanel" aria-hidden="true">
              <div className="mktpanel__body">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} height={18} width={`${92 - i * 8}%`} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const status = request.status;
  const step = STAGE_PATH.indexOf(status);
  const queued = detail.emailIntents.filter((intent) => intent.sentAt === null).length;
  /** An award is history the moment it exists, so it is read in the words it was
   *  written in; the program's current ones are the fallback, not the source. */
  const awardLabels =
    snapshotLabels(detail.events.find((e) => e.type === 'inspected')?.data ?? null) ?? labels;
  const customerTo = `/marketing/customers?email=${encodeURIComponent(request.customerEmail)}`;

  return (
    <div className={`mktscr${bar === null ? '' : ' mktscr--barred'}`}>
      <header className="mktscr__head">
        {/* The queue's filters are still in the URL, so this goes back to the
            list somebody had rather than to an unfiltered one. */}
        <Link className="btn btn--ghost btn--sm" to={backTo}>
          <ArrowLeft className="ui-ic" aria-hidden="true" />
          Back to the queue
        </Link>

        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Return</h1>
            <p className="mktscr__lede">
              <Link className="mkttable__link" to={customerTo}>
                {request.customerEmail}
              </Link>{' '}
              · <span className="mktnum">{request.id}</span> · logged{' '}
              {WHEN.format(new Date(request.createdAt))}
            </p>
          </div>
          <span className={`chip mktchip--${status}`}>{STATUS_LABEL[status]}</span>
        </div>

        {isTerminal(status) ? (
          /* A terminal branch is not a sixth dot: the path would have to draw a
             fork it never walks again, so the band states the ending instead. */
          <div
            className={`notice ${status === 'rejected' ? 'notice--danger' : 'notice--warn'}`}
            role="status"
          >
            <div>
              <strong>{STATUS_LABEL[status]}</strong>
              {(request.rejectedReason ?? request.cancelReason) !== null &&
                ` — ${request.rejectedReason ?? request.cancelReason}`}
              {request.closedAt !== null && ` · ${WHEN.format(new Date(request.closedAt))}`}
            </div>
          </div>
        ) : (
          <>
            <p className="stagepath__count">
              Step {step + 1} of {STAGE_PATH.length} — {STATUS_LABEL[status]}
            </p>
            <ol className="stagepath">
              {STAGE_PATH.map((stage, i) => (
                <li
                  key={stage}
                  className={`stagepath__step${i < step ? ' is-done' : i === step ? ' is-current' : ''}`}
                  aria-current={i === step ? 'step' : undefined}
                >
                  <span className="stagepath__dot" aria-hidden="true" />
                  <span className="stagepath__label">{STATUS_LABEL[stage]}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </header>

      <div className="mktscr__body">
        {problem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>{problem}</div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {mailUnconfigured && (
          <div className="notice notice--warn" role="status">
            <div>
              <strong>Email transport isn’t configured</strong> — {queued} notification
              {queued === 1 ? '' : 's'} for this return {queued === 1 ? 'is' : 'are'} queued and
              will send once it is. Nothing was lost.
            </div>
          </div>
        )}

        <div className="mktgrid mktgrid--detail">
          {/* Details FIRST in the DOM, because on a phone this is one column and
              the thumb wants to know what it is looking at before what to do
              about it. Above 900px the stylesheet puts the action panel
              top-left; see `.mktgrid--detail`. */}
          <section className="mktpanel mktdetail--ref">
            <div className="mktpanel__head">
              <h2 className="mktpanel__title">Details</h2>
            </div>
            <div className="mktpanel__body">
              <div className="mktkv">
                <span className="mktkv__k">Customer</span>
                <span className="mktkv__v">{request.customerName ?? request.customerEmail}</span>
                {request.customerPhone !== null && (
                  <>
                    <span className="mktkv__k">Phone</span>
                    <span className="mktkv__v">{request.customerPhone}</span>
                  </>
                )}
                <span className="mktkv__k">Declared</span>
                <span className="mktkv__v">{fmtUnits(request.qtyDeclared, labels)}</span>
                {request.qtyAccepted !== null && (
                  <>
                    <span className="mktkv__k">Counted</span>
                    <span className="mktkv__v">
                      {fmtUnits(request.qtyAccepted, awardLabels)} accepted ·{' '}
                      {request.qtyRejected ?? 0} rejected
                    </span>
                  </>
                )}
                <span className="mktkv__k">Program</span>
                <span className="mktkv__v">{detail.program.name}</span>
                <span className="mktkv__rule" />
                <span className="mktkv__k">Pickup address</span>
                <span className="mktkv__v">{request.pickupAddress ?? 'None on the request'}</span>
                {request.pickupScheduledAt !== null && (
                  <>
                    <span className="mktkv__k">Pickup booked</span>
                    <span className="mktkv__v">
                      {WHEN.format(new Date(request.pickupScheduledAt))}
                      {request.driverName !== null && ` · ${request.driverName}`}
                    </span>
                  </>
                )}
                {request.receivedAt !== null && (
                  <>
                    <span className="mktkv__k">Received</span>
                    <span className="mktkv__v">{WHEN.format(new Date(request.receivedAt))}</span>
                  </>
                )}
                <span className="mktkv__rule" />
                <span className="mktkv__k">Return id</span>
                <span className="mktkv__v mktkv__v--id">{request.id}</span>
                {request.customerId !== null && (
                  <>
                    <span className="mktkv__k">Customer id</span>
                    <span className="mktkv__v mktkv__v--id">{request.customerId}</span>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="mktpanel mktdetail--act" ref={actionRef}>
            <div className="mktpanel__head">
              <h2 className="mktpanel__title">
                {primary === null ? (status === 'awarded' ? 'Awarded' : 'Closed') : 'Next step'}
              </h2>
            </div>
            <div className="mktpanel__body">
              {panelConflict !== null && (
                <ConflictBand conflict={panelConflict} onResolve={resolveConflict} />
              )}

              {panelAction === 'inspect' ? (
                <InspectionForm
                  formId={ACTION_FORM_ID}
                  request={request}
                  labels={labels}
                  value={counting}
                  onChange={setCounted}
                  rejected={rejected}
                  sentence={sentence}
                  primaryLabel={inspectLabel}
                  problem={localProblem ?? stageProblem}
                  busy={busy || frozen}
                  onSubmit={submitInspection}
                />
              ) : panelAction !== null ? (
                <StageForm
                  key={panelAction}
                  formId={ACTION_FORM_ID}
                  action={panelAction}
                  target={request}
                  busy={busy || frozen}
                  problem={stageProblem}
                  banner={
                    panelAction === 'receive' ? (
                      /* Never the bare word "points" — the currency word is
                         configuration, and this panel is holding the program's
                         own copy of it. */
                      <p className="mktpanel__note">
                        {detail.program.pointsLabelPlural} are computed at inspection, from what is
                        actually accepted.
                      </p>
                    ) : null
                  }
                  onSubmit={(submission) => void runStage(submission, panelAction)}
                />
              ) : status === 'awarded' ? (
                <>
                  <p className="mktmath">
                    {fmtUnits(request.qtyAccepted ?? 0, awardLabels)} accepted ·{' '}
                    {fmtPoints(request.pointsAwarded ?? 0, awardLabels)} awarded
                  </p>
                  <p className="mktform__hint">
                    <Link className="mkttable__link" to={customerTo}>
                      View the ledger entry →
                    </Link>
                  </p>
                </>
              ) : (
                <p className="mktpanel__note">
                  Nothing is left to do. Notes can still be added — a closed return keeps its
                  history for good.
                </p>
              )}

              {/* The panel offers ONLY what the server says is legal (spec D4).
                  There is no status→action map on this screen to drift out of
                  step with the state machine. */}
              {secondaries.length > 0 && !frozen && (
                <div className="mktform__actions">
                  {secondaries.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={
                        action === 'reject' || action === 'cancel'
                          ? 'btn btn--ghost'
                          : 'btn btn--outline'
                      }
                      onClick={() => {
                        setStageProblem(null);
                        setConflict(null);
                        setSecondary((prev) => ({ action, open: true, seq: (prev?.seq ?? 0) + 1 }));
                      }}
                    >
                      {SECONDARY_LABEL[action]}
                    </button>
                  ))}
                </div>
              )}

              {detail.emailIntents.map((intent) => (
                <div className="mktmail" key={intent.kind}>
                  <span>{MAIL_WHAT[intent.kind] ?? intent.kind}</span>
                  <span className="mktmail__meta">{mailLine(intent)}</span>
                  {intent.lastError !== null && (
                    <span className="mktmail__err">{intent.lastError}</span>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="mktpanel mktdetail--log">
            <div className="mktpanel__head">
              <h2 className="mktpanel__title">Timeline</h2>
            </div>
            <div className="mktpanel__body">
              <form
                className="mktform"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addNote();
                }}
              >
                <div className="mktform__field">
                  <label className="label" htmlFor="mkt-note">
                    Add a note
                  </label>
                  <textarea
                    id="mkt-note"
                    className="input"
                    rows={2}
                    value={noteDraft}
                    maxLength={2000}
                    placeholder="Kept with the return. Nothing else changes."
                    onChange={(e) => setNoteDraft(e.target.value)}
                  />
                </div>
                <div className="mktform__actions">
                  <button
                    type="submit"
                    className="btn btn--outline btn--sm"
                    disabled={noting || noteDraft.trim() === ''}
                  >
                    Add note
                  </button>
                </div>
              </form>

              <ul className="mkttimeline">
                {/* Newest first, over a list the server sends oldest-first. */}
                {[...detail.events].reverse().map((event) => {
                  const Icon = EVENT_ICON[event.type];
                  const line = eventLine(event, labels);
                  const tone =
                    event.type === 'inspected' && (num(event.data?.pointsAwarded) ?? 0) > 0
                      ? ' mkttimeline__item--award'
                      : event.type === 'rejected' || event.type === 'cancelled'
                        ? ' mkttimeline__item--closed'
                        : '';
                  return (
                    <li className={`mkttimeline__item${tone}`} key={event.id}>
                      <span className="mkttimeline__icon">
                        <Icon className="ui-ic" aria-hidden="true" />
                      </span>
                      <span className="mkttimeline__what">{EVENT_WHAT[event.type]}</span>
                      {line !== null && <span className="mkttimeline__note">{line}</span>}
                      {event.note !== null && (
                        <span className="mkttimeline__note">{event.note}</span>
                      )}
                      <span className="mkttimeline__when">
                        {WHEN.format(new Date(event.occurredAt))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        </div>
      </div>

      {/* MIRRORS the inline submit, never replaces it: `form=` posts the panel's
          own form, so the same client-side refusals run whichever button was
          pressed — and the flow still works while a phone keyboard covers this
          bar. Unrendered on a terminal stage and while a dialog owns the screen. */}
      {bar !== null && (
        <div className="mktbar">
          <button type="submit" form={ACTION_FORM_ID} className="btn btn--primary" disabled={busy}>
            {bar === 'inspect' ? inspectLabel : ACTION_VERB[bar]}
          </button>
        </div>
      )}

      {secondary !== null && (
        <Dialog
          key={secondary.seq}
          open={secondary.open}
          onClose={closeSecondary}
          sheet
          title={SECONDARY_LABEL[secondary.action].replace('…', '')}
          description={`${request.customerEmail} · ${request.id}`}
          footer={<></>}
        >
          <StageForm
            action={secondary.action}
            target={request}
            busy={busy}
            problem={stageProblem}
            banner={
              dialogConflict === null ? null : (
                <ConflictBand conflict={dialogConflict} onResolve={resolveConflict} />
              )
            }
            onSubmit={(submission) => void runStage(submission, null)}
            onCancel={closeSecondary}
          />
        </Dialog>
      )}

      {confirming !== null && (
        <ConfirmDialog
          key={confirming.seq}
          open={confirming.open}
          onClose={() => setConfirming((prev) => (prev === null ? null : { ...prev, open: false }))}
          onConfirm={() => void runInspect()}
          sheet
          title={counting.accepted > 0 ? 'Record this inspection' : 'Record — nothing to award'}
          /* THE SAME STRING as the live line above the button that opened this.
             Phrase parity is what makes a confirmation a check rather than a
             second, differently-worded claim about the same arithmetic. */
          description={sentence}
          confirmLabel={inspectLabel}
        />
      )}
    </div>
  );
}

/**
 * What a lost write says, and the one control that resolves it.
 *
 * `moved` and `stale` are different things and are worded differently on
 * purpose: one means the return is somewhere else entirely and the form on
 * screen is about a stage that has passed; the other means only that the
 * revision moved under a form that is still perfectly valid. Both render from
 * the entity the 409 carried, so neither costs a second request.
 */
function ConflictBand({
  conflict,
  onResolve,
}: {
  conflict: Conflict;
  onResolve: () => void;
}) {
  return (
    <div className="notice notice--warn" role="alert">
      <div>
        {conflict.kind === 'moved' ? (
          <>
            Somebody else has already moved this return — it is now{' '}
            <strong>{STATUS_LABEL[conflict.fresh.status]}</strong>. Nothing here was saved; your
            entries are kept below.
          </>
        ) : (
          <>
            Somebody else changed this return while the form was open. It is still{' '}
            <strong>{STATUS_LABEL[conflict.fresh.status]}</strong>.
          </>
        )}
      </div>
      <div className="notice__actions">
        <button className="btn btn--outline btn--sm" onClick={onResolve}>
          {conflict.kind === 'moved' ? 'Show the current step' : 'Load theirs'}
        </button>
      </div>
    </div>
  );
}

/**
 * THE INSPECTION — two counts, a derived third, and one sentence.
 *
 * CONTROLLED, because three things outside this form depend on what is in it:
 * the confirmation restates the sentence, the mobile bar mirrors the submit and
 * has to carry the same label, and a 409 must leave every number where it was.
 * State that lived in here would be state the auto-heal could not preserve.
 *
 * REJECTED IS DISPLAYED AND NEVER TYPED. It is `received − accepted`, so the two
 * numbers cannot contradict a third — the sum-mismatch error is not validated
 * away, it is made unrepresentable (spec D5).
 */
function InspectionForm({
  formId,
  request,
  labels,
  value,
  onChange,
  rejected,
  sentence,
  primaryLabel,
  problem,
  busy,
  onSubmit,
}: {
  formId: string;
  request: ReturnRequest;
  labels: ProgramLabels;
  value: Counting;
  onChange: (next: Counting) => void;
  /** Derived by the caller, which also posts it. Never an input. */
  rejected: number;
  sentence: string;
  primaryLabel: string;
  problem: StageProblem | null;
  busy: boolean;
  onSubmit: () => void;
}) {
  const errorFor = (field: string): string | null =>
    problem !== null && problem.field === field ? problem.message : null;

  return (
    <form
      id={formId}
      className="mktform"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="mktform__hint">
        {fmtUnits(request.qtyDeclared, labels)} declared. Count what actually arrived — a driver
        collecting five of six is normal, and both numbers are recorded.
      </p>

      <div className="mktform__split">
        <div className="mktform__field">
          <span className="label">Received</span>
          <QtyStepper
            label="Received"
            value={value.received}
            onChange={(received) => onChange({ ...value, received })}
          />
        </div>
        <div className="mktform__field">
          <span className="label">Accepted</span>
          <QtyStepper
            label="Accepted"
            value={value.accepted}
            max={value.received}
            onChange={(accepted) => onChange({ ...value, accepted })}
          />
          {errorFor('qtyAccepted') && <p className="mktform__error">{errorFor('qtyAccepted')}</p>}
        </div>
      </div>

      <div className="mktform__field">
        <span className="label">Rejected</span>
        <p className="mktnum">{fmtUnits(rejected, labels)}</p>
        <p className="mktform__hint">Received minus accepted — there is nothing to type here.</p>
      </div>

      {rejected > 0 && (
        <div className="mktform__field">
          <span className="label">Why they were rejected</span>
          <Select
            label="Why they were rejected"
            value={value.reason}
            options={REJECT_OPTIONS}
            onChange={(reason) => onChange({ ...value, reason })}
          />
          {errorFor('rejectedReason') && (
            <p className="mktform__error">{errorFor('rejectedReason')}</p>
          )}
        </div>
      )}

      <div className="mktform__field">
        <label className="label" htmlFor={`${formId}-note`}>
          Note
        </label>
        <textarea
          id={`${formId}-note`}
          className="input"
          rows={2}
          value={value.note}
          maxLength={2000}
          placeholder="Optional"
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
        {/* When something was refused this text is part of the REASON as well —
            said once, stored where the customer will read it. */}
        <p className="mktform__hint">
          {rejected > 0
            ? 'Kept with the return — and added to the reason the customer is given.'
            : 'Optional — kept on the timeline.'}
        </p>
        {errorFor('note') && <p className="mktform__error">{errorFor('note')}</p>}
      </div>

      <p className={`mktmath${value.accepted === 0 ? ' mktmath--zero' : ''}`}>{sentence}</p>

      {problem !== null && problem.field === null && (
        <p className="mktform__error" role="alert">
          {problem.message}
        </p>
      )}

      <div className="mktform__actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {primaryLabel}
        </button>
        {/* NOT the `/reject` endpoint — that one is illegal once the goods are in
            hand. This prefills the inspection with nothing accepted, so the
            quantities are still counted and recorded (spec §UI, D5). */}
        {value.accepted > 0 && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onChange({ ...value, accepted: 0 })}
          >
            Reject everything…
          </button>
        )}
      </div>
    </form>
  );
}

