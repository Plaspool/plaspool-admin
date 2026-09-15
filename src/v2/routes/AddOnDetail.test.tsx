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

/** GET answers the fixture; a PATCH echoes the patch back over it, one revision on. */
const echoing = (row: typeof box): Responder => (init) => ((init.method ?? 'GET') === 'GET'
  ? { body: { addOn: row } }
  : { body: { addOn: { ...row, ...(JSON.parse(String(init.body)) as { patch: object }).patch, revision: row.revision + 1 } } });

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
    when(ONE, echoing(box));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    expect(screen.getByText('Rules are read top to bottom. The first one that fits decides.')).toBeTruthy();

    const price = screen.getByLabelText('Price');
    await user.clear(price);
    await user.type(price, '2000');

    // Rule 1 reads: Ask the customer · when Items in cart is between 1 and 4.
    const rule = screen.getByTestId('rule-0');
    const outcome = within(rule).getByLabelText('What happens') as HTMLSelectElement;
    expect(outcome.value).toBe('ask');
    await user.selectOptions(outcome, 'include');
    const charge = within(rule).getByLabelText('Charge');
    expect((charge as HTMLInputElement).placeholder).toMatch(/2,?000/);
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

  /*
   * THE OWNER'S EXAMPLE, BUILT THE WAY THEY WOULD BUILD IT (0960): switch the
   * outcome to "in the price", type 500, say it is for each item, save. The
   * assertion is the PATCH body, because the rule that reaches the column is
   * what the checkout evaluates -- a green screen that posts the wrong jsonb
   * is the failure this suite exists to catch.
   */
  it('sets up a take-it-out rule at ₦500 for each item, and posts the basis', async () => {
    const user = userEvent.setup();
    when(ONE, echoing(box));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');

    const rule = screen.getByTestId('rule-0');
    await user.selectOptions(within(rule).getByLabelText('What happens'), 'opt_out');
    /* The money box is not called Charge any more: the number is money going
       BACK, and a box labelled Charge would be read with the wrong sign. */
    expect(within(rule).queryByLabelText('Charge')).toBeNull();
    await user.type(within(rule).getByLabelText('Save'), '500');
    await user.selectOptions(within(rule).getByLabelText('How often'), 'item');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0].patch.rules).toEqual([
      {
        when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }],
        then: 'opt_out',
        amountMinor: 50_000,
        basis: 'item',
      },
    ]);
  });

  it('adds a rule and a condition through the registry pickers', async () => {
    const user = userEvent.setup();
    when(ONE, () => ({ body: { addOn: box } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    const rule = screen.getByTestId('rule-1');
    expect(within(rule).getByText('Every cart. Add a condition to narrow it down.')).toBeTruthy();
    await user.click(within(rule).getByRole('button', { name: 'Add condition' }));
    await user.selectOptions(within(rule).getByLabelText('Attribute'), 'tag');
    expect(within(rule).getByLabelText('Operator')).toBeTruthy();
    expect(within(rule).getByText('is any of')).toBeTruthy();
    // A typed value becomes a chip on Enter.
    await user.type(within(rule).getByLabelText('Values'), 'gift{Enter}');
    expect(within(rule).getByRole('button', { name: 'Remove gift' })).toBeTruthy();
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

  it('the status is one switch: on saves it active, off saves it a draft', async () => {
    const user = userEvent.setup();
    when(ONE, echoing(box));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    const offered = screen.getByRole('switch', { name: 'Offered at checkout' }) as HTMLInputElement;
    expect(offered.checked).toBe(false);
    await user.click(offered);
    expect(offered.checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0].patch).toMatchObject({ status: 'active' });
  });

  it('archiving lives under More actions, asks first, and moves only the status', async () => {
    const user = userEvent.setup();
    when(ONE, echoing(box));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    // An unsaved edit on screen must not ride along with the archive.
    await user.type(screen.getByLabelText('Name'), '!');

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive add-on' }));
    expect(await screen.findByText('Archive Gift box?')).toBeTruthy();
    expect(bodiesOf(ONE, 'PATCH').length).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0]).toEqual({ baseRevision: 3, patch: { status: 'archived' } });

    // The screen adopts the archived row: the badge, the sidebar, and the menu
    // now offering the way back.
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Offered at checkout' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Put it back' })).toBeTruthy();
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

  it('removing a rule does not leave the survivor showing a different rule’s Charge', async () => {
    // The debt ledger's exact repro: [A: no amount, B: ₦2,000] — remove A, and
    // an index-keyed card would keep showing A's empty Charge over B's data.
    const user = userEvent.setup();
    const twoRules = {
      ...box,
      rules: [
        { when: [], then: 'ask' },
        { when: [], then: 'include', amountMinor: 200_000 },
      ],
    };
    when(ONE, echoing(twoRules));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');
    expect(screen.getByTestId('rule-0')).toBeTruthy();
    expect(screen.getByTestId('rule-1')).toBeTruthy();

    await user.click(within(screen.getByTestId('rule-0')).getByRole('button', { name: 'Remove rule' }));
    expect(screen.queryByTestId('rule-1')).toBeNull();

    const survivor = screen.getByTestId('rule-0');
    const charge = within(survivor).getByLabelText('Charge') as HTMLInputElement;
    expect(charge.value).toBe('2,000.00');
    // The placeholder falls back to the add-on's own price (₦1,500, untouched
    // in this test) and reads it through `formatMinor` — locale-dependent, so
    // matched on digits with the grouping comma optional, same as
    // `SpoolsAnalytics.test.tsx`.
    expect(charge.placeholder).toMatch(/1,?500\.00/);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0].patch).toMatchObject({
      rules: [{ when: [], then: 'include', amountMinor: 200_000 }],
    });
  });

  it('discarding after typing a Charge shows the saved value again', async () => {
    const user = userEvent.setup();
    when(ONE, () => ({ body: { addOn: box } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');

    const rule = screen.getByTestId('rule-0');
    const charge = within(rule).getByLabelText('Charge') as HTMLInputElement;
    await user.type(charge, '500');
    // Blur commits the typed amount to state (only then does the save bar
    // appear) — the same tab-away a person does before reaching for Discard.
    await user.tab();
    await user.click(await screen.findByRole('button', { name: 'Discard' }));

    const survivor = screen.getByTestId('rule-0');
    expect((within(survivor).getByLabelText('Charge') as HTMLInputElement).value).toBe('');
  });

  it('picks a product by its title through the search-select, not by typing its id', async () => {
    const user = userEvent.setup();
    when(ONE, echoing(box));
    when('/api/shop/admin/products', () => ({ body: { items: [{ id: 'prd_1', title: 'PLA Silk' }, { id: 'prd_2', title: 'PLA Basic' }], nextCursor: null } }));
    mount('/products/add-ons/ado_box');
    await screen.findByDisplayValue('Gift box');

    const rule = screen.getByTestId('rule-0');
    await user.selectOptions(within(rule).getByLabelText('Attribute'), 'product');
    await user.click(within(rule).getByRole('button', { name: 'Add a product' }));
    await user.click(await screen.findByRole('option', { name: 'PLA Silk' }));
    expect(within(rule).getByText('PLA Silk')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(ONE, 'PATCH').length).toBe(1));
    expect(bodiesOf(ONE, 'PATCH')[0].patch).toMatchObject({
      rules: [{ when: [{ attribute: 'product', op: 'any_in', values: ['prd_1'] }] }],
    });
  });
});
