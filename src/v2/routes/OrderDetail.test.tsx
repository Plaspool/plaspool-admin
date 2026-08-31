import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ORDER DETAIL, pinned on the three money-adjacent behaviours the debt ledger
 * names:
 *
 *  - **The refund `idempotencyKey` is minted once per attempt and survives a
 *    retried click.** It is what stops a refund the network swallowed from
 *    being paid twice when the operator clicks again — a fresh key per click
 *    would defeat the whole mechanism while looking identical on screen.
 *  - **A PAID cancel refuses to submit until the money is decided.** The
 *    server 400s a paid cancel without a `refund`, so the modal must refuse
 *    on this side, and the request that finally goes must carry the choice.
 *  - **`setFulfillmentStatus`'s `order` result has THREE states** — absent
 *    (delivered/cancelled: no settlement to attempt), `null` (shipped, but
 *    parcels remain), and a real order (this shipment settled it) — and only
 *    the third may claim the order fulfilled.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
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
 * older jsdoms lack. Guarded: when the real one exists it is used, because
 * the tests only ever assert the key is STABLE, never what it looks like.
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
const CANCEL = '/api/shop/admin/orders/ord_1/cancel';
const REFUNDS = '/api/shop/admin/payments/intents/pi_1/refunds';
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
  when(ORDER, { order, lines: [line], fulfillments, timeline: [], emails: [], payment });
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

/** Every refund POST's parsed body, oldest first. */
const refundBodies = (): Record<string, unknown>[] =>
  calls
    .filter((c) => c.path.split('?')[0] === REFUNDS && c.init.method === 'POST')
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

const SETTLED_TOAST = 'Every parcel on its way — order fulfilled';

// ============================================================================

