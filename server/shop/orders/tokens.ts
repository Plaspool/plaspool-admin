import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../env';

/**
 * Guest access to one order (brief §6).
 *
 * "Guest access is by a signed, expiring, single-order token emailed to the
 * purchaser — **never by order number alone, which is guessable by
 * construction**." The order number is a sequence with a check character; anybody
 * holding one can produce the next. So the number is an identifier and the token
 * is the authorization, and the two are never confused.
 *
 * STATELESS, AND THAT IS A CHOICE WITH A COST. There is no `shop_order_tokens`
 * table: the signature is the authority, so there is nothing to sweep, nothing to
 * migrate, and no read on the hot path. What it buys up is revocation — a leaked
 * link works until it expires. That is the right trade for this object and only
 * this object: the token names ONE order, carries no ability to write, and grants
 * exactly what a link in a confirmation email is for. A session token, which
 * carries a whole identity and can write, is stored and revocable
 * (`server/repo/users.ts`); the difference in treatment is the difference in
 * blast radius, not an inconsistency.
 *
 * WHAT IS SIGNED IS WHAT IS QUERIED. The token carries the order number AND the
 * purchaser's email, and `getOrderForGuest` scopes its `WHERE` clause by both,
 * taken from the VERIFIED TOKEN rather than from the URL. So a valid token for
 * order A cannot read order B even if the path says B — there is no code path in
 * which an attacker-chosen order number reaches the query.
 */

/** Domain separation, so a signature minted here cannot be spent anywhere else. */
const CONTEXT = 'shop-order-access:v1';

/**
 * 30 days. Long enough that a customer can still find the email after a delivery
 * dispute, short enough that a forwarded link does not outlive the relationship.
 * The expiry is INSIDE the signature, so it cannot be extended by editing the
 * token.
 */
export const GUEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GuestGrant {
  orderNumber: string;
  /** Lowercased at mint time, so a case difference cannot become a miss. */
  email: string;
}

interface Claims extends GuestGrant {
  /** epoch-ms. */
  exp: number;
}

function sign(body: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET)
    .update(`${CONTEXT}.${body}`)
    .digest('hex');
}

/**
 * `<base64url payload>.<hex signature>`.
 *
 * The payload is READABLE, and deliberately so: it holds an order number the
 * recipient already knows and their own email address. Encrypting it would imply a
 * confidentiality property this does not have and does not need. What it must not
 * be is FORGEABLE, which is the signature's job.
 */
export function mintGuestToken(
  grant: GuestGrant,
  now: number,
  ttlMs: number = GUEST_TOKEN_TTL_MS,
): string {
  const claims: Claims = {
    orderNumber: grant.orderNumber,
    email: grant.email.toLowerCase(),
    exp: now + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * The grant, or `null`. NEVER A THROW.
 *
 * A token arrives in a query string, so it is attacker-controlled and the
 * malformed case is ordinary rather than exceptional — the same reasoning
 * `decodeCursor` records. Every field is re-validated after `JSON.parse`, because
 * a signed payload proves who wrote it and nothing at all about its shape, and a
 * `JSON.parse` result can be any shape whatsoever.
 */
export function verifyGuestToken(token: string, now: number): GuestGrant | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(body);
  /*
   * LENGTH FIRST, THEN `timingSafeEqual`. The function THROWS on unequal lengths
   * rather than returning false, so an attacker sending a one-character signature
   * would get a 500 instead of a refusal — and a 500 is retried five times by the
   * client policy for a request that can never succeed (spec §8).
   */
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { orderNumber, email, exp } = parsed as Partial<Claims>;
  if (typeof orderNumber !== 'string' || orderNumber.length === 0) return null;
  if (typeof email !== 'string' || email.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp <= now) return null;

  return { orderNumber, email };
}
