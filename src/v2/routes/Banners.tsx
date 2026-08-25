import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutTemplate, Megaphone, MoreHorizontal, Plus } from 'lucide-react';
import {
  deriveBannerStatus,
  marketingApi,
  type Banner as MarketingBanner,
  type BannerDraft,
  type DerivedBannerStatus,
} from '../../data/api-marketing';
import { parseWhen } from '../data/discounts';
import { humanise, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState, type BadgeTone } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { SelectField, TextArea, TextField } from '../ui/Field';
import { MenuItem, MenuSeparator, Menu } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * BANNERS — `/content/banners`. The promotional strips the storefront shows.
 *
 * WHAT A ROW'S STATUS MEANS: the stored intent is draft/live/archived, and
 * what the site actually shows is that intent CROSSED WITH THE CLOCK —
 * `deriveBannerStatus`, the same rule the public endpoint's WHERE uses. So
 * the status column here can say "scheduled" or "ended" about a row whose
 * stored status is `live`, and that is the honest reading.
 *
 * THERE IS NO DELETE. A banner that ran is a thing that happened; archiving
 * is the way off the list.
 *
 * TODO(tests): none — skipped this session, recorded in CLAUDE.md. Worth
 * pinning: the derived-status filter (a stored-live row shows under
 * "scheduled" before its window), and the CAS patch carrying
 * expectedRevision.
 */

const STATUS_TONE: Record<DerivedBannerStatus, BadgeTone> = {
  draft: 'warn',
  scheduled: 'info',
  live: 'ok',
  ended: 'neutral',
  archived: 'neutral',
};

const PLACEMENT_LABEL: Record<MarketingBanner['placement'], string> = {
  top_bar: 'Top bar',
  popup: 'Popup',
  section: 'Section',
};

const TABS: { value: DerivedBannerStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'draft', label: 'Drafts' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' },
];

