import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import {
  analyticsApi,
  ANALYTICS_CURRENCY,
  ANALYTICS_DEFAULT_DAYS,
  type AnalyticsDays,
  type ShopAnalytics,
} from '../../data/api-shop-analytics';
import { useAsync } from '../lib/useAsync';
import { humanise, money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button, ButtonLink } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Segmented } from '../ui/Field';
import { EChart } from '../ui/EChart';

/**
 * ANALYTICS — `/analytics`. The diagrams, and only the diagrams: the table of
 * best sellers is its own subpage (`/analytics/products`), which is the
 * owner's explicit ask — "a table in a subpage different from the diagrams".
 *
 * This screen used to page `GET /admin/orders` client-side and hand-draw an
 * SVG under a TODO ("real server-side aggregates, a date-range picker —
 * backend work"). THAT TODO IS DONE: `GET /api/shop/admin/analytics` computes
 * the daily series, the status mix, the totals and the sellers over EVERY
 * order in the window, so the sweep, its page cap and its partial-coverage
 * banner are all gone — there is no partial coverage to disclose any more.
 *
 * THE HONESTY RULE SURVIVES THE REWRITE: nothing on this screen is fabricated.
 * Every number is the server's own aggregate; the one thing computed here is
 * the CALENDAR — the server omits days with no paid order, and this screen
 * fills them with an explicit zero so the axis is real days, not just days
 * that sold. A zero bar is the truthful shape of a quiet day.
 *
 * Charts are Apache ECharts through `ui/EChart` (owner: "a better, more
 * interactive library so I can do interactions a salesperson would need") —
 * drag/pinch to zoom the date range, crosshair tooltips reading net and order
 * count together, legend toggles isolating a status, save-as-image.
 */

/** Mirrors `ANALYTICS_RANGES` server-side — the route's `z.enum`. */
const RANGES: { value: '7' | '30' | '90' | '365'; label: string }[] = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '365', label: '1y' },
];

/** WAT is UTC+1, fixed, no DST since 1919 — the server's own constant. The
 *  client repeats it only to name the same calendar days the server bucketed
 *  into; if the store ever moves timezones, both constants move together. */
const WAT_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

