import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The Details panel's category control, after it stopped being a text box.
 *
 * It was `<input list="known-categories">` with a `<datalist>`: the list was a
 * suggestion and anything typed past it became a category. That is how a blog
 * ends up with Technology and Technolgy, with nothing on any screen saying so
 * and no way to merge them afterwards. The cases below are the four things
 * that had to stay true through the replacement:
 *
 *  - a post written before any of this still shows ITS OWN value selected —
 *    the route answers with in-use-but-unmanaged names for exactly this, and
 *    without the pin, opening the panel on such a post would show a blank
 *    control and saving from it would re-file the post silently;
 *  - the list is the blog's, not this browser's cache of it;
 *  - a new name is still possible, but only through a control that says it is
 *    making one;
 *  - none of it depends on `GET /api/categories` existing yet.
 *
 * `../../data/api-categories` is mocked and nothing else is: Dexie, the
 * settings store and the real `Select` all run, because three of these cases
 * are about what a writer can actually reach in the rendered control.
 */

vi.mock('../../data/api-categories', () => ({
  categoriesApi: {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}));

import { categoriesApi } from '../../data/api-categories';
import { db, type CachedListPost } from '../../data/db';
import { setActiveUser, type PostPatch } from '../../data/posts';
import { resetCategories } from '../../data/useCategories';
import { MetaPanel } from '../MetaPanel';
import type { ListPost, Post } from '../../data/types';

const USER = 'u_writer';

/**
 * jsdom ships none of these and Radix needs all four the moment a Select
 * opens — without them this file fails on the click rather than on anything it
 * is about. Copied from `Dashboard.test.tsx`, which needs the same set.
 */
function stubBrowserGaps(): void {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  // The panel is a native <dialog>. jsdom's implementation of the top layer is
  // partial, and `showModal` on an already-open element throws — which turns a
  // re-render into a failure that says nothing about categories.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
}

function post(over: Partial<Post> = {}): Post {
  return {
    id: 'p_1',
    title: 'A title',
    subtitle: '',
    slug: 'a-title',
    excerpt: '',
    excerptSource: 'derived',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    coverImage: null,
    category: '',
    tags: [],
    template: null,
    status: 'draft',
    createdAt: 1,
    updatedAt: 2,
    publishedAt: null,
    deletedAt: null,
    wordCount: 0,
    readingTime: 1,
    authorId: USER,
    authorName: 'A Writer',
    revision: 1,
    ...over,
  };
}

function listRow(over: Partial<ListPost> = {}): CachedListPost {
  const { content: _content, ...rest } = post();
  return { ...rest, ownerUserId: USER, ...over } as CachedListPost;
}

/** The panel, plus the patch its Save button produced. */
function draw(over: Partial<Post> = {}) {
  const patches: PostPatch[] = [];
  render(
    <MetaPanel
      open
      onClose={() => {}}
      post={post(over)}
      onPatch={(p) => {
        patches.push(p);
      }}
    />,
  );
  return patches;
}

const picker = () => screen.getByLabelText('Category for this post');
const save = () => screen.getByRole('button', { name: 'Save details' });

/** Open the picker and choose the item with this exact label. */
async function choose(label: string): Promise<void> {
  await userEvent.click(picker());
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
  await userEvent.click(screen.getByText(label));
}

beforeEach(async () => {
  stubBrowserGaps();
  vi.clearAllMocks();
  resetCategories();
  vi.mocked(categoriesApi.list).mockResolvedValue([]);
  setActiveUser(USER);
  await db.open();
  await db.postList.clear();
});

afterEach(() => {
  cleanup();
});

// ------------------------------------------------------------ the legacy value

describe('a category typed before the list existed', () => {
  it('is still shown as the post’s own, and survives an untouched save', async () => {
    // 45 characters: longer than the 40 the old `commit()` sliced everything
    // to, which would have saved this post under a DIFFERENT category five
    // characters shorter than the one it already had.
    const legacy = 'Long-form essays about typography and print';
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: null, name: legacy, count: 1, managed: false },
    ]);

    const patches = draw({ category: legacy });

    await waitFor(() => expect(picker().textContent).toContain(legacy));
    await userEvent.click(save());

    expect(patches[0].category).toBe(legacy);
  });

  it('is pinned in even when the list has never heard of it', async () => {
    // The route is answering, and answering with something else entirely — the
    // state a legacy value lands in if the union arm ever regresses. A picker
    // that cannot show it renders a blank trigger, and the next save re-files
    // the post under whatever was picked instead.
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: 'c_fiction', name: 'Fiction', count: 2, managed: true },
    ]);

    draw({ category: 'Marginalia' });

    await waitFor(() => expect(picker().textContent).toContain('Marginalia'));
  });
});

