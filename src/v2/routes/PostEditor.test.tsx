import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The v2 post editor, pinned on the three ways a lite editor quietly loses
 * somebody's writing:
 *
 *  - **A save filed as an autosave.** `kind: 'manual'` is what keeps the
 *    snapshot forever; autosaves are throttled and pruned. The whole PATCH
 *    body is asserted key by key, because a body that is right except for the
 *    kind looks identical on screen and erases history on a schedule.
 *  - **An excerpt that pins itself.** An untouched derived excerpt tracks the
 *    opening of the post; sending its current text back on every save would
 *    freeze it as authored. So the patch must OMIT the key until the field is
 *    actually edited, and carry it afterwards.
 *  - **A 409 that overwrites.** The CAS miss must become the conflict banner
 *    with the typed words still in the boxes — never a toast, never a silent
 *    adoption of either side.
 *
 * `fetch` IS STUBBED, NOT `../../data/api`: the path, the method and the body
 * are the three things most likely to be silently wrong against the server,
 * and a mocked module asserts none of them. The TipTap surface mounts for
 * real and is deliberately never typed in — `adoptDrafts` seeds `content`
 * with the loaded document, so every save of an existing post carries it back
 * unchanged, and the body assertions say so key by key.
 */

vi.mock('../../data/session', () => ({
  getSession: () => ({
    status: 'authed',
    user: { id: 'u_owner', email: 'o@test.local', displayName: 'An Owner', role: 'owner' },
  }),
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import type { Post } from '../../../shared/types';
import { ToastHost } from '../ui/Toast';
import PostEditor from './PostEditor';

/* What jsdom does not implement and the v2 chrome touches. */
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

/** Every body written to a path with this method, oldest first. */
function sentAll(pathname: string, method: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
}

const wrote = (pathname: string, method: string): boolean =>
  calls.some((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);

beforeEach(() => {
  handlers.clear();
  calls = [];
  /* `plaspool.v2.advanced-editor-default` at '1' bounces this route straight
     to `/advanced` — these tests are about the quick editor, so the device
     preference starts unset every time. */
  window.localStorage.clear();
  window.sessionStorage.clear();
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

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Opening words of the story.' }] },
  ],
};

const POST: Post = {
  id: 'post_1',
  title: 'A spool remembered',
  subtitle: '',
  slug: 'a-spool-remembered',
  excerpt: 'Opening words of the story.',
  excerptSource: 'derived',
  content: DOC as Post['content'],
  coverImage: null,
  category: '',
  tags: [],
  template: null,
  status: 'draft',
  createdAt: 1_756_000_000_000,
  updatedAt: 1_756_100_000_000,
  publishedAt: null,
  deletedAt: null,
  wordCount: 5,
  readingTime: 1,
  authorId: 'u_owner',
  authorName: 'An Owner',
  revision: 3,
};

const POST_PATH = '/api/posts/post_1';

/** The read and the write share one pathname; only the method tells them apart. */
function withPost(onPatch: Responder): void {
  when(POST_PATH, (url, init) =>
    (init.method ?? 'GET') === 'PATCH' ? onPatch(url, init) : { body: { post: POST } },
  );
  when('/api/categories', { categories: [] });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/content/posts/post_1']}>
        <Routes>
          <Route path="/content/posts/:id" element={<PostEditor />} />
        </Routes>
      </MemoryRouter>
    </ToastHost>,
  );
}

const retype = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
): Promise<void> => {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};

// ============================================================================

describe('the post editor', () => {
  it('saves as a manual snapshot, with the revision it read', async () => {
    const user = userEvent.setup();
    withPost(() => ({ body: { post: { ...POST, title: 'Renamed post', revision: 4 } } }));
    mount();

    await screen.findByLabelText('Title');
    await retype(user, 'Title', 'Renamed post');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(wrote(POST_PATH, 'PATCH')).toBe(true));
    const [body] = sentAll(POST_PATH, 'PATCH');
    /*
     * `kind: 'manual'` IS THE POINT: the route prunes autosaves and keeps
     * manual snapshots forever, so a save that files under the wrong kind
     * looks identical today and has no history next month.
     */
    expect(body.kind).toBe('manual');
    expect(body.baseRevision).toBe(POST.revision);
    /* The patch, key by key. `content` is the loaded document riding along
       unchanged (`adoptDrafts` seeds it); the untouched excerpt contributes
       NO key at all — that is the next test's whole subject. */
    expect(body.patch).toEqual({
      title: 'Renamed post',
      subtitle: '',
      category: '',
      tags: [],
      template: null,
      coverImage: null,
      content: DOC,
    });
  });

  it('sends the excerpt only once the field is touched, so a derived one keeps tracking the opening', async () => {
    const user = userEvent.setup();
    let revision = POST.revision;
    withPost((url, init) => {
      revision += 1;
      const { patch } = JSON.parse(String(init.body)) as { patch: Partial<Post> };
      return { body: { post: { ...POST, ...patch, revision } } };
    });
    mount();

    /* Save 1: the excerpt box shows the derived text, but nobody edited it. */
    await screen.findByLabelText('Title');
    await retype(user, 'Title', 'Renamed post');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sentAll(POST_PATH, 'PATCH')).toHaveLength(1));
    expect(sentAll(POST_PATH, 'PATCH')[0].patch).not.toHaveProperty('excerpt');

    /* The save settled: nothing is dirty, so the bar stood down. */
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());

    /* Save 2: the field has now actually been edited, so the key travels. */
    await retype(user, 'Excerpt', 'Pinned by hand.');
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sentAll(POST_PATH, 'PATCH')).toHaveLength(2));

    const second = sentAll(POST_PATH, 'PATCH')[1];
    expect(second.patch).toEqual({
      title: 'Renamed post',
      subtitle: '',
      category: '',
      tags: [],
      template: null,
      coverImage: null,
      content: DOC,
      excerpt: 'Pinned by hand.',
    });
    /* And the base moved with the adopted response — no self-409 next save. */
    expect(second.baseRevision).toBe(POST.revision + 1);
  });

  it('turns a 409 into the conflict banner, never a silent overwrite', async () => {
    const user = userEvent.setup();
    withPost(() => ({
      status: 409,
      body: {
        error: 'stale_write',
        expected: 3,
        actual: 7,
        post: { ...POST, title: 'Theirs', revision: 7 },
        requestId: 'req_stale',
      },
    }));
    mount();

    await screen.findByLabelText('Title');
    await retype(user, 'Title', 'Mine now');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    /* The banner, with its way out — and not the generic critical toast. */
    await screen.findByText('This post changed somewhere else');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByText('Saved')).toBeNull();

    /* Nothing was adopted from either side: the operator's words are still in
       the box, until the reload they have not yet chosen. */
    expect(screen.getByLabelText('Title')).toHaveProperty('value', 'Mine now');
    expect(sentAll(POST_PATH, 'PATCH')).toHaveLength(1);
  });
});
