import type { ZodError, ZodType } from 'zod';
import type { Context } from 'hono';
import {
  BadRequestError,
  InvalidDocumentError,
  NotFoundError,
  PreconditionFailedError,
  StaleWriteError,
} from '../repo/errors';
import {
  DuplicateEmailError,
  InviteError,
  UserInputError,
} from '../repo/users';

/**
 * The error contract (spec §8), in one place.
 *
 * | Condition                       | Status | Body                                           |
 * | ------------------------------- | ------ | ---------------------------------------------- |
 * | Not authenticated               | 401    | `{ error: 'unauthenticated' }`                  |
 * | Authenticated, not permitted    | 403    | `{ error: 'forbidden' }`                        |
 * | Post absent or destroyed        | 404    | `{ error: 'gone' }`                             |
 * | Malformed request               | 400    | `{ error: 'bad_request', detail }`              |
 * | Document fails validation       | 422    | `{ error: 'invalid_document', path }`           |
 * | CAS lost                        | 409    | `{ error: 'stale_write', expected, actual, post }` |
 * | Lifecycle op refused, no race   | 409    | `{ error: 'precondition_failed', operation, post }` |
 * | Rate limited                    | 429    | `{ error: 'rate_limited', retryAfter }`         |
 * | Unhandled                       | 500    | `{ error: 'internal', requestId }`              |
 *
 * TWO RULES DECIDE EVERY LINE BELOW.
 *
 * **A 500 is transient by the client's retry policy** (spec §8): 5xx and
 * network errors are retried five times with backoff, while 401/403/404/409/422
 * stop. So every input that can never be accepted has to be a 4xx — a NUL byte,
 * a cursor from another sort, an unknown body key — or the client spends 30
 * seconds re-asking a question that has one permanent answer. Anything that
 * falls through to 500 here is a bug in this table, not a bug in the client.
 *
 * **Nothing that is not on the table is described to the caller.** A 500 body
 * is exactly `{ error, requestId }`: no message, no stack, no SQLSTATE. The
 * detail goes to the log beside the same `requestId`, which is what makes an
 * incident traceable without making the error surface an information channel.
 */

/** 401. Thrown by `requireAuth()`; there is no session. */
export class UnauthenticatedError extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * 403. A session exists and is not permitted — a foreign `Origin`, a writer
 * reaching for an owner-only route, a writer editing someone else's post.
 *
 * DELIBERATELY THE SAME ANSWER FOR ALL THREE. A 403 that explained which of
 * them applied would tell an unauthenticated caller whether a post exists and
 * whether they wrote it.
 */
export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

/** 429, carrying the seconds until the window ends. */
export class RateLimitedError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('rate_limited');
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
  }
}

interface Mapped {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

function map(err: unknown): Mapped | null {
  if (err instanceof UnauthenticatedError) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: 'forbidden' } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: 'gone' } };
  }
  if (err instanceof BadRequestError) {
    return { status: 400, body: { error: 'bad_request', detail: err.detail } };
  }
  if (err instanceof InvalidDocumentError) {
    /*
     * `reason` rides along beside the spec's `path`. The path says WHERE and
     * the reason says WHAT, and a client that cannot tell `too_deep` from
     * `bad_protocol` can only say "this document is invalid" to a writer who
     * has just lost the ability to save.
     */
    return {
      status: 422,
      body: { error: 'invalid_document', path: err.path, reason: err.reason },
    };
  }
  if (err instanceof StaleWriteError) {
    return {
      status: 409,
      body: {
        error: 'stale_write',
        expected: err.expected,
        actual: err.actual,
        // Spec §4.3: the server's current post rides along so the conflict
        // banner's "Load theirs" renders with no second round trip.
        post: err.post,
      },
    };
  }
  if (err instanceof PreconditionFailedError) {
    /*
     * A DIFFERENT 409 FROM `stale_write`, and that is the point (spec §4.2).
     * "The post is already published" is not "someone else got there first";
     * collapsed into one, the refusal arrived with `expected === actual`, which
     * no conflict banner can render and which a client could only tell apart
     * from a real race by comparing two numbers and guessing.
     */
    return {
      status: 409,
      body: {
        error: 'precondition_failed',
        operation: err.operation,
        post: err.post,
      },
    };
  }
  if (err instanceof RateLimitedError) {
    return {
      status: 429,
      body: { error: 'rate_limited', retryAfter: err.retryAfter },
      // The standard header as well as the body: a proxy or a browser devtool
      // reads this one, and it costs nothing to be honest in both places.
      headers: { 'Retry-After': String(err.retryAfter) },
    };
  }

  /*
   * The repo's user-facing errors, which have no row of their own in §8.
   *
   * All three are permanent conditions the caller can act on, so all three are
   * 400 rather than 500 — a 500 would be retried five times for an invite that
   * will never become valid and a password that will never become long enough.
   * `detail` names the FIELD and never the value: `UserInputError` is thrown
   * about a password, and a message echoing one into a response is a password
   * in a log the first time anyone captures traffic.
   */
  if (err instanceof UserInputError) {
    return { status: 400, body: { error: 'bad_request', detail: err.field } };
  }
  if (err instanceof InviteError) {
    return { status: 400, body: { error: 'bad_request', detail: 'invite' } };
  }
  if (err instanceof DuplicateEmailError) {
    return { status: 400, body: { error: 'bad_request', detail: 'email' } };
  }

  return null;
}

