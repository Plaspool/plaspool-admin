import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { money } from '../../../shared/commerce/money';
import type { Money } from '../../../shared/commerce/money';
import { newCatalogId } from './mapping';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';

/**
 * Effective-dated prices.
 *
 * A price change is TWO ROW WRITES IN ONE STATEMENT: close the current row by
 * stamping `effective_to`, and open a new one. Doing it as two statements leaves
 * a window in which a variant has zero current prices (if the close lands first)
 * or two (if the open does) — and the second is worse, because
 * `shop_prices_current_uq` would refuse the insert and the caller would get a
 * 23505 for an ordinary price change.
 *
 * THE PARTIAL UNIQUE INDEX IS THE AUTHORITY, NOT THIS FUNCTION. `UNIQUE
 * (variant_id) WHERE effective_to IS NULL` is what makes "one current price"
 * true under concurrency; the statement below is what makes the ordinary path
 * not trip it. Two simultaneous price changes therefore produce one winner and
 * one 23505 that becomes a 409-shaped refusal, rather than two current prices
 * and a shop that charges different customers differently for reasons nobody can
 * reconstruct.
 */

/** 409-shaped: another writer changed the price between this read and this write. */
export class ConcurrentPriceChangeError extends BadRequestError {
  constructor() {
    super('price');
    this.name = 'ConcurrentPriceChangeError';
  }
}

export interface PriceRow {
  id: string;
  variantId: string;
  amount: number;
  currency: string;
  effectiveFrom: number;
  effectiveTo: number | null;
  createdAt: number;
  /** WHY it moved. NULL on every price written before migration 0009, and NULL
   *  whenever a caller chose not to say — the audit view distinguishes the two
   *  from neither, by saying "no reason recorded" rather than showing ''. */
  reason: string | null;
}

