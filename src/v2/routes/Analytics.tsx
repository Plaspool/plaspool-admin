import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Package } from 'lucide-react';
import { shopApi, type ShopOrderRow, type ShopStats } from '../../data/api-shop';
import { humanise, money, orderTone, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { DataTable, IdCell, type Column } from '../ui/DataTable';

/**
 * ANALYTICS — `/analytics`. Reporting from what the server ALREADY answers:
 * `stats()` for the exact 30-day revenue (the server's own aggregate over
 * every order), and a client sweep of the most recent order pages for the
 * shapes the server does not aggregate yet — the daily series, the status
 * mix, the best sellers.
 *
 * THE HONESTY RULE, inherited from the summary bar: nothing on this screen
 * is fabricated. The revenue tile is the server's own number; everything
 * computed client-side names its basis, and if the sweep could not reach the
 * whole window the screen says which days it actually covers rather than
 * drawing a curve over days it never read.
 *
 * TODO(v2): real server-side aggregates (revenue by day over ALL orders, a
 * date-range picker) — backend work; this screen upgrades in place when the
 * endpoints exist.
 */

const WINDOW_DAYS = 30;
const MAX_PAGES = 8;

interface Sweep {
  rows: ShopOrderRow[];
  /** True when the page cap stopped the sweep while still inside the window
   *  — older days exist that the chart cannot see. */
  truncated: boolean;
}

interface Day {
  key: string;
  label: string;
  date: Date;
  netMinor: number;
  orders: number;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function buildDays(now: number): Day[] {
  const days: Day[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);
    days.push({
      key: dayKey(date),
      label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      date,
      netMinor: 0,
      orders: 0,
    });
  }
  return days;
}

export default function Analytics() {
  const [stats, setStats] = useState<ShopStats | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
      const statsPromise = shopApi.stats({}, signal);

      const rows: ShopOrderRow[] = [];
      let cursor: string | null = null;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await shopApi.listOrders(
          { ...(cursor ? { cursor } : {}), limit: 25 },
          signal,
        );
        rows.push(...res.items);
        const oldest = res.items[res.items.length - 1];
        cursor = res.nextCursor;
        if (!cursor || (oldest && oldest.order.placedAt < cutoff)) break;
        if (page === MAX_PAGES - 1 && cursor) truncated = true;
      }

      setStats(await statsPromise);
      setSweep({ rows, truncated });
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

  if (loadError) {
    return (
      <div className="page">
        <PageHeader icon={<BarChart3 />} title="Analytics" />
        <Banner tone="critical" title="Couldn’t load analytics" action={<Button onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );
  }

  const loading = stats === null || sweep === null;

  /* ── derive, all from real rows ─────────────────────────────────────── */
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86_400_000;
  const inWindow = (sweep?.rows ?? []).filter((r) => r.order.placedAt >= cutoff);
  const paid = inWindow.filter((r) => r.order.paidAt !== null);
  const currency =
    stats?.revenue[0]?.currency ?? inWindow[0]?.order.currency ?? 'NGN';

  const days = buildDays(now);
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const { order } of paid) {
    const bucket = byKey.get(dayKey(new Date(order.placedAt)));
    if (!bucket) continue;
    bucket.netMinor += order.grandTotal - order.refundedTotal;
    bucket.orders += 1;
  }

  const netWindow = paid.reduce((n, r) => n + r.order.grandTotal - r.order.refundedTotal, 0);
  const itemsSold = paid.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.qty, 0), 0);
  const aov = paid.length > 0 ? Math.round(netWindow / paid.length) : 0;

  const statusCounts = new Map<string, number>();
  for (const { order } of inWindow) {
    statusCounts.set(order.status, (statusCounts.get(order.status) ?? 0) + 1);
  }

  /* Best sellers: gross line revenue over paid orders — refunds are not
     recorded per line, so this is stated as gross rather than guessed net. */
  const sellers = new Map<string, { title: string; sku: string; units: number; grossMinor: number }>();
  for (const { order, lines } of paid) {
    void order;
    for (const line of lines) {
      const entry = sellers.get(line.sku) ?? {
        title: line.title,
        sku: line.sku,
        units: 0,
        grossMinor: 0,
      };
      entry.units += line.qty;
      entry.grossMinor += line.lineTotal;
      sellers.set(line.sku, entry);
    }
  }
  const topSellers = [...sellers.values()].sort((a, b) => b.grossMinor - a.grossMinor).slice(0, 10);

  const serverNet30 = stats?.revenue.find((r) => r.currency === currency)?.last30d ?? null;

  const oldestFetched = sweep?.rows[sweep.rows.length - 1]?.order.placedAt ?? null;
  const coverageNote =
    sweep?.truncated && oldestFetched !== null
      ? `The daily series covers the most recent ${sweep.rows.length} orders — back to ${shortDate(oldestFetched)}. Days before that are in the tiles (server totals) but not in the bars.`
      : null;

  type SellerRow = (typeof topSellers)[number];
  const sellerColumns: Column<SellerRow>[] = [
    {
      key: 'product',
      header: 'Product',
      primary: true,
      render: (s) => (
        <IdCell thumb={<Package aria-hidden="true" />} title={s.title} meta={<span className="mono">{s.sku}</span>} />
      ),
    },
    {
      key: 'units',
      header: 'Units',
      label: 'Units',
      numeric: true,
      render: (s) => <span className="num">{s.units}</span>,
    },
    {
      key: 'gross',
      header: 'Gross revenue',
      label: 'Gross revenue',
      numeric: true,
      render: (s) => <strong className="num">{money(s.grossMinor, currency)}</strong>,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        title="Analytics"
        subtitle={`The last ${WINDOW_DAYS} days, from real orders — nothing modelled, nothing smoothed.`}
      />

      {coverageNote ? (
        <Banner tone="info" title="Partial daily coverage">
          {coverageNote}
        </Banner>
      ) : null}

      {/* ── tiles ─────────────────────────────────────────────────────── */}
      <div className="bento" style={{ gap: 'var(--s3)' }}>
        {(
          [
            {
              label: `Net revenue · ${WINDOW_DAYS}d`,
              value: loading ? null : money(serverNet30 ?? netWindow, currency),
              hint: serverNet30 !== null ? 'Server total, every order' : 'From the swept orders',
            },
            {
              label: `Paid orders · ${WINDOW_DAYS}d`,
              value: loading ? null : String(paid.length) + (sweep?.truncated ? '+' : ''),
              hint: sweep?.truncated ? 'At least — sweep capped' : 'From the swept orders',
            },
            {
              label: 'Average order',
              value: loading ? null : paid.length ? money(aov, currency) : '—',
              hint: 'Net of refunds',
            },
            {
              label: 'Items sold',
              value: loading ? null : String(itemsSold) + (sweep?.truncated ? '+' : ''),
              hint: 'Across paid orders',
            },
          ] as const
        ).map((tile) => (
          <div
            key={tile.label}
            className="card"
            style={{ gridColumn: 'span 3', padding: 'var(--s4)', minWidth: 0 }}
          >
            <div className="muted" style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--w-medium)' }}>
              {tile.label}
            </div>
            {tile.value === null ? (
              <span className="skel" style={{ width: '5rem', height: '1rem', marginTop: 6 }} />
            ) : (
              <div
                className="num"
                style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)', letterSpacing: '-0.02em', marginTop: 2 }}
              >
                {tile.value}
              </div>
            )}
            <div className="muted" style={{ fontSize: 'var(--t-xs)', marginTop: 2 }}>
              {tile.hint}
            </div>
          </div>
        ))}
      </div>

      {/* ── the daily series ──────────────────────────────────────────── */}
      <Card title={`Net revenue by day`}>
        {loading ? (
          <span className="skel" style={{ width: '100%', height: '9rem' }} aria-hidden="true" />
        ) : paid.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
            No paid orders in the window — the chart draws the day the first one lands.
          </p>
        ) : (
          <RevenueBars days={days} currency={currency} />
        )}
        {!loading && inWindow.length > 0 ? (
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
            {[...statusCounts.entries()].map(([status, count]) => (
              <Badge key={status} tone={orderTone(status as never)}>
                {count} {humanise(status).toLowerCase()}
              </Badge>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ── best sellers — THE table ──────────────────────────────────── */}
      <DataTable
        caption="Best sellers"
        columns={sellerColumns}
        rows={topSellers}
        rowKey={(s) => s.sku}
        loading={loading}
        empty={
          <EmptyState
            icon={<Package />}
            title="Nothing sold in the window yet"
            body="Best sellers rank by gross line revenue over paid orders."
          />
        }
        footer={
          topSellers.length > 0 ? (
            <div className="tfoot">
              <span>
                Gross line revenue, before refunds — refunds are order-level and cannot be pinned
                to a line honestly.
              </span>
            </div>
          ) : null
        }
      />
    </div>
  );
}

/**
 * Plain bars over real sums. No smoothing, no interpolation — an empty day
 * is a gap on the baseline, which is the truthful shape of a quiet store.
 */
function RevenueBars({ days, currency }: { days: Day[]; currency: string }) {
  const W = 600;
  const H = 130;
  const PAD_BOTTOM = 18;
  const max = Math.max(...days.map((d) => d.netMinor), 1);
  const barW = W / days.length;

  return (
    <div>
      <div className="muted num" style={{ fontSize: 'var(--t-xs)', marginBottom: 2 }}>
        peak {money(max, currency)}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Net revenue per day over the last ${days.length} days`}
      >
        <line x1="0" y1={H - PAD_BOTTOM} x2={W} y2={H - PAD_BOTTOM} stroke="var(--border)" strokeWidth="1" />
        {days.map((d, i) => {
          const h = d.netMinor === 0 ? 0 : Math.max(2, ((H - PAD_BOTTOM - 6) * d.netMinor) / max);
          const x = i * barW + barW * 0.18;
          return (
            <g key={d.key}>
              <rect
                x={x}
                y={H - PAD_BOTTOM - h}
                width={barW * 0.64}
                height={h}
                rx="1.5"
                fill="var(--accent)"
                opacity={d.netMinor === 0 ? 0 : 0.9}
              >
                <title>
                  {d.label} — {money(d.netMinor, currency)} · {d.orders}{' '}
                  {d.orders === 1 ? 'order' : 'orders'}
                </title>
              </rect>
              {i === 0 || i === days.length - 1 || i % 7 === 0 ? (
                <text
                  x={i * barW + barW / 2}
                  y={H - 5}
                  textAnchor="middle"
                  fontSize="8.5"
                  fill="var(--ink-muted)"
                  fontFamily="var(--font)"
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
