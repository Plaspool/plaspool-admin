import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

const fixture = vi.hoisted(() => ({
  session: { status: 'authed', user: { id: 'u_owner', email: 'o@test.local', displayName: 'An Owner', role: 'owner' as const } },
}));
vi.mock('../../data/session', () => ({ getSession: () => fixture.session, subscribe: () => () => {}, initSession: vi.fn(), logout: vi.fn() }));

import { ToastHost } from '../ui/Toast';
import AddOns from './AddOns';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

const LIST = '/api/shop/admin/add-ons';
let items: unknown[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'https://studio.test');
    const body = url.pathname === LIST ? { items } : { error: 'gone', requestId: 'req_test' };
    return new Response(JSON.stringify(body), { status: url.pathname === LIST ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const box = {
  id: 'ado_box', title: 'Gift box', description: null, imageId: null, priceMinor: 150_000, currency: 'NGN', status: 'active',
  rules: [{ when: [{ attribute: 'item_count', op: 'between', min: 1, max: 4 }], then: 'ask' }, { when: [{ attribute: 'item_count', op: 'gte', value: 5 }], then: 'include', amountMinor: 0 }],
  position: 0, revision: 3, createdAt: 1, updatedAt: 1,
};

function mount() {
  return render(<ToastHost><MemoryRouter initialEntries={['/products/add-ons']}><AddOns /></MemoryRouter></ToastHost>);
}

describe('Add-ons', () => {
  it('lists each add-on with its status beside the name, its price, and a few words on when it is offered', async () => {
    items = [box, { ...box, id: 'ado_note', title: 'Gift note', status: 'draft', priceMinor: 0, rules: [] }];
    mount();
    expect(await screen.findByText('Gift box')).toBeTruthy();
    // Status is the second column: draft or active is the first thing to know.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(['Add-on', 'Status', 'Price', "When it's offered"]);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    // The short form leads with the first rule and counts the rest.
    expect(screen.getByText('Ask · 1–4 items')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.getByText('Never offered')).toBeTruthy();
    expect(screen.getByRole('link', { name: /New add-on/ })).toBeTruthy();
  });

  it('the (i) shows every rule in full on hover and puts it away on leaving', async () => {
    const user = userEvent.setup();
    items = [box];
    mount();
    await screen.findByText('Gift box');
    const tip = screen.getByRole('button', { name: 'How Gift box is offered, in full' });
    expect(screen.queryByText('Ask when Items in cart is between 1 and 4')).toBeNull();
    await user.hover(tip);
    expect(await screen.findByText('Ask when Items in cart is between 1 and 4')).toBeTruthy();
    expect(screen.getByText('Included free when Items in cart is at least 5')).toBeTruthy();
    await user.unhover(tip);
    await waitFor(() => expect(screen.queryByText('Ask when Items in cart is between 1 and 4')).toBeNull());
  });

  it('the tabs filter by status', async () => {
    items = [box, { ...box, id: 'ado_note', title: 'Gift note', status: 'draft' }];
    mount();
    await screen.findByText('Gift box');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.queryByText('Gift box')).toBeNull();
    expect(screen.getByText('Gift note')).toBeTruthy();
  });

  it('shows the first-run empty state', async () => {
    items = [];
    mount();
    expect(await screen.findByText('No add-ons yet')).toBeTruthy();
    expect(screen.getByText(/Add-ons are extras offered at checkout, and on the product page/)).toBeTruthy();
  });
});
