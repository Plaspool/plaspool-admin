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
 */

/** A single component of a sort key. `null` is a NULL column value. */
export type CursorValue = number | string | null;

/** Spec §5.2: "Default limit 24, max 100." */
export const DEFAULT_PAGE_LIMIT = 24;
export const MAX_PAGE_LIMIT = 100;

interface Decoded {
  sortValues: CursorValue[];
  id: string;
}

/**
 * Opaque to the client on purpose — base64url of a JSON pair — so the shape can
 * change without becoming a compatibility surface. It is NOT a security
 * boundary: a cursor names a row the caller could already see, and every query
 * that consumes one is still scoped by the caller's own filters.
 */
export function encodeCursor(sortValues: CursorValue[], id: string): string {
  return Buffer.from(JSON.stringify([sortValues, id]), 'utf8').toString('base64url');
}

/**
 * `null` for anything that is not a cursor this codec produced — never a throw.
 *
 * A cursor arrives from a query string, so it is attacker-controlled and the
 * malformed case is ordinary rather than exceptional. Every field is checked:
 * `JSON.parse` on attacker input can yield any shape at all, and a
 * `sortValues` holding an object would reach the query builder as a bound
 * parameter of a type Postgres does not expect.
 */
export function decodeCursor(cursor: string): Decoded | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [values, id] = parsed as [unknown, unknown];
  if (!Array.isArray(values) || values.length === 0) return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const value of values) {
    const ok = value === null || typeof value === 'number' || typeof value === 'string';
    if (!ok) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
  }
  return { sortValues: values as CursorValue[], id };
}

/** As `decodeCursor`, but for a caller that has to answer a request. */
export function requireCursor(cursor: string): Decoded {
  const decoded = decodeCursor(cursor);
  if (!decoded) throw new BadRequestError('cursor');
  return decoded;
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
