import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The editor's "Featured" switch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR CLAIMS.
 *
 *  - **A draft's switch is DISABLED and says why.** The server answers 422, so
 *    a switch that flipped and then apologised would be teaching a rule the
 *    interface already knew. This is the storefront contract's admin-UI item 1.
 *  - **The counter is live and comes from the same list the manager draws.**
 *    Derived separately it would be the thing that says "3 of 4" beside a
 *    toggle that has just been refused.
 *  - **The fifth is an OFFER.** A 409 carries the current four; the dialog
 *    lists them and picking one sends `replace`, which is one statement server
 *    side — so the rail is never three posts long in between.
 *  - **An already-featured post can always be un-featured.** Whatever state it
 *    is in. Gating that on "is it publishable" would strand a post on the rail
 *    with no way to take it off.
 * ═══════════════════════════════════════════════════════════════════════════
 */

vi.mock('../data/session', () => ({
  getSession: () => ({ status: 'unknown' }),
  subscribe: () => () => {},
}));

import { ToastProvider } from './Toast';
import { TooltipProvider } from './ui/Switch';
import { FeatureToggle } from './FeatureToggle';
import { api } from '../data/api';
import { FeaturedConflictError, NotFeaturableError } from '../data/errors';
import { resetFeatured } from '../data/useFeatured';
import type { AuthUser, FeaturedItem, Post } from '../data/types';

const OWNER: AuthUser = {
  id: 'u_owner',
  email: 'o@test.local',
  displayName: 'An Owner',
  role: 'owner',
};

const WRITER: AuthUser = { ...OWNER, id: 'u_writer', role: 'writer' };

const post = (over: Partial<Post> = {}): Post => ({
  id: 'p_1',
  title: 'A title',
  subtitle: '',
  slug: 'a-title',
  excerpt: '',
  excerptSource: 'derived',
  content: { type: 'doc', content: [] },
  coverImage: null,
  category: '',
  tags: [],
  template: null,
  status: 'published',
  createdAt: 1,
  updatedAt: 2,
  publishedAt: 3,
  deletedAt: null,
  wordCount: 1,
  readingTime: 1,
  authorId: 'u_owner',
  authorName: 'An Owner',
  revision: 1,
  ...over,
});

const item = (id: string, rank: number): FeaturedItem => ({
  id,
  slug: id,
  title: id.toUpperCase(),
  coverImage: null,
  publishedAt: 1,
  rank,
});

function draw(p: Post | null, user: AuthUser = OWNER) {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <FeatureToggle post={p} user={user} />
      </ToastProvider>
    </TooltipProvider>,
  );
}

const theSwitch = () => screen.getByRole('switch', { name: 'Feature this post' });

/**
 * jsdom has no `HTMLDialogElement.showModal` — measured in this environment,
 * not assumed. `Dialog` calls it from an effect, so without this shim the swap
 * dialog throws during commit, React tears the tree down, and the two cases
 * below fail with an empty document for a reason that has nothing to do with
 * the component. Same shim, and the same argument for patching the PROTOTYPE
 * rather than the instance, as `RequireAuth.test.tsx`.
 */
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

beforeEach(() => {
  resetFeatured();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the counter', () => {
  it('reads n of 4 from the rail', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_a', 1), item('p_b', 2)]);
    draw(post());
    expect(await screen.findByText('2 of 4')).toBeTruthy();
  });

  it('says nothing rather than zero when the rail could not be read', async () => {
    vi.spyOn(api, 'listFeatured').mockRejectedValue(new Error('offline'));
    draw(post());
    // "0 of 4" for a dropped connection would invite an operator to feature a
    // post that is already featured, and then be refused for no visible reason.
    expect(await screen.findByText('— of 4')).toBeTruthy();
  });
});

