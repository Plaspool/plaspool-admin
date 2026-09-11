import { sql, type SQL } from 'drizzle-orm';
import { toEpochMs } from '../../db/client';
import type { Db } from '../../db/client';
import { encodeCursor, pageLimit, rejectNul, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import type { OrderStatus } from '../orders/repo/orders';

/**
 * BUYERS, WHICH ARE NOT THE ROWS OF `shop_customers` (HANDOFF §1.9, §2 A4).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GUEST CHECKOUT IS THE WHOLE REASON THIS IS NOT A `SELECT * FROM shop_customers`.
 *
 * Contract §7 makes guest checkout the default path, and `shop_orders.customer_id`
 * is nullable precisely so a stranger can buy something without an account. A
 * customer list read off `shop_customers` therefore shows the people who signed
 * in and omits the people who bought — which on a shop where most orders are
 * guest orders is a list that is mostly empty while the till is busy.
 *
 * So the aggregate is over `shop_orders`, grouped by `lower(email)`, with
 * `shop_customers` LEFT JOINED on for the two things an order does not carry: an
 * account id and a display name. A buyer with no account is a row with
 * `customerId: null` and `displayName: null`, and that is the ORDINARY case, not
 * a degenerate one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `lower(email)` IS THE IDENTITY, EVERYWHERE. The group key, the join predicate,
 * the sort tiebreak and the cursor's id are all the folded address, because
 * `Buyer@Example.test` and `buyer@example.test` are one person and grouping on
 * the raw value would split their history in two — one row saying "3 orders" next
 * to another saying "5", with no way to tell from the screen that they are the
 * same customer. It is the same rule `getOrderForGuest` scopes its lookup by, and
 * migration 0160 builds `shop_orders_email_idx ON shop_orders (lower(email))` for
 * exactly this comparison.
 *
 * THE JOIN CANNOT MULTIPLY ROWS. `shop_customers.email` is UNIQUE
 * (`shop_customers_email_uq`), so at most one account row matches a group — which
 * is why `max(c.id)` below is a way of saying "the one, if there is one" rather
 * than a real aggregate. Stated here because a reader is entitled to check that a
 * join before a GROUP BY is not double-counting the money.
 */

/**
 * The ordering, and the cursor's sort key.
 *
 * Newest buyer first, because the question this list answers is "who has bought
 * recently". One ordering only, for the reason `listOrders` gives about its own:
 * a second sort is a second way for a cursor to be spent against the wrong
 * column, and `server/repo/cursor.ts` measured that silently returning 2 of 8
 * rows is one of the two things that happens when it is.
 */
const SORT_KEY = 'buyer_last_order';

/** `max(o.placed_at)`, written once and used in the SELECT, ORDER BY and keyset. */
const LAST_ORDER_AT = sql.raw('max(o.placed_at)');

/** `lower(o.email)`, likewise — the group key and the keyset tiebreak. */
const EMAIL_KEY = sql.raw('lower(o.email)');

export interface Buyer {
  /** The folded address. It is this row's identity, and the cursor's id. */
  email: string;
  /** Null for a guest — the ordinary case, not an error. */
  customerId: string | null;
  displayName: string | null;
  /** Every order at this address, whatever its status. */
  orderCount: number;
  /** Of those, the ones that were actually paid for. */
  paidCount: number;
  /**
   * Money taken and kept, in MINOR UNITS: `sum(grandTotal - refundedTotal)` over
   * the paid orders only. A pending order is not spend and a fully refunded one
   * is not either.
   */
  totalSpent: number;
  /** The ISO-4217 code the totals are in. See the note on mixed currencies below. */
  currency: string;
  lastOrderAt: number;
  lastOrderId: string;
  lastOrderNumber: string;
  lastOrderStatus: OrderStatus;
}

export interface BuyerQuery {
  cursor?: string;
  limit?: number;
}

export interface BuyerPage {
  items: Buyer[];
  nextCursor: string | null;
}

function rowToBuyer(row: Record<string, unknown>): Buyer {
  return {
    email: String(row.email),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    /*
     * `count(*)::int` and `sum(...)::bigint` in the statement, so the first is a
     * JS number in both drivers and the second is a string under Neon and under
     * the Neon-like PGlite the suites run (spec §9). `Number()` closes both, and
     * the money stays an integer count of minor units on the way through — there
     * is no float anywhere in this path.
     */
    orderCount: Number(row.order_count),
    paidCount: Number(row.paid_count),
    totalSpent: Number(row.total_spent),
    currency: String(row.currency),
    lastOrderAt: toEpochMs(row.last_order_at),
    lastOrderId: String(row.last_order_id),
    lastOrderNumber: String(row.last_order_number),
    lastOrderStatus: row.last_order_status as OrderStatus,
  };
}

/**
 * One page of buyers, most recent purchase first.
 *
 * THE KEYSET IS IN A `HAVING`, NOT A `WHERE`, and it has to be: the sort key is
 * `max(o.placed_at)`, which does not exist until the rows are grouped. A `WHERE`
 * on `o.placed_at` would filter the ORDERS before grouping — so a buyer whose
 * newest order falls after the cursor would come back on the next page with their
 * older orders re-aggregated, reporting a smaller `orderCount` and a smaller
 * `totalSpent` than the same buyer's row on the previous page. The list would
 * paginate and the numbers on it would be wrong, which is worse than either
 * failing outright.
 *
 * ONE CURRENCY PER BUYER, TAKEN FROM THEIR MOST RECENT ORDER. Contract §13 gives
 * the shop a single store currency in v1, so in practice every order of every
 * buyer shares one — but `shop_orders.currency` is per row, and summing two
 * currencies into one integer is the money bug that produces a plausible number
 * nobody can reconcile. What this does instead is sum everything and LABEL the
 * total with the currency of the latest order, which is exactly right while v1's
 * assumption holds and visibly attributable the day it stops.
 */
export async function listBuyers(db: Db, q: BuyerQuery): Promise<BuyerPage> {
  const size = pageLimit(q.limit);
  const having: SQL[] = [];

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const lastOrderAt = Number(cursor.sortValues[0]);
    if (!Number.isFinite(lastOrderAt)) throw new BadRequestError('cursor');
    /*
     * The id half of the cursor is an EMAIL ADDRESS rather than a row id, because
     * a buyer has no row of their own — that is the point of this file. It goes
     * through `rejectNul` before it is bound: the payload is base64 JSON a caller
     * can hand-write, and a U+0000 in a `text` comparison is SQLSTATE 22021, a
     * 500 for input that can never be accepted.
     */
    const email = rejectNul(cursor.id, 'cursor');
    having.push(sql`(${LAST_ORDER_AT} < ${lastOrderAt}
                     OR (${LAST_ORDER_AT} = ${lastOrderAt} AND ${EMAIL_KEY} > ${email}))`);
  }

  const res = await db.execute(sql`
    SELECT ${EMAIL_KEY}                      AS email,
           max(c.id)                         AS customer_id,
           max(c.display_name)               AS display_name,
           count(*)::int                     AS order_count,
           count(o.paid_at)::int             AS paid_count,
           /*
            * Paid orders only, net of refunds. The count above is the same
            * predicate spelled as an aggregate -- count(paid_at) skips NULLs --
            * so the two numbers cannot disagree about which orders are paid.
            */
           COALESCE(sum(o.grand_total - o.refunded_total)
                    FILTER (WHERE o.paid_at IS NOT NULL), 0)::bigint AS total_spent,
           ${LAST_ORDER_AT}                  AS last_order_at,
           /*
            * The newest order's own columns, picked with the SAME ordering the
            * page is sorted by. An ordered array_agg indexed at 1, rather than a
            * correlated subquery: the subquery would be one extra scan per group,
            * and DISTINCT ON cannot be combined with the aggregates above.
            */
           (array_agg(o.id           ORDER BY o.placed_at DESC, o.id ASC))[1] AS last_order_id,
           (array_agg(o.order_number ORDER BY o.placed_at DESC, o.id ASC))[1] AS last_order_number,
           (array_agg(o.status       ORDER BY o.placed_at DESC, o.id ASC))[1] AS last_order_status,
           (array_agg(o.currency     ORDER BY o.placed_at DESC, o.id ASC))[1] AS currency
      FROM shop_orders o
      LEFT JOIN shop_customers c ON c.email IS NOT NULL AND lower(c.email) = ${EMAIL_KEY}
     -- A manual sale recorded with no email (migration 1110) belongs to nobody
     -- here: grouped by email, every one of them would become one blank buyer.
     WHERE o.email <> ''
     GROUP BY ${EMAIL_KEY}
     ${having.length > 0 ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
     ORDER BY ${LAST_ORDER_AT} DESC, ${EMAIL_KEY} ASC
     LIMIT ${size + 1}`);

  const items = res.rows.slice(0, size).map(rowToBuyer);
  const last = items[items.length - 1];
  const more = res.rows.length > size;
  return {
    items,
    nextCursor: more && last ? encodeCursor(SORT_KEY, [last.lastOrderAt], last.email) : null,
  };
}
