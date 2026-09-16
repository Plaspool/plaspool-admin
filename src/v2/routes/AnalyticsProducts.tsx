import { useState } from 'react';
import { BarChart3, Lock, Package } from 'lucide-react';
import {
  analyticsApi,
  ANALYTICS_CURRENCY,
  ANALYTICS_DEFAULT_DAYS,
  type AnalyticsDays,
  type AnalyticsProductRow,
} from '../../data/api-shop-analytics';
import { useAsync } from '../lib/useAsync';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Segmented } from '../ui/Field';

/**
 * BEST SELLERS — `/analytics/products`. The table half of the analytics split:
 * the diagrams live on `/analytics`, and the owner asked for "a table in a
 * subpage different from the diagrams" — so this page is the whole list
 * (every seller in the window, best first, capped at 200 server-side), and
 * the parent page keeps only a five-bar teaser.
 *
 * OWN STATE, OWN FETCH. The range picked here does not follow the parent's —
 * a salesperson comparing "the year's table" against "the month's charts" in
 * two tabs must not have one range clobber the other, and the fetch is cheap
 * because the server aggregate is.
 *
 * The share column is the one computed number on the page, and it is computed
 * over the SAME rows it is shown beside — each product's gross over the sum
 * of every row's gross — so the column always sums to 100% of what the table
 * actually shows.
 */

/** Mirrors `ANALYTICS_RANGES` server-side — the route's `z.enum`. */
const RANGES: { value: '7' | '30' | '90' | '365'; label: string }[] = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '365', label: '1y' },
];

export default function AnalyticsProducts() {
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  const allowed = viewer !== null && hasDomain(viewer.role, 'analytics');
  const [days, setDays] = useState<AnalyticsDays>(ANALYTICS_DEFAULT_DAYS);
  const { data, error, loading, reload } = useAsync(
    (signal) => (allowed ? analyticsApi.get(days, signal) : Promise.resolve(null)),
    [days, allowed],
  );

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader
          icon={<Lock />}
          title="Best sellers"
          backTo="/analytics"
          backLabel="Analytics"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don’t have access to this"
            body="Analytics is for the owner, developers, and the operations and marketing teams."
          />
        </div>
      </div>
    );
  }

  const rows = data?.topProducts ?? [];
  const grossTotal = rows.reduce((n, r) => n + r.gross, 0);

  const columns: Column<AnalyticsProductRow>[] = [
    {
      key: 'product',
      header: 'Product',
      primary: true,
      render: (r) => (
        <IdCell
          thumb={<Package aria-hidden="true" />}
          title={r.title}
          meta={<span className="mono">{r.sku}</span>}
        />
      ),
    },
    {
      key: 'units',
      header: 'Units',
      label: 'Units',
      numeric: true,
      render: (r) => <span className="num">{r.units}</span>,
    },
    {
      key: 'gross',
      header: 'Total sales',
      label: 'Total sales',
      numeric: true,
      mobile: 'keep',
      render: (r) => <strong className="num">{money(r.gross, ANALYTICS_CURRENCY)}</strong>,
    },
    {
      key: 'cost',
      header: 'Cost',
      label: 'Cost',
      numeric: true,
      render: (r) =>
        r.cost === undefined || !r.costedUnits ? (
          <span className="muted">No cost</span>
        ) : (
          <span className="num">{money(r.cost, ANALYTICS_CURRENCY)}</span>
        ),
    },
    {
      key: 'profit',
      header: 'Profit',
      label: 'Profit',
      numeric: true,
      mobile: 'keep',
      /* Over the costed units only, with the margin beneath. A row where some
         units had no cost says so rather than reading as a clean figure. */
      render: (r) => {
        if (r.cost === undefined || !r.costedUnits || r.costedGross === undefined) {
          return <span className="muted">—</span>;
        }
        const profit = r.costedGross - r.cost;
        const margin = r.costedGross > 0 ? `${((profit / r.costedGross) * 100).toFixed(1)}%` : '—';
        const partial = r.costedUnits < r.units;
        return (
          <span className="num" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <strong style={profit < 0 ? { color: 'var(--critical)' } : undefined}>
              {money(profit, ANALYTICS_CURRENCY)}
            </strong>
            <span className="muted" style={{ fontSize: 'var(--t-xs)' }}>
              {margin}
              {partial ? ` · ${r.costedUnits} of ${r.units} costed` : ''}
            </span>
          </span>
        );
      },
    },
    {
      key: 'share',
      header: 'Share of sales',
      label: 'Share of sales',
      numeric: true,
      /* Of the range's summed gross, one decimal. Guarded: a window with rows
         but zero gross (free items) must not print NaN%. */
      render: (r) => (
        <span className="num muted">
          {grossTotal > 0 ? `${((r.gross / grossTotal) * 100).toFixed(1)}%` : '—'}
        </span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        backTo="/analytics"
        backLabel="Analytics"
        title="Best sellers"
        subtitle={`Every product that sold in the last ${days} days, best first.`}
        actions={
          <Segmented
            collapse
            label="Range"
            value={String(days) as (typeof RANGES)[number]['value']}
            options={RANGES}
            onChange={(next) => setDays(Number(next) as AnalyticsDays)}
          />
        }
      />

      {error ? (
        <Banner
          tone="critical"
          title="Couldn’t load best sellers"
          action={<Button onClick={reload}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : (
        <DataTable
          caption="Best sellers"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.variantId}
          loading={loading}
          empty={
            <EmptyState
              icon={<Package />}
              title="Nothing sold in this window yet"
              body="Products appear here, ranked by sales, as soon as a paid order comes in."
            />
          }
          footer={
            rows.length > 0 ? (
              <div className="tfoot">
                <span>
                  Total sales from paid orders in this period, before refunds. Profit is sales minus
                  what the items cost you, counted only for items with a cost. Refunds apply to whole
                  orders, so they are shown on the Analytics page rather than per product.
                </span>
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
