import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PackageOpen, Plus, Truck } from 'lucide-react';
import {
  labelsOf,
  marketingApi,
  OUT_OF_AREA,
  type EmbeddedProgram,
  type InspectResult,
  type Program,
  type ReturnAction,
  type ReturnDetail,
  type ReturnEvent,
  type ReturnListItem,
  type ReturnRequest,
  type ReturnStatus,
  type ReturnsView,
  type ServiceArea,
} from '../../data/api-marketing';
import { ApiError } from '../../data/errors';
import { getSession } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { dateTime, humanise, money, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { SelectField, TextArea, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { SearchSelect } from '../ui/SearchSelect';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';
import { isAdminRole } from '../../../shared/roles';

/**
 * SPOOLS — `/spools`, the root of the section. The pickup queue: request →
 * schedule → collect → receive → inspect → award. Lived at `/orders/returns`
 * until 2026-09-06; the old path redirects here.
 *
 * THE QUEUE'S ONE-BUTTON RULE, from the API contract: `allowedActions` is
 * ORDERED, pipeline-advancing action first, and each row renders exactly one
 * button — `allowedActions[0]`. Everything else lives in the detail.
 *
 * WORTH IS THE SNAPSHOT, NEVER TODAY'S RATE: a card shows quantity × the
 * rate the customer was PROMISED (`pointsPerUnitSnapshot`), so a Wednesday
 * repricing cannot silently restate Monday's cards.
 *
 * TODO(v2): the bulk selection bar (schedule/collect/receive many at once —
 * `marketingApi.bulk` exists, with per-item CAS and partial-success results)
 * is not wired yet; the queue works one card at a time.
 */

const STATUS_TONE: Record<ReturnStatus, BadgeTone> = {
  requested: 'warn',
  scheduled: 'info',
  collected: 'info',
  received: 'warn',
  awarded: 'ok',
  rejected: 'neutral',
  cancelled: 'neutral',
};

/** The row button's words — the imperative for the NEXT move. */
const ACTION_LABEL: Record<ReturnAction, string> = {
  schedule: 'Schedule…',
  collect: 'Collected',
  receive: 'Received',
  inspect: 'Inspect…',
  reject: 'Reject…',
  cancel: 'Cancel…',
  note: 'Add note…',
};

const VIEWS: { value: ReturnsView; label: string; countKey?: keyof Counts }[] = [
  { value: 'needs_action', label: 'Needs action', countKey: 'needsAction' },
  { value: 'requested', label: 'Requested', countKey: 'requested' },
  { value: 'scheduled', label: 'Scheduled', countKey: 'scheduled' },
  { value: 'collected', label: 'Collected', countKey: 'collected' },
  { value: 'received', label: 'Received', countKey: 'received' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

type Counts = {
  requested: number;
  scheduled: number;
  collected: number;
  received: number;
  awarded: number;
  rejected: number;
  cancelled: number;
  needsAction: number;
};

function points(n: number, program: EmbeddedProgram): string {
  const labels = labelsOf(program);
  return `${n} ${n === 1 ? labels.points.one : labels.points.other}`;
}

export default function Spools() {
  const toast = useToast();
  const [view, setView] = useState<ReturnsView>('needs_action');
  /** '' means every board at once — the desk. */
  const [district, setDistrict] = useState<string>('');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const [nonce, setNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [intake, setIntake] = useState(false);
  /** A row action started from the LIST — the detail modal opens on that stage. */
  const [openStage, setOpenStage] = useState<Stage>('view');

  const { data, error, loading } = useAsync(
    (signal) =>
      marketingApi.listReturns(
        view,
        {
          ...(q.trim() ? { q: q.trim() } : {}),
          ...(district ? { district } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
        signal,
      ),
    [view, district, q, cursor, nonce],
  );

  const areas = useAsync((signal) => marketingApi.listAreas(true, signal), []);

  const reload = () => setNonce((n) => n + 1);

  const boardOptions = useMemo(() => {
    const opts: { value: string; label: string; meta?: string }[] = [
      { value: '', label: 'Every board' },
    ];
    for (const area of areas.data?.areas ?? []) {
      opts.push({
        value: area.id,
        label: area.name,
        meta: area.needsAction > 0 ? `${area.needsAction} to act on` : `${area.open} open`,
      });
    }
    const foot = areas.data?.outOfArea;
    if (foot && (foot.open > 0 || foot.needsAction > 0)) {
      opts.push({ value: OUT_OF_AREA, label: 'Out of area', meta: `${foot.open} open` });
    }
    return opts;
  }, [areas.data]);

  const counts = data?.counts;
  const rows = data?.items ?? [];

  const columns: Column<ReturnListItem>[] = [
    {
      key: 'customer',
      header: 'Customer',
      primary: true,
      render: (r) => (
        <IdCell
          title={r.customerName || r.customerEmail}
          meta={
            <>
              {r.customerName ? `${r.customerEmail} · ` : ''}
              {r.program.name}
            </>
          }
        />
      ),
    },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{humanise(r.status)}</Badge>,
    },
    {
      key: 'qty',
      header: 'Qty',
      label: 'Qty',
      numeric: true,
      render: (r) => (
        <span className="num">
          {r.qtyAccepted !== null ? `${r.qtyAccepted} of ${r.qtyDeclared}` : r.qtyDeclared}
        </span>
      ),
    },
    {
      key: 'worth',
      header: 'Worth',
      label: 'Worth',
      numeric: true,
      render: (r) => (
        <span className="num" title="Number of items × the rate promised when they asked">
          {r.pointsAwarded !== null
            ? points(r.pointsAwarded, r.program)
            : points(r.qtyDeclared * r.pointsPerUnitSnapshot, r.program)}
        </span>
      ),
    },
    {
      key: 'area',
      header: 'Area',
      label: 'Area',
      render: (r) =>
        r.serviceArea ? (
          r.serviceArea.name
        ) : (
          <Badge tone="warn">Out of area</Badge>
        ),
    },
    {
      key: 'pickup',
      header: 'Pickup',
      label: 'Pickup',
      render: (r) =>
        r.pickupScheduledAt ? dateTime(r.pickupScheduledAt) : <span className="muted">—</span>,
    },
    {
      key: 'act', pin: true,
      header: <span className="sr">Next step</span>,
      label: 'Next step',
      tight: true,
      render: (r) => {
        /* Exactly one button, and it is allowedActions[0] — the contract's
           own rule for the queue. */
        const primary = r.allowedActions[0];
        if (!primary || primary === 'note') return null;
        return (
          <Button
            onClick={() => {
              setOpenStage(stageFor(primary));
              setOpenId(r.id);
            }}
          >
            {ACTION_LABEL[primary]}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Truck />}
        title="Spools"
        subtitle="Customers ask, you book a pickup, collect, check the items, then pay out points."
        actions={
          <>
            {boardOptions.length > 1 ? (
              <SearchSelect
                label="Board"
                value={district}
                onChange={(next) => {
                  setCursors([null]);
                  setDistrict(next);
                }}
                align="right"
                placeholder="Search boards…"
                emptyText="No board matches that."
                options={boardOptions}
              />
            ) : null}
            {/* No "What items cost us" button here any more: Analytics is a
                child of this section in the rail, one click away on every
                Spools screen, and a second door beside the primary action was
                chrome without a reason. */}
            <Button tone="primary" size="lg" onClick={() => setIntake(true)}>
              <Plus aria-hidden="true" />
              New return
            </Button>
          </>
        }
      />

      {error ? (
        <Banner tone="critical" title="Couldn’t load returns">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Returns"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => {
          setOpenStage('view');
          setOpenId(r.id);
        }}
        loading={loading && rows.length === 0}
        tabs={{
          value: view,
          tabs: VIEWS.map((v) => ({
            value: v.value,
            /* Counts are on every response — real aggregates, never a guess. */
            label:
              v.countKey && counts ? `${v.label} · ${counts[v.countKey]}` : v.label,
          })),
          onChange: (next) => {
            setCursors([null]);
            setView(next);
          },
        }}
        search={{
          value: q,
          placeholder: 'Search by email or name',
          onChange: (next) => {
            setCursors([null]);
            setQ(next);
          },
        }}
        empty={
          q ? (
            <EmptyState
              icon={<PackageOpen />}
              title="Nothing matches that search"
              actions={<Button onClick={() => setQ('')}>Clear search</Button>}
            />
          ) : view === 'needs_action' ? (
            <EmptyState
              icon={<PackageOpen />}
              title="Nothing needs you right now"
              body="New requests, and returns waiting to be checked. These are the two steps that need you."
            />
          ) : (
            <EmptyState icon={<PackageOpen />} title="No returns in this view" />
          )
        }
        footer={
          <TablePager
            note={`${rows.length} shown`}
            canPrev={cursors.length > 1}
            canNext={Boolean(data?.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => setCursors((c) => [...c, data?.nextCursor ?? null])}
          />
        }
      />

      {openId ? (
        <ReturnModal
          id={openId}
          initialStage={openStage}
          /* For the cost form's PLACEHOLDERS — the district's standard shown
             in grey, never pre-filled into the box. Only active districts are
             fetched here (that is what the board switcher wants), so a return
             in a retired one simply gets no suggestion; the analytics reader
             still resolves its standard server-side. */
          areas={areas.data?.areas ?? []}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      ) : null}

      {intake ? (
        <IntakeModal
          areas={areas.data?.areas ?? []}
          onClose={() => setIntake(false)}
          onDone={(detail) => {
            setIntake(false);
            reload();
            toast.show(`Return for ${detail.request.customerEmail} created`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ DETAIL MODAL ════ */

type Stage =
  | 'view'
  /** What the pickup cost us. Not a transition — it is legal in every status,
   *  including the closed ones, because a transport invoice arrives late. */
  | 'costs'
  | 'schedule'
  | 'collect'
  | 'receive'
  | 'inspect'
  | 'reject'
  | 'cancel'
  | 'note';

function stageFor(action: ReturnAction): Stage {
  return action;
}

function eventLine(event: ReturnEvent): TimelineEvent {
  const tone: TimelineEvent['tone'] =
    event.type === 'inspected'
      ? 'ok'
      : event.type === 'rejected' || event.type === 'cancelled'
        ? 'critical'
        : event.type === 'note'
          ? 'neutral'
          : 'info';
  /* The `data` snapshot is render-final — the inspected event carries the
     wording that was true at the time, displayed verbatim. */
  const snapshot =
    event.data && typeof event.data['summary'] === 'string' ? (event.data['summary'] as string) : null;
  return {
    id: event.id,
    tone,
    message: (
      <>
        {humanise(event.type)}
        {snapshot ? <> — {snapshot}</> : null}
        {event.note ? <> · {event.note}</> : null}
      </>
    ),
    meta: `${dateTime(event.occurredAt)} · ${event.actorType}${event.actorId ? ` ${event.actorId}` : ''}`,
  };
}

function ReturnModal({
  id,
  initialStage,
  areas,
  onClose,
  onChanged,
}: {
  id: string;
  initialStage: Stage;
  areas: ServiceArea[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const session = getSession();
  /* Owner-grade means owner OR developer since migration 0680 — the
     server's requireAdmin() tier, mirrored (shared/roles.ts). */
  const isOwner = 'user' in session && session.user != null && isAdminRole(session.user.role);

  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>(initialStage);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function fetchDetail() {
    try {
      setDetail(await marketingApi.getReturn(id));
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }

  useEffect(() => {
    void fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** Every transition ends the same way: re-read (events moved too), tell the
   *  list, land back on the facts. */
  async function run(work: () => Promise<unknown>, doneMsg: string) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      toast.show(doneMsg);
      await fetchDetail();
      onChanged();
      setStage('view');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'already_awarded') {
        /* The first attempt landed and its response was lost — a retry after a
           dropped connection is SUCCESS, the contract's own words. */
        toast.show('Already paid out — your first attempt worked');
        await fetchDetail();
        onChanged();
        setStage('view');
      } else if (cause instanceof ApiError && cause.status === 409) {
        setProblem('Someone else changed this return. Reload and try again.');
        await fetchDetail();
      } else {
        setProblem(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  const request = detail?.request ?? null;
  /** The district this pickup belongs to, for its standard costs. `null` for
   *  an out-of-area return and for one in a district that has been retired —
   *  both mean "no suggestion", which the form shows as an empty box. */
  const area = areas.find((a) => a.id === request?.serviceAreaId) ?? null;

  return (
    <Modal
      title={request ? request.customerName || request.customerEmail : 'Return'}
      onClose={onClose}
      wide
      footer={
        stage === 'view' && request ? (
          <>
            {request.allowedActions
              .filter((a) => a !== 'note')
              .map((action, i) => (
                <Button key={action} tone={i === 0 ? 'primary' : 'default'} onClick={() => setStage(stageFor(action))}>
                  {ACTION_LABEL[action]}
                </Button>
              ))}
            <Button tone="plain" onClick={() => setStage('costs')}>
              What it cost…
            </Button>
            <Button tone="plain" onClick={() => setStage('note')}>
              Add note…
            </Button>
          </>
        ) : undefined
      }
    >
      {loadError ? (
        <Banner tone="critical" title="Couldn’t load this return">
          {loadError}
        </Banner>
      ) : !detail || !request ? (
        <div className="stack stack--tight" aria-hidden="true">
          <span className="skel" style={{ width: '12rem' }} />
          <span className="skel" style={{ width: '16rem', opacity: 0.7 }} />
          <span className="skel" style={{ width: '9rem', opacity: 0.5 }} />
        </div>
      ) : stage === 'view' ? (
        <div className="stack">
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <Badge tone={STATUS_TONE[request.status]}>{humanise(request.status)}</Badge>
            <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              {detail.program.name} · requested {shortDate(request.createdAt)} ·{' '}
              {request.source === 'admin' ? 'phoned in' : 'from your shop'}
            </span>
          </div>

          {problem ? (
            <Banner tone="warn" title="That didn’t go through">
              {problem}
            </Banner>
          ) : null}

          <Defs
            rows={[
              { label: 'Email', value: request.customerEmail },
              ...(request.customerPhone ? [{ label: 'Phone', value: request.customerPhone }] : []),
              {
                label: 'Pickup address',
                value: request.pickupAddress ?? <span className="muted">None on file</span>,
              },
              {
                label: 'Declared',
                value: `${request.qtyDeclared} — worth ${points(
                  request.qtyDeclared * request.pointsPerUnitSnapshot,
                  detail.program,
                )} at the promised rate`,
              },
              ...(request.qtyAccepted !== null
                ? [
                    {
                      label: 'Inspected',
                      value: `${request.qtyAccepted} accepted · ${request.qtyRejected ?? 0} rejected`,
                    },
                  ]
                : []),
              ...(request.pointsAwarded !== null
                ? [{ label: 'Awarded', value: points(request.pointsAwarded, detail.program) }]
                : []),
              ...(request.pickupScheduledAt
                ? [
                    {
                      label: 'Pickup',
                      value: `${dateTime(request.pickupScheduledAt)}${
                        request.driverName ? ` · ${request.driverName}` : ''
                      }${request.driverPhone ? ` (${request.driverPhone})` : ''}`,
                    },
                  ]
                : []),
              ...costRows(request, area, detail.program.unitCostMinor),
              ...(request.rejectedReason ? [{ label: 'Rejected because', value: request.rejectedReason }] : []),
              ...(request.cancelReason ? [{ label: 'Cancelled because', value: request.cancelReason }] : []),
            ]}
          />

          {detail.emailIntents.length > 0 ? (
            <div className="stack stack--tight">
              <span className="field__label">Customer mail</span>
              {detail.emailIntents.map((mail, i) => (
                <div key={i} className="row" style={{ fontSize: 'var(--t-sm)' }}>
                  <span className="muted">{humanise(mail.kind)}</span>
                  <span className="spacer" />
                  <Badge tone={mail.sentAt ? 'ok' : mail.lastError ? 'critical' : 'neutral'}>
                    {mail.sentAt ? 'Handed to mailer' : mail.lastError ? 'Stuck' : 'Queued'}
                  </Badge>
                </div>
              ))}
            </div>
          ) : null}

          <div className="stack stack--tight">
            <span className="field__label">History</span>
            <Timeline events={detail.events.map(eventLine)} />
          </div>
        </div>
      ) : stage === 'costs' ? (
        <CostsForm
          request={request}
          area={area}
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onSubmit={(patch) =>
            void run(
              () => marketingApi.setReturnCosts(request.id, { expectedRevision: request.revision, ...patch }),
              'Saved what it cost',
            )
          }
        />
      ) : stage === 'schedule' ? (
        <ScheduleForm
          request={request}
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onSubmit={(draft) =>
            void run(
              () => marketingApi.schedule(request.id, { expectedRevision: request.revision, ...draft }),
              'Pickup scheduled',
            )
          }
        />
      ) : stage === 'collect' || stage === 'receive' ? (
        <ConfirmStep
          title={stage === 'collect' ? 'Has the driver picked these up?' : 'Have they arrived?'}
          body={
            stage === 'collect'
              ? 'Marks it as picked up. The customer is told their items are on the way in.'
              : 'Marks it as arrived and adds it to the list waiting to be checked.'
          }
          confirmLabel={stage === 'collect' ? 'Mark collected' : 'Mark received'}
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onConfirm={(note) =>
            void run(
              () =>
                stage === 'collect'
                  ? marketingApi.collect(request.id, {
                      expectedRevision: request.revision,
                      ...(note ? { note } : {}),
                    })
                  : marketingApi.receive(request.id, {
                      expectedRevision: request.revision,
                      ...(note ? { note } : {}),
                    }),
              stage === 'collect' ? 'Marked collected' : 'Marked received',
            )
          }
        />
      ) : stage === 'inspect' ? (
        <InspectForm
          detail={detail}
          isOwner={isOwner}
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onSubmit={(draft, summary) =>
            void run(async () => {
              const result: InspectResult = await marketingApi.inspect(request.id, {
                expectedRevision: request.revision,
                ...draft,
              });
              return result;
            }, summary)
          }
        />
      ) : stage === 'reject' ? (
        <ReasonStep
          title="Refuse this return?"
          body="Use this before anything is collected — nothing gets counted. If the items are already with you, check them in and accept zero instead, so the numbers are still recorded."
          label="Why it is refused (optional)"
          /* OPTIONAL SINCE 2026-09-03 (owner's instruction). This one is MAILED
           * to the customer — leave it blank and they get a refusal with no
           * explanation, which the email renders as a missing paragraph rather
           * than an empty "Reason:". */
          required={false}
          confirmLabel="Reject return"
          critical
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onConfirm={(reason) =>
            void run(
              () =>
              marketingApi.reject(request.id, {
                expectedRevision: request.revision,
                ...(reason ? { reason } : {}),
              }),
              'Return rejected',
            )
          }
        />
      ) : stage === 'cancel' ? (
        <ReasonStep
          title="Cancel this return?"
          body="Closes it without paying any points. You can also cancel a return you already collected — use that if it was lost on the way."
          label="Reason"
          required={false}
          confirmLabel="Cancel return"
          critical
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onConfirm={(reason) =>
            void run(
              () =>
                marketingApi.cancel(request.id, {
                  expectedRevision: request.revision,
                  ...(reason ? { reason } : {}),
                }),
              'Return cancelled',
            )
          }
        />
      ) : (
        <ReasonStep
          title="Add a note"
          body="You can add a note at any stage. A note doesn’t change the return."
          label="Note"
          required
          confirmLabel="Add note"
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onConfirm={(note) => void run(() => marketingApi.addNote(request.id, note), 'Note added')}
        />
      )}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════ WHAT IT COST US ════ */

/**
 * The four lines a pickup is costed in, and the words for each.
 *
 * FOUR AND NOT ONE TOTAL, which is the owner's ask: seeing that TRANSPORT is
 * the half that moved is the entire reason to record them apart. `std` names
 * the district's standard for the same line — read for a placeholder only,
 * never written onto the return.
 */
const COST_LINES = [
  {
    key: 'transportMinor',
    row: 'costTransportMinor',
    std: 'stdTransportMinor',
    label: 'Transport in',
    hint: 'The long leg — getting them to the workshop.',
  },
  {
    key: 'localMinor',
    row: 'costLocalMinor',
    std: 'stdLocalMinor',
    label: 'Local delivery',
    hint: 'The run around the district itself.',
  },
  {
    key: 'driverMinor',
    row: 'costDriverMinor',
    std: 'stdDriverMinor',
    label: 'Driver',
    hint: 'What the driver was paid for this trip.',
  },
  {
    key: 'feesMinor',
    row: 'costFeesMinor',
    std: 'stdFeesMinor',
    label: 'Loading and fees',
    hint: 'Loading, park fees, anything else on the day.',
  },
] as const;

type CostKey = (typeof COST_LINES)[number]['key'];

/** Minor units → what goes in the box. Naira, plain, no separators, because
 *  the box is a number input and a comma in one is not a number. */
const toBox = (minor: number | null | undefined): string =>
  /* `== null`, NEVER `=== null`. These columns are younger than the API
     contract, so a payload from before 0920 — a cached response, an older
     deployment answering a newer bundle, a fixture — carries `undefined`, and
     `String(undefined / 100)` is the string "NaN" sitting in a money box. */
  minor == null ? '' : String(minor / 100);

/**
 * What is in the box → minor units, or `null` for an empty one.
 *
 * `undefined` IS THE THIRD ANSWER and it means "this is not a number" — the
 * form refuses to save rather than sending something the server will 400.
 * Naira are multiplied by 100 and ROUNDED: a pasted `2500.005` is a typo, not
 * a fraction of a kobo, and rounding is what keeps it an integer the column
 * will accept.
 */
function fromBox(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const naira = Number(trimmed);
  if (!Number.isFinite(naira) || naira < 0) return undefined;
  return Math.round(naira * 100);
}

/**
 * What this pickup cost, for the read-only panel.
 *
 * IT SAYS WHERE EACH FIGURE CAME FROM. A line nobody typed is shown as the
 * district's standard and labelled "standard" — because a screen that renders
 * an estimate and a receipt identically is how the number on the dashboard
 * stops meaning anything.
 */
function costRows(
  request: ReturnRequest,
  area: ServiceArea | null,
  unitCostMinor: number | null,
): { label: string; value: ReactNode }[] {
  /* `!= null` throughout — see `toBox`. */
  const typed = COST_LINES.some((l) => request[l.row] != null);
  const parts: string[] = [];
  let total = 0;

  for (const l of COST_LINES) {
    const own = request[l.row] ?? null;
    const std = (area ? area[l.std] : null) ?? null;
    const value = own ?? std;
    if (value === null) continue;
    total += value;
    parts.push(`${l.label} ${money(value, 'NGN')}${own === null ? ' (standard)' : ''}`);
  }

  if (parts.length === 0) {
    return [
      {
        label: 'What it cost us',
        value: <span className="muted">Not recorded — it counts as nothing on the analytics.</span>,
      },
    ];
  }

  /* The reward side, priced at the rate FROZEN onto this return — never
     today's, which is the whole point of the snapshot. */
  const rate = request.unitCostMinorSnapshot ?? unitCostMinor ?? null;
  const kept = request.qtyAccepted;
  const reward = rate !== null && kept !== null ? kept * rate : null;

  return [
    {
      label: 'What it cost us',
      value: (
        <span>
          <strong>{money(total, 'NGN')}</strong>
          {typed ? '' : ' — all estimated from the district'}
          <br />
          <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
            {parts.join(' · ')}
          </span>
          {request.costNote ? (
            <>
              <br />
              <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                {request.costNote}
              </span>
            </>
          ) : null}
        </span>
      ),
    },
    ...(reward !== null && kept !== null && kept > 0
      ? [
          {
            label: 'All in, per item kept',
            value: (
              <span>
                <strong>{money(Math.round((reward + total) / kept), 'NGN')}</strong>{' '}
                <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                  {money(reward, 'NGN')} paid out + {money(total, 'NGN')} to fetch them, over{' '}
                  {kept} kept
                </span>
              </span>
            ),
          },
        ]
      : []),
  ];
}

/**
 * The cost form.
 *
 * THE DISTRICT'S STANDARD IS A PLACEHOLDER AND NEVER A PRE-FILLED VALUE, and
 * that is the single most important line in this component. Pre-filling would
 * save the standard onto the return the moment somebody pressed Save, and an
 * estimate saved that way is indistinguishable from a figure a person
 * measured — which would quietly destroy the one thing the analytics screen
 * uses to say how much of its own headline it trusts.
 *
 * AN EMPTY BOX SENDS `null`, NOT NOTHING. Clearing a figure typed into the
 * wrong box has to be possible, and the wire spells that difference out.
 */
function CostsForm({
  request,
  area,
  busy,
  problem,
  onBack,
  onSubmit,
}: {
  request: ReturnRequest;
  area: ServiceArea | null;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onSubmit: (patch: Partial<Record<CostKey, number | null>> & { note: string | null }) => void;
}) {
  const [boxes, setBoxes] = useState<Record<CostKey, string>>(() => ({
    transportMinor: toBox(request.costTransportMinor),
    localMinor: toBox(request.costLocalMinor),
    driverMinor: toBox(request.costDriverMinor),
    feesMinor: toBox(request.costFeesMinor),
  }));
  const [note, setNote] = useState(request.costNote ?? '');

  const parsed = COST_LINES.map((l) => [l.key, fromBox(boxes[l.key])] as const);
  const bad = parsed.some(([, value]) => value === undefined);

  /* Live, so the person typing sees the answer they are actually after rather
     than four numbers they have to add up themselves. */
  const total = parsed.reduce<number>((sum, [key, value]) => {
    const line = COST_LINES.find((l) => l.key === key)!;
    const std = (area ? area[line.std] : null) ?? null;
    return sum + (value === undefined ? 0 : (value ?? std ?? 0));
  }, 0);
  const kept = request.qtyAccepted;

  return (
    <div className="stack">
      <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
        <strong>What did this pickup cost us?</strong> Fill in what you know — every box is
        optional. Anything you leave empty falls back to the standard for this district, and the
        analytics page says how many pickups it had to estimate.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
          gap: 'var(--s3)',
        }}
      >
        {COST_LINES.map((line) => {
          const std = (area ? area[line.std] : null) ?? null;
          return (
            <TextField
              key={line.key}
              label={line.label}
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              value={boxes[line.key]}
              /* GREY, NOT FILLED IN. The number is a suggestion until somebody
                 types it, and that difference is what the dashboard counts. */
              placeholder={std === null ? '₦0' : `₦${(std / 100).toLocaleString()} standard`}
              hint={line.hint}
              error={
                fromBox(boxes[line.key]) === undefined ? 'Enter an amount in naira' : undefined
              }
              onChange={(e) => setBoxes((b) => ({ ...b, [line.key]: e.target.value }))}
            />
          );
        })}
      </div>

      <TextArea
        label="Why (optional)"
        rows={2}
        value={note}
        placeholder="Second trip — the first driver broke down"
        onChange={(e) => setNote(e.target.value)}
      />

      <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
        {bad ? (
          'Fix the amounts above to see the total.'
        ) : (
          <>
            <strong>{money(total, 'NGN')}</strong> to fetch this pickup
            {kept !== null && kept > 0
              ? ` — ${money(Math.round(total / kept), 'NGN')} an item on top of what we paid out`
              : ''}
            {area ? '' : ' · no district, so nothing is estimated for the empty boxes'}
          </>
        )}
      </p>

      {problem ? (
        <span className="field__error" role="alert">
          {problem}
        </span>
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={onBack}>
          Back
        </Button>
        <Button
          tone="primary"
          busy={busy}
          disabled={bad}
          onClick={() => {
            const patch: Partial<Record<CostKey, number | null>> = {};
            for (const [key, value] of parsed) patch[key] = value ?? null;
            /* A blank note is sent as `null` and never as an empty string —
               one spelling of blank, the rule every optional sentence in this
               admin has followed since 2026-09-03. */
            onSubmit({ ...patch, note: note.trim() || null });
          }}
        >
          Save what it cost
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ STAGE FORMS ════ */

function ScheduleForm({
  request,
  busy,
  problem,
  onBack,
  onSubmit,
}: {
  request: ReturnRequest;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onSubmit: (draft: {
    pickupAt: number;
    driverName?: string;
    driverPhone?: string;
    pickupAddress?: string;
    note?: string;
  }) => void;
}) {
  const [when, setWhen] = useState('');
  const [driverName, setDriverName] = useState(request.driverName ?? '');
  const [driverPhone, setDriverPhone] = useState(request.driverPhone ?? '');
  const [address, setAddress] = useState(request.pickupAddress ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reschedule = request.status === 'scheduled';

  function submit() {
    const ms = when ? new Date(when).getTime() : NaN;
    if (!Number.isFinite(ms)) {
      setError('Pick the pickup date and time.');
      return;
    }
    if (!request.pickupAddress && !address.trim()) {
      setError('This request has no address saved. The driver needs one.');
      return;
    }
    onSubmit({
      pickupAt: ms,
      ...(driverName.trim() ? { driverName: driverName.trim() } : {}),
      ...(driverPhone.trim() ? { driverPhone: driverPhone.trim() } : {}),
      ...(address.trim() && address.trim() !== request.pickupAddress
        ? { pickupAddress: address.trim() }
        : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <div className="stack">
      {reschedule ? (
        <Banner tone="info" title="Rescheduling">
          The history will show that the pickup was moved.
        </Banner>
      ) : null}
      <TextField
        label="Pickup date and time"
        type="datetime-local"
        value={when}
        autoFocus
        onChange={(e) => {
          setWhen(e.target.value);
          setError(null);
        }}
      />
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
        <div style={{ flex: 1 }}>
          <TextField label="Driver" value={driverName} placeholder="Optional" onChange={(e) => setDriverName(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <TextField
            label="Driver phone"
            value={driverPhone}
            placeholder="Optional"
            inputMode="tel"
            onChange={(e) => setDriverPhone(e.target.value)}
          />
        </div>
      </div>
      <TextField
        label="Pickup address"
        value={address}
        hint={request.pickupAddress ? 'Changing this updates the request.' : 'Required — no address is saved yet.'}
        onChange={(e) => {
          setAddress(e.target.value);
          setError(null);
        }}
      />
      <TextField label="Note" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
      {error || problem ? (
        <span className="field__error" role="alert">
          {error ?? problem}
        </span>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={onBack}>
          Back
        </Button>
        <Button tone="primary" busy={busy} onClick={submit}>
          <Truck aria-hidden="true" />
          {reschedule ? 'Reschedule pickup' : 'Schedule pickup'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Inspection: staff type what ARRIVED and what was ACCEPTED; the screen
 * subtracts. There is no third box to disagree with the other two — the
 * classic "your numbers don't add up" error is unrepresentable (spec D5).
 */
function InspectForm({
  detail,
  isOwner,
  busy,
  problem,
  onBack,
  onSubmit,
}: {
  detail: ReturnDetail;
  isOwner: boolean;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onSubmit: (
    draft: {
      qtyAccepted: number;
      qtyRejected: number;
      rejectedReason?: string;
      bonusPoints?: number;
      bonusReason?: string;
      note?: string;
    },
    successMessage: string,
  ) => void;
}) {
  const { request, program } = detail;
  const [received, setReceived] = useState(String(request.qtyDeclared));
  const [accepted, setAccepted] = useState(String(request.qtyDeclared));
  const [rejectedReason, setRejectedReason] = useState('');
  const [bonus, setBonus] = useState('');
  const [bonusReason, setBonusReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const nReceived = Number(received);
  const nAccepted = Number(accepted);
  const valid =
    Number.isInteger(nReceived) &&
    nReceived >= 0 &&
    Number.isInteger(nAccepted) &&
    nAccepted >= 0 &&
    nAccepted <= nReceived;
  const nRejected = valid ? nReceived - nAccepted : 0;
  const award = valid ? nAccepted * request.pointsPerUnitSnapshot : 0;

  function submit() {
    if (!valid) {
      setError('Use whole numbers. You can’t accept more than arrived.');
      return;
    }
    /* NEITHER REASON IS DEMANDED since 2026-09-03. The labels still say what
     * each one is for, and the rejected-items reason still says that the
     * customer reads it — that argument is now the copy's job, not the form's. */
    const nBonus = bonus.trim() === '' ? undefined : Number(bonus);
    if (nBonus !== undefined && (!Number.isInteger(nBonus) || nBonus <= 0)) {
      setError('A bonus must be a whole number of points, above zero.');
      return;
    }
    onSubmit(
      {
        qtyAccepted: nAccepted,
        qtyRejected: nRejected,
        /* KEY OMITTED WHEN BLANK, both here and below. The route's REASON is
         * still `.min(1)` inside its `.optional()`, and the repository still
         * REFUSES a rejected-items reason when nothing was rejected — optional
         * means "you need not explain", not "the record may contradict itself". */
        ...(nRejected > 0 && rejectedReason.trim() ? { rejectedReason: rejectedReason.trim() } : {}),
        ...(nBonus !== undefined
          ? { bonusPoints: nBonus, ...(bonusReason.trim() ? { bonusReason: bonusReason.trim() } : {}) }
          : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      nAccepted > 0
        ? `Awarded ${points(award, program)}${nBonus ? ` + ${nBonus} bonus` : ''}`
        : 'Nothing accepted — return closed as turned down',
    );
  }

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label="Arrived"
            type="number"
            min={0}
            step={1}
            value={received}
            autoFocus
            hint={`${request.qtyDeclared} declared.`}
            onChange={(e) => {
              setReceived(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField
            label="Accepted"
            type="number"
            min={0}
            step={1}
            value={accepted}
            onChange={(e) => {
              setAccepted(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <TextField label="Rejected" value={valid ? String(nRejected) : '—'} disabled hint="Arrived minus accepted." onChange={() => {}} />
        </div>
      </div>

      <Banner tone={nAccepted > 0 ? 'info' : 'warn'} title={valid && nAccepted > 0 ? `Awards ${points(award, program)}` : 'Awards nothing'}>
        {valid && nAccepted > 0
          ? `${nAccepted} × ${request.pointsPerUnitSnapshot} — the rate promised when they asked, not today’s.`
          : 'Accepting zero closes this return as turned down. The numbers are still recorded.'}
      </Banner>

      {nRejected > 0 ? (
        <TextField
          label="Why units were rejected (optional)"
          hint="The customer is emailed this."
          value={rejectedReason}
          onChange={(e) => {
            setRejectedReason(e.target.value);
            setError(null);
          }}
        />
      ) : null}

      {isOwner ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Bonus points"
              type="number"
              min={1}
              step={1}
              value={bonus}
              placeholder="Optional"
              hint="Added as a separate entry, on top of the points above."
              onChange={(e) => {
                setBonus(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 2 }}>
            <TextField
              label="Bonus reason (optional)"
              value={bonusReason}
              placeholder="Saved permanently"
              onChange={(e) => {
                setBonusReason(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>
      ) : null}

      <TextField label="Note" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />

      {error || problem ? (
        <span className="field__error" role="alert">
          {error ?? problem}
        </span>
      ) : null}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={onBack}>
          Back
        </Button>
        <Button tone="primary" busy={busy} onClick={submit}>
          {valid && nAccepted === 0 ? 'Record and reject' : 'Award points'}
        </Button>
      </div>
    </div>
  );
}

function ConfirmStep({
  title,
  body,
  confirmLabel,
  busy,
  problem,
  onBack,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="stack">
      <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
        <strong>{title}</strong> {body}
      </p>
      <TextField label="Note" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
      {problem ? (
        <span className="field__error" role="alert">
          {problem}
        </span>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={onBack}>
          Back
        </Button>
        <Button tone="primary" busy={busy} onClick={() => onConfirm(note.trim())}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function ReasonStep({
  title,
  body,
  label,
  required,
  confirmLabel,
  critical = false,
  busy,
  problem,
  onBack,
  onConfirm,
}: {
  title: string;
  body: string;
  label: string;
  required: boolean;
  confirmLabel: string;
  critical?: boolean;
  busy: boolean;
  problem: string | null;
  onBack: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <p style={{ fontSize: 'var(--t-md)', lineHeight: 1.55 }}>
        <strong>{title}</strong> {body}
      </p>
      <TextArea
        label={label}
        rows={2}
        value={reason}
        onChange={(e) => {
          setReason((e.target as HTMLTextAreaElement).value);
          setError(null);
        }}
      />
      {error || problem ? (
        <span className="field__error" role="alert">
          {error ?? problem}
        </span>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--s2)' }}>
        <Button tone="plain" onClick={onBack}>
          Back
        </Button>
        <Button
          tone={critical ? 'critical' : 'primary'}
          busy={busy}
          onClick={() => {
            if (required && !reason.trim()) {
              setError('Fill this in.');
              return;
            }
            onConfirm(reason.trim());
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ INTAKE MODAL ════ */

function IntakeModal({
  areas,
  onClose,
  onDone,
}: {
  areas: ServiceArea[];
  onClose: () => void;
  onDone: (detail: ReturnDetail) => void;
}) {
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [email, setEmail] = useState('');
  const [qty, setQty] = useState('1');
  const [programId, setProgramId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [areaId, setAreaId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    marketingApi
      .listPrograms()
      .then((list) => {
        if (live) setPrograms(list.filter((p) => p.kind === 'unit_return' && p.status === 'active'));
      })
      .catch(() => {
        if (live) setPrograms([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function commit() {
    const n = Number(qty);
    if (!email.trim() || !email.includes('@')) {
      setError('Enter the customer’s email address.');
      return;
    }
    if (!Number.isInteger(n) || n < 1) {
      setError('Quantity is a whole number of at least 1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await marketingApi.createReturn({
        email: email.trim(),
        qtyDeclared: n,
        ...(programId ? { programId } : {}),
        ...(name.trim() ? { customerName: name.trim() } : {}),
        ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
        ...(address.trim() ? { pickupAddress: address.trim() } : {}),
        ...(areaId ? { serviceAreaId: areaId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(detail);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'outside_service_area') {
        setError('You don’t deliver to that area. Leave the board empty to file it as out of area instead.');
      } else {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New return"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            <Plus aria-hidden="true" />
            Create return
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--t-md)', lineHeight: 1.5 }}>
          For a customer who phoned or walked in. A request from an area you don’t serve still counts — it goes
          to the out-of-area list, can be closed with a reason, but can never earn points.
        </p>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1.4 }}>
            <TextField
              label="Customer email"
              type="email"
              value={email}
              autoFocus
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 0.6 }}>
            <TextField
              label="Quantity"
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => {
                setQty(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Name" value={name} placeholder="Optional" onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <TextField label="Phone" value={phone} placeholder="Optional" inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <TextField label="Pickup address" value={address} placeholder="Optional now — needed before you can book a pickup" onChange={(e) => setAddress(e.target.value)} />
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <SelectField
              label="Board"
              value={areaId}
              hint="Pick from the list. Addresses aren’t looked up automatically."
              onChange={(e) => setAreaId(e.target.value)}
            >
              <option value="">Out of area / not sure</option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name} — {area.region}
                </option>
              ))}
            </SelectField>
          </div>
          <div style={{ flex: 1 }}>
            <SelectField
              label="Programme"
              value={programId}
              hint={programs === null ? 'Loading…' : 'Leave empty to use the store default.'}
              onChange={(e) => setProgramId(e.target.value)}
            >
              <option value="">Store default</option>
              {(programs ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <TextField label="Note" value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
