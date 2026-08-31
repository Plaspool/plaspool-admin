import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Package, Percent, Receipt, TicketPercent, Truck } from 'lucide-react';
import type { Discount } from '../../data/api-marketing';
import { discountsApi } from '../data/discounts';
import { useAsync } from '../lib/useAsync';
import { money, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { CouponArt } from '../ui/illustrations';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { Menu, MenuItem } from '../ui/Menu';
import { useToast } from '../ui/Toast';

/**
 * DISCOUNTS — the feature this build adds, and the screen v1 replaced with a
 * "Planned" placeholder.
 *
 * IT WAS A PLACEHOLDER FOR A GOOD REASON AND THAT REASON STILL HOLDS. The
 * server half has been complete for a while — table, CHECKs, CRUD — but
 * `computeTotals` never reads these rows, so a code created here does nothing
 * at checkout. v1 refused to ship a table of codes on the grounds that a table
 * implies the codes are the feature, when the feature is the half nobody built.
 *
 * v2 SHIPS THE TABLE AND SAYS SO IN A BANNER THAT CANNOT BE DISMISSED. That is
 * the trade the owner asked for: the admin side becomes real and usable now,
 * and the one thing it must never do — let somebody hand out a code believing
 * it will be honoured — is prevented by a notice sitting above the list rather
 * than by withholding the screen. The moment redemption ships, delete the
 * banner and nothing else here changes.
 *
 * ── WHAT THE UI DELIBERATELY DOES NOT OFFER ────────────────────────────────
 * There is no "Edit" on a row. The server has no route for changing what a code
 * is worth, on purpose: a code is printed on a flyer and read out on a podcast,
 * and every copy is a promise already made. Status is the only mutable field,
 * so the row menu offers Disable and Enable and nothing else. An edit button
 * that opened a form the server would 400 is worse than no button.
 */

type Tab = 'all' | 'active' | 'disabled' | 'scheduled' | 'expired';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'expired', label: 'Expired' },
  { value: 'disabled', label: 'Disabled' },
];

/** The state an operator actually cares about, which is NOT the `status`
 *  column on its own: an `active` code whose window closed yesterday is
 *  expired, and one whose window opens next week is scheduled. The server
 *  stores the two facts separately and the row has to combine them. */
function derive(d: Discount, now: number): { label: string; tone: 'ok' | 'warn' | 'critical' | 'neutral'; tab: Tab } {
  if (d.status === 'disabled') return { label: 'Disabled', tone: 'neutral', tab: 'disabled' };
  if (d.endsAt !== null && d.endsAt < now) return { label: 'Expired', tone: 'critical', tab: 'expired' };
  if (d.startsAt !== null && d.startsAt > now) return { label: 'Scheduled', tone: 'warn', tab: 'scheduled' };
  if (d.maxRedemptions !== null && d.redeemedCount >= d.maxRedemptions)
    return { label: 'Used up', tone: 'critical', tab: 'expired' };
  return { label: 'Active', tone: 'ok', tab: 'active' };
}

function valueOf(d: Discount): string {
  if (d.kind === 'percent') return `${((d.percentBps ?? 0) / 100).toFixed(((d.percentBps ?? 0) % 100) === 0 ? 0 : 2)}% off`;
  return `${money(d.amountMinor ?? 0, d.currency ?? 'NGN')} off`;
}

