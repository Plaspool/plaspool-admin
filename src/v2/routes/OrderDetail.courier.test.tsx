import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ORDER DETAIL — BOOKING A COURIER FROM THE PARCEL ROW (spec §6.2).
 *
 * The behaviours pinned here are the ones that are expensive rather than
 * merely ugly, because pressing Book spends real money at a real courier:
 *
 *  - **By hand leaves the screen exactly as it was.** The provider read is a
 *    SEPARATE, failure-tolerant fetch — this screen is worked by roles that
 *    may not hold the settings domain, and a 404 or a 500 there must read as
 *    "By hand" rather than take the order screen down with it. Nothing is
 *    registered for `/api/shop/logistics/provider` in the first test, and the
 *    row must still be the row `OrderDetail.test.tsx` describes.
 *  - **Terminal cannot be booked while any line lacks a weight.** The server
 *    refuses with 422 `weights_missing` and names the lines; the dialog turns
 *    that into an INLINE step that PATCHes each variant and re-quotes. There
 *    is no way past the gate — no options are rendered at all until the
 *    weights are saved, and a blank or zero grams is refused before any write.
 *  - **Fez only warns.** The same missing weights come back as
 *    `missingWeights` on a successful quote, and Book stays live: Fez prices a
 *    weightless parcel at 1 kg, and refusing the booking would be this admin
 *    inventing a rule the courier does not have.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 *
 * NO `@testing-library/jest-dom` IN THIS REPO, so text assertions read
 * `.textContent` rather than `toHaveTextContent` — an unknown matcher here is
 * an "Invalid Chai property", not a failing assertion.
 *
 * Money is pinned literally (`₦6,450.00`): `formatMinor` asks `Intl` for
 * `currencyDisplay: 'narrowSymbol'`, which is what reaches the ₦ rather than
 * the three-letter code.
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
import OrderDetail from './OrderDetail';

/**
 * What jsdom does not implement and the shared suites shim the same way —
 * plus `crypto.randomUUID`, which the refund modal mints its key with and
 * older jsdoms lack.
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
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  let uuidSerial = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: () => `test-uuid-${++uuidSerial}-abcdefghij`,
  });
}

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

/** GETs of exactly this path. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

// -------------------------------------------------------------- the harness

const ORDER = '/api/shop/admin/orders/ord_1';
const PARCEL = '/api/shop/admin/fulfillments/ful_1';

const address = {
  name: 'B. Uyer',
  line1: '1 Test Close',
  city: 'Gwarinpa',
  region: 'FCT',
  country: 'NG',
};

/** A PAID order with money still on the intent — every path here needs one. */
const order = {
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
  shippingAddress: address,
  billingAddress: address,
  placedAt: NOW - 86_400_000,
  paidAt: NOW - 86_000_000,
  fulfilledAt: null,
  deliveredAt: null,
  cancelledAt: null,
  revision: 1,
  checkoutId: 'chk_1',
  paymentIntentId: 'pi_1',
};

const line = {
  id: 'line_1',
  lineNo: 1,
  variantId: 'var_1',
  sku: 'SPL-RED',
  title: 'Recycled Spool',
  optionValues: { Colour: 'Red' },
  qty: 2,
  unitAmount: 250000,
  lineTotal: 500000,
  fulfilledQty: 0,
};

const payment = {
  intentId: 'pi_1',
  checkoutId: 'chk_1',
  status: 'captured',
  amount: 530000,
  currency: 'NGN',
  refundedTotal: 0,
  createdAt: NOW - 86_000_000,
  updatedAt: NOW - 86_000_000,
};

function parcel(status: 'pending' | 'shipped' | 'delivered' | 'cancelled') {
  return {
    id: 'ful_1',
    orderId: 'ord_1',
    status,
    carrier: null,
    trackingNumber: null,
    shippedAt: status === 'shipped' ? NOW - 3_600_000 : null,
    deliveredAt: null,
    createdAt: NOW - 7_200_000,
    revision: 1,
    lines: [{ id: 'fl_1', orderLineId: 'line_1', qty: 1 }],
  };
}

