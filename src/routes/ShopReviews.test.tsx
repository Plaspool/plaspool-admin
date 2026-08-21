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
import { UNRENDERABLE } from '../data/when';

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

/**
 * THE QUEUE SURVIVES A DATE IT CANNOT READ.
 *
 * `createdAt` is NOT NULL in the schema, so nothing below is a live bug today —
 * which is exactly the state `/shop/orders` was in the week before it went
 * down. The field that killed that screen was NOT NULL too; what reached the
 * formatter was a client type asserting a shape the server does not send, and
 * no column constraint has anything to say about that. These cases pin the
 * DOWNGRADE rather than the column: whatever arrives, a moderator keeps the
 * queue.
 */
describe('a review whose timestamps are broken', () => {
  it('costs the date and not the screen', async () => {
    api.listReviews.mockResolvedValue({
      items: [review({ createdAt: undefined as unknown as number })],
      nextCursor: null,
    });

    mount();

    // The review is still readable and still moderatable, which is the point:
    // the decision this screen exists for does not depend on the date.
    await screen.findByText('Solid everyday spool');
    expect(screen.getByText('Prints clean with no stringing. Layer adhesion is strong.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved' })).toBeTruthy();

    expect(screen.getByText(UNRENDERABLE)).toBeTruthy();
  });

  /*
   * `datetime=""` IS NOT THE SAME REPAIR AS `––`, AND BOTH ARE NEEDED.
   * `new Date(undefined).toISOString()` throws the same `RangeError` the visible
   * formatter does, so a screen that downgraded only the text would still have
   * died on the attribute beside it — the "repair that looks finished and is
   * not" that `api-shop.ts` warns about one value across. `isoAttr` returns
   * `undefined` so React omits the attribute entirely: an empty `datetime` is a
   * machine-readable claim that parses to nothing, and `<time>` with no
   * `datetime` is HTML's own way of saying the text is all there is.
   */
  it('omits the datetime attribute rather than writing an empty one', async () => {
    api.listReviews.mockResolvedValue({
      items: [review({ createdAt: Number.NaN })],
      nextCursor: null,
    });

    mount();
    await screen.findByText('Solid everyday spool');

    const time = document.querySelector('time');
    expect(time).toBeTruthy();
    expect(time?.hasAttribute('datetime')).toBe(false);
  });

  it('keeps a good date good while the broken one beside it downgrades', async () => {
    // The downgrade is PER VALUE. A screen that blanked every date on one bad
    // row would be a different bug wearing the same placeholder.
    api.listReviews.mockResolvedValue({
      items: [
        review({ status: 'approved', moderatedAt: undefined as unknown as number }),
      ],
      nextCursor: null,
    });

    mount('/shop/reviews?status=approved');
    await screen.findByText('Solid everyday spool');

    const times = [...document.querySelectorAll('time')];
    expect(times).toHaveLength(2); // written, and the decision
    expect(times.filter((t) => t.textContent === UNRENDERABLE)).toHaveLength(1);
    expect(times.filter((t) => t.hasAttribute('datetime'))).toHaveLength(1);
  });
});
