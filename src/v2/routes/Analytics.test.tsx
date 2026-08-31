import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The analytics screen, rebuilt on the server aggregate. What these tests pin
 * is the DATA FLOW — the wire and what lands on screen:
 *
 *  - **The tiles print the server's own numbers**, formatted through the one
 *    shared money formatter — no client re-derivation survives the rewrite.
 *  - **The default range says nothing on the wire.** The route defaults
 *    `days` to 30 itself; the opening read must carry NO `days` param, and
 *    switching the picker to 90d must refetch with the literal `?days=90`
 *    (the schema is `z.enum(['7','30','90','365'])` — anything else is a 400).
 *  - **A 403 is a sentence, not a blank.** `ForbiddenError`'s message lands
 *    in the critical banner with a Retry.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop-analytics`: the path and the
 * query string are exactly what a mocked module would assert nothing about.
 *
 * `../ui/EChart` IS MOCKED, deliberately: jsdom has no canvas, so
 * `echarts.init` cannot paint here — and pixels are not what this suite is
 * for. The stub renders the `ariaLabel` each chart receives, so the tests
 * assert that the right CHARTS exist with the right accessible sentences,
 * while the option plumbing stays the component's own code.
 */
vi.mock('../ui/EChart', async () => {
  const { createElement } = await import('react');
  return {
    EChart: (props: { ariaLabel: string }) =>
      createElement('div', {
        'data-testid': 'echart',
        role: 'img',
        'aria-label': props.ariaLabel,
      }),
  };
});

import { money } from '../lib/format';
import type { ShopAnalytics } from '../../data/api-shop-analytics';
import { ToastHost } from '../ui/Toast';
import Analytics from './Analytics';

/* What jsdom does not implement and the v2 chrome touches. */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

beforeEach(() => {
  handlers.clear();
  calls = [];
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({ path: url.pathname + url.search, init });
      const handler = handlers.get(url.pathname);
      const answer = handler
        ? handler(url, init)
        : { status: 404, body: { error: 'gone', requestId: 'req_test' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// -------------------------------------------------------------- the harness

const ANALYTICS = '/api/shop/admin/analytics';

const DAY = 86_400_000;
const NOW = 1_756_224_000_000;

/** The server's WAT bucketing (UTC+1), repeated so fixture days really land
 *  inside the calendar the component builds from `generatedAt`. */
const watDay = (epochMs: number): string =>
  new Date(epochMs + 3_600_000).toISOString().slice(0, 10);

const BODY: ShopAnalytics = {
  generatedAt: NOW,
  days: 30,
  totals: { net: 12_345_600, orders: 4, items: 9, averageOrder: 3_086_400 },
  revenueByDay: [
    { day: watDay(NOW - 2 * DAY), net: 9_345_600, orders: 3 },
    { day: watDay(NOW), net: 3_000_000, orders: 1 },
  ],
  ordersByStatus: [
    { status: 'paid', count: 3 },
    { status: 'pending', count: 1 },
  ],
  topProducts: [
    { variantId: 'var_1', sku: 'SP-1', title: 'A spool', units: 6, gross: 9_000_000 },
    { variantId: 'var_2', sku: 'SP-2', title: 'Another spool', units: 3, gross: 3_345_600 },
  ],
};

/** The route's own behaviour: `days` echoed back, defaulting to 30. */
function withAnalytics(): void {
  when(ANALYTICS, (url) => ({
    body: { ...BODY, days: Number(url.searchParams.get('days') ?? '30') },
  }));
}

/** Every GET of the aggregate, oldest first, as its parsed query string. */
const queries = (): URLSearchParams[] =>
  calls
    .filter((c) => c.path.split('?')[0] === ANALYTICS && (c.init.method ?? 'GET') === 'GET')
    .map((c) => new URLSearchParams(c.path.split('?')[1] ?? ''));

/**
 * `Intl` writes a no-break space between code and digits; testing-library's
 * default normalizer collapses every whitespace run to a plain space before
 * matching. Expected strings must go through the same wash or they miss the
 * very text on screen.
 */
const norm = (s: string): string => s.replace(/\s+/g, ' ');

/** The tile card around a label — where its value and its basis sentence live. */
function tile(label: string): HTMLElement {
  const found = screen.getByText(label).closest('.card');
  if (found === null) throw new Error(`no tile labelled ${label}`);
  return found as HTMLElement;
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/analytics']}>
        <Analytics />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('the analytics screen', () => {
  it('shows skeletons first, then the four tiles printing the server’s own numbers', async () => {
    withAnalytics();
    mount();

    /* Before the response lands, the wait is skeleton blocks, not a blank. */
    expect(document.querySelectorAll('.skel').length).toBeGreaterThan(0);

    /* Then each tile carries the aggregate's number through the shared money
       formatter — net, count, net-over-orders, items. */
    expect(
      await within(tile('Net revenue')).findByText(norm(money(12_345_600, 'NGN'))),
    ).toBeTruthy();
    expect(within(tile('Paid orders')).getByText('4')).toBeTruthy();
    expect(
      within(tile('Average order')).getByText(norm(money(3_086_400, 'NGN'))),
    ).toBeTruthy();
    expect(within(tile('Items sold')).getByText('9')).toBeTruthy();

    /* And nothing is still pretending to load. */
    expect(document.querySelectorAll('.skel')).toHaveLength(0);
  });

  it('asks with no days param by default, and refetches with ?days=90 when the picker moves', async () => {
    const user = userEvent.setup();
    withAnalytics();
    mount();
    await within(tile('Paid orders')).findByText('4');

    /* The opening read carries NOTHING — the server's default is the answer,
       not a client echo of it. */
    expect(queries()).toHaveLength(1);
    expect(queries()[0]!.get('days')).toBeNull();

    await user.click(screen.getByRole('button', { name: '90d' }));
    await waitFor(() => expect(queries()).toHaveLength(2));
    /* The literal '90' — the route's z.enum refuses anything else. */
    expect(queries()[1]!.get('days')).toBe('90');
    expect(await screen.findByText(/The last 90 days, from real orders/)).toBeTruthy();
  });

  it('renders the three charts with their accessible sentences, and the teaser links to the table subpage', async () => {
    withAnalytics();
    mount();
    await within(tile('Paid orders')).findByText('4');

    /* Three charts, no more: the daily bars, the status donut, the teaser. */
    expect(screen.getAllByTestId('echart')).toHaveLength(3);
    expect(
      screen.getByRole('img', { name: /net revenue per day over the last 30 days/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /orders by status over the last 30 days/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /top 2 products by gross revenue/i }),
    ).toBeTruthy();

    /* The table itself does NOT render here — that is the subpage's whole
       reason to exist. The teaser offers the way there instead. */
    expect(screen.queryByRole('table')).toBeNull();
    const link = screen.getByRole('link', { name: 'See the full table' });
    expect(link.getAttribute('href')).toBe('/analytics/products');
  });

  it('turns a 403 into the critical banner with the permission sentence and a Retry', async () => {
    when(ANALYTICS, { error: 'forbidden', requestId: 'req_test' }, 403);
    mount();

    expect(await screen.findByText('Couldn’t load analytics')).toBeTruthy();
    expect(screen.getByText('You do not have permission to do that')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    /* The refused screen draws no chart it has no data for. */
    expect(screen.queryAllByTestId('echart')).toHaveLength(0);
  });
});
