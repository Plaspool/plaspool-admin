import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * THE ORDER LIST, AGAINST THE PAYLOAD THE DEPLOYED SERVER ACTUALLY SENDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, WHEN `Shop.test.tsx` ALREADY HAS ELEVEN ORDER TESTS.
 *
 * Because all eleven passed while the screen was dead. `GET /shop/admin/orders`
 * returns `{ items: [{ order, lines }] }`; the fixture in that file was
 * `{ items: [ORDER] }` — flat — and the client type said `Page<ShopOrder>`,
 * which `shopFetch` asserts without checking. So the screen read `placedAt` off
 * a wrapper, got `undefined`, and `Intl.DateTimeFormat.format(new Date(undefined))`
 * threw `RangeError: Invalid time value` into the route's error boundary. Every
 * operator saw "This screen ran into a problem". The suite saw green.
 *
 * The bug was a fixture that disagreed with the server. A test written from the
 * same wrong assumption cannot catch it, so this file does not invent a payload
 * at all: `__fixtures__/orders-live.json` is a VERBATIM CAPTURE of the
 * production response, and every assertion below runs against those bytes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EXACTLY WHAT THIS FILE GUARANTEES, AND WHAT IT CANNOT.
 *
 * IT GUARANTEES THE SCREEN. Against this payload — the real one — the list
 * renders, the dates are dates, the totals are naira, and a field that arrives
 * broken costs one cell instead of the route. That is a regression gate on
 * `ShopOrders.tsx`, and a strong one, because the input is not something
 * anybody here made up.
 *
 * IT DOES NOT GUARANTEE THE SERVER, AND AN EARLIER VERSION OF THIS COMMENT SAID
 * IT DID. "If the server's shape moves, this file fails" was false. The capture
 * is a static file with no link to any server, and the shape assertions compare
 * it to string literals — which is to say, to itself. Change the route tomorrow
 * and this file goes on passing against yesterday's bytes, which is precisely
 * the failure mode it was written about, one layer up. A capture can pin the
 * SCREEN to a payload; only something that runs the real app can pin the payload
 * to the server.
 *
 * SO THAT HALF LIVES IN `server/shop/admin/orders-list-shape.test.ts`, which
 * drives a real order through the real `createApp()`, asks
 * `GET /api/shop/admin/orders` as an admin, and asserts `items[0]` carries
 * exactly `order` and `lines`. One gate, two halves, and neither is sufficient
 * alone — CLAUDE.md §2: "Anything money-adjacent needs a test through the real
 * `createApp()`."
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

import { ToastProvider } from '../components/Toast';
import { formatMinor } from '../data/api-shop';
import { UNRENDERABLE } from '../data/when';
import ShopOrders from './ShopOrders';
import LIVE from './__fixtures__/orders-live.json';

// jsdom gaps Radix's Select needs; same block as `Shop.test.tsx`.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

let body: unknown = LIVE;

