import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * A VARIANT'S OWN RATE IN ANOTHER CURRENCY — the "Rates in other currencies"
 * section of the product screen's variant modal.
 *
 *  - **The rate travels as text.** Same rule as the Currencies card: the PUT
 *    body is `{ multiplier: "<what was typed>" }`, a string, key by key.
 *  - **It saves on its own buttons.** These are rows on their own route, so
 *    adding, editing or removing one must not touch the variant PATCH — and
 *    "Save variant" must not carry them.
 *  - **Only currencies a shopper can meet are offered.** Switched on or
 *    offered, never naira, never one the variant already has.
 *
 * `fetch` IS STUBBED, NOT the api module, for the reason the rewards suite
 * gives: path, method and body are what a mocked module cannot assert.
 */

vi.setConfig({ testTimeout: 20_000 });

import { ToastHost } from '../ui/Toast';
import type { ShopProductDetail, ShopVariant } from '../../data/api-shop';
import ProductDetail from './ProductDetail';

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

function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

const requests = (pathname: string, method: string) =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);

const writes = (): string[] =>
  calls
    .filter((c) => (c.init.method ?? 'GET') !== 'GET')
    .map((c) => `${c.init.method} ${c.path.split('?')[0]}`);

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

// -------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 8, 11, 9, 0);
const DAY = 86_400_000;

const variant: ShopVariant = {
  id: 'var_blue',
  productId: 'prod_spool',
  sku: 'SPL-BLU-1KG',
  optionValues: { Colour: 'Blue' },
  position: 1,
  weightGrams: 1000,
  status: 'active',
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - DAY,
  imageId: null,
  colorHex: '#2244aa',
  compareAtMinor: null,
  costMinor: null,
  price: { amount: 2_300_000, currency: 'NGN' },
  available: 5,
  backorderable: false,
  everOrdered: false,
};

const product: ShopProductDetail = {
  id: 'prod_spool',
  slug: 'recycled-petg-spool',
  title: 'Recycled Spool',
  description: null,
  status: 'active',
  category: 'Filament',
  tags: [],
  coverImageId: null,
  imageIds: [],
  createdAt: NOW - 60 * DAY,
  updatedAt: NOW - DAY,
  publishedAt: NOW - 50 * DAY,
  deletedAt: null,
  seoTitle: '',
  seoDescription: '',
  overview: null,
  overviewFallback: '',
  bulkDiscountEnabled: false,
  authorId: 'u_owner',
  revision: 3,
  variants: [variant],
};

const row = (code: string, extra: Record<string, unknown>) => ({
  code,
  exponent: 2,
  store: false,
  enabled: true,
  multiplier: null,
  source: 'feed',
  updatedAt: NOW,
  ageHours: 1,
  gateway: true,
  offered: true,
  reason: null,
  ...extra,
});

const currencySettings = {
  storeCurrency: 'NGN',
  revision: 7,
  stalenessHours: 168,
  fallbackCurrency: 'NGN',
  countries: {},
  known: ['NGN', 'GHS', 'USD', 'EUR', 'KES'],
  offered: ['NGN', 'GHS', 'USD'],
  currencies: [
    row('NGN', { store: true, multiplier: '1.000000000000', source: null }),
    row('GHS', { multiplier: '0.008496176720' }),
    row('USD', { multiplier: '0.000651000000' }),
    /* Switched on but not offered yet — a shopper will meet it soon, so it can be given a rate. */
    row('KES', { offered: false, reason: 'no_rate' }),
    /* Switched off and not offered: nobody can pay in it, so it is not offered here. */
    row('EUR', { enabled: false, offered: false, reason: 'disabled', multiplier: '0.000580000000' }),
  ],
};

const MULTS = `/api/shop/admin/variants/${variant.id}/multipliers`;
const multOf = (code: string) => `${MULTS}/${code}`;

function withProduct(): void {
  when(`/api/shop/admin/products/${product.id}`, { product });
  when('/api/shop/admin/categories', { items: [] });
  when('/api/shop/admin/tags', { items: [] });
  when('/api/shop/admin/audit', { items: [], nextCursor: null });
  when('/api/shop/admin/bulk-tiers', { tiers: [] });
  when(`/api/shop/admin/products/${product.id}/bulk-tiers`, { tiers: [], inherited: true, effective: [] });
  when('/api/shop/admin/payments/currency', currencySettings);
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={[`/products/${product.id}`]}>
        <Routes>
          <Route path="/products/:id" element={<ProductDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

async function openVariant(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findByDisplayValue('Recycled Spool');
  await user.click(screen.getByRole('button', { name: `Actions for ${variant.sku}` }));
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name: 'Edit variant…' }));
  return await screen.findByRole('dialog', { name: `Edit ${variant.sku}` });
}

