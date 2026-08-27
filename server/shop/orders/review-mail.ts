import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { ID, newId } from './ids';
import { readOrder } from './repo/orders';
import { renderReviewApproved } from './mailer';
import { mintGuestToken } from './tokens';
import { storefrontOrigin } from '../storefront-url';
import { BUILT_IN } from '../../email/system-templates';
import type { TemplateSet } from '../../email/system-templates';

/**
 * "Your review is live" — queued when a human approves a review.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS IN ORDERS AND NOT IN REVIEWS.
 *
 * Reviews needs a message sent; Orders owns the outbox, the renderer, the
 * access-link minting and every table involved. Writing this in Reviews would
 * mean a third subsystem composing SQL against `shop_orders` and
 * `shop_order_email_intents` — and `reviews/eligibility.ts` already spends the
 * one crossing this codebase's contract §2 R3 allows, with a comment promising
 * that a SECOND one gets a proper seam instead. This is that seam.
 *
 * IT TAKES PLAIN DATA, NEVER A REVIEW. Three scalars in, a boolean out. Orders
 * does not import a Reviews type, does not know what a rating is, and cannot
 * grow a dependency on the moderation lifecycle by accident.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ReviewApprovedMail {
  /** The review, only as a dedupe discriminator. */
  reviewId: string;
  /** The order that proved the purchase. */
  orderId: string;
  /**
   * Where it goes — the REVIEW's `author_email`, not the order's.
   *
   * They can differ, and the difference is the common case rather than an edge:
   * a shopper who checked out as a guest under one address and later signed up
   * under another has an order carrying the first and a review carrying the
   * second. The review is what this message is about, so the review's address
   * is the one that is still current for the person who wrote it.
   */
  to: string;
}

/**
 * Returns whether an intent was written.
 *
 * FALSE IS NOT A FAILURE. It means the order has gone, or one was already
 * queued for this review. Both are ordinary, and neither is worth failing a
 * moderator's approval over — see the call site, which deliberately does not
 * treat this as fallible.
 */
export async function queueReviewApprovedEmail(
  db: Db,
  input: ReviewApprovedMail,
  now: number,
  templates: TemplateSet = BUILT_IN,
): Promise<boolean> {
  const read = await readOrder(db, input.orderId);
  if (!read) return false;

  const origin = storefrontOrigin();
  /* Same shape and the same refusal as `linkFor` in `routes.ts`: no origin
     means no link rather than a link built from a request header, which is a
     phishing link the application sent itself. */
  const link = origin
    ? {
        origin,
        token: mintGuestToken(
          { orderNumber: read.order.orderNumber, email: read.order.email },
          now,
        ),
      }
    : null;

  const rendered = renderReviewApproved(
    {
      orderNumber: read.order.orderNumber,
      email: input.to,
      currency: read.order.currency,
      grandTotal: read.order.grandTotal,
      placedAt: read.order.placedAt,
      lines: read.lines.map((line) => ({
        title: line.title,
        sku: line.sku,
        qty: line.qty,
        lineTotal: line.lineTotal,
        imageId: line.imageId,
      })),
    },
    link,
    templates,
  );

  /*
   * ONE PER REVIEW, FOREVER — the dedupe key carries the review id and nothing
   * else. A review that is un-approved and approved again does NOT send a
   * second message: the reader already knows it is live, and a moderator
   * flipping a status twice while making up their mind is not news.
   */
  const res = await db.execute(sql`
    INSERT INTO shop_order_email_intents
      (id, order_id, kind, to_email, subject, body, html, created_at, dedupe_key)
    VALUES (${newId(ID.emailIntent)}, ${input.orderId}, 'review_approved', ${input.to},
            ${rendered.subject}, ${rendered.body}, ${rendered.html ?? null}::text,
            ${now}, ${`review_approved:${input.reviewId}`})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1`);

  return res.rows.length > 0;
}