/** Epoch ms → the value a datetime-local input holds, in local time. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function windowLabel(b: MarketingBanner): string {
  if (b.startsAt === null && b.endsAt === null) return 'Always on';
  const from = b.startsAt !== null ? shortDate(b.startsAt) : 'Now';
  const to = b.endsAt !== null ? shortDate(b.endsAt) : 'no end';
  return `${from} → ${to}`;
}

export default function Banners() {
  const toast = useToast();
  const [banners, setBanners] = useState<MarketingBanner[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<DerivedBannerStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<'closed' | 'new' | MarketingBanner>('closed');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setBanners(await marketingApi.listBanners(signal));
      setLoadError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const adopt = (next: MarketingBanner) =>
    setBanners((list) =>
      list === null
        ? list
        : list.some((b) => b.id === next.id)
          ? list.map((b) => (b.id === next.id ? next : b))
          : [next, ...list],
    );

  const now = Date.now();
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (banners ?? [])
      .map((b) => ({ banner: b, derived: deriveBannerStatus(b, now) }))
      .filter((r) => (tab === 'all' ? r.derived !== 'archived' : r.derived === tab))
      .filter((r) => !q || r.banner.title.toLowerCase().includes(q) || r.banner.body.toLowerCase().includes(q));
  }, [banners, tab, search, now]);

  async function setStatus(banner: MarketingBanner, status: 'draft' | 'live' | 'archived') {
    try {
      const next = await marketingApi.patchBanner(banner.id, {
        expectedRevision: banner.revision,
        status,
      });
      adopt(next);
      toast.show(
        status === 'live'
          ? `“${banner.title}” is on — the clock decides when it shows`
          : status === 'draft'
            ? `“${banner.title}” back to draft`
            : `“${banner.title}” archived`,
      );
    } catch (cause) {
      toast.show(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.', 'critical');
      void load();
    }
  }

  type RowShape = { banner: MarketingBanner; derived: DerivedBannerStatus };
  const columns: Column<RowShape>[] = [
    {
      key: 'banner',
      header: 'Banner',
      primary: true,
      render: ({ banner: b }) => (
        <IdCell
          thumb={<Megaphone aria-hidden="true" />}
          title={b.title}
          meta={b.body ? (b.body.length > 80 ? `${b.body.slice(0, 80)}…` : b.body) : 'No body text'}
        />
      ),
    },
    {
      key: 'placement',
      header: 'Placement',
      label: 'Placement',
      tight: true,
      render: ({ banner: b }) => <Badge>{PLACEMENT_LABEL[b.placement]}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: ({ derived }) => <Badge tone={STATUS_TONE[derived]}>{humanise(derived)}</Badge>,
    },
    {
      key: 'window',
      header: 'Window',
      label: 'Window',
      render: ({ banner: b }) => <span className="muted">{windowLabel(b)}</span>,
    },
    {
      key: 'priority',
      header: 'Priority',
      label: 'Priority',
      numeric: true,
      render: ({ banner: b }) => <span className="num">{b.priority}</span>,
    },
    {
      key: 'act',
      header: <span className="sr">Actions</span>,
      label: 'Actions',
      tight: true,
      render: (row) => <RowMenu row={row} onEdit={() => setEditing(row.banner)} onStatus={setStatus} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<LayoutTemplate />}
        title="Banners"
        subtitle="Promotional strips on the storefront — the clock decides what actually shows."
        actions={
          <Button tone="primary" size="lg" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            Create banner
          </Button>
        }
      />

      {loadError ? (
        <Banner tone="critical" title="Couldn’t load banners" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      ) : null}

      <DataTable
        caption="Banners"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.banner.id}
        onRowClick={(r) => setEditing(r.banner)}
        loading={banners === null && !loadError}
        tabs={{ value: tab, tabs: TABS, onChange: setTab }}
        search={{ value: search, placeholder: 'Filter banners', onChange: setSearch }}
        empty={
          search ? (
            <EmptyState
              icon={<Megaphone />}
              title="No banners match"
              actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
            />
          ) : tab === 'all' ? (
            <EmptyState
              icon={<Megaphone />}
              title="No banners yet"
              body="A banner is a strip at the top of the storefront, a popup, or a section — with an optional schedule."
              actions={
                <Button tone="primary" onClick={() => setEditing('new')}>
                  <Plus aria-hidden="true" />
                  Create banner
                </Button>
              }
            />
          ) : (
            <EmptyState icon={<Megaphone />} title={`Nothing ${tab === 'draft' ? 'in drafts' : tab}`} />
          )
        }
        footer={null}
      />

      {editing !== 'closed' ? (
        <BannerModal
          banner={editing === 'new' ? null : editing}
          onClose={() => setEditing('closed')}
          onDone={(next) => {
            adopt(next);
            setEditing('closed');
          }}
        />
      ) : null}
    </div>
  );
}

function RowMenu({
  row,
  onEdit,
  onStatus,
}: {
  row: { banner: MarketingBanner; derived: DerivedBannerStatus };
  onEdit: () => void;
  onStatus: (banner: MarketingBanner, status: 'draft' | 'live' | 'archived') => Promise<void>;
}) {
  const { banner: b } = row;
  return (
    <Menu
      chrome="bare"
      buttonLabel={`Actions for ${b.title}`}
      label={
        <span className="btn btn--plain btn--icon" style={{ display: 'inline-grid', placeItems: 'center' }}>
          <MoreHorizontal aria-hidden="true" />
        </span>
      }
    >
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close();
              onEdit();
            }}
          >
            Edit banner…
          </MenuItem>
          {b.status === 'draft' ? (
            <MenuItem
              onSelect={() => {
                close();
                void onStatus(b, 'live');
              }}
            >
              Turn on
            </MenuItem>
          ) : b.status === 'live' ? (
            <MenuItem
              onSelect={() => {
                close();
                void onStatus(b, 'draft');
              }}
            >
              Back to draft
            </MenuItem>
          ) : (
            <MenuItem
              onSelect={() => {
                close();
                void onStatus(b, 'draft');
              }}
            >
              Restore to draft
            </MenuItem>
          )}
          {b.status !== 'archived' ? (
            <>
              <MenuSeparator />
              <MenuItem
                critical
                onSelect={() => {
                  close();
                  void onStatus(b, 'archived');
                }}
              >
                Archive
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}

function BannerModal({
  banner,
  onClose,
  onDone,
}: {
  banner: MarketingBanner | null;
  onClose: () => void;
  onDone: (next: MarketingBanner) => void;
}) {
  const toast = useToast();
  const creating = banner === null;

  const [title, setTitle] = useState(banner?.title ?? '');
  const [body, setBody] = useState(banner?.body ?? '');
  const [ctaText, setCtaText] = useState(banner?.ctaText ?? '');
  const [ctaUrl, setCtaUrl] = useState(banner?.ctaUrl ?? '');
  const [placement, setPlacement] = useState<MarketingBanner['placement']>(
    banner?.placement ?? 'top_bar',
  );
  const [startsAt, setStartsAt] = useState(toLocalInput(banner?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(banner?.endsAt ?? null));
  const [priority, setPriority] = useState(String(banner?.priority ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit() {
    setError(null);
    if (!title.trim()) {
      setError('A banner needs a title.');
      return;
    }
    const hasText = ctaText.trim() !== '';
    const hasUrl = ctaUrl.trim() !== '';
    if (hasText !== hasUrl) {
      setError('A call to action needs both its words and its link — or neither.');
      return;
    }
    const startMs = parseWhen(startsAt);
    const endMs = parseWhen(endsAt);
    if (startMs !== null && endMs !== null && endMs <= startMs) {
      setError('The end has to come after the start.');
      return;
    }
    const prio = Number(priority);
    if (!Number.isInteger(prio) || prio < 0) {
      setError('Priority is a whole number of zero or more — higher shows first.');
      return;
    }

    const draft: BannerDraft = {
      title: title.trim(),
      body: body.trim(),
      ctaText: hasText ? ctaText.trim() : null,
      ctaUrl: hasUrl ? ctaUrl.trim() : null,
      placement,
      startsAt: startMs,
      endsAt: endMs,
      priority: prio,
    };

    setBusy(true);
    try {
      if (creating) {
        const created = await marketingApi.createBanner(draft);
        toast.show(`“${created.title}” created as a draft`);
        onDone(created);
      } else {
        const patched = await marketingApi.patchBanner(banner.id, {
          expectedRevision: banner.revision,
          ...draft,
        });
        toast.show(`“${patched.title}” saved`);
        onDone(patched);
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={creating ? 'Create banner' : `Edit “${banner.title}”`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" busy={busy} onClick={() => void commit()}>
            {creating ? 'Create banner' : 'Save banner'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Title" value={title} placeholder="Free Abuja delivery this week" autoFocus onChange={(e) => setTitle(e.target.value)} />
        <TextArea
          label="Body"
          rows={2}
          value={body}
          hint="One sentence — a banner is a strip, not a page."
          onChange={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField label="Button text" value={ctaText} placeholder="Shop now" onChange={(e) => setCtaText(e.target.value)} />
          </div>
          <div style={{ flex: 1.4 }}>
            <TextField
              label="Button link"
              value={ctaUrl}
              placeholder="/products or a full URL"
              className="input mono"
              spellCheck={false}
              onChange={(e) => setCtaUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <SelectField
              label="Placement"
              value={placement}
              onChange={(e) => setPlacement(e.target.value as MarketingBanner['placement'])}
            >
              <option value="top_bar">Top bar</option>
              <option value="popup">Popup</option>
              <option value="section">Section</option>
            </SelectField>
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="Priority"
              type="number"
              min={0}
              step={1}
              value={priority}
              hint="Higher shows first when two overlap."
              onChange={(e) => setPriority(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <div style={{ flex: 1 }}>
            <TextField
              label="Starts"
              type="datetime-local"
              value={startsAt}
              hint="Empty starts the moment it is on."
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <TextField
              label="Ends"
              type="datetime-local"
              value={endsAt}
              hint="Empty runs until somebody turns it off."
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <span className="field__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
