import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

const fixture = vi.hoisted(() => ({
  session: { status: 'authed', user: { id: 'u_owner', email: 'o@test.local', displayName: 'An Owner', role: 'owner' as const } },
}));
vi.mock('../../data/session', () => ({ getSession: () => fixture.session, subscribe: () => () => {}, initSession: vi.fn(), logout: vi.fn() }));

import { ToastHost } from '../ui/Toast';
import AddOnDetail from './AddOnDetail';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

type Responder = (init: RequestInit) => { status?: number; body: unknown };
const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];
const when = (path: string, respond: Responder) => handlers.set(path, respond);
const bodiesOf = (path: string, method: string) =>
  calls.filter((c) => c.path === path && (c.init.method ?? 'GET') === method).map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://studio.test');
    calls.push({ path: url.pathname, init });
    const answer = handlers.get(url.pathname)?.(init) ?? { status: 404, body: { error: 'gone', requestId: 'req_test' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const box = {
  id: 'ado_box', title: 'Gift box', description: 'Boxed and ribboned.', imageId: null, priceMinor: 150_000, currency: 'NGN', status: 'draft',
  rules: [{ when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' }],
  position: 0, revision: 3, createdAt: 1, updatedAt: 1,
};
const ONE = '/api/shop/admin/add-ons/ado_box';

function mount(path: string) {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/products/add-ons/new" element={<AddOnDetail create />} />
          <Route path="/products/add-ons/:id" element={<AddOnDetail />} />
          <Route path="/products/add-ons" element={<p>list</p>} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

describe('AddOnDetail', () => {
  it('loads an add-on, edits its price and a rule, and PATCHes under the loaded revision', async () => {
    const user = userEvent.setup();
    when(ONE, (init) => ((init.method ?? 'GET') === 'GET'
      ? { body: { addOn: box } }
      : { body: { addOn: { ...box, ...(JSON.parse(String(init.body)) as { patch: object }).patch, revision: 4 } } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    expect(screen.getByText('Rules are read top to bottom. The first one that fits decides.')).toBeTruthy();

    const price = screen.getByLabelText('Price');
    await user.clear(price);
    await user.type(price, '2000');

    // Rule 1 reads: Ask the customer · when Items in cart is between 1 and 4.
    const rule = screen.getByTestId('rule-0');
    expect(within(rule).getByRole('button', { name: 'Ask the customer', pressed: true })).toBeTruthy();
    await user.click(within(rule).getByRole('button', { name: 'Add it automatically' }));
    const charge = within(rule).getByLabelText('Charge');
    expect((charge as HTMLInputElement).placeholder).toContain('2,000');
    await user.type(charge, '0');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0]).toEqual({
      baseRevision: 3,
      patch: {
        title: 'Gift box',
        description: 'Boxed and ribboned.',
        imageId: null,
        priceMinor: 200_000,
        status: 'draft',
        position: 0,
        rules: [{ when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'include', amountMinor: 0 }],
      },
    });
  });

  it('adds a rule and a condition through the registry pickers', async () => {
    const user = userEvent.setup();
    when(ONE, () => ({ body: { addOn: box } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const rule = screen.getByTestId('rule-1');
    await user.click(within(rule).getByRole('button', { name: 'Add condition' }));
    await user.selectOptions(within(rule).getByLabelText('Attribute'), 'tag');
    expect(within(rule).getByLabelText('Operator')).toBeTruthy();
    expect(within(rule).getByText('is any of')).toBeTruthy();
    await user.selectOptions(within(rule).getByLabelText('Attribute'), 'signed_in');
    expect(within(rule).getByLabelText('Value')).toBeTruthy();
  });

  it('creates a draft and moves to it', async () => {
    const user = userEvent.setup();
    when('/api/shop/admin/add-ons', (init) => ({ status: 201, body: { addOn: { ...box, ...(JSON.parse(String(init.body)) as object), id: 'ado_new', revision: 1 } } }));
    when('/api/shop/admin/add-ons/ado_new', () => ({ body: { addOn: { ...box, id: 'ado_new', title: 'Note' } } }));
    mount('/products/add-ons/new');
    await user.type(screen.getByLabelText('Name'), 'Note');
    await user.type(screen.getByLabelText('Price'), '500');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf('/api/shop/admin/add-ons', 'POST').length).toBe(1));
    expect(bodiesOf('/api/shop/admin/add-ons', 'POST')[0]).toMatchObject({ title: 'Note', priceMinor: 50_000, status: 'draft', rules: [{ when: [], then: 'ask' }] });
  });

  it('a stale save shows the conflict banner and does not lie about saving', async () => {
    const user = userEvent.setup();
    when(ONE, (init) => ((init.method ?? 'GET') === 'GET'
      ? { body: { addOn: box } }
      : { status: 409, body: { error: 'stale_write', expected: 3, actual: 4, addOn: { ...box, revision: 4 }, requestId: 'r' } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    await user.type(screen.getByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone else saved this add-on/)).toBeTruthy();
  });
});
