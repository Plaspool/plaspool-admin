import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The variant panel's archive / restore / delete controls (issue #18).
 *
 * The API module is mocked: this is a test about the screen — the routes
 * behind it have their own suite driving real HTTP against a real database
 * (`server/shop/catalog/routes.test.ts`, "deleting a variant").
 */

const api = vi.hoisted(() => ({
  updateVariant: vi.fn(),
  deleteVariant: vi.fn(),
}));

vi.mock('../data/api-shop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/api-shop')>();
  return { ...actual, shopApi: { ...actual.shopApi, ...api } };
});

import { VariantsPanel } from './ShopVariants';
import type { ShopProductDetail, ShopVariant } from '../data/api-shop';

function variant(over: Partial<ShopVariant> = {}): ShopVariant {
  return {
    id: 'var_1',
    productId: 'prd_1',
    sku: 'SKU-1',
    optionValues: { Colour: 'Black' },
    position: 0,
    weightGrams: null,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    price: null,
    available: 0,
    backorderable: false,
    imageId: null,
    colorHex: null,
    everOrdered: false,
    ...over,
  };
}

function product(variants: ShopVariant[]): ShopProductDetail {
  return {
    id: 'prd_1',
    slug: 'prd-1',
    title: 'A Product',
    description: null,
    status: 'draft',
    category: 'filament',
    tags: [],
    coverImageId: null,
    imageIds: [],
    createdAt: 0,
    updatedAt: 0,
    publishedAt: null,
    deletedAt: null,
    authorId: 'u_1',
    revision: 1,
    variants,
  };
}

const draw = (variants: ShopVariant[], onChanged = vi.fn()) => {
  render(
    <MemoryRouter>
      <VariantsPanel product={product(variants)} onChanged={onChanged} />
    </MemoryRouter>,
  );
  return onChanged;
};

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  api.updateVariant.mockResolvedValue(variant({ status: 'discontinued' }));
  api.deleteVariant.mockResolvedValue(variant());
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  confirmSpy.mockRestore();
});

describe('the list', () => {
  it('marks a discontinued variant distinctly, not only in the detail pane', () => {
    draw([variant({ status: 'discontinued' })]);
    // The list row itself carries the word, not just the panel beside it.
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('an active variant carries no such badge', () => {
    draw([variant({ status: 'active' })]);
    expect(screen.queryByText('Archived')).toBeNull();
  });
});

describe('archive and restore', () => {
  it('archives without asking for confirmation', async () => {
    const user = userEvent.setup();
    const onChanged = draw([variant({ status: 'active' })]);

    await user.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => expect(api.updateVariant).toHaveBeenCalledTimes(1));
    expect(api.updateVariant).toHaveBeenCalledWith('var_1', { status: 'discontinued' });
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('restores a discontinued variant, also without confirming', async () => {
    const user = userEvent.setup();
    draw([variant({ status: 'discontinued' })]);

    await user.click(screen.getByRole('button', { name: /^restore$/i }));

    await waitFor(() => expect(api.updateVariant).toHaveBeenCalledTimes(1));
    expect(api.updateVariant).toHaveBeenCalledWith('var_1', { status: 'active' });
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  it('confirms before deleting a never-ordered variant', async () => {
    const user = userEvent.setup();
    const onChanged = draw([variant({ everOrdered: false })]);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.deleteVariant).toHaveBeenCalledWith('var_1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('does not call the API when the confirmation is declined', async () => {
    confirmSpy.mockReturnValue(false);
    const user = userEvent.setup();
    draw([variant({ everOrdered: false })]);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(api.deleteVariant).not.toHaveBeenCalled();
  });

  it('hides Delete entirely for a variant that has ever been ordered', () => {
    draw([variant({ everOrdered: true })]);
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    // Archive is still there — the reversible half stays available.
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeTruthy();
  });
});