function withOrder(fulfillments: unknown[] = []): void {
  when(ORDER, {
    order,
    lines: [line],
    fulfillments,
    timeline: [],
    emails: [],
    payment,
  });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/orders/ord_1']}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

const loaded = (): Promise<HTMLElement> => screen.findByText('PP-1042-7');

// ============================================================================

const PROVIDER = '/api/shop/logistics/provider';
const QUOTE = '/api/shop/admin/fulfillments/ful_1/courier/quote';
const BOOK = '/api/shop/admin/fulfillments/ful_1/courier/book';
const REFRESH = '/api/shop/admin/fulfillments/ful_1/courier/refresh';
const CANCEL_COURIER = '/api/shop/admin/fulfillments/ful_1/courier/cancel';
const VARIANT = '/api/shop/admin/variants/var_1';

const fezQuote = {
  provider: 'fez', providerLabel: 'Fez Delivery', weightKg: 1, quoteRef: null, note: null,
  options: [{ id: 'fez', carrier: 'Fez Delivery', label: 'Fez Delivery', amountMinor: 645000, currency: 'NGN', eta: '2 - 5 day(s)' }],
  missingWeights: [],
};
const terminalQuote = {
  provider: 'terminal', providerLabel: 'Terminal Africa', weightKg: 1.2, quoteRef: 'SH-1', note: null,
  options: [
    { id: 'RT-1', carrier: 'GIG Logistics', label: 'GIG Logistics · Standard', amountMinor: 350000, currency: 'NGN', eta: '2 days', pickupEta: 'Tomorrow' },
    { id: 'RT-2', carrier: 'Kwik Delivery', label: 'Kwik Delivery · Same day', amountMinor: 520000, currency: 'NGN', eta: 'Today' },
  ],
  missingWeights: [],
};
const booked = {
  ...parcel('pending'),
  carrier: 'Fez Delivery', trackingNumber: 'ASAC27012319', provider: 'fez', providerRef: 'ASAC27012319',
  providerStatus: 'Pending Pick-Up', courierState: 'booked', trackingUrl: null, labelUrl: 'https://fez.test/manifest.pdf',
  providerCostMinor: 645000, providerSyncedAt: NOW, providerLastError: null,
};

describe('OrderDetail — courier booking', () => {
  it('shows nothing new when the courier is By hand, even if the provider call fails', async () => {
    withOrder([parcel('pending')]);
    // no PROVIDER handler → 404 → treated as manual
    mount();
    await loaded();
    expect(screen.getByRole('button', { name: 'Mark shipped' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Book with/ })).toBeNull();
  });

  it('books a Fez quote: quote → confirm → POST book, then reloads', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(QUOTE, fezQuote);
    when(BOOK, { fulfillment: booked });
    mount();
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Book with Fez Delivery' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Fez Delivery' });
    await waitFor(() => expect(sent(QUOTE, 'POST')).toEqual({}));
    expect(await within(dialog).findByText('₦6,450.00')).toBeTruthy();
    expect(within(dialog).getByText('2 - 5 day(s)')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));

    await waitFor(() => expect(sent(BOOK, 'POST')).toEqual({ optionId: 'fez', quoteRef: null }));
    expect(await screen.findByText('Booked with Fez Delivery · ASAC27012319')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
  });

  it('keeps Mark shipped reachable as "Ship by hand" while a courier is on', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(PARCEL, { fulfillment: parcel('shipped'), order: null });
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Ship by hand' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark Parcel 1 shipped' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark shipped' }));
    await waitFor(() => expect(sent(PARCEL, 'PATCH')).toEqual({ status: 'shipped', carrier: null, trackingNumber: null }));
  });

  it('Terminal: a 422 weights_missing becomes an inline weights step that saves each variant then re-quotes', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'terminal', label: 'Terminal Africa' });
    let quotes = 0;
    when(QUOTE, () =>
      quotes++ === 0
        ? { status: 422, body: { error: 'weights_missing', lines: [{ orderLineId: 'line_1', variantId: 'var_1', sku: 'SPL-RED', title: 'Recycled Spool' }] } }
        : { body: terminalQuote },
    );
    when(VARIANT, { variant: { id: 'var_1', weightGrams: 600 } });
    when(BOOK, { fulfillment: { ...booked, provider: 'terminal', carrier: 'GIG Logistics', trackingNumber: 'GIG123', providerRef: 'SH-1', trackingUrl: 'https://t.test/GIG123' } });
    mount();
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Book with Terminal Africa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Terminal Africa' });
    expect(await within(dialog).findByText(/needs a weight for every item/)).toBeTruthy();
    // Nothing to pick yet, and no way past the gate.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    await user.type(within(dialog).getByLabelText('Weight of Recycled Spool'), '600');
    await user.click(within(dialog).getByRole('button', { name: 'Save weights' }));

    await waitFor(() => expect(sent(VARIANT, 'PATCH')).toEqual({ weightGrams: 600 }));
    await waitFor(() => expect(quotes).toBe(2));
    // Now the rates.
    const gig = await within(dialog).findByRole('radio', { name: /GIG Logistics/ });
    expect(within(dialog).getByText('₦3,500.00')).toBeTruthy();
    expect(within(dialog).getByText('₦5,200.00')).toBeTruthy();
    await user.click(gig);
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(sent(BOOK, 'POST')).toEqual({ optionId: 'RT-1', quoteRef: 'SH-1' }));
  });

  it('Terminal refuses to save a blank or zero weight', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'terminal', label: 'Terminal Africa' });
    // The responder form: `when(path, body, status)` would read a bare
    // `{ status, body }` object as a 200 whose body says 422.
    when(QUOTE, () => ({
      status: 422,
      body: { error: 'weights_missing', lines: [{ orderLineId: 'line_1', variantId: 'var_1', sku: 'SPL-RED', title: 'Recycled Spool' }] },
    }));
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Book with Terminal Africa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Terminal Africa' });
    await within(dialog).findByLabelText('Weight of Recycled Spool');
    await user.click(within(dialog).getByRole('button', { name: 'Save weights' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Weight is grams — a whole number above 0.',
    );
    expect(sentNothing(VARIANT)).toBe(true);
  });

  it('Fez: missing weights only warn, and booking proceeds', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(QUOTE, { ...fezQuote, note: '1 item has no weight; Fez will be told 1 kg', missingWeights: [{ orderLineId: 'line_1', variantId: 'var_1', sku: 'SPL-RED', title: 'Recycled Spool' }] });
    when(BOOK, { fulfillment: booked });
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Book with Fez Delivery' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Fez Delivery' });
    expect(await within(dialog).findByText(/1 item has no weight\. Fez will be told 1 kg/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(sent(BOOK, 'POST')).toEqual({ optionId: 'fez', quoteRef: null }));
  });

  it('sends a booking that lost a weight back to the weights step, not to a code', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'terminal', label: 'Terminal Africa' });
    when(QUOTE, terminalQuote);
    /* The server re-asks the weight question at booking time rather than
       trusting the quote, so somebody clearing a weight in between lands
       here — and `weights_missing` is a code, not a sentence. */
    when(BOOK, () => ({
      status: 422,
      body: { error: 'weights_missing', lines: [{ orderLineId: 'line_1', variantId: 'var_1', sku: 'SPL-RED', title: 'Recycled Spool' }] },
    }));
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Book with Terminal Africa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Terminal Africa' });
    await user.click(await within(dialog).findByRole('radio', { name: /GIG Logistics/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));

    expect(await within(dialog).findByText(/needs a weight for every item/)).toBeTruthy();
    expect(within(dialog).getByLabelText('Weight of Recycled Spool')).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
  });

  it('turns courier errors into words', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(QUOTE, () => ({ status: 422, body: { error: 'provider_rejected', message: 'Invalid recipient state' } }));
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Book with Fez Delivery' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book Parcel 1 with Fez Delivery' });
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Fez Delivery said: Invalid recipient state',
    );
  });

  it('a booked parcel shows carrier, tracking link, waybill, courier status, refresh and cancel', async () => {
    const user = userEvent.setup();
    withOrder([{ ...booked, trackingUrl: 'https://track.test/ASAC27012319' }]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(REFRESH, { fulfillment: { ...booked, providerStatus: 'Dispatched', courierState: 'in_transit', status: 'shipped' } });
    when(CANCEL_COURIER, { fulfillment: { ...booked, courierState: 'cancelled', providerStatus: 'Cancelled' } });
    mount();
    await loaded();

    expect(screen.getByText('Booked')).toBeTruthy();
    expect((screen.getByRole('link', { name: 'ASAC27012319' }) as HTMLAnchorElement).href).toBe('https://track.test/ASAC27012319');
    expect((screen.getByRole('link', { name: 'Waybill' }) as HTMLAnchorElement).href).toBe('https://fez.test/manifest.pdf');
    expect(screen.getByText('Cost ₦6,450.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Book with/ })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(sent(REFRESH, 'POST')).toEqual({}));
    await waitFor(() => expect(reads(ORDER)).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Cancel courier' }));
    await waitFor(() => expect(sent(CANCEL_COURIER, 'POST')).toEqual({}));
  });

  /*
   * THE ROW'S OWN FAILURES ARE SENTENCES TOO. `ApiError.message` is the
   * server's CODE (`src/data/api.ts` passes no message), so the toast used to
   * read `provider_rejected` — which tells an operator holding a parcel
   * neither what happened nor what to do next.
   */
  it('a courier that refuses the cancel is quoted, not coded', async () => {
    const user = userEvent.setup();
    withOrder([{ ...booked, trackingUrl: 'https://track.test/ASAC27012319' }]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(CANCEL_COURIER, () => ({
      status: 422,
      body: { error: 'provider_rejected', message: 'Already collected from your address' },
    }));
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Cancel courier' }));
    expect(
      await screen.findByText('Fez Delivery said: Already collected from your address'),
    ).toBeTruthy();
  });

  it('a cancel the parcel has outrun reads as "already gone out"', async () => {
    const user = userEvent.setup();
    withOrder([{ ...booked, trackingUrl: 'https://track.test/ASAC27012319' }]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    when(CANCEL_COURIER, () => ({ status: 409, body: { error: 'already_shipped' } }));
    mount();
    await loaded();
    await user.click(await screen.findByRole('button', { name: 'Cancel courier' }));
    expect(
      await screen.findByText('This parcel has already gone out. Refresh to see where it is.'),
    ).toBeTruthy();
  });

  it('offers Book again after the courier cancelled', async () => {
    withOrder([{ ...booked, courierState: 'cancelled', providerStatus: 'Cancelled' }]);
    when(PROVIDER, { provider: 'fez', label: 'Fez Delivery' });
    mount();
    await loaded();
    expect(await screen.findByRole('button', { name: 'Book again' })).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel courier' })).toBeNull();
  });
});
