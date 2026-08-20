import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The featured manager.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE CLAIMS, EACH ONE A SCREENSHOT CANNOT MAKE.
 *
 *  - **The four SLOTS are visible, not just the posts in them.** The cap is the
 *    one thing about this screen an operator cannot change and the one thing
 *    they most need to understand. Drawn as a list that happens to be short, it
 *    would have to be inferred from a counter.
 *  - **A reorder posts the WHOLE list.** Invariant 4 of the storefront's
 *    contract. A single-row PATCH would leave two posts sharing a rank at some
 *    point in every swap, and nothing on screen would show it.
 *  - **A refused reorder reverts.** The list moves first so the drag feels
 *    immediate; if the server says no, what is on screen must stop being a lie.
 *  - **A writer sees the rail and cannot change it.** The server is owner-only,
 *    so controls in front of a 403 would be a form that cannot be submitted.
 *  - **An unreadable rail is not an empty one.** There is nothing cached to
 *    fall back to, so "0 of 4" for a dropped connection would invite an
 *    operator to feature a post that is already featured.
 * ═══════════════════════════════════════════════════════════════════════════
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

// `StoredImg` reaches for IndexedDB and object URLs; neither is what this
// screen is about, and a broken cover must never take a card down with it.
vi.mock('../components/StoredImg', () => ({
  StoredImg: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

import { ToastProvider } from '../components/Toast';
import { api } from '../data/api';
import { FeaturedConflictError } from '../data/errors';
import { resetFeatured } from '../data/useFeatured';
import Featured from './Featured';
import type { FeaturedItem } from '../data/types';

const item = (id: string, rank: number, title = id.toUpperCase()): FeaturedItem => ({
  id,
  slug: id,
  title,
  coverImage: null,
  publishedAt: 1,
  rank,
});

function draw() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Featured />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The cards, in the order they are on screen. */
function titles(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((li) => within(li).queryByRole('link')?.textContent ?? '')
    .filter((text) => text !== '');
}

beforeEach(() => {
  resetFeatured();
  fixture.session.user.role = 'owner';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the rail', () => {
  it('draws every slot, filled or not', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
    draw();

    await screen.findByText('P_A');
    // Four slots for four ranks. One card and three invitations, so "one of
    // four" is something you can SEE rather than something you work out.
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(await screen.findByText(/1 of 4 featured/)).toBeTruthy();
  });

  it('says what an empty rail means for the blog', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
    draw();

    // The storefront falls back to the newest posts when nothing is curated, so
    // an empty rail is not a broken page — but only this sentence says so.
    expect(await screen.findByText(/leads with its newest posts/i)).toBeTruthy();
  });

  it('distinguishes an unreadable rail from an empty one', async () => {
    vi.spyOn(api, 'listFeatured').mockRejectedValue(new Error('offline'));
    draw();

    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    // And it does NOT claim four empty slots, which would read as "nothing is
    // featured" for a request that never got an answer.
    expect(screen.queryByText(/leads with its newest posts/i)).toBeNull();
  });
});

describe('reordering', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([
      item('p_a', 1),
      item('p_b', 2),
      item('p_c', 3),
    ]);
  });

  it('posts the whole list, in the new order', async () => {
    const reorder = vi
      .spyOn(api, 'reorderFeatured')
      .mockResolvedValue([item('p_b', 1), item('p_a', 2), item('p_c', 3)]);
    draw();
    await screen.findByText('P_A');

    await userEvent.click(screen.getByLabelText('Move P_B up'));

    // EVERY id, not the one that moved. Invariant 4 — the server rewrites all
    // the ranks in one statement and cannot do that from a single row.
    await waitFor(() => {
      expect(reorder).toHaveBeenCalledWith(['p_b', 'p_a', 'p_c']);
    });
  });

  it('moves the card before the server answers', async () => {
    let settle: (items: FeaturedItem[]) => void = () => {};
    vi.spyOn(api, 'reorderFeatured').mockReturnValue(
      new Promise<FeaturedItem[]>((resolve) => {
        settle = resolve;
      }),
    );
    draw();
    await screen.findByText('P_A');

    await userEvent.click(screen.getByLabelText('Move P_B up'));

    // A drag that waited for a round trip before the card moved would feel
    // broken, so the order is applied locally first.
    await waitFor(() => expect(titles()).toEqual(['P_B', 'P_A', 'P_C']));
    settle([item('p_b', 1), item('p_a', 2), item('p_c', 3)]);
  });

  it('puts the card back when the server refuses', async () => {
    vi.spyOn(api, 'reorderFeatured').mockRejectedValue(new Error('nope'));
    draw();
    await screen.findByText('P_A');

    await userEvent.click(screen.getByLabelText('Move P_B up'));

    // What is on screen must stop being a lie. An optimistic order that stayed
    // after a failure is a rail the operator believes they curated.
    await waitFor(() => expect(titles()).toEqual(['P_A', 'P_B', 'P_C']));
    expect(await screen.findByText(/could not be saved/i)).toBeTruthy();
  });

  it('adopts the truth a 409 carries rather than the order it tried', async () => {
    const truth = [item('p_c', 1), item('p_a', 2)];
    vi.spyOn(api, 'reorderFeatured').mockRejectedValue(
      new FeaturedConflictError('featured_stale', truth, 4),
    );
    draw();
    await screen.findByText('P_A');

    await userEvent.click(screen.getByLabelText('Move P_B up'));

    // The refusal is also an answer: the server sends the current rail with
    // every `featured_stale` precisely so this screen can re-render from it
    // instead of asking again and hoping.
    await waitFor(() => expect(titles()).toEqual(['P_C', 'P_A']));
  });

  it('cannot move the first card up or the last one down', async () => {
    draw();
    await screen.findByText('P_A');
    expect(screen.getByLabelText('Move P_A up').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Move P_C down').hasAttribute('disabled')).toBe(true);
  });
});

describe('removing', () => {
  it('takes the post off the rail and says so', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1), item('p_b', 2)]);
    const unfeature = vi.spyOn(api, 'unfeaturePost').mockResolvedValue([item('p_b', 2)]);
    draw();
    await screen.findByText('P_A');

    await userEvent.click(
      screen.getByLabelText('Remove P_A from the featured rail'),
    );

    await waitFor(() => expect(unfeature).toHaveBeenCalledWith('p_a'));
    // The RANK IS NOT COMPACTED: P_B keeps rank 2, and the screen still draws
    // four slots. Gaps are legal and closing them would rewrite a row nobody
    // touched.
    await waitFor(() => expect(titles()).toEqual(['P_B']));
  });
});

describe('a writer', () => {
  beforeEach(() => {
    fixture.session.user.role = 'writer';
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1)]);
  });

  it('sees the rail', async () => {
    draw();
    expect(await screen.findByText('P_A')).toBeTruthy();
  });

  it('is given no controls, rather than controls that 403', async () => {
    draw();
    await screen.findByText('P_A');

    // ABSENT, not disabled. A disabled control advertises a capability and then
    // refuses it; the sentence below says who has it instead.
    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
    expect(screen.queryByLabelText(/^Move /)).toBeNull();
    expect(screen.getByText(/only the blog’s owner/i)).toBeTruthy();
  });
});
