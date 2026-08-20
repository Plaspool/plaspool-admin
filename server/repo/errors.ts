import type { DocViolation } from '../../shared/validate';
import type { FeaturedItem, Post } from '../../shared/types';

/**
 * The domain errors the write path raises, and the only ones a route has to map
 * onto spec §8. Anything else reaching a route is a bug and becomes a 500.
 */

/**
 * The CAS lost: the stored row moved on from the revision this write derived
 * from.
 *
 * It carries BOTH sides and the current post because spec §4.3's 409 body is
 * `{ error, expected, actual, post }` — so "Load theirs" in the conflict banner
 * renders with no second round trip. `post` is nullable only because the row
 * can be destroyed between the losing CAS and the re-read.
 */
export class StaleWriteError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly post: Post | null;

  constructor(expected: number, actual: number, post: Post | null = null) {
    super(`Stale write: based on revision ${expected}, store is at ${actual}`);
    this.name = 'StaleWriteError';
    this.expected = expected;
    this.actual = actual;
    this.post = post;
  }
}

/**
 * 409 `{ error: 'precondition_failed', operation, post }`. The lifecycle op was
 * REFUSED, not lost: the post is already in the state being asked for.
 *
 * Separate from `StaleWriteError` because the two need different words in the
 * UI and different handling in a client. A stale write means "someone else got
 * there first, here is theirs, choose"; this means "there is nothing to do —
 * the post is already published". Reported as a `StaleWriteError` it arrived
 * with `expected === actual`, which is not a conflict any conflict banner can
 * render and not something a route layer could tell apart from a real race
 * without inspecting two numbers for equality and guessing.
 *
 * `post` is non-null: this error is only ever raised from a read that found the
 * row, so the caller always gets the state that refused it.
 */
export class PreconditionFailedError extends Error {
  readonly operation: string;
  readonly post: Post;

  constructor(operation: string, post: Post) {
    super(`Cannot ${operation}: the post is already in that state`);
    this.name = 'PreconditionFailedError';
    this.operation = operation;
    this.post = post;
  }
}

/**
 * 400 `{ error: 'bad_request', detail }`. A request the server can parse but
 * cannot honour: a page limit outside its range, a cursor that does not decode.
 *
 * It exists so those cases are not 500s. A 500 is transient by the client's
 * retry policy (spec §8) and would be retried five times with backoff for a
 * request that can never succeed; a 400 stops immediately and names the field.
 */
export class BadRequestError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'BadRequestError';
    this.detail = detail;
  }
}

/** 404 `{ error: 'gone' }`. Absent or destroyed — the client cannot tell. */
export class NotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Post ${id} not found`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/**
 * 422 `{ error: 'invalid_document', path }`. Never a silent repair — a document
 * this refuses is one the writer must be told about, because the alternative is
 * storing something subtly different from what they wrote.
 *
 * `reason` is additive beyond the plan's interface: the path alone says where
 * but not what, and a log line that cannot distinguish `too_deep` from
 * `bad_protocol` cannot tell an attack from a paste.
 */
export class InvalidDocumentError extends Error {
  readonly path: string;
  readonly reason: DocViolation['reason'];

  constructor(violation: DocViolation) {
    super(`Invalid document at ${violation.path}: ${violation.reason}`);
    this.name = 'InvalidDocumentError';
    this.path = violation.path;
    this.reason = violation.reason;
  }
}

/**
 * 422 `{ error: 'not_featurable', reason }`. The post cannot go on the curated
 * rail because it is not publicly visible.
 *
 * A 422 AND NOT A 409, because nothing raced: the row is exactly as the caller
 * left it, and the request is refused rather than lost. And not a 400, because
 * the request was well-formed — the post named is real and the caller is
 * allowed to touch it; the state is what refuses.
 *
 * `reason` NAMES THE STATE, so the admin can say "publish this first" rather
 * than "no". A featured draft would be a post that holds one of four slots and
 * is invisible to every reader, which is the failure this exists to prevent.
 */
export type NotFeaturableReason =
  | 'draft'
  | 'archived'
  | 'trashed'
  | 'no_slug'
  | 'no_publish_date';

export class NotFeaturableError extends Error {
  readonly id: string;
  readonly reason: NotFeaturableReason;

  constructor(id: string, reason: NotFeaturableReason) {
    super(`Post ${id} cannot be featured: ${reason}`);
    this.name = 'NotFeaturableError';
    this.id = id;
    this.reason = reason;
  }
}

/**
 * 409 `{ error: reason, limit, items }`. The rail cannot take this change in
 * the state it is actually in.
 *
 * IT CARRIES THE CURRENT RAIL, AND THAT IS THE WHOLE POINT. The storefront's
 * contract asks for it by name: the 409 "should NAME the current four so the
 * admin UI can offer 'unfeature one of these' instead of a dead error". An
 * error the operator can only acknowledge is one they will work around by
 * guessing.
 *
 * TWO REASONS, ONE ERROR, because they need the same body and differ only in
 * the sentence above it:
 *
 * - `featured_full` — four are featured and a fifth was asked for. The offer is
 *   a swap.
 * - `featured_stale` — the rail moved between the render and the request: a
 *   reorder that is not a permutation of what is featured now, or a swap naming
 *   a post that has already left. The offer is to re-render from `items`.
 *
 * Separate from `PreconditionFailedError` and `StaleWriteError` despite sharing
 * a status: those two are about ONE post's revision, carry `post`, and are
 * rendered by the editor's conflict banner. This is about a collection, carries
 * `items`, and is rendered by the featured manager.
 */
export class FeaturedConflictError extends Error {
  readonly reason: 'featured_full' | 'featured_stale';
  readonly items: FeaturedItem[];
  readonly limit: number;

  constructor(
    reason: 'featured_full' | 'featured_stale',
    items: FeaturedItem[],
    limit: number,
  ) {
    super(
      reason === 'featured_full'
        ? `The featured rail is full (${limit})`
        : 'The featured rail changed since it was read',
    );
    this.name = 'FeaturedConflictError';
    this.reason = reason;
    this.items = items;
    this.limit = limit;
  }
}
