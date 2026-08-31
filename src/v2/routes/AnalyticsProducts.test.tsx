import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The best-sellers subpage — the TABLE half of the analytics split. Pinned:
 *
 *  - **The rows print the server's numbers and a share that adds up.** Gross
 *    goes through the one shared money formatter; the share column is each
 *    row's gross over the sum of every row's gross, one decimal — so with two
 *    rows at 3:1 the column must read 75.0% and 25.0%, summing to 100%.
 *  - **Its range picker is its own.** Switching it refetches with the literal
 *    `?days=7` — the route's `z.enum` refuses anything else.
 *  - **An empty window is a sentence, not a bare table.**
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop-analytics` — the path and the
 * query string are what a mocked module would assert nothing about. No EChart
 * mock here: this page deliberately renders no chart.
 */

import { money } from '../lib/format';
import type { ShopAnalytics } from '../../data/api-shop-analytics';
import { ToastHost } from '../ui/Toast';
vi.mock('../../data/session', () => ({
  getSession: () => ({
    status: 'authed' as const,
    user: {
      id: 'u_owner',
      email: 'owner@plaspool.com',
      displayName: 'Owner',
      role: 'owner' as import('../../../shared/roles').Role,
    },
  }),
  subscribe: () => () => {},
}));
import AnalyticsProducts from './AnalyticsProducts';

/* What jsdom does not implement and the v2 chrome touches — `ResizeObserver`
   is the load-bearing one: `TableScroll` observes the scroller the moment the
   table mounts. */
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

const NOW = 1_756_224_000_000;

/** Two sellers at a 3:1 gross split, so the share column has one right answer. */
const BODY: ShopAnalytics = {
  generatedAt: NOW,
  days: 30,
  totals: { net: 12_000_000, orders: 4, items: 15, averageOrder: 3_000_000 },
  revenueByDay: [],
  ordersByStatus: [],
  topProducts: [
    { variantId: 'var_1', sku: 'SP-1', title: 'A spool', units: 12, gross: 9_000_000 },
    { variantId: 'var_2', sku: 'SP-2', title: 'Another spool', units: 3, gross: 3_000_000 },
  ],
};

function withProducts(): void {
  when(ANALYTICS, (url) => ({
    body: { ...BODY, days: Number(url.searchParams.get('days') ?? '30') },
  }));
}

/** Every GET of the aggregate, oldest first, as its parsed query string. */
const queries = (): URLSearchParams[] =>
  calls
    .filter((c) => c.path.split('?')[0] === ANALYTICS && (c.init.method ?? 'GET') === 'GET')
    .map((c) => new URLSearchParams(c.path.split('?')[1] ?? ''));

const norm = (s: string): string => s.replace(/\s+/g, ' ');

/** The row a product's title lives on. */
function rowOf(title: string): HTMLElement {
  const found = screen.getByText(title).closest('tr');
  if (found === null) throw new Error(`no row titled ${title}`);
  return found as HTMLElement;
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/analytics/products']}>
        <AnalyticsProducts />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('the best-sellers subpage', () => {
  it('renders each row’s units, formatted gross, and a share column that sums to 100%', async () => {
    withProducts();
    mount();

    const top = await waitFor(() => rowOf('A spool'));
    expect(within(top).getByText('12')).toBeTruthy();
    expect(within(top).getByText(norm(money(9_000_000, 'NGN')))).toBeTruthy();
    /* 9,000,000 of 12,000,000 gross — 75.0%, one decimal. */
    expect(within(top).getByText('75.0%')).toBeTruthy();
    expect(within(top).getByText('SP-1')).toBeTruthy();

    const second = rowOf('Another spool');
    expect(within(second).getByText('3')).toBeTruthy();
    expect(within(second).getByText(norm(money(3_000_000, 'NGN')))).toBeTruthy();
    expect(within(second).getByText('25.0%')).toBeTruthy();

    /* The footer names the table's basis — gross, with refunds netted on the
       parent page rather than guessed per product. */
    expect(
      screen.getByText(/Refunds apply to whole orders/),
    ).toBeTruthy();
  });

  it('has its own range picker: switching to 7d refetches with the literal ?days=7', async () => {
    const user = userEvent.setup();
    withProducts();
    mount();
    await waitFor(() => rowOf('A spool'));

    expect(queries()).toHaveLength(1);
    expect(queries()[0]!.get('days')).toBeNull();

    await user.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(queries()).toHaveLength(2));
    expect(queries()[1]!.get('days')).toBe('7');
  });

  it('shows the empty state when nothing sold in the window', async () => {
    when(ANALYTICS, { ...BODY, topProducts: [] });
    mount();

    expect(await screen.findByText('Nothing sold in this window yet')).toBeTruthy();
    /* No footer note under a table with nothing in it. */
    expect(
      screen.queryByText(/Refunds apply to whole orders/),
    ).toBeNull();
  });
});
