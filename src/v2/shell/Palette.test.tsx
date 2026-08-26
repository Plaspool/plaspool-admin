import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The palette's CUSTOMERS search — the one live, per-keystroke server search
 * on the surface — pinned on the two ways it turns into a request storm:
 *
 *  - **A fetch per keystroke.** The effect debounces a beat behind the typing
 *    and aborts the request it supersedes, so rapid typing produces far fewer
 *    requests than characters and only the final query's answer can land.
 *    Asserted against the fetch log with REAL timers — `userEvent` cannot
 *    type through fake ones — by waiting on the calls the debounce lets out.
 *  - **A fetch for nothing.** An empty (or all-whitespace) query must not
 *    reach the wire at all: the marketing route would answer its "recently
 *    active" list, which is not what an empty palette asked for.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-marketing`: the debounce and the
 * abort live between the component and the wire, which is exactly the layer a
 * mocked module deletes.
 */

import type { CustomerRow } from '../../data/api-marketing';
import { Palette } from './Palette';

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

const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

// -------------------------------------------------------------- the harness

const PRODUCTS = '/api/shop/admin/products';
const ORDERS = '/api/shop/admin/orders';
const DISCOUNTS = '/api/marketing/discounts';
const POSTS = '/api/posts';
const CUSTOMERS = '/api/marketing/customers';

const CUSTOMER: CustomerRow = {
  email: 'curious@buyers.test',
  customerId: null,
  displayName: 'Curious Customer',
  guest: true,
  balance: 40,
  lifetimeEarned: 90,
  lastEntryAt: null,
  lastEntry: null,
};

/** The open-time pool — pages, products, orders, discounts, posts. All empty:
 *  the customers group is the only one under test and is fetched separately. */
function withPool(): void {
  when(PRODUCTS, { items: [], nextCursor: null });
  when(ORDERS, { items: [], nextCursor: null });
  when(DISCOUNTS, { discounts: [] });
  when(POSTS, { items: [], nextCursor: null });
}

const customerCalls = () =>
  calls.filter((c) => c.path.split('?')[0] === CUSTOMERS && (c.init.method ?? 'GET') === 'GET');

const queryOf = (call: { path: string }): string | null =>
  new URL(call.path, 'https://studio.test').searchParams.get('query');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Palette open onClose={() => {}} />
    </MemoryRouter>,
  );
}

const searchBox = (): HTMLElement => screen.getByPlaceholderText('Search PlaSpool Admin');

// ============================================================================

describe('the palette’s live customer search', () => {
  it('debounces behind the typing and abandons the request it superseded', async () => {
    const user = userEvent.setup();
    withPool();
    when(CUSTOMERS, { items: [CUSTOMER], nextCursor: null });
    mount();

    /* Burst one: two characters, one settled request carrying both. */
    await user.type(searchBox(), 'cu');
    await waitFor(() => expect(customerCalls().map(queryOf)).toContain('cu'));

    /* Burst two: six more characters on top. */
    await user.type(searchBox(), 'stomer');
    await waitFor(() => expect(customerCalls().map(queryOf)).toContain('customer'));

    /*
     * THE SUPERSEDED REQUEST WAS ABORTED, not left to race: the moment the
     * query moved past 'cu', its effect's controller was cancelled, so a slow
     * first answer can never overwrite the newer one.
     */
    const first = customerCalls().find((c) => queryOf(c) === 'cu');
    expect((first?.init.signal as AbortSignal).aborted).toBe(true);

    /* Eight keystrokes, nowhere near eight requests. */
    expect(customerCalls().length).toBeLessThan(8);

    /* The last request carried the whole query and the palette's page size. */
    const last = customerCalls()[customerCalls().length - 1];
    expect(queryOf(last)).toBe('customer');
    expect(new URL(last.path, 'https://studio.test').searchParams.get('limit')).toBe('8');

    /* And the answer landed as the Customers group. */
    expect(await screen.findByText('Curious Customer')).toBeTruthy();
  });

  it('fetches no customers for an empty query', async () => {
    const user = userEvent.setup();
    withPool();
    /* Registered so a stray request WOULD succeed — the assertion is that
       none is ever made, not that one fails. */
    when(CUSTOMERS, { items: [CUSTOMER], nextCursor: null });
    mount();

    /* The pool loads on open; the customers route stays untouched, including
       after the debounce interval has well and truly passed. */
    await waitFor(() => expect(reads(PRODUCTS)).toBe(1));
    await sleep(350);
    expect(customerCalls()).toHaveLength(0);

    /* Whitespace is still an empty query. */
    await user.type(searchBox(), ' ');
    await sleep(350);
    expect(customerCalls()).toHaveLength(0);
    expect(screen.queryByText('Curious Customer')).toBeNull();
  });
});
