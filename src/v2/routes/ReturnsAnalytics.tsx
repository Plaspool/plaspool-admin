import { useMemo, useState } from 'react';
import { BarChart3, Lock } from 'lucide-react';
import {
  marketingApi,
  RETURN_ANALYTICS_DEFAULT,
  type ReturnAnalyticsRange,
  type ReturnCostAnalytics,
} from '../../data/api-marketing';
import { useAsync } from '../lib/useAsync';
import { getSession } from '../../data/session';
import { hasDomain } from '../../../shared/roles';
import { money, shortDate } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { Card } from '../ui/Card';
import { Segmented } from '../ui/Field';
import { EChart } from '../ui/EChart';

/**
 * WHAT ITEMS COST US — `/orders/returns/analytics`.
 *
 * The one question this screen exists to answer, in the owner's own words: the
 * headline rate says a hundred naira an item, but a van has to fetch them, so
 * what are we REALLY paying? Every figure here is that one fraction,
 *
 *     (paid to customers + what the pickups cost) / items KEPT
 *
 * sliced a different way. The charts are here; the district table is its own
 * subpage, the split `/analytics` and `/analytics/products` already set.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HONESTY RULE, WHICH THIS SCREEN NEEDS MORE THAN THE SHOP'S DOES. Sales
 * analytics reads real orders; this reads a mix of figures somebody typed and
 * standards standing in for figures nobody did. So the coverage line is not a
 * footnote — it is the sentence that tells a reader how much of the headline
 * to believe, and it is drawn every time, including when the answer is "all of
 * it". A screen that renders an estimate and a receipt identically is how the
 * number stops meaning anything.
 *
 * NO PRODUCT NOUN IS WRITTEN DOWN HERE. The programme's unit word is DATA
 * (spec D11) and this aggregate does not carry it, so the copy says "item"
 * throughout — a word that is true whatever the programme collects, rather
 * than a guess that would be wrong the first time a second programme ships.
 *
 * THE GATE IS `orders`, NOT `analytics`, and that is deliberate: the API puts
 * `/api/marketing/returns` in the orders domain
 * (`server/middleware/permissions.ts`), so gating this screen on the analytics
 * domain would hand a marketing user a page that 403s on its first fetch.
 */

const RANGES: { value: ReturnAnalyticsRange; label: string }[] = [
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '365', label: '1y' },
  { value: 'all', label: 'All time' },
];

const CURRENCY = 'NGN';

/**
 * ECharts inserts a string tooltip formatter's return value as raw innerHTML
 * and a custom formatter bypasses its own escaping, so every scalar
 * interpolated into one goes through this first — the same guard
 * `Analytics.tsx` carries, for the same reason. Nothing on this screen is
 * attacker-influenced today; a district NAME is typed by an owner, and that is
 * one role change away from not being the same person as the reader.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** '2026-08' → 'Aug 2026', for an axis label. */
function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Canvas cannot read CSS custom properties — see `Analytics.tsx`. */
function accentColour(): string {
  const read =
    typeof window === 'undefined'
      ? ''
      : window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return read || '#2e2a6b';
}

/**
 * The five bands of the stacked bar, in the order they stack.
 *
 * THE REWARD IS AT THE BOTTOM because it is the part the owner already knows —
 * everything above it is the gap this screen exists to show. Literal hexes
 * near the tokens in `tokens.css`, because a canvas cannot read a token.
 */
const BANDS = [
  { key: 'rewardMinor', label: 'Paid to customers', colour: '#2e2a6b' },
  { key: 'transportMinor', label: 'Transport in', colour: '#00527c' },
  { key: 'localMinor', label: 'Local delivery', colour: '#0c5132' },
  { key: 'driverMinor', label: 'Driver', colour: '#b26b00' },
  { key: 'feesMinor', label: 'Loading and fees', colour: '#8a8782' },
] as const;

function useOrdersAccess(): boolean {
  const session = getSession();
  const viewer = 'user' in session ? session.user : null;
  return viewer !== null && hasDomain(viewer.role, 'orders');
}

