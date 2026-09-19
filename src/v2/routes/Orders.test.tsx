import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * THE ORDERS LIST'S REFRESH STATUS BUTTON, and the report it turns a sweep into.
 *
 * WHY THIS BUTTON IS ON THE LIST AT ALL — the fact that decides everything here:
 * a capture whose webhook was lost leaves NO ORDER. The intent never moves, the
 * checkout never completes, `shop_orders` never gets a row. So there is no detail
 * screen to press a button on and nothing on this list to click, and this header
 * is the only place the recovery can start from.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards suite
 * gives: the path and the method are what a backend written in another session
 * gets silently wrong, and a mocked module asserts neither. `sweepReport` is
 * exported and tested directly as well, because it is the part with all the cases
 * in it and driving nine wordings through a rendered table would prove less.
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
import Orders, { sweepReport } from './Orders';
import type { SweepRun } from '../../data/api-shop';

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

function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

const NOW = 1756224000000;
const LIST = '/api/shop/admin/orders';
const SWEEP = '/api/shop/admin/sweep';

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  fixture.session.user.role = 'owner';
});

const row = {
  order: {
    id: 'ord_1',
    orderNumber: 'PP-1042-7',
    customerId: null,
    email: 'buyer@test.local',
    currency: 'NGN',
    subtotal: 500000,
    shippingTotal: 30000,
    taxTotal: 0,
    grandTotal: 530000,
    refundedTotal: 0,
    status: 'paid',
    placedAt: NOW - 86_400_000,
    paidAt: NOW - 86_000_000,
    fulfilledAt: null,
    deliveredAt: null,
    cancelledAt: null,
    revision: 1,
    source: 'online',
  },
  lines: [{ id: 'line_1', qty: 2, title: 'Recycled Spool', sku: 'SPL-RED' }],
};

/** One sweep answer, with only the fields a case cares about set. */
function sweep(over: Partial<SweepRun> = {}): SweepRun {
  return {
    intents: { checked: 0, changed: 0, captured: 0, failed: 0 },
    payments: { count: 0 },
    events: { applied: 0, ignored: 0, parked: 0, passes: 1 },
    emails: { sent: 0, failed: 0, skipped: 0 },
    couriers: { checked: 0, changed: 0, transitioned: 0, failed: 0 },
    seeded: 0,
    passes: 1,
    ...over,
  };
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/orders']}>
        <Orders />
      </MemoryRouter>
    </ToastHost>,
  );
}

const loaded = (): Promise<HTMLElement> => screen.findByText('PP-1042-7');

describe('the Refresh status button', () => {
  it('runs the sweep, names what it found, and reloads the list', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [row], nextCursor: null });
    when(SWEEP, sweep({ intents: { checked: 3, changed: 1, captured: 1, failed: 0 } }));
    mount();
    await loaded();
    const before = reads(LIST);

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    /*
     * `POST /admin/sweep` — the SAME route the ten-minute cron calls, not a
     * second endpoint doing the same work. A repair path that is not the
     * scheduled path is a repair path nobody exercises.
     */
    await waitFor(() => expect(sent(SWEEP, 'POST')).toEqual({}));
    expect(await screen.findByText('1 payment had gone through — this page is up to date now.')).toBeTruthy();
    /* And the list is re-read, because the recovered order was not on it. */
    await waitFor(() => expect(reads(LIST)).toBeGreaterThan(before));
  });

  it('is not offered to a writer, who the server would 403', async () => {
    fixture.session.user.role = 'writer';
    when(LIST, { items: [row], nextCursor: null });
    mount();
    await loaded();

    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
  });

  it('reports a failure rather than swallowing it', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [row], nextCursor: null });
    when(SWEEP, { error: 'forbidden', requestId: 'req_test' }, 403);
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    /* The server's own reason, shown rather than swallowed — a button that
       silently does nothing is how an operator concludes the feature is broken
       when what they actually lack is permission. */
    expect(await screen.findByText('You do not have permission to do that')).toBeTruthy();
  });
});

describe('what the sweep is reported as', () => {
  it('names a recovered payment, which is the case it exists for', () => {
    expect(sweepReport(sweep({ intents: { checked: 4, changed: 1, captured: 1, failed: 0 } }))).toEqual({
      text: '1 payment had gone through — this page is up to date now.',
      critical: false,
    });
  });

  it('counts a payment that changed without being money found, separately', () => {
    /* The gateway now calls it failed or cancelled: still the screen catching up,
       but not a sale recovered, so it must not be reported as one. */
    expect(
      sweepReport(sweep({ intents: { checked: 2, changed: 2, captured: 1, failed: 0 } })).text,
    ).toBe('1 payment had gone through and 1 payment changed — this page is up to date now.');
  });

  it('names payments and parcels together', () => {
    const out = sweepReport(
      sweep({
        intents: { checked: 2, changed: 1, captured: 1, failed: 0 },
        couriers: { checked: 3, changed: 2, transitioned: 2, failed: 0 },
      }),
    );
    expect(out.text).toBe('1 payment had gone through and 2 parcels moved — this page is up to date now.');
  });

  it('says plainly when nothing moved', () => {
    /* A useful answer to "the gateway shows a payment and my admin doesn't": the
       money is genuinely not there, so the problem is somewhere else. */
    expect(sweepReport(sweep()).text).toBe(
      'Nothing new — the gateway and the couriers agree with what’s here.',
    );
  });

  it('is critical when something could not be reached, even if something moved', () => {
    const out = sweepReport(
      sweep({
        intents: { checked: 2, changed: 1, captured: 1, failed: 1 },
      }),
    );
    expect(out.critical).toBe(true);
    expect(out.text).toContain('1 couldn’t be reached');
  });

  it('does not claim to have checked anything when nothing is wired', () => {
    /*
     * `null` IS NOT ZERO. No gateway and no courier configured means we did not
     * ask — reporting that as "nothing found" would tell an owner their payments
     * had been checked when nothing of the kind happened.
     */
    expect(sweepReport(sweep({ intents: null, couriers: null }))).toEqual({
      text: 'Nothing to check — no gateway or courier is set up here.',
      critical: false,
    });
  });

  it('reads an older response, from before the sweep reported either, as unknown', () => {
    const old = sweep();
    delete old.intents;
    delete old.couriers;
    expect(sweepReport(old).text).toBe('Nothing to check — no gateway or courier is set up here.');
  });
});

describe('when the payment pass could not run at all', () => {
  it('says so instead of reporting zero, and is critical', () => {
    /*
     * `checked: 0` means "we looked and found nothing to ask about". An `error`
     * means nobody looked — a database missing migration 1320 is the concrete
     * case — and those must not read the same. The rest of the sweep still ran,
     * so the message says that too rather than implying a total failure.
     */
    const out = sweepReport(
      sweep({ intents: { checked: 0, changed: 0, captured: 0, failed: 0, error: 'candidates_failed' } }),
    );
    expect(out.critical).toBe(true);
    expect(out.text).toContain('Couldn’t check the payments');
    expect(out.text).not.toContain('Nothing new');
  });
});
