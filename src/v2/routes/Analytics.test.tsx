import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The analytics screen, pinned on its honesty rule — nothing on it is
 * fabricated, and each assertion below is one way that rule quietly breaks:
 *
 *  - **A curve over days it never read.** The order sweep is capped at eight
 *    pages; when the cap stops it while still INSIDE the 30-day window, older
 *    days exist that the bars cannot see, and the screen must say so. The
 *    notice must also NOT appear when the sweep stopped because it reached
 *    past the window — that sweep saw everything the chart draws.
 *  - **Gross bars.** A day's bar is `grandTotal - refundedTotal` over paid
 *    orders. Drawing gross would overstate every day somebody was refunded,
 *    which is precisely the day an operator comes here to understand.
 *  - **A client total where the server has a better one.** The revenue tile
 *    prefers `stats()`'s own 30-day aggregate — computed over EVERY order —
 *    and only falls back to the swept subtotal when the server offered no row
 *    for the currency, naming its basis either way.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`: the path, the cursor
 * threading and the response shape are what the sweep gets wrong silently,
 * and a mocked module asserts none of them.
 */

import { money } from '../lib/format';
import type { ShopOrderRow } from '../../data/api-shop';
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

/** GETs of exactly this path, cursors and all. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

const STATS = '/api/shop/admin/stats';
const ORDERS = '/api/shop/admin/orders';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** One paid order-with-lines row, the exact wrapper shape the list sends. */
function orderRow(
  id: string,
  placedAt: number,
  over: Partial<ShopOrderRow['order']> = {},
): ShopOrderRow {
  const grandTotal = over.grandTotal ?? 500_000;
  return {
    order: {
      id,
      orderNumber: `PL-${id}`,
      customerId: null,
      email: 'buyer@test.local',
      currency: 'NGN',
      subtotal: grandTotal,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal,
      refundedTotal: 0,
      status: 'paid',
      shippingAddress: {},
      billingAddress: {},
      placedAt,
      paidAt: placedAt,
      fulfilledAt: null,
      deliveredAt: null,
      cancelledAt: null,
      revision: 1,
      checkoutId: `chk_${id}`,
      paymentIntentId: null,
      ...over,
    },
    lines: [
      {
        id: `${id}_l1`,
        lineNo: 1,
        variantId: 'var_1',
        sku: 'SP-1',
        title: 'A spool',
        optionValues: {},
        qty: 1,
        unitAmount: grandTotal,
        lineTotal: grandTotal,
        fulfilledQty: 0,
      },
    ],
  };
}

/** `stats()`'s full shape — only `revenue` matters here, but the wire is whole. */
function statsBody(revenue: { currency: string; last24h: number; last7d: number; last30d: number }[]) {
  return {
    generatedAt: Date.now(),
    ordersByStatus: [],
    revenue,
    lowStockThreshold: 5,
    lowStock: [],
    lowStockMore: false,
    emails: { pending: 0, stuck: 0, sent: 0 },
    latestOrders: [],
  };
}

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
  it('shows the partial-coverage notice exactly when the page cap stops the sweep inside the window', async () => {
    const NOW = Date.now();
    when(STATS, statsBody([]));
    /*
     * Eight pages, every order inside the window, every page offering a next
     * cursor — so the CAP is what ends the sweep, with older in-window days
     * still unread. That is the one condition the banner exists for.
     */
    when(ORDERS, (url) => {
      const cursor = url.searchParams.get('cursor');
      const page = cursor ? Number(cursor.slice(1)) : 0;
      return {
        body: {
          items: [
            orderRow(`o${page}a`, NOW - (page * 2 + 1) * HOUR),
            orderRow(`o${page}b`, NOW - (page * 2 + 2) * HOUR),
          ],
          nextCursor: `c${page + 1}`,
        },
      };
    });
    mount();

    const banner = await screen.findByText('Partial daily coverage');
    /* The note names the actual coverage rather than apologising vaguely. */
    expect(banner.closest('.banner')?.textContent).toContain('the most recent 16 orders');
    expect(reads(ORDERS)).toBe(8);

    cleanup();
    calls = [];

    /*
     * The same sweep stopped by the WINDOW instead: a page still offers a
     * cursor, but its oldest row is already older than 30 days — everything
     * the chart draws was read, so there is nothing to disclose.
     */
    when(ORDERS, {
      items: [orderRow('recent', NOW - HOUR), orderRow('ancient', NOW - 40 * DAY)],
      nextCursor: 'c1',
    });
    mount();

    await screen.findByText(norm(`peak ${money(500_000, 'NGN')}`));
    expect(screen.queryByText('Partial daily coverage')).toBeNull();
    /* …and the offered cursor was never followed: the window ended the walk. */
    expect(reads(ORDERS)).toBe(1);
  });

  it('nets refunds out of the daily bars', async () => {
    const NOW = Date.now();
    when(STATS, statsBody([]));
    when(ORDERS, {
      items: [orderRow('o1', NOW - 3 * HOUR, { grandTotal: 500_000, refundedTotal: 200_000 })],
      nextCursor: null,
    });
    mount();

    /* The chart's own scale line reads the netted figure — a gross bar would
       print ₦5,000 here and overstate the day somebody was refunded on. */
    expect(await screen.findByText(norm(`peak ${money(300_000, 'NGN')}`))).toBeTruthy();

    /* The day's tooltip carries the same net, and the gross appears nowhere. */
    const titles = [...document.querySelectorAll('svg title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes(money(300_000, 'NGN')) && t.includes('1 order'))).toBe(
      true,
    );
    expect(titles.some((t) => t.includes(money(500_000, 'NGN')))).toBe(false);

    /* The derived tiles agree about what one paid order was worth net. */
    expect(within(tile('Average order')).getByText(norm(money(300_000, 'NGN')))).toBeTruthy();
  });

  it('prefers the server’s own 30-day figure on the revenue tile, and names its basis', async () => {
    const NOW = Date.now();
    /* The swept orders net to 300,000; the server's aggregate over EVERY
       order says 1,234,500. The tile must show the server's number. */
    when(ORDERS, {
      items: [orderRow('o1', NOW - HOUR, { grandTotal: 500_000, refundedTotal: 200_000 })],
      nextCursor: null,
    });
    when(STATS, statsBody([{ currency: 'NGN', last24h: 0, last7d: 0, last30d: 1_234_500 }]));
    mount();

    const revenue = tile('Net revenue · 30d');
    expect(await within(revenue).findByText(norm(money(1_234_500, 'NGN')))).toBeTruthy();
    expect(within(revenue).getByText('Server total, every order')).toBeTruthy();
    expect(within(revenue).queryByText(norm(money(300_000, 'NGN')))).toBeNull();

    cleanup();
    calls = [];

    /* No aggregate for the currency → the honest fallback is the swept
       subtotal, and the basis sentence says so rather than posing as a total. */
    when(STATS, statsBody([]));
    mount();

    const fallback = tile('Net revenue · 30d');
    expect(await within(fallback).findByText(norm(money(300_000, 'NGN')))).toBeTruthy();
    expect(within(fallback).getByText('From the swept orders')).toBeTruthy();
  });
});
