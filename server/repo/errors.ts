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
