import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { BadRequestError, NotFoundError } from '../../../repo/errors';
import { CartPreconditionError, CartStaleWriteError } from '../errors';
import { newId } from '../ids';

/**
 * The cart write path (brief §3, §5).
 *
 * ═══ THE THREE RULES EVERY STATEMENT IN THIS FILE FOLLOWS ═══
 *
 * **1. ONE STATEMENT PER MUTATION, AND NEVER `db.transaction`.** The Neon HTTP
 * driver throws unconditionally on `transaction()` while PGlite supports it, so
 * a transaction here would pass every test in this repository and 500 in
 * production — the exact divergence spec §9 exists to eliminate. Atomicity comes
 * from the statement instead: the line write SELECTs FROM the cart update, so a
 * CAS that matches nothing writes nothing at all.
 *
 * **2. THE CAS PREDICATE IS THE ONLY AUTHORITY.** No JavaScript check decides
 * whether a write may proceed. A precondition judged in TypeScript is judged
 * against a row that has already been read — exactly the stale value the CAS
 * exists to distrust — and GAUNTLET II Part 2b measured what that costs:
 * neutralising the real predicates broke NONE of 254 tests, because every
 * precondition case was satisfied by the JS pre-check. The re-read after a
 * failed CAS is used only to CLASSIFY the refusal, never to authorise a write.
 *
 * **3. NO RETRIES. AT ALL.** Every mutation takes one attempt and a lost CAS is
 * a 409 the caller resolves. This is what makes `posts.lifecycle_generation`
 * unnecessary here, and the reasoning is worth writing down because brief §5
 * explicitly offers that pattern: the A→B→A defect exists only where a lost
 * write is BLINDLY RE-APPLIED, and `shop_carts.revision` moves on every write of
 * any kind — a line edit, a status change, an address — so open → converting →
 * open is visible as `revision 1 → 3` even though `status` is back where it
 * started. A state precondition alone could not express that; a revision CAS
 * with no retry does. `repo.test.ts` executes the interleaving rather than
 * arguing it, and a mutation test proves the predicate is what refuses it.
 */

export type CartStatus = 'open' | 'converting' | 'converted' | 'abandoned';

export interface Cart {
  id: string;
  customerId: string | null;
  currency: string;
  status: CartStatus;
  email: string | null;
  shippingOptionId: string | null;
  taxZone: string | null;
  /** Uppercase discount code, or null when none is applied (migration 0820). */
  discountCode: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  revision: number;
}

export interface CartLine {
  id: string;
  cartId: string;
  variantId: string;
  qty: number;
  addedAt: number;
}

/**
 * How long an untouched cart lives.
 *
 * Fourteen days: long enough that a shopper who comes back next weekend still
 * has their basket — which is most of the point of having one — and short enough
 * that the table does not grow without bound from an anonymous, unauthenticated
 * create endpoint. Every write pushes it out again, so the clock measures
 * ABANDONMENT rather than age.
 */
export const CART_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The columns, once. `SELECT *` is banned in this codebase for the reason
 * `POST_COLUMNS` gives: a column added later silently joins every response.
 */
const CART_COLUMNS = [
  'id',
  'customer_id',
  'currency',
  'status',
  'email',
  'shipping_option_id',
  'tax_zone',
  /* The applied discount code, or NULL (migration 0820). Stored on the cart
     rather than derived, so it survives a reload and is re-validated at the
     freeze — an owner can switch a code off while a cart sits at payment. */
  'discount_code',
  'created_at',
  'updated_at',
  'expires_at',
  'revision',
] as const;

const CART_COLS = CART_COLUMNS.join(', ');

