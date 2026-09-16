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
const sessionFixture = vi.hoisted(() => ({
  role: 'owner' as import('../../../shared/roles').Role,
}));
vi.mock('../../data/session', () => ({
  getSession: () => ({
    status: 'authed' as const,
    user: {
      id: 'u_owner',
      email: 'owner@plaspool.com',
      displayName: 'Owner',
      role: sessionFixture.role,
    },
  }),
  subscribe: () => () => {},
}));
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
  sessionFixture.role = 'owner';
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

/* The money split adds up the way the server sums it: sales + discounts +
 * delivery + tax = charged, charged - refunded = net. */
const BODY: ShopAnalytics = {
  generatedAt: NOW,
  days: 30,
  totals: {
    sales: 10_000_000,
    discounts: -200_000,
    delivery: 1_500_000,
    tax: 1_045_600,
    charged: 12_345_600,
    refunded: 300_000,
    net: 12_045_600,
    orders: 4,
    items: 9,
    averageOrder: 2_500_000,
  },
  revenueByDay: [
    {
      day: watDay(NOW - 2 * DAY),
      sales: 7_500_000,
      discounts: -200_000,
      delivery: 1_200_000,
      tax: 845_600,
      charged: 9_345_600,
      refunded: 300_000,
      net: 9_045_600,
      orders: 3,
      manual: { charged: 4_000_000, orders: 1 },
    },
    {
      day: watDay(NOW),
      sales: 2_500_000,
      discounts: 0,
      delivery: 300_000,
      tax: 200_000,
      charged: 3_000_000,
      refunded: 0,
      net: 3_000_000,
      orders: 1,
      manual: { charged: 0, orders: 0 },
    },
  ],
  ordersByStatus: [
    { status: 'paid', count: 3 },
    { status: 'pending', count: 1 },
  ],
  /* Online and manual add up to `totals.charged`, as the server guarantees. */
  bySource: [
    {
      source: 'manual',
      sales: 3_800_000,
      discounts: 0,
      delivery: 200_000,
      tax: 0,
      charged: 4_000_000,
      refunded: 0,
      net: 4_000_000,
      orders: 1,
      items: 2,
    },
    {
      source: 'online',
      sales: 6_200_000,
      discounts: -200_000,
      delivery: 1_300_000,
      tax: 1_045_600,
      charged: 8_345_600,
      refunded: 300_000,
      net: 8_045_600,
      orders: 3,
      items: 7,
    },
  ],
  manualByChannel: [{ key: 'whatsapp', orders: 1, charged: 4_000_000 }],
  manualByMethod: [{ key: 'bank_transfer', orders: 1, charged: 4_000_000 }],
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

/** The tile card around a label — where its value and its basis sentence live.
 *  "Product sales" is ALSO the first line of the receipt card, so the tile is
 *  the match whose card carries no definition list. */
function tile(label: string): HTMLElement {
  const found = screen
    .getAllByText(label)
    .map((el) => el.closest('.card'))
    .find((card) => card !== null && card.querySelector('.defs') === null);
  if (!found) throw new Error(`no tile labelled ${label}`);
  return found as HTMLElement;
}

/** The receipt card: the money split, top to bottom. */
function receipt(): HTMLElement {
  const found = screen.getByText('Where the money went').closest('.card');
  if (found === null) throw new Error('no receipt card');
  return found as HTMLElement;
}

/** A Defs row's value, by its label, inside `root`. */
function rowValue(root: HTMLElement, label: string): string {
  const row = within(root).getByText(label).closest('.defs__row');
  if (row === null) throw new Error(`no row labelled ${label}`);
  return norm(row.querySelector('.defs__value')?.textContent ?? '');
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
       formatter — ITEM PRICES (not the charged total), count, sales-over-
       orders, items. */
    expect(await screen.findByText('Where the money went')).toBeTruthy();
    expect(
      within(tile('Product sales')).getByText(norm(money(10_000_000, 'NGN'))),
    ).toBeTruthy();
    expect(within(tile('Paid orders')).getByText('4')).toBeTruthy();
    expect(
      within(tile('Average order')).getByText(norm(money(2_500_000, 'NGN'))),
    ).toBeTruthy();
    expect(within(tile('Items sold')).getByText('9')).toBeTruthy();
    /* The charged total is nowhere on a tile — that was the bug. */
    expect(screen.queryByText('Sales after refunds')).toBeNull();

    /* And nothing is still pretending to load. */
    expect(document.querySelectorAll('.skel')).toHaveLength(0);
  });

  it('reads the money split as a receipt: sales, discounts, delivery, VAT, charged, refunded, collected', async () => {
    withAnalytics();
    mount();
    await screen.findByText('Where the money went');
    const card = receipt();

    expect(rowValue(card, 'Product sales')).toBe(norm(money(10_000_000, 'NGN')));
    expect(rowValue(card, 'Discounts')).toBe(norm(`−${money(200_000, 'NGN')}`));
    expect(rowValue(card, 'Delivery')).toBe(norm(money(1_500_000, 'NGN')));
    expect(rowValue(card, 'VAT')).toBe(norm(money(1_045_600, 'NGN')));
    expect(rowValue(card, 'Charged to customers')).toBe(norm(money(12_345_600, 'NGN')));
    expect(rowValue(card, 'Refunded')).toBe(norm(`−${money(300_000, 'NGN')}`));
    expect(rowValue(card, 'Collected after refunds')).toBe(norm(money(12_045_600, 'NGN')));
  });

  it('shows profit on products over the costed items only, and says how many had no cost', async () => {
    when(ANALYTICS, {
      ...BODY,
      ...{
        profit: {
          sales: 10_000_000,
          costedSales: 8_000_000,
          cost: 6_000_000,
          profit: 2_000_000,
          units: 9,
          costedUnits: 7,
          estimatedUnits: 0,
        },
      },
    });
    mount();
    const card = (await screen.findByText('Profit on products')).closest('.card') as HTMLElement;
    expect(rowValue(card, 'What those items cost you')).toBe(norm(`−${money(6_000_000, 'NGN')}`));
    expect(rowValue(card, 'Profit')).toBe(norm(money(2_000_000, 'NGN')));
    expect(rowValue(card, 'Profit margin')).toBe('25.0%');
    expect(within(card).getByText(/2 items have no cost recorded/)).toBeTruthy();
  });

  it('leaves the profit card out for a server that sends no profit', async () => {
    withAnalytics();
    mount();
    await screen.findByText('Where the money went');
    expect(screen.queryByText('Profit on products')).toBeNull();
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
    expect(await screen.findByText(/The last 90 days, taken straight from real orders/)).toBeTruthy();
  });

  it('renders the three charts with their accessible sentences, and the teaser links to the table subpage', async () => {
    withAnalytics();
    mount();
    await within(tile('Paid orders')).findByText('4');

    /* Three charts, no more: the daily bars, the status donut, the teaser. */
    expect(screen.getAllByTestId('echart')).toHaveLength(3);
    expect(
      screen.getByRole('img', {
        name: /product sales, delivery and VAT per day over the last 30 days/i,
      }),
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

  it('a content writer is gated with a graceful empty state and no fetch', async () => {
    /* The integration critic's finding: a writer (the one role without the
     * analytics domain) must degrade like the rest of the batch, not hit a
     * red load-failure banner. The gate is client-side and fetches nothing. */
    sessionFixture.role = 'writer';
    when(ANALYTICS, { body: {} }); // present but must never be called
    mount();

    expect(await screen.findByText('You don’t have access to this')).toBeTruthy();
    expect(queries()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('where sales came from', () => {
  /** The card, found by its heading — the only one carrying source rows. */
  function sourceCard(): HTMLElement {
    const card = screen.getByText('Where sales came from').closest('.card');
    if (!card) throw new Error('no source card');
    return card as HTMLElement;
  }

  it('splits the window into online and hand-recorded, and names the share', async () => {
    withAnalytics();
    render(
      <ToastHost>
        <MemoryRouter initialEntries={['/analytics']}>
          <Analytics />
        </MemoryRouter>
      </ToastHost>,
    );

    const card = await waitFor(() => sourceCard());
    const text = norm(card.textContent ?? '');
    expect(text).toContain(norm(money(8_345_600, 'NGN')));
    expect(text).toContain(norm(money(4_000_000, 'NGN')));
    expect(text).toContain('3 orders');
    expect(text).toContain('1 order');
    // 4,000,000 of 12,345,600 charged — the share the sentence claims.
    expect(text).toContain('32% of the money');
    // The two halves are printed with their sum, so the card reconciles itself.
    expect(text).toContain(norm(money(12_345_600, 'NGN')));
  });

  it('cuts the manual half by channel and by how it was paid, in the owner\'s words', async () => {
    withAnalytics();
    render(
      <ToastHost>
        <MemoryRouter initialEntries={['/analytics']}>
          <Analytics />
        </MemoryRouter>
      </ToastHost>,
    );

    const card = await waitFor(() => sourceCard());
    expect(within(card).getByText('How those sales came in')).toBeTruthy();
    expect(within(card).getByText('How they were paid')).toBeTruthy();
    const text = norm(card.textContent ?? '');
    // The enum values never reach the screen: the labels the form uses do.
    expect(text).toContain('WhatsApp');
    expect(text).toContain('Bank transfer');
    expect(text).not.toContain('bank_transfer');
  });

  it('is absent entirely when nothing was recorded by hand', async () => {
    when(ANALYTICS, (url) => ({
      body: {
        ...BODY,
        days: Number(url.searchParams.get('days') ?? '30'),
        bySource: [BODY.bySource[1]],
        manualByChannel: [],
        manualByMethod: [],
      },
    }));
    render(
      <ToastHost>
        <MemoryRouter initialEntries={['/analytics']}>
          <Analytics />
        </MemoryRouter>
      </ToastHost>,
    );

    // The screen has loaded — the receipt card is there — and the source card is not.
    await screen.findByText('Where the money went');
    expect(screen.queryByText('Where sales came from')).toBeNull();
  });
});
