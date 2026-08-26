import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The moderation queue, pinned on the two things it can get wrong quietly
 * (CLAUDE.md's ledger for this screen):
 *
 *  - **Destroy is ABSENT for a writer, not disabled.** `DELETE /shop/reviews/:id`
 *    is owner-only at the server, so drawing the button for a writer is a
 *    control in front of a 403. The owner still gets it — asserted in the same
 *    test, or the writer half passes vacuously on a modal that never renders
 *    the footer at all.
 *  - **Moderation only ever moves status.** The rating, the words and the
 *    sentiment are the customer's; an admin surface that could rewrite a review
 *    would make every review on the site unciteable (the API module's own
 *    words). So the PATCH body is asserted KEY BY KEY — `{ status }` and
 *    structurally nothing else — for both verbs, approve and reject.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-reviews`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session, and
 * a mocked module asserts none of them.
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

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { ToastHost } from '../ui/Toast';
import type { AdminReview, ReviewStatus } from '../../data/api-reviews';
import Reviews from './Reviews';

/**
 * What jsdom does not implement and the shared table/menu chrome needs the
 * moment it mounts — the same three blocks `MarketingRewards.test.tsx` and the
 * returns suites carry, plus the `<dialog>` shim for parity with them.
 */
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

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
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

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  fixture.session.user.role = 'owner';
});

// -------------------------------------------------------------- the harness

const REVIEWS = '/api/shop/reviews';

const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);

const pendingReview: AdminReview = {
  id: 'rev_1',
  productSlug: 'recycled-filament',
  rating: 4,
  title: 'Great product',
  body: 'Strong and consistent — no snapping mid-print.',
  authorName: 'Ada Obi',
  authorEmail: 'ada@test.local',
  customerId: 'cus_1',
  orderId: 'ord_1',
  status: 'pending',
  sentimentLabel: 'positive',
  sentimentScore: 3,
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  moderatedAt: null,
  moderatedBy: null,
};

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/products/reviews']}>
        <Reviews />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Open the review's modal by clicking its row — the title is plain text, so
 *  the row's own click handler (which ignores real controls) takes it. */
async function openModal(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByText(pendingReview.title!));
  return screen.findByRole('dialog', { name: pendingReview.title! });
}

// ============================================================================

describe('the reviews queue', () => {
  it('offers destroy to the owner and never to a writer', async () => {
    const user = userEvent.setup();
    when(REVIEWS, { items: [pendingReview], nextCursor: null });
    mount();

    /* The owner half first — without it, the writer half would pass against a
       modal that renders no footer at all. */
    const asOwner = await openModal(user);
    expect(within(asOwner).getByRole('button', { name: 'Delete review' })).toBeTruthy();

    cleanup();
    fixture.session.user.role = 'writer';
    mount();

    const asWriter = await openModal(user);
    /* ABSENT, not disabled: the server answers 403 and a disabled button is a
       promise nobody can keep. */
    expect(within(asWriter).queryByRole('button', { name: 'Delete review' })).toBeNull();
    /* …while the rest of the footer is intact — moderation IS the writer's
       job, so only destroy may be missing. */
    expect(within(asWriter).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(asWriter).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('moderates by moving status and touching nothing else', async () => {
    const user = userEvent.setup();
    when(REVIEWS, { items: [pendingReview], nextCursor: null });
    when(`${REVIEWS}/${pendingReview.id}`, (_url, init) => {
      const sent = JSON.parse(String(init.body)) as { status: ReviewStatus };
      return {
        body: {
          review: {
            ...pendingReview,
            status: sent.status,
            moderatedAt: NOW,
            moderatedBy: 'o@test.local',
          },
        },
      };
    });
    mount();

    // Approve, from the row's quick action.
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved — now on the storefront');

    const approve = bodiesOf(`${REVIEWS}/${pendingReview.id}`, 'PATCH')[0]!;
    /*
     * KEY BY KEY: `{ status }` and structurally nothing else. A body that also
     * carried the words, the rating or the sentiment would look identical on
     * screen and make every review on the site rewritable from here.
     */
    expect(approve).toEqual({ status: 'approved' });
    for (const theirs of ['rating', 'title', 'body', 'sentimentLabel', 'authorName']) {
      // Said twice on purpose: `toEqual` would still pass if the fixture and
      // the payload ever gained the same extra field together.
      expect(approve).not.toHaveProperty(theirs);
    }

    // Reject, from the modal — the other verb, the same wall.
    const modal = await openModal(user);
    await user.click(within(modal).getByRole('button', { name: 'Reject' }));
    await screen.findByText('Rejected — hidden from the storefront');

    const patches = bodiesOf(`${REVIEWS}/${pendingReview.id}`, 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ status: 'rejected' });
  });
});
