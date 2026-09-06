import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * "What items cost us", pinned on the four things it can get wrong QUIETLY.
 *
 *  - **The headline divides by items KEPT.** Everything the programme spent
 *    over the items it actually got — so a wasted pickup pushes the number up
 *    rather than hiding in a bigger denominator. The screen renders the
 *    server's own `perUnit`, and the test asserts the FIGURE, because a screen
 *    that quietly re-derived it from the totals would be right today and wrong
 *    the first time a pickup came back with nothing.
 *  - **The coverage line always draws.** It is the sentence that says how much
 *    of the headline is a receipt and how much is a district standard standing
 *    in. A disclosure that only appears when things are bad teaches a reader to
 *    stop looking for it, so the happy case is asserted too.
 *  - **`uncosted` means the headline is an UNDERSTATEMENT**, and the words have
 *    to say so. Those pickups contribute nothing at all, so the real figure is
 *    higher — the opposite of what a reader would assume from a warning.
 *  - **The out-of-area group is NAMED.** It has a null district id because it
 *    is the absence of a place; a table that rendered a blank cell would look
 *    like a bug in the data rather than a real group worth acting on.
 *
 * `fetch` IS STUBBED, NOT the api module: the path, the method and the query
 * are exactly what a screen gets silently wrong against a backend written in
 * another session, and a mocked module asserts none of them.
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

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { ToastHost } from '../ui/Toast';
import {
  emptyReturnCostAnalytics,
  returnCostAnalytics,
} from '../../data/marketing-fixtures';
import SpoolsAnalytics from './SpoolsAnalytics';
import SpoolsAnalyticsAreas from './SpoolsAnalyticsAreas';

/* jsdom gaps the v2 chrome touches. `ResizeObserver` is load-bearing:
   `TableScroll` observes its own scroller on mount, so the district table
   never renders without it. ECharts needs a canvas context it will not get
   here — the component is stubbed to a marker instead, because what this
   suite is about is the numbers and the words, not the pixels. */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock('../ui/EChart', () => ({
  EChart: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div data-testid="chart" aria-label={ariaLabel} />
  ),
}));

// --------------------------------------------------------------- the server

let calls: string[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: returnCostAnalytics };

const ANALYTICS = '/api/marketing/returns/analytics';

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: returnCostAnalytics };
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push(url.pathname + url.search);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.session.user.role = 'owner';
});

const mount = () =>
  render(
    <ToastHost>
      <MemoryRouter initialEntries={['/spools/analytics']}>
        <SpoolsAnalytics />
      </MemoryRouter>
    </ToastHost>,
  );

const mountAreas = () =>
  render(
    <ToastHost>
      <MemoryRouter initialEntries={['/spools/analytics/areas']}>
        <SpoolsAnalyticsAreas />
      </MemoryRouter>
    </ToastHost>,
  );

/**
 * Money, matched WITHOUT its symbol.
 *
 * `Intl` renders NGN as "₦315.00" under a full ICU and "NGN 315.00" under a
 * small one, with a non-breaking space between — so an exact string here is a
 * test that passes on a laptop and fails in CI for a reason that has nothing
 * to do with the screen. The digits are what these assertions are about.
 */
const norm = (content: string) => content.replace(/ /g, ' ').trim();

/** The element whose WHOLE text is this money value — so a matcher cannot also
 *  match every ancestor that happens to contain it. */
const amount = (digits: string) => (content: string) => {
  const text = norm(content);
  return /^(?:₦|NGN ?)?[\d.,]+$/.test(text) && text.includes(digits);
};

/** …and the looser one, for a money value inside a sentence. */
const says = (digits: string, phrase: string) => (content: string) => {
  const text = norm(content);
  return text.includes(digits) && text.includes(phrase);
};

// ============================================================================