function rowToCart(row: Record<string, unknown>): Cart {
  return {
    id: String(row.id),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    currency: String(row.currency),
    status: String(row.status) as CartStatus,
    email: row.email == null ? null : String(row.email),
    shippingOptionId: row.shipping_option_id == null ? null : String(row.shipping_option_id),
    taxZone: row.tax_zone == null ? null : String(row.tax_zone),
    discountCode: row.discount_code == null ? null : String(row.discount_code),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
    expiresAt: toEpochMs(row.expires_at),
    revision: Number(row.revision),
  };
}

function rowToLine(row: Record<string, unknown>): CartLine {
  return {
    id: String(row.id),
    cartId: String(row.cart_id),
    variantId: String(row.variant_id),
    qty: Number(row.qty),
    addedAt: toEpochMs(row.added_at),
  };
}

// -------------------------------------------------------------------- reads

export async function getCart(db: Db, id: string): Promise<Cart | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(CART_COLS)} FROM shop_carts WHERE id = ${id}`);
  return res.rows[0] ? rowToCart(res.rows[0]) : null;
}

export async function listLines(db: Db, cartId: string): Promise<CartLine[]> {
  const res = await db.execute(sql`
    SELECT id, cart_id, variant_id, qty, added_at
      FROM shop_cart_lines WHERE cart_id = ${cartId}
     ORDER BY added_at, id`);
  return res.rows.map(rowToLine);
}

// ------------------------------------------------------------------- create

export async function createCart(
  db: Db,
  a: { currency: string; customerId?: string | null; ttlMs?: number },
): Promise<Cart> {
  const now = Date.now();
  const res = await db.execute(sql`
    INSERT INTO shop_carts (id, customer_id, currency, status, created_at, updated_at,
                            expires_at, revision)
    VALUES (${newId('cart')}, ${a.customerId ?? null}, ${a.currency}, 'open',
            ${now}, ${now}, ${now + (a.ttlMs ?? CART_TTL_MS)}, 1)
    RETURNING ${sql.raw(CART_COLS)}`);
  return rowToCart(res.rows[0]);
}

// ------------------------------------------------------------ line mutations

/**
 * Judged BEFORE the statement, and it is not a precondition.
 *
 * A quantity is a property of the request, not of the stored row, so checking it
 * here is not the stale-read mistake rule 2 forbids — there is nothing
 * concurrent that could make `qty = 0` acceptable. The database has the same
 * CHECK, so an import or a hand-run INSERT is refused too; this exists so the
 * ordinary path answers 400 with a field name rather than 500 with a SQLSTATE.
 */
function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestError('qty');
}

interface CasTarget {
  cartId: string;
  /** When omitted, the cart's own current revision is used — one attempt still. */
  baseRevision?: number;
}

/**
 * Read the cart, or 404. Also resolves the base revision for a caller that did
 * not supply one.
 *
 * IT DOES NOT REFUSE A STALE `baseRevision`, and that omission is deliberate —
 * it is rule 2, applied to this function rather than merely stated at the top of
 * the file. An early `if (baseRevision !== cart.revision) throw` looks like a
 * free optimisation and is the exact shape of the defect GAUNTLET II Part 2b
 * measured: it makes the JavaScript comparison the thing that actually refuses
 * the write, so the SQL predicate can be neutralised with every test still
 * green. This was not reasoned about — the mutation test in `repo.test.ts`
 * caught it, on the first run, with the early check present.
 *
 * `server/repo/posts.ts` keeps its equivalent early check and says out loud that
 * "this is only the cheap path; the CAS is what is authoritative". That is true
 * there and it is why the check is harmless there — but "harmless" and
 * "testable" are different, and the cost of removing it is one statement that
 * would have been issued anyway.
 */
async function basedOn(db: Db, t: CasTarget): Promise<{ cart: Cart; base: number }> {
  const cart = await getCart(db, t.cartId);
  if (!cart) throw new NotFoundError(t.cartId);
  return { cart, base: t.baseRevision ?? cart.revision };
}

function snapshot(cart: Cart) {
  return {
    id: cart.id,
    status: cart.status,
    revision: cart.revision,
    currency: cart.currency,
  };
}

/**
 * The CAS matched nothing. Work out WHY, from a fresh read, and raise the error
 * that says so.
 *
 * `operation` names what was refused so a client can word it. The order of the
 * checks is deliberate: a cart that is no longer open is a PERMANENT refusal and
 * must not be reported as a race the caller could win by retrying.
 */
async function explainMiss(
  db: Db,
  t: { cartId: string; base: number; operation: string; lineId?: string },
): Promise<never> {
  /*
   * LINE FIRST. A line that is not in this cart is a 404 and a PERMANENT stop
   * under spec §8's retry policy; reported as a `stale_write` it would be a 409
   * the client tried to resolve by re-reading a cart that will never contain it.
   */
  if (t.lineId !== undefined) {
    const line = await db.execute(sql`
      SELECT 1 FROM shop_cart_lines WHERE cart_id = ${t.cartId} AND id = ${t.lineId}`);
    if (line.rows.length === 0) throw new NotFoundError(t.lineId);
  }
  const after = await getCart(db, t.cartId);
  if (!after) throw new NotFoundError(t.cartId);
  if (after.status !== 'open') throw new CartPreconditionError(t.operation, snapshot(after));
  throw new CartStaleWriteError(t.base, after.revision, snapshot(after));
}

/**
 * The shared shape of every line mutation: bump the cart under CAS, and let the
 * line statement select FROM that bump.
 *
 * `lineWrite` may only reach `shop_cart_lines` through the `upd` CTE. That is
 * what guarantees the line write cannot happen unless the cart write did — the
 * same construction `server/repo/posts.ts` uses to get atomicity without
 * `db.transaction`, which the Neon HTTP driver rejects unconditionally.
 *
 * `requires` goes INSIDE the cart's own predicate rather than being checked
 * after it. Without that, a `removeLine` naming a line in somebody else's cart
 * answered 404 — correctly — having ALREADY bumped this cart's revision, so a
 * refused request invalidated every other tab's optimistic token for nothing.
 * Caught by `repo.test.ts`, not by reading.
 *
 * The cart columns are aliased `c_*` rather than `cart_*`: `cart_` + `id` is
 * `cart_id`, which is also a column of `shop_cart_lines`, and the two would
 * silently collide in the result row.
 */
async function withCartCas<T>(
  db: Db,
  t: CasTarget & { lineId?: string },
  operation: string,
  build: (now: number) => {
    sql: SQL;
    map: (row: Record<string, unknown>) => T;
    requires?: SQL;
  },
): Promise<{ cart: Cart; value: T }> {
  const { base } = await basedOn(db, t);
  const now = Date.now();
  const { sql: write, map, requires } = build(now);

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE shop_carts
         SET revision = revision + 1, updated_at = ${now},
             expires_at = ${now + CART_TTL_MS}
       WHERE id = ${t.cartId} AND revision = ${base} AND status = 'open'
         ${requires ? sql`AND ${requires}` : sql``}
      RETURNING ${sql.raw(CART_COLS)}
    ), line AS (
      ${write}
    )
    SELECT ${sql.raw(CART_COLUMNS.map((c) => `upd.${c} AS c_${c}`).join(', '))}, line.*
      FROM upd LEFT JOIN line ON true`);

  const row = res.rows[0];
  // `rows.length`, never `affectedRows` — measured to be 0 even on a winning
  // CAS (see `server/db/client.ts`). No row means nothing at all was written.
  if (!row) await explainMiss(db, { cartId: t.cartId, base, operation, lineId: t.lineId });

  const cartRow: Record<string, unknown> = {};
  for (const column of CART_COLUMNS) cartRow[column] = row[`c_${column}`];
  return { cart: rowToCart(cartRow), value: map(row) };
}

