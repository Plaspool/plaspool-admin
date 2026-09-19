import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * INVENTORY, pinned on the two behaviours the debt ledger names:
 *
 *  - **The adjust popover sets a COUNT and sends a DELTA.** Since 2026-09-19 the
 *    box opens at the variant's own Available figure and two buttons move it;
 *    the wire still carries the difference, because "+4, delivery arrived" is
 *    what the stock ledger is for. A change of nothing — the box left as it
 *    opened, or cleared — is refused on this side, before a write. (The REASON
 *    has been optional since 2026-09-03, the owner's instruction; this file
 *    used to open by asserting a delta alone was refused.)
 *  - **`belowOnly` crosses the wire as `'1'`/`'0'`, never as a boolean's
 *    `String()`.** The route's schema is `z.enum(['0','1'])` precisely
 *    because `?belowOnly=false` is a string every truthiness test calls true
 *    — a filter that reads as applied, is not, and reports nothing. The Low
 *    stock tab must send the literal `'1'`; the All tab must send NOTHING.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop` — the query string is exactly
 * the thing a mocked module would assert nothing about.
 */

import { shopApi } from '../../data/api-shop';
import { ToastHost } from '../ui/Toast';
import Inventory from './Inventory';

/**
 * What jsdom does not implement and the shared suites shim the same way.
 * `ResizeObserver` is the load-bearing one here — `TableScroll` observes the
 * scroller the moment the table mounts.
 */
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

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** No write has gone to this path yet — the refusal held. */
function sentNothing(pathname: string): boolean {
  return !calls.some((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET');
}

const NOW = 1756224000000;

beforeEach(() => {
  handlers.clear();
  calls = [];
  // The analytics bar and column picker remember per-screen choices here; a
  // leaked '1' from one test would change what the next one mounts.
  window.sessionStorage.clear();
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
});

// -------------------------------------------------------------- the harness

const INVENTORY = '/api/shop/admin/inventory';
const ADJUST = '/api/shop/admin/inventory/var_1/adjust';

const row = {
  variantId: 'var_1',
  sku: 'SPL-RED',
  optionValues: { Colour: 'Red' },
  variantStatus: 'active',
  productId: 'prod_1',
  productTitle: 'Recycled Spool',
  productStatus: 'active',
  onHand: 12,
  reserved: 2,
  available: 10,
  backorderable: false,
  updatedAt: NOW - 3_600_000,
};

function withRows(): void {
  when(INVENTORY, { items: [row], nextCursor: null });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/products/inventory']}>
        <Inventory />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Every GET of the list, oldest first, as its parsed query string. */
const listQueries = (): URLSearchParams[] =>
  calls
    .filter((c) => c.path.split('?')[0] === INVENTORY && (c.init.method ?? 'GET') === 'GET')
    .map((c) => new URLSearchParams(c.path.split('?')[1] ?? ''));

// ============================================================================

describe('the inventory screen', () => {
  it('sends delta and reason together', async () => {
    const user = userEvent.setup();
    withRows();
    when(ADJUST, { inventory: { variantId: 'var_1', onHand: 15, reserved: 2, available: 13 } });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    // The box opens at the variant's OWN count, not empty — 10 available.
    const box = within(panel).getByLabelText('Available for SPL-RED');
    expect(box).toHaveProperty('value', '10');

    await user.clear(box);
    await user.type(box, '13');
    await user.type(within(panel).getByLabelText('Reason (optional)'), 'Stocktake');
    await user.click(within(panel).getByRole('button', { name: 'Adjust' }));

    // Key by key: the DELTA as a number and the reason, nothing else. The panel
    // takes a target and the wire still carries the difference — 13 from 10.
    await waitFor(() => expect(sent(ADJUST, 'POST')).toEqual({ delta: 3, reason: 'Stocktake' }));
    // The receipt names the row and the SERVER'S new available figure, not a
    // locally recomputed one.
    expect(await screen.findByText('SPL-RED — 13 available')).toBeTruthy();
  });

  /*
   * THE REASON IS OPTIONAL SINCE 2026-09-03 (owner’s instruction). The test
   * above used to open by asserting that a delta alone was refused.
   *
   * THE BODY IS THE ASSERTION, not the 200. A screen that sent
   * `{ delta: 3, reason: '' }` would look identical here and be a 400 in
   * production: the route keeps `.min(1)` inside its `.optional()`, so the key
   * has to be ABSENT rather than empty. `toEqual` is what pins that — a
   * `toMatchObject` would pass with the empty string still on the wire.
   */
  it('sends no reason key at all when the box is left empty', async () => {
    const user = userEvent.setup();
    withRows();
    when(ADJUST, { inventory: { variantId: 'var_1', onHand: 13, reserved: 2, available: 11 } });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    const box = within(panel).getByLabelText('Available for SPL-RED');
    await user.clear(box);
    await user.type(box, '13');
    await user.click(within(panel).getByRole('button', { name: 'Adjust' }));

    await waitFor(() => expect(sent(ADJUST, 'POST')).toEqual({ delta: 3 }));
    expect(await screen.findByText('SPL-RED — 11 available')).toBeTruthy();
  });

  /*
   * THE OWNER'S ASK, 2026-09-19: the buttons are the point. Typing "+3" was
   * the thing being replaced, so a suite that only ever types a target would
   * pass while the two controls this change exists for did nothing.
   */
  it('steps the count with the buttons and sends the difference', async () => {
    const user = userEvent.setup();
    withRows();
    when(ADJUST, { inventory: { variantId: 'var_1', onHand: 14, reserved: 2, available: 12 } });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    await user.click(within(panel).getByRole('button', { name: 'One more SPL-RED' }));
    await user.click(within(panel).getByRole('button', { name: 'One more SPL-RED' }));
    expect(within(panel).getByLabelText('Available for SPL-RED')).toHaveProperty('value', '12');

    // And back down once, to prove the pair is not one-way.
    await user.click(within(panel).getByRole('button', { name: 'One fewer SPL-RED' }));
    expect(within(panel).getByLabelText('Available for SPL-RED')).toHaveProperty('value', '11');

    await user.click(within(panel).getByRole('button', { name: 'One more SPL-RED' }));
    await user.click(within(panel).getByRole('button', { name: 'Adjust' }));

    await waitFor(() => expect(sent(ADJUST, 'POST')).toEqual({ delta: 2 }));
  });

  /* A variant that cannot be back-ordered has nothing below zero to offer, and
   * the button says so by being unpressable rather than by doing nothing. */
  it('will not step an ordinary variant below zero', async () => {
    const user = userEvent.setup();
    when(INVENTORY, { items: [{ ...row, onHand: 0, reserved: 0, available: 0 }], nextCursor: null });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    expect(within(panel).getByRole('button', { name: 'One fewer SPL-RED' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  /*
   * THE NUMBER STILL GATES IT, but the shape of "no change" moved with the
   * control: it used to be a typed zero, and now it is the box left exactly as
   * it opened. Pressing Adjust straight away is the easy accident once the
   * figure is pre-filled, so it has to be refused BEFORE a write — a delta of
   * zero is a change the server cannot make.
   */
  it('refuses when the number has not been changed, sending nothing', async () => {
    const user = userEvent.setup();
    withRows();
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    await user.click(within(panel).getByRole('button', { name: 'Adjust' }));

    expect(
      await within(panel).findByText('Already 10. Change the number to adjust it.'),
    ).toBeTruthy();
    expect(sentNothing(ADJUST)).toBe(true);
  });

  /* A cleared box is not a zero — it is nothing yet, and writing stock off to
   * zero because somebody hit Backspace on the way to typing is the accident
   * this refusal exists for. */
  it('refuses an empty box, sending nothing', async () => {
    const user = userEvent.setup();
    withRows();
    mount();

    await user.click(await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' }));
    const panel = screen.getByRole('dialog', { name: 'Adjust stock of SPL-RED' });

    await user.clear(within(panel).getByLabelText('Available for SPL-RED'));
    await user.click(within(panel).getByRole('button', { name: 'Adjust' }));

    expect(await within(panel).findByText('Enter a whole number.')).toBeTruthy();
    expect(sentNothing(ADJUST)).toBe(true);
  });

  it('puts belowOnly on the wire as the string 1 for Low stock, absent for All, 0 for an explicit false', async () => {
    const user = userEvent.setup();
    withRows();
    mount();
    await screen.findByRole('button', { name: 'Adjust stock of SPL-RED' });

    // The opening read is the All tab: no belowOnly at all — absent, not '0',
    // because the screen has no opinion rather than a negative one.
    expect(listQueries()).toHaveLength(1);
    expect(listQueries()[0]!.get('belowOnly')).toBeNull();
    expect(listQueries()[0]!.get('limit')).toBe('25');

    await user.click(screen.getByRole('tab', { name: 'Low stock' }));
    await waitFor(() => expect(listQueries()).toHaveLength(2));
    // The literal '1' — `String(true)` would be 'true', which the route's
    // z.enum(['0','1']) refuses with a 400.
    expect(listQueries()[1]!.get('belowOnly')).toBe('1');

    await user.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(listQueries()).toHaveLength(3));
    expect(listQueries()[2]!.get('belowOnly')).toBeNull();

    /*
     * The '0' half of the same wire contract, at the seam the screen rides:
     * an explicit `false` crosses as the literal '0'. `String(false)` is
     * 'false' — a string every truthiness test calls TRUE, i.e. a filter that
     * reads as applied and is not, which is the bug the mapping exists for.
     */
    await shopApi.listInventory({ belowOnly: false });
    expect(listQueries()).toHaveLength(4);
    expect(listQueries()[3]!.get('belowOnly')).toBe('0');
  });
});
