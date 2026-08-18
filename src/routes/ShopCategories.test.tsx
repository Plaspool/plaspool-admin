import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The categories screen's load-bearing properties:
 *
 *   - a MANAGED row and an UNMANAGED one are visibly different things, and the
 *     unmanaged one offers exactly one action — adopt it — because until then
 *     the storefront has no page for it
 *   - a save sends ONLY what changed, because a resent `name` is a rename and a
 *     rename rewrites every product carrying the value
 *   - a rename reports how many products moved
 *   - deleting a category that is still in use asks where its products go,
 *     rather than making a request the server will refuse
 *   - the two 409s get different words, because the server distinguishes them
 *
 * The API module is mocked: this is a test about the screen, and the routes
 * behind it have their own suite driving real HTTP against a real database
 * (`server/shop/catalog/categories.test.ts`).
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

const api = vi.hoisted(() => ({
  listCategories: vi.fn(),
  createCategory: vi.fn(),
  saveCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));

vi.mock('../data/api-shop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api-shop')>();
  return { ...actual, shopApi: { ...actual.shopApi, ...api } };
});

import ShopCategories from './ShopCategories';
import { ApiError } from '../data/errors';
import type { ShopCategory } from '../data/api-shop';

function managed(over: Partial<ShopCategory> = {}): ShopCategory {
  return {
    id: 'cat_1',
    slug: 'pla',
    name: 'PLA',
    blurb: 'The everyday filament.',
    accentHex: '#1b4fa8',
    position: 0,
    count: 4,
    managed: true,
    ...over,
  };
}

function unmanaged(over: Partial<ShopCategory> = {}): ShopCategory {
  return {
    id: null,
    slug: null,
    name: 'Typed In',
    blurb: '',
    accentHex: null,
    position: 0,
    count: 2,
    managed: false,
    ...over,
  };
}

const draw = () =>
  render(
    <MemoryRouter>
      <ShopCategories />
    </MemoryRouter>,
  );

beforeEach(() => {
  api.listCategories.mockResolvedValue([managed(), unmanaged()]);
  api.createCategory.mockResolvedValue(managed());
  api.saveCategory.mockResolvedValue({ category: managed(), movedProducts: 0 });
  api.deleteCategory.mockResolvedValue({ movedProducts: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the two kinds of row', () => {
  it('shows a managed category with its address and an unmanaged one without', async () => {
    draw();
    expect(await screen.findByText('PLA')).toBeTruthy();
    expect(screen.getByText('/store/pla')).toBeTruthy();

    // The unmanaged row is present, and has no address to show.
    expect(screen.getByText('Typed In')).toBeTruthy();
    expect(screen.queryByText('/store/typed-in')).toBeNull();
  });

  it('offers an unmanaged category exactly one action, and it adopts the name', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('Typed In');

    await user.click(screen.getByRole('button', { name: /add to storefront/i }));

    await waitFor(() => expect(api.createCategory).toHaveBeenCalledTimes(1));
    expect(api.createCategory.mock.calls[0][0]).toMatchObject({ name: 'Typed In' });
  });

  it('says why an unmanaged category is not on the storefront', async () => {
    draw();
    await screen.findByText('Typed In');
    expect(screen.getByText(/no page on the storefront/i)).toBeTruthy();
  });
});

describe('saving', () => {
  /*
   * THE PROPERTY THAT MATTERS MOST HERE. Resending an unchanged `name` is a
   * rename as far as the server is concerned, and a rename rewrites every
   * product carrying the value — so "I only edited the description" must not
   * put `name` in the body.
   */
  it('sends only the fields that actually changed', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const blurb = screen.getByRole('textbox', { name: /description/i });
    await user.clear(blurb);
    await user.type(blurb, 'Reworded.');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.saveCategory).toHaveBeenCalledTimes(1));
    expect(api.saveCategory.mock.calls[0][1]).toEqual({ blurb: 'Reworded.' });
  });

  it('does not call the API at all when nothing changed', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(api.saveCategory).not.toHaveBeenCalled();
  });

  /* "This moved 12 products" is the sentence that stops somebody renaming the
   * wrong row, so it is reported rather than swallowed. */
  it('reports how many products a rename moved', async () => {
    const user = userEvent.setup();
    api.saveCategory.mockResolvedValue({
      category: managed({ name: 'PLA Basic' }),
      movedProducts: 12,
    });
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const name = screen.getByRole('textbox', { name: /^name$/i });
    await user.clear(name);
    await user.type(name, 'PLA Basic');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/12 products moved/i)).toBeTruthy();
  });

  it('clears the tint by sending null, which is not the same as leaving it alone', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^clear$/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.saveCategory).toHaveBeenCalledTimes(1));
    expect(api.saveCategory.mock.calls[0][1]).toEqual({ accentHex: null });
  });
});

describe('deleting', () => {
  /* The server refuses a category still in use, and it is right to. Asking the
   * question the refusal would ask is better than making the request. */
  it('asks where the products should go when the category is in use', async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Somewhere Else');
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(prompt).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteCategory).toHaveBeenCalledWith('cat_1', 'Somewhere Else'));
    prompt.mockRestore();
  });

  it('does not delete when the question is cancelled', async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(api.deleteCategory).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  /* Nothing uses it, so there is nowhere for anything to go — a confirm, not a
   * prompt, and `reassign` stays undefined. */
  it('only confirms when nothing uses the category', async () => {
    const user = userEvent.setup();
    api.listCategories.mockResolvedValue([managed({ count: 0 })]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.deleteCategory).toHaveBeenCalledWith('cat_1', undefined));
    confirm.mockRestore();
  });
});

describe('the two conflicts get different words', () => {
  it('explains a duplicate name as a naming collision', async () => {
    const user = userEvent.setup();
    api.createCategory.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'precondition_failed',
        body: { operation: 'create', category: managed({ name: 'PLA' }) },
      }),
    );
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /new category/i }));
    await user.type(screen.getByRole('textbox', { name: /^name$/i }), 'pla');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    expect(screen.getByText(/matched without case/i)).toBeTruthy();
  });

  it('explains a refused delete as products still using it', async () => {
    const user = userEvent.setup();
    api.deleteCategory.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'precondition_failed',
        body: { operation: 'delete', category: managed({ count: 7 }) },
      }),
    );
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('');
    draw();
    await screen.findByText('PLA');

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/7 products still use this category/i)).toBeTruthy();
    prompt.mockRestore();
  });
});

describe('loading and failure', () => {
  it('offers a retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    api.listCategories.mockRejectedValueOnce(new Error('down'));
    draw();

    expect(await screen.findByRole('alert')).toBeTruthy();
    api.listCategories.mockResolvedValue([managed()]);
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('PLA')).toBeTruthy();
  });
});
