import { useMemo, useState } from 'react';
import { BarChart3, Lock } from 'lucide-react';
import {
  analyticsApi,
  ANALYTICS_CURRENCY,
  ANALYTICS_DEFAULT_DAYS,
  type AnalyticsBreakdownRow,
  type AnalyticsDay,
  type AnalyticsDays,
  type ShopAnalytics,
} from '../../data/api-shop-analytics';
import { useAsync } from '../lib/useAsync';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { humanise, money } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Defs, type DefRow } from '../ui/Defs';
import { Segmented } from '../ui/Field';
import { EChart } from '../ui/EChart';
import { paymentMethodLabel, salesChannelLabel } from './manual-order-copy';

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
 *
 * SALES MEANS ITEM PRICES (owner, 2026-09-06). The headline tile used to print
 * the CHARGED total net of refunds, so a 28,000 order with 3,000 delivery
 * read as 31,000 of sales. Now the tile, the average and the solid bars are
 * the server's `sales` — subtotals, nothing else — and every other kind of
 * money has its own named place: the delivery and VAT bars stack on top in
 * lighter shades (legend toggles them off), and the "Where the money went"
 * card reads like a receipt from item prices down to what was collected.
 * Refunds come off a whole order and cannot be split between items and
 * delivery honestly, so they appear on that receipt and nowhere else.
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
function fillCalendar(a: ShopAnalytics): AnalyticsDay[] {
  const byDay = new Map(a.revenueByDay.map((d) => [d.day, d]));
  const out: AnalyticsDay[] = [];
  for (let i = a.days; i >= 0; i--) {
    const day = watDay(a.generatedAt - i * DAY_MS);
    out.push(byDay.get(day) ?? { day, ...NO_MONEY, orders: 0, manual: NO_MANUAL });
  }
  return out;
}

/** A day with nothing recorded by hand — the ordinary case. */
const NO_MANUAL = { charged: 0, orders: 0 } as const;

/** A quiet day: every kind of money at zero. */
const NO_MONEY = {
  sales: 0,
  discounts: 0,
  delivery: 0,
  tax: 0,
  charged: 0,
  refunded: 0,
  net: 0,
} as const;

/** "3 orders" / "1 order" — the count beside a source row. */
function orderWord(n: number): string {
  return `${n} ${n === 1 ? 'order' : 'orders'}`;
}

/**
 * One cut of the manual half — by channel, or by payment method. A row the
 * owner left blank prints as "Not recorded", which is an answer rather than a
 * gap: both fields are optional on the form.
 */
function Breakdown({
  title,
  rows,
  label,
}: {
  title: string;
  rows: AnalyticsBreakdownRow[];
  label: (value: string | null) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--s4)' }}>
      <h4 style={{ font: 'var(--t-sm-strong)', margin: '0 0 var(--s2)' }}>{title}</h4>
      <Defs
        rows={rows.map((row) => ({
          label: (
            <>
              {row.key === null ? 'Not recorded' : label(row.key)}{' '}
              <span className="muted">· {orderWord(row.orders)}</span>
            </>
          ),
          value: money(row.charged, ANALYTICS_CURRENCY),
        }))}
      />
    </div>
  );
}

/** A money figure that is taken OFF — a discount, a refund — printed with a
 *  leading minus the way the order screen prints one, and never as a bare
 *  negative from the formatter. Zero prints as zero. */
function deduction(minor: number): string {
  return minor === 0 ? money(0, ANALYTICS_CURRENCY) : `−${money(Math.abs(minor), ANALYTICS_CURRENCY)}`;
}

/** One line of the daily tooltip: label left, amount right. */
function tooltipRow(label: string, amount: string, strong = false): string {
  const weight = strong ? 'font-weight:600' : '';
  return `<div style="display:flex;justify-content:space-between;gap:16px;${weight}"><span>${esc(label)}</span><span>${esc(amount)}</span></div>`;
}

