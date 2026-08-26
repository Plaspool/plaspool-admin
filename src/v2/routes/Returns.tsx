import { useEffect, useMemo, useState } from 'react';
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
import { dateTime, humanise, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Defs } from '../ui/Defs';
import { SelectField, TextArea, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { SearchSelect } from '../ui/SearchSelect';
import { Timeline, type TimelineEvent } from '../ui/Timeline';
import { useToast } from '../ui/Toast';

/**
 * RETURNS — `/orders/returns`. The pickup queue: request → schedule → collect
 * → receive → inspect → award.
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

export default function Returns() {
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
        <span className="num" title="Quantity × the rate promised at request time">
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
        title="Returns"
        subtitle="Request, schedule, collect, inspect, award — the spool pickup queue."
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
            <Button tone="primary" size="lg" onClick={() => setIntake(true)}>
              <Plus aria-hidden="true" />
              New return
            </Button>
          </>
        }
      />

      {error ? (
        <Banner tone="critical" title="Couldn’t load the queue">
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
              body="New requests and returns waiting on inspection land here — the two stages where the admin is the blocker."
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
  onClose,
  onChanged,
}: {
  id: string;
  initialStage: Stage;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

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
        toast.show('Already awarded — the first attempt landed');
        await fetchDetail();
        onChanged();
        setStage('view');
      } else if (cause instanceof ApiError && cause.status === 409) {
        setProblem('This return moved somewhere else — re-read and try again.');
        await fetchDetail();
      } else {
        setProblem(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  const request = detail?.request ?? null;

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
              {request.source === 'admin' ? 'phoned in' : 'from the storefront'}
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
          title={stage === 'collect' ? 'The driver has the goods?' : 'At the warehouse?'}
          body={
            stage === 'collect'
              ? 'Marks it collected — the customer is told the spools are on their way in.'
              : 'Marks it received and puts it in the inspection queue.'
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
          body="Pre-receipt refusal — nothing was collected, nothing is counted. Once goods are in hand, inspect with zero accepted instead, so the quantities are still recorded."
          label="Why it is refused"
          required
          confirmLabel="Reject return"
          critical
          busy={busy}
          problem={problem}
          onBack={() => setStage('view')}
          onConfirm={(reason) =>
            void run(
              () => marketingApi.reject(request.id, { expectedRevision: request.revision, reason }),
              'Return rejected',
            )
          }
        />
      ) : stage === 'cancel' ? (
        <ReasonStep
          title="Cancel this return?"
          body="Closes it without an award. Collected returns can be cancelled too — that is the lost-in-transit escape."
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
          body="Notes are legal in every state and bump nothing — a note is not an edit."
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
      setError('This request has no address on file — the driver needs one.');
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
          A second scheduled event is emitted, so the history shows the pickup moved.
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
        hint={request.pickupAddress ? 'Changing this updates the request.' : 'Required — nothing is on file yet.'}
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
      setError('Whole numbers, and accepted can’t exceed what arrived.');
      return;
    }
    if (nRejected > 0 && !rejectedReason.trim()) {
      setError('Rejecting units needs the reason — it is recorded and mailed.');
      return;
    }
    const nBonus = bonus.trim() === '' ? undefined : Number(bonus);
    if (nBonus !== undefined && (!Number.isInteger(nBonus) || nBonus <= 0)) {
      setError('A bonus is a positive whole number of points.');
      return;
    }
    if (nBonus !== undefined && !bonusReason.trim()) {
      setError('A bonus needs its reason — stored verbatim and forever.');
      return;
    }
    onSubmit(
      {
        qtyAccepted: nAccepted,
        qtyRejected: nRejected,
        ...(nRejected > 0 ? { rejectedReason: rejectedReason.trim() } : {}),
        ...(nBonus !== undefined ? { bonusPoints: nBonus, bonusReason: bonusReason.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      nAccepted > 0
        ? `Awarded ${points(award, program)}${nBonus ? ` + ${nBonus} bonus` : ''}`
        : 'Nothing accepted — return closed as rejected',
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
          <TextField label="Rejected" value={valid ? String(nRejected) : '—'} disabled hint="Derived — arrived minus accepted." onChange={() => {}} />
        </div>
      </div>

      <Banner tone={nAccepted > 0 ? 'info' : 'warn'} title={valid && nAccepted > 0 ? `Awards ${points(award, program)}` : 'Awards nothing'}>
        {valid && nAccepted > 0
          ? `${nAccepted} × ${request.pointsPerUnitSnapshot} — the rate promised when the request was made, not today’s.`
          : 'Zero accepted closes this return as rejected, with the quantities on record.'}
      </Banner>

      {nRejected > 0 ? (
        <TextField
          label="Why units were rejected"
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
              hint="A second ledger row — never a bigger award."
              onChange={(e) => {
                setBonus(e.target.value);
                setError(null);
              }}
            />
          </div>
          <div style={{ flex: 2 }}>
            <TextField
              label="Bonus reason"
              value={bonusReason}
              placeholder="Required with a bonus"
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
              setError('This one needs its words.');
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
      setError('The customer’s email is the return’s identity.');
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
        setError('That area isn’t served — leave the board empty to file it as out-of-area instead.');
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
          The phone-in path. A request from outside the served districts is still real — it lands
          in the out-of-area footer, can be closed with a reason, and can never be awarded.
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
        <TextField label="Pickup address" value={address} placeholder="Optional now, needed to schedule" onChange={(e) => setAddress(e.target.value)} />
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <SelectField
              label="Board"
              value={areaId}
              hint="Chosen, never parsed — no geocoding here."
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
              hint={programs === null ? 'Loading…' : 'Empty uses the store default.'}
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
