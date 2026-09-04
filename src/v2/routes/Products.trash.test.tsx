import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The product list's TRASH tab.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS: A TRASHED PRODUCT HAD NO ROUTE TO IT.
 *
 * `deleted_at` is independent of `status`, so the All/Active/Draft/Archived
 * tabs all exclude the trash — and those were the only four. The detail screen
 * has had a working Restore button the whole time and nothing could navigate
 * to it, so on 2026-09-04 the answer to "how do I get this product back" was
 * "type its id into the URL bar". The server already answered `status=trash`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`. What can go wrong here is the
 * QUERY STRING (a tab that quietly lists live products instead) and the PATH
 * of the restore write — neither of which a mocked module would notice.
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

/** Every path+query this render asked for, in order. */
const asked = (pathname: string): string[] =>
  calls.filter((c) => c.path.split('?')[0] === pathname).map((c) => c.path);

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
const restorePath = (id: string): string => `${LIST}/${id}/restore`;

function product(id: string, over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id,
    slug: id,
    title: `Spool ${id}`,
    description: null,
    status: 'draft',
    category: 'Fibre',
    tags: [],
    coverImageId: null,
    imageIds: [],
    createdAt: 1_756_000_000_000,
    updatedAt: 1_756_100_000_000,
    publishedAt: null,
    deletedAt: 1_756_200_000_000,
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

async function openTrashTab(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('tab', { name: 'Trash' });
  await user.click(screen.getByRole('tab', { name: 'Trash' }));
}

// ============================================================================

describe('the trash tab on the product list', () => {
  it('offers Trash beside the other four tabs', async () => {
    when(LIST, { items: [], nextCursor: null });
    mount();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Active', 'Draft', 'Archived', 'Trash']);
  });

  it('asks the server for status=trash, which is the only query that returns deleted rows', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a', { title: 'Binned spool' })], nextCursor: null });
    mount();

    await openTrashTab(user);

    // The FIRST list call is the All tab and carries no status at all.
    await waitFor(() => expect(asked(LIST).some((p) => p.includes('status=trash'))).toBe(true));
    expect(asked(LIST)[0]).not.toContain('status=');
  });

  it('restores a ticked row through the lifecycle route', async () => {
    const user = userEvent.setup();
    const binned = product('prod_a', { title: 'Binned spool' });
    when(LIST, { items: [binned], nextCursor: null });
    when(restorePath('prod_a'), { product: { ...binned, deletedAt: null, revision: 2 } });
    mount();

    await openTrashTab(user);
    await screen.findByText('Binned spool');
    await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    await user.click(await screen.findByRole('button', { name: /Restore/ }));

    await waitFor(() => expect(wrote(restorePath('prod_a'), 'POST')).toBe(true));
  });

  it('offers ONLY Restore in the trash — every other bulk action is a no-op on a deleted row', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a', { title: 'Binned spool' })], nextCursor: null });
    mount();

    await openTrashTab(user);
    await screen.findByText('Binned spool');
    await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);

    expect(await screen.findByRole('button', { name: /Restore/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set as draft' })).toBeNull();
    // No overflow menu either: there is nothing else worth offering here.
    expect(screen.queryByRole('button', { name: 'More bulk actions' })).toBeNull();
  });

  it('keeps the ordinary actions on every other tab', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a', { title: 'Live spool', deletedAt: null })], nextCursor: null });
    mount();

    await screen.findByText('Live spool');
    await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);

    expect(await screen.findByRole('button', { name: 'Set as draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More bulk actions' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });
});
