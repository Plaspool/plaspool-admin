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

function withOrder(
  fulfillments: unknown[] = [],
  overrides: {
    addOns?: unknown[];
    addOnTotal?: number;
    shippingAddress?: unknown;
    order?: Record<string, unknown>;
    payment?: unknown;
  } = {},
): void {
  const start = { ...order, ...overrides.order };
  const base =
    overrides.addOnTotal === undefined ? start : { ...start, addOnTotal: overrides.addOnTotal };
  when(ORDER, {
    order:
      overrides.shippingAddress === undefined
        ? base
        : { ...base, shippingAddress: overrides.shippingAddress },
    lines: [line],
    fulfillments,
    timeline: [],
    emails: [],
    payment: overrides.payment === undefined ? payment : overrides.payment,
    ...(overrides.addOns === undefined ? {} : { addOns: overrides.addOns }),
  });
}

/** The same paid order, its payment taken through Flutterwave. */
const flutterwavePayment = { ...payment, provider: 'flutterwave' };

async function openRefund(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Refund payment…' }));
  return screen.findByRole('dialog', { name: 'Refund payment' });
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

const SETTLED_TOAST = 'Every parcel is on its way — order complete';

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

    /* Migration 1200: a paid cancel also says what goes back in stock. Nothing
       has shipped, so by default every unit does — both of line_1's two. */
    await waitFor(() =>
      expect(sent(CANCEL, 'POST')).toEqual({
        refund: { kind: 'percent', percent: 100 },
        restock: { lines: [{ orderLineId: 'line_1', qty: 2 }], keptOutReason: null },
      }),
    );
    expect(await screen.findByText('PP-1042-7 cancelled')).toBeTruthy();
  });

  /*
   * THE GATEWAY IS THE PAYMENT'S OWN, NEVER ASSUMED. The refund window said
   * "The money goes back through Paystack" on every order, and production's
   * first Flutterwave refund (2026-09-15) was refused and shown as `internal`.
   */
  it('names the gateway that took the payment, and says the refund goes back through it', async () => {
    const user = userEvent.setup();
    withOrder([], { payment: flutterwavePayment });
    mount();
    await loaded();

    expect(screen.getByText('Flutterwave')).toBeTruthy();

    const dialog = await openRefund(user);
    expect(within(dialog).getByText(/^The money goes back through Flutterwave\./)).toBeTruthy();
    expect(within(dialog).queryByText(/Paystack/)).toBeNull();
  });

  it('says in words that the gateway refused a refund, instead of showing its error code', async () => {
    const user = userEvent.setup();
    withOrder([], { payment: flutterwavePayment });
    when(
      REFUNDS,
      { error: 'refund_failed', provider: 'flutterwave', outcome: 'refused', code: 'invalid_request', requestId: 'req_r' },
      422,
    );
    mount();
    await loaded();

    const dialog = await openRefund(user);
    await user.type(within(dialog).getByLabelText('Amount'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

    expect(
      await within(dialog).findByText('Flutterwave refused this refund, so no money was sent.'),
    ).toBeTruthy();
    expect(within(dialog).queryByText('refund_failed')).toBeNull();
    expect(screen.queryByText(/^Refunded/)).toBeNull();
  });

  /*
   * A REFUND NOBODY COULD CONFIRM IS HELD (owner's rule, 2026-09-15). The window
   * closes and the order re-reads, because what happens next lives on the order
   * page — the held refund, with the two buttons that settle it.
   */
  const UNCONFIRMED = {
    error: 'refund_failed',
    provider: 'flutterwave',
    outcome: 'unconfirmed',
    code: 'provider_unavailable',
    requestId: 'req_u',
  };
  const HELD_MESSAGE = 'Flutterwave didn’t confirm this refund, so the money is held. See the note on this order.';

  it('closes the cancel window and points at the order when its refund was not confirmed', async () => {
    const user = userEvent.setup();
    withOrder([], { payment: flutterwavePayment });
    when(CANCEL, UNCONFIRMED, 422);
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel order…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel PP-1042-7?' });
    await user.click(within(dialog).getByRole('radio', { name: /Refund in full/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText(HELD_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads(ORDER)).toBe(2));
    expect(screen.queryByText('PP-1042-7 cancelled')).toBeNull();
  });

  it('closes the refund window and points at the order when the refund was not confirmed', async () => {
    const user = userEvent.setup();
    withOrder([], { payment: flutterwavePayment });
    when(REFUNDS, UNCONFIRMED, 422);
    mount();
    await loaded();

    const dialog = await openRefund(user);
    await user.type(within(dialog).getByLabelText('Amount'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

    expect(await screen.findByText(HELD_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads(ORDER)).toBe(2));
    expect(screen.queryByText(/^Refunded/)).toBeNull();
  });

  describe('a refund nobody could confirm', () => {
    const RESOLVE = '/api/shop/admin/payments/refunds/rfd_held/resolve';
    const held = {
      ...flutterwavePayment,
      refundedTotal: 530000,
      unconfirmedRefunds: [{ id: 'rfd_held', amount: 530000, currency: 'NGN', createdAt: NOW - 3_600_000 }],
    };

    it('shows it on the order, and does not offer the held money for another refund', async () => {
      const user = userEvent.setup();
      withOrder([], { payment: held });
      mount();
      await loaded();

      expect(screen.getByText('Refund not confirmed')).toBeTruthy();
      // The amount either way ICU renders it (see `amount` at the foot of this file).
      expect(
        screen.getByText(/^Flutterwave didn’t confirm the (?:₦|NGN[\s ]?)5,300\.00 refund/),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'It went through' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'It didn’t go through' })).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Refund payment…' })).toBeNull();
    });

    it('marks it sent once the owner confirms, and re-reads the order', async () => {
      const user = userEvent.setup();
      withOrder([], { payment: held });
      when(RESOLVE, { refund: { id: 'rfd_held', status: 'succeeded' } });
      mount();
      await loaded();

      await user.click(screen.getByRole('button', { name: 'It went through' }));
      const dialog = await screen.findByRole('dialog', { name: 'Mark the refund as sent?' });
      expect(sentNothing(RESOLVE)).toBe(true);
      await user.click(within(dialog).getByRole('button', { name: 'Mark as sent' }));

      await waitFor(() => expect(sent(RESOLVE, 'POST')).toEqual({ outcome: 'sent' }));
      expect(await screen.findByText('Refund marked as sent')).toBeTruthy();
      await waitFor(() => expect(reads(ORDER)).toBe(2));
    });

    it('marks it not sent once the owner confirms', async () => {
      const user = userEvent.setup();
      withOrder([], { payment: held });
      when(RESOLVE, { refund: { id: 'rfd_held', status: 'failed' } });
      mount();
      await loaded();

      await user.click(screen.getByRole('button', { name: 'It didn’t go through' }));
      const dialog = await screen.findByRole('dialog', { name: 'Mark the refund as not sent?' });
      await user.click(within(dialog).getByRole('button', { name: 'Mark as not sent' }));

      await waitFor(() => expect(sent(RESOLVE, 'POST')).toEqual({ outcome: 'not_sent' }));
      expect(await screen.findByText('Refund marked as not sent. The money can be refunded again.')).toBeTruthy();
    });

    it('asks the owner to wait while the refund may still be on its way', async () => {
      const user = userEvent.setup();
      withOrder([], { payment: held });
      when(RESOLVE, { error: 'refund_still_sending', requestId: 'req_s' }, 409);
      mount();
      await loaded();

      await user.click(screen.getByRole('button', { name: 'It didn’t go through' }));
      const dialog = await screen.findByRole('dialog', { name: 'Mark the refund as not sent?' });
      await user.click(within(dialog).getByRole('button', { name: 'Mark as not sent' }));

      expect(
        await within(dialog).findByText('This refund was sent less than a minute ago. Wait a minute, then try again.'),
      ).toBeTruthy();
    });
  });

  it('waits on the gateway that is actually taking the payment', async () => {
    withOrder([], {
      order: { status: 'pending', paidAt: null },
      payment: { ...flutterwavePayment, status: 'requires_payment' },
    });
    mount();
    await loaded();

    expect(screen.getByText(/once Flutterwave confirms/)).toBeTruthy();
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
  it('names "Send out items…" for a paid order with items left to send, and opens the modal', async () => {
    const user = userEvent.setup();
    withOrder(); // paid, qty 2 of which 0 fulfilled — the remainder decides.
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Next step: Send out items…' }),
    );

    expect(await screen.findByRole('dialog', { name: 'Send out items' })).toBeTruthy();
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

  it('says "Waiting for payment — nothing to do yet" on a pending order', async () => {
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
      await screen.findByRole('menuitem', { name: 'Waiting for payment — nothing to do yet' }),
    ).toBeTruthy();
  });
});

// ============================================================================

/**
 * Money, matched WITHOUT its exact locale rendering. `Intl` renders NGN as
 * "₦1,500.00" under a full ICU and "NGN 1,500.00" under a small one, and
 * `formatMinor` resolves the process default locale — so a literal pin
 * passes on one machine and fails on a `LANG=C` runner. See the same
 * reasoning, stated at length, in `SpoolsAnalytics.test.tsx`.
 */
const amount = (digits: string) => (content: string) => {
  const text = content.replace(/\u00A0/g, ' ').trim();
  return /^(?:₦|NGN ?)?[\d.,]+$/.test(text) && text.includes(digits);
};

describe('add-ons on the order', () => {
  it('lists each add-on, marks the included one Included, and totals them under Payment', async () => {
    withOrder([], {
      addOns: [
        { id: 'oao_1', position: 0, addOnId: 'ado_box', title: 'Gift box', mode: 'chosen', amount: 150000, listPrice: 150000, currency: 'NGN' },
        { id: 'oao_2', position: 1, addOnId: 'ado_note', title: 'Gift note', mode: 'included', amount: 0, listPrice: 50000, currency: 'NGN' },
      ],
      addOnTotal: 150000,
    });
    mount();
    await loaded();

    expect(await screen.findByText('Gift box')).toBeTruthy();
    expect(screen.getByText('Included')).toBeTruthy();
    // "Add-ons" renders twice once the total is positive: the card
    // heading and the Payment row label both carry it, so a plain
    // getByText would throw on the very success this test is proving.
    expect(screen.getAllByText('Add-ons').length).toBeGreaterThan(0);
    // The rendered amount is locale-dependent (the naira sign under some
    // ICU builds, the bare ISO code under this one) and `getByText` also
    // collapses the non-breaking space to a plain one — `amount()` matches
    // on the digits alone, so this holds either way. Two occurrences are
    // expected: the add-on row and the Payment total.
    expect(screen.getAllByText(amount('1,500.00')).length).toBeGreaterThan(0);
  });

  it('renders an order with no add-ons exactly as before', async () => {
    withOrder([], { addOnTotal: 0 });
    mount();
    await loaded();

    expect(screen.queryByText('Add-ons')).toBeNull();
    expect(await screen.findByText('Recycled Spool')).toBeTruthy();
  });
});

/**
 * WHAT THE COURIER WAS TOLD, WHEN IT IS NOT WHAT THE CUSTOMER TYPED.
 *
 * The shopper picks a routing city from the courier's own list because Terminal
 * refuses a city that is not on it. Staff chasing a parcel need to see the zone
 * it actually went out under — otherwise "we booked it to Gwarinpa" and the
 * waybill saying Maitama is a mystery nobody can resolve from this screen.
 *
 * A QUIET SECOND LINE, NOT A REPLACEMENT. The customer's own city is still the
 * one printed in its usual place, and the zone only appears when the two
 * genuinely differ — which on most orders they will not.
 */
describe('the courier zone on the address', () => {
  it('shows the zone as a second line when it is not the city the customer typed', async () => {
    withOrder([], { shippingAddress: { ...address, routingCity: 'Maitama' } });
    mount();
    await loaded();

    // The customer's own city survives, in its usual place.
    expect(screen.getAllByText(/Gwarinpa/).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Maitama · courier zone/)).toBeTruthy();
  });

  it('says nothing when the courier was told the same city', async () => {
    withOrder([], { shippingAddress: { ...address, routingCity: 'Gwarinpa' } });
    mount();
    await loaded();

    expect(screen.queryByText(/courier zone/)).toBeNull();
  });

  /* Every order placed before migration 1020, which is all of them so far. */
  it('says nothing for an order that never named a zone', async () => {
    withOrder();
    mount();
    await loaded();

    expect(screen.queryByText(/courier zone/)).toBeNull();
  });
});

// ============================================================================

/**
 * PUTTING STOCK BACK ON CANCEL (migration 1200). Before this the dialog said
 * "Cancelling puts the stock back" and nothing did. The owner chose a number per
 * line over an automatic restock: only the person holding the parcel knows
 * whether a spool can be sold again.
 */
describe('putting stock back when cancelling', () => {
  const openCancel = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel order…' }));
    return screen.findByRole('dialog', { name: 'Cancel PP-1042-7?' });
  };

  it('offers every unit that has not shipped, and says so plainly', async () => {
    const user = userEvent.setup();
    withOrder();
    mount();
    await loaded();
    const dialog = await openCancel(user);

    expect(within(dialog).queryByText(/puts the stock back/)).toBeNull();
    const box = within(dialog).getByLabelText('Put back how many of Recycled Spool');
    expect(box).toHaveProperty('value', '2');
    expect(box).toHaveProperty('max', '2');
    expect(within(dialog).queryByLabelText(/Why the rest stays out/)).toBeNull();
  });

  it('caps a line at the units that never shipped', async () => {
    const user = userEvent.setup();
    withOrder([parcel('shipped')]);
    mount();
    await loaded();
    const dialog = await openCancel(user);

    const box = within(dialog).getByLabelText('Put back how many of Recycled Spool');
    expect(box).toHaveProperty('value', '1');
    expect(box).toHaveProperty('max', '1');
    expect(within(dialog).getByText('1 already sent out')).toBeTruthy();
  });

  it('sends a lowered number with the reason for what stays out', async () => {
    const user = userEvent.setup();
    withOrder();
    when(CANCEL, { order: { ...order, status: 'cancelled', cancelledAt: NOW }, restock: { returned: 1, refused: [] } });
    mount();
    await loaded();
    const dialog = await openCancel(user);

    const box = within(dialog).getByLabelText('Put back how many of Recycled Spool');
    await user.clear(box);
    await user.type(box, '1');
    await user.type(within(dialog).getByLabelText(/Why the rest stays out/), 'Seal broken');
    await user.click(within(dialog).getByRole('radio', { name: /Refund in full/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    await waitFor(() =>
      expect(sent(CANCEL, 'POST')).toEqual({
        refund: { kind: 'percent', percent: 100 },
        restock: { lines: [{ orderLineId: 'line_1', qty: 1 }], keptOutReason: 'Seal broken' },
      }),
    );
  });

  it('refuses a number above what can go back, before anything reaches the server', async () => {
    const user = userEvent.setup();
    withOrder();
    mount();
    await loaded();
    const dialog = await openCancel(user);

    const box = within(dialog).getByLabelText('Put back how many of Recycled Spool');
    await user.clear(box);
    await user.type(box, '5');
    await user.click(within(dialog).getByRole('radio', { name: /Refund in full/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(await within(dialog).findByText('Recycled Spool: a whole number from 0 to 2.')).toBeTruthy();
    expect(sentNothing(CANCEL)).toBe(true);
  });

  it('tells staff when the cancel went through but the stock could not be put back', async () => {
    const user = userEvent.setup();
    withOrder();
    when(CANCEL, { order: { ...order, status: 'cancelled', cancelledAt: NOW }, restock: { failed: true } });
    mount();
    await loaded();
    const dialog = await openCancel(user);
    await user.click(within(dialog).getByRole('radio', { name: /Refund in full/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(
      await screen.findByText('PP-1042-7 cancelled, but the stock wasn’t put back. Adjust the stock count by hand.'),
    ).toBeTruthy();
  });

  it('shows no list for an unpaid order, and sends no restock', async () => {
    const user = userEvent.setup();
    when(ORDER, {
      order: { ...order, status: 'pending', paidAt: null },
      lines: [line],
      fulfillments: [],
      timeline: [],
      emails: [],
      payment: null,
    });
    when(CANCEL, { order: { ...order, status: 'cancelled', cancelledAt: NOW } });
    mount();
    await loaded();
    const dialog = await openCancel(user);

    expect(within(dialog).queryByLabelText('Put back how many of Recycled Spool')).toBeNull();
    expect(within(dialog).getByText(/Items set aside for it go back in stock within about 30 minutes/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(sent(CANCEL, 'POST')).toEqual({}));
  });
});

/**
 * REFRESH STATUS — asking the gateway when the webhook never arrived.
 *
 * WHAT THESE CASES ARE ACTUALLY FOR is the wiring, not the wording: the PATH,
 * the METHOD and the role gate. The server half of this feature is proved in
 * `server/shop/payments/sync.test.ts` and through the real composition root in
 * `server/shop/composition.test.ts`; what no server test can catch is a button
 * that posts to the wrong URL, which is the failure this harness exists for.
 */
describe('refresh status on an unpaid order', () => {
  const REFRESH = '/api/shop/admin/payments/intents/pi_1/refresh';

  /** The order as it looks when the money has not arrived — no payment row yet. */
  function unpaid(): void {
    when(ORDER, {
      order: { ...order, status: 'pending', paidAt: null },
      lines: [line],
      fulfillments: [],
      timeline: [],
      emails: [],
      payment: null,
    });
  }

  it('asks the gateway about this intent, and says what came back', async () => {
    const user = userEvent.setup();
    unpaid();
    when(REFRESH, {
      asked: true,
      gateway: 'paystack',
      gatewayStatus: 'captured',
      status: 'captured',
      changed: true,
      anomaly: null,
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    /* The path and the method, which is the whole point of stubbing `fetch`
       rather than the module. */
    await waitFor(() => expect(sent(REFRESH, 'POST')).toEqual({}));
    expect(await screen.findByText('Paystack says this was paid. The order is up to date now.')).toBeTruthy();
  });

  it('says plainly when the money still is not there', async () => {
    const user = userEvent.setup();
    unpaid();
    when(REFRESH, {
      asked: true,
      gateway: 'paystack',
      gatewayStatus: 'requires_payment',
      status: 'requires_payment',
      changed: false,
      anomaly: null,
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    /*
     * "NOTHING CHANGED" IS A RESULT, NOT A NON-EVENT. An operator presses this
     * because a gateway dashboard disagrees with this screen; being told the
     * money is genuinely not there is what sends them to look elsewhere instead
     * of pressing again.
     */
    expect(
      await screen.findByText('Nothing new — Paystack still says it hasn’t been paid.'),
    ).toBeTruthy();
  });

  it('never reports a refused capture as success', async () => {
    const user = userEvent.setup();
    unpaid();
    when(REFRESH, {
      asked: true,
      gateway: 'paystack',
      gatewayStatus: 'captured',
      status: 'requires_payment',
      changed: false,
      anomaly: 'amount_short',
    });
    mount();
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));

    /* Somebody paid the wrong sum. The money is not counted, nothing is applied,
       and the screen must not imply the order is ready to send. */
    expect(
      await screen.findByText(/doesn’t match this order. Nothing was applied/),
    ).toBeTruthy();
  });

  it('is not offered to a writer, who the server would 403', async () => {
    fixture.session.user.role = 'writer';
    unpaid();
    mount();
    await loaded();

    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
  });

  it('is not offered on a paid order, which has nothing to chase', async () => {
    withOrder();
    mount();
    await loaded();

    expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
  });
});
