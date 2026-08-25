import { useMemo, useState } from 'react';
import { Lock, Plus, Upload, UserRound, Users } from 'lucide-react';
import {
  emailApi,
  type EmailSubscriber,
  type SubscriberFilter,
  type SubscriberSource,
} from '../../data/api-email';
import { getSession } from '../../data/session';
import { useAsync } from '../lib/useAsync';
import { shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { Checkbox, TextArea, TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * SUBSCRIBERS — `/emails/subscribers`.
 *
 * SUPPRESSION IS NOT DELETION: an unsubscribed row stays visible, so
 * re-importing the same file cannot quietly resurrect someone who asked to
 * leave. There is deliberately no admin unsubscribe action either — leaving
 * is the recipient's own link, not a button here.
 *
 * TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: the import preview showing the refused rows BEFORE anything is
 * written, and only valid addresses travelling in the body.
 */

const SOURCE_TONE: Record<SubscriberSource, BadgeTone> = {
  customer: 'info',
  manual: 'neutral',
  import: 'neutral',
};

const TABS: { value: SubscriberFilter; label: string }[] = [
  { value: 'subscribed', label: 'Subscribed' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'all', label: 'All' },
];

/** Good enough to keep typos out of a send list; the server re-validates. */
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function OwnerOnly() {
  return (
    <div className="page">
      <PageHeader icon={<Users />} title="Subscribers" />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          title="Owner-only surface"
          body="Everything on the email side — templates, subscribers, broadcasts — belongs to the owner account."
        />
      </div>
    </div>
  );
}

export default function EmailSubscribers() {
  const toast = useToast();
  const session = getSession();
  const isOwner = 'user' in session && session.user?.role === 'owner';

  const [tab, setTab] = useState<SubscriberFilter>('subscribed');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const [nonce, setNonce] = useState(0);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const { data, error, loading } = useAsync(
    (signal) =>
      isOwner
        ? emailApi.listSubscribers(
            { filter: tab, ...(cursor ? { cursor } : {}), limit: 25 },
            signal,
          )
        : Promise.resolve({ items: [] as EmailSubscriber[], nextCursor: null }),
    [tab, cursor, nonce, isOwner],
  );

  const audience = useAsync(
    (signal) => (isOwner ? emailApi.audience(signal) : Promise.resolve(null)),
    [nonce, isOwner],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((s) => s.email.toLowerCase().includes(q));
  }, [all, search]);

  if (!isOwner) return <OwnerOnly />;

  const reload = () => setNonce((n) => n + 1);

  const columns: Column<EmailSubscriber>[] = [
    {
      key: 'email',
      header: 'Email',
      primary: true,
      render: (s) => <IdCell thumb={<UserRound aria-hidden="true" />} title={s.email} />,
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (s) =>
        s.unsubscribedAt !== null ? (
          <Badge>Unsubscribed {shortDate(s.unsubscribedAt)}</Badge>
        ) : (
          <Badge tone="ok">Subscribed</Badge>
        ),
    },
    {
      key: 'source',
      header: 'Source',
      label: 'Source',
      tight: true,
      render: (s) => <Badge tone={SOURCE_TONE[s.source]}>{s.source}</Badge>,
    },
    {
      key: 'consent',
      header: 'Consented',
      label: 'Consented',
      render: (s) =>
        s.consentAt !== null ? shortDate(s.consentAt) : <span className="muted">No date on record</span>,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Users />}
        title="Subscribers"
        subtitle={
          audience.data
            ? `${audience.data.subscribed} subscribed · ${audience.data.suppressed} unsubscribed and kept on record`
            : 'The audience the next broadcast goes to.'
        }
        actions={
          <>
            <Button size="lg" onClick={() => setImporting(true)}>
              <Upload aria-hidden="true" />
              Import
            </Button>
            <Button tone="primary" size="lg" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              Add subscriber
            </Button>
          </>
        }
      />

      {error ? (
        <Banner tone="critical" title="Couldn’t load subscribers">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Subscribers"
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        loading={loading && all.length === 0}
        tabs={{
          value: tab,
          tabs: TABS,
          onChange: (next) => {
            setCursors([null]);
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Filter the addresses on this page',
          onChange: setSearch,
        }}
        empty={
          search ? (
            <EmptyState
              icon={<Users />}
              title="No addresses match that filter"
              actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
            />
          ) : tab === 'unsubscribed' ? (
            <EmptyState icon={<Users />} title="Nobody has unsubscribed" />
          ) : (
            <EmptyState
              icon={<Users />}
              title="No subscribers yet"
              body="Customers join at checkout; you can also add or import addresses you have consent for."
            />
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

      {adding ? (
        <AddModal
          onClose={() => setAdding(false)}
          onDone={(email) => {
            setAdding(false);
            reload();
            toast.show(`${email} added`);
          }}
        />
      ) : null}

      {importing ? (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={(added, skipped) => {
            setImporting(false);
            reload();
            toast.show(`${added} added · ${skipped} already on the list`);
          }}
        />
      ) : null}
    </div>
  );
}

function AddModal({ onClose, onDone }: { onClose: () => void; onDone: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [welcome, setWelcome] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const addr = email.trim().toLowerCase();
    if (!EMAILISH.test(addr)) {
      setError('That does not look like an email address.');
      return;
    }
    setBusy(true);
    try {
      await emailApi.addSubscriber(addr, welcome);
      onDone(addr);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add subscriber"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            Add subscriber
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Email"
          type="email"
          value={email}
          autoFocus
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
          }}
        />
        <Checkbox
          label="Send the welcome email"
          hint="A real message to a real person — off by default, because most manual adds are a list being migrated, not a new subscriber. Ignored if the address is already on the list."
          checked={welcome}
          onChange={setWelcome}
        />
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}

function ImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (added: number, skipped: number) => void;
}) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    const tokens = raw
      .split(/[\s,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const unique = [...new Set(tokens)];
    const valid = unique.filter((t) => EMAILISH.test(t));
    const invalid = unique.filter((t) => !EMAILISH.test(t));
    return { valid, invalid };
  }, [raw]);

  async function commit() {
    if (parsed.valid.length === 0) {
      setError('Nothing importable yet.');
      return;
    }
    setBusy(true);
    try {
      const result = await emailApi.importSubscribers(parsed.valid);
      onDone(result.added, result.skipped);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import subscribers"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} disabled={parsed.valid.length === 0} onClick={() => void commit()}>
            <Upload aria-hidden="true" />
            Import {parsed.valid.length || ''} {parsed.valid.length === 1 ? 'address' : 'addresses'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextArea
          label="Addresses"
          rows={7}
          value={raw}
          hint="Paste them — one per line, or separated by commas. Importing asserts you have consent to email these people; that assertion is what fills the consent date."
          onChange={(e) => {
            setRaw((e.target as HTMLTextAreaElement).value);
            setError(null);
          }}
        />
        {raw.trim() ? (
          <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
            <Badge tone="ok">{parsed.valid.length} importable</Badge>
            {parsed.invalid.length > 0 ? (
              <Badge tone="warn">{parsed.invalid.length} refused</Badge>
            ) : null}
          </div>
        ) : null}
        {parsed.invalid.length > 0 ? (
          <div className="field__hint" style={{ overflowWrap: 'anywhere' }}>
            Won’t be written: {parsed.invalid.slice(0, 12).join(', ')}
            {parsed.invalid.length > 12 ? ` and ${parsed.invalid.length - 12} more` : ''} — fix
            them here or import without them.
          </div>
        ) : null}
        <p className="muted" style={{ fontSize: 'var(--t-sm)', lineHeight: 1.5 }}>
          Already-present addresses are skipped, in either state — an import can never resurrect
          someone who unsubscribed.
        </p>
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
