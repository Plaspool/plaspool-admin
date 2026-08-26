import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The product list's BULK TAGS flow, and only that — the two ways it can be
 * wrong without looking wrong:
 *
 *  - **One revision for everybody.** The apply loop is a CAS save per product,
 *    and each PATCH must carry THAT row's `revision` from the list it was
 *    ticked on — a shared or invented base would let a row another tab moved
 *    be silently overwritten instead of refusing. Asserted key by key, per
 *    product.
 *  - **A tag added twice in two spellings.** "Filament" + "filament" is one
 *    tag: the modal's chip list folds case on entry, and the apply folds the
 *    chosen tags against each product's existing spellings — a product that
 *    already carries the case-variant is not written to at all, because there
 *    is nothing to change.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`: the per-product paths, the
 * PATCH bodies and the skipped write are exactly the things a mocked module
 * cannot vouch for.
 */

import type { ShopProduct } from '../../data/api-shop';
import { ToastHost } from '../ui/Toast';
import Products from './Products';

/* What jsdom does not implement and the v2 chrome touches. */
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

const wrote = (pathname: string, method: string): boolean =>
  calls.some((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);

beforeEach(() => {
  handlers.clear();
  calls = [];
  window.sessionStorage.clear();
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

const LIST = '/api/shop/admin/products';
const TAGS = '/api/shop/admin/tags';
const rowPath = (id: string): string => `${LIST}/${id}`;

function product(id: string, over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id,
    slug: id,
    title: `Spool ${id}`,
    description: null,
    status: 'active',
    category: 'Fibre',
    tags: [],
    coverImageId: null,
    imageIds: [],
    createdAt: 1_756_000_000_000,
    updatedAt: 1_756_100_000_000,
    publishedAt: 1_756_050_000_000,
    deletedAt: null,
    seoTitle: null,
    seoDescription: null,
    authorId: 'u_owner',
    revision: 1,
    ...over,
  };
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/products']}>
        <Products />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Tick both listed rows and open the Add tags… modal. */
async function openAddTags(user: ReturnType<typeof userEvent.setup>, firstTitle: string) {
  await screen.findByText(firstTitle);
  await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
  await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[1]);
  await user.click(screen.getByRole('button', { name: 'More bulk actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Add tags…' }));
  await screen.findByText('Add tags to 2 products');
}

// ============================================================================

describe('bulk tags on the product list', () => {
  it('writes each product with the revision it was listed under', async () => {
    const user = userEvent.setup();
    const amber = product('prod_a', { title: 'Amber spool', revision: 3 });
    const blue = product('prod_b', { title: 'Blue spool', revision: 9, tags: ['Blue'] });
    when(LIST, { items: [amber, blue], nextCursor: null });
    when(TAGS, { items: [] });
    when(rowPath('prod_a'), { product: { ...amber, tags: ['Bulk'], revision: 4 } });
    when(rowPath('prod_b'), { product: { ...blue, tags: ['Blue', 'Bulk'], revision: 10 } });
    mount();

    await openAddTags(user, 'Amber spool');
    await user.type(screen.getByLabelText('Tags to add'), 'Bulk,');
    await user.click(screen.getByRole('button', { name: 'Add tags' }));

    await waitFor(() => expect(wrote(rowPath('prod_b'), 'PATCH')).toBe(true));
    /*
     * PER-PRODUCT CAS: each body carries the revision of ITS row from the
     * list fixture — 3 and 9, not one shared number — so a row another tab
     * has moved refuses with a 409 instead of being overwritten.
     */
    expect(sent(rowPath('prod_a'), 'PATCH')).toEqual({
      patch: { tags: ['Bulk'] },
      baseRevision: 3,
    });
    expect(sent(rowPath('prod_b'), 'PATCH')).toEqual({
      patch: { tags: ['Blue', 'Bulk'] },
      baseRevision: 9,
    });
    expect(await screen.findByText('Tags updated on 2 products')).toBeTruthy();
  });

  it('folds case on add: “Filament” + “filament” is one tag, and a product already carrying it is left alone', async () => {
    const user = userEvent.setup();
    /* `folded` already carries the tag in another spelling — the apply must
       recognise that as "nothing to change" rather than writing a twin. */
    const folded = product('prod_a', { title: 'Amber spool', revision: 3, tags: ['filament'] });
    const bare = product('prod_b', { title: 'Blue spool', revision: 9 });
    when(LIST, { items: [folded, bare], nextCursor: null });
    when(TAGS, { items: [] });
    when(rowPath('prod_b'), { product: { ...bare, tags: ['Filament'], revision: 10 } });
    /* `prod_a` is deliberately UNREGISTERED: a write to it would 404, flip the
       toast to "1 updated, 1 refused" and fail the assertions below twice over. */
    mount();

    await openAddTags(user, 'Amber spool');
    const box = screen.getByLabelText('Tags to add');
    await user.type(box, 'Filament,');
    await user.type(box, 'filament,');

    /* One chip. The second spelling folded into the first at the door. */
    const chips = screen.getAllByRole('button', { name: /^Remove tag / });
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('aria-label')).toBe('Remove tag Filament');

    await user.click(screen.getByRole('button', { name: 'Add tags' }));

    /* Both counted as done — one written, one skipped as already tagged. */
    expect(await screen.findByText('Tags updated on 2 products')).toBeTruthy();
    expect(sent(rowPath('prod_b'), 'PATCH')).toEqual({
      patch: { tags: ['Filament'] },
      baseRevision: 9,
    });
    expect(wrote(rowPath('prod_a'), 'PATCH')).toBe(false);
  });
});
