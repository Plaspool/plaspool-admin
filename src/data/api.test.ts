import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_EXPIRED_EVENT, api, apiFetch } from './api';
import {
  ApiError,
  AuthExpiredError,
  FeaturedConflictError,
  ForbiddenError,
  NotFeaturableError,
  NotFoundError,
  OfflineError,
  PreconditionFailedError,
  StaleWriteError,
} from './errors';
import { StaleWriteError as ReExported } from './posts';
import type { Post } from './types';

/**
 * The API client's contract with `server/`, pinned on this side.
 *
 * Three of these cases exist because the thing they check has no compiler
 * behind it: a path string, an error message a frozen regex greps, and which of
 * two 409s a body means. All three are silent when wrong — the first is a 404,
 * the second turns "this post was destroyed" into a retry loop, and the third
 * hands the conflict banner `expected === actual`, which it cannot draw.
 */

const post = (over: Partial<Post> = {}): Post => ({
  id: 'p_1',
  title: 'A title',
  subtitle: '',
  slug: null,
  excerpt: '',
  excerptSource: 'derived',
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
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
  readingTime: 1,
  authorId: 'u_1',
  authorName: 'Ada',
  revision: 4,
  ...over,
});

/** Every wrapper key any route answers with, so one body satisfies them all. */
const ANY_BODY = {
  ok: true,
  user: { id: 'u_1', email: 'a@b.c', displayName: 'Ada', role: 'writer' },
  post: post(),
  items: [],
  nextCursor: null,
  revision: { id: 'r_1' },
  invite: { id: 'i_1' },
  image: { id: 'img_1' },
  id: 'img_1',
  uploadUrl: 'https://r2.example/put',
  headers: {},
  expiresIn: 300,
  swept: 0,
  emptied: 0,
  imported: 0,
  skipped: 0,
  ignored: { revisions: 0, images: 0 },
  collected: 0,
  format: 'publishing-studio/v2',
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * A FRESH `Response` PER CALL, and that is not a detail. A `Response` body can
 * be read once; handing the same instance to three concurrent requests makes
 * the second and third reject inside `res.text()` with an error that has
 * nothing to do with the case under test.
 */
function serve(status: number, body: unknown, headers: Record<string, string> = {}): void {
  fetchMock.mockImplementation(() => Promise.resolve(reply(status, body, headers)));
}

/** The last request's `[url, init]`. */
function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
}

