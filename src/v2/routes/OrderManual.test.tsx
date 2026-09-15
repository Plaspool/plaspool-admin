import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * RECORD A SALE BY HAND — the create and edit form, and the list's badge.
 *
 * What these pin is the WIRE, because the server half was written in another
 * session against a contract, and a form that looks right can still send
 * naira where kobo belongs, `''` where nothing belongs, or an edit without the
 * revision it was based on:
 *
 *  - the create body, key by key: integer kobo per line, the bare date string,
 *    the enum values, and `advanced` ABSENT until something under it is filled
 *    — then only the members that were;
 *  - a 400 naming a field lands on that field;
 *  - an edit is a PUT carrying `baseRevision`, and a 409 says to reload;
 *  - the order list marks a manual order.
 *
 * `fetch` is stubbed rather than the api module, for the reason the rewards
 * suite gives: path, method and body are what a mocked module cannot assert.
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
import OrderManual from './OrderManual';
import Orders from './Orders';

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

/** 2026-09-11 10:00 UTC — "today" is the 11th in Lagos. */
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
});

// -------------------------------------------------------------- fixtures

const PRODUCTS = '/api/shop/admin/products';
const PRODUCT = '/api/shop/admin/products/prd_1';
const CREATE = '/api/shop/admin/orders/manual';
const ORDER = '/api/shop/admin/orders/ord_m';
const UPDATE = '/api/shop/admin/orders/ord_m/manual';
const LIST = '/api/shop/admin/orders';

const product = {
  id: 'prd_1',
  slug: 'pla-basic',
  title: 'PLA Basic',
  status: 'active',
  revision: 1,
};

function variant(id: string, colour: string, amount: number, available: number) {
  return {
    id,
    productId: 'prd_1',
    sku: `PLA-${colour.toUpperCase()}`,
    optionValues: { Colour: colour },
    position: 0,
    status: 'active',
    price: { amount, currency: 'NGN' },
    available,
    backorderable: false,
    everOrdered: true,
  };
}

function withCatalogue(): void {
  when(PRODUCTS, { items: [product], nextCursor: null });
  when(PRODUCT, {
    product: {
      ...product,
      variants: [variant('var_black', 'Black', 2800000, 12), variant('var_white', 'White', 2600000, 0)],
    },
  });
}

const baseOrder = {
  id: 'ord_m',
  orderNumber: 'PP-2001-3',
  customerId: null,
  email: '',
  currency: 'NGN',
  subtotal: 5600000,
  shippingTotal: 0,
  taxTotal: 0,
  grandTotal: 5600000,
  addOnTotal: 0,
  refundedTotal: 0,
  status: 'fulfilled',
  shippingAddress: {},
  billingAddress: {},
  placedAt: NOW - 3_600_000,
  paidAt: Date.UTC(2026, 8, 9, 0, 0, 0),
  fulfilledAt: NOW - 3_600_000,
  deliveredAt: null,
  cancelledAt: null,
  revision: 3,
  checkoutId: 'chk_manual',
  paymentIntentId: null,
  source: 'manual',
};

const manualDetail = {
  order: baseOrder,
  lines: [
    {
      id: 'line_1',
      lineNo: 1,
      variantId: 'var_black',
      sku: 'PLA-BLACK',
      title: 'PLA Basic',
      optionValues: { Colour: 'Black' },
      qty: 2,
      unitAmount: 2800000,
      lineTotal: 5600000,
      fulfilledQty: 0,
    },
  ],
  fulfillments: [],
  timeline: [],
  emails: [],
  payment: null,
  manual: {
    paymentMethod: 'cash',
    paymentReference: null,
    salesChannel: null,
    note: null,
    stockTaken: true,
    customer: { name: null, email: null, phone: null },
  },
};

/** Where the form lands after a save — shows what the router was handed. */
function Landed() {
  const location = useLocation();
  return <p>Landed on {location.pathname}</p>;
}