export default function ReturnsAnalytics() {
  const allowed = useOrdersAccess();
  const [range, setRange] = useState<ReturnAnalyticsRange>(RETURN_ANALYTICS_DEFAULT);
  const { data, error, loading, reload } = useAsync(
    (signal) => (allowed ? marketingApi.returnAnalytics(range, signal) : Promise.resolve(null)),
    [range, allowed],
  );

  const accent = accentColour();
  const months = useMemo(() => data?.byMonth ?? [], [data]);

  /* ── the stacked bars: cost PER ITEM, split by where it went ────────────
     Per item and not totals, because a month that collected twice as much
     would tower over every other bar while saying nothing about whether the
     programme got cheaper — which is the only question this chart is for. */
  const mixOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const rows = (Array.isArray(params) ? params : [params]) as {
            name?: string;
            seriesName?: string;
            value?: number;
            data?: { minor?: number };
          }[];
          const head = monthLabel(String(rows[0]?.name ?? ''));
          const total = rows.reduce((n, r) => n + Number(r.value ?? 0), 0);
          const lines = rows
            .filter((r) => Number(r.value ?? 0) > 0)
            .map(
              (r) =>
                `${esc(String(r.seriesName ?? ''))}: ${money(
                  Math.round(Number(r.value ?? 0) * 100),
                  CURRENCY,
                )}`,
            );
          return `${esc(head)}<br/><strong>${money(
            Math.round(total * 100),
            CURRENCY,
          )} an item</strong><br/>${lines.join('<br/>')}`;
        },
      },
      legend: { bottom: 0, type: 'scroll', icon: 'circle' },
      grid: { left: 8, right: 8, top: 24, bottom: 48, containLabel: true },
      xAxis: {
        type: 'category',
        data: months.map((m) => m.month),
        axisLabel: { formatter: (value: string) => monthLabel(value) },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { formatter: (value: number) => value.toLocaleString() },
        splitLine: { lineStyle: { opacity: 0.4 } },
      },
      series: BANDS.map((band) => ({
        name: band.label,
        type: 'bar',
        stack: 'cost',
        barMaxWidth: 44,
        itemStyle: { color: band.colour },
        /* Each band divided by the SAME month's items kept, so the bars sum to
           that month's cost per item exactly. Guarded: a month that kept
           nothing would otherwise divide by zero and draw Infinity. */
        data: months.map((m) =>
          m.unitsKept === 0 ? 0 : (m[band.key] ?? 0) / m.unitsKept / 100,
        ),
      })),
    }),
    [months],
  );

  /* ── how many items we actually got, month by month ─────────────────── */
  const volumeOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const first = (Array.isArray(params) ? params[0] : params) as {
            name?: string;
            value?: number;
          };
          const n = Number(first?.value ?? 0);
          return `${esc(monthLabel(String(first?.name ?? '')))}<br/>${n} ${
            n === 1 ? 'item kept' : 'items kept'
          }`;
        },
      },
      grid: { left: 8, right: 8, top: 16, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category',
        data: months.map((m) => m.month),
        axisLabel: { formatter: (value: string) => monthLabel(value) },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { opacity: 0.4 } } },
      series: [
        {
          name: 'Items kept',
          type: 'line',
          smooth: true,
          symbolSize: 7,
          lineStyle: { width: 2.5, color: accent },
          itemStyle: { color: accent },
          areaStyle: { opacity: 0.08, color: accent },
          data: months.map((m) => m.unitsKept),
        },
      ],
    }),
    [months, accent],
  );

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader
          icon={<Lock />}
          title="What items cost us"
          backTo="/orders/returns"
          backLabel="Returns"
        />
        <div className="card">
          <EmptyState
            icon={<Lock />}
            title="You don’t have access to this"
            body="Returns are for the owner, developers, and the operations and support teams. If you write content, your work is under Products and Content."
          />
        </div>
      </div>
    );
  }

  const showSkeletons = loading || data === null;
  const t = data?.totals ?? null;
  const kept = t?.unitsKept ?? 0;

  /* `big` is optional and the annotation is what makes it readable on every
     member — without it the union's other arms have no such property and the
     JSX below cannot ask. */
  const tiles: { label: string; value: string | null; hint: string; big?: boolean }[] = [
    {
      label: 'What an item costs us',
      value: data === null ? null : kept === 0 ? '—' : money(data.perUnit.allIn, CURRENCY),
      hint:
        kept === 0
          ? 'Nothing settled in this period yet'
          : `Everything we spent, over ${kept.toLocaleString()} ${kept === 1 ? 'item' : 'items'} kept`,
      big: true,
    },
    {
      label: 'Paid to customers',
      value: t === null ? null : money(t.rewardMinor, CURRENCY),
      hint: data === null || kept === 0 ? '—' : `${money(data.perUnit.reward, CURRENCY)} an item`,
    },
    {
      label: 'Fetching them',
      value: t === null ? null : money(t.collectionMinor, CURRENCY),
      hint:
        data === null || kept === 0
          ? '—'
          : `${money(
              data.perUnit.allIn - data.perUnit.reward,
              CURRENCY,
            )} an item — transport, driver, loading`,
    },
    {
      label: 'Items kept',
      value: t === null ? null : t.unitsKept.toLocaleString(),
      hint:
        t === null
          ? '—'
          : `${t.returns} ${t.returns === 1 ? 'pickup' : 'pickups'} · ${t.unitsRejected} turned away`,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<BarChart3 />}
        title="What items cost us"
        backTo="/orders/returns"
        backLabel="Returns"
        subtitle="What we pay customers, plus what it costs to get their items to the workshop, over the items we actually kept."
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
        <>
          {data !== null && data.rates?.unitCostMinor == null ? (
            <Banner tone="warn" title="Nobody has said what an item is worth to us">
              The payouts below count as nothing until someone sets a price under Marketing →
              the returns programme. Everything about transport is still real.
            </Banner>
          ) : null}

          <div className="bento" style={{ gap: 'var(--s3)' }}>
            {tiles.map((tile) => (
              <div
                key={tile.label}
                className="card"
                style={{
                  gridColumn: tile.big ? 'span 6' : 'span 3',
                  padding: 'var(--s4)',
                  minWidth: 0,
                }}
              >
                <div
                  className="muted"
                  style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--w-medium)' }}
                >
                  {tile.label}
                </div>
                {showSkeletons || tile.value === null ? (
                  <span className="skel" style={{ width: '6rem', height: '1rem', marginTop: 6 }} />
                ) : (
                  <div
                    className="num"
                    style={{
                      fontSize: tile.big ? 'var(--t-3xl)' : 'var(--t-2xl)',
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

          <Coverage data={data} />
          <VersusNew data={data} />

          <Card title="What an item costs, month by month">
            {showSkeletons ? (
              <span className="skel" style={{ width: '100%', height: '20rem' }} aria-hidden="true" />
            ) : months.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                Nothing has been settled in this period yet. The chart draws the month the first
                pickup is paid out or turned away.
              </p>
            ) : (
              <EChart
                option={mixOption}
                height="22rem"
                ariaLabel="Stacked bar chart of what one item costs us each month, split into what we paid the customer, transport in, local delivery, driver, and loading and fees. Legend entries toggle each part in and out."
              />
            )}
            {!showSkeletons && months.length > 0 ? (
              <p className="muted" style={{ fontSize: 'var(--t-xs)' }}>
                Each bar is one month’s spending divided by the items it kept — so a month that
                collected more does not simply look worse. Click a legend entry to take that part
                out.
              </p>
            ) : null}
          </Card>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
              gap: 'var(--s4)',
              alignItems: 'stretch',
            }}
          >
            <Card title="How many we got">
              {showSkeletons ? (
                <span
                  className="skel"
                  style={{ width: '100%', height: '16rem' }}
                  aria-hidden="true"
                />
              ) : months.length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                  No items kept in this period yet.
                </p>
              ) : (
                <EChart
                  option={volumeOption}
                  height="16rem"
                  ariaLabel="Line chart of how many items were kept each month."
                />
              )}
              {!showSkeletons && months.length > 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-xs)' }}>
                  Read this beside the bars above: a costly month with very few items is a quiet
                  month, not a broken one.
                </p>
              ) : null}
            </Card>

            <Card
              title="The dearest pickups"
              action={<ButtonLink to="/orders/returns/analytics/areas">By district</ButtonLink>}
            >
              {showSkeletons ? (
                <span
                  className="skel"
                  style={{ width: '100%', height: '16rem' }}
                  aria-hidden="true"
                />
              ) : (data?.costliest ?? []).length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--t-md)' }}>
                  Nothing to rank yet — a pickup appears here once it has been paid out and kept at
                  least one item.
                </p>
              ) : (
                <div className="stack stack--tight">
                  {(data?.costliest ?? []).map((row) => (
                    <div
                      key={row.id}
                      className="row"
                      style={{ gap: 'var(--s2)', fontSize: 'var(--t-sm)' }}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {row.customerName || row.customerEmail}
                        <span className="muted">
                          {' · '}
                          {row.areaName ?? 'Out of area'}
                          {' · '}
                          {row.unitsKept} kept
                          {row.closedAt ? ` · ${shortDate(row.closedAt)}` : ''}
                          {row.estimated ? ' · estimated' : ''}
                        </span>
                      </span>
                      <span className="spacer" />
                      <strong className="num">{money(row.perUnitMinor, CURRENCY)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * HOW MUCH OF THE HEADLINE IS REAL.
 *
 * Drawn on every load, including the happy one, because "all of it" is
 * information too — and a disclosure that only appears when things are bad
 * teaches a reader to stop looking for it.
 */
function Coverage({ data }: { data: ReturnCostAnalytics | null }) {
  if (data === null) return null;
  /* Defensive: a bundle newer than the deployment answering it would get no
     `coverage` at all, and destructuring `undefined` takes the page down
     rather than one banner. */
  const { recorded = 0, estimated = 0, uncosted = 0 } = data.coverage ?? {};
  const total = recorded + estimated + uncosted;
  if (total === 0) return null;

  if (estimated === 0 && uncosted === 0) {
    return (
      <Banner tone="info" title="Every pickup has real figures">
        All {total} {total === 1 ? 'pickup' : 'pickups'} in this period had their costs written
        down, so nothing above is estimated.
      </Banner>
    );
  }

  return (
    <Banner
      tone={uncosted > 0 ? 'warn' : 'info'}
      title={`${recorded} of ${total} ${total === 1 ? 'pickup has' : 'pickups have'} real figures`}
    >
      {estimated > 0 ? (
        <>
          {estimated} {estimated === 1 ? 'is' : 'are'} using the standard cost for their district.{' '}
        </>
      ) : null}
      {uncosted > 0 ? (
        <>
          {uncosted} {uncosted === 1 ? 'has' : 'have'} no figures and no district standard, so{' '}
          {uncosted === 1 ? 'it counts' : 'they count'} as nothing —{' '}
          <strong>the real cost is higher than the number above</strong>. Set a standard on the
          district, or open the pickup and write down what it cost.
        </>
      ) : null}
    </Banner>
  );
}

/**
 * WHAT WE SAVE AGAINST BUYING NEW.
 *
 * The benchmark is LIVE and not snapshotted onto anything, so the sentence
 * says "today" out loud — comparing years of history against a price that
 * moved last week is only honest if the screen admits that is what it is
 * doing.
 */
function VersusNew({ data }: { data: ReturnCostAnalytics | null }) {
  if (data === null) return null;
  const bench = data.rates?.unitMarketCostMinor ?? null;
  if (bench === null || data.totals.unitsKept === 0) return null;

  const ours = data.perUnit.allIn;
  const gap = bench - ours;
  const saved = gap * data.totals.unitsKept;

  return (
    <Banner
      tone={gap > 0 ? 'info' : 'warn'}
      title={
        gap > 0
          ? `${money(gap, CURRENCY)} cheaper an item than buying new`
          : `${money(-gap, CURRENCY)} dearer an item than buying new`
      }
    >
      {gap > 0 ? (
        <>
          A new one costs {money(bench, CURRENCY)} today and this programme brought them in at{' '}
          {money(ours, CURRENCY)} — about <strong>{money(saved, CURRENCY)}</strong> saved across
          the {data.totals.unitsKept.toLocaleString()} items kept in this period.
        </>
      ) : (
        <>
          A new one costs {money(bench, CURRENCY)} today and these came in at{' '}
          {money(ours, CURRENCY)}. Worth checking the transport figures and the district standards
          before reading too much into it.
        </>
      )}
    </Banner>
  );
}
