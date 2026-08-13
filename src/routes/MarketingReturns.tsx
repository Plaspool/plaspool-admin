import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { RotateCcw, Search, X } from 'lucide-react';
import {
  fmtUnits,
  labelsOf,
  marketingApi,
  type Program,
  type ProgramLabels,
  type ReturnAction,
  type ReturnCounts,
  type ReturnListItem,
  type ReturnRequest,
  type ReturnStatus,
  type ReturnsView,
} from '../data/api-marketing';
import { ApiError, NotFoundError, OfflineError, StaleWriteError } from '../data/errors';
import { useSidebarCounts } from '../components/Sidebar';
import { useToast } from '../components/Toast';
import { Dialog } from '../components/Dialog';
import { QtyStepper } from '../components/QtyStepper';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import {
  ACTION_VERB,
  GROUP_HEADING,
  PIPELINE,
  STATUS_LABEL,
  StageForm,
  submitStage,
  type StageAction,
  type StageProblem,
  type StageSubmission,
} from './marketing/StageForm';
import './marketing.css';

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

const PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

const HOUR = 3_600_000;
/** Waiting bands. Text AND colour — `.mktage--warn` never says anything alone. */
const WARN_MS = 48 * HOUR;
const DANGER_MS = 96 * HOUR;

const VIEWS: {
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

const EMPTY_COPY: Record<ReturnsView, { title: string; body: string }> = {
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
const FIELD_MESSAGE: Record<string, string> = {
  email: 'That doesn’t look like an email address.',
  qtyDeclared: 'Say how many are coming back.',
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

const fieldMessage = (field: string): string =>
  FIELD_MESSAGE[field] ?? 'That value wasn’t accepted.';

/** What a completed transition says. One per action, so none can fall through. */
const DONE_MESSAGE: Record<StageAction, string> = {
  schedule: 'Pickup scheduled',
  collect: 'Marked as picked up',
  receive: 'Marked as received',
  reject: 'Request rejected',
  cancel: 'Return cancelled',
};

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** `?view=schedulled` is a typo, not an error screen. */
function readView(params: URLSearchParams): ReturnsView {
  const raw = params.get('view');
  return VIEWS.some((v) => v.key === raw) ? (raw as ReturnsView) : 'needs_action';
}

/** The same params with the defaults dropped rather than written. */
function withParams(
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

const asSearch = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
};

/** "3h", "4d" — coarse on purpose: nobody schedules a driver by the minute. */
function ago(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const CLOSED: ReturnStatus[] = ['awarded', 'rejected', 'cancelled'];
const isClosed = (status: ReturnStatus): boolean => CLOSED.includes(status);

/**
 * The one action a row offers, or null for "there is nothing to advance".
 *
 * `note` counts as nothing: it is the only action a closed return allows, and a
 * queue button that added a note would be a write where the operator expected
 * to look at something.
 */
function primaryOf(row: ReturnListItem): ReturnAction | null {
  const first = row.allowedActions?.[0];
  return first === undefined || first === 'note' ? null : first;
}

function explainLoad(err: unknown): string {
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
  return 'The queue didn’t load.';
}

/** A write's failures, minus the ones the catalogue says to render inline. */
function explainWrite(err: unknown): string {
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
function carriedRequest(err: unknown): ReturnRequest | null {
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
function healed(row: ReturnListItem, fresh: ReturnRequest): ReturnListItem {
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

interface QueuePage {
  rows: ReturnListItem[];
  nextCursor: string | null;
  /** Null when the server sent none — the tabs degrade to labels, the queue lists. */
  counts: ReturnCounts | null;
}

export default function MarketingReturns() {
  const [params] = useSearchParams();
  const openId = params.get('id');
  return (
    <div className="mktscr">
      {openId === null ? <ReturnQueue /> : <DetailPending backTo={params} />}
    </div>
  );
}

// ============================================================================
// QUEUE
// ============================================================================

function ReturnQueue() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { notify } = useToast();

  const view = readView(params);
  const search = params.get('q') ?? '';
  const programId = params.get('programId') ?? '';

  const [page, setPage] = useState<QueuePage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const showSkeletons = useDelayed(loading);

  /**
   * The programs, fetched once and allowed to fail.
   *
   * They are decoration on this screen — a filter that only appears when there
   * is more than one, and the intake dialog's minimum and unit words — so a
   * failure here must not take the queue down with it. Without them the filter
   * is absent and the intake asks the server to pick the default program, which
   * is what it does anyway when no program is named (#5).
   */
  const [programs, setPrograms] = useState<Program[]>([]);

  // The box types into local state; a timer copies it into `?q=`. Same two
  // halves and the same 250ms as the dashboard's search — writing the param on
  // every keystroke refetches the queue five times for the word "dara".
  const [draft, setDraft] = useState(search);
  const pushed = useRef(search);

  useEffect(() => {
    if (search === pushed.current) return;
    pushed.current = search;
    setDraft(search);
  }, [search]);

  useEffect(() => {
    if (draft === pushed.current) return;
    const timer = window.setTimeout(() => {
      pushed.current = draft;
      setParams((prev) => withParams(prev, { q: draft }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, setParams]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setProblem(null);
      return marketingApi
        .listReturns(
          view,
          {
            q: search.trim() || undefined,
            programId: programId || undefined,
            limit: PAGE_LIMIT,
          },
          signal,
        )
        .then((next) => {
          if (signal?.aborted) return;
          setPage({
            rows: next.items ?? [],
            nextCursor: next.nextCursor ?? null,
            counts: next.counts ?? null,
          });
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          setProblem(explainLoad(err));
          setLoading(false);
        });
    },
    [view, search, programId],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    const ac = new AbortController();
    marketingApi
      .listPrograms(ac.signal)
      .then((next) => {
        if (!ac.signal.aborted) setPrograms(next);
      })
      .catch(() => {
        /* Soft: see the state's own note. */
      });
    return () => ac.abort();
  }, []);

  const rows = page?.rows ?? [];
  const counts = page?.counts ?? null;

  /** The rail badges Returns with the number of returns waiting on a person. */
  useSidebarCounts(counts === null ? null : { returns: counts.needsAction });

  // ------------------------------------------------------------- the dialogs
  /**
   * `seq` remounts the dialog on every open, which is how its fields come up
   * empty without an effect that reaches into them. `open` is kept separate from
   * the contents so a close still plays its exit animation with something to
   * animate.
   */
  const [intake, setIntake] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 });
  const [quick, setQuick] = useState<
    { open: boolean; action: StageAction; id: string; seq: number } | null
  >(null);
  const [stageProblem, setStageProblem] = useState<StageProblem | null>(null);
  const [conflict, setConflict] = useState<ReturnRequest | null>(null);
  const [stageBusy, setStageBusy] = useState(false);

  const quickRow = quick === null ? null : (rows.find((r) => r.id === quick.id) ?? null);

  function openQuick(action: StageAction, id: string): void {
    setStageProblem(null);
    setConflict(null);
    setQuick((prev) => ({ open: true, action, id, seq: (prev?.seq ?? 0) + 1 }));
  }

  const closeQuick = (): void =>
    setQuick((prev) => (prev === null ? null : { ...prev, open: false }));

  // ------------------------------------------------------------- navigation
  const detailTo = (row: ReturnListItem) => ({
    pathname: '/marketing/returns',
    search: asSearch(withParams(params, { id: row.id })),
  });

  /**
   * Inspection ALWAYS navigates. It is a form with derived quantities, a live
   * award sentence and a confirmation that restates it — squeezing that into a
   * dialog over the queue would be a second, smaller version of the screen that
   * exists for it.
   */
  const inspectTo = (row: ReturnListItem) => ({
    pathname: '/marketing/returns',
    search: asSearch(withParams(params, { id: row.id, act: 'inspect' })),
  });

  function fire(row: ReturnListItem): void {
    const action = primaryOf(row);
    if (action === null) {
      navigate(detailTo(row));
      return;
    }
    if (action === 'inspect') {
      navigate(inspectTo(row));
      return;
    }
    openQuick(action, row.id);
  }

  // ------------------------------------------------------------- the writes
  async function runStage(submission: StageSubmission): Promise<void> {
    if (quick === null || quickRow === null) return;
    setStageBusy(true);
    setStageProblem(null);
    setConflict(null);
    try {
      await submitStage(quickRow.id, submission);
      notify(DONE_MESSAGE[submission.action]);
      closeQuick();
      await load();
    } catch (err) {
      const fresh = carriedRequest(err);

      /*
       * AUTO-HEAL, the signature of this section's error handling. A 409 always
       * carries the re-read entity, so the answer to "somebody else moved this"
       * is to show its true stage — the row regroups under the heading it now
       * belongs to — rather than to ask the operator to reload and find out.
       */
      if (err instanceof StaleWriteError && fresh !== null) {
        // A lost CAS, not an illegal move: the form's inputs are still valid, so
        // the dialog stays open behind a band offering the revision it lost to.
        setConflict(fresh);
      } else if (err instanceof ApiError && err.code === 'invalid_transition' && fresh !== null) {
        adopt(fresh);
        closeQuick();
        notify(`That return is now ${STATUS_LABEL[fresh.status]}.`, { tone: 'danger' });
      } else if (err instanceof ApiError && err.status === 400 && err.detail !== undefined) {
        setStageProblem({ field: err.detail, message: fieldMessage(err.detail) });
      } else if (err instanceof NotFoundError) {
        // Evict rather than retry: the catalogue's `gone` is permanent.
        setPage((prev) =>
          prev === null ? prev : { ...prev, rows: prev.rows.filter((r) => r.id !== quickRow.id) },
        );
        closeQuick();
        notify('That return no longer exists.', { tone: 'danger' });
      } else {
        notify(explainWrite(err), {
          tone: 'danger',
          action: { label: 'Try again', run: () => void runStage(submission) },
        });
      }
    } finally {
      // In a `finally` because the success path needs it too: without it the
      // NEXT quick action opens with its submit already disabled, and the dialog
      // it opens in looks broken for a reason nothing on screen explains.
      setStageBusy(false);
    }
  }

  /** Put a re-read request back into the row it belongs to. */
  function adopt(fresh: ReturnRequest): void {
    setPage((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            rows: prev.rows.map((r) => (r.id === fresh.id ? healed(r, fresh) : r)),
          },
    );
  }

  async function showMore(): Promise<void> {
    if (page === null || page.nextCursor === null || paging) return;
    setPaging(true);
    try {
      const next = await marketingApi.listReturns(view, {
        q: search.trim() || undefined,
        programId: programId || undefined,
        cursor: page.nextCursor,
        limit: PAGE_LIMIT,
      });
      setPage((prev) =>
        prev === null
          ? prev
          : {
              rows: [...prev.rows, ...(next.items ?? [])],
              nextCursor: next.nextCursor ?? null,
              counts: next.counts ?? prev.counts,
            },
      );
    } catch (err) {
      notify(explainLoad(err), { tone: 'danger' });
    } finally {
      setPaging(false);
    }
  }

  // -------------------------------------------------------------- the rows
  const groups = PIPELINE.map((status) => ({
    status,
    rows: rows.filter((r) => r.status === status),
  })).filter((g) => g.rows.length > 0);
  /** Flat, in the order they are drawn — what ↑/↓ walk. */
  const ordered = groups.flatMap((g) => g.rows);

  const [activeId, setActiveId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  /**
   * ROVING TABINDEX. One row is in the tab order at a time and ↑/↓ move between
   * them; the row's own link and button follow it, so Tab through the queue is
   * three stops rather than a hundred and fifty. Enter opens the return, 'a'
   * fires the row's one action — the same two keys whichever stage the row is
   * at, which is what makes the queue workable from a keyboard at 8am.
   */
  const focused = ordered.findIndex((r) => r.id === activeId);
  const tabbableId = ordered[focused === -1 ? 0 : focused]?.id ?? null;

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>, index: number): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        ordered[e.key === 'ArrowDown' ? Math.min(index + 1, ordered.length - 1) : Math.max(index - 1, 0)];
      if (next === undefined) return;
      setActiveId(next.id);
      rowRefs.current.get(next.id)?.focus();
      return;
    }
    // Enter and 'a' belong to the ROW. Handling them from a child would hijack
    // Enter on the link inside it, which already means "open this".
    if (e.target !== e.currentTarget) return;
    const row = ordered[index];
    if (row === undefined) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(detailTo(row));
      return;
    }
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      fire(row);
    }
  }

  const now = Date.now();
  const eligible = programs.filter((p) => p.kind === 'unit_return' && p.status === 'active');
  /** How many this view holds in total, out of the counts — not a guess at it. */
  const total = counts === null ? null : (VIEWS.find((v) => v.key === view)?.count(counts) ?? null);

  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <div>
            <h1 className="mktscr__title">Returns</h1>
            <p className="mktscr__lede">
              Oldest first. Book a pickup, mark it collected, receive it — then inspect.
              Nothing is awarded until somebody has counted what arrived.
            </p>
          </div>
          {/* The section's ONLY create control, and any staff member may use it:
              processing returns is the job, not an owner's privilege. */}
          <button
            className="btn btn--primary"
            onClick={() => setIntake((prev) => ({ open: true, seq: prev.seq + 1 }))}
          >
            Log a return…
          </button>
        </div>

        <nav className="mkttabs" aria-label="Return stages">
          {VIEWS.map((tab) => (
            <Link
              key={tab.key}
              className={`mkttabs__tab${view === tab.key ? ' is-active' : ''}`}
              aria-current={view === tab.key ? 'page' : undefined}
              to={{
                pathname: '/marketing/returns',
                // The cursor is not in the URL — "Show more" appends — so a tab
                // change carries nothing of the old list with it.
                search: asSearch(withParams(params, { view: tab.key })),
              }}
            >
              {tab.label}
              {/* The space is for the accessible name, not the layout: the
                  strip is a flex row with its own gap, and a whitespace-only
                  text node between two flex items is not a flex item — but
                  without it the tab is announced as "Needs action3". */}
              {counts !== null && (
                <>
                  {' '}
                  <span className="mkttabs__count">{tab.count(counts)}</span>
                </>
              )}
            </Link>
          ))}
        </nav>

        <div className="mktfilters">
          <div className="searchbox">
            <Search className="ui-ic" aria-hidden="true" />
            <input
              className="searchbox__input"
              type="search"
              value={draft}
              placeholder="Email address, or a whole return id…"
              aria-label="Search returns"
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft !== '' && (
              <button
                className="searchbox__clear"
                aria-label="Clear search"
                onClick={() => {
                  pushed.current = '';
                  setDraft('');
                  setParams((prev) => withParams(prev, { q: '' }), { replace: true });
                }}
              >
                <X className="ui-ic" aria-hidden="true" />
              </button>
            )}
          </div>
          {/* One program is not a choice, so it is not a control. */}
          {programs.length > 1 && (
            <Select
              label="Program"
              value={programId === '' ? 'all' : programId}
              options={[
                { value: 'all', label: 'All programs' },
                ...programs.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) =>
                setParams((prev) => withParams(prev, { programId: v === 'all' ? null : v }), {
                  replace: true,
                })
              }
            />
          )}
        </div>
      </header>

      <div className="mktscr__body">
        {problem !== null && (
          <div className="notice notice--danger" role="alert">
            <div>
              <strong>The queue didn’t load.</strong> {problem}
            </div>
            <div className="notice__actions">
              <button className="btn btn--outline btn--sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {loading && page === null ? (
          showSkeletons ? (
            <ul className="mktqueue" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <li className="mktqrow" key={i}>
                  <span className="mktqrow__who">
                    <Skeleton height={16} width={`${70 - i * 6}%`} />
                    <Skeleton height={12} width="35%" />
                  </span>
                  <span className="mktqrow__qty">
                    <Skeleton height={16} width={72} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null
        ) : rows.length === 0 && problem === null ? (
          <div className="empty">
            <div className="empty__mark" aria-hidden="true">
              <RotateCcw />
            </div>
            <h2 className="empty__title">
              {search === '' ? EMPTY_COPY[view].title : 'Nothing matches'}
            </h2>
            <p className="empty__body">
              {search === ''
                ? EMPTY_COPY[view].body
                : 'The queue matches the start of an email address, or a whole return id.'}
            </p>
            {search !== '' && (
              <Link
                className="btn btn--outline"
                to={{
                  pathname: '/marketing/returns',
                  search: asSearch(withParams(params, { q: '' })),
                }}
              >
                Clear the search
              </Link>
            )}
          </div>
        ) : (
          <ul className="mktqueue" aria-label="Return requests">
            {groups.map((group) => (
              <Fragment key={group.status}>
                {/* An <li> in the same flat list rather than a nested <ul>: one
                    list of returns is announced, not seven lists of one. */}
                <li className="mktqgroup">
                  {GROUP_HEADING[group.status]} · {group.rows.length}
                </li>
                {group.rows.map((row) => {
                  const index = ordered.indexOf(row);
                  const tabbable = row.id === tabbableId;
                  const action = primaryOf(row);
                  const labels = labelsOf(row.program);
                  const closed = isClosed(row.status);
                  const waited = now - row.createdAt;
                  return (
                    <li
                      key={row.id}
                      className="mktqrow"
                      tabIndex={tabbable ? 0 : -1}
                      ref={(el) => {
                        if (el === null) rowRefs.current.delete(row.id);
                        else rowRefs.current.set(row.id, el);
                      }}
                      onFocus={() => setActiveId(row.id)}
                      onKeyDown={(e) => onRowKeyDown(e, index)}
                    >
                      <span className="mktqrow__who">
                        <Link
                          className="mktqrow__email"
                          tabIndex={tabbable ? 0 : -1}
                          to={detailTo(row)}
                        >
                          {row.customerEmail}
                        </Link>
                        <span className="mktqrow__id">{row.id}</span>
                      </span>

                      <span className="mktqrow__qty">
                        {fmtUnits(row.qtyDeclared, labels)}
                        {row.qtyAccepted !== null && ` · ${row.qtyAccepted} accepted`}
                      </span>

                      <span className="mktqrow__meta">
                        <span className={`mktage${ageModifier(closed ? 0 : waited)}`}>
                          {closed ? `${ago(now - row.updatedAt)} ago` : `waiting ${ago(waited)}`}
                        </span>
                        <span className={`chip mktchip--${row.status}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                        {row.pickupScheduledAt !== null && !closed && (
                          <span className="mktnum">
                            pickup {WHEN.format(new Date(row.pickupScheduledAt))}
                          </span>
                        )}
                      </span>

                      <span className="mktqrow__act">
                        <button
                          className={`btn btn--sm ${action === null ? 'btn--ghost' : 'btn--outline'}`}
                          tabIndex={tabbable ? 0 : -1}
                          // The visible verb, plus who it is for: fifty rows
                          // otherwise offer fifty buttons with the same name.
                          aria-label={`${action === null ? 'View' : ACTION_VERB[action]} — ${row.customerEmail}`}
                          onClick={() => fire(row)}
                        >
                          {action === null ? 'View' : ACTION_VERB[action]}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </Fragment>
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div className="mktpager">
            <span className="mktpager__note">
              {total === null
                ? `${rows.length} loaded — oldest first`
                : `${rows.length} of ${total} — oldest first`}
            </span>
            {page !== null && page.nextCursor !== null && (
              <button
                className="btn btn--outline btn--sm"
                disabled={paging}
                onClick={() => void showMore()}
              >
                Show more
              </button>
            )}
          </div>
        )}
      </div>

      <LogReturn
        key={intake.seq}
        open={intake.open}
        programs={eligible}
        onClose={() => setIntake((prev) => ({ ...prev, open: false }))}
        onLogged={async () => {
          setIntake((prev) => ({ ...prev, open: false }));
          notify('Return logged');
          await load();
        }}
      />

      {quick !== null && quickRow !== null && (
        <Dialog
          key={quick.seq}
          open={quick.open}
          onClose={closeQuick}
          // Inert above 640px, a bottom sheet below it. This is the dialog a
          // warehouse opens one-handed, which is the case the variant exists for.
          sheet
          title={
            quick.action === 'schedule'
              ? 'Schedule a pickup'
              : quick.action === 'collect'
                ? 'Mark as picked up'
                : 'Mark as received'
          }
          description={`${quickRow.customerEmail} · ${quickRow.id}`}
          // The form brings its own actions, so the dialog draws no footer of
          // its own — one row of buttons, in the order the fields lead to them.
          footer={<></>}
        >
          <StageForm
            action={quick.action}
            target={quickRow}
            busy={stageBusy}
            problem={stageProblem}
            banner={
              conflict === null ? null : (
                <div className="notice notice--warn" role="alert">
                  <div>
                    Somebody else changed this return while the form was open. It is now{' '}
                    <strong>{STATUS_LABEL[conflict.status]}</strong>.
                  </div>
                  <div className="notice__actions">
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => {
                        // No second fetch: the 409 carried the whole entity.
                        adopt(conflict);
                        setConflict(null);
                      }}
                    >
                      Load theirs
                    </button>
                  </div>
                </div>
              )
            }
            onSubmit={(submission) => void runStage(submission)}
            onCancel={closeQuick}
          />
        </Dialog>
      )}
    </>
  );
}

/** Which band a wait falls in. Closed rows are handed 0 — nothing is waiting. */
function ageModifier(ms: number): string {
  if (ms >= DANGER_MS) return ' mktage--danger';
  if (ms >= WARN_MS) return ' mktage--warn';
  return '';
}

// ============================================================================
// INTAKE
// ============================================================================

/**
 * What an admin fills in when a customer asks for a pickup.
 *
 * Its three named refusals are the reason it is a component rather than four
 * inputs in a ConfirmDialog: `below_minimum` belongs under the quantity box in
 * the program's own units, `return_already_open` is a LINK to the request that
 * is already in flight (a dead end otherwise — one open return per email is a
 * partial unique index, so there is nothing to retry), and `program_paused` is a
 * link to the screen that can unpause it.
 */
function LogReturn({
  open,
  programs,
  onClose,
  onLogged,
}: {
  open: boolean;
  /** Already filtered to the programs that can take a return. */
  programs: Program[];
  onClose: () => void;
  onLogged: () => void | Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [chosenId, setChosenId] = useState('');
  const [typedQty, setTypedQty] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<IntakeProblem | null>(null);

  /*
   * The chosen program is DERIVED rather than seeded into state, because the
   * list arrives from its own request and may land after this dialog is open. A
   * `useState(programs[0])` would keep the empty first answer forever; falling
   * back on every render adopts the real one the moment it exists, and still
   * lets an explicit choice win.
   */
  const chosen = programs.find((p) => p.id === chosenId) ?? programs[0] ?? null;
  const labels: ProgramLabels | null = chosen === null ? null : labelsOf(chosen);
  const min = chosen?.minUnitsPerReturn ?? 1;
  // Likewise: the operator's number wins, the program's minimum is the start.
  // Switching program does NOT reset it — they typed what the customer sent.
  const qty = typedQty ?? min;

  const atLeast = (n: number): string =>
    labels === null ? `At least ${n} per request.` : `At least ${fmtUnits(n, labels)} per request.`;

  /** Which inputs are on screen — the program picker only exists above one. */
  const onScreen = new Set([
    'email',
    'qtyDeclared',
    'customerName',
    'customerPhone',
    'pickupAddress',
    'note',
    ...(programs.length > 1 ? ['programId'] : []),
  ]);

  const fieldError = (field: string): string | null =>
    problem !== null && problem.kind === 'field' && problem.field === field
      ? problem.message
      : null;

  /**
   * A message with nowhere to land, said at the foot of the form instead.
   *
   * The catalogue's rule is "inline, keyed by `detail`" — but `detail` is a
   * field path the SERVER chose, and it may name one this form is not showing
   * (`programId`, whenever there is only one program to pick from) or one it has
   * never heard of. Dropped, the dialog would refuse to save and say nothing.
   */
  const orphan =
    problem === null
      ? null
      : problem.kind === 'failed'
        ? problem.message
        : problem.kind === 'field' && !onScreen.has(problem.field)
          ? problem.message
          : null;

  async function submit(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await marketingApi.createReturn({
        email: email.trim(),
        qtyDeclared: qty,
        programId: chosen?.id,
        customerName: name.trim() || undefined,
        customerPhone: phone.trim() || undefined,
        pickupAddress: address.trim() || undefined,
        note: note.trim() || undefined,
      });
      await onLogged();
    } catch (err) {
      setProblem(readIntakeProblem(err, min, atLeast));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      sheet
      title="Log a return"
      description="What the customer says they are sending back. Nothing is awarded until it has been inspected."
      footer={<></>}
    >
      <form
        className="mktform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {problem?.kind === 'already-open' && (
          <div className="notice notice--warn" role="alert">
            <div>
              This customer already has a return in progress — one at a time, so there is a
              driver for each.
            </div>
            <div className="notice__actions">
              <Link
                className="btn btn--outline btn--sm"
                to={{ pathname: '/marketing/returns', search: `?id=${problem.id}` }}
                onClick={onClose}
              >
                Open it
              </Link>
            </div>
          </div>
        )}

        {problem?.kind === 'paused' && (
          <div className="notice notice--warn" role="alert">
            <div>That program is paused, so it isn’t taking new returns.</div>
            <div className="notice__actions">
              <Link className="btn btn--outline btn--sm" to="/marketing/rewards" onClick={onClose}>
                Open Rewards
              </Link>
            </div>
          </div>
        )}

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-email">
            Customer email
          </label>
          <input
            id="mkt-intake-email"
            className="input"
            type="email"
            value={email}
            maxLength={320}
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldError('email') ? (
            <p className="mktform__error">{fieldError('email')}</p>
          ) : (
            <p className="mktform__hint">
              Guests earn under the address they checked out with.
            </p>
          )}
        </div>

        <div className="mktform__field">
          <span className="label">Quantity</span>
          {/* The program's minimum is the floor the BUTTONS respect, and the box
              still takes a smaller number typed into it: the operator records
              what the customer actually sent, and the route's `below_minimum`
              is the answer to it — not a quantity that changed itself. */}
          <QtyStepper label="Quantity" value={qty} min={min} onChange={setTypedQty} />
          {fieldError('qtyDeclared') ? (
            <p className="mktform__error">{fieldError('qtyDeclared')}</p>
          ) : (
            <p className="mktform__hint">{atLeast(min)}</p>
          )}
        </div>

        {programs.length > 1 && (
          <div className="mktform__field">
            <span className="label">Program</span>
            <Select
              label="Program"
              value={chosen?.id ?? ''}
              options={programs.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setChosenId}
            />
            {fieldError('programId') && <p className="mktform__error">{fieldError('programId')}</p>}
          </div>
        )}

        <div className="mktform__split">
          <div className="mktform__field">
            <label className="label" htmlFor="mkt-intake-name">
              Name
            </label>
            <input
              id="mkt-intake-name"
              className="input"
              value={name}
              maxLength={300}
              placeholder="Optional"
              onChange={(e) => setName(e.target.value)}
            />
            {fieldError('customerName') && (
              <p className="mktform__error">{fieldError('customerName')}</p>
            )}
          </div>
          <div className="mktform__field">
            <label className="label" htmlFor="mkt-intake-phone">
              Phone
            </label>
            <input
              id="mkt-intake-phone"
              className="input"
              value={phone}
              maxLength={300}
              placeholder="Optional"
              onChange={(e) => setPhone(e.target.value)}
            />
            {fieldError('customerPhone') && (
              <p className="mktform__error">{fieldError('customerPhone')}</p>
            )}
          </div>
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-address">
            Pickup address
          </label>
          <input
            id="mkt-intake-address"
            className="input"
            value={address}
            maxLength={2000}
            placeholder="Where the driver is going"
            onChange={(e) => setAddress(e.target.value)}
          />
          {fieldError('pickupAddress') && (
            <p className="mktform__error">{fieldError('pickupAddress')}</p>
          )}
        </div>

        <div className="mktform__field">
          <label className="label" htmlFor="mkt-intake-note">
            Note
          </label>
          <textarea
            id="mkt-intake-note"
            className="input"
            rows={2}
            value={note}
            maxLength={2000}
            placeholder="Optional — kept on the timeline"
            onChange={(e) => setNote(e.target.value)}
          />
          {fieldError('note') && <p className="mktform__error">{fieldError('note')}</p>}
        </div>

        {orphan !== null && (
          <p className="mktform__error" role="alert">
            {orphan}
          </p>
        )}

        <div className="mktform__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || email.trim() === ''}>
            Log the return
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type IntakeProblem =
  | { kind: 'field'; field: string; message: string }
  | { kind: 'already-open'; id: string }
  | { kind: 'paused' }
  | { kind: 'failed'; message: string };

function readIntakeProblem(
  err: unknown,
  min: number,
  atLeast: (n: number) => string,
): IntakeProblem {
  if (err instanceof ApiError) {
    if (err.code === 'below_minimum') {
      // The payload carries the minimum so the message can name it; the
      // program's own is the fallback, not the source.
      const body = (err.body ?? {}) as { min?: unknown };
      const stated = typeof body.min === 'number' ? body.min : min;
      return { kind: 'field', field: 'qtyDeclared', message: atLeast(stated) };
    }
    if (err.code === 'return_already_open') {
      const body = (err.body ?? {}) as { existingId?: unknown };
      if (typeof body.existingId === 'string') {
        return { kind: 'already-open', id: body.existingId };
      }
    }
    if (err.code === 'program_paused') return { kind: 'paused' };
    if (err.code === 'program_type_mismatch') {
      // The wire carries no message field by design — this copy is the client's.
      return { kind: 'field', field: 'programId', message: 'That program doesn’t take returns.' };
    }
    if (err.status === 400 && err.detail !== undefined) {
      return { kind: 'field', field: err.detail, message: fieldMessage(err.detail) };
    }
  }
  return { kind: 'failed', message: explainWrite(err) };
}

// ============================================================================
// DETAIL (plan Task B4)
// ============================================================================

/**
 * The lifecycle screen is Task B4's; this stands in its place so `?id=` is a
 * destination rather than the queue rendered under a URL that promised a return.
 * Replaced whole, not extended.
 */
function DetailPending({ backTo }: { backTo: URLSearchParams }) {
  const to = {
    pathname: '/marketing/returns',
    search: asSearch(withParams(backTo, { id: null, act: null })),
  };
  return (
    <>
      <header className="mktscr__head">
        <div className="mktscr__headrow">
          <h1 className="mktscr__title">Return</h1>
        </div>
        <p className="mktscr__lede">
          The lifecycle view — stages, inspection and the timeline — is still being built.
        </p>
      </header>
      <div className="mktscr__body">
        <div className="empty">
          <div className="empty__mark" aria-hidden="true">
            <RotateCcw />
          </div>
          <h2 className="empty__title">Not on this screen yet</h2>
          <p className="empty__body">
            Scheduling, receiving and inspecting a single return land here next.
          </p>
          <Link className="btn btn--outline" to={to}>
            Back to the queue
          </Link>
        </div>
      </div>
    </>
  );
}