/**
 * ECharts inserts a string tooltip formatter's return value as raw innerHTML
 * (TooltipHTMLContent.js), and a custom formatter bypasses ECharts' own
 * escaping — so any attacker-influenced string in a tooltip is stored XSS.
 * A product TITLE is exactly that: a `writer` (products domain, no analytics)
 * could plant `<img onerror>` in a title that an analytics-only viewer's
 * session then executes on hover, jumping the role wall migration 0680 built.
 * Every scalar interpolated into a tooltip goes through this first.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
 *
 * READ, NEVER HARDCODED AS A TINT OF THE ACCENT: the accent is a theme value
 * (`#2e2a6b` in light, the pale lavender `#9b93d4` under a dark preference —
 * which is what the owner's own screenshots show), so a literal "lighter
 * purple" for the delivery bars sat on top of that lavender and was
 * indistinguishable from it, and the accent's own tints inverted the
 * emphasis (pale products, dark extras). Measured 2026-09-06. So the
 * EXTRAS ARE NEUTRAL: the brand colour means "ours", grey means "passed
 * through" — delivery and VAT — in either theme.
 */
function cssColour(token: string, fallback: string): string {
  const read =
    typeof window === 'undefined'
      ? ''
      : window.getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return read || fallback;
}

/** The stacked series' colours, in the order they stack: product sales in
 *  the accent, delivery in the mid neutral, VAT in the light neutral with a
 *  hairline so a thin 7.5% slice still shows against the card. */
