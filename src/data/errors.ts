import type { FeaturedItem, Post } from './types';

/**
 * Spec §8's error table, as classes the client can branch on.
 *
 * HERE RATHER THAN IN `api.ts`, and that is not filing. `src/data/posts.ts`
 * throws `StaleWriteError` and will call `api.ts`, so a class living in
 * `api.ts` closes an import cycle `posts.ts` → `api.ts` → `posts.ts`. This
 * module imports types only, so it can never be one end of one.
 *
 * `useAutosave.ts:98` does `err instanceof StaleWriteError` against the class
 * `posts.ts` re-exports, which is this object — a second declaration anywhere
 * would make that check silently false and turn every conflict into a generic
 * retry loop.
 *
 * The table these mirror is in `server/middleware/errors.ts`. Two of its rows
 * are the reason this file has more than one class in it; both are marked
 * below.
 */

/**
 * WHICH FAILURES ARE WORTH ASKING AGAIN, IN ONE FUNCTION.
 *
 * Spec §8: 5xx and network errors are retried with backoff and
 * 401/403/404/409/422 stop. A permanent condition classed as transient is a
 * client spending ~30 seconds re-asking a question with one permanent answer —
 * the server's own error table is built around never producing one, so the
 * client must not invent them on this side either.
 *
 * `status === 0` means the request never got an answer at all (see
 * `OfflineError`), which is the one genuinely retryable non-status.
 */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export interface ApiErrorInit {
  status: number;
  code: string;
  /**
   * The field, path or reason the server named: `detail` on a 400, `path` on a
   * 422. One field because it plays one role — the thing to show a writer
   * beside "this could not be saved".
   */
  detail?: string;
  /** The parsed response body, or `undefined` when there was not one. */
  body?: unknown;
  /** Seconds, from a 429's body and `Retry-After` header. */
  retryAfter?: number;
  /**
   * The server's correlation id. Every error body carries one and a 500's body
   * carries nothing else — `server/middleware/errors.ts` deliberately logs the
   * detail beside the same id rather than returning it — so this is the whole
   * of what makes a 500 diagnosable from a bug report.
   */
  requestId?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly body: unknown;
  readonly retryAfter?: number;
  readonly requestId?: string;
  /** See `isTransientStatus`. Never true for 401/403/404/409/422. */
  readonly transient: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message ?? (init.detail ? `${init.code}: ${init.detail}` : init.code));
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.body = init.body;
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
    this.transient = isTransientStatus(init.status);
  }
}

/**
 * 409 `{ error: 'stale_write', expected, actual, post }` — the CAS lost.
 *
 * `post` IS THE SERVER'S CURRENT POST, CONTENT AND ALL. Verified rather than
 * assumed: `server/repo/posts.ts` hands `StaleWriteError` the result of
 * `getPost`, which maps `POST_COLUMNS` through `rowToPost`, and `content` is in
 * that list (`server/repo/mapping.ts`). That is what lets the conflict banner's
 * "Load theirs" render with no second request, and what makes it safe for the
 * caller to write this post into the editor's own store — a projection without
 * `content` reaching there is the defect plan §2.1 exists to prevent.
 *
 * THE TWO-ARGUMENT FORM IS THE PRE-CUTOVER PATH. `src/data/posts.ts` still
 * raises this against IndexedDB, where there is no response and no server post.
 * 409 is the honest status for it anyway: it is the same condition, decided
 * locally, and classing it as anything else would make the local path retryable
 * when the network one is not.
 */
export class StaleWriteError extends ApiError {
  readonly expected: number;
  readonly actual: number;
  readonly post: Post | null;

  constructor(expected: number, actual: number, post: Post | null = null, init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 409,
      code: 'stale_write',
      // Byte-identical to the message this class carried before it moved here,
      // so anything reading it — a toast, a log line — reads what it used to.
      message: `Stale write: based on revision ${expected}, store is at ${actual}`,
    });
    this.name = 'StaleWriteError';
    this.expected = expected;
    this.actual = actual;
    this.post = post;
  }
}

/**
 * 409 `{ error: 'precondition_failed', operation, post }` — the lifecycle op was
 * REFUSED, not lost.
 *
 * A DIFFERENT CLASS FROM `StaleWriteError`, AND THAT IS THE WHOLE POINT.
 * "The post is already published" is not "someone else got there first".
 * Collapsed into one class the refusal arrives with `expected === actual`,
 * which is not a conflict any conflict banner can render — the server split
 * these two for exactly this reason (`server/repo/errors.ts`) and merging them
 * on this side would throw the distinction away one layer later.
 *
 * `post` is non-null: the server only raises this from a read that found the
 * row, so the caller always gets the state that refused it.
 */
export class PreconditionFailedError extends ApiError {
  readonly operation: string;
  readonly post: Post;

  constructor(operation: string, post: Post, init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 409,
      code: 'precondition_failed',
      message: `Cannot ${operation}: the post is already in that state`,
    });
    this.name = 'PreconditionFailedError';
    this.operation = operation;
    this.post = post;
  }
}

/**
 * 404 `{ error: 'gone' }`.
 *
 * THIS MESSAGE MAY NOT BE REWORDED. `src/editor/useAutosave.ts:103` is frozen
 * by plan §0 F1 and decides that the post was destroyed with
 * `/not found/i.test(err.message)` — a regex over this string is the entire
 * mechanism, so a friendlier wording here turns "this post no longer exists"
 * into a generic error the autosave loop retries five times against a post that
 * will never come back. `api.test.ts`'s frozen-probe case fails if either side
 * drifts.
 *
 * `subject` exists because the same 404 answers for images, revisions and
 * invites, and "Post img_9 not found" is a sentence no writer should be shown.
 * Every form still satisfies the probe; only the post form is what
 * `useAutosave` can ever see, because the only route it calls is
 * `PATCH /posts/:id`.
 */
