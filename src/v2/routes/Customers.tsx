import { useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { shopApi, type ShopBuyer } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, money, orderTone, shortDate } from '../lib/format';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { PeopleArt } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';

/**
 * CUSTOMERS — buyers, which is not the same list as accounts.
 *
 * A row is a folded email address and every order placed against it, guest
 * checkouts included. `customerId` is null for most of them, and that is the
 * ordinary case rather than an error: somebody who bought without registering
 * is still a customer, and the support call about their order arrives the same
 * way. The "Account" column says which is which because the two behave
 * differently everywhere else in the app.
 */
export default function Customers() {
  const [shown, toggle] = useAnalyticsBar('customers');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  const { data, error, loading } = useAsync(
    (signal) => shopApi.listCustomers({ ...(cursor ? { cursor } : {}), limit: 25 }, signal),
    [cursor],
  );

  const all = data?.items ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (b) => b.email.toLowerCase().includes(q) || (b.displayName ?? '').toLowerCase().includes(q),
    );
  }, [all, search]);

  const metrics: Metric[] = useMemo(() => {
    const currency = all[0]?.currency ?? 'NGN';
    const spend = all.reduce((sum, b) => sum + b.totalSpent, 0);
    const returning = all.filter((b) => b.paidCount > 1).length;
    return [
      { label: 'Customers on this page', value: String(all.length) },
      { label: 'Total spend', value: money(spend, currency) },
      { label: 'Repeat buyers', value: String(returning) },
      {
        label: 'With an account',
        value: String(all.filter((b) => b.customerId !== null).length),
      },
    ];
  }, [all]);

  const columns: Column<ShopBuyer>[] = [
    {
      key: 'buyer',
      header: 'Customer',
      primary: true,
      render: (b) => (
        <IdCell
          thumb={<Users aria-hidden="true" />}
          title={b.displayName || b.email}
          meta={b.displayName ? b.email : undefined}
        />
      ),
    },
    {
      key: 'account',
      header: 'Account',
      label: 'Account',
      tight: true,
      render: (b) =>
        b.customerId ? <Badge tone="info">Registered</Badge> : <Badge>Guest</Badge>,
    },
    { key: 'orders', header: 'Orders', label: 'Orders', numeric: true, render: (b) => b.orderCount },
    { key: 'paid', header: 'Paid', label: 'Paid', numeric: true, render: (b) => b.paidCount },
    {
      key: 'spent',
      header: 'Spent',
      label: 'Spent',
      numeric: true,
      render: (b) => <strong className="num">{money(b.totalSpent, b.currency)}</strong>,
    },
    {
      key: 'last',
      header: 'Last order',
      label: 'Last order',
      render: (b) => (
        <span className="row" style={{ gap: 'var(--s2)' }}>
          <span className="mono">{b.lastOrderNumber}</span>
          <Badge tone={orderTone(b.lastOrderStatus)}>{humanise(b.lastOrderStatus)}</Badge>
          <span className="muted">{shortDate(b.lastOrderAt)}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Users />}
        title="Customers"
        subtitle="Everyone who has checked out, registered or not."
        menu={(close) => <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />}
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load customers">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Customers"
        columns={columns}
        rows={rows}
        rowKey={(b) => b.email}
        loading={loading}
        search={{
          value: search,
          placeholder: 'Filter the customers on this page',
          onChange: setSearch,
        }}
        empty={
          (
            <EmptyState
              icon={search ? <Users /> : undefined}
              art={search ? undefined : <PeopleArt />}
              title={search ? 'No customers match that filter' : 'No customers yet'}
              body={
                search
                  ? 'The filter only searches the customers on this page.'
                  : 'Anyone who completes a checkout appears here, whether or not they registered.'
              }
              actions={search ? <Button onClick={() => setSearch('')}>Clear filter</Button> : null}
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
    </div>
  );
}