function seriesColours(): { sales: string; delivery: string; tax: string; manual: string } {
  return {
    sales: cssColour('--accent', '#2e2a6b'),
    delivery: cssColour('--ink-disabled', '#b5b5b5'),
    tax: cssColour('--border', '#e3e3e3'),
    /* The hand-recorded line rides OVER the stack rather than in it, so it
       needs a colour that reads against every bar underneath: the same amber
       the pending badge wears, which is in neither the accent nor the neutral
       ramp the bars are drawn from. */
    manual: '#b26b00',
  };
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

/** The analytics domain (owner/developer/support/supply-chain/marketing) —
 *  a content writer is the one role without it, and gets the graceful absence
 *  the rest of the batch renders rather than a red load-failure banner. */
function useAnalyticsAccess(): boolean {
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  return viewer !== null && hasDomain(viewer.role, 'analytics');
}

function NoAnalytics({ backTo, title }: { backTo?: string; title: string }) {
  return (
    <div className="page">
      <PageHeader icon={<BarChart3 />} title={title} backTo={backTo} backLabel="Analytics" />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          title="You don’t have access to this"
          body="Analytics is for the owner, developers, and the operations and marketing teams. If you write content, your work is under Products and Content."
        />
      </div>
    </div>
  );
}

export default function Analytics() {
  const allowed = useAnalyticsAccess();
  const [days, setDays] = useState<AnalyticsDays>(ANALYTICS_DEFAULT_DAYS);
  const { data, error, loading, reload } = useAsync(
    (signal) => (allowed ? analyticsApi.get(days, signal) : Promise.resolve(null)),
    [days, allowed],
  );

  if (!allowed) return <NoAnalytics title="Analytics" />;

  const calendar = useMemo(() => (data ? fillCalendar(data) : []), [data]);
  const colours = seriesColours();
  const accent = colours.sales;

  /* ── the daily bars ─────────────────────────────────────────────────────
     Y is MAJOR units (minor / 100) so the axis reads as naira. THREE series
     STACKED: product sales solid in the accent, delivery and VAT in lighter
     steps above it — the bar's solid part is what the products sold for, its
     full height is what customers were charged before discounts, and the
     legend drops either extra out. Every point carries its whole day, so the
     tooltip prints the receipt for that day through the shared money
     formatter and names the order count beside it. dataZoom inside + slider
     is the drag/pinch zoom; the toolbox is save-as-image. */
  const revenueOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const first = (Array.isArray(params) ? params[0] : params) as {
            name?: string;
            data?: { day?: AnalyticsDay };
          };
          const d = first?.data?.day ?? { day: '', ...NO_MONEY, orders: 0, manual: NO_MANUAL };
          const fmt = (minor: number) => money(minor, ANALYTICS_CURRENCY);
          const rows = [
            tooltipRow('Product sales', fmt(d.sales), true),
            d.discounts !== 0 ? tooltipRow('Discounts', deduction(d.discounts)) : '',
            tooltipRow('Delivery', fmt(d.delivery)),
            tooltipRow('VAT', fmt(d.tax)),
            tooltipRow('Charged', fmt(d.charged), true),
            d.refunded !== 0 ? tooltipRow('Refunded', deduction(d.refunded)) : '',
            d.refunded !== 0 ? tooltipRow('Collected', fmt(d.net), true) : '',
            d.manual.charged !== 0
              ? tooltipRow('of which recorded by hand', fmt(d.manual.charged))
              : '',
          ].join('');
          return `<div style="font-weight:600;margin-bottom:4px">${esc(dayLabel(String(first?.name ?? '')))} · ${d.orders} ${
            d.orders === 1 ? 'order' : 'orders'
          }</div>${rows}`;
        },
      },
      legend: { top: 0, left: 0, icon: 'circle', itemGap: 16 },
      toolbox: {
        feature: {
          saveAsImage: { title: 'Save chart', name: `sales-by-day-${days}d` },
        },
        right: 8,
        top: 0,
      },
      grid: { left: 8, right: 8, top: 40, bottom: 56, containLabel: true },
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
          name: 'Product sales',
          type: 'bar',
          stack: 'charged',
          barMaxWidth: 26,
          itemStyle: { color: accent },
          data: calendar.map((d) => ({ value: d.sales / 100, day: d })),
        },
        {
          name: 'Delivery',
          type: 'bar',
          stack: 'charged',
          barMaxWidth: 26,
          itemStyle: { color: colours.delivery },
          data: calendar.map((d) => ({ value: d.delivery / 100, day: d })),
        },
        {
          name: 'VAT',
          type: 'bar',
          stack: 'charged',
          barMaxWidth: 26,
          itemStyle: { color: colours.tax, borderColor: colours.delivery, borderWidth: 1 },
          data: calendar.map((d) => ({ value: d.tax / 100, day: d })),
        },
        /* Recorded by hand, as a LINE OVER the bars rather than a fourth
           stacked segment: the stack is already the whole of what was
           charged, split by what the money was for, so adding a source to it
           would draw the same naira twice. A line answers the other question
           — how much of each day came from outside the checkout — and the
           legend drops it when nobody is asking. Hidden entirely in a window
           with no manual sale, so a shop that never records one sees the
           chart it had before. */
        ...(calendar.some((d) => d.manual.charged !== 0)
          ? [
              {
                name: 'Recorded by hand',
                type: 'line',
                smooth: false,
                symbolSize: 6,
                lineStyle: { width: 2, color: colours.manual },
                itemStyle: { color: colours.manual },
                data: calendar.map((d) => ({ value: d.manual.charged / 100, day: d })),
              },
            ]
          : []),
      ],
    }),
    [calendar, colours.sales, colours.delivery, colours.tax, colours.manual, days],
  );

  /* ── where the sales came from ────────────────────────────────────────
     Two rows that ADD UP to the headline, then the manual half cut by the two
     things the owner types when recording a sale. Absent entirely until a
     manual sale exists in the window: until then "100% online" is a fact
     nobody needs a card to learn. */
  const bySource = data?.bySource ?? [];
  const manualRow = bySource.find((r) => r.source === 'manual') ?? null;
  const onlineRow = bySource.find((r) => r.source === 'online') ?? null;
  const sourceRows: DefRow[] = manualRow
    ? [
        {
          label: <>Online <span className="muted">· {orderWord(onlineRow?.orders ?? 0)}</span></>,
          value: money(onlineRow?.charged ?? 0, ANALYTICS_CURRENCY),
        },
        {
          label: <>Recorded by hand <span className="muted">· {orderWord(manualRow.orders)}</span></>,
          value: money(manualRow.charged, ANALYTICS_CURRENCY),
        },
        {
          label: <>Charged to customers</>,
          value: money((onlineRow?.charged ?? 0) + manualRow.charged, ANALYTICS_CURRENCY),
          total: true,
        },
      ]
    : [];
  const manualShare =
    manualRow && (onlineRow?.charged ?? 0) + manualRow.charged > 0
      ? Math.round((manualRow.charged * 100) / ((onlineRow?.charged ?? 0) + manualRow.charged))
      : 0;

  /* ── the status donut ─────────────────────────────────────────────────── */
  const statusRows = data?.ordersByStatus ?? [];
  const statusOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { name?: string; value?: number };
          /* `name` is a humanised STATUS enum today — escaped anyway, so a
             future data source cannot reopen the tooltip XSS above. */
          return `${esc(String(p.name ?? ''))}: ${Number(p.value ?? 0)}`;
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
          return `${esc(String(p.name ?? ''))}<br/>${money(grossMinor, ANALYTICS_CURRENCY)} · ${units} ${
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
          name: 'Total sales',
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
      label: 'Product sales',
      value: totals === null ? null : money(totals.sales, ANALYTICS_CURRENCY),
      hint: 'Item prices only. Delivery, VAT and refunds are below.',
    },
    {
      label: 'Paid orders',
      value: totals === null ? null : String(totals.orders),
      hint: 'Paid in this period',
    },
    {
      label: 'Average order',
      value:
        totals === null
          ? null
          : totals.orders > 0
            ? money(totals.averageOrder, ANALYTICS_CURRENCY)
            : '—',
      hint: 'Product sales per paid order',
    },
    {
      label: 'Items sold',
      value: totals === null ? null : String(totals.items),
      hint: 'Items across all paid orders',
    },
  ] as const;

  const showSkeletons = loading || data === null;

  /* ── profit ──────────────────────────────────────────────────────────────
     Only units with a cost count toward profit — an item nobody priced the
     cost of is not free, and treating it as free would inflate the number. */
  const profit = data?.profit ?? null;
  const uncosted = profit === null ? 0 : profit.units - profit.costedUnits;
  const profitRows: DefRow[] =
    profit === null
      ? []
      : [
          {
            label: 'Sales of costed items',
            value: <span className="num">{money(profit.costedSales, ANALYTICS_CURRENCY)}</span>,
          },
          {
            label: 'What those items cost you',
            value: <span className="num">{deduction(profit.cost)}</span>,
          },
          {
            label: 'Profit',
            value: (
              <span className="num" style={profit.profit < 0 ? { color: 'var(--critical)' } : undefined}>
                {money(profit.profit, ANALYTICS_CURRENCY)}
              </span>
            ),
            total: true,
          },
          {
            label: 'Profit margin',
            value: (
              <span className="num">
                {profit.costedSales > 0
                  ? `${((profit.profit / profit.costedSales) * 100).toFixed(1)}%`
                  : '—'}
              </span>
            ),
          },
          {
            label: 'Items sold',
            value: <span className="num">{profit.units}</span>,
          },
        ];

  /* ── the receipt ────────────────────────────────────────────────────────
     Top to bottom the way an order prints: item prices, what came off, what
     was added, what was charged, what went back, what was kept. The two
     ruled rows are the two sums a reader actually wants. */
  const receipt: DefRow[] =
    totals === null
      ? []
      : [
          { label: 'Product sales', value: <span className="num">{money(totals.sales, ANALYTICS_CURRENCY)}</span> },
          { label: 'Discounts', value: <span className="num">{deduction(totals.discounts)}</span> },
          { label: 'Delivery', value: <span className="num">{money(totals.delivery, ANALYTICS_CURRENCY)}</span> },
          { label: 'VAT', value: <span className="num">{money(totals.tax, ANALYTICS_CURRENCY)}</span> },
          {
            label: 'Charged to customers',
            value: <span className="num">{money(totals.charged, ANALYTICS_CURRENCY)}</span>,
            total: true,
          },
          {
            label: 'Refunded',
            value: (
              <span className="num" style={totals.refunded > 0 ? { color: 'var(--critical)' } : undefined}>
                {deduction(totals.refunded)}
              </span>
            ),
          },
          {
            label: 'Collected after refunds',
            value: <span className="num">{money(totals.net, ANALYTICS_CURRENCY)}</span>,
            total: true,
          },
        ];

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        title="Analytics"
        subtitle={`The last ${days} days, taken straight from real orders.`}
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
          title="Couldn’t load analytics"
          action={<Button onClick={reload}>Retry</Button>}
        >
          {error}
        </Banner>
      ) : (
        <>
          {/* ── tiles ─────────────────────────────────────────────────── */}
          <div className="stats">
            {tiles.map((tile) => (
              <div key={tile.label} className="card stats__tile">
                <div className="muted stats__label">{tile.label}</div>
                {showSkeletons || tile.value === null ? (
                  <span className="skel" style={{ width: '5rem', height: '1rem', marginTop: 6 }} />
                ) : (
                  <div className="num stats__num">{tile.value}</div>
                )}
                <div className="muted stats__hint">{tile.hint}</div>
              </div>
            ))}
          </div>

          {/* ── sales by day: product bars, extras stacked above ──────── */}
          <Card title="Sales by day">
            {showSkeletons ? (
              <span className="skel" style={{ width: '100%', height: '20rem' }} aria-hidden="true" />
            ) : (
              <EChart
                option={revenueOption}
                height="22rem"
                ariaLabel={`Stacked bar chart of product sales, delivery and VAT per day over the last ${days} days, in naira. The solid bar is item prices; delivery and VAT stack above it and the legend hides either. Drag to zoom the date range; each day's tooltip prints its receipt and order count.`}
              />
            )}
          </Card>

          {/* ── profit on products ──────────────────────────────────── */}
          {showSkeletons ? null : profit === null ? null : (
            <Card title="Profit on products">
              {profit.costedUnits === 0 ? (
                <EmptyState
                  title={profit.units === 0 ? 'No sales in this period' : 'No cost prices yet'}
                  body={
                    profit.units === 0
                      ? 'Profit shows here once something sells.'
                      : 'Add a cost price to your variants and profit shows here from the next sale.'
                  }
                />
              ) : (
                <Defs rows={profitRows} />
              )}
              <p className="muted" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s3)' }}>
                Item prices minus what each item cost you, before delivery, VAT and refunds.
                {uncosted > 0
                  ? ` ${uncosted} ${uncosted === 1 ? 'item has' : 'items have'} no cost recorded, so ${uncosted === 1 ? 'it is' : 'they are'} left out of profit.`
                  : ''}
                {profit.estimatedUnits > 0
                  ? ` ${profit.estimatedUnits} ${profit.estimatedUnits === 1 ? 'item was' : 'items were'} sold before costs were saved on orders, so ${profit.estimatedUnits === 1 ? 'it uses' : 'they use'} today’s cost.`
                  : ''}
              </p>
              <div style={{ marginTop: 'var(--s3)' }}>
                <ButtonLink to="/analytics/products">Profit by product</ButtonLink>
              </div>
            </Card>
          )}

          {/* ── the receipt, the status donut and the best-sellers teaser ── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
              gap: 'var(--s4)',
              alignItems: 'stretch',
            }}
          >
            <Card title="Where the money went">
              {showSkeletons ? (
                <span
                  className="skel"
                  style={{ width: '100%', height: '16rem' }}
                  aria-hidden="true"
                />
              ) : (
                <>
                  <Defs rows={receipt} />
                  <p className="muted" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s3)' }}>
                    Product sales are item prices after bulk discounts. A refund comes off the
                    whole order, so it only lowers what was collected.
                  </p>
                </>
              )}
            </Card>

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

            {manualRow ? (
              <Card title="Where sales came from">
                <Defs rows={sourceRows} />
                <p className="muted" style={{ fontSize: 'var(--t-xs)', marginTop: 'var(--s3)' }}>
                  {manualShare}% of the money in this window was recorded by hand. A sale counts
                  on the day it was SOLD, not the day it was typed in.
                </p>
                <Breakdown title="How those sales came in" rows={data?.manualByChannel ?? []} label={salesChannelLabel} />
                <Breakdown title="How they were paid" rows={data?.manualByMethod ?? []} label={paymentMethodLabel} />
              </Card>
            ) : null}

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
