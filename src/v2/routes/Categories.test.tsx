import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * ADDING A CATEGORY.
 *
 * The button raised a toast saying this was "coming with the new product
 * editor". It was not coming: `POST /shop/admin/categories` and
 * `shopApi.createCategory` had both existed the whole time, so the only thing
 * missing was the form — the kind of gap a screenshot finds and a green suite
 * never does.
 *
 * What these pin is the WIRE, for the reason the rewards suite gives: the
 * path, the method and the body key by key are the three things most likely to
 * be quietly wrong against a backend written in another session, and a mocked
 * module asserts none of them.
 *
 * The second test is the interesting one. A name already in use as free text
 * on products comes back 201 with those products already counted — "adopt the
 * category I have been typing onto products" and "create a new one" are the
 * same request — and a category that arrives owning six products reads as a
 * bug unless the screen says why.
 */

import { ToastHost } from '../ui/Toast';
import type { ShopCategory } from '../../data/api-shop';
import Categories from './Categories';

/* jsdom gaps the v2 chrome touches — the same blocks every v2 suite carries. */
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

/** Every body sent to this exact path with this method, oldest first. */
const bodiesOf = (pathname: string, method: string): Record<string, unknown>[] =>
  calls
    .filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

/** GETs of exactly this path — the re-read counter. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

// -------------------------------------------------------------- the harness

const CATEGORIES = '/api/shop/admin/categories';

const filament: ShopCategory = {
  id: 'cat_1',
  slug: 'filament',
  name: 'Filament',
  blurb: 'Spools of the stuff',
  accentHex: '1b4fa8',
  position: 0,
  count: 3,
  managed: true,
};

/** The modal's own submit, not the page header's button of the same name. */
const inModal = (name: string) =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/products/categories']}>
        <Categories />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('adding a category', () => {
  it('posts the name, blurb and tint, then re-reads the list', async () => {
    const user = userEvent.setup();
    when(CATEGORIES, (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [filament] } };
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        status: 201,
        body: {
          category: {
            ...filament,
            id: 'cat_2',
            slug: 'resin',
            name: body.name as string,
            blurb: body.blurb as string,
            count: 0,
          },
        },
      };
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Resin');
    await user.type(screen.getByLabelText('Short description'), 'For the messy printers');
    await user.click(inModal('Add category'));

    await waitFor(() => expect(bodiesOf(CATEGORIES, 'POST')).toHaveLength(1));
    const body = bodiesOf(CATEGORIES, 'POST')[0]!;
    expect(body.name).toBe('Resin');
    expect(body.blurb).toBe('For the messy printers');
    /* No tint chosen is a real answer, and `null` is how the API spells it. */
    expect(body.accentHex).toBeNull();
    /* NO SLUG ON THE WIRE. The server allocates it, because a published URL is
       a promise and moving it is a separate, deliberate act. */
    expect('slug' in body).toBe(false);

    /* The new row has to appear without the person reloading the page. */
    await waitFor(() => expect(reads(CATEGORIES)).toBe(2));
  });

  it('says so when the name was already in use, and brings its products with it', async () => {
    const user = userEvent.setup();
    when(CATEGORIES, (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [] } };
      return {
        status: 201,
        body: { category: { ...filament, id: 'cat_9', name: 'Nozzles', count: 6 } },
      };
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Nozzles');
    await user.click(inModal('Add category'));

    expect(await screen.findByText(/its 6 products came with it/)).toBeTruthy();
  });

  it('will not post a blank name', async () => {
    const user = userEvent.setup();
    when(CATEGORIES, { items: [] });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.click(inModal('Add category'));

    expect(screen.getByText('Give the category a name.')).toBeTruthy();
    expect(bodiesOf(CATEGORIES, 'POST')).toHaveLength(0);
  });

  it('shows a refusal rather than pretending it worked', async () => {
    const user = userEvent.setup();
    when(CATEGORIES, (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [] } };
      return {
        status: 409,
        body: { error: 'category_exists', message: 'That one already exists.' },
      };
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Filament');
    await user.click(inModal('Add category'));

    /* Still open, with the typing intact — a refusal must not discard work. */
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Filament');
    expect(reads(CATEGORIES)).toBe(1);
  });
});
