import { randomUUID } from 'node:crypto';

/**
 * Prefixed, client-safe ids for the marketing tables — the same shape the rest
 * of this repository mints, `Date.now().toString(36)` then 16 hex characters.
 *
 * COPIED RATHER THAN IMPORTED, and there are two reasons rather than one.
 * `newId` is module-private in `server/repo/posts.ts` and in
 * `server/repo/images.ts`; `server/shop/orders/ids.ts` copied it for the first
 * of those reasons alone. The second is this subsystem's: spec D9 says
 * marketing never imports `server/shop/**` and shop never imports
 * `server/marketing/**`, so the orders copy is not available to be reused even
 * though it is exported. Exporting a four-line function from one of the private
 * files to serve both is an edit to somebody else's module for no behavioural
 * gain. `server/marketing/ids.test.ts` pins the shape against the same regex the
 * orders suite uses, so the copies are compared by property rather than trusted.
 *
 * The time prefix is what makes an id SORTABLE, which the keyset pagers depend
 * on: contract #4 and #17 order by `(created_at DESC, id DESC)` and the id is the
 * tie-breaker that keeps a page boundary stable when two rows share a
 * millisecond. It is not the uniqueness mechanism — the 64 bits after it are.
 */
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * The seven prefixes migration 0011 stamps into primary keys (spec §Database).
 *
 * THESE ARE DATA, NOT NAMES. An id is stored in nine tables, printed on the
 * returns queue as a mono badge, pasted into the `q` search box (contract #4
 * matches an exact `ret_` id), quoted in support conversations and copied into
 * the ledger's `return_request_id`. Changing one is a migration over every
 * existing row, so each is written out here and asserted literally in the test
 * rather than derived from a table name.
 *
 * None of them collides with the set `server/shop/orders/ids.ts` mints — which
 * matters because a marketing row holds the shop's ids beside its own
 * (`marketing_ledger.order_id`, `marketing_return_requests.customer_id`, both
 * TEXT with no FK per spec D10). The test asserts that against a written-out
 * copy of the shop's prefixes, since importing them is the coupling D9 forbids.
 *
 * `mmi_` rather than orders' `eml_` for an email intent, and `mev_` rather than
 * orders' `oev_` for a timeline row: the two subsystems keep parallel outboxes
 * and parallel histories, and an operator reading a log line should not have to
 * know which table a row came from.
 */
export const ID = {
  program: 'prg_',
  /** A return REQUEST. The lifecycle row, not an event about it. */
  return: 'ret_',
  /** A row of `marketing_return_events` — the customer-visible history. */
  timeline: 'mev_',
  /** A row of `marketing_ledger`. Points, hence `pts_`. */
  ledger: 'pts_',
  emailIntent: 'mmi_',
  banner: 'bnr_',
  discount: 'dsc_',
} as const;