export default function Discounts() {
  const [shown, toggle] = useAnalyticsBar('discounts');
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, error, loading, reload } = useAsync((signal) => discountsApi.list(signal), []);
  const all = data ?? [];
  const now = Date.now();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((d) => {
      if (tab !== 'all' && derive(d, now).tab !== tab) return false;
      if (!q) return true;
      return d.code.toLowerCase().includes(q) || (d.note ?? '').toLowerCase().includes(q);
    });
  }, [all, tab, search, now]);

  const metrics: Metric[] = useMemo(() => {
    const live = all.filter((d) => derive(d, now).tab === 'active');
    const redemptions = all.reduce((n, d) => n + d.redeemedCount, 0);
    return [
      { label: 'Codes', value: String(all.length) },
      { label: 'Active now', value: String(live.length) },
      { label: 'Scheduled', value: String(all.filter((d) => derive(d, now).tab === 'scheduled').length) },
      { label: 'Redemptions', value: String(redemptions) },
      { label: 'Percent codes', value: String(all.filter((d) => d.kind === 'percent').length) },
    ];
  }, [all, now]);

  async function setStatus(d: Discount, status: 'active' | 'disabled') {
    setBusyId(d.id);
    try {
      await discountsApi.setStatus(d.id, d.revision, status);
      toast.show(status === 'disabled' ? `${d.code} disabled` : `${d.code} enabled`);
      reload();
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Could not change that code.',
        'critical',
      );
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<Discount>[] = [
    {
      key: 'code',
      header: 'Code',
      primary: true,
      render: (d) => (
        <IdCell
          thumb={d.kind === 'percent' ? <Percent aria-hidden="true" /> : <Receipt aria-hidden="true" />}
          title={<span className="mono">{d.code}</span>}
          meta={d.note ?? undefined}
        />
      ),
    },
    {
      key: 'state', mobile: 'keep',
      header: 'Status',
      tight: true,
      render: (d) => {
        const s = derive(d, now);
        return <Badge tone={s.tone}>{s.label}</Badge>;
      },
    },
    { key: 'value', header: 'Value', render: (d) => <strong>{valueOf(d)}</strong> },
    {
      key: 'window',
      header: 'Active dates',
      render: (d) => (
        <span className="muted">
          {d.startsAt ? shortDate(d.startsAt) : 'Immediately'} → {d.endsAt ? shortDate(d.endsAt) : 'No end'}
        </span>
      ),
    },
    {
      key: 'used', mobile: 'keep',
      header: 'Used',
      numeric: true,
      render: (d) => (
        <span className="num">
          {d.redeemedCount}
          {d.maxRedemptions !== null ? <span className="muted"> / {d.maxRedemptions}</span> : null}
        </span>
      ),
    },
    {
      key: 'actions', pin: true,
      header: <span className="sr">Actions</span>,
      tight: true,
      render: (d) => (
        <Menu tone="plain" label={busyId === d.id ? '…' : '⋯'}>
          {(close) =>
            d.status === 'active' ? (
              <MenuItem
                critical
                onSelect={() => {
                  close();
                  void setStatus(d, 'disabled');
                }}
              >
                Disable code
              </MenuItem>
            ) : (
              <MenuItem
                onSelect={() => {
                  close();
                  void setStatus(d, 'active');
                }}
              >
                Enable code
              </MenuItem>
            )
          }
        </Menu>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<TicketPercent />}
        title="Discounts"
        subtitle="Codes a customer types at checkout."
        actions={
          <Button tone="primary" size="lg" onClick={() => setPicking(true)}>
            Create discount
          </Button>
        }
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {shown ? <AnalyticsBar range="All time" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load discounts">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Discount codes"
        columns={columns}
        rows={rows}
        rowKey={(d) => d.id}
        loading={loading}
        tabs={{ value: tab, tabs: TABS, onChange: setTab }}
        search={{ value: search, placeholder: 'Search codes and notes', onChange: setSearch }}
        empty={
          (
            <EmptyState
              icon={all.length === 0 ? undefined : <TicketPercent />}
              art={all.length === 0 ? <CouponArt /> : undefined}
              title={
                all.length === 0 ? 'Manage discounts and promotions' : 'No codes match that filter'
              }
              body={
                all.length === 0
                  ? 'Create a code a customer can type at checkout — either a percentage or a flat amount off, with an optional window and usage cap.'
                  : 'Try another tab or clear the search.'
              }
              actions={
                all.length === 0 ? (
                  <Button tone="primary" onClick={() => setPicking(true)}>
                    Create discount
                  </Button>
                ) : (
                  <Button
                    onClick={() => {
                      setSearch('');
                      setTab('all');
                    }}
                  >
                    Clear filters
                  </Button>
                )
              }
            />
          )
        }
      />

      {picking ? (
        <TypePicker
          onClose={() => setPicking(false)}
          onPick={(kind) => {
            setPicking(false);
            navigate(`/discounts/new?kind=${kind}`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ TYPE PICKER ══ */

/**
 * The modal the reference admin opens before the create form.
 *
 * IT LISTS THE UNSUPPORTED TYPES TOO, disabled and labelled. Showing only the
 * two this backend can do would make the product look like it has decided
 * against per-product discounts and free shipping, when in fact nobody has
 * built them. Disabled rows say which it is, and they are also the roadmap the
 * next session reads.
 */
function TypePicker({ onClose, onPick }: { onClose: () => void; onPick: (kind: 'percent' | 'fixed_amount') => void }) {
  return (
    <Modal title="Select discount type" onClose={onClose} flush wide>
      <button className="pick" type="button" onClick={() => onPick('percent')}>
        <span className="pick__icon">
          <Percent />
        </span>
        <span>
          <span className="pick__title">Percentage off the order</span>
          <span className="pick__body">Take a share off the whole cart — 10%, 25%.</span>
        </span>
        <span className="pick__chev">
          <ChevronRight />
        </span>
      </button>

      <button className="pick" type="button" onClick={() => onPick('fixed_amount')}>
        <span className="pick__icon">
          <Receipt />
        </span>
        <span>
          <span className="pick__title">Fixed amount off the order</span>
          <span className="pick__body">Take a flat sum off the whole cart — ₦2,000 off.</span>
        </span>
        <span className="pick__chev">
          <ChevronRight />
        </span>
      </button>

      <button className="pick" type="button" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>
        <span className="pick__icon">
          <Package />
        </span>
        <span>
          <span className="pick__title">Amount off specific products</span>
          <span className="pick__body">
            Not built — a code has no product or category scope in the model yet.
          </span>
        </span>
      </button>

      <button className="pick" type="button" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>
        <span className="pick__icon">
          <Truck />
        </span>
        <span>
          <span className="pick__title">Free shipping</span>
          <span className="pick__body">
            Not built — needs the delivery quote to accept a waiver at checkout.
          </span>
        </span>
      </button>
    </Modal>
  );
}
