import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

/**
 * `#/recover` — the list of unsent writes only a human can end.
 *
 * Against the real `pending` store, because the two properties worth testing
 * are which rows appear (this user's, never a colleague's) and that resolving
 * one actually ends it. A mocked store would assert neither.
 */
vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: { getPost: vi.fn() },
}));

const fixture = vi.hoisted(() => ({
  session: { status: 'authed' } as Record<string, unknown>,
}));

vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => undefined,
  initSession: vi.fn(),
  logout: vi.fn(),
  whenReplayed: () => Promise.resolve(),
}));

import { api } from '../data/api';
import { cachePost } from '../data/cache';
import { db } from '../data/db';
import { OfflineError } from '../data/errors';
import { listPending, markPending, queuePending } from '../data/pending';
import Recover from './Recover';
import { EMPTY_DOC, type AuthUser, type DocNode, type Post } from '../data/types';

const WRITER: AuthUser = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer',
};
const COLLEAGUE: AuthUser = {
  id: 'u_colleague',
  email: 'colleague@test.local',
  displayName: 'Someone Else',
  role: 'writer',
};

const para = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let n = 0;
function makePost(over: Partial<Post> = {}): Post {
  n += 1;
  return {
    id: `p_${n}`,
    title: `Post ${n}`,
    subtitle: '',
    slug: null,
    excerpt: '',
    excerptSource: 'derived',
    content: EMPTY_DOC,
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
    readingTime: 0,
    authorId: WRITER.id,
    authorName: WRITER.displayName,
    revision: 5,
    ...over,
  };
}

async function seedRow(
  postId: string,
  userId: string,
  state: 'queued' | 'unresolved' | 'blocked',
  text: string,
  detail?: string,
) {
  await queuePending({
    postId,
    userId,
    patch: { title: `Title of ${postId}`, content: para(text) },
    baseRevision: 4,
  });
  if (state !== 'queued') await markPending(postId, userId, { state, detail });
}

const open = () =>
  render(
    <MemoryRouter>
      <Recover />
    </MemoryRouter>,
  );

beforeEach(async () => {
  cleanup();
  vi.resetAllMocks();
  fixture.session = { status: 'authed', user: WRITER };
  await db.posts.clear();
  await db.postList.clear();
  await db.pending.clear();
});

describe('what the list shows', () => {
  it('lists the rows a human has to end, and not the ones replay will retry', async () => {
    await seedRow('p_conflict', WRITER.id, 'unresolved', 'the words I typed offline');
    await seedRow('p_refused', WRITER.id, 'blocked', 'the words the server refused');
    await seedRow('p_waiting', WRITER.id, 'queued', 'these will be sent on their own');
    vi.mocked(api.getPost).mockResolvedValue(makePost());

    open();

    expect(await screen.findByText('the words I typed offline')).toBeTruthy();
    expect(screen.getByText('the words the server refused')).toBeTruthy();
    // A `queued` row needs nobody: the next boot's replay sends it. Listing it
    // as a decision would make the screen mostly noise, and the real decisions
    // easy to miss inside it.
    expect(screen.queryByText('these will be sent on their own')).toBeNull();
  });

  it("never shows another user's unsent draft", async () => {
    await seedRow('p_theirs', COLLEAGUE.id, 'blocked', 'a colleague was writing this');
    vi.mocked(api.getPost).mockResolvedValue(makePost());

    open();

    // The rows are keyed [postId+ownerUserId] and every reader is user-scoped.
    // A shared machine must not show one writer's draft to the next.
    expect(await screen.findByText(/nothing is waiting/i)).toBeTruthy();
    expect(screen.queryByText('a colleague was writing this')).toBeNull();
    expect(await listPending(COLLEAGUE.id)).toHaveLength(1);
  });

  it('quotes the server on a row it will never accept, and offers a file', async () => {
    await seedRow(
      'p_refused',
      WRITER.id,
      'blocked',
      'five hundred words',
      'content.text exceeds 500 KB',
    );
    vi.mocked(api.getPost).mockResolvedValue(makePost());

    open();

    // `blocked` is permanent — 422 or 400 — so "try again later" would be a
    // lie, and without the reason the writer has nothing to act on.
    expect(await screen.findByText(/exceeds 500 KB/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /export to a file/i })).toBeTruthy();
  });

  it('says plainly when there is nothing to decide', async () => {
    open();

    expect(await screen.findByText(/nothing is waiting/i)).toBeTruthy();
  });
});

describe('resolving', () => {
  it('"Keep mine" puts the words back where the editor reads them and ends the row', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await seedRow(post.id, WRITER.id, 'unresolved', 'my version');
    vi.mocked(api.getPost).mockResolvedValue(post);
    open();
    await screen.findByText('my version');

    await userEvent.click(screen.getByRole('button', { name: /keep mine/i }));

    await waitFor(async () => expect(await listPending(WRITER.id)).toHaveLength(0));
    // The overlay is the only thing that can put words back on screen: the
    // frozen editor hydrates from `db.posts` and nothing else reaches it.
    const row = await db.posts.get(post.id);
    expect(row?.content).toEqual(para('my version'));
    expect(row?.pendingAt).toBeTypeOf('number');
    // Not the server's revision + 1 — the server never accepted this write.
    expect(row?.revision).toBe(post.revision);
  });

  it('"Load theirs" is refused outright while the server version cannot be fetched', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await seedRow(post.id, WRITER.id, 'blocked', 'my version');
    vi.mocked(api.getPost).mockRejectedValue(new OfflineError());
    open();
    await screen.findByText('my version');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /load theirs/i })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    // Without the server's version in hand, "load theirs" would delete the only
    // copy of the patch and put nothing in its place.
    expect(await listPending(WRITER.id)).toHaveLength(1);
  });

  it('"Load theirs" takes the server version and drops the patch', async () => {
    const post = makePost();
    await cachePost(WRITER.id, post);
    await seedRow(post.id, WRITER.id, 'blocked', 'my version');
    const theirs = { ...post, revision: post.revision, content: para('their version') };
    vi.mocked(api.getPost).mockResolvedValue(theirs);
    open();
    await screen.findByText('my version');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /load theirs/i })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /load theirs/i }));

    await waitFor(async () => expect(await listPending(WRITER.id)).toHaveLength(0));
    /*
     * The equal-revision case is the one that needs the eviction: `reconcile`
     * refuses to write over a `pendingAt` row at the same revision — which is
     * what stops a background revalidation erasing recovered work — so a plain
     * `cachePost` here would leave the writer's overlay in place while claiming
     * to have loaded the other version.
     */
    expect((await db.posts.get(post.id))?.content).toEqual(para('their version'));
  });
});