beforeEach(() => {
  body = LIVE;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'https://studio.test');
      const answer = url.pathname.startsWith('/api/shop/admin/orders')
        ? body
        : { error: 'gone', requestId: 'req_test' };
      return new Response(JSON.stringify(answer), {
        status: url.pathname.startsWith('/api/shop/admin/orders') ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(cleanup);

/** Testing Library's own whitespace rule, applied to the expectation too. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * `?view=table` IS THE DEFAULT HERE AND IS NOT A WEAKENING OF ANYTHING.
 *
 * `/shop/orders` now opens the board, and the board is a different question:
 * every assertion below is about a ROW of the list — a date rendered as a date,
 * a total in major units, one broken field costing one cell — and the table is
 * the surface that has rows and cells. Naming the view keeps each of them
 * pointed at what it was written to catch, against the same captured payload.
 *
 * The board reads the same fields through the same `safeFormatMinor`, and its
 * own coverage lives in `orders/Board.test.tsx`.
 */
function mount(at = '/shop/orders?view=table') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <ShopOrders />
      </MemoryRouter>
    </ToastProvider>,
  );
}

// ---------------------------------------------------------------- the shape

describe('the captured production payload', () => {
  /*
   * THE ASSERTION THAT WOULD HAVE CAUGHT THE OUTAGE, and it is about the
   * FIXTURE rather than about any screen. A flat `items[0].placedAt` is what
   * every order test in `Shop.test.tsx` believed in; this says out loud that the
   * server has never sent one.
   */
  it('nests each order under `order`, with its lines beside it — never flat', () => {
    const row = LIVE.items[0] as Record<string, unknown>;

    expect(Object.keys(row).sort()).toEqual(['lines', 'order']);
    expect(row).not.toHaveProperty('placedAt');
    expect(row).not.toHaveProperty('orderNumber');
    expect(LIVE.items.every((r) => typeof r.order.placedAt === 'number')).toBe(true);
    expect(LIVE.items.every((r) => Array.isArray(r.lines))).toBe(true);
  });

  it('carries `fulfilledQty` on every line — the only fulfilment signal the list has', () => {
    // The board derives "packed or not" from this and nothing else; the list
    // endpoint returns no fulfilment rows. If it ever stops arriving, the board
    // silently parks every paid order in "To pack".
    for (const row of LIVE.items) {
      for (const line of row.lines) expect(typeof line.fulfilledQty).toBe('number');
    }
  });

  it('holds two spellings of one region, which is why geography must normalise', () => {
    const regions = new Set(
      LIVE.items.map((r) => (r.order.shippingAddress as { region?: string }).region),
    );
    // Live data, not a contrivance: `Abuja` and `Federal Capital Territory` are
    // the same place, and shipping zones match on this field (CLAUDE.md §6).
    expect(regions.has('Abuja')).toBe(true);
    expect(regions.has('Federal Capital Territory')).toBe(true);
  });
});

// ---------------------------------------------------------------- the screen

describe('the order list, driven by that payload', () => {
  it('renders every captured order instead of throwing on the first date', async () => {
    mount();

    // The exact five order numbers from production. Before the fix this
    // expectation never ran: the render threw on `2026-000006-S`'s date.
    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());
    for (const n of ['2026-000005-F', '2026-000004-T', '2026-000002-U', '2026-000001-H']) {
      expect(screen.getByText(n)).toBeTruthy();
    }
  });

  it('renders the placed date as a date, not as a dash', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());

    // 1787175360356 is a real epoch; if the screen reads the wrapper again it
    // renders the placeholder, and this fails loudly rather than silently.
    const cells = screen.getAllByText((_t, el) => el?.className === 'num');
    expect(cells.length).toBe(LIVE.items.length);
    for (const cell of cells) expect(cell.textContent).not.toBe(UNRENDERABLE);
  });

  it('shows naira totals in major units, from the frozen minor ones', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());

    /*
     * COMPARED ON NORMALISED WHITESPACE, because `Intl.NumberFormat` separates
     * the currency from the digits with U+00A0 and Testing Library's default
     * normaliser collapses it to U+0020 — so the literal `formatMinor` output
     * never equals the rendered text, and an exact `getByText` here fails on a
     * screen that is entirely correct.
     */
    const money = (minor: number) => norm(formatMinor(minor, 'NGN'));
    const shown = screen
      .getAllByText((_t, el) => el?.className === 'dtable__num')
      .map((el) => norm(el.textContent ?? ''));

    // 2_500_000 minor = ₦25,000.00. NOT "2500000", NOT "₦2,500,000".
    expect(shown).toContain(money(2_500_000));
    expect(shown.filter((s) => s === money(2_600_000)).length).toBe(4);
  });

  /*
   * THE DOWNGRADE, ASSERTED. The type is fixed, so the specific bug is gone —
   * but the class of bug (a field that is not the number it was declared to be)
   * is one unchecked assertion away at all times. What must never come back is
   * the ESCALATION: a bad cell has to stay a bad cell.
   */
  it('renders a placeholder — not an error screen — when a date arrives broken', async () => {
    body = {
      items: LIVE.items.map((row, i) => ({
        ...row,
        order: { ...row.order, placedAt: i === 0 ? undefined : row.order.placedAt },
      })),
      nextCursor: null,
    };

    mount();

    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());
    // The broken row still lists its number, its email and its total.
    expect(screen.getByText(UNRENDERABLE)).toBeTruthy();
    expect(screen.getByText('2026-000001-H')).toBeTruthy();
    expect(screen.queryByText(/ran into a problem/i)).toBeNull();
  });

  /*
   * THE SAME DOWNGRADE, ON THE COLUMN IT DID NOT USED TO COVER.
   *
   * That guarantee was written for dates and held for dates only. Running the
   * test above with `grandTotal: undefined` in place of `placedAt` failed
   * exactly the way `/shop/orders` failed in production — `MoneyShapeError:
   * money must be an integer of minor units, got undefined` thrown out of
   * `formatMinor` at render time, `<body><div /></body>`, no order list at all.
   * A screen that survives one broken field and dies on the next one along has
   * not been made safe; it has been made lucky.
   *
   * `grandTotal` rather than a line amount because it is the one on every row of
   * the LIST. The detail panel is one order the operator chose to open; the list
   * is the screen they cannot get past.
   */
  it('renders a placeholder — not an error screen — when a total arrives broken', async () => {
    body = {
      items: LIVE.items.map((row, i) => ({
        ...row,
        order: { ...row.order, grandTotal: i === 0 ? undefined : row.order.grandTotal },
      })),
      nextCursor: null,
    };

    mount();

    // Every OTHER row still lists its number: one unreadable amount costs one
    // cell, not the four orders beside it.
    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());
    for (const n of ['2026-000005-F', '2026-000004-T', '2026-000002-U', '2026-000001-H']) {
      expect(screen.getByText(n)).toBeTruthy();
    }

    const totals = screen
      .getAllByText((_t, el) => el?.className === 'dtable__num')
      .map((el) => norm(el.textContent ?? ''));
    expect(totals).toContain(UNRENDERABLE);
    expect(totals).toContain(norm(formatMinor(2_600_000, 'NGN')));

    // The date beside the broken total is untouched: the downgrade is per value.
    const dates = screen.getAllByText((_t, el) => el?.className === 'num');
    for (const cell of dates) expect(cell.textContent).not.toBe(UNRENDERABLE);

    expect(screen.queryByText(/ran into a problem/i)).toBeNull();
  });

  /*
   * A CURRENCY IS THE OTHER HALF OF AN AMOUNT, and guarding only the number
   * would have left the screen just as reachable: `currencyDigits` swallows a
   * code `Intl` refuses, but `formatMinor` then builds a second
   * `Intl.NumberFormat` with `style: 'currency'`, and THAT constructor throws
   * `RangeError: Invalid currency code`. The amount here is a good integer.
   */
  it('renders a placeholder when the currency is missing, not just the amount', async () => {
    body = {
      items: LIVE.items.map((row, i) => ({
        ...row,
        order: { ...row.order, currency: i === 0 ? undefined : row.order.currency },
      })),
      nextCursor: null,
    };

    mount();

    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());
    expect(screen.getByText('2026-000001-H')).toBeTruthy();

    const totals = screen
      .getAllByText((_t, el) => el?.className === 'dtable__num')
      .map((el) => norm(el.textContent ?? ''));
    expect(totals).toContain(UNRENDERABLE);

    expect(screen.queryByText(/ran into a problem/i)).toBeNull();
  });
});