// -------------------------------------------------------------- the list itself

describe('the list is the blog’s', () => {
  it('offers a category no cached post carries', async () => {
    await db.postList.put(listRow({ id: 'p_cached', category: 'Notes' }));
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: 'c_fiction', name: 'Fiction', count: 9, managed: true },
    ]);

    draw();
    await userEvent.click(picker());

    // Both halves matter. The name from the server proves the control is not
    // reading Dexie; the absence of the cached-only one proves it is not
    // quietly unioning the two, which would put a category on the list that
    // this device merely happened to have a row for.
    await waitFor(() => expect(screen.getByText('Fiction')).toBeTruthy());
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('falls back to this device’s posts when the route does not answer', async () => {
    await db.postList.bulkPut([
      listRow({ id: 'p_a', category: 'Notes' }),
      listRow({ id: 'p_binned', category: 'Abandoned', deletedAt: 1234 }),
    ]);
    // `GET /api/categories` lands in a parallel workstream and 404s until it
    // does. An empty picker would leave a writer unable to file anything at
    // all on a build where the rest of the app works.
    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('gone'));

    draw();
    await userEvent.click(picker());

    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());
    // Trashed rows are excluded, which is the dashboard's old rule rather than
    // this panel's — filing new work under a name that disappears when the
    // trash is emptied is a trap. `useCategories.test.ts` pins the rule itself.
    expect(screen.queryByText('Abandoned')).toBeNull();
  });
});

// --------------------------------------------------------------- the new name

describe('a name that is not on the list yet', () => {
  it('cannot be typed until the writer says they are making one', async () => {
    draw();

    /*
     * THE POINT OF THE WHOLE CHANGE. There is no text box here: the old
     * `<input list="known-categories">` accepted anything, so "Technolgy"
     * became a category with one keystroke and no screen ever said the blog now
     * had two spellings of one shelf.
     */
    expect(screen.queryByLabelText('New category name')).toBeNull();

    await choose('New category…');

    await waitFor(() => expect(screen.getByLabelText('New category name')).toBeTruthy());
  });

  it('is created on the blog and selected', async () => {
    vi.mocked(categoriesApi.create).mockResolvedValue({
      id: 'c_essays',
      name: 'Essays',
      count: 0,
      managed: true,
    });

    const patches = draw();
    await choose('New category…');

    await userEvent.type(screen.getByLabelText('New category name'), 'Essays');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(categoriesApi.create).toHaveBeenCalledWith('Essays'));
    await waitFor(() => expect(picker().textContent).toContain('Essays'));

    await userEvent.click(save());
    expect(patches[0].category).toBe('Essays');
  });

  it('still files the post when the blog will not register the name', async () => {
    vi.mocked(categoriesApi.list).mockRejectedValue(new Error('gone'));
    vi.mocked(categoriesApi.create).mockRejectedValue(new Error('gone'));

    const patches = draw();
    await choose('New category…');

    await userEvent.type(screen.getByLabelText('New category name'), 'Essays');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    /*
     * What the writer asked for is that this post be filed under this name, and
     * `posts.category` is still the denormalised text column that carries it —
     * so the managed row is the part that can be missing without them losing
     * anything they asked for.
     */
    await waitFor(() => expect(picker().textContent).toContain('Essays'));
    await userEvent.click(save());
    expect(patches[0].category).toBe('Essays');
  });

  it('is abandoned without touching the category when Cancel is used', async () => {
    const patches = draw({ category: 'Fiction' });
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: 'c_fiction', name: 'Fiction', count: 1, managed: true },
    ]);

    await choose('New category…');
    await userEvent.type(screen.getByLabelText('New category name'), 'Essa');
    // Named, not just labelled "Cancel": the panel's footer has one too, and
    // two of them in one dialog is a coin toss for a screen-reader user.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel new category' }));

    expect(categoriesApi.create).not.toHaveBeenCalled();
    await userEvent.click(save());
    expect(patches[0].category).toBe('Fiction');
  });
});

// ------------------------------------------------------------- uncategorised

describe('uncategorised', () => {
  it('is reachable, so a filed post can be un-filed', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValue([
      { id: 'c_fiction', name: 'Fiction', count: 1, managed: true },
    ]);
    const patches = draw({ category: 'Fiction' });
    await waitFor(() => expect(picker().textContent).toContain('Fiction'));

    // Radix refuses an Item with `value=""` and `posts.category = ''` is what
    // uncategorised means on the server, so without the sentinel behind this
    // item there is no way back out of a category from this panel at all.
    await choose('Uncategorised');

    await userEvent.click(save());
    expect(patches[0].category).toBe('');
  });
});
