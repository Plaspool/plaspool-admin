import { randomUUID } from 'node:crypto';

/**
 * Prefixed, client-safe ids (contract §10), in the same shape the rest of this
 * codebase mints them — `Date.now().toString(36)` then 16 hex characters.
 *
 * COPIED RATHER THAN IMPORTED, and that is not carelessness: `newId` is a private
 * function inside `server/repo/posts.ts` and `server/repo/images.ts`, declared
 * twice there already, and contract §2 R1 makes those files somebody else's to
 * change. Exporting it from one of them is an amendment for a four-line function.
 * `server/shop/orders/ids.test.ts` pins the shape against the same regex, so a
 * divergence is caught rather than assumed away.
 *
 * The time prefix is what makes an id sortable and therefore "ULID-ish, monotonic"
 * as §6 asks of an event id. It is not a uniqueness mechanism — the 64 bits of
 * randomness after it are.
 */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * The prefixes this subsystem mints. Contract §10 fixes `ord_`, `ful_` and `evt_`;
 * the rest follow the same convention for rows that need an id and that §10 did
 * not have to name because nothing outside this subsystem ever sees them.
 */
export const ID = {
  order: 'ord_',
  orderLine: 'oln_',
  fulfillment: 'ful_',
  fulfillmentLine: 'fll_',
  /** A row of `shop_order_events` — customer-visible history. */
  timeline: 'oev_',
  /** A row of `commerce_events` — the outbox. */
  event: 'evt_',
  emailIntent: 'eml_',
} as const;
