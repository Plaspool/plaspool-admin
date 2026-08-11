import type { DocViolation } from '../../shared/validate';
import type { Post } from '../../shared/types';

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
