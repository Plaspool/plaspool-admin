import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getEnv } from '../../env';
import type { Db } from '../../db/client';
import { normalizeBlobId, publicImageUrl } from '../../repo/public-projection';

/**
 * REVIEW LINKS — a link the owner copies from an order and sends to the buyer
 * themselves, on WhatsApp or wherever they are talking (owner's request
 * 2026-09-16).
 *
 * WHAT THE LINK GRANTS: writing a review, without signing in, for the products
 * on ONE order, as the buyer on that order. Nothing else — it cannot read the
 * order's address, total or payment, and every review it writes still lands
 * `pending` for a human to approve.
 *
 * STATELESS, SIGNED WITH `SESSION_SECRET`, the same shape and trade as the guest
 * order token in `server/shop/orders/tokens.ts`: no table, nothing to sweep, and
 * no revocation — a forwarded link works until it expires. That is acceptable
 * here for the same reason it is there: the worst a stranger holding one can do
 * is queue a review under the buyer's name that the owner then reads before it
 * is public, and each product can be reviewed once.
 *
 * The context string is different from the order token's, so a token minted for
 * one can never be spent as the other.
 */
const CONTEXT = 'shop-review-link:v1';

/** 90 days. A customer the owner chases on WhatsApp may take a while. */
export const REVIEW_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The order statuses that mean money changed hands — `eligibility.ts`'s list. */
export const LINKABLE_STATUSES = ['paid', 'fulfilled', 'refunded', 'partially_refunded'] as const;

interface Claims {
  o: string;
  exp: number;
}

function sign(body: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update(`${CONTEXT}.${body}`).digest('hex');
}

export function mintReviewLinkToken(
  orderId: string,
  now: number,
  ttlMs: number = REVIEW_LINK_TTL_MS,
): { token: string; expiresAt: number } {
  const exp = now + ttlMs;
  const body = Buffer.from(JSON.stringify({ o: orderId, exp } satisfies Claims), 'utf8').toString(
    'base64url',
  );
  return { token: `${body}.${sign(body)}`, expiresAt: exp };
}

/** The order id, or null. Never throws — the token is attacker-controlled. */
export function verifyReviewLinkToken(token: string, now: number): { orderId: string; expiresAt: number } | null {
  if (token.length > 500) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body);
  /* Length first: timingSafeEqual throws on a length mismatch. */
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { o, exp } = parsed as Partial<Claims>;
  if (typeof o !== 'string' || o.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return null;
  return { orderId: o, expiresAt: exp };
}

export interface ReviewLinkProduct {
  slug: string;
  title: string;
  imageUrl: string | null;
}

export interface ReviewLinkOrder {
  id: string;
  orderNumber: string;
  email: string;
  customerId: string | null;
  status: string;
  /** A first name to greet with and to pre-fill the byline, when the address has one. */
  firstName: string | null;
  /** Every distinct product on the order that still exists, in line order. */
  products: ReviewLinkProduct[];
}

/**
 * The order a link points at, with its products. Null when there is no such
 * order. The caller decides what a status means.
 *
 * A line whose variant or product has since been deleted is left out — there is
 * no page to put a review on. A trashed product is left out for the same reason.
 */
export async function reviewLinkOrder(db: Db, orderId: string): Promise<ReviewLinkOrder | null> {
  const head = await db.execute(sql`
    SELECT id, order_number, email, customer_id, status,
           NULLIF(trim(COALESCE(
             shipping_address->>'firstName',
             split_part(COALESCE(shipping_address->>'name', shipping_address->>'fullName', ''), ' ', 1),
             ''
           )), '') AS first_name
      FROM shop_orders
     WHERE id = ${orderId}`);
  const row = head.rows[0];
  if (!row) return null;

  const lines = await db.execute(sql`
    SELECT p.slug AS slug, p.title AS title, p.cover_image_id AS cover, min(l.line_no) AS first_line
      FROM shop_order_lines l
      JOIN shop_variants v ON v.id = l.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE l.order_id = ${orderId}
       AND p.slug IS NOT NULL
       AND p.deleted_at IS NULL
     GROUP BY p.slug, p.title, p.cover_image_id
     ORDER BY first_line`);

  return {
    id: String(row.id),
    orderNumber: String(row.order_number),
    email: String(row.email),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    status: String(row.status),
    firstName: row.first_name == null ? null : String(row.first_name),
    products: lines.rows.map((l) => {
      const cover = l.cover == null ? '' : normalizeBlobId(String(l.cover));
      return {
        slug: String(l.slug),
        title: String(l.title),
        imageUrl: cover === '' ? null : publicImageUrl(cover),
      };
    }),
  };
}
