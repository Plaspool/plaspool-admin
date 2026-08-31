import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    await screen.findByText('Approved — now showing in your shop');

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
    await screen.findByText('Turned down — hidden from your shop');

    const patches = bodiesOf(`${REVIEWS}/${pendingReview.id}`, 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ status: 'rejected' });
  });
});

// -------------------------------------------------- the thread panel (0620)

/** An APPROVED review — the thread only opens on one, by design. */
const approvedReview: AdminReview = {
  ...pendingReview,
  id: 'rev_ok',
  title: 'Approved review',
  status: 'approved',
};

const ownerReply = {
  id: 'rpl_owner',
  parentId: null,
  depth: 0,
  body: 'Thanks Ada — glad it printed well.',
  authorKind: 'owner' as const,
  authorName: 'PlaSpool',
  status: 'approved' as const,
  customerId: null,
  staffUserId: 'u_owner',
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 3_600_000,
  moderatedAt: NOW - 3_600_000,
  moderatedBy: 'u_owner',
};

const pendingCustomerReply = {
  id: 'rpl_cust',
  parentId: 'rpl_owner',
  depth: 1,
  body: 'Mine arrived quickly too.',
  authorKind: 'customer' as const,
  authorName: 'Tunde',
  status: 'pending' as const,
  customerId: 'cus_2',
  staffUserId: null,
  createdAt: NOW - 1_800_000,
  updatedAt: NOW - 1_800_000,
  moderatedAt: null,
  moderatedBy: null,
};

function withThread(
  replies: unknown[] = [ownerReply, pendingCustomerReply],
  reactions = { helpful: 3, unhelpful: 1 },
): void {
  when(REVIEWS, { items: [approvedReview], nextCursor: null });
  when(`${REVIEWS}/${approvedReview.id}/replies`, { replies, reactions });
}

const openApproved = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByText(approvedReview.title!));
  return screen.findByRole('dialog', { name: approvedReview.title! });
};

describe('the review thread', () => {
  it('shows BOTH reaction counts — the only surface that does', async () => {
    /*
     * The asymmetry 0620 exists for: publicly there is no dislike tally to
     * organise around, and here the owner gets the signal. If this ever starts
     * matching the public response, one of the two is wrong.
     */
    const user = userEvent.setup();
    withThread();
    mount();
    const modal = await openApproved(user);

    expect(await within(modal).findByText('3 found this helpful')).toBeTruthy();
    expect(within(modal).getByText(/1 did not/)).toBeTruthy();
  });

  it('badges the shop reply and gives it the brand mark, not an initial', async () => {
    const user = userEvent.setup();
    withThread();
    mount();
    const modal = await openApproved(user);

    expect(await within(modal).findByText('PlaSpool')).toBeTruthy();
    expect(within(modal).getByText('Shop')).toBeTruthy();
    // The customer gets an initial instead.
    expect(within(modal).getByText('T')).toBeTruthy();
  });

  it('SHOWS a pending reply rather than hiding it — this is the queue', async () => {
    const user = userEvent.setup();
    withThread();
    mount();
    const modal = await openApproved(user);

    expect(await within(modal).findByText('Mine arrived quickly too.')).toBeTruthy();
    expect(within(modal).getByText('pending')).toBeTruthy();
    // And it can be acted on.
    expect(within(modal).getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('offers moderation on CUSTOMER replies only — an owner reply is approved at birth', async () => {
    const user = userEvent.setup();
    withThread([ownerReply], { helpful: 0, unhelpful: 0 });
    mount();
    const modal = await openApproved(user);

    await within(modal).findByText('PlaSpool');
    /* SCOPED TO THE REPLY'S OWN ROW, not to the modal. The modal footer carries
       the REVIEW's moderation buttons, and asserting over the whole dialog
       would conflate the two — which is exactly what the first draft of this
       test did, and it failed for that reason rather than a real one. */
    const row = within(modal).getByRole('listitem');
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull();
    // The reply button IS offered — the row is not simply actionless.
    expect(within(row).getByRole('button', { name: 'Reply' })).toBeTruthy();
  });

  it('hides Reply at depth 1, rather than offering what the server refuses', async () => {
    // Two levels is the ceiling. A button that produced a 400 naming `parentId`
    // would make the refusal the user's first hint that a rule exists.
    const user = userEvent.setup();
    withThread();
    mount();
    const modal = await openApproved(user);

    await within(modal).findByText('Mine arrived quickly too.');
    // One Reply button — the depth-0 owner reply's — and not two.
    expect(within(modal).getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
  });

  it('posts to the STAFF endpoint with no byline, and reloads the thread', async () => {
    const user = userEvent.setup();
    withThread([], { helpful: 0, unhelpful: 0 });
    when(`${REVIEWS}/${approvedReview.id}/staff-replies`, { reply: ownerReply }, 201);
    mount();
    const modal = await openApproved(user);

    await user.type(
      await within(modal).findByLabelText('Reply as the shop'),
      'Thanks for the kind words.',
    );
    await user.click(within(modal).getByRole('button', { name: 'Post reply' }));

    await waitFor(() =>
      expect(bodiesOf(`${REVIEWS}/${approvedReview.id}/staff-replies`, 'POST').at(-1)).toEqual({
        body: 'Thanks for the kind words.',
        // Top level, and NO authorName — the shop's byline is the server's to
        // set, so an admin cannot sign a reply with their own name.
        parentId: null,
      }),
    );
  });

  it('threads a reply under the one it is answering', async () => {
    const user = userEvent.setup();
    withThread();
    when(`${REVIEWS}/${approvedReview.id}/staff-replies`, { reply: ownerReply }, 201);
    mount();
    const modal = await openApproved(user);

    await user.click(await within(modal).findByRole('button', { name: 'Reply' }));
    expect(within(modal).getByLabelText('Replying to PlaSpool')).toBeTruthy();

    await user.type(within(modal).getByLabelText('Replying to PlaSpool'), 'Following up.');
    await user.click(within(modal).getByRole('button', { name: 'Post reply' }));

    await waitFor(() =>
      expect(bodiesOf(`${REVIEWS}/${approvedReview.id}/staff-replies`, 'POST').at(-1)).toMatchObject({
        parentId: 'rpl_owner',
      }),
    );
  });

  it('does not open a composer on a review that is not approved yet', async () => {
    // Nothing public to reply to, and the server refuses on the same rule — so
    // a composer here would be a control that 404s.
    const user = userEvent.setup();
    when(REVIEWS, { items: [pendingReview], nextCursor: null });
    mount();
    const modal = await openModal(user);

    expect(within(modal).queryByLabelText('Reply as the shop')).toBeNull();
    expect(within(modal).getByText(/You can reply once this review is approved/)).toBeTruthy();
  });

  it('survives a thread that will not load, rather than breaking the modal', async () => {
    // The panel is an adjunct to the review. A modal that refused to open
    // because the replies 500'd would be worse than one without them.
    const user = userEvent.setup();
    when(REVIEWS, { items: [approvedReview], nextCursor: null });
    when(`${REVIEWS}/${approvedReview.id}/replies`, { error: 'boom' }, 500);
    mount();
    const modal = await openApproved(user);

    expect(await within(modal).findByText('No replies yet.')).toBeTruthy();
    expect(within(modal).getByLabelText('Reply as the shop')).toBeTruthy();
  });
});
