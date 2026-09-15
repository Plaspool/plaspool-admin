import { useMemo, useState } from 'react';
import { Boxes, Warehouse } from 'lucide-react';
import { shopApi, type InventoryRow } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';
import { TextField } from '../ui/Field';
import { PopEdit, PopEditFoot } from '../ui/PopEdit';
import { useToast } from '../ui/Toast';

/**
 * INVENTORY — `/products/inventory`. One row per variant: on hand, reserved,
 * and what is left to sell. NEGATIVE AVAILABLE IS LEGAL for a backorderable
 * variant — it is oversold on purpose, shown in the critical ink rather than
 * "fixed" by a floor.
 *
 * Adjustments happen in place. The reason is OPTIONAL since 2026-09-03 (owner's
 * instruction). THERE ARE TWO STOCK PANELS: this one and `StockCell` in
 * `ProductDetail.tsx`. PR #103 made only this one optional, and the owner met
 * the other still refusing a blank on 2026-09-15 — change them together.
 */

const TABS = [
  { value: 'all', label: 'All' },
  { value: 'low', label: 'Low stock' },
] as const;

type Tab = (typeof TABS)[number]['value'];

export default function Inventory() {
  const [shown, toggle] = useAnalyticsBar('inventory');
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const [nonce, setNonce] = useState(0);

  const { data, error, loading } = useAsync(
    (signal) =>
      shopApi.listInventory(
        {
          ...(tab === 'low' ? { belowOnly: true } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
        signal,
      ),
    [tab, cursor, nonce],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) => r.productTitle.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q),
    );
  }, [all, search]);

  const metrics: Metric[] = useMemo(
    () => [
      { label: 'Variants on this page', value: String(all.length) },
      { label: 'Units in stock', value: String(all.reduce((n, r) => n + r.onHand, 0)) },
      { label: 'Set aside', value: String(all.reduce((n, r) => n + r.reserved, 0)) },
      { label: 'Available', value: String(all.reduce((n, r) => n + r.available, 0)) },
      { label: 'Oversold', value: String(all.filter((r) => r.available < 0).length) },
    ],
    [all],
  );

  const reloadRows = () => setNonce((n) => n + 1);

  const columns: Column<InventoryRow>[] = [
    {
      key: 'variant',
      header: 'Variant',
      primary: true,
      render: (r) => (
        <IdCell
          thumb={<Boxes aria-hidden="true" />}
          title={
            <>
              {r.productTitle}
              {optionLabel(r.optionValues) ? (
                <span className="muted"> — {optionLabel(r.optionValues)}</span>
              ) : null}
            </>
          }
          meta={<span className="mono">{r.sku}</span>}
          href={`/products/${r.productId}`}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: (r) =>
        r.variantStatus === 'active' ? (
          <Badge tone="ok">Active</Badge>
        ) : (
          <Badge>{humanise(r.variantStatus)}</Badge>
        ),
    },
    {
      key: 'onHand', mobile: 'keep',
      header: 'In stock',
      label: 'In stock',
      numeric: true,
      render: (r) => <span className="num">{r.onHand}</span>,
    },
    {
      key: 'reserved',
      header: 'Set aside',
      label: 'Set aside',
      numeric: true,
      render: (r) => <span className="num muted">{r.reserved}</span>,
    },
    {
      key: 'available', mobile: 'keep',
      header: 'Available',
      label: 'Available',
      numeric: true,
      render: (r) => <AdjustCell row={r} onWrite={reloadRows} />,
    },
    {
      key: 'backorder',
      header: 'Backorder',
      label: 'Backorder',
      tight: true,
      render: (r) =>
        r.backorderable ? <Badge tone="info">Allowed</Badge> : <span className="muted">—</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      label: 'Updated',
      render: (r) => shortDate(r.updatedAt),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Warehouse />}
        title="Inventory"
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load inventory">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Inventory"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.variantId}
        hrefFor={(r) => `/products/${r.productId}`}
        loading={loading}
        tabs={{
          value: tab,
          tabs: [...TABS],
          onChange: (next) => {
            setCursors([null]);
            setTab(next);
          },
        }}
        search={{
          value: search,
          placeholder: 'Filter the variants on this page',
          onChange: setSearch,
        }}
        empty={
          search ? (
            <EmptyState
              icon={<Boxes />}
              title="No variants match that filter"
              body="This only searches the variants on this page."
              actions={<Button onClick={() => setSearch('')}>Clear filter</Button>}
            />
          ) : tab === 'low' ? (
            <EmptyState
              icon={<Boxes />}
              title="Nothing is low on stock"
              body="Variants at or below your low stock level show up here."
            />
          ) : (
            <EmptyState
              icon={<Boxes />}
              title="No inventory yet"
              body="Each variant has its own stock count. Add products and variants to see them here."
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

      <p className="page__learn">
        Set aside means held for carts being paid for and orders not yet shipped. Available is what is in stock
        minus reserved.
      </p>
    </div>
  );
}

/** Top-level, not nested in the screen — a component defined inside another
 *  gets a fresh identity per parent render, and this one holds an open
 *  popover's draft. */
function AdjustCell({ row, onWrite }: { row: InventoryRow; onWrite: () => void }) {
  const toast = useToast();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = Number(delta);
  const deltaOk = delta.trim() !== '' && Number.isInteger(parsed) && parsed !== 0;

  async function commit(close: () => void) {
    if (!deltaOk) {
      setFieldError('Enter a whole number, above or below zero — but not zero.');
      return;
    }
    setBusy(true);
    try {
      /* NO REASON GUARD. It is optional since 2026-09-03 (owner's instruction);
       * the placeholder still asks, and `adjustInventory` omits the key rather
       * than sending an empty string. */
      const res = await shopApi.adjustInventory(row.variantId, parsed, reason.trim());
      toast.show(`${row.sku} — ${res.available} available`);
      close();
      onWrite();
    } catch (cause) {
      setFieldError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <PopEdit
      ariaLabel={`Adjust stock of ${row.sku}`}
      value={
        <span className="num" style={row.available < 0 ? { color: 'var(--critical)' } : undefined}>
          {row.available}
        </span>
      }
    >
      {(close) => (
        <>
          <TextField
            label="Adjust by"
            type="number"
            step={1}
            placeholder="+5 or -2"
            value={delta}
            autoFocus
            hint={
              deltaOk
                ? `Available ${row.available} → ${row.available + parsed}`
                : row.backorderable
                  ? 'Can be back-ordered, so stock is allowed to go below zero.'
                  : undefined
            }
            onChange={(e) => {
              setDelta(e.target.value);
              setFieldError(null);
            }}
          />
          <TextField
            label="Reason (optional)"
            value={reason}
            placeholder="Stock count, damage, correction…"
            hint="Kept on record. Worth a few words if you have them."
            error={fieldError}
            onChange={(e) => {
              setReason(e.target.value);
              setFieldError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(close);
            }}
          />
          <PopEditFoot>
            <Button tone="plain" onClick={close}>
              Cancel
            </Button>
            <Button tone="primary" busy={busy} onClick={() => void commit(close)}>
              Adjust
            </Button>
          </PopEditFoot>
        </>
      )}
    </PopEdit>
  );
}

function optionLabel(values: Record<string, string>): string | null {
  const parts = Object.values(values).filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}