function watDay(epochMs: number): string {
  return new Date(epochMs + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Every calendar day the window touches, oldest first, with the server's rows
 * merged in and the absent days written as explicit zeros. Anchored on
 * `generatedAt` — the exact instant the server measured from — so the client
 * calendar and the server buckets can never disagree by a clock skew. The
 * window `[now - days·24h, now]` touches days + 1 calendar days (both ends
 * partial), and all of them get an axis slot so no server bucket is dropped.
 */
function fillCalendar(a: ShopAnalytics): { day: string; net: number; orders: number }[] {
  const byDay = new Map(a.revenueByDay.map((d) => [d.day, d]));
  const out: { day: string; net: number; orders: number }[] = [];
  for (let i = a.days; i >= 0; i--) {
    const day = watDay(a.generatedAt - i * DAY_MS);
    const hit = byDay.get(day);
    out.push({ day, net: hit?.net ?? 0, orders: hit?.orders ?? 0 });
  }
  return out;
}

/** '2026-08-31' → '31 Aug', for an axis label. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * ECharts paints CANVAS, and CSS custom properties do not cascade into a
 * canvas — handing it 'var(--accent)' draws that literal string's idea of a
 * colour, i.e. nothing. So the token is read off the root element at render
 * time and passed as a literal, with the token's own value as the fallback
 * for anywhere `getComputedStyle` has no answer (jsdom).
 */
function accentColour(): string {
  const read =
    typeof window === 'undefined'
      ? ''
      : window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return read || '#2e2a6b';
}

/**
 * Status → slice colour, the same verdicts as `orderTone` renders in every
 * Badge: green for the terminal good state, blue for paid, amber for pending,
 * red for money that went back, grey for cancelled. LITERAL hexes near the
 * tokens in `tokens.css` (--ok-ink, --info-ink, --critical-ink…), because
 * canvas cannot read tokens — see `accentColour` above.
 */
const STATUS_COLOURS: Record<string, string> = {
  fulfilled: '#0c5132', // ≈ --ok-ink
  paid: '#00527c', // ≈ --info-ink
  pending: '#b26b00', // amber, between --warn-ink and --warn-bg
  refunded: '#8e1f0b', // ≈ --critical-ink
  partially_refunded: '#c4573f', // a lighter step off --critical-ink
  cancelled: '#8a8782', // the muted grey a neutral badge wears
};

const statusColour = (status: string): string => STATUS_COLOURS[status] ?? '#8a8782';

export default function Analytics() {
  const [days, setDays] = useState<AnalyticsDays>(ANALYTICS_DEFAULT_DAYS);
  const { data, error, loading, reload } = useAsync(
    (signal) => analyticsApi.get(days, signal),
    [days],
  );

  const calendar = useMemo(() => (data ? fillCalendar(data) : []), [data]);
  const accent = accentColour();

  /* ── the daily bars ─────────────────────────────────────────────────────
     Y is MAJOR units (minor / 100) so the axis reads as naira; the tooltip
     formats the exact minor amount through the shared money formatter and
     names the day's order count beside it — the two numbers a salesperson
     reads together. dataZoom inside + slider is the drag/pinch zoom; the
     toolbox is save-as-image. */
  const revenueOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const first = (Array.isArray(params) ? params[0] : params) as {
            name?: string;
            data?: { netMinor?: number; orders?: number };
          };
          const netMinor = first?.data?.netMinor ?? 0;
          const orders = first?.data?.orders ?? 0;
          return `${dayLabel(String(first?.name ?? ''))}<br/>${money(netMinor, ANALYTICS_CURRENCY)} · ${orders} ${
            orders === 1 ? 'order' : 'orders'
          }`;
        },
      },
      toolbox: {
        feature: {
          saveAsImage: { title: 'Save chart', name: `net-revenue-by-day-${days}d` },
        },
        right: 8,
        top: 0,
      },
      grid: { left: 8, right: 8, top: 32, bottom: 56, containLabel: true },
      xAxis: {
        type: 'category',
        data: calendar.map((d) => d.day),
        axisLabel: { formatter: (value: string) => dayLabel(value) },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (value: number) => value.toLocaleString() },
        splitLine: { lineStyle: { opacity: 0.4 } },
      },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
      series: [
        {
          name: 'Net revenue',
          type: 'bar',
          barMaxWidth: 26,
          itemStyle: { color: accent, borderRadius: [3, 3, 0, 0] },
          data: calendar.map((d) => ({
            value: d.net / 100,
            netMinor: d.net,
            orders: d.orders,
          })),
        },
      ],
    }),
    [calendar, accent, days],
  );

  /* ── the status donut ─────────────────────────────────────────────────── */
  const statusRows = data?.ordersByStatus ?? [];
  const statusOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { name?: string; value?: number };
          return `${p.name}: ${p.value}`;
        },
      },
      /* The legend IS the interaction: clicking an entry drops that status out
         of the donut, which is how "what does the pipeline look like without
         the cancellations" gets answered without a filter UI. */
      legend: { bottom: 0, type: 'scroll', icon: 'circle' },
      series: [
        {
          name: 'Orders by status',
          type: 'pie',
          radius: ['55%', '80%'],
          center: ['50%', '44%'],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
          data: statusRows.map((s) => ({
            name: humanise(s.status),
            value: s.count,
            itemStyle: { color: statusColour(s.status) },
          })),
        },
      ],
    }),
    [statusRows],
  );

  /* ── the best-sellers TEASER — five bars and a link, never the table ──── */
  const topFive = useMemo(() => (data?.topProducts ?? []).slice(0, 5), [data]);
  const teaserOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { name?: string; data?: { grossMinor?: number; units?: number } };
          const grossMinor = p?.data?.grossMinor ?? 0;
          const units = p?.data?.units ?? 0;
          return `${p.name}<br/>${money(grossMinor, ANALYTICS_CURRENCY)} · ${units} ${
            units === 1 ? 'unit' : 'units'
          }`;
        },
      },
      grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: 'value',
        axisLabel: { formatter: (value: number) => value.toLocaleString() },
        splitLine: { lineStyle: { opacity: 0.4 } },
      },
      yAxis: {
        type: 'category',
        /* Reversed so the best seller sits on top — category axes draw upward. */
        data: [...topFive].reverse().map((p) => p.title),
        axisLabel: { width: 140, overflow: 'truncate' },
      },
      series: [
        {
          name: 'Gross revenue',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: accent, borderRadius: [0, 3, 3, 0] },
          data: [...topFive].reverse().map((p) => ({
            value: p.gross / 100,
            grossMinor: p.gross,
            units: p.units,
          })),
        },
      ],
    }),
    [topFive, accent],
  );

  const totals = data?.totals ?? null;
  const tiles = [
    {
      label: 'Net revenue',
      value: totals === null ? null : money(totals.net, ANALYTICS_CURRENCY),
      hint: 'Net of refunds, over paid orders',
    },
    {
      label: 'Paid orders',
      value: totals === null ? null : String(totals.orders),
      hint: 'Paid inside the window',
    },
    {
      label: 'Average order',
      value:
        totals === null
          ? null
          : totals.orders > 0
            ? money(totals.averageOrder, ANALYTICS_CURRENCY)
            : '—',
      hint: 'Net over paid orders',
    },
    {
      label: 'Items sold',
      value: totals === null ? null : String(totals.items),
      hint: 'Units across paid orders',
    },
  ] as const;

  const showSkeletons = loading || data === null;

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        title="Analytics"
        subtitle={`The last ${days} days, from real orders — nothing modelled, nothing smoothed.`}
        actions={
          <Segmented
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
          title="Couldn’t load analytics"
          action={<Button onClick={reload}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : (
        <>
          {/* ── tiles ─────────────────────────────────────────────────── */}
          <div className="bento" style={{ gap: 'var(--s3)' }}>
            {tiles.map((tile) => (
              <div
                key={tile.label}
                className="card"
                style={{ gridColumn: 'span 3', padding: 'var(--s4)', minWidth: 0 }}
              >
                <div
                  className="muted"
                  style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--w-medium)' }}
                >
                  {tile.label}
                </div>
                {showSkeletons || tile.value === null ? (
                  <span className="skel" style={{ width: '5rem', height: '1rem', marginTop: 6 }} />
                ) : (
                  <div
                    className="num"
                    style={{
                      fontSize: 'var(--t-2xl)',
                      fontWeight: 'var(--w-bold)',
                      letterSpacing: '-0.02em',
                      marginTop: 2,
                    }}
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

          {/* ── net revenue by day ────────────────────────────────────── */}
          <Card title="Net revenue by day">
            {showSkeletons ? (
              <span className="skel" style={{ width: '100%', height: '20rem' }} aria-hidden="true" />
            ) : (
              <EChart
                option={revenueOption}
                height="22rem"
                ariaLabel={`Bar chart of net revenue per day over the last ${days} days, in naira. Drag to zoom the date range; each day's tooltip names its net revenue and order count.`}
              />
            )}
          </Card>

          {/* ── status donut and best-sellers teaser, side by side ────── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
              gap: 'var(--s4)',
              alignItems: 'stretch',
            }}
          >
            <Card title="Orders by status">
              {showSkeletons ? (
                <span
                  className="skel"
                  style={{ width: '100%', height: '16rem' }}
                  aria-hidden="true"
                />
              ) : statusRows.length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                  No orders placed in this window yet.
                </p>
              ) : (
                <EChart
                  option={statusOption}
                  height="18rem"
                  ariaLabel={`Donut chart of orders by status over the last ${days} days. Legend entries toggle each status in and out of the chart.`}
                />
              )}
              {!showSkeletons && statusRows.length > 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-xs)' }}>
                  Every order placed in the window, cancellations included — the pipeline, not
                  just the wins.
                </p>
              ) : null}
            </Card>

            <Card
              title="Best sellers"
              action={<ButtonLink to="/analytics/products">See the full table</ButtonLink>}
            >
              {showSkeletons ? (
                <span
                  className="skel"
                  style={{ width: '100%', height: '16rem' }}
                  aria-hidden="true"
                />
              ) : topFive.length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                  Nothing sold in this window yet — the chart draws the day the first paid order
                  lands.
                </p>
              ) : (
                <EChart
                  option={teaserOption}
                  height="16rem"
                  ariaLabel={`Horizontal bar chart of the top ${topFive.length} products by gross revenue over the last ${days} days.`}
                />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
