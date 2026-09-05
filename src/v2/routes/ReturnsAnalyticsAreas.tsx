import { useState } from 'react';
import { BarChart3, Lock, MapPin } from 'lucide-react';
import {
  marketingApi,
  RETURN_ANALYTICS_DEFAULT,
  type ReturnAnalyticsRange,
  type ReturnCostArea,
} from '../../data/api-marketing';
import { useAsync } from '../lib/useAsync';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { Segmented } from '../ui/Field';

/**
 * WHAT ITEMS COST US, BY DISTRICT — `/orders/returns/analytics/areas`.
 *
 * The table half of the split the shop's analytics already set: the charts
 * live on the parent page, and this is the whole list, DEAREST FIRST.
 *
 * DEAREST FIRST IS THE POINT OF THE PAGE. The headline on the parent screen
 * tells you what the programme costs; this tells you WHERE, which is the only
 * one of the two you can act on — a district running at twice the average is a
 * conversation with a driver, or a standard that was never corrected.
 *
 * OWN STATE, OWN FETCH, like `AnalyticsProducts` — a range picked here does
 * not follow the parent's, so the year's table and the month's charts can sit
 * open in two tabs without one clobbering the other.
 *
 * NO PRODUCT NOUN (spec D11): the programme's unit word is data and this
 * aggregate does not carry it, so the copy says "item" throughout.
 */

const RANGES: { value: ReturnAnalyticsRange; label: string }[] = [
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '365', label: '1y' },
  { value: 'all', label: 'All time' },
];

const CURRENCY = 'NGN';

export default function ReturnsAnalyticsAreas() {
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  /* The ORDERS domain, matching the API's own gate — see the parent screen. */
  const allowed = viewer !== null && hasDomain(viewer.role, 'orders');
  const [range, setRange] = useState<ReturnAnalyticsRange>(RETURN_ANALYTICS_DEFAULT);
  const { data, error, loading, reload } = useAsync(
    (signal) => (allowed ? marketingApi.returnAnalytics(range, signal) : Promise.resolve(null)),
    [range, allowed],
  );

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader
          icon={<Lock />}
          title="By district"
          backTo="/orders/returns/analytics"
          backLabel="What items cost us"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don’t have access to this"
            body="Returns are for the owner, developers, and the operations and support teams."
          />
        </div>
      </div>
    );
  }

  const rows = data?.byArea ?? [];
  /* The line every row is read against. Computed over the SAME rows the table
     shows, so "above average" always means above the average of what is on
     screen — never of a window the reader is not looking at. */
  const keptTotal = rows.reduce((n, r) => n + r.unitsKept, 0);
  const allInTotal = rows.reduce((n, r) => n + r.allInMinor, 0);
  const average = keptTotal === 0 ? 0 : Math.round(allInTotal / keptTotal);

  const columns: Column<ReturnCostArea>[] = [
    {
      key: 'district',
      header: 'District',
      primary: true,
      render: (r) => (
        <IdCell
          thumb={<MapPin aria-hidden="true" />}
          /* The out-of-area group is the ABSENCE of a district, not a place —
             so it is named as what it is rather than given a blank cell. */
          title={r.name ?? 'Out of area'}
          meta={r.region ?? 'Belongs to no board'}
        />
      ),
    },
    {
      key: 'pickups',
      header: 'Pickups',
      label: 'Pickups',
      numeric: true,
      render: (r) => (
        <span className="num">
          {r.returns}
          {r.estimated > 0 ? (
            <span className="muted" title="Pickups with no figures typed — the district standard stood in">
              {' '}
              ({r.estimated} est.)
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'kept',
      header: 'Items kept',
      label: 'Items kept',
      numeric: true,
      render: (r) => <span className="num">{r.unitsKept.toLocaleString()}</span>,
    },
    {
      key: 'paid',
      header: 'Paid out',
      label: 'Paid out',
      numeric: true,
      render: (r) => <span className="num muted">{money(r.rewardMinor, CURRENCY)}</span>,
    },
    {
      key: 'fetch',
      header: 'Fetching them',
      label: 'Fetching them',
      numeric: true,
      render: (r) => <span className="num muted">{money(r.collectionMinor, CURRENCY)}</span>,
    },
    {
      key: 'perUnit',
      header: 'Per item',
      label: 'Per item',
      numeric: true,
      mobile: 'keep',
      render: (r) => {
        if (r.unitsKept === 0) {
          /* Spending with nothing to divide it by. Rendering ₦0 would put the
             cheapest-looking row on a district that kept nothing at all. */
          return <span className="muted">nothing kept</span>;
        }
        /* A fifth over the average is the threshold, so ordinary variation
           does not paint the whole column red. */
        const dear = average > 0 && r.perUnitMinor > average * 1.2;
        return (
          <strong className="num">
            {money(r.perUnitMinor, CURRENCY)}{' '}
            {dear ? <Badge tone="warn">above average</Badge> : null}
          </strong>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        backTo="/orders/returns/analytics"
        backLabel="What items cost us"
        title="By district"
        subtitle="Everything we spent getting items in, district by district, dearest first."
        actions={
          <Segmented
            label="Range"
            value={range}
            options={RANGES}
            onChange={(next) => setRange(next as ReturnAnalyticsRange)}
          />
        }
      />

      {error ? (
        <Banner
          tone="critical"
          title="Couldn’t load these figures"
          action={<Button onClick={reload}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : (
        <DataTable
          caption="What items cost us, by district"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.areaId ?? 'out-of-area'}
          loading={loading}
          empty={
            <EmptyState
              icon={<MapPin />}
              title="Nothing settled in this period yet"
              body="A district appears here once one of its pickups has been paid out or turned away."
            />
          }
          footer={
            rows.length > 0 ? (
              <div className="tfoot">
                <span>
                  {money(average, CURRENCY)} an item across every district in this period. A
                  district marked <em>est.</em> had pickups with no figures written down — its
                  standard cost stood in for those, so read that row as an estimate.
                </span>
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
