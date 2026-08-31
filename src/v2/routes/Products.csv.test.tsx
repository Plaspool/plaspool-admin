import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The product list's CSV EXPORT and IMPORT modals, and only those — the
 * things a mocked api module cannot vouch for:
 *
 *  - **Export** posts to the real path and renders the SERVER'S answer — the
 *    row count, the emailed status and the tokened URL — rather than anything
 *    invented client-side.
 *  - **Import** is two round trips with the same csv text: a preview the
 *    moment a file is chosen, then an apply, both carrying `replace` exactly
 *    as the checkbox stands — asserted key by key on the request bodies,
 *    because a body that silently dropped `replace: false` would overwrite
 *    products the operator asked to keep.
 *
 * `fetch` is stubbed, not `../../data/api-shop-csv` — the harness is
 * `Products.bulk-tags.test.tsx`'s, copied.
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
/* The import modal reads the chosen file with File#text; some jsdom builds
   ship Blob without it. FileReader exists everywhere jsdom runs. */
if (typeof File.prototype.text !== 'function') {
  File.prototype.text = function text(this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsText(this);
    });
  };
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

/** Every body sent to a path with this method, in order. */
function bodies(pathname: string, method: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
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
const EXPORT = '/api/shop/admin/products/export';
const IMPORT = '/api/shop/admin/products/import';

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

async function openMenuItem(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByText('Spool prod_a');
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

const CSV_TEXT =
  'Handle,Title,Status,Category,Tags,Description,Overview,SEO Title,SEO Description,' +
  'Variant SKU,Variant Options,Variant Price,Variant Compare At Price,Variant Cost,' +
  'Variant Stock,Variant Backorderable\n' +
  'amber,Amber Spool,active,Fibre,pla,Nice.,,,AMB-1,,23500.00,,,5,true\n';

function csvFile(): File {
  return new File([CSV_TEXT], 'products.csv', { type: 'text/csv' });
}

// ============================================================================

describe('CSV export and import on the product list', () => {
  it('the export modal posts to the export route and shows the count and download link', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a')], nextCursor: null });
    const url =
      'https://studio.test/api/shop/admin/products/exports/exp_1/download?token=tok_123';
    when(EXPORT, {
      export: { id: 'exp_1', rowCount: 7, url },
      emailed: true,
    });
    mount();

    await openMenuItem(user, 'Export…');
    await screen.findByText(/download link goes to/);
    await user.click(screen.getByRole('button', { name: 'Email me the export' }));

    expect(await screen.findByText('7 rows exported.')).toBeTruthy();
    expect(screen.getByText(/on its way to your inbox/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Download now' });
    expect(link.getAttribute('href')).toBe(url);
    expect(wrote(EXPORT, 'POST')).toBe(true);
  });

  it('import previews on file choice, then applies — both carrying the typed csv and replace:true', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a')], nextCursor: null });
    when(IMPORT, (_url, init) => {
      const body = JSON.parse(String(init.body)) as { mode: string };
      return body.mode === 'preview'
        ? {
            body: {
              creates: 1,
              updates: 2,
              invalid: [{ line: 4, problem: 'bad Variant Price "abc"' }],
              total: 4,
            },
          }
        : { body: { applied: true, created: 1, updated: 2, skipped: 0, invalid: [] } };
    });
    mount();

    await openMenuItem(user, 'Import…');
    await user.upload(screen.getByLabelText('CSV file'), csvFile());

    // The preview is the SERVER'S counts, problems included.
    await screen.findByText('1 new · 2 to update · 1 row with problems');
    expect(screen.getByText('Row 4: bad Variant Price "abc"')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Import products' }));
    await waitFor(() => expect(bodies(IMPORT, 'POST')).toHaveLength(2));

    expect(bodies(IMPORT, 'POST')).toEqual([
      { csv: CSV_TEXT, mode: 'preview', replace: true },
      { csv: CSV_TEXT, mode: 'apply', replace: true },
    ]);
    // The toast reports what the server did, and the table reloads.
    expect(await screen.findByText('1 created · 2 updated')).toBeTruthy();
  });

  it('unticking the replace checkbox sends replace:false on preview and apply alike', async () => {
    const user = userEvent.setup();
    when(LIST, { items: [product('prod_a')], nextCursor: null });
    when(IMPORT, (_url, init) => {
      const body = JSON.parse(String(init.body)) as { mode: string };
      return body.mode === 'preview'
        ? { body: { creates: 0, updates: 1, invalid: [], total: 1 } }
        : { body: { applied: true, created: 0, updated: 0, skipped: 1, invalid: [] } };
    });
    mount();

    await openMenuItem(user, 'Import…');
    await user.click(
      screen.getByRole('checkbox', { name: /Replace products with the same handle/ }),
    );
    await user.upload(screen.getByLabelText('CSV file'), csvFile());
    await screen.findByText('0 new · 1 to update · 0 rows with problems');

    await user.click(screen.getByRole('button', { name: 'Import products' }));
    await waitFor(() => expect(bodies(IMPORT, 'POST')).toHaveLength(2));

    expect(bodies(IMPORT, 'POST')).toEqual([
      { csv: CSV_TEXT, mode: 'preview', replace: false },
      { csv: CSV_TEXT, mode: 'apply', replace: false },
    ]);
    expect(await screen.findByText('0 created · 0 updated · 1 skipped')).toBeTruthy();
  });
});