describe('a post that cannot be featured', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
  });

  it('disables the switch for a draft', async () => {
    draw(post({ status: 'draft', publishedAt: null }));
    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(true));
  });

  it('disables the switch for a post in the trash', async () => {
    // Trash is a VIEW, not a status: this row still reads `published`. A check
    // written as `status !== 'published'` would leave the switch live.
    draw(post({ deletedAt: 4 }));
    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(true));
  });

  it('disables the switch for a writer, whose every attempt would 403', async () => {
    draw(post(), WRITER);
    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(true));
  });

  it('never sends the request', async () => {
    const feature = vi.spyOn(api, 'featurePost');
    draw(post({ status: 'draft', publishedAt: null }));
    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(true));
    await userEvent.click(theSwitch());
    expect(feature).not.toHaveBeenCalled();
  });
});

describe('featuring', () => {
  it('sends the request and adopts the answer', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
    const feature = vi
      .spyOn(api, 'featurePost')
      .mockResolvedValue([{ ...item('p_1', 1), title: 'A title' }]);
    draw(post());

    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(false));
    await userEvent.click(theSwitch());

    await waitFor(() => expect(feature).toHaveBeenCalledWith('p_1', undefined));
    // The response IS the new rail, so the counter moves without a second GET.
    expect(await screen.findByText('1 of 4')).toBeTruthy();
  });

  it('un-features an already-featured post whatever state it is in', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([item('p_1', 1)]);
    const unfeature = vi.spyOn(api, 'unfeaturePost').mockResolvedValue([]);
    // Archived AND featured — a state invariant 3 makes unreachable through the
    // app, but which a backfill could produce. Gating the switch on "is it
    // publishable" would strand it on the rail with no way off.
    draw(post({ status: 'archived' }));

    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(false));
    await userEvent.click(theSwitch());
    await waitFor(() => expect(unfeature).toHaveBeenCalledWith('p_1'));
  });

  it('shows the 422 reason rather than a generic failure', async () => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue([]);
    vi.spyOn(api, 'featurePost').mockRejectedValue(new NotFeaturableError('no_slug'));
    // A state the client cannot see for itself — the switch is enabled, and
    // only the server knows the slug is missing.
    draw(post());

    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(false));
    await userEvent.click(theSwitch());
    expect(await screen.findByText(/no address yet/i)).toBeTruthy();
  });
});

describe('the fifth', () => {
  const four = [item('p_a', 1), item('p_b', 2), item('p_c', 3), item('p_d', 4)];

  beforeEach(() => {
    vi.spyOn(api, 'listFeatured').mockResolvedValue(four);
  });

  it('offers a swap instead of an error, listing the current four', async () => {
    vi.spyOn(api, 'featurePost').mockRejectedValue(
      new FeaturedConflictError('featured_full', four, 4),
    );
    draw(post());

    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(false));
    await userEvent.click(theSwitch());

    // The list comes from the REFUSAL, not a fresh request, so the offer
    // describes the state that actually refused the call.
    expect(await screen.findByText(/Only 4 posts can be featured/i)).toBeTruthy();
    for (const name of ['P_A', 'P_B', 'P_C', 'P_D']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('swaps in place through `replace`, not through unfeature-then-feature', async () => {
    const feature = vi
      .spyOn(api, 'featurePost')
      .mockRejectedValueOnce(new FeaturedConflictError('featured_full', four, 4))
      .mockResolvedValueOnce(four);
    const unfeature = vi.spyOn(api, 'unfeaturePost');
    draw(post());

    await waitFor(() => expect(theSwitch().hasAttribute('disabled')).toBe(false));
    await userEvent.click(theSwitch());
    await screen.findByText('P_C');
    await userEvent.click(screen.getByText('P_C'));

    // ONE call carrying `replace`. Two calls would leave the live rail three
    // posts long in between, and would lose the position the operator chose.
    await waitFor(() => expect(feature).toHaveBeenLastCalledWith('p_1', 'p_c'));
    expect(unfeature).not.toHaveBeenCalled();
  });
});