/** `EXISTS (…)` over a line that must be in THIS cart for the write to happen. */
function lineExists(cartId: string, lineId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM shop_cart_lines l
                      WHERE l.cart_id = ${cartId} AND l.id = ${lineId})`;
}

/**
 * Add to the basket. A variant already present has its quantity SUMMED.
 *
 * `UNIQUE (cart_id, variant_id)` makes a second row for the same variant
 * impossible, so the only question is whether a repeat add is lost or added.
 * Summing is what a shopper means by pressing "add to basket" twice, and it is
 * what makes the guest→account merge (`mergeCarts`) express the same rule with
 * the same words.
 */
export async function addLine(
  db: Db,
  a: { cartId: string; variantId: string; qty: number; baseRevision?: number },
): Promise<{ cart: Cart; line: CartLine }> {
  assertQty(a.qty);
  const { cart, value } = await withCartCas(db, a, 'add_line', (now) => ({
    sql: sql`
      INSERT INTO shop_cart_lines (id, cart_id, variant_id, qty, added_at)
      SELECT ${newId('cartLine')}, upd.id, ${a.variantId}, ${a.qty}, ${now} FROM upd
      ON CONFLICT (cart_id, variant_id)
        DO UPDATE SET qty = shop_cart_lines.qty + EXCLUDED.qty
      RETURNING id, cart_id, variant_id, qty, added_at`,
    map: rowToLine,
  }));
  return { cart, line: value };
}

/** Replace a line's quantity. Not additive — this is the number the shopper typed. */
export async function setLineQty(
  db: Db,
  a: { cartId: string; lineId: string; qty: number; baseRevision?: number },
): Promise<{ cart: Cart; line: CartLine }> {
  assertQty(a.qty);
  const { cart, value } = await withCartCas(db, a, 'set_line_qty', () => ({
    requires: lineExists(a.cartId, a.lineId),
    sql: sql`
      UPDATE shop_cart_lines SET qty = ${a.qty}
        FROM upd
       WHERE shop_cart_lines.cart_id = upd.id AND shop_cart_lines.id = ${a.lineId}
      RETURNING shop_cart_lines.id, shop_cart_lines.cart_id, shop_cart_lines.variant_id,
                shop_cart_lines.qty, shop_cart_lines.added_at`,
    map: rowToLine,
  }));
  return { cart, line: value };
}

export async function removeLine(
  db: Db,
  a: { cartId: string; lineId: string; baseRevision?: number },
): Promise<Cart> {
  /*
   * SCOPED TO THE CART, not just to the line id, and that is a security
   * property rather than tidiness. The storefront is anonymous: a line id is
   * the only thing between two strangers' baskets, so a predicate on `id` alone
   * would let anyone who learned one edit somebody else's cart.
   */
  const { cart } = await withCartCas(db, a, 'remove_line', () => ({
    requires: lineExists(a.cartId, a.lineId),
    sql: sql`
      DELETE FROM shop_cart_lines
        USING upd
       WHERE shop_cart_lines.cart_id = upd.id AND shop_cart_lines.id = ${a.lineId}
      RETURNING shop_cart_lines.id`,
    map: (row) => row.id,
  }));
  return cart;
}

// ---------------------------------------------------------- the state machine

/**
 * The transitions that exist. Anything not listed is refused.
 *
 * An ALLOW-LIST and not a deny-list, for the reason `isBlankDoc` gives in the
 * frontend gauntlet: the next status somebody adds must not be silently
 * reachable from everywhere. `converted` has no outgoing edge at all — a
 * converted cart has become an order, and Orders owns what happens next.
 *
 * `converting → open` exists on purpose: a customer who backs out of checkout
 * gets their basket back rather than a cart they can never edit again. It is
 * also the A→B→A edge, and `repo.test.ts` executes it to show the CAS refuses a
 * stale write across it.
 *
 * ═══ AND FOR MONTHS THAT SENTENCE DESCRIBED NOTHING ═══
 *
 * The edge was listed here, tested here, and PERFORMED NOWHERE: `setCartStatus`
 * had exactly one caller in the whole application (`merge.ts`, moving a guest
 * cart to `abandoned`), so no route, function or job ever walked it. The
 * customer this comment promises to look after was locked out of their own
 * checkout permanently instead — every address edit a `409
 * precondition_failed / update_cart`, for ever.
 *
 * `checkout/repo.ts#thawCheckout` is the caller it was always missing. A legal
 * transition with no caller is a promise, not a behaviour; if another edge here
 * ever has no caller either, that is the same bug and not a spare part.
 */
