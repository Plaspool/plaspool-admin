import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The moderation queue's four load-bearing properties:
 *
 *   - a decision REMOVES the review from the list it was made in, because the
 *     list is a filter on status and the review no longer matches it
 *   - delete is owner-only in the UI as well as at the server, and absent
 *     rather than disabled for a writer
 *   - the filters live in the URL, so a filtered queue is a shareable link
 *   - the review's own text is never edited, only its status
 *
 * The API module is mocked: this is a test about the screen, and the routes
 * behind it have their own suite driving real HTTP against a real database.
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
  listReviews: vi.fn(),
  moderateReview: vi.fn(),
  destroyReview: vi.fn(),
}));

vi.mock('../data/api-reviews', () => api);

import ShopReviews from './ShopReviews';
import type { AdminReview } from '../data/api-reviews';

const NOW = 1_780_000_000_000;

function review(over: Partial<AdminReview> = {}): AdminReview {
  return {
    id: 'rev_1',
    productSlug: 'pla-basic',
    rating: 4,
    title: 'Solid everyday spool',
    body: 'Prints clean with no stringing. Layer adhesion is strong.',
    authorName: 'Dara',
    authorEmail: 'dara@example.com',
    customerId: null,
    orderId: null,
    status: 'pending',
    sentimentLabel: 'positive',
    sentimentScore: 3,
    createdAt: NOW,
    updatedAt: NOW,
    moderatedAt: null,
    moderatedBy: null,
    ...over,
  };
}

function mount(initialPath = '/shop/reviews') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ShopReviews />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fixture.session.user.role = 'owner';
  api.listReviews.mockReset().mockResolvedValue({ items: [review()], nextCursor: null });
  api.moderateReview.mockReset().mockResolvedValue(review({ status: 'approved' }));
  api.destroyReview.mockReset().mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('the queue', () => {
  it('opens on pending and shows the whole review, not a summary', async () => {
    mount();
    await screen.findByText('Solid everyday spool');

    expect(api.listReviews).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
    // The body is present in full — nothing here truncates it.
    expect(
      screen.getByText('Prints clean with no stringing. Layer adhesion is strong.'),
    ).toBeTruthy();
    // Staff see the email; the public projection cannot return it at all.
    expect(screen.getByText('dara@example.com')).toBeTruthy();
  });

  it('drops a review out of the list once it is moderated', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Solid everyday spool');

    await user.click(screen.getByRole('button', { name: 'Approved' }));

    await waitFor(() => {
      expect(api.moderateReview).toHaveBeenCalledWith('rev_1', 'approved');
    });
    // It no longer matches the filter it was listed under, so it leaves.
    await waitFor(() => {
      expect(screen.queryByText('Solid everyday spool')).toBeNull();
    });
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
  });

  it('offers every status except the one the review already has', async () => {
    api.listReviews.mockResolvedValue({
      items: [review({ status: 'flagged' })],
      nextCursor: null,
    });
    mount('/shop/reviews?status=flagged');
    await screen.findByText('Solid everyday spool');

    const card = screen.getByRole('article');
    expect(within(card).queryByRole('button', { name: 'Flagged' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Approved' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Rejected' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Return to pending' })).toBeTruthy();
  });

  it('reads its filters from the URL', async () => {
    mount('/shop/reviews?status=rejected&sentiment=negative&product=petg-cf');
    await waitFor(() => {
      expect(api.listReviews).toHaveBeenCalledWith({
        status: 'rejected',
        sentiment: 'negative',
        product: 'petg-cf',
      });
    });
  });

  it('surfaces a failed load with a way to retry', async () => {
    api.listReviews.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    mount();

    await screen.findByRole('alert');
    api.listReviews.mockResolvedValue({ items: [review()], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Solid everyday spool')).toBeTruthy();
  });
});

describe('delete', () => {
  it('is offered to an owner and confirms before acting', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    mount();
    await screen.findByText('Solid everyday spool');

    await user.click(screen.getByRole('button', { name: /Delete/ }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(api.destroyReview).toHaveBeenCalledWith('rev_1'));
    confirm.mockRestore();
  });

  it('does nothing when the confirmation is dismissed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    mount();
    await screen.findByText('Solid everyday spool');

    await user.click(screen.getByRole('button', { name: /Delete/ }));
    expect(api.destroyReview).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('is absent for a writer rather than offered and refused', async () => {
    fixture.session.user.role = 'writer';
    mount();
    await screen.findByText('Solid everyday spool');

    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    // A writer can still do the job the queue exists for.
    expect(screen.getByRole('button', { name: 'Approved' })).toBeTruthy();
  });
});