function rowToPrice(row: Record<string, unknown>): PriceRow {
  return {
    id: String(row.id),
    variantId: String(row.variant_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    effectiveFrom: toEpochMs(row.effective_from),
    effectiveTo: toEpochMsOrNull(row.effective_to),
    createdAt: toEpochMs(row.created_at),
    reason: row.reason == null ? null : String(row.reason),
  };
}

/** The current price, or null for a variant nobody has priced yet. */
export async function currentPrice(db: Db, variantId: string): Promise<Money | null> {
  const res = await db.execute(sql`
    SELECT amount, currency FROM shop_prices
     WHERE variant_id = ${variantId} AND effective_to IS NULL`);
  const row = res.rows[0];
  return row ? money(Number(row.amount), String(row.currency)) : null;
}

/**
 * The full history, newest first. What "what did this cost on Tuesday" is for
 * (brief §2), and the reason prices are rows rather than a column.
 */
export async function priceHistory(db: Db, variantId: string): Promise<PriceRow[]> {
  const res = await db.execute(sql`
    SELECT id, variant_id, amount, currency, effective_from, effective_to, created_at, reason
      FROM shop_prices WHERE variant_id = ${variantId}
     ORDER BY effective_from DESC, id DESC`);
  return res.rows.map(rowToPrice);
}

/**
 * Set the current price: close the open row, then open a new one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO STATEMENTS, AND THIS IS THE ONE PLACE IN CATALOG THAT IS NOT ATOMIC.
 * Everywhere else in this subsystem a mutation is a single statement with
 * data-modifying CTEs. That is impossible here, and it was MEASURED rather than
 * reasoned about:
 *
 *   WITH closed AS (UPDATE shop_prices SET effective_to = 200
 *                    WHERE variant_id='v1' AND effective_to IS NULL RETURNING id),
 *        opened AS (INSERT INTO shop_prices VALUES ('p2','v1',1500,200,NULL) …)
 *   SELECT * FROM opened;
 *   -->  ERROR, constraint = shop_prices_current_uq
 *
 * Every CTE in a statement sees the SAME SNAPSHOT, so the INSERT's uniqueness
 * check still sees the row the UPDATE is closing, and the partial unique index
 * refuses it. The whole statement rolls back — verified: the original row was
 * left open and unchanged — so nothing is corrupted, but a shop whose SECOND
 * price change is a permanent 400 is not a shop. No test caught it until one
 * changed a price twice on the same variant.
 *
 * WHY NOT DROP THE INDEX INSTEAD. Because it is the thing that makes "at most
 * one current price" true under concurrency, and without it two racing price
 * changes leave two open rows — `quote()` then depends on which one the planner
 * returns, i.e. the shop charges different customers differently for reasons
 * nobody can reconstruct, silently. The index is worth more than the atomicity.
 *
 * SO THE FAILURE IS POINTED IN THE SAFE DIRECTION. Close FIRST, open SECOND. If
 * the process dies between them the variant has NO current price, which
 * `quote()` reads as "not sellable" — a variant that briefly cannot be bought.
 * The other ordering would leave two open rows, or a moment where the old price
 * and the new one are both current. Between "cannot sell for a moment" and "sold
 * at an ambiguous price", only the first is recoverable by setting the price
 * again, and only the first is visible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `price` arrives as a `Money`, so the caller has already been through the one
 * constructor that refuses a non-integer amount and a malformed currency code.
 * The column's `amount >= 0` and `currency ~ '^[A-Z]{3}$'` checks are the
 * backstop for a backfill.
 */
export async function setPrice(
  db: Db,
  variantId: string,
  price: Money,
  /** WHY it moved (migration 0009). NULL for every price written before it. */
  reason: string | null = null,
): Promise<PriceRow> {
  const now = Date.now();
  const id = newCatalogId('prc_');

  /*
   * `effective_from < now` is not optional: `shop_prices_window_ck` demands
   * `effective_to > effective_from`, so a price opened in this same millisecond
   * cannot be closed at this millisecond. Such a change is refused below rather
   * than stored as a zero-width window no "what did this cost at T" query could
   * ever return.
   */
  const closed = await db.execute(sql`
    UPDATE shop_prices SET effective_to = ${now}
     WHERE variant_id = ${variantId}
       AND effective_to IS NULL
       AND effective_from < ${now}
    RETURNING id`);

  const row = await db
    .execute(sql`
      WITH variant AS (
        SELECT id FROM shop_variants WHERE id = ${variantId}
      )
      INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from,
                               effective_to, created_at, reason)
      SELECT ${id}, variant.id, ${price.amount}, ${price.currency}, ${now}, NULL, ${now},
             ${reason && reason.trim() ? reason.trim() : null}
        FROM variant
      RETURNING id, variant_id, amount, currency, effective_from, effective_to, created_at, reason`)
    .then((res) => res.rows[0])
    .catch((err: unknown) => {
      /*
       * `shop_prices_current_uq`: an open row still exists. Either a concurrent
       * writer opened one between the two statements, or this call's own close
       * matched nothing because the existing row was opened in this same
       * millisecond. Both mean "try again", and neither may be a 500 — a 500 is
       * transient by the client's retry policy and would be re-sent five times,
       * whereas this genuinely does succeed on a retry a millisecond later.
       */
      if (String(err).includes('shop_prices_current_uq')) throw new ConcurrentPriceChangeError();
      throw err;
    });

  if (!row) {
    /*
     * The `variant` CTE was empty — the variant does not exist. The close above
     * matched nothing either (its predicate is the same variant id), so there is
     * no half-applied state to undo: `closed.rows.length` is asserted to be zero
     * rather than assumed, because a non-empty one here would mean a price was
     * closed for a variant that is not there, and that is worth a loud failure
     * rather than a quiet 404.
     */
    if (closed.rows.length > 0) {
      throw new Error(`closed a price for variant ${variantId}, which does not exist`);
    }
    throw new NotFoundError(variantId);
  }
  return rowToPrice(row);
}
