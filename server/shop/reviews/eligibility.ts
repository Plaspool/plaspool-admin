import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import type { ReviewsCustomer } from './routes';

/**
 * "Has this shopper bought this product?" — the gate in front of every review
 * mutation (storefront brief §2).
 *
 * WHY IT IS ITS OWN FILE. `repo.ts` owns the review row and `threads.ts` owns
 * replies and reactions, and this question is asked by BOTH plus the new read
 * route. Putting it in either would make the other import across a seam that
 * exists on purpose; putting it in Orders would make Reviews depend on Orders'
 * internals rather than on three tables it reads at arm's length.
 *
 * IT READS ORDERS AND CATALOG DIRECTLY, WHICH IS A DELIBERATE EXCEPTION.
 * Commerce's contract §2 R3 keeps subsystems out of each other's tables, and
 * every other crossing in this codebase goes through a port. This one does not,
 * for a reason the alternatives make plain: a port would have to answer
 * "which of these sixty slugs has this customer bought", which is not a
 * question Orders has any reason to be able to answer — it would exist solely
 * for this caller, and be a join written in Orders' file on Catalog's tables
 * instead of in this one. The read is narrow (four columns, no writes) and it
 * is the ONLY crossing in this subsystem; if a second appears, that is the
 * moment to draw the port properly.
 */

/** The order statuses that mean money changed hands. */
const PURCHASED_STATUSES = ['paid', 'fulfilled', 'refunded', 'partially_refunded'] as const;

/**
 * WHY `refunded` COUNTS. It reads wrong for about a second and is right on
 * reflection: the customer received the product and formed an opinion, and the
 * refund is often the very thing they have something to say about. Silencing
 * complaints from the people the shop has already paid back is the single most
 * self-serving rule this feature could have, and it would be invisible — the
 * reviews it suppressed would simply never exist.
 *
 * `pending` DOES NOT COUNT, because an unpaid order is an intention. `cancelled`
 * does not count because it never happened.
 */

export interface PurchaseProof {
  /** The slug that was proven. */
  productSlug: string;
  /**
   * The order that proves it — the EARLIEST qualifying one, since order ids are
   * time-prefixed and sort by creation. Recorded on the review so a later
   * question ("prove this reviewer bought it") has an answer that does not
   * depend on re-running this query against data that has since moved.
   */
  orderId: string;
}

/**
 * Which of these slugs the customer has bought, and what proves each one.
 *
 * ONE STATEMENT FOR THE WHOLE PAGE. A product page asks about one slug and a
 * listing asks about sixty; a per-slug query would make the second a subrequest
 * per card, which is the N+1 `listVariantsForProducts` exists to avoid.
 *
 * A slug nobody bought is simply ABSENT from the map. The route turns that into
 * an explicit `false`, because the wire contract promises every requested slug
 * appears in the answer and a caller should not have to write the same
 * "missing means no" branch the aggregates route already spared them.
 */
export async function purchasedProducts(
  db: Db,
  customer: ReviewsCustomer,
  slugs: readonly string[],
): Promise<Map<string, PurchaseProof>> {
  if (slugs.length === 0) return new Map();

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * TWO WAYS TO OWN AN ORDER, AND THE SECOND ONE IS THE IMPORTANT ONE.
   *
   * shop_orders.customer_id is NULL for a guest order, and guest checkout is
   * the DEFAULT path through this shop (the column's own comment in migration
   * 0160 says so). An account-only rule would therefore lock out most real
   * buyers — someone who checked out as a guest and made an account afterwards
   * would be told they had never bought anything, which is both wrong and
   * unarguable from their side.
   *
   * So the email matches too. That is a weaker claim than an account link and
   * it is worth being honest about what it rests on: it trusts that the address
   * on the session was proven at sign-up. It was — a customer session only
   * exists behind the auth bundle's verification — so this is not "anyone who
   * types your address", it is "whoever proved they hold it".
   *
   * CASE-FOLDED ON BOTH SIDES. Checkout takes the address a shopper types and
   * sign-up takes the address they type on another day; the same mailbox
   * reached through two capitalisations is one mailbox, and a case-sensitive
   * comparison would silently deny a real buyer.
   * ═══════════════════════════════════════════════════════════════════════
   */
  const email = customer.email;

  const res = await db.execute(sql`
    SELECT p.slug AS slug, min(o.id) AS order_id
      FROM shop_order_lines l
      JOIN shop_orders o ON o.id = l.order_id
      /* Order lines record a variant, never a slug (migration 0160 keeps them
         snapshots and not references), so the product is two hops away. Any
         variant counts: buying the 5kg tub earns the right to review the
         product, not that one SKU. */
      JOIN shop_variants v ON v.id = l.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE p.slug = ANY(${sql.param([...slugs])}::text[])
       AND o.status = ANY(${sql.param([...PURCHASED_STATUSES])}::text[])
       AND (
             o.customer_id = ${customer.id}::text
          OR (${email}::text IS NOT NULL AND lower(o.email) = lower(${email}::text))
           )
     GROUP BY p.slug`);

  const proofs = new Map<string, PurchaseProof>();
  for (const row of res.rows) {
    proofs.set(String(row.slug), {
      productSlug: String(row.slug),
      orderId: String(row.order_id),
    });
  }
  return proofs;
}

/**
 * The single-slug question, for the three mutations. Null means "not bought".
 *
 * A thin wrapper rather than a second statement, so there is exactly one
 * definition of what a purchase is and no way for the read route and the write
 * gate to drift apart — which is the failure mode where a page shows a form
 * that the submit then refuses.
 */
export async function purchasedProduct(
  db: Db,
  customer: ReviewsCustomer,
  slug: string,
): Promise<PurchaseProof | null> {
  const proofs = await purchasedProducts(db, customer, [slug]);
  return proofs.get(slug) ?? null;
}

/**
 * Which of these slugs the customer has ALREADY reviewed — in any status.
 *
 * PENDING AND REJECTED COUNT. The point of the field is to stop the page
 * offering a form whose submission will be refused as a duplicate, and both of
 * those states are duplicates. It also spares a rejected reviewer the loop of
 * rewriting the review that was rejected, which they cannot see and would not
 * understand the refusal of.
 *
 * MATCHED THE SAME TWO WAYS as a purchase, and for the same reason: reviews
 * written before accounts existed carry an email and a null customer_id, so an
 * account-only match would offer a second form to somebody who already reviewed.
 */
export async function reviewedProducts(
  db: Db,
  customer: ReviewsCustomer,
  slugs: readonly string[],
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const email = customer.email;

  const res = await db.execute(sql`
    SELECT DISTINCT product_slug AS slug
      FROM shop_reviews
     WHERE product_slug = ANY(${sql.param([...slugs])}::text[])
       AND (
             customer_id = ${customer.id}::text
          OR (${email}::text IS NOT NULL AND lower(author_email) = lower(${email}::text))
           )`);

  return new Set(res.rows.map((row) => String(row.slug)));
}

/**
 * The product a review is about, for the reply and reaction gates.
 *
 * THE GATE IS JUDGED AGAINST THE REVIEWED PRODUCT, NOT AGAINST ANYTHING THE
 * CALLER SENDS. A body-supplied slug would let a customer who bought one
 * product act on every review in the shop by naming the product they own.
 */
export async function reviewProductSlug(db: Db, reviewId: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT product_slug FROM shop_reviews WHERE id = ${reviewId}`);
  const row = res.rows[0];
  return row ? String(row.product_slug) : null;
}