const TRANSITIONS: Record<CartStatus, readonly CartStatus[]> = {
  open: ['converting', 'abandoned'],
  converting: ['open', 'converted', 'abandoned'],
  converted: [],
  abandoned: ['open'],
};

export function canTransition(from: CartStatus, to: CartStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Move the cart along the checkout state machine.
 *
 * The FROM state is in the CAS predicate, not only in the allow-list check: the
 * allow-list is evaluated against a row that has already been read, so on its
 * own it is exactly the stale pre-check rule 2 forbids. `status = ${from}` in
 * the statement is what actually decides.
 */
export async function setCartStatus(
  db: Db,
  a: {
    cartId: string;
    to: CartStatus;
    baseRevision?: number;
    /** Set alongside the status, in the same statement. */
    fields?: { email?: string | null; shippingOptionId?: string | null; taxZone?: string | null };
  },
): Promise<Cart> {
  const { cart, base } = await basedOn(db, a);
  if (!canTransition(cart.status, a.to)) {
    throw new CartPreconditionError(`transition_to_${a.to}`, snapshot(cart));
  }

  const now = Date.now();
  const f = a.fields ?? {};
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET status = ${a.to},
           email = ${f.email !== undefined ? f.email : sql`email`},
           shipping_option_id = ${
             f.shippingOptionId !== undefined ? f.shippingOptionId : sql`shipping_option_id`
           },
           tax_zone = ${f.taxZone !== undefined ? f.taxZone : sql`tax_zone`},
           revision = revision + 1, updated_at = ${now}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = ${cart.status}
    RETURNING ${sql.raw(CART_COLS)}`);

  if (res.rows.length === 0) {
    const after = await getCart(db, a.cartId);
    if (!after) throw new NotFoundError(a.cartId);
    if (after.revision !== base) {
      throw new CartStaleWriteError(base, after.revision, snapshot(after));
    }
    throw new CartPreconditionError(`transition_to_${a.to}`, snapshot(after));
  }
  return rowToCart(res.rows[0]);
}

/**
 * Set cart fields without changing status. Same CAS, same `status = 'open'`
 * guard — an address may not be edited once checkout has frozen a total that
 * was derived from it.
 */
export async function updateCartFields(
  db: Db,
  a: {
    cartId: string;
    baseRevision?: number;
    fields: { email?: string | null; shippingOptionId?: string | null; taxZone?: string | null };
  },
): Promise<Cart> {
  const { base } = await basedOn(db, a);
  const now = Date.now();
  const f = a.fields;
  const res = await db.execute(sql`
    UPDATE shop_carts
       SET email = ${f.email !== undefined ? f.email : sql`email`},
           shipping_option_id = ${
             f.shippingOptionId !== undefined ? f.shippingOptionId : sql`shipping_option_id`
           },
           tax_zone = ${f.taxZone !== undefined ? f.taxZone : sql`tax_zone`},
           revision = revision + 1, updated_at = ${now},
           expires_at = ${now + CART_TTL_MS}
     WHERE id = ${a.cartId} AND revision = ${base} AND status = 'open'
    RETURNING ${sql.raw(CART_COLS)}`);
  if (res.rows.length === 0) {
    await explainMiss(db, { cartId: a.cartId, base, operation: 'update_cart' });
  }
  return rowToCart(res.rows[0]);
}