// ------------------------------------------------- the orders with no lane

/**
 * `awaiting_payment` IS NOT A LANE, AND THIS IS THE HALF OF THAT CHANGE THAT
 * KEEPS THE ORDERS ON THE SCREEN.
 *
 * `orders/Board.tsx` argues why an unpaid order gets no column — nothing an
 * operator does moves one — and `orders/Board.test.tsx` pins the lane's absence
 * and the staleness boundary as functions. What is asserted HERE is the debt:
 * the count above the lanes is honest about the difference, the row is one link
 * away, and the notice that means "a payment event went missing" fires on a
 * stale order while staying silent on an ordinary one.
 *
 * THE CLOCK IS REAL. `readAt` is `Date.now()` at the moment the page is read and
 * nothing on this screen lets a test set it, so the ages below are built from
 * the real clock and sit far from the boundary on purpose. The boundary itself
 * is pinned to the millisecond beside the rule that owns it.
 */
describe('the orders the board does not draw', () => {
  /** The capture with its first order left unpaid `agoMs` ago — the shape
   *  `createOrderFromCheckout` INSERTs, which no payment event has touched. */
  const unpaidPage = (agoMs: number) => ({
    items: [
      {
        ...LIVE.items[0],
        order: {
          ...LIVE.items[0].order,
          status: 'pending',
          paidAt: null,
          placedAt: Date.now() - agoMs,
        },
      },
      ...LIVE.items.slice(1),
    ],
    nextCursor: null,
  });

  it('counts the board by cards drawn and names the order that is not on it', async () => {
    body = unpaidPage(90_000); // a minute and a half: entirely ordinary
    mount('/shop/orders');

    /*
     * FIVE ROWS CAME BACK AND FOUR ARE DRAWN. "5 orders on the board" over four
     * cards is the one number here an operator would check by counting, so the
     * count is of cards and the difference is named in the next line rather than
     * left as a card somebody goes looking for.
     */
    await waitFor(() => expect(screen.getByText('4 orders on the board')).toBeTruthy());
    expect(screen.queryByText('5 orders on the board')).toBeNull();
    expect(screen.getByText(/more is awaiting payment and has no lane/)).toBeTruthy();

    // The sentence is checked against the canvas rather than against the arithmetic
    // that produced it: four cards, and the number above them says four.
    expect(document.querySelectorAll('.shopcard')).toHaveLength(4);
  });

  it('says nothing about a payment that is merely in flight', async () => {
    // 90 s. The live capture's own capture-to-payment gaps are 191 ms, 22 s and
    // 63 s, so this is a normal Tuesday and the screen must not remark on it.
    body = unpaidPage(90_000);
    mount('/shop/orders');

    await waitFor(() => expect(screen.getByText('4 orders on the board')).toBeTruthy());
    expect(screen.queryByText(/Check the payment provider/)).toBeNull();
    expect(document.querySelector('.notice')).toBeNull();
    // …and it is STILL reachable while nothing is wrong with it.
    expect(screen.getByRole('link', { name: 'The table lists it' }).getAttribute('href')).toBe(
      '/shop/orders?view=table&status=pending',
    );
  });

  it('raises a notice for one that has been pending for hours, and says what to do', async () => {
    body = unpaidPage(3 * 60 * 60_000);
    mount('/shop/orders');

    await waitFor(() =>
      expect(screen.getByText('One order has been awaiting payment for 3 hours.')).toBeTruthy(),
    );

    /*
     * THE WORDS ARE THE POINT. "1 order pending" is a fact nobody can act on;
     * what an operator needs is that no event is coming and that the money may
     * already be sitting at the provider.
     */
    const notice = document.querySelector('.notice');
    expect(notice?.className).toContain('notice--warn');
    expect(notice?.textContent).toMatch(/Check the payment provider/);
    expect(notice?.textContent).toMatch(/never lands/);
    // Not an alarm: no live region, no danger tone, nothing that interrupts.
    expect(notice?.getAttribute('role')).toBeNull();
    expect(notice?.className).not.toContain('notice--danger');
  });

  it('names the oldest when there is more than one', async () => {
    const now = Date.now();
    body = {
      items: LIVE.items.map((row, i) =>
        i < 2
          ? {
              ...row,
              order: {
                ...row.order,
                status: 'pending',
                paidAt: null,
                placedAt: now - (i === 0 ? 4 * 60 * 60_000 : 30 * 60 * 60_000),
              },
            }
          : row,
      ),
      nextCursor: null,
    };
    mount('/shop/orders');

    // The OLDEST, not the newest and not the first in the payload: a day and a
    // quarter, floored to "1 day" the way `ageLabel` floors everything.
    await waitFor(() =>
      expect(
        screen.getByText('2 orders are awaiting payment, the oldest for 1 day.'),
      ).toBeTruthy(),
    );
    expect(screen.getByText('3 orders on the board')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Show them' })).toBeTruthy();
  });

  it('links the notice at those orders, on an address this screen already reads', async () => {
    const user = userEvent.setup();
    body = unpaidPage(3 * 60 * 60_000);
    mount('/shop/orders');

    await waitFor(() => expect(screen.getByRole('link', { name: 'Show the order' })).toBeTruthy());
    const link = screen.getByRole('link', { name: 'Show the order' });
    expect(link.getAttribute('href')).toBe('/shop/orders?view=table&status=pending');

    // Followed, it lands on the surface that shows the row — the board is not
    // the only way off this screen, which is what makes dropping the lane safe.
    await user.click(link);
    await waitFor(() => expect(screen.getByText('2026-000006-S')).toBeTruthy());
    expect(screen.getAllByText('Awaiting payment').length).toBeGreaterThan(0);
  });

  it('stays silent, and says nothing extra, when every order has been paid', async () => {
    body = LIVE; // the capture as it came: five paid orders
    mount('/shop/orders');

    await waitFor(() => expect(screen.getByText('5 orders on the board')).toBeTruthy());
    expect(document.querySelector('.notice')).toBeNull();
    expect(screen.queryByText(/awaiting payment and has no lane/)).toBeNull();
  });
});