async function refused(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(reply(200, ANY_BODY)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --------------------------------------------------------------------- routes

/**
 * Every method, its verb and its path — copied from `server/routes/*.ts`.
 *
 * A wrong path is a 404 that plan §3 reads as "the post was destroyed", and
 * nothing in the type system connects this file to the router.
 */
const ROUTES: [string, () => Promise<unknown>, string, string][] = [
  ['me', () => api.me(), 'GET', '/api/auth/me'],
  ['logout', () => api.logout(), 'POST', '/api/auth/logout'],
  /* `login` and `acceptInvite` were here until Clerk became the only door.
     The one route that mints a session is now `/api/auth/clerk/exchange`,
     which `ClerkGate` calls through `apiFetch` directly rather than through
     `api`, and which is covered against the real server in
     `server/routes/clerk.test.ts`. */
  ['createInvite', () => api.createInvite('a@b.c'), 'POST', '/api/invites'],
  ['listInvites', () => api.listInvites(), 'GET', '/api/invites'],
  ['revokeInvite', () => api.revokeInvite('i_1'), 'DELETE', '/api/invites/i_1'],
  ['listPosts', () => api.listPosts({ status: 'trash' }), 'GET', '/api/posts?status=trash'],
  ['getPost', () => api.getPost('p_1'), 'GET', '/api/posts/p_1'],
  ['createPost', () => api.createPost(), 'POST', '/api/posts'],
  ['savePost', () => api.savePost('p_1', {}), 'PATCH', '/api/posts/p_1'],
  ['publishPost', () => api.publishPost('p_1'), 'POST', '/api/posts/p_1/publish'],
  ['unpublishPost', () => api.unpublishPost('p_1'), 'POST', '/api/posts/p_1/unpublish'],
  ['archivePost', () => api.archivePost('p_1'), 'POST', '/api/posts/p_1/archive'],
  ['unarchivePost', () => api.unarchivePost('p_1'), 'POST', '/api/posts/p_1/unarchive'],
  ['trashPost', () => api.trashPost('p_1'), 'POST', '/api/posts/p_1/trash'],
  ['restorePost', () => api.restorePost('p_1'), 'POST', '/api/posts/p_1/restore'],
  ['duplicatePost', () => api.duplicatePost('p_1'), 'POST', '/api/posts/p_1/duplicate'],
  ['destroyPost', () => api.destroyPost('p_1'), 'DELETE', '/api/posts/p_1'],
  ['sweepBlankDrafts', () => api.sweepBlankDrafts(), 'POST', '/api/posts/sweep-blank'],
  ['emptyTrash', () => api.emptyTrash(), 'POST', '/api/trash/empty'],
  ['listRevisions', () => api.listRevisions('p_1'), 'GET', '/api/posts/p_1/revisions'],
  ['getRevision', () => api.getRevision('r_1'), 'GET', '/api/revisions/r_1'],
  [
    'restoreRevision',
    () => api.restoreRevision('p_1', 'r_1'),
    'POST',
    '/api/posts/p_1/revisions/r_1/restore',
  ],
  ['exportAll', () => api.exportAll(), 'GET', '/api/export'],
  ['importBundle', () => api.importBundle({ format: 'publishing-studio/v2' }), 'POST', '/api/import'],
  [
    'createImageSlot',
    () => api.createImageSlot({ contentType: 'image/png', byteSize: 10 }),
    'POST',
    '/api/images',
  ],
  ['commitImage', () => api.commitImage('img_1'), 'POST', '/api/images/img_1/commit'],
  [
    'collectOrphanImages',
    () => api.collectOrphanImages(),
    'POST',
    '/api/images/collect-orphans',
  ],
  ['listFeatured', () => api.listFeatured(), 'GET', '/api/featured'],
  ['featurePost', () => api.featurePost('p_1'), 'POST', '/api/posts/p_1/feature'],
  ['unfeaturePost', () => api.unfeaturePost('p_1'), 'POST', '/api/posts/p_1/unfeature'],
  ['reorderFeatured', () => api.reorderFeatured(['p_1']), 'PUT', '/api/featured'],
];

describe('routes', () => {
  it.each(ROUTES)('%s issues %s %s', async (_name, run, method, path) => {
    await run();
    const [requested, init] = lastCall();
    expect([requested, init.method]).toEqual([path, method]);
  });

  /**
   * WITHOUT THIS THE SESSION COOKIE IS NEVER SENT. It is a `__Host-` cookie and
   * `fetch` omits cookies by default, so every route would answer 401 while the
   * cookie sat in the jar — an app that looks logged out and cannot be logged
   * back in.
   */
  it.each(ROUTES)('%s sends credentials: include', async (_name, run) => {
    await run();
    expect(lastCall()[1].credentials).toBe('include');
  });

  it('declares application/json whenever it sends a body, and not otherwise', async () => {
    await api.savePost('p_1', { title: 'x' });
    expect(lastCall()[1].headers).toEqual({ 'content-type': 'application/json' });

    // `readJson` answers 400 for any other media type, so a body without the
    // header is a permanent refusal of a request that was otherwise fine.
    await api.publishPost('p_1');
    expect(lastCall()[1].headers).toBeUndefined();
  });

  it('omits empty query values rather than sending them', async () => {
    // Every query schema is `.strict()` and `str()` accepts '', so `category=`
    // would be honoured as "posts whose category is the empty string".
    await api.listPosts({ status: 'all', search: '', category: undefined, limit: 50 });
    expect(lastCall()[0]).toBe('/api/posts?status=all&limit=50');
  });

  it('escapes an id so it cannot escape its path segment', async () => {
    await api.getPost('p_1/../trash');
    expect(lastCall()[0]).toBe('/api/posts/p_1%2F..%2Ftrash');
  });

  it('sends the CAS token and the snapshot kind savePost was given', async () => {
    await api.savePost('p_1', { title: 'x' }, { baseRevision: 7, kind: 'manual' });
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({
      patch: { title: 'x' },
      baseRevision: 7,
      kind: 'manual',
    });
  });

  it('builds an image URL rather than fetching one', () => {
    expect(api.imageUrl('img_1')).toBe('/api/images/img_1');
  });

  it('returns the created post from a 201', async () => {
    serve(201, { post: post({ id: 'p_new' }) });
    await expect(api.createPost()).resolves.toMatchObject({ id: 'p_new' });
    serve(201, { post: post({ id: 'p_copy' }) });
    await expect(api.duplicatePost('p_1')).resolves.toMatchObject({ id: 'p_copy' });
  });
});

// ---------------------------------------------------------------- the two 409s

describe('409 is two different errors', () => {
  const staleBody = {
    error: 'stale_write',
    expected: 4,
    actual: 6,
    post: post({ revision: 6, title: 'Theirs' }),
    requestId: 'req_1',
  };

  it('maps stale_write to StaleWriteError carrying expected, actual and the server post', async () => {
    serve(409, staleBody);
    const err = await refused(() => api.savePost('p_1', { title: 'mine' }, { baseRevision: 4 }));
    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err).toMatchObject({ expected: 4, actual: 6, status: 409, code: 'stale_write' });
  });

  /**
   * The banner's "Load theirs" renders from this and plan §2.3 writes it into
   * `db.posts`, which the frozen editor live-queries. A projection without
   * `content` reaching that store is the defect §2.1 exists to prevent, so the
   * fullness of this object is load-bearing rather than incidental.
   */
  it('carries the full server post, content included', async () => {
    serve(409, staleBody);
    const err = (await refused(() => api.savePost('p_1', {}, { baseRevision: 4 }))) as StaleWriteError;
    expect(err.post?.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('maps precondition_failed to a DIFFERENT class', async () => {
    serve(409, { error: 'precondition_failed', operation: 'publish', post: post() });
    const err = await refused(() => api.publishPost('p_1'));
    expect(err).toBeInstanceOf(PreconditionFailedError);
    expect(err).not.toBeInstanceOf(StaleWriteError);
    expect(err).toMatchObject({ operation: 'publish' });
  });

  /*
   * The other direction, because collapsing the pair is only half-caught by the
   * assertion above: `StaleWriteError extends ApiError`, and a mapping that
   * answered `precondition_failed` for both would still be an `ApiError`.
   */
  it('does not answer a lost CAS with PreconditionFailedError', async () => {
    serve(409, staleBody);
    const err = await refused(() => api.savePost('p_1', {}, { baseRevision: 4 }));
    expect(err).not.toBeInstanceOf(PreconditionFailedError);
  });

  it('leaves an unrecognised 409 as a plain ApiError rather than guessing', async () => {
    serve(409, { error: 'something_new' });
    const err = await refused(() => api.publishPost('p_1'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(StaleWriteError);
    expect(err).not.toBeInstanceOf(PreconditionFailedError);
  });
});

// -------------------------------------------------------------- the 404 probe

describe('404', () => {
  /**
   * THE FROZEN PROBE. `src/editor/useAutosave.ts:103` is
   * `/not found/i.test(err.message)` and the file may not be edited (plan §0
   * F1), so this exact wording is the entire mechanism by which the editor
   * learns a post was destroyed. Rewording it turns that into a generic error
   * the autosave loop retries against a post that will never come back.
   */
  it('produces the message useAutosave greps for, byte for byte', async () => {
    serve(404, { error: 'gone', requestId: 'req_2' });
    const err = (await refused(() => api.savePost('p_9', {}))) as NotFoundError;
    expect(err.message).toBe('Post p_9 not found');
    expect(/not found/i.test(err.message)).toBe(true);
  });

  it('names what the id actually is for a route that is not about posts', async () => {
    serve(404, { error: 'gone' });
    const err = (await refused(() => api.commitImage('img_7'))) as NotFoundError;
    expect(err.message).toBe('Image img_7 not found');
    // Still satisfies the probe — the wording changes, the mechanism does not.
    expect(/not found/i.test(err.message)).toBe(true);
  });

  /**
   * The probe is a substring match on a free-text message, so any OTHER error
   * whose message contained "not found" would be read by the frozen editor as
   * "your post was destroyed" and would replace the writer's screen with a
   * tombstone.
   */
  it('is the only error whose message matches the probe', async () => {
    const others: [number, unknown, () => Promise<unknown>][] = [
      [401, { error: 'unauthenticated' }, () => api.getPost('p_1')],
      [403, { error: 'forbidden' }, () => api.savePost('p_1', {})],
      [400, { error: 'bad_request', detail: 'body' }, () => api.savePost('p_1', {})],
      [422, { error: 'invalid_document', path: 'content.0', reason: 'bad_protocol' }, () => api.savePost('p_1', {})],
      [429, { error: 'rate_limited', retryAfter: 30 }, () => api.importBundle({})],
      [500, { error: 'internal', requestId: 'req_3' }, () => api.getPost('p_1')],
      [409, { error: 'stale_write', expected: 1, actual: 2, post: post() }, () => api.savePost('p_1', {})],
      [409, { error: 'precondition_failed', operation: 'publish', post: post() }, () => api.publishPost('p_1')],
    ];
    for (const [status, body, run] of others) {
      serve(status, body);
      const err = (await refused(run)) as Error;
      expect([status, /not found/i.test(err.message)]).toEqual([status, false]);
    }
  });
});

// ---------------------------------------------------------------------- 401

describe('401', () => {
  let target: EventTarget;
  let seen: number;
  /*
   * Dated ahead of anything an earlier test announced at, and MOVED FORWARD FOR
   * EACH TEST. The suppression window is module state measured against
   * `Date.now()`, so re-pinning the clock to the same instant would let the
   * previous test's announcement suppress this one — which is a real property
   * of the module and a false failure of the test.
   */
  let clock = Date.UTC(2099, 0, 1);

  beforeEach(() => {
    vi.useFakeTimers();
    clock += 60_000;
    vi.setSystemTime(clock);
    target = new EventTarget();
    seen = 0;
    target.addEventListener(AUTH_EXPIRED_EVENT, () => {
      seen += 1;
    });
    vi.stubGlobal('window', target);
    serve(401, { error: 'unauthenticated', requestId: 'req_4' });
  });

  it('raises AuthExpiredError, which is permanent', async () => {
    const err = await refused(() => api.getPost('p_1'));
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated', transient: false });
  });

  /**
   * ONE EVENT PER BURST. A dashboard mount fires several requests at once and
   * an expired cookie 401s all of them within a few milliseconds; one event per
   * response is one re-auth flow per response.
   */
  it('announces auth-expired once for three concurrent 401s', async () => {
    await Promise.all([
      refused(() => api.getPost('p_1')),
      refused(() => api.listPosts()),
      refused(() => api.listRevisions('p_1')),
    ]);
    expect(seen).toBe(1);
  });

  it('announces again once the suppression window has passed', async () => {
    await refused(() => api.getPost('p_1'));
    expect(seen).toBe(1);
    vi.setSystemTime(clock + 1001);
    await refused(() => api.getPost('p_1'));
    expect(seen).toBe(2);
  });

  it('still rejects every suppressed request individually', async () => {
    const errs = await Promise.all([
      refused(() => api.getPost('p_1')),
      refused(() => api.getPost('p_2')),
    ]);
    expect(errs.every((e) => e instanceof AuthExpiredError)).toBe(true);
  });

  it('does not announce for any other status', async () => {
    serve(403, { error: 'forbidden' });
    await refused(() => api.savePost('p_1', {}));
    expect(seen).toBe(0);
  });
});

// ----------------------------------------------------------- what gets retried

describe('transient', () => {
  /**
   * THE RETRY POLICY'S ONLY INPUT. Spec §8: 5xx, 429 and network failures are
   * worth asking again; 401/403/404/409/422 never become true, so classing one
   * of them transient is a client spending ~30 seconds re-asking a question
   * with one permanent answer.
   */
  const PERMANENT: [number, unknown][] = [
    [400, { error: 'bad_request', detail: 'body' }],
    [401, { error: 'unauthenticated' }],
    [403, { error: 'forbidden' }],
    [404, { error: 'gone' }],
    [409, { error: 'stale_write', expected: 1, actual: 2, post: post() }],
    [409, { error: 'precondition_failed', operation: 'publish', post: post() }],
    [422, { error: 'invalid_document', path: 'content.0', reason: 'bad_protocol' }],
  ];

  it.each(PERMANENT)('%i is permanent', async (status, body) => {
    serve(status, body);
    const err = (await refused(() => api.savePost('p_1', {}))) as ApiError;
    expect(err.transient).toBe(false);
  });

  it.each([429, 500, 502, 503])('%i is transient', async (status) => {
    serve(status, { error: status === 429 ? 'rate_limited' : 'internal' });
    const err = (await refused(() => api.savePost('p_1', {}))) as ApiError;
    expect(err.transient).toBe(true);
  });

  it('treats a fetch rejection as OfflineError, not as a 5xx', async () => {
    // Plan §2.2 I3 turns on the difference: an authoritative 401 at boot clears
    // the cache and a dropped connection must never do the same thing.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await refused(() => api.getPost('p_1'));
    expect(err).toBeInstanceOf(OfflineError);
    expect(err).toMatchObject({ status: 0, transient: true });
  });
});

// ------------------------------------------------------------------- the body

describe('the error body', () => {
  it('takes the code from the body rather than inventing a message', async () => {
    serve(422, { error: 'invalid_document', path: 'content.1.attrs.src', reason: 'bad_protocol' });
    const err = (await refused(() => api.savePost('p_1', {}))) as ApiError;
    expect(err).toMatchObject({ code: 'invalid_document', detail: 'content.1.attrs.src' });
    // `reason` stays reachable: plan §2.3's `blocked` rows quote both halves.
    expect((err.body as { reason: string }).reason).toBe('bad_protocol');
  });

  it('keeps the 400 detail, which names the field and never its value', async () => {
    serve(400, { error: 'bad_request', detail: 'posts.0.migratedAt' });
    const err = (await refused(() => api.importBundle({}))) as ApiError;
    expect(err).toMatchObject({ code: 'bad_request', detail: 'posts.0.migratedAt' });
  });

  it('reads retryAfter from the body, and from the header when the body has none', async () => {
    serve(429, { error: 'rate_limited', retryAfter: 42 });
    expect((await refused(() => api.importBundle({}))) as ApiError).toMatchObject({ retryAfter: 42 });

    serve(429, { error: 'rate_limited' }, { 'retry-after': '17' });
    expect((await refused(() => api.importBundle({}))) as ApiError).toMatchObject({ retryAfter: 17 });
  });

  it('carries the requestId a 500 answers with, since it answers with nothing else', async () => {
    serve(500, { error: 'internal', requestId: 'req_9' });
    const err = (await refused(() => api.getPost('p_1'))) as ApiError;
    expect(err).toMatchObject({ status: 500, code: 'internal', requestId: 'req_9' });
  });

  it('survives a non-JSON error body without losing the status', async () => {
    // A proxy's HTML 502 must still become a transient 502 rather than a crash
    // inside the client's own error handling.
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    );
    const err = (await refused(() => api.getPost('p_1'))) as ApiError;
    expect(err).toMatchObject({ status: 502, transient: true, code: 'http_502' });
  });

  it('does not confuse the requestId on a success for an error', async () => {
    serve(200, { post: post({ title: 'ok' }) });
    await expect(api.getPost('p_1')).resolves.toMatchObject({ title: 'ok' });
  });
});

// ------------------------------------------------------------------- wiring

describe('wiring', () => {
  /**
   * `useAutosave.ts:98` — a frozen file — halts into the conflict banner on
   * `err instanceof StaleWriteError`, importing it from `./posts`. If that ever
   * stops being the same class object the check is silently false and every
   * conflict becomes a generic retry.
   */
  it('re-exports the one StaleWriteError from posts.ts', () => {
    expect(ReExported).toBe(StaleWriteError);
  });

  it('keeps the message the local class raised before it moved', () => {
    expect(new StaleWriteError(4, 6).message).toBe(
      'Stale write: based on revision 4, store is at 6',
    );
  });

  it('answers a 403 with ForbiddenError', async () => {
    serve(403, { error: 'forbidden' });
    expect(await refused(() => api.savePost('p_1', {}))).toBeInstanceOf(ForbiddenError);
  });

  it('exposes apiFetch for a route this object does not wrap', async () => {
    serve(200, { ok: true });
    await expect(apiFetch<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
    expect(lastCall()[0]).toBe('/api/health');
  });
});

/**
 * The curated rail's two refusals.
 *
 * BOTH ARE ABOUT A COLLECTION, WHICH IS WHY THEY NEED THEIR OWN CLASSES. The
 * two 409s already here carry a `post` and are drawn by the editor's conflict
 * banner; these carry the RAIL and are drawn by the featured manager. Mapped to
 * a bare `ApiError` they would arrive with `items` buried in `body` as
 * `unknown`, and the one thing the storefront's contract asks for — that a
 * refused fifth feature names the current four so a swap can be offered — would
 * be unreachable without a cast at every call site.
 */
describe('featured refusals', () => {
  const item = (id: string, rank: number) => ({
    id,
    slug: id,
    title: id.toUpperCase(),
    coverImage: null,
    publishedAt: 1,
    rank,
  });

  it('maps a 409 featured_full to an error carrying the current rail', async () => {
    const items = [item('p_a', 1), item('p_b', 2), item('p_c', 3), item('p_d', 4)];
    serve(409, { error: 'featured_full', limit: 4, items });

    const err = (await refused(() => api.featurePost('p_e'))) as FeaturedConflictError;
    expect(err).toBeInstanceOf(FeaturedConflictError);
    expect(err.reason).toBe('featured_full');
    expect(err.limit).toBe(4);
    expect(err.items.map((i) => i.id)).toEqual(['p_a', 'p_b', 'p_c', 'p_d']);
  });

  it('maps a 409 featured_stale to the same class, with the other reason', async () => {
    serve(409, { error: 'featured_stale', limit: 4, items: [item('p_a', 1)] });
    const err = (await refused(() =>
      api.reorderFeatured(['p_a', 'p_b']),
    )) as FeaturedConflictError;
    expect(err).toBeInstanceOf(FeaturedConflictError);
    // ONE CLASS, TWO REASONS: the body is identical and only the sentence above
    // it differs, so a caller branches on `reason` rather than on the class.
    expect(err.reason).toBe('featured_stale');
  });

  it('does not mistake a featured 409 for a stale write', async () => {
    serve(409, { error: 'featured_full', limit: 4, items: [] });
    const err = await refused(() => api.featurePost('p_e'));
    // The editor's banner reads `expected`/`actual` off a `StaleWriteError`;
    // handed this it would draw a conflict between two undefined revisions.
    expect(err).not.toBeInstanceOf(StaleWriteError);
    expect(err).not.toBeInstanceOf(PreconditionFailedError);
  });

  it('maps a 422 not_featurable, keeping the reason', async () => {
    serve(422, { error: 'not_featurable', reason: 'draft' });
    const err = (await refused(() => api.featurePost('p_a'))) as NotFeaturableError;
    expect(err).toBeInstanceOf(NotFeaturableError);
    // What the toggle's message is written from: "Publish this post first" is a
    // different sentence from "this post is in the trash".
    expect(err.reason).toBe('draft');
  });

  it('classes both as permanent, so nothing retries them', async () => {
    serve(409, { error: 'featured_full', limit: 4, items: [] });
    expect(((await refused(() => api.featurePost('p_e'))) as ApiError).transient).toBe(false);
    serve(422, { error: 'not_featurable', reason: 'draft' });
    expect(((await refused(() => api.featurePost('p_a'))) as ApiError).transient).toBe(false);
  });
});
