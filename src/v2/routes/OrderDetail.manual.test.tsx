import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ORDER DETAIL FOR A SALE RECORDED BY HAND.
 *
 *  - It is marked Manual, says how it was paid, offers Edit — and none of the
 *    parcel, send-out, refund or cancel controls, which have nothing to act on.
 *  - Void CONFIRMS before it posts, and posts the revision it was based on.
 *  - The edit history reads as sentences a person can check: who, and what
 *    changed against the version before — "Quantity of PLA Basic — Black:
 *    2 → 3", "Paid by: Cash → Bank transfer".
 *
 * `fetch` is stubbed, as in the sibling suites.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: { id: 'u_owner', email: 'o@test.local', displayName: 'An Owner', role: 'owner' },
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
  handlers.set(pathname, typeof body === 'function' ? (body as Responder) : () => ({ status, body }));
}

function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const writes = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET').length;

const NOW = Date.UTC(2026, 8, 11, 10, 0, 0);

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

// -------------------------------------------------------------- fixtures

const ORDER = '/api/shop/admin/orders/ord_m';
const VOID = '/api/shop/admin/orders/ord_m/void';
const REVISIONS = '/api/shop/admin/orders/ord_m/revisions';

const order = {
  id: 'ord_m',
  orderNumber: 'PP-2001-3',
  customerId: null,
  email: 'ada@test.local',
  currency: 'NGN',
  subtotal: 8400000,
  shippingTotal: 250000,
  taxTotal: 0,
  grandTotal: 8150000,
  addOnTotal: 0,
  refundedTotal: 0,
  status: 'fulfilled',
  shippingAddress: { line1: '4 Aminu Kano Crescent', city: 'Wuse', region: 'FCT', countryCode: 'NG' },
  billingAddress: {},
  placedAt: NOW - 3_600_000,
  paidAt: Date.UTC(2026, 8, 10, 0, 0, 0),
  fulfilledAt: NOW - 3_600_000,
  deliveredAt: null,
  cancelledAt: null,
  revision: 3,
  checkoutId: 'chk_manual',
  paymentIntentId: null,
  source: 'manual',
};

const detail = {
  order,
  lines: [
    {
      id: 'line_1',
      lineNo: 1,
      variantId: 'var_black',
      sku: 'PLA-BLACK',
      title: 'PLA Basic',
      optionValues: { Colour: 'Black' },
      qty: 3,
      unitAmount: 2800000,
      lineTotal: 8400000,
      fulfilledQty: 0,
    },
  ],
  fulfillments: [],
  timeline: [],
  emails: [],
  payment: null,
  manual: {
    paymentMethod: 'bank_transfer',
    paymentReference: 'TRX-778',
    salesChannel: 'whatsapp',
    note: 'Paid half upfront.',
    stockTaken: true,
    customer: { name: 'Ada Obi', email: 'ada@test.local', phone: null },
  },
};

function snapshot(qty: number, paymentMethod: string, soldAt: number) {
  return {
    soldAt,
    lines: [
      {
        variantId: 'var_black',
        sku: 'PLA-BLACK',
        title: 'PLA Basic',
        optionValues: { Colour: 'Black' },
        qty,
        unitAmount: 2800000,
        lineTotal: qty * 2800000,
      },
    ],
    paymentMethod,
    paymentReference: 'TRX-778',
    salesChannel: 'whatsapp',
    customer: { name: 'Ada Obi', email: 'ada@test.local', phone: null },
    address: null,
    shippingAmount: 250000,
    discountAmount: 500000,
    taxAmount: 0,
    subtotal: qty * 2800000,
    grandTotal: qty * 2800000 + 250000 - 500000,
    note: 'Paid half upfront.',
    takeFromStock: true,
    status: 'fulfilled',
  };
}