/**
 * What gets logged for a 500, and what does not.
 *
 * `guardDb` has already discarded the driver error — a `DrizzleQueryError`
 * carries `Failed query: INSERT INTO users …\nparams: alice@example.com,scrypt$…`
 * in its own message AND its stack, so `console.error(err)` on any 500 path
 * writes an account email and an offline-crackable hash into the log. What
 * arrives here is a `DbError` holding SQLSTATE and relation names only.
 *
 * This function is the second half of that guarantee: it logs NAMED FIELDS
 * rather than the error object, so a future error type carrying a `params` or
 * a `query` property cannot re-open the leak by being passed to `console.error`
 * whole. `stack` is included because it is where a 500 is actually diagnosed
 * from, and because a scrubbed `DbError` builds its own stack from
 * `captureStackTrace` rather than inheriting the driver's.
 */
export function logLine(err: unknown, requestId: string): Record<string, unknown> {
  const e = err instanceof Error ? err : null;
  return {
    requestId,
    name: e?.name ?? typeof err,
    message: e?.message ?? '',
    stack: e?.stack ?? '',
  };
}

/**
 * The one place an error becomes a response.
 *
 * Returns a `Response` rather than taking a `Context`, so it is a pure function
 * of `(error, requestId)` and the whole §8 table can be exercised without an
 * HTTP request — which is what lets every row be pinned, including the rows
 * whose routes do not exist yet.
 */
export function toResponse(err: unknown, requestId: string): Response {
  const mapped = map(err);

  if (!mapped) {
    // eslint-disable-next-line no-console -- the 500 log is the only record of what happened
    console.error('[api]', JSON.stringify(logLine(err, requestId)));
  }

  const { status, body, headers } = mapped ?? {
    status: 500,
    body: { error: 'internal' },
    headers: undefined,
  };

  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-request-id': requestId,
      ...headers,
    },
  });
}

// ------------------------------------------------------------ request bodies

/**
 * The first issue's PATH, and never its value.
 *
 * Zod's own `message` quotes the offending input for several issue codes, and
 * one of the bodies this parses is `{ email, password }`. A `detail` built from
 * `error.message` would put a password in a 400 response the first time
 * somebody submitted one that failed a rule.
 *
 * `unrecognized_keys` carries the rejected names in `keys` rather than in
 * `path`, so those are appended — a key NAME is a field name, not a value, and
 * "which key did you not expect" is the whole of what makes a `.strict()`
 * rejection actionable.
 */
export function zodDetail(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'body';
  const path = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') path.push(...issue.keys);
  return path.join('.') || 'body';
}

/**
 * Parse a JSON body against a `.strict()` schema, or 400.
 *
 * Both failures are 400 and not 500, for the reason at the top of this file: a
 * body that is not JSON and a body carrying an unknown key are permanent, and a
 * 500 would be retried five times before failing anyway.
 */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequestError('body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError(zodDetail(parsed.error));
  return parsed.data;
}

/**
 * As `readJson`, but an ABSENT body is `{}` rather than a 400.
 *
 * `POST /api/posts` creates an empty draft, so `fetch('/api/posts', { method:
 * 'POST' })` with no body at all is the ordinary call. `c.req.json()` throws on
 * an empty string, which would make the simplest possible request the one that
 * fails.
 */
export async function readJsonOrEmpty<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError('body');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError(zodDetail(parsed.error));
  return parsed.data;
}

/** As `readJson`, for query strings. */
export function readQuery<T>(c: Context, schema: ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new BadRequestError(zodDetail(parsed.error));
  return parsed.data;
}
