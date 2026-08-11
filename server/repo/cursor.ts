import { BadRequestError } from './errors';

/**
 * Keyset pagination, shared by the revision list and the post list.
 *
 * WHY KEYSET AND NOT OFFSET (spec §5.2). `OFFSET 24` re-counts the whole
 * preceding set on every page against a table that is being written to while
 * the reader scrolls: a post inserted above the window pushes one row down past
 * the boundary and it is never seen, and a post deleted above the window pulls
 * one up and it is seen twice. Neither shows up as an error anywhere. A cursor
 * naming the last row seen cannot skip or duplicate, because the next page is
 * defined relative to a row rather than to a count.
 *
 * THE CURSOR CARRIES A TUPLE, NOT A SCALAR. The plan's `{ sortValue, id }`
 * cannot express `drafts-first`, which orders on `(statusRank, updatedAt)` —
 * and the plan says so itself, offering "extend the cursor to
 * `{ v: (number|string)[], id }` … or exclude `drafts-first` from cursor
 * pagination". Extending is the choice made here: excluding it would mean the
 * one view a writer lives in cannot be scrolled, which is a worse answer than a
 * slightly wider codec. One codec for every sort key also means one place where
 * an undecodable cursor is handled.
 *
 * AND IT CARRIES THE SORT KEY THAT MINTED IT. Spec §5.2 requires the cursor to
 * match the active sort, and nothing outside the payload can enforce that: a
 * width comparison cannot tell `updated`, `published`, `oldest` and
 * `alphabetical` apart, because all four are one component wide. Spending an
 * `alphabetical` cursor (text) under `updated` (bigint) raised SQLSTATE 22P02,
 * which scrubs to a `DbError` and answers 500 — a status the client's policy
 * retries five times for a request that can never succeed. The other direction
 * did not error at all: measured on an 8-post corpus, a `published` cursor
 * spent under `oldest` returned 2 of 8 rows and silently skipped six. A
 * dashboard changing its sort dropdown mid-scroll reaches both.
 */

/** A single component of a sort key. `null` is a NULL column value. */
export type CursorValue = number | string | null;

/** Spec §5.2: "Default limit 24, max 100." */
export const DEFAULT_PAGE_LIMIT = 24;
export const MAX_PAGE_LIMIT = 100;

interface Decoded {
  /** The ordering this cursor was minted under. */
  sort: string;
  sortValues: CursorValue[];
  id: string;
}

/**
 * Opaque to the client on purpose — base64url of a JSON triple — so the shape
 * can change without becoming a compatibility surface. It is NOT a security
 * boundary: a cursor names a row the caller could already see, every query that
 * consumes one is still scoped by the caller's own filters, and the payload is
 * readable and forgeable by anyone who cares to base64-decode it. Which is
 * exactly why `decodeCursor` re-validates every field rather than trusting the
 * shape it wrote.
 */
export function encodeCursor(
  sort: string,
  sortValues: CursorValue[],
  id: string,
): string {
  return Buffer.from(JSON.stringify([sort, sortValues, id]), 'utf8').toString('base64url');
}

/**
 * `null` for anything that is not a cursor this codec produced — never a throw.
 *
 * A cursor arrives from a query string, so it is attacker-controlled and the
 * malformed case is ordinary rather than exceptional. Every field is checked:
 * `JSON.parse` on attacker input can yield any shape at all, and a
 * `sortValues` holding an object would reach the query builder as a bound
 * parameter of a type Postgres does not expect.
 *
 * A U+0000 anywhere in a text field makes it undecodable too. Postgres text
 * cannot hold that byte — binding one raises SQLSTATE 22021, which `guardDb`
 * scrubs to a `DbError` and which answers 500 for a request that can never
 * succeed, so it is caught at the boundary like every other malformed field.
 */
export function decodeCursor(cursor: string): Decoded | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [sort, values, id] = parsed as [unknown, unknown, unknown];
  if (typeof sort !== 'string' || sort.length === 0 || hasNul(sort)) return null;
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof id !== 'string' || id.length === 0 || hasNul(id)) return null;
  for (const value of values) {
    const ok = value === null || typeof value === 'number' || typeof value === 'string';
    if (!ok) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'string' && hasNul(value)) return null;
  }
  return { sort, sortValues: values as CursorValue[], id };
}

/**
 * As `decodeCursor`, but for a caller that has to answer a request — and it is
 * where the cursor is bound to the ordering that minted it.
 *
 * `sort` is the ACTIVE ordering. A cursor carrying any other one is a 400 and
 * not a wrong page: the components would be compared against different columns,
 * which either raises a type error the client retries five times or silently
 * returns a page with rows missing from it.
 */
export function requireCursor(cursor: string, sort: string): Decoded {
  const decoded = decodeCursor(cursor);
  if (!decoded || decoded.sort !== sort) throw new BadRequestError('cursor');
  return decoded;
}

/**
 * Written as an escape rather than as a literal, because a raw U+0000 in a
 * source file is invisible in every editor and survives a copy-paste as
 * whitespace.
 */
const NUL = String.fromCharCode(0);

/**
 * U+0000 in a string bound for Postgres `text`.
 *
 * `.trim()` does not remove it and no domain rule forbids it, so it arrives
 * intact from any query string — `?search=%00` is a one-line request — and
 * raises SQLSTATE 22021 at the driver. Spec §8 has no row for 22021, so
 * untranslated it is a 500 the client retries with backoff, forever, for input
 * that can never be accepted. `BadRequestError` is the answer, exactly as it is
 * for a limit out of range or a cursor that does not decode.
 */
export function hasNul(value: string): boolean {
  return value.includes(NUL);
}

/** As `hasNul`, for a caller that has to answer a request. */
export function rejectNul(value: string, field: string): string {
  if (hasNul(value)) throw new BadRequestError(field);
  return value;
}

/**
 * The page size, or a 400.
 *
 * Rejected rather than clamped: a caller asking for 500 rows is asking for
 * something it will not get, and silently handing back 100 makes a truncated
 * page indistinguishable from a complete one — which is how a client that
 * paginates by "did I get fewer than I asked for" stops early.
 */
export function pageLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new BadRequestError('limit');
  }
  return limit;
}
