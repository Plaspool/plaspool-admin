import { useMemo, useState } from 'react';
import { Inbox, ShoppingBag } from 'lucide-react';
import { shopApi, type OrderStatus, type ShopOrderRow } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { money, orderTone, shortAddress, shortDate } from '../lib/format';
import { orderStatusLabel } from './manual-order-copy';
import { AnalyticsBar, AnalyticsMenuItem, PageHeader, useAnalyticsBar, type Metric } from '../ui/Page';
import { Badge, Button, ButtonLink, EmptyState, Banner } from '../ui/primitives';
import { ReceiptArt } from '../ui/illustrations';
import { DataTable, IdCell, TablePager, type Column } from '../ui/DataTable';

/**
 * ORDERS — the canonical v2 list screen, and the one every other list copies.
 *
 * The shape is: header, then (optionally) the analytics bar, then ONE table
 * whose filters live inside its own card. Nothing else. The v1 screen carried a
 * section rail, a stat row and a board switcher above the same rows; this one
 * puts everything that is not the list behind More actions.
 */

const TABS: { value: OrderStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
  { value: 'fulfilled', label: 'Sent out' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function Orders() {
  const [shown, toggle] = useAnalyticsBar('orders');
  const [tab, setTab] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  /* A stack of cursors rather than a page number, because the endpoint is
     cursor-paged and has no total. The stack is what makes Back work: the
     server gives you the NEXT cursor and never the previous one. */
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  const { data, error, loading } = useAsync(
    (signal) =>
      shopApi.listOrders(
        {
          ...(tab === 'all' ? {} : { status: tab }),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
        signal,
      ),
    [tab, search, cursor],
  );

  const rows = data?.items ?? [];

  const metrics = useMemo<Metric[]>(() => {
    const paid = rows.filter((r) => r.order.paidAt !== null);
    const currency = rows[0]?.order.currency ?? 'NGN';
    /* Item prices only — the frozen subtotal — never the grand total, which
       carries delivery and VAT; those are their own tile (owner, 2026-09-06). */
    const sales = paid.reduce((sum, r) => sum + r.order.subtotal, 0);
    const extras = paid.reduce((sum, r) => sum + r.order.shippingTotal + r.order.taxTotal, 0);
    const items = rows.reduce((sum, r) => sum + r.lines.reduce((n, l) => n + l.qty, 0), 0);
    const refunded = rows.reduce((sum, r) => sum + r.order.refundedTotal, 0);
    return [
      { label: 'Orders', value: String(rows.length) },
      { label: 'Items ordered', value: String(items) },
      { label: 'Product sales', value: money(sales, currency) },
      { label: 'Delivery & VAT', value: money(extras, currency) },
      { label: 'Refunded', value: money(refunded, currency) },
      { label: 'Sent out', value: String(rows.filter((r) => r.order.fulfilledAt !== null).length) },
    ];
  }, [rows]);

  const columns: Column<ShopOrderRow>[] = [
    {
      key: 'order',
      header: 'Order',
      primary: true,
      render: ({ order }) => (
        <IdCell
          title={<span className="mono">{order.orderNumber}</span>}
          meta={
            /* A sale recorded by hand is marked, so it is never mistaken for
               one the checkout took — and it may have no email at all. */
            order.source === 'manual' ? (
              <>
                <Badge dot={false}>Manual</Badge>
                {order.email ? ` ${order.email}` : ''}
              </>
            ) : (
              order.email
            )
          }
          href={`/orders/${order.id}`}
        />
      ),
    },
    { key: 'date', header: 'Date', label: 'Date', render: ({ order }) => shortDate(order.placedAt) },
    {
      key: 'status', mobile: 'keep',
      header: 'Status',
      label: 'Status',
      tight: true,
      render: ({ order }) => <Badge tone={orderTone(order.status)}>{orderStatusLabel(order)}</Badge>,
    },
    {
      key: 'items',
      header: 'Items',
      label: 'Items',
      numeric: true,
      render: ({ lines }) => lines.reduce((n, l) => n + l.qty, 0),
    },
    {
      key: 'destination',
      header: 'Destination',
      label: 'Destination',
      render: ({ order }) => <span className="muted">{shortAddress(order.shippingAddress)}</span>,
    },
    {
      key: 'total', mobile: 'keep',
      header: 'Total',
      label: 'Total',
      numeric: true,
      render: ({ order }) => (
        <strong className="num">{money(order.grandTotal, order.currency)}</strong>
      ),
    },
  ];

  function resetPaging<T>(apply: () => T) {
    setCursors([null]);
    return apply();
  }

  return (
    <div className="page">
      <PageHeader
        icon={<ShoppingBag />}
        title="Orders"
        menu={(close) => (
          <AnalyticsMenuItem shown={shown} onToggle={toggle} close={close} />
        )}
        actions={
          <ButtonLink to="/orders/new" tone="primary" size="lg">
            New order
          </ButtonLink>
        }
      />

      {shown ? <AnalyticsBar range="This page" metrics={metrics} /> : null}

      {error ? (
        <Banner tone="critical" title="Couldn’t load orders">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Orders"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.order.id}
        hrefFor={(r) => `/orders/${r.order.id}`}
        loading={loading}
        tabs={{ value: tab, tabs: TABS, onChange: (next) => resetPaging(() => setTab(next)) }}
        search={{
          value: search,
          placeholder: 'Search by order number or email',
          onChange: (next) => resetPaging(() => setSearch(next)),
        }}
        empty={
          (
            <EmptyState
              icon={search || tab !== 'all' ? <Inbox /> : undefined}
              art={search || tab !== 'all' ? undefined : <ReceiptArt />}
              title={search || tab !== 'all' ? 'No orders match' : 'Your orders will show here'}
              body={
                search || tab !== 'all'
                  ? 'Try a different filter or clear the search.'
                  : 'This is where you send out orders, take payments and follow their progress.'
              }
              actions={
                search || tab !== 'all' ? (
                  <Button
                    onClick={() =>
                      resetPaging(() => {
                        setSearch('');
                        setTab('all');
                      })
                    }
                  >
                    Clear filters
                  </Button>
                ) : null
              }
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

      {/* This line claimed order detail was "still on the v1 screen" for four
          rounds after it stopped being true — caught by the mobile pass's
          screenshot, not by anyone reading the code. Copy states the actual
          affordance now. */}
      <p className="page__learn">
        Open an order to send it out, refund it, or see everything that has happened to it.
      </p>
    </div>
  );
}
