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
    SELECT id, variant_id, amount, currency, effective_from, effective_to, created_at
      FROM shop_prices WHERE variant_id = ${variantId}
     ORDER BY effective_from DESC, id DESC`);
  return res.rows.map(rowToPrice);
}

/**
 * Set the current price: close the open row, open a new one, in one statement.
 *
 * `price` arrives as a `Money`, so the caller has already been through the one
 * constructor that refuses a non-integer amount and a malformed currency code —
 * there is no path from an HTTP body to this column that does not pass through
 * it. The database's own `amount >= 0` and `currency ~ '^[A-Z]{3}$'` checks are
 * the backstop for a backfill.
 */
export async function setPrice(db: Db, variantId: string, price: Money): Promise<PriceRow> {
  const now = Date.now();
  const id = newCatalogId('prc_');

  const row = await db
    .execute(sql`
      WITH variant AS (
        SELECT id FROM shop_variants WHERE id = ${variantId}
      ), closed AS (
        UPDATE shop_prices SET effective_to = ${now}
         WHERE variant_id = (SELECT id FROM variant)
           AND effective_to IS NULL
           -- A price opened in the same millisecond cannot be closed at that
           -- millisecond: shop_prices_window_ck demands
           -- effective_to > effective_from. Two price changes inside one
           -- millisecond are refused here rather than violating the check --
           -- which is the honest answer, since the two would otherwise produce
           -- a zero-width window that no "what did this cost at T" query could
           -- ever return.
           AND effective_from < ${now}
        RETURNING id
      ), opened AS (
        INSERT INTO shop_prices (id, variant_id, amount, currency, effective_from,
                                 effective_to, created_at)
        SELECT ${id}, variant.id, ${price.amount}, ${price.currency}, ${now}, NULL, ${now}
          FROM variant
        RETURNING id, variant_id, amount, currency, effective_from, effective_to, created_at
      )
      SELECT * FROM opened`)
    .then((res) => res.rows[0])
    .catch((err: unknown) => {
      /*
       * `shop_prices_current_uq`. Reachable two ways, and both mean the same
       * thing to a caller: a concurrent writer opened a price between this
       * statement's snapshot and its write, or the existing open row was opened
       * in this same millisecond and so could not be closed. Either way the
       * answer is "try again", and it must not be a 500 — a 500 is retried five
       * times by the client's policy with no reason to think the outcome
       * changes, whereas this genuinely does succeed on a retry.
       */
      if (String(err).includes('shop_prices_current_uq')) throw new ConcurrentPriceChangeError();
      throw err;
    });

  // Empty `variant` CTE — the variant does not exist. A 404 rather than a
  // foreign-key 500, and without a separate existence read that would let the
  // variant be deleted in between.
  if (!row) throw new NotFoundError(variantId);
  return rowToPrice(row);
}
