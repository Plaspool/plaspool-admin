import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { encodeCursor, pageLimit, rejectNul, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import { parseOrderNumber } from '../orders/order-number';
import { readOrder } from '../orders/repo/orders';
import type { OrderPage, OrderRead, OrderStatus } from '../orders/repo/orders';

/**
 * Finding ONE order on the admin surface (HANDOFF §1.9, §2 A4).
 *
 * Until this existed the only admin filter was `?status=`, so an operator holding
 * a customer's email or the order number off their receipt had no way to reach
 * the order except by paging the whole list. Both are now exact lookups.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BOTH BRANCHES ARE EQUALITY AGAINST AN INDEX. NEITHER IS A `LIKE`.
 *
 * - An order number is checked by `parseOrderNumber` BEFORE any statement runs,
 *   so 22 of every 23 mistyped numbers never reach the database at all, and the
 *   one that survives is `order_number = $1` against `shop_orders_order_number_uq`
 *   — at most one row.
 * - An email is `lower(o.email) = lower($1)` against `shop_orders_email_idx`,
 *   which migration 0160 builds on `lower(email)` for exactly this comparison.
 *
 * A SUBSTRING SEARCH IS NOT ON OFFER, and that is a decision rather than an
 * omission. `email LIKE '%bob%'` cannot use that index, so it is a sequential
 * scan of every order in the shop for every keystroke of a debounced search box —
 * and it would also let one customer's address be discovered by typing fragments,
 * on a surface where the whole order table is readable. Exact-match keeps the
 * route O(index) and keeps the box honest: it finds the order you were given, it
 * does not browse.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A MISTYPED ORDER NUMBER IS AN EMPTY PAGE, NOT A 400 — the opposite of
 * `requireOrderNumber`, and the difference is which question is being asked. In
 * `/shop/orders/:orderNumber` the number IS the request, so a failed check
 * character means the request is malformed and 400 is the only answer that tells
 * the caller they typed it wrong. Here it is a search term: a search box that
 * turns red because somebody pasted a truncated number is worse than one that
 * says "no orders". So a term that fails the check character falls through to the
 * email branch, where `lower(email) = '2026-000042-q'` matches nothing — a clean
 * empty result, from an indexed comparison, with no scan.
 */

/**
 * The ordering, and it MUST be the string `server/shop/orders/repo/orders.ts`
 * mints its own cursors under.
 *
 * That module's `SORT_KEY` is private to it, so this is a second copy of a
 * constant — the shape this repository has been bitten by before. What makes it
 * safe is not care, it is a test: `routes.test.ts` mints a cursor from the plain
 * `GET /admin/orders` and spends it on `GET /admin/orders?search=…`, which is a
 * 400 the moment the two strings stop agreeing (`requireCursor` refuses a cursor
 * minted under another ordering). The two pages are the same list with one more
 * predicate, so a cursor has to cross between them.
 */
const SORT_KEY = 'placed';

/**
 * How long a search term may be.
 *
 * 320 is the longest address the auth routes accept (`64 + @ + 255`, RFC 5321),
 * and an order number is 13 characters. Anything longer cannot match either
 * column, so bounding it here means a 4 kB query string is refused before it is
 * bound rather than after it has been compared against every row.
 */
export const MAX_SEARCH_LENGTH = 320;

export interface OrderSearchQuery {
  /** Trimmed by the caller. An empty string must not reach here — see the route. */
  search: string;
  status?: OrderStatus;
  /** Same filter the unsearched list takes, so the two cannot disagree. */
  source?: 'online' | 'manual';
  cursor?: string;
  limit?: number;
}

/**
 * The scope for one search term: an exact order number, or an exact address.
 *
 * SEPARATED FROM THE QUERY so the decision is a value a test can assert on
 * directly. "Which branch did this term take" is the whole of the behaviour, and
 * inferring it from a row count only works when there are rows.
 */
export function searchScope(term: string): SQL {
  return parseOrderNumber(term) !== null
    ? sql`o.order_number = ${term}`
    : sql`lower(o.email) = lower(${term})`;
}

/**
 * One page of orders matching an exact term, newest first.
 *
 * TWO STATEMENTS, AND THE SECOND IS A FAN-OUT RATHER THAN A JOIN. The first
 * resolves the page — ids and their sort key, straight off an index. The second
 * is `readOrder` per id, issued in parallel.
 *
 * WHY NOT ONE STATEMENT. Because the one statement already exists: `listOrders`
 * in `server/shop/orders/repo/orders.ts` selects the same columns with the same
 * line aggregation and maps them with `rowToOrder`/`rowToLine`, neither of which
 * is exported. Rewriting it here would be a SECOND PROJECTION of the order row —
 * and the failure mode of that is not a crash, it is a field added to `Order`
 * next month that appears on the unfiltered list and is missing from the search
 * results, with nothing to report it. This repository has paid for that mistake
 * twice (two copies of a sort key that disagreed became a page boundary that
 * skipped rows; three copies of a schema block became two silently lost blocks).
 * Reusing the single mapping costs at most `limit` extra round trips on a route a
 * human triggers by typing into a box, all of them concurrent.
 *
 * The right end state is `listAllOrders` taking a search scope and this function
 * disappearing into it; that file belongs to another workstream in this build.
 */
export async function searchOrders(db: Db, q: OrderSearchQuery): Promise<OrderPage> {
  const size = pageLimit(q.limit);
  const term = rejectNul(q.search, 'search');
  if (term.length > MAX_SEARCH_LENGTH) throw new BadRequestError('search');

  const where: SQL[] = [searchScope(term)];
  if (q.status !== undefined) where.push(sql`o.status = ${q.status}`);
  if (q.source !== undefined) where.push(sql`o.source = ${q.source}`);

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const placedAt = Number(cursor.sortValues[0]);
    // Coerced to the column's type, as every cursor consumer here does: the
    // payload is base64 JSON anybody can write, and a string against a bigint is
    // SQLSTATE 22P02 — a 500 the client retries five times for nothing.
    if (!Number.isFinite(placedAt)) throw new BadRequestError('cursor');
    where.push(sql`(o.placed_at < ${placedAt}
                    OR (o.placed_at = ${placedAt} AND o.id > ${cursor.id}))`);
  }

  const page = await db.execute(sql`
    SELECT o.id, o.placed_at
      FROM shop_orders o
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY o.placed_at DESC, o.id ASC
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT, exactly as `listOrders` does it.
  const rows = page.rows.slice(0, size);
  const reads = await Promise.all(rows.map((row) => readOrder(db, String(row.id))));

  /*
   * A `null` here would mean the order vanished between the two statements, which
   * `shop_order_lines`' `ON DELETE RESTRICT` and its `BEFORE DELETE` trigger make
   * unreachable — an order is a financial record and nothing in this application
   * deletes one. Dropped rather than thrown anyway: a search that 500s because a
   * row moved is a worse answer than a search that returns the rows it found.
   */
  const items = reads
    .filter((read): read is OrderRead => read !== null)
    .map((read) => ({ order: read.order, lines: read.lines }));

  const last = rows[rows.length - 1];
  const more = page.rows.length > size;
  return {
    items,
    nextCursor:
      more && last
        ? encodeCursor(SORT_KEY, [Number(last.placed_at)], String(last.id))
        : null,
  };
}

/**
 * One order by its CUSTOMER-FACING number, for the admin surface.
 *
 * The number is what a customer reads off their receipt and quotes on the phone;
 * `shop_orders.id` is what the admin routes address. Without this route the
 * operator's only path from one to the other was to page the list until they saw
 * it. `shop_orders_order_number_uq` makes the lookup a single-row index hit.
 *
 * TWO STATEMENTS AGAIN, AND FOR THE SAME REASON AS `searchOrders`: the id lookup,
 * then `readOrder` — the ONE order projection — rather than a second copy of it
 * here. One extra round trip on a route a human triggers.
 *
 * THIS IS NOT AN AUTHORIZATION BOUNDARY AND MUST NEVER BECOME ONE. The order
 * number is sequential by construction and therefore guessable, which is why the
 * customer-facing `/shop/orders/:orderNumber` scopes every lookup by a resolved
 * customer id or a signed token. This function is unscoped, so it is safe only
 * behind `requireAuth()` at the route — where every other admin order read
 * already sits.
 */
export async function readOrderByNumber(
  db: Db,
  orderNumber: string,
): Promise<OrderRead | null> {
  const res = await db.execute(sql`
    SELECT o.id FROM shop_orders o WHERE o.order_number = ${orderNumber}`);
  const row = res.rows[0];
  return row ? readOrder(db, String(row.id)) : null;
}