describe('the order detail screen', () => {
  it('mints one refund idempotency key per attempt and repeats it on the retried click', async () => {
    const user = userEvent.setup();
    withOrder();
    /*
     * The first POST dies at the gateway — the case the key exists for: the
     * operator cannot know whether the refund landed, clicks again, and the
     * second request must be the SAME refund rather than a second one.
     */
    let attempt = 0;
    when(REFUNDS, () =>
      attempt++ === 0
        ? { status: 502, body: { error: 'bad_gateway', requestId: 'req_r1' } }
        : {
            status: 201,
            body: {
              refund: {
                id: 'ref_1',
                intentId: 'pi_1',
                amount: 15000,
                currency: 'NGN',
                status: 'processing',
                createdAt: NOW,
              },
            },
          },
    );
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Refund payment…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Refund payment' });

    await user.type(within(dialog).getByLabelText('Amount'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

    // The failure surfaced under the amount box and the modal stayed up.
    await within(dialog).findByText('bad_gateway');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

    await waitFor(() => expect(refundBodies()).toHaveLength(2));
    const [first, second] = refundBodies();

    // Key by key: the amount in MINOR units (₦150 → 15000) and the key, and
    // nothing else — no `reason` travels when the box was never touched.
    expect(Object.keys(first!).sort()).toEqual(['amount', 'idempotencyKey']);
    expect(first!.amount).toBe(15000);
    expect(typeof first!.idempotencyKey).toBe('string');
    // The server's own floor is min(8); a key shorter than that is refused.
    expect(String(first!.idempotencyKey).length).toBeGreaterThanOrEqual(8);

    // THE PIN: the retried click reuses the attempt's key, byte for byte.
    expect(second).toEqual(first);

    // The retry succeeded: the modal closes and the order re-reads.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads(ORDER)).toBe(2));
  });

  it('refuses a paid cancel until the refund choice is complete, then sends exactly that choice', async () => {
    const user = userEvent.setup();
    withOrder();
    when(CANCEL, { order: { ...order, status: 'cancelled', cancelledAt: NOW } });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel order…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel PP-1042-7?' });

    /*
     * The paid branch demands the money be decided. Point at "custom" and
     * name no amount: that is a cancel WITHOUT a usable refund choice, and it
     * must be refused on this side — the server would 400 it, after the
     * operator already agreed to the dialog.
     */
    await user.click(within(dialog).getByRole('radio', { name: 'Refund a custom amount' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(await within(dialog).findByText('Enter an amount.')).toBeTruthy();
    expect(sentNothing(CANCEL)).toBe(true);

    // Decide it, and the POST carries the choice — the server's required
    // shape for a paid cancel, asserted key by key.
    await user.click(within(dialog).getByRole('radio', { name: /Refund in full/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() =>
      expect(sent(CANCEL, 'POST')).toEqual({ refund: { kind: 'percent', percent: 100 } }),
    );
    expect(await screen.findByText('PP-1042-7 cancelled')).toBeTruthy();
  });

  it('reads an ABSENT order off a delivered parcel as nothing to settle', async () => {
    const user = userEvent.setup();
    withOrder([parcel('shipped')]);
    // The delivered branch answers { fulfillment } and STOPS — no `order` key
    // at all. The old `if (res.order === null)` guard let this shape through
    // to a property read; plain truthiness must treat it as "not settled".
    when(PARCEL, { fulfillment: { ...parcel('shipped'), status: 'delivered', deliveredAt: NOW } });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Mark delivered' }));

    await waitFor(() => expect(sent(PARCEL, 'PATCH')).toEqual({ status: 'delivered' }));
    expect(await screen.findByText('Parcel 1 delivered')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
    expect(screen.queryByText(SETTLED_TOAST)).toBeNull();
  });

  it('reads order: null off a shipped parcel as a partial shipment, not a settlement', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    // `null` is the shipped branch's ORDINARY answer: this parcel went out and
    // the order still has parcels left. Information, not an error — and not a
    // settlement either.
    when(PARCEL, { fulfillment: parcel('shipped'), order: null });
    mount();
    await loaded();

    /* "Mark shipped" no longer fires: it opens the ship dialog, where the
     * carrier/tracking the shipment email will carry are confirmed. Untouched
     * empty fields submit as explicit nulls — the parcel row held none. */
    await user.click(screen.getByRole('button', { name: 'Mark shipped' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark Parcel 1 shipped' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark shipped' }));

    await waitFor(() =>
      expect(sent(PARCEL, 'PATCH')).toEqual({
        status: 'shipped',
        carrier: null,
        trackingNumber: null,
      }),
    );
    expect(await screen.findByText('Parcel 1 shipped')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
    expect(screen.queryByText(SETTLED_TOAST)).toBeNull();
  });

  it('reads a real order in the response as the shipment settling it, and says so', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PARCEL, {
      fulfillment: parcel('shipped'),
      order: { ...order, status: 'fulfilled', fulfilledAt: NOW },
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Mark shipped' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark Parcel 1 shipped' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark shipped' }));

    // The one shape of the three allowed to claim the order fulfilled.
    expect(await screen.findByText(SETTLED_TOAST)).toBeTruthy();
    expect(await screen.findByText('Parcel 1 shipped')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
  });

  it('ships with the TYPED carrier and tracking — the dialog is what the email renders', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PARCEL, { fulfillment: parcel('shipped'), order: null });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Mark shipped' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark Parcel 1 shipped' });
    await user.type(within(dialog).getByLabelText('Carrier'), 'GIG Logistics');
    await user.type(within(dialog).getByLabelText('Tracking number'), 'GIG-123');
    await user.click(within(dialog).getByRole('button', { name: 'Mark shipped' }));

    await waitFor(() =>
      expect(sent(PARCEL, 'PATCH')).toEqual({
        status: 'shipped',
        carrier: 'GIG Logistics',
        trackingNumber: 'GIG-123',
      }),
    );
    expect(await screen.findByText('Parcel 1 shipped')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
  });

  it('Edit tracking saves details on a pending parcel WITHOUT transitioning it', async () => {
    const user = userEvent.setup();
    withOrder([parcel('pending')]);
    when(PARCEL, {
      fulfillment: { ...parcel('pending'), carrier: 'DHL', trackingNumber: 'T-9' },
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Edit tracking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Parcel 1 tracking' });
    await user.type(within(dialog).getByLabelText('Carrier'), 'DHL');
    await user.type(within(dialog).getByLabelText('Tracking number'), 'T-9');
    await user.click(within(dialog).getByRole('button', { name: 'Save tracking' }));

    /* Key by key: NO status member at all — this is the details-only PATCH,
     * and a stray transition here would ship the parcel. */
    await waitFor(() =>
      expect(sent(PARCEL, 'PATCH')).toEqual({ carrier: 'DHL', trackingNumber: 'T-9' }),
    );
    expect(await screen.findByText('Parcel 1 tracking saved')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
  });
});

// ============================================================================

describe('the next-step menu item', () => {
  it('names "Fulfil items…" for a paid order with an unfulfilled remainder, and opens the modal', async () => {
    const user = userEvent.setup();
    withOrder(); // paid, qty 2 of which 0 fulfilled — the remainder decides.
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Next step: Fulfil items…' }),
    );

    expect(await screen.findByRole('dialog', { name: 'Fulfil items' })).toBeTruthy();
  });

  it('names "Mark Parcel 1 shipped…" once the remainder is packed, and the dialog ships it', async () => {
    const user = userEvent.setup();
    // Everything packed (fulfilledQty = qty), one parcel still pending: the
    // next move is that parcel's shipment, by its ROW number.
    when(ORDER, {
      order,
      lines: [{ ...line, fulfilledQty: 2 }],
      fulfillments: [parcel('pending')],
      timeline: [],
      emails: [],
      payment,
    });
    when(PARCEL, { fulfillment: parcel('shipped'), order: null });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Next step: Mark Parcel 1 shipped…' }),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Mark Parcel 1 shipped' });
    await user.type(within(dialog).getByLabelText('Carrier'), 'GIG Logistics');
    await user.type(within(dialog).getByLabelText('Tracking number'), 'GIG-123');
    await user.click(within(dialog).getByRole('button', { name: 'Mark shipped' }));

    await waitFor(() =>
      expect(sent(PARCEL, 'PATCH')).toEqual({
        status: 'shipped',
        carrier: 'GIG Logistics',
        trackingNumber: 'GIG-123',
      }),
    );
    expect(await screen.findByText('Parcel 1 shipped')).toBeTruthy();
  });

  it('runs "Mark Parcel 1 delivered" directly — no dialog, the existing toasts', async () => {
    const user = userEvent.setup();
    when(ORDER, {
      order,
      lines: [{ ...line, fulfilledQty: 2 }],
      fulfillments: [parcel('shipped')],
      timeline: [],
      emails: [],
      payment,
    });
    // The delivered branch answers { fulfillment } and stops — nothing settles.
    when(PARCEL, {
      fulfillment: { ...parcel('shipped'), status: 'delivered', deliveredAt: NOW },
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Next step: Mark Parcel 1 delivered' }),
    );

    await waitFor(() => expect(sent(PARCEL, 'PATCH')).toEqual({ status: 'delivered' }));
    expect(await screen.findByText('Parcel 1 delivered')).toBeTruthy();
    await waitFor(() => expect(reads(ORDER)).toBe(2));
    expect(screen.queryByText(SETTLED_TOAST)).toBeNull();
  });

  it('says "Awaiting payment — nothing to run" on a pending order', async () => {
    const user = userEvent.setup();
    when(ORDER, {
      order: { ...order, status: 'pending', paidAt: null },
      lines: [line],
      fulfillments: [],
      timeline: [],
      emails: [],
      payment: null,
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Awaiting payment — nothing to run' }),
    ).toBeTruthy();
  });
});
