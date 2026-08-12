import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { toEpochMs } from '../../db/client';
import { BadRequestError } from '../../repo/errors';
import { encodeCursor, pageLimit, requireCursor } from '../../repo/cursor';

/**
 * What changed in the catalogue, who changed it, and why.
 *
 * NO NEW TABLE, AND THAT IS THE POINT. Both halves of this were already durable
 * and neither was readable:
 *
 * - **Stock.** `adjustInventory` has required a reason since it was written, and
 *   it writes `{ variantId, delta, onHand, reason, actorId }` into
 *   `commerce_events` as `catalog.inventory.adjusted` in the SAME statement as
 *   the stock change. Nothing in this codebase ever deletes a commerce event, so
 *   that is a complete ledger — it simply had no reader.
 * - **Prices.** `shop_prices` is append-only and effective-dated, so every price
 *   the shop has ever charged is still there with the instant it took effect.
 *   Migration 0009 added `reason`, which is the half a human needs: a row saying
 *   18,500 became 22,000 on a Tuesday is a trail nobody can act on.
 *
 * A purpose-built audit table would have been a THIRD copy of facts these two
 * already hold, kept in step by hand.
 *
 * THE DIFFERENCE IS COMPUTED, NOT STORED. A price row knows what it became; what
 * a reader wants is what it was, which is the previous row's amount. `lag()` over
 * the variant's own history answers that in the same statement rather than making
 * the client fetch the history and subtract.
 */

/** The union's ordering, and the cursor's sort key. */
const SORT_KEY = 'occurred';

export type AuditKind = 'stock' | 'price';

export interface AuditEntry {
  /** `evt_…` for a stock change, `prc_…` for a price. Unique across both. */
  id: string;
  kind: AuditKind;
  occurredAt: number;
  variantId: string;
  sku: string | null;
  productId: string | null;
  productTitle: string | null;
  optionValues: Record<string, string>;
  /** NULL for a price written before 0009, and for a caller that said nothing. */
  reason: string | null;
  /** The display name of whoever did it, resolved through `users`. */
  actor: string | null;
  /** Stock only: signed, never zero. */
  delta: number | null;
  /** Stock only: the count AFTER the change. */
  onHand: number | null;
  /** Price only: minor units. */
  amount: number | null;
  /** Price only: what it was immediately before, or null for the first price. */
  previousAmount: number | null;
  currency: string | null;
}

export interface AuditQuery {
  kind?: AuditKind;
  /** One variant's own history, for the panel that edits it. */
  variantId?: string;
  productId?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export async function listAudit(db: Db, q: AuditQuery = {}): Promise<AuditPage> {
  const limit = pageLimit(q.limit);

  /*
   * The keyset bound, applied to the UNION rather than to either half.
   *
   * `(occurred_at, id) < (cursor_at, cursor_id)` as a row comparison, so the
   * tiebreak is part of the predicate rather than a second sort the planner is
   * free to reorder. Two events in the same millisecond are ordinary — a
   * six-variant price update writes six rows inside one request — and without
   * the id in the bound a page boundary landing between them drops or repeats
   * whichever the planner happened to emit second.
   */
  let after = sql``;
  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const at = Number(cursor.sortValues[0]);
    if (!Number.isFinite(at)) throw new BadRequestError('cursor');
    after = sql` AND (u.occurred_at, u.id) < (${at}, ${cursor.id})`;
  }

  const byVariant = q.variantId
    ? sql` AND u.variant_id = ${q.variantId}`
    : sql``;
  const byProduct = q.productId ? sql` AND v.product_id = ${q.productId}` : sql``;

  /*
   * BOTH ARMS ARE BUILT EVEN WHEN ONE IS FILTERED OUT, and the filter is a
   * constant predicate rather than a missing arm. A UNION assembled by string
   * concatenation is one edit away from a query whose column list depends on a
   * parameter, and the two arms must stay positionally identical for the union
   * to be legal at all.
   */
  const wantStock = q.kind === undefined || q.kind === 'stock';
  const wantPrice = q.kind === undefined || q.kind === 'price';

  const res = await db.execute(sql`
    WITH stock AS (
      SELECT e.id,
             'stock'::text                         AS kind,
             e.occurred_at,
             e.payload ->> 'variantId'             AS variant_id,
             e.payload ->> 'reason'                AS reason,
             e.payload ->> 'actorId'               AS actor_id,
             (e.payload ->> 'delta')::int          AS delta,
             (e.payload ->> 'onHand')::int         AS on_hand,
             NULL::int                             AS amount,
             NULL::int                             AS previous_amount,
             NULL::text                            AS currency
        FROM commerce_events e
       WHERE e.type = 'catalog.inventory.adjusted'
         AND ${wantStock ? sql`TRUE` : sql`FALSE`}
    ), price AS (
      SELECT p.id,
             'price'::text                         AS kind,
             p.effective_from                      AS occurred_at,
             p.variant_id,
             p.reason,
             /* shop_prices carries no actor. The WHO for a price change is a
                column nobody added, and inventing one from created_at would be
                a guess presented as a fact. */
             NULL::text                            AS actor_id,
             NULL::int                             AS delta,
             NULL::int                             AS on_hand,
             p.amount,
             lag(p.amount) OVER (
               PARTITION BY p.variant_id ORDER BY p.effective_from, p.id
             )                                     AS previous_amount,
             p.currency
        FROM shop_prices p
       WHERE ${wantPrice ? sql`TRUE` : sql`FALSE`}
    ), u AS (
      SELECT * FROM stock
      UNION ALL
      SELECT * FROM price
    )
    SELECT u.*, v.sku, v.option_values, v.product_id, pr.title AS product_title,
           us.display_name AS actor_name
      FROM u
      LEFT JOIN shop_variants v ON v.id = u.variant_id
      LEFT JOIN shop_products pr ON pr.id = v.product_id
      /* The actor is a blog user. commerce_events stores the id as plain text
         with no FK (contract R3 keeps commerce from constraining users), so a
         deleted account resolves to NULL rather than removing the row. */
      LEFT JOIN users us ON us.id::text = u.actor_id
     WHERE TRUE${after}${byVariant}${byProduct}
     ORDER BY u.occurred_at DESC, u.id DESC
     LIMIT ${limit + 1}`);

  const rows = res.rows.slice(0, limit);
  const items = rows.map(toEntry);
  const more = res.rows.length > limit;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      more && last ? encodeCursor(SORT_KEY, [last.occurredAt], last.id) : null,
  };
}

function toEntry(row: Record<string, unknown>): AuditEntry {
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: String(row.id),
    kind: String(row.kind) as AuditKind,
    occurredAt: toEpochMs(row.occurred_at),
    variantId: row.variant_id == null ? '' : String(row.variant_id),
    sku: row.sku == null ? null : String(row.sku),
    productId: row.product_id == null ? null : String(row.product_id),
    productTitle: row.product_title == null ? null : String(row.product_title),
    optionValues:
      row.option_values && typeof row.option_values === 'object'
        ? (row.option_values as Record<string, string>)
        : {},
    reason: row.reason == null ? null : String(row.reason),
    actor: row.actor_name == null ? null : String(row.actor_name),
    delta: num(row.delta),
    onHand: num(row.on_hand),
    amount: num(row.amount),
    previousAmount: num(row.previous_amount),
    currency: row.currency == null ? null : String(row.currency),
  };
}
