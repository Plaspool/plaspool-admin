import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * THE CURRENCIES CARD on `/settings/payments` — naira is the only real price,
 * and every other currency is a published multiplier the storefront applies.
 *
 * Pinned here because each is wrong quietly rather than loudly:
 *
 *  - **A rate that travels as a number.** `"0.008496176720"` as a JSON number
 *    is a float some parser rounds; the server takes TEXT and parses it
 *    exactly. So the PUT body is asserted key by key, and its type.
 *  - **A switch that forgets the revision.** Switching a currency on or off is
 *    CAS on `revision`; a body without it would be a 400, and one with a stale
 *    one has to become the conflict banner, never a silent second PATCH.
 *  - **A reason nobody can read.** "no_gateway" is a code; the owner needs
 *    "No payment gateway takes it" and what to do about it.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-currency`, for the reason the
 * rewards suite gives: the path, the method and the body are the three things
 * most likely to be silently wrong against a backend written in another
 * session, and a mocked module asserts none of them.
 *
 * NO `@testing-library/jest-dom` IN THIS REPO, so text assertions read
 * `.textContent`.
 */

import { ToastHost } from '../ui/Toast';

const sessionFixture = {
  session: {
    status: 'authed' as const,
    user: {
      id: 'u_owner',
      email: 'owner@plaspool.com',
      displayName: 'Owner',
      role: 'owner' as import('../../../shared/roles').Role,
    },
  },
};

vi.mock('../../data/session', () => ({
  getSession: () => sessionFixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import SettingsPayments from './SettingsPayments';

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
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** Every request to this exact path with this method, oldest first. */
const requests = (pathname: string, method: string) =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);

const bodiesOf = (pathname: string, method: string): unknown[] =>
  requests(pathname, method).map((c) => JSON.parse(String(c.init.body)) as unknown);

/** Every write that has gone anywhere, in arrival order. */
const writes = (): string[] =>
  calls
    .filter((c) => (c.init.method ?? 'GET') !== 'GET')
    .map((c) => `${c.init.method} ${c.path.split('?')[0]}`);

beforeEach(() => {
  handlers.clear();
  calls = [];
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

// -------------------------------------------------------------- the fixtures

const PAYMENTS = '/api/shop/admin/payments/settings';
const CURRENCY = '/api/shop/admin/payments/currency';
const rateOf = (code: string) => `${CURRENCY}/${code}/multiplier`;

const NOW = Date.UTC(2026, 8, 11, 9, 0);
const HOUR = 3_600_000;

const paymentSettings = {
  activeProvider: 'paystack',
  internationalProvider: 'flutterwave',
  revision: 4,
  gateways: {
    paystack: { hasKey: true, currencies: ['NGN'], canCharge: ['NGN', 'USD'] },
    flutterwave: { hasKey: true, currencies: ['NGN', 'GHS', 'USD', 'KES'], canCharge: ['NGN', 'GHS', 'USD', 'KES', 'ZAR', 'EUR'] },
  },
};

type Row = {
  code: string;
  exponent: number | null;
  store: boolean;
  enabled: boolean;
  multiplier: string | null;
  source: 'feed' | 'manual' | null;
  updatedAt: number | null;
  ageHours: number | null;
  gateway: boolean;
  offered: boolean;
  reason: null | 'disabled' | 'no_rate' | 'stale' | 'no_gateway' | 'unknown_currency';
};

const ngn: Row = { code: 'NGN', exponent: 2, store: true, enabled: true, multiplier: '1.000000000000', source: null, updatedAt: null, ageHours: null, gateway: true, offered: true, reason: null };
const ghs: Row = { code: 'GHS', exponent: 2, store: false, enabled: true, multiplier: '0.008496176720', source: 'feed', updatedAt: NOW - 3 * HOUR, ageHours: 3, gateway: true, offered: true, reason: null };
const usd: Row = { code: 'USD', exponent: 2, store: false, enabled: true, multiplier: null, source: null, updatedAt: null, ageHours: null, gateway: true, offered: false, reason: 'no_rate' };
const kes: Row = { code: 'KES', exponent: 2, store: false, enabled: true, multiplier: '0.084000000000', source: 'feed', updatedAt: NOW - 200 * HOUR, ageHours: 200, gateway: true, offered: false, reason: 'stale' };
const zar: Row = { code: 'ZAR', exponent: 2, store: false, enabled: true, multiplier: '0.011500000000', source: 'manual', updatedAt: NOW - 30 * HOUR, ageHours: 30, gateway: false, offered: false, reason: 'no_gateway' };
const eur: Row = { code: 'EUR', exponent: 2, store: false, enabled: false, multiplier: '0.000580000000', source: 'feed', updatedAt: NOW - 5 * HOUR, ageHours: 5, gateway: true, offered: false, reason: 'disabled' };

function view(currencies: Row[], revision = 7, feedMarginBps = 0) {
  return {
    storeCurrency: 'NGN',
    revision,
    stalenessHours: 168,
    feedMarginBps,
    refreshAfterHours: 12,
    fallbackCurrency: 'NGN',
    countries: { GH: 'GHS', KE: 'KES', ZA: 'ZAR', US: 'USD' },
    known: ['NGN', 'GHS', 'USD', 'GBP', 'EUR', 'KES', 'ZAR'],
    offered: currencies.filter((c) => c.offered).map((c) => c.code),
    currencies,
  };
}

const START = view([ngn, ghs, usd, kes, zar, eur]);

const REFRESH = `${CURRENCY}/refresh`;

/** What one fetch of the daily rates did, as `server/shop/currency/feed.ts` answers it. */
function refreshOf(over: Partial<{
  skipped: boolean;
  source: string | null;
  refreshed: string[];
  unchanged: string[];
  manual: string[];
  missing: string[];
  error: null | 'feed_unavailable';
}> = {}) {
  return {
    skipped: false,
    source: 'test-feed',
    refreshed: [],
    unchanged: [],
    manual: ['ZAR'],
    missing: [],
    error: null,
    ...over,
  };
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/payments']}>
        <SettingsPayments />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** The list item for one currency, once the card has loaded. */
async function item(label: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: 'Currencies' });
  return within(list).getByRole('listitem', { name: label });
}

// ============================================================================

describe('Settings → Payments → Currencies', () => {
  it('shows each rate in words and exactly, where it came from, and why a currency is not offered', async () => {
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    mount();

    const naira = await item('Naira (NGN)');
    expect(naira.textContent).toContain('Always on');
    expect(naira.textContent).toContain('Offered to shoppers');
    /* The store currency cannot be switched off, so it has no switch at all. */
    expect(within(naira).queryByRole('switch')).toBeNull();

    const cedis = await item('Cedis (GHS)');
    expect(cedis.textContent).toContain('1 naira = 0.008496 cedis');
    expect(cedis.textContent).toContain('0.008496176720');
    expect(cedis.textContent).toContain('Daily rate, updated 3 hours ago');
    expect(cedis.textContent).toContain('Offered to shoppers');
    /* Only a hand-set rate can go back to the daily one. */
    expect(within(cedis).queryByRole('button', { name: /daily rate/ })).toBeNull();

    const dollars = await item('Dollars (USD)');
    expect(dollars.textContent).toContain('Not offered: no rate yet');
    expect(dollars.textContent).toContain('Set one by hand, or wait for the daily rate.');

    const kenyan = await item('Kenyan shillings (KES)');
    expect(kenyan.textContent).toContain('Not offered: rate out of date');
    expect(kenyan.textContent).toContain('hasn’t updated in over 7 days');
    expect(kenyan.textContent).toContain('updated 8 days ago');

    const rand = await item('Rand (ZAR)');
    expect(rand.textContent).toContain('Not offered: no payment gateway takes it');
    expect(rand.textContent).toContain('Set by hand, never goes out of date');

    const euros = await item('Euros (EUR)');
    expect(euros.textContent).toContain('Switched off');
    expect((within(euros).getByRole('switch') as HTMLInputElement).checked).toBe(false);

    expect(screen.getByText(/Everyone else pays in naira\./)).toBeTruthy();
    /* Reading the screen wrote nothing. */
    expect(writes()).toEqual([]);
  });

  it('sets a rate by hand as the TEXT typed, never a number, and refuses a thirteenth decimal first', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    when(rateOf('GHS'), view([ngn, { ...ghs, multiplier: '0.008500000000', source: 'manual', ageHours: 0 }, usd, kes, zar, eur], 8));
    mount();

    const cedis = await item('Cedis (GHS)');
    await user.click(within(cedis).getByRole('button', { name: 'Set Cedis (GHS) rate by hand' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set the cedis rate by hand' });
    const input = within(dialog).getByLabelText('GHS per 1 naira') as HTMLInputElement;
    /* Opens on the current rate, exactly, trailing zeros dropped. */
    expect(input.value).toBe('0.00849617672');

    await user.clear(input);
    await user.type(input, '0.0085000000001');
    await user.click(within(dialog).getByRole('button', { name: 'Save rate' }));
    expect(dialog.textContent).toContain('up to 12 digits after the point');
    expect(requests(rateOf('GHS'), 'PUT')).toHaveLength(0);

    await user.clear(input);
    await user.type(input, '0.0085');
    expect(dialog.textContent).toContain('1 naira = 0.0085 cedis');
    await user.click(within(dialog).getByRole('button', { name: 'Save rate' }));

    await waitFor(() => expect(requests(rateOf('GHS'), 'PUT')).toHaveLength(1));
    const body = bodiesOf(rateOf('GHS'), 'PUT')[0] as Record<string, unknown>;
    expect(body).toEqual({ multiplier: '0.0085' });
    expect(typeof body.multiplier).toBe('string');
    expect(writes()).toEqual([`PUT ${rateOf('GHS')}`]);

    /* Re-rendered from the response, not from what was typed. */
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const after = await item('Cedis (GHS)');
    expect(after.textContent).toContain('0.008500000000');
    expect(after.textContent).toContain('Set by hand');
  });

  it('goes back to the daily rate with a bodiless DELETE', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    when(rateOf('ZAR'), view([ngn, ghs, usd, kes, { ...zar, multiplier: null, source: null, updatedAt: null, ageHours: null, reason: 'no_rate' }, eur], 8));
    mount();

    const rand = await item('Rand (ZAR)');
    await user.click(within(rand).getByRole('button', { name: 'Use the daily rate for Rand (ZAR)' }));

    await waitFor(() => expect(requests(rateOf('ZAR'), 'DELETE')).toHaveLength(1));
    expect(requests(rateOf('ZAR'), 'DELETE')[0]!.init.body).toBeUndefined();
    expect(writes()).toEqual([`DELETE ${rateOf('ZAR')}`]);
    await waitFor(async () => expect((await item('Rand (ZAR)')).textContent).toContain('No rate yet.'));
  });

  it('switches a currency on and off with `enabled` and the revision it read', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    let revision = 7;
    when(CURRENCY, (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: START };
      const body = JSON.parse(String(init.body)) as { enabled: string[] };
      revision += 1;
      return {
        body: view(
          [ngn, ghs, usd, kes, zar, eur].map((c) =>
            c.store ? c : { ...c, enabled: body.enabled.includes(c.code) },
          ),
          revision,
        ),
      };
    });
    mount();

    const euros = await item('Euros (EUR)');
    await user.click(within(euros).getByRole('switch'));
    await waitFor(() => expect(requests(CURRENCY, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(CURRENCY, 'PATCH')[0]).toEqual({
      enabled: ['NGN', 'GHS', 'USD', 'KES', 'ZAR', 'EUR'],
      revision: 7,
    });

    /* The next switch carries the revision the PATCH answered, not the first one. */
    await waitFor(async () =>
      expect((within(await item('Euros (EUR)')).getByRole('switch') as HTMLInputElement).checked).toBe(true),
    );
    await user.click(within(await item('Cedis (GHS)')).getByRole('switch'));
    await waitFor(() => expect(requests(CURRENCY, 'PATCH')).toHaveLength(2));
    expect(bodiesOf(CURRENCY, 'PATCH')[1]).toEqual({
      enabled: ['NGN', 'USD', 'KES', 'ZAR', 'EUR'],
      revision: 8,
    });
  });

  it('switches on a currency that is not listed yet from the picker', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: START }
        : { body: view([ngn, ghs, usd, kes, zar, eur, { ...usd, code: 'GBP' }], 8) },
    );
    mount();

    await item('Cedis (GHS)');
    const picker = screen.getByLabelText('Switch on another currency') as HTMLSelectElement;
    /* Only currencies not already on the list are offered. */
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'GBP']);
    await user.selectOptions(picker, 'GBP');

    await waitFor(() => expect(requests(CURRENCY, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(CURRENCY, 'PATCH')[0]).toEqual({
      enabled: ['NGN', 'GHS', 'USD', 'KES', 'ZAR', 'GBP'],
      revision: 7,
    });
  });

  it('turns a stale revision into the conflict banner and a re-read, never a second PATCH', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: view([ngn, ghs, usd, kes, zar, eur], 9) }
        : { status: 409, body: { error: 'stale_write', expected: 7, actual: 9 } },
    );
    mount();

    const euros = await item('Euros (EUR)');
    const readsBefore = requests(CURRENCY, 'GET').length;
    await user.click(within(euros).getByRole('switch'));

    expect(await screen.findByText('Someone else changed this while you had it open')).toBeTruthy();
    expect(requests(CURRENCY, 'PATCH')).toHaveLength(1);
    await waitFor(() => expect(requests(CURRENCY, 'GET').length).toBe(readsBefore + 1));
  });

  it('says plainly when the viewer may not change currencies', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: START }
        : { status: 403, body: { error: 'forbidden' } },
    );
    mount();

    await user.click(within(await item('Euros (EUR)')).getByRole('switch'));
    expect(await screen.findByText(/You don’t have access to this\./)).toBeTruthy();
  });

  // ------------------------------------------------------------ daily rates

  /** The one-line result beside "Refresh rates now". */
  const refreshLine = () => within(screen.getByRole('group', { name: 'Daily rates' })).getByRole('status');

  it('says the daily rates refresh on their own, and how often', async () => {
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    mount();

    await item('Cedis (GHS)');
    expect(screen.getByText('Daily rates update on their own about every 12 hours.')).toBeTruthy();
    expect((screen.getByLabelText('Add to the daily rate') as HTMLInputElement).value).toBe('0');
    expect(writes()).toEqual([]);
  });

  it('refreshes the rates now with a bodiless POST, and says which moved and which the service lacked', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    when(REFRESH, {
      ...view([ngn, { ...ghs, multiplier: '0.008600000000', ageHours: 0 }, usd, kes, zar, eur], 8),
      refresh: refreshOf({ refreshed: ['GHS'], unchanged: ['EUR'], missing: ['USD', 'KES'] }),
    });
    mount();

    await item('Cedis (GHS)');
    await user.click(screen.getByRole('button', { name: 'Refresh rates now' }));

    await waitFor(() => expect(requests(REFRESH, 'POST')).toHaveLength(1));
    expect(requests(REFRESH, 'POST')[0]!.init.body).toBeUndefined();
    expect(writes()).toEqual([`POST ${REFRESH}`]);

    await waitFor(() =>
      expect(refreshLine().textContent).toBe(
        'Rates updated: GHS. The rate service had no rate for USD and KES.',
      ),
    );
    /* Re-rendered from the response. */
    expect((await item('Cedis (GHS)')).textContent).toContain('0.008600000000');
  });

  it('says so when the refresh changed nothing', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    when(REFRESH, { ...START, refresh: refreshOf({ unchanged: ['GHS', 'KES', 'EUR'] }) });
    mount();

    await item('Cedis (GHS)');
    await user.click(screen.getByRole('button', { name: 'Refresh rates now' }));
    await waitFor(() => expect(refreshLine().textContent).toBe('Rates checked — no change.'));
  });

  it('says plainly when the rate service could not be reached', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, START);
    when(REFRESH, { ...START, refresh: refreshOf({ source: null, error: 'feed_unavailable' }) });
    mount();

    await item('Cedis (GHS)');
    await user.click(screen.getByRole('button', { name: 'Refresh rates now' }));
    await waitFor(() =>
      expect(refreshLine().textContent).toBe('Couldn’t reach the rate service. Try again later.'),
    );
    expect(refreshLine().className).toContain('field__error');
  });

  it('saves the margin as INTEGER basis points with the revision, and refuses one over 50% first', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: START }
        : {
            body: {
              ...view([ngn, { ...ghs, multiplier: '0.008751062022', ageHours: 0 }, usd, kes, zar, eur], 8, 300),
              refresh: refreshOf({ refreshed: ['GHS', 'EUR'] }),
            },
          },
    );
    mount();

    await item('Cedis (GHS)');
    const input = screen.getByLabelText('Add to the daily rate') as HTMLInputElement;
    const save = () => within(screen.getByRole('group', { name: 'Daily rates' })).getByRole('button', { name: 'Save' });
    /* Nothing to save until the number changes. */
    expect((save() as HTMLButtonElement).disabled).toBe(true);

    await user.clear(input);
    await user.type(input, '60');
    await user.click(save());
    expect(screen.getByText('Use a number from 0 to 50, with up to 2 decimals.')).toBeTruthy();
    expect(requests(CURRENCY, 'PATCH')).toHaveLength(0);

    await user.clear(input);
    await user.type(input, '3');
    await user.click(save());

    await waitFor(() => expect(requests(CURRENCY, 'PATCH')).toHaveLength(1));
    const body = bodiesOf(CURRENCY, 'PATCH')[0] as Record<string, unknown>;
    expect(body).toEqual({ feedMarginBps: 300, revision: 7 });
    expect(Number.isInteger(body.feedMarginBps)).toBe(true);
    expect(writes()).toEqual([`PATCH ${CURRENCY}`]);

    /* The new margin re-fetched the rates; that is said too. */
    await waitFor(() => expect(refreshLine().textContent).toBe('Rates updated: GHS and EUR.'));
    expect(await screen.findByText('Now adding 3% to daily rates')).toBeTruthy();
    expect((screen.getByLabelText('Add to the daily rate') as HTMLInputElement).value).toBe('3');
  });

  it('sends a two-decimal margin without float drift', async () => {
    const user = userEvent.setup();
    when(PAYMENTS, paymentSettings);
    when(CURRENCY, (_url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: START }
        : { body: { ...view([ngn, ghs, usd, kes, zar, eur], 8, 29), refresh: refreshOf({ unchanged: ['GHS'] }) } },
    );
    mount();

    await item('Cedis (GHS)');
    const input = screen.getByLabelText('Add to the daily rate') as HTMLInputElement;
    await user.clear(input);
    /* `Number("0.29") * 100` is 28.999999999999996. */
    await user.type(input, '0.29{Enter}');
    await waitFor(() => expect(requests(CURRENCY, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(CURRENCY, 'PATCH')[0]).toEqual({ feedMarginBps: 29, revision: 7 });
  });
});