const revisions = {
  items: [
    {
      revision: 3,
      kind: 'edited',
      editedAt: NOW - 600_000,
      editedBy: { id: 'u_2', name: 'Bola Staff' },
      snapshot: snapshot(3, 'bank_transfer', Date.UTC(2026, 8, 10)),
    },
    {
      revision: 2,
      kind: 'created',
      editedAt: NOW - 3_600_000,
      editedBy: { id: 'u_owner', name: 'An Owner' },
      snapshot: snapshot(2, 'cash', Date.UTC(2026, 8, 9)),
    },
  ],
};

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/orders/ord_m']}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('a manual order on the detail screen', () => {
  it('is marked Manual, says how it was paid, and offers Edit instead of the checkout controls', async () => {
    when(ORDER, detail);
    when(REVISIONS, revisions);
    mount();

    await screen.findByText('PP-2001-3');
    expect(screen.getByText('Manual')).toBeTruthy();
    expect(screen.getByText('Sent out')).toBeTruthy();

    expect(screen.getByRole('heading', { name: 'How it was paid' })).toBeTruthy();
    expect(screen.getByText('Bank transfer')).toBeTruthy();
    expect(screen.getByText('TRX-778')).toBeTruthy();
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('Paid half upfront.')).toBeTruthy();

    const edit = screen.getByRole('link', { name: 'Edit' });
    expect(edit.getAttribute('href')).toBe('/orders/ord_m/edit');

    // Nothing to send out, pack or refund: already sent out, no intent.
    expect(screen.queryByRole('button', { name: /Send out items/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Parcels' })).toBeNull();
    expect(screen.queryByText('Fulfilled')).toBeNull();
    // The discount is what the parts add up to beyond the total.
    expect(screen.getByText('−₦5,000.00')).toBeTruthy();
  });

  it('confirms before voiding, then posts the revision it was based on', async () => {
    const user = userEvent.setup();
    when(ORDER, detail);
    when(REVISIONS, revisions);
    when(VOID, { ...detail, order: { ...order, status: 'cancelled', cancelledAt: NOW, revision: 4 } });
    mount();
    await screen.findByText('PP-2001-3');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Void order…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Void this order?' });
    expect(within(dialog).getByText(/It will no longer count as a sale\./)).toBeTruthy();
    // Opening the confirm sent nothing.
    expect(writes(VOID)).toBe(0);

    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Entered twice');
    await user.click(within(dialog).getByRole('button', { name: 'Void order' }));

    await waitFor(() => expect(writes(VOID)).toBe(1));
    expect(sent(VOID, 'POST')).toEqual({ baseRevision: 3, reason: 'Entered twice' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the order when the void is called off', async () => {
    const user = userEvent.setup();
    when(ORDER, detail);
    when(REVISIONS, revisions);
    mount();
    await screen.findByText('PP-2001-3');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Void order…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Void this order?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep the order' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(VOID)).toBe(0);
  });

  it('shows the edit history as who, when, and what changed', async () => {
    when(ORDER, detail);
    when(REVISIONS, revisions);
    mount();

    const history = (await screen.findByRole('heading', { name: 'Edit history' })).closest('section')!;
    await within(history).findByText('Edited by Bola Staff');
    expect(within(history).getByText('Recorded by An Owner')).toBeTruthy();

    expect(within(history).getByText('Quantity of PLA Basic — Black: 2 → 3')).toBeTruthy();
    expect(within(history).getByText('Paid by: Cash → Bank transfer')).toBeTruthy();
    expect(within(history).getByText('Date sold: 9 Sep → 10 Sep')).toBeTruthy();
    // The total moved with the quantity; nothing that did not change is listed.
    expect(within(history).getByText('Total: ₦53,500.00 → ₦81,500.00')).toBeTruthy();
    expect(within(history).queryByText(/Reference:/)).toBeNull();
    expect(within(history).queryByText(/Delivery fee:/)).toBeNull();
  });

  it('keeps Void from a writer, whom the server would refuse', async () => {
    fixture.session.user.role = 'writer';
    when(ORDER, detail);
    when(REVISIONS, revisions);
    mount();

    await screen.findByText('PP-2001-3');
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('offers neither Edit nor Void once voided', async () => {
    when(ORDER, { ...detail, order: { ...order, status: 'cancelled', cancelledAt: NOW } });
    when(REVISIONS, revisions);
    mount();

    await screen.findByText('PP-2001-3');
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);
    expect(screen.getByText('This order was voided')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});
