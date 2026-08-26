import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The v2 banners list, pinned on the two things the debt ledger names.
 *
 *  - **The status column filters on the DERIVED status.** The stored intent is
 *    draft/live/archived; what the site shows is that intent crossed with the
 *    clock. The load-bearing fixture is `scheduledBanner` — STORED `live`,
 *    window opening two days after `NOW` — which must file under "Scheduled"
 *    and must NOT answer the "Live" tab, or the admin says Live while the
 *    site shows nothing.
 *  - **Every patch carries `expectedRevision`.** Both write paths — the row
 *    menu's status flip and the edit modal's save — are asserted key by key,
 *    so a patch that dropped the CAS revision (or invented a key) fails here
 *    rather than silently overwriting somebody else's edit in production.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-marketing`, per the rewards suite:
 * path, method and body are the three things a mocked module asserts nothing
 * about.
 */

import { ToastHost } from '../ui/Toast';
import {
  NOW,
  banners,
  draftBanner,
  liveBanner,
  scheduledBanner,
} from '../../data/marketing-fixtures';
import Banners from './Banners';

/** The shared jsdom shims, byte-for-byte the harness's set. */
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

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** Requests to this path with this method, however many. */
const count = (pathname: string, method: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .length;

beforeEach(() => {
  handlers.clear();
  calls = [];
  // Pinned, because the whole first test is about a schedule crossed with the
  // clock: `deriveBannerStatus(b, Date.now())` has to read the fixtures' NOW.
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
});

// -------------------------------------------------------------- the harness

const BANNERS = '/api/marketing/banners';

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/content/banners']}>
        <Banners />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** A banner's table row, found by its title. */
const rowOf = (title: string): HTMLElement => {
  const row = screen.getByText(title).closest('tr');
  if (row === null) throw new Error(`no row for ${title}`);
  return row as HTMLElement;
};

// ============================================================================

describe('the banners list', () => {
  it('files a stored-live row under Scheduled until its window opens', async () => {
    const user = userEvent.setup();
    when(BANNERS, { banners });
    mount();
    await screen.findByText(scheduledBanner.title);

    /*
     * The guard that keeps this test meaning what it says: the fixture STORES
     * `live` and its window opens after NOW. If either ever drifts, the
     * assertions below would be testing the trivial case.
     */
    expect(scheduledBanner.status).toBe('live');
    expect(scheduledBanner.startsAt).toBeGreaterThan(NOW);

    // On the All tab the status column already says what the SITE would do —
    // "Scheduled" on a row whose stored status is `live`.
    expect(within(rowOf(scheduledBanner.title)).getByText('Scheduled')).toBeTruthy();

    // The Scheduled tab claims the row…
    await user.click(screen.getByRole('tab', { name: 'Scheduled' }));
    expect(screen.getByText(scheduledBanner.title)).toBeTruthy();
    expect(screen.queryByText(liveBanner.title)).toBeNull();
    expect(screen.queryByText(draftBanner.title)).toBeNull();

    // …and the Live tab refuses it, stored status notwithstanding. A filter
    // written over `banner.status` would put it here and pass a softer test.
    await user.click(screen.getByRole('tab', { name: 'Live' }));
    expect(screen.getByText(liveBanner.title)).toBeTruthy();
    expect(screen.queryByText(scheduledBanner.title)).toBeNull();
  });

  it('flips a status from the row menu as a CAS patch carrying the revision it read', async () => {
    const user = userEvent.setup();
    when(BANNERS, { banners });
    when(`${BANNERS}/${draftBanner.id}`, {
      banner: { ...draftBanner, status: 'live', revision: draftBanner.revision + 1 },
    });
    mount();
    await screen.findByText(draftBanner.title);

    await user.click(screen.getByRole('button', { name: `Actions for ${draftBanner.title}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Turn on' }));

    await waitFor(() => expect(count(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toBe(1));
    // KEY BY KEY: the CAS revision and the one field that moved — nothing else.
    expect(sent(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toEqual({
      expectedRevision: draftBanner.revision,
      status: 'live',
    });

    // The screen adopts the server's row rather than re-deriving from hope:
    // the badge leaves Draft for Live (null window → live the moment it is on).
    await waitFor(() =>
      expect(within(rowOf(draftBanner.title)).queryByText('Draft')).toBeNull(),
    );
    expect(within(rowOf(draftBanner.title)).getByText('Live')).toBeTruthy();
  });

  it('saves the edit modal as one CAS patch, keeping a cleared CTA a real null', async () => {
    const user = userEvent.setup();
    when(BANNERS, { banners });
    when(`${BANNERS}/${draftBanner.id}`, {
      banner: { ...draftBanner, title: 'Bank holiday sale', revision: draftBanner.revision + 1 },
    });
    mount();
    await screen.findByText(draftBanner.title);

    // A row click opens the editor — the click lands on the title text, which
    // is not a control, so the row's own handler takes it.
    await user.click(screen.getByText(draftBanner.title));
    const dialog = await screen.findByRole('dialog', { name: `Edit “${draftBanner.title}”` });

    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Bank holiday sale');
    await user.click(within(dialog).getByRole('button', { name: 'Save banner' }));

    await waitFor(() => expect(count(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toBe(1));
    /*
     * The WHOLE body, key by key. `expectedRevision` rides this patch exactly
     * as it rides the status flip; the untouched CTA pair travels as real
     * nulls (a value, not an absence — null is how "no button" is stored);
     * and the empty schedule stays a pair of nulls rather than `''`.
     */
    expect(sent(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toEqual({
      expectedRevision: draftBanner.revision,
      title: 'Bank holiday sale',
      body: draftBanner.body,
      ctaText: null,
      ctaUrl: null,
      placement: 'section',
      startsAt: null,
      endsAt: null,
      priority: 0,
    });

    // The modal closes on the server's answer and the list adopts it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Bank holiday sale')).toBeTruthy();
  });
});
