import { randomUUID } from 'node:crypto';

/**
 * Prefixed, client-safe ids (contract §10).
 *
 * Same construction as `newId` in `server/repo/posts.ts`, so a commerce id and a
 * post id are indistinguishable by origin: a time component in base 36 followed
 * by 16 hex characters of a v4 UUID. Never a sequential integer on the wire —
 * a sequential id on a cart or an order tells any customer how many other people
 * bought something today, and lets them walk the range.
 *
 * The prefixes are fixed by the contract so that an id is self-describing in a
 * log line: `crt_…` is a cart, `res_…` is a reservation, and a `cus_` where a
 * `crt_` was expected is a bug visible without a schema.
 */
export const ID_PREFIXES = {
  customer: 'cus_',
  cart: 'crt_',
  cartLine: 'crl_',
  reservation: 'res_',
  address: 'adr_',
  event: 'evt_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  const suffix = `${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return `${ID_PREFIXES[kind]}${suffix}`;
}
