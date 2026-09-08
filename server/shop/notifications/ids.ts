import { randomUUID } from 'node:crypto';

/**
 * Prefixed, client-safe ids for this subsystem.
 *
 * COPIED, NOT IMPORTED, which is this codebase's settled convention rather than
 * carelessness: `server/shop/orders/ids.ts`, `server/shop/cart/ids.ts` and
 * `server/marketing/ids.ts` each declare their own, and each says why — reaching
 * into another subsystem for a four-line function trades a duplicated line for a
 * dependency between two things that otherwise share nothing. `ids.test.ts`
 * beside this file pins the shape against the same regex the others use, so a
 * divergence is caught rather than assumed away.
 *
 * The time prefix makes an id sortable. It is not what makes it unique — the 64
 * bits of randomness after it are.
 */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** The prefixes this subsystem mints. Settings is a singleton pinned to 'main'
 *  and needs none, so there is exactly one. */
export const ID = {
  /** A row of `shop_push_subscriptions` — one browser on one machine. */
  pushSubscription: 'psb_',
} as const;
