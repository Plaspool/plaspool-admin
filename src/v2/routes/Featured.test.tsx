import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The v2 featured rail, pinned on the two conflict paths the debt ledger names.
 *
 *  - **A stale reorder ADOPTS the server's items instead of retrying.** Every
 *    `featured_stale` carries the current rail precisely so no screen needs a
 *    second request to recover — so the honest assertions are three at once:
 *    the list re-renders to the SERVER's order, exactly one PUT ever went out,
 *    and the GET count never moved. A retry loop or a refetch would pass a
 *    softer test that only looked at the final order.
 *  - **`featured_full` routes into the replace picker rather than surfacing as
 *    an error.** The 409 is the answer to a question the operator could not
 *    see ("which four are already on?"), and the modal turns it into the
 *    question it implies. The retry then carries the chosen `replace` id — the
 *    slot inheritance the server contract hangs on.
 *
 * `fetch` IS STUBBED, NOT `../../data/api` — same reason the rewards suite
 * gives: the path, the method and the body are the three things most likely to
 * be silently wrong, and a mocked module asserts none of them.
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
import Featured from './Featured';
import type { FeaturedItem, ListPost } from '../../../shared/types';

/**
 * What jsdom does not implement and the shared harness always shims — kept
 * identical to `src/routes/MarketingRewards.test.tsx` so a future popover or
 * confirm on this screen does not fail for environmental reasons.
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

/** GETs of exactly this path. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

/** Non-GET requests to this path with this method. */
const writes = (pathname: string, method: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .length;

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

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
  fixture.session.user.role = 'owner';
});

// -------------------------------------------------------------- the harness

const FEATURED = '/api/featured';
const POSTS = '/api/posts';

const NOW = 1786600000000;
const DAY = 86_400_000;

/** A rail item. `coverImage: null` keeps `StoredImg` (IndexedDB) unmounted. */
const item = (id: string, rank: number, title: string): FeaturedItem => ({
  id,
  slug: id,
  title,
  coverImage: null,
  publishedAt: NOW - 30 * DAY,
  rank,
});

const first = item('p_a', 1, 'Fewer bottles, better bottles');
const second = item('p_b', 2, 'The refill van timetable');
const third = item('p_c', 3, 'What a deposit really buys');
const fourth = item('p_d', 4, 'Caps, counted');

/** A published post the picker can offer — the full `ListPost` shape. */
const candidate: ListPost = {
  id: 'p_e',
  title: 'A fifth story',
  subtitle: '',
  slug: 'a-fifth-story',
  excerpt: '',
  excerptSource: 'derived',
  coverImage: null,
  category: '',
  tags: [],
  template: null,
  status: 'published',
  createdAt: NOW - 40 * DAY,
  updatedAt: NOW - 2 * DAY,
  publishedAt: NOW - 2 * DAY,
  deletedAt: null,
  wordCount: 600,
  readingTime: 3,
  authorId: 'u_owner',
  authorName: 'An Owner',
  revision: 4,
};

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/content/featured']}>
        <Featured />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** The rail's titles, in the order they are drawn. */
const railTitles = (): string[] =>
  screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.idcell__title')?.textContent ?? '');

// ============================================================================

describe('the featured rail', () => {
  it('adopts the rail a stale reorder answers with, instead of retrying it', async () => {
    const user = userEvent.setup();
    /*
     * The server's truth is a DIFFERENT SET, not just a different order:
     * somebody else unfeatured the post being moved. Adoption has to un-draw a
     * row nobody here removed — which is exactly what a retry loop would
     * refuse to do.
     */
    const truth = [item('p_c', 1, third.title), item('p_a', 2, first.title)];
    when(FEATURED, (url, init) =>
      (init.method ?? 'GET') === 'GET'
        ? { body: { items: [first, second, third] } }
        : {
            status: 409,
            body: { error: 'featured_stale', limit: 4, items: truth, requestId: 'req_stale' },
          },
    );
    mount();
    await screen.findByText(first.title);

    await user.click(screen.getByLabelText(`Move “${second.title}” up`));

    // The write carried the WHOLE rail in its new order — never one row.
    await waitFor(() => expect(writes(FEATURED, 'PUT')).toBe(1));
    expect(sent(FEATURED, 'PUT')).toEqual({ ids: ['p_b', 'p_a', 'p_c'] });

    // The refusal is adopted as the truth it is: the list re-renders to the
    // server's items in the server's rank order, and says what happened.
    await waitFor(() => expect(railTitles()).toEqual([third.title, first.title]));
    expect(
      await screen.findByText('The featured posts changed somewhere else — showing the latest order'),
    ).toBeTruthy();

    // And that adoption was the WHOLE recovery: no second PUT went out, and
    // the payload was enough — the rail was never re-fetched.
    expect(writes(FEATURED, 'PUT')).toBe(1);
    expect(reads(FEATURED)).toBe(1);
  });

  it('routes a full rail into the replace picker rather than surfacing an error', async () => {
    const user = userEvent.setup();
    const rail = [first, second, third, fourth];
    when(FEATURED, { items: rail });
    when(POSTS, { items: [candidate], nextCursor: null });
    when(`${POSTS}/p_e/feature`, (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return 'replace' in body
        ? { body: { items: [first, item('p_e', 2, candidate.title), third, fourth] } }
        : {
            status: 409,
            body: { error: 'featured_full', limit: 4, items: rail, requestId: 'req_full' },
          };
    });
    mount();
    await screen.findByText(first.title);

    await user.click(screen.getByRole('button', { name: 'Feature a post' }));
    const picker = await screen.findByRole('dialog');
    await within(picker).findByText(candidate.title);
    await user.click(within(picker).getByRole('button', { name: 'Feature' }));

    /*
     * The 409 became the question it implies — "replace which one?" — listing
     * the four posts the payload named, and never an error about a rule the
     * operator could not see.
     */
    const full = await screen.findByRole('dialog', { name: 'No room for another' });
    for (const on of rail) {
      expect(within(full).getByText(on.title)).toBeTruthy();
    }
    expect(document.querySelector('.toast--critical')).toBeNull();
    // The first attempt carried no `replace` — the client had no way to know
    // it needed one, and the absent key is what makes the 409 legitimate.
    expect(sent(`${POSTS}/p_e/feature`, 'POST')).toEqual({});

    // Choosing a slot retries WITH the replace id, and the screen adopts the
    // answer: the newcomer inherits the replaced post's position.
    const row = within(full).getByText(second.title).closest('button');
    if (!row) throw new Error('no replace row for the second post');
    await user.click(row);

    await waitFor(() =>
      expect(sent(`${POSTS}/p_e/feature`, 'POST')).toEqual({ replace: 'p_b' }),
    );
    await waitFor(() =>
      expect(railTitles()).toEqual([first.title, candidate.title, third.title, fourth.title]),
    );
    expect(screen.queryByText('No room for another')).toBeNull();
  });
});