export class NotFoundError extends ApiError {
  readonly id: string;

  constructor(id: string, subject = 'Post', init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 404,
      code: 'gone',
      message: `${subject} ${id} not found`,
    });
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/**
 * 401 `{ error: 'unauthenticated' }`.
 *
 * Raised for the caller AND announced once per burst as an `auth-expired`
 * event — see `api.ts`. Permanent: re-sending the same request without a
 * session cannot succeed, and plan §2.2 I3 turns on a mid-session 401 raising
 * inline re-auth rather than anything destructive.
 */
export class AuthExpiredError extends ApiError {
  constructor(init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 401,
      code: 'unauthenticated',
      message: 'Your session has expired',
    });
    this.name = 'AuthExpiredError';
  }
}

/**
 * 403 `{ error: 'forbidden' }`.
 *
 * The server answers this identically for a foreign `Origin`, an owner-only
 * route and someone else's post, deliberately, so this class cannot tell them
 * apart either. Plan §3 case 3 is what stops the common one being reached at
 * all: a writer opening a colleague's post gets a read-only view rather than an
 * editor whose every save 403s (F14).
 */
export class ForbiddenError extends ApiError {
  constructor(init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 403,
      code: 'forbidden',
      message: 'You do not have permission to do that',
    });
    this.name = 'ForbiddenError';
  }
}

/**
 * No answer at all — `fetch` itself rejected.
 *
 * Status 0 rather than a 5xx: nothing was served, so there is no row of spec
 * §8's table to claim. It is transient by `isTransientStatus`, which is the
 * behaviour that matters — and plan §2.2 I3 leans on the distinction from a
 * real 401 hard enough that collapsing the two would clear a writer's whole
 * cache the first time a connection dropped.
 */
export class OfflineError extends ApiError {
  constructor(init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 0,
      code: 'offline',
      message: 'Could not reach the server',
    });
    this.name = 'OfflineError';
  }
}

/**
 * 409 `{ error: 'featured_full' | 'featured_stale', limit, items }` — the
 * curated rail cannot take this change in the state it is actually in.
 *
 * A THIRD 409 CLASS, AND IT CARRIES A COLLECTION RATHER THAN A POST. The two
 * above are about one post's revision and are drawn by the editor's conflict
 * banner; this is about the rail and is drawn by the featured manager. Left as
 * a bare `ApiError` the list would sit in `body` as `unknown`, and the one
 * thing the storefront's contract asks of this refusal — that it NAME the
 * current four so the admin can offer "unfeature one of these" instead of a
 * dead error — would need a cast at every call site.
 *
 * ONE CLASS, TWO REASONS, unlike the split above. `featured_full` and
 * `featured_stale` carry the identical body and differ only in the sentence
 * printed over it, so a caller branches on `reason`. Splitting them into two
 * classes would be ceremony over a distinction the renderer already makes.
 */
export class FeaturedConflictError extends ApiError {
  readonly reason: 'featured_full' | 'featured_stale';
  readonly items: FeaturedItem[];
  readonly limit: number;

  constructor(
    reason: 'featured_full' | 'featured_stale',
    items: FeaturedItem[],
    limit: number,
    init?: Partial<ApiErrorInit>,
  ) {
    super({
      ...init,
      status: 409,
      code: reason,
      message:
        reason === 'featured_full'
          ? `Only ${limit} posts can be featured at once`
          : 'The featured posts changed while you were editing them',
    });
    this.name = 'FeaturedConflictError';
    this.reason = reason;
    this.items = items;
    this.limit = limit;
  }
}

/**
 * 422 `{ error: 'not_featurable', reason }` — the post is not publicly visible,
 * so it cannot go on the rail.
 *
 * `reason` IS WHAT THE MESSAGE IS WRITTEN FROM. "Publish this post first" and
 * "this post is in the trash" are different things to tell a writer, and the
 * toggle's tooltip is the place they get told. A generic `ApiError` would put
 * the reason in `body` as `unknown` and leave the UI guessing from the status.
 */
export type NotFeaturableReason =
  | 'draft'
  | 'archived'
  | 'trashed'
  | 'no_slug'
  | 'no_publish_date';

export class NotFeaturableError extends ApiError {
  readonly reason: NotFeaturableReason;

  constructor(reason: NotFeaturableReason, init?: Partial<ApiErrorInit>) {
    super({
      ...init,
      status: 422,
      code: 'not_featurable',
      message: NOT_FEATURABLE_MESSAGE[reason] ?? 'This post cannot be featured yet',
    });
    this.name = 'NotFeaturableError';
    this.reason = reason;
  }
}

/**
 * One sentence per reason, HERE rather than in a component.
 *
 * The toggle's tooltip, the manager's toast and the swap dialog all have to say
 * the same thing about the same state; three copies drift, and the one that
 * drifts is the one nobody has looked at since.
 */
export const NOT_FEATURABLE_MESSAGE: Record<NotFeaturableReason, string> = {
  draft: 'Publish this post before featuring it',
  archived: 'Archived posts cannot be featured',
  trashed: 'Posts in the trash cannot be featured',
  no_slug: 'This post has no address yet — publish it to give it one',
  no_publish_date: 'This post has no publish date, so it cannot be featured',
};