function mountForm(path = '/orders/new') {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/orders/new" element={<OrderManual />} />
          <Route path="/orders/:id/edit" element={<OrderManual />} />
          <Route path="/orders/:id" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

async function addBlack(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Search products' }));
  await user.type(screen.getByRole('combobox', { name: 'Search products' }), 'black');
  await user.click(await screen.findByRole('option', { name: /PLA Basic — Black/ }));
}

// ============================================================================

describe('recording a sale by hand', () => {
  it('sends integer kobo, the date string and the enum values — and no advanced block when nothing under it was filled', async () => {
    const user = userEvent.setup();
    withCatalogue();
    when(CREATE, { ...manualDetail, order: { ...baseOrder, id: 'ord_9' }, stock: { failed: [] } }, 201);
    mountForm();

    await addBlack(user);
    // The picker offered the price and the stock beside the name.
    const quantity = await screen.findByLabelText('Quantity of PLA Basic — Black');
    expect(screen.getByLabelText('Price of PLA Basic — Black')).toHaveProperty('value', '28,000');

    await user.clear(quantity);
    await user.type(quantity, '2');
    const price = screen.getByLabelText('Price of PLA Basic — Black');
    await user.clear(price);
    await user.type(price, '27,500.50');

    fireEvent.change(screen.getByLabelText('Date sold'), { target: { value: '2026-09-10' } });
    await user.selectOptions(screen.getByLabelText('How was it paid?'), 'bank_transfer');
    await user.type(screen.getByLabelText('Reference (optional)'), 'TRX-778');

    // The live total is the same arithmetic the body carries: 2 × ₦27,500.50.
    expect(screen.getAllByText('₦55,001.00').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Landed on /orders/ord_9');

    const body = sent(CREATE, 'POST');
    expect(Object.keys(body).sort()).toEqual([
      'lines',
      'paymentMethod',
      'paymentReference',
      'soldAt',
      'takeFromStock',
    ]);
    expect(body.soldAt).toBe('2026-09-10');
    expect(body.lines).toEqual([{ variantId: 'var_black', qty: 2, unitAmount: 2750050 }]);
    expect(Number.isInteger((body.lines as { unitAmount: number }[])[0]!.unitAmount)).toBe(true);
    expect(body.paymentMethod).toBe('bank_transfer');
    expect(body.paymentReference).toBe('TRX-778');
    expect(body.takeFromStock).toBe(true);
  });

  it('sends only the advanced fields that were filled, in kobo, and today by default', async () => {
    const user = userEvent.setup();
    withCatalogue();
    when(CREATE, { ...manualDetail, order: { ...baseOrder, id: 'ord_9' }, stock: { failed: [] } }, 201);
    mountForm();

    await addBlack(user);
    await user.selectOptions(screen.getByLabelText('How was it paid?'), 'cash');
    await user.click(screen.getByLabelText(/Take these items out of stock/));

    // Closed by default: none of its boxes exist until it is opened.
    expect(screen.queryByLabelText('Customer name')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Advanced/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);

    await user.type(screen.getByLabelText('Customer name'), '  Ada Obi ');
    await user.selectOptions(screen.getByLabelText('Where did the sale come from?'), 'whatsapp');
    await user.type(screen.getByLabelText('Delivery fee'), '2500');
    await user.type(screen.getByLabelText('City'), 'Wuse');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Landed on /orders/ord_9');

    const body = sent(CREATE, 'POST');
    // The date box was never touched: today, in the shop's own calendar.
    expect(body.soldAt).toBe('2026-09-11');
    // Current price, untouched: still sent, as the kobo the picker offered.
    expect(body.lines).toEqual([{ variantId: 'var_black', qty: 1, unitAmount: 2800000 }]);
    expect(body.takeFromStock).toBe(false);
    expect('paymentReference' in body).toBe(false);
    // Trimmed, and nothing that was left blank: no email, no phone, no
    // discount, no tax, no note — and the country rides only with an address.
    expect(body.advanced).toEqual({
      customer: { name: 'Ada Obi' },
      salesChannel: 'whatsapp',
      address: { city: 'Wuse', countryCode: 'NG' },
      shippingAmount: 250000,
    });
  });

  it('refuses to send without a product or a payment method, and puts a server 400 on its field', async () => {
    const user = userEvent.setup();
    withCatalogue();
    when(CREATE, { error: 'bad_request', detail: 'soldAt', requestId: 'req_1' }, 400);
    mountForm();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Add at least one product.')).toBeTruthy();
    expect(screen.getByText('Choose how it was paid.')).toBeTruthy();
    expect(writes(CREATE)).toBe(0);

    await addBlack(user);
    await user.selectOptions(screen.getByLabelText('How was it paid?'), 'pos');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The server's refusal named `soldAt`; the sentence sits under that box.
    expect(await screen.findByText('Pick the day it was sold — today or earlier.')).toBeTruthy();
    expect(writes(CREATE)).toBe(1);
  });
});

describe('editing a manual order', () => {
  it('prefills from the order and PUTs the whole thing with its baseRevision', async () => {
    const user = userEvent.setup();
    withCatalogue();
    when(ORDER, manualDetail);
    when(UPDATE, { ...manualDetail, order: { ...baseOrder, revision: 4 }, stock: { failed: [] } });
    mountForm('/orders/ord_m/edit');

    const quantity = await screen.findByLabelText('Quantity of PLA Basic — Black');
    expect(quantity).toHaveProperty('value', '2');
    expect(screen.getByLabelText('Date sold')).toHaveProperty('value', '2026-09-09');
    expect(screen.getByLabelText('How was it paid?')).toHaveProperty('value', 'cash');

    await user.click(screen.getByRole('button', { name: 'One more PLA Basic — Black' }));
    await user.selectOptions(screen.getByLabelText('How was it paid?'), 'bank_transfer');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Landed on /orders/ord_m');

    const body = sent(UPDATE, 'PUT');
    expect(body.baseRevision).toBe(3);
    expect(body.soldAt).toBe('2026-09-09');
    expect(body.lines).toEqual([{ variantId: 'var_black', qty: 3, unitAmount: 2800000 }]);
    expect(body.paymentMethod).toBe('bank_transfer');
    expect(body.takeFromStock).toBe(true);
    expect('advanced' in body).toBe(false);
  });

  it('says to reload when someone else saved first (409)', async () => {
    const user = userEvent.setup();
    when(ORDER, manualDetail);
    when(UPDATE, { error: 'stale_write', expected: 3, actual: 4, requestId: 'req_2' }, 409);
    mountForm('/orders/ord_m/edit');

    await screen.findByLabelText('Quantity of PLA Basic — Black');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        'Someone else changed this order while you had it open. Reload to see their changes.',
      ),
    ).toBeTruthy();
    expect(sent(UPDATE, 'PUT').baseRevision).toBe(3);
    // Still on the form — nothing navigated away from the unsaved boxes.
    expect(screen.queryByText(/Landed on/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});

describe('the order list', () => {
  it('marks a manual order and offers New order', async () => {
    const online = { ...baseOrder, id: 'ord_o', orderNumber: 'PP-1000-1', email: 'buyer@test.local', source: 'online' };
    const manual = { ...baseOrder, orderNumber: 'PP-2001-3', email: 'ada@test.local' };
    when(LIST, {
      items: [
        { order: online, lines: [] },
        { order: manual, lines: [] },
      ],
      nextCursor: null,
    });
    render(
      <ToastHost>
        <MemoryRouter initialEntries={['/orders']}>
          <Routes>
            <Route path="/orders" element={<Orders />} />
          </Routes>
        </MemoryRouter>
      </ToastHost>,
    );

    const manualRow = (await screen.findByText('PP-2001-3')).closest('tr')!;
    const onlineRow = screen.getByText('PP-1000-1').closest('tr')!;
    expect(within(manualRow).getByText('Manual')).toBeTruthy();
    expect(within(onlineRow).queryByText('Manual')).toBeNull();
    // A manual order is recorded already sent out — in the owner's words.
    expect(within(manualRow).getByText('Sent out')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'New order' });
    expect(link.getAttribute('href')).toBe('/orders/new');
  });

  it('asks the server for one source when the filter is set', async () => {
    when(LIST, { items: [{ order: baseOrder, lines: [] }], nextCursor: null });
    render(
      <ToastHost>
        <MemoryRouter initialEntries={['/orders']}>
          <Routes>
            <Route path="/orders" element={<Orders />} />
          </Routes>
        </MemoryRouter>
      </ToastHost>,
    );
    await screen.findByText('PP-2001-3');
    // No filter, no parameter: the wire carries only what differs from "all".
    expect(calls.some((c) => c.path.startsWith(`${LIST}?`) && c.path.includes('source='))).toBe(false);

    const picker = screen.getByLabelText('Where the order came from');
    fireEvent.change(picker, { target: { value: 'manual' } });
    await vi.waitFor(() =>
      expect(calls.some((c) => c.path.includes('source=manual'))).toBe(true),
    );

    fireEvent.change(picker, { target: { value: 'online' } });
    await vi.waitFor(() =>
      expect(calls.some((c) => c.path.includes('source=online'))).toBe(true),
    );
  });
});