describe('what items cost us', () => {
  it('leads with the all-in cost per item and shows the two halves it is made of', async () => {
    mount();

    /* ₦312 an item: ₦100 paid to the customer and ₦212 to fetch them. The gap
       between the headline rate and this number is the whole feature. */
    expect(await screen.findByText(amount('315.00'))).toBeTruthy();
    expect(screen.getByText('What an item costs us')).toBeTruthy();
    expect(screen.getAllByText(/1,240 items kept/).length).toBeGreaterThan(0);

    expect(screen.getByText('Paid to customers')).toBeTruthy();
    expect(screen.getByText(amount('124,000.00'))).toBeTruthy();
    expect(screen.getByText('Fetching them')).toBeTruthy();
    expect(screen.getByText(amount('266,600.00'))).toBeTruthy();

    /* 96 pickups, 61 items turned away — read beside the kept count, that is
       what explains a period whose cost per item jumped. */
    expect(screen.getByText(/96 pickups · 61 turned away/)).toBeTruthy();
  });

  it('asks the server for the default range without echoing it, and for a chosen one by name', async () => {
    const user = userEvent.setup();
    mount();

    await screen.findByText(amount('315.00'));
    /* The wire carries only what DIFFERS from the default, so the route's
       answer is its own default and never a copy the client holds. */
    expect(calls[0]).toBe(ANALYTICS);

    await user.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(calls.some((c) => c === `${ANALYTICS}?range=all`)).toBe(true));
  });

  it('says how much of the headline is estimated, and that uncosted pickups make it an understatement', async () => {
    mount();

    await screen.findByText(amount('315.00'));
    expect(screen.getByText('78 of 96 pickups have real figures')).toBeTruthy();
    expect(screen.getByText(/14 are using the standard cost for their district/)).toBeTruthy();
    /* The sharp end: four pickups count as nothing, so the truth is DEARER
       than the headline. A reader who assumed a warning meant "too high"
       would draw exactly the wrong conclusion. */
    expect(screen.getByText(/the real cost is higher than the number above/)).toBeTruthy();
  });

  it('draws the coverage line even when every pickup is costed', async () => {
    answer = {
      status: 200,
      body: {
        ...returnCostAnalytics,
        coverage: { recorded: 96, estimated: 0, uncosted: 0 },
      },
    };
    mount();

    /* A disclosure that only shows up when something is wrong is one a reader
       learns to stop looking for. */
    expect(await screen.findByText('Every pickup has real figures')).toBeTruthy();
  });

  it('compares against buying new, and says the benchmark is today’s', async () => {
    mount();

    /* ₦850 new against ₦315 ours. The comparison is against a LIVE figure, so
       the copy has to admit that rather than imply the saving was measured at
       the time each item came in. */
    expect(
      await screen.findByText(says('535.00', 'cheaper an item than buying new')),
    ).toBeTruthy();
    expect(screen.getAllByText(says('850.00', 'today')).length).toBeGreaterThan(0);
  });

  it('says nobody has set a price rather than printing a confident zero', async () => {
    answer = { status: 200, body: emptyReturnCostAnalytics };
    mount();

    expect(await screen.findByText('Nobody has said what an item is worth to us')).toBeTruthy();
    /* And with nothing settled, the headline is a dash — not ₦0, which would
       read as "we get them for free". */
    expect(screen.getByText('Nothing settled in this period yet')).toBeTruthy();
    /* A dash and not ₦0, which would read as "we get them for free". */
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shuts a content writer out rather than letting them hit a 403', async () => {
    fixture.session.user.role = 'writer';
    mount();

    expect(await screen.findByText('You don’t have access to this')).toBeTruthy();
    /* Not one request: the screen knows it would be refused, so it does not
       ask and then paint a red banner over the answer. */
    expect(calls).toEqual([]);
  });
});

describe('by district', () => {
  it('ranks districts dearest first and marks the ones above average', async () => {
    mountAreas();

    const rows = await screen.findAllByRole('row');
    const text = rows.map((r) => r.textContent ?? '');
    /* Turnip Hill at ₦600 an item is the row worth acting on, so it is first
       — the order is the point of the page. */
    expect(text.findIndex((t) => t.includes('Turnip Hill'))).toBeLessThan(
      text.findIndex((t) => t.includes('Cabbage Quarter')),
    );
    expect(screen.getAllByText('above average').length).toBeGreaterThan(0);
  });

  it('names the out-of-area group instead of leaving a blank cell', async () => {
    mountAreas();

    /* It has a null district id because it is the ABSENCE of a place. A blank
       cell would read as broken data rather than as a real group. */
    expect(await screen.findByText('Out of area')).toBeTruthy();
    expect(screen.getByText('Belongs to no board')).toBeTruthy();
  });

  it('flags a district whose figures are partly estimated', async () => {
    mountAreas();

    await screen.findByText('Turnip Hill');
    const row = screen.getByText('Turnip Hill').closest('tr');
    if (row === null) throw new Error('no row');
    /* Four of the twelve pickups had nothing typed. The row is still shown —
       it is real spending — but it is labelled, because the reader is about
       to act on it. */
    expect(within(row as HTMLElement).getByText(/\(4 est\.\)/)).toBeTruthy();
  });

  it('holds its own range, so two tabs do not clobber one another', async () => {
    const user = userEvent.setup();
    mountAreas();

    await screen.findByText('Turnip Hill');
    expect(calls[0]).toBe(ANALYTICS);
    await user.click(screen.getByRole('button', { name: '30d' }));
    await waitFor(() => expect(calls.some((c) => c === `${ANALYTICS}?range=30`)).toBe(true));
  });
});