// ============================================================================

describe('the variant modal’s rates in other currencies', () => {
  it('lists the variant’s own rates beside each currency’s normal one', async () => {
    const user = userEvent.setup();
    withProduct();
    when(MULTS, { items: [{ currency: 'GHS', multiplier: '0.009000000000', updatedAt: NOW }] });
    mount();

    const dialog = await openVariant(user);
    const input = (await within(dialog).findByLabelText('Cedis (GHS)')) as HTMLInputElement;
    expect(input.value).toBe('0.009');
    expect(dialog.textContent).toContain('replaces the currency’s normal rate for this variant only');
    expect(dialog.textContent).toContain('Normal rate: 1 naira = 0.008496 cedis');

    /* The picker offers what a shopper can meet and the variant doesn't already have. */
    const picker = within(dialog).getByLabelText('Currency') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'USD', 'KES']);
    expect(writes()).toEqual([]);
  });

  it('adds a rate with a PUT whose body is the typed string', async () => {
    const user = userEvent.setup();
    withProduct();
    when(MULTS, { items: [] });
    when(multOf('USD'), { items: [{ currency: 'USD', multiplier: '0.000700000000', updatedAt: NOW }] });
    mount();

    const dialog = await openVariant(user);
    const picker = (await within(dialog).findByLabelText('Currency')) as HTMLSelectElement;

    /* A bad rate is refused here, before any request. */
    await user.selectOptions(picker, 'USD');
    await user.type(within(dialog).getByLabelText('Rate for this variant'), '-0.0007');
    await user.click(within(dialog).getByRole('button', { name: 'Add rate' }));
    expect(dialog.textContent).toContain('Use a number above zero');
    expect(writes()).toEqual([]);

    await user.clear(within(dialog).getByLabelText('Rate for this variant'));
    await user.type(within(dialog).getByLabelText('Rate for this variant'), '0.0007');
    await user.click(within(dialog).getByRole('button', { name: 'Add rate' }));

    await waitFor(() => expect(requests(multOf('USD'), 'PUT')).toHaveLength(1));
    const body = JSON.parse(String(requests(multOf('USD'), 'PUT')[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ multiplier: '0.0007' });
    expect(typeof body.multiplier).toBe('string');
    /* Its own route, and nothing else — no variant PATCH rode along. */
    expect(writes()).toEqual([`PUT ${multOf('USD')}`]);

    /* The row appears from the response. */
    expect(((await within(dialog).findByLabelText('Dollars (USD)')) as HTMLInputElement).value).toBe('0.0007');
  });

  it('edits a rate with a PUT and removes one with a bodiless DELETE', async () => {
    const user = userEvent.setup();
    withProduct();
    when(MULTS, { items: [{ currency: 'GHS', multiplier: '0.009000000000', updatedAt: NOW }] });
    when(multOf('GHS'), (_url, init) =>
      init.method === 'DELETE'
        ? { body: { items: [] } }
        : { body: { items: [{ currency: 'GHS', multiplier: '0.009500000000', updatedAt: NOW }] } },
    );
    mount();

    const dialog = await openVariant(user);
    const input = await within(dialog).findByLabelText('Cedis (GHS)');
    const save = within(dialog).getByRole('button', { name: 'Save Cedis (GHS) rate' }) as HTMLButtonElement;
    /* Nothing to save until the rate changes. */
    expect(save.disabled).toBe(true);

    await user.clear(input);
    await user.type(input, '0.0095');
    await user.click(within(dialog).getByRole('button', { name: 'Save Cedis (GHS) rate' }));

    await waitFor(() => expect(requests(multOf('GHS'), 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requests(multOf('GHS'), 'PUT')[0]!.init.body))).toEqual({ multiplier: '0.0095' });

    await user.click(await within(dialog).findByRole('button', { name: 'Remove Cedis (GHS) rate' }));
    await waitFor(() => expect(requests(multOf('GHS'), 'DELETE')).toHaveLength(1));
    expect(requests(multOf('GHS'), 'DELETE')[0]!.init.body).toBeUndefined();
    expect(writes()).toEqual([`PUT ${multOf('GHS')}`, `DELETE ${multOf('GHS')}`]);

    await waitFor(() => expect(within(dialog).queryByLabelText('Cedis (GHS)')).toBeNull());
  });

  it('is not offered while adding a variant — there is no variant id yet', async () => {
    const user = userEvent.setup();
    withProduct();
    mount();

    await screen.findByDisplayValue('Recycled Spool');
    await user.click(screen.getAllByRole('button', { name: 'Add variant' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add variant' });
    expect(dialog.textContent).not.toContain('Rates in other currencies');
    expect(requests(MULTS, 'GET')).toHaveLength(0);
  });
});
