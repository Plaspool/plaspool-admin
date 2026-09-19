import { useMemo, useState } from 'react';
import { Inbox, RefreshCw, ShoppingBag } from 'lucide-react';
import {
  shopApi,
  type OrderSource,
  type OrderStatus,
  type ShopOrderRow,
  type SweepRun,
} from '../../data/api-shop';
import { getSession } from '../../data/session';
import { isAdminRole } from '../../../shared/roles';
import { useToast } from '../ui/Toast';
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

/** The second dimension, beside the status tabs: where the order came from. */
const SOURCES: { value: OrderSource | 'all'; label: string }[] = [
  { value: 'all', label: 'All orders' },
  { value: 'online', label: 'From the shop' },
  { value: 'manual', label: 'Recorded by hand' },
];

const TABS: { value: OrderStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Unpaid' },
  { value: 'paid', label: 'Paid' },
  { value: 'fulfilled', label: 'Sent out' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * What to tell the operator one Refresh status found.
 *
 * A PURE FUNCTION, OUTSIDE THE COMPONENT, because it is the part with all the
 * cases in it and the only part worth asserting on directly.
 *
 * `null` IS NOT ZERO, and the distinction is the whole reason this is not a
 * one-liner. `intents: null` means no gateway is configured on this deployment —
 * we did not ask — and reporting that as "nothing found" would tell an owner
 * their payments had been checked when nothing of the kind happened. The same
 * goes for couriers. Both absent is a deployment that has nothing to check, and
 * it says so.
 *
 * ALWAYS NAMES WHAT MOVED, and says plainly when nothing did: "nothing new" is a
 * useful answer to "the gateway shows a payment and my admin doesn't" — it means
 * the money is genuinely not there and the problem is elsewhere.
 */
export function sweepReport(res: SweepRun): { text: string; critical: boolean } {
  const intents = res.intents ?? null;
  const couriers = res.couriers ?? null;
  if (intents === null && couriers === null) {
    return { text: 'Nothing to check — no gateway or courier is set up here.', critical: false };
  }

  /* THE PASS COULD NOT EVEN WORK OUT WHAT TO ASK ABOUT — reported first and on
     its own, because every count below it is then meaningless rather than zero,
     and "nothing new" would be a lie about payments nobody looked at. */
  if (intents?.error) {
    return {
      text: 'Couldn’t check the payments — the gateway list couldn’t be read. Parcels and emails were still swept.',
      critical: true,
    };
  }

  const paid = intents?.captured ?? 0;
  /* Changed but not captured: a payment the gateway now calls failed or
     cancelled. Worth reporting — it is still the screen catching up — but not as
     money found. */
  const otherMoves = Math.max(0, (intents?.changed ?? 0) - paid);
  const parcels = couriers?.transitioned ?? 0;
  const failed = (intents?.failed ?? 0) + (couriers?.failed ?? 0);

  const moved: string[] = [];
  if (paid > 0) moved.push(paid === 1 ? '1 payment had gone through' : `${paid} payments had gone through`);
  if (otherMoves > 0) {
    moved.push(otherMoves === 1 ? '1 payment changed' : `${otherMoves} payments changed`);
  }
  if (parcels > 0) moved.push(parcels === 1 ? '1 parcel moved' : `${parcels} parcels moved`);

  /* A gateway or courier we could not reach is the half the operator has to act
     on, so it is `critical` even when something else did move — the reason is on
     the payment or the parcel. */
  const couldNotAsk =
    failed > 0
      ? `${failed === 1 ? '1 couldn’t be reached' : `${failed} couldn’t be reached`} — the reason is on the payment or the parcel.`
      : '';

  if (moved.length === 0) {
    return {
      text: couldNotAsk
        ? `Nothing new. ${couldNotAsk}`
        : 'Nothing new — the gateway and the couriers agree with what’s here.',
      critical: failed > 0,
    };
  }

  const list =
    moved.length === 1 ? moved[0] : `${moved.slice(0, -1).join(', ')} and ${moved[moved.length - 1]}`;
  return {
    text: couldNotAsk ? `${list}. ${couldNotAsk}` : `${list} — this page is up to date now.`,
    critical: failed > 0,
  };
}

export default function Orders() {
  const toast = useToast();
  const [shown, toggle] = useAnalyticsBar('orders');
  const [tab, setTab] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<OrderSource | 'all'>('all');
  const [syncing, setSyncing] = useState(false);
  /* A stack of cursors rather than a page number, because the endpoint is
     cursor-paged and has no total. The stack is what makes Back work: the
     server gives you the NEXT cursor and never the previous one. */
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;

  /* Owner-grade only, mirroring `requireAdmin()` on `POST /admin/sweep`
     (shared/roles.ts) — a writer gets no button that leads to a 403. */
  const session = getSession();
  const isOwner = 'user' in session && session.user != null && isAdminRole(session.user.role);

  const { data, error, loading, reload } = useAsync(
    (signal) =>
      shopApi.listOrders(
        {
          ...(tab === 'all' ? {} : { status: tab }),
          ...(source === 'all' ? {} : { source }),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
        signal,
      ),
    [tab, search, source, cursor],
  );

  const rows = data?.items ?? [];
  /** Anything narrowing the list — what the empty state offers to clear. */
  const filtered = Boolean(search) || tab !== 'all' || source !== 'all';

  /**
   * ASK THE GATEWAYS AND THE COURIERS, THEN CATCH THIS PAGE UP.
   *
   * WHY THIS BUTTON IS ON THE LIST AND NOT ONLY ON AN ORDER. A capture whose
   * webhook was lost leaves NO ORDER AT ALL — the intent never moves, the
   * checkout never completes, `shop_orders` never gets a row — so there is no
   * detail screen to press a button on and nothing on this list to click. This is
   * the only place the recovery can start from.
   *
   * IT IS `POST /admin/sweep`, the same route the ten-minute cron calls, rather
   * than a second endpoint that does the same work. That is deliberate: a repair
   * path that is not the scheduled path is a repair path nobody exercises. The
   * pass asks both gateways about payments that could still have taken money,
   * asks every courier where its parcels are, drains what it finds, and sends the
   * mail it queued.
   */
  async function refreshStatus() {
    setSyncing(true);
    try {
      const report = sweepReport(await shopApi.sweepNow());
      toast.show(report.text, report.critical ? 'critical' : undefined);
    } catch (cause) {
      toast.show(
        cause instanceof Error && cause.message ? cause.message : 'Something went wrong.',
        'critical',
      );
    } finally {
      /* Cleared before the reload, not after: the button is what the person is
         looking at, and leaving it busy while the table refetches reads as a
         click that did not land. */
      setSyncing(false);
    }
    reload();
  }

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
          <>
            {isOwner ? (
              <Button busy={syncing} onClick={() => void refreshStatus()} size="lg">
                <RefreshCw aria-hidden="true" />
                Refresh status
              </Button>
            ) : null}
            <ButtonLink to="/orders/new" tone="primary" size="lg">
              New order
            </ButtonLink>
          </>
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
        filter={{
          label: 'Where the order came from',
          value: source,
          options: SOURCES,
          onChange: (next) => resetPaging(() => setSource(next as OrderSource | 'all')),
        }}
        empty={
          (
            <EmptyState
              icon={filtered ? <Inbox /> : undefined}
              art={filtered ? undefined : <ReceiptArt />}
              title={filtered ? 'No orders match' : 'Your orders will show here'}
              body={
                filtered
                  ? 'Try a different filter or clear the search.'
                  : 'This is where you send out orders, take payments and follow their progress.'
              }
              actions={
                filtered ? (
                  <Button
                    onClick={() =>
                      resetPaging(() => {
                        setSearch('');
                        setTab('all');
                        setSource('all');
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
