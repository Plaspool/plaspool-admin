import { z } from 'zod';
import { zodDetail } from '../../../middleware/errors';
import { asCommerceEventType } from '../../../../shared/commerce/events';
import type { CommerceEventType } from '../../../../shared/commerce/events';

/**
 * THE INBOUND BOUNDARY. Every payload Cart reads out of `commerce_events` is
 * validated here, and nothing downstream trusts a field it did not come through.
 *
 * ═══ WHY VALIDATE SOMETHING THAT IS ALREADY TYPED ═══
 * `shared/commerce/events.ts` declares `PaymentCapturedPayload`, so the compiler
 * believes it knows the shape. It does not: the value arrived as a `jsonb`
 * column, written by a different subsystem, possibly by an older deploy of it,
 * possibly by a backfill, possibly by hand at 2am. A compile-time type over data
 * that crossed a database is exactly the "validator and a database disagreeing
 * about what is storable" seam every round of both gauntlets has found.
 *
 * The declared type is what this is CHECKED AGAINST — see the assignability
 * assertion at the bottom — not what it assumes.
 *
 * ═══ ONLY WHAT CART USES ═══
 * Cart needs `checkoutId` and nothing else: the amount is Payments' business and
 * the lines are already frozen on the cart. `.passthrough()` rather than
 * `.strict()`, deliberately — a field Payments adds later must not park every
 * capture until Cart redeploys, which is precisely the "ship an event type
 * before the consumer knows about it" property contract §6 rule 4 exists for.
 *
 * NOTHING HERE RE-CHECKS FOR U+0000. It cannot be present: the payload came out
 * of a `jsonb` column and Postgres refuses a NUL inside a jsonb string outright
 * (SQLSTATE 22P05).
 */

/** `detail` names a FIELD PATH and never a value. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

function run<T>(schema: z.ZodType<T>, payload: unknown): Parsed<T> {
  const parsed = schema.safeParse(payload);
  /*
   * `zodDetail` rather than `error.message`, and imported rather than
   * re-derived: Zod quotes the offending input for several issue codes, and one
   * of the things flowing through this outbox is a customer's postal address. A
   * `detail` column built from a Zod message is a customer record in a table
   * nobody audited.
   */
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, detail: zodDetail(parsed.error) };
}

/**
 * Bounded, because it becomes a `WHERE cart_id = $1` and `shop_carts.id` is a
 * `crt_…` id of known length. An unbounded string here is an unbounded
 * parameter on a path a stranger's outbox row can reach.
 */
const CheckoutId = z.string().min(1).max(128);

const PaymentCaptured = z
  .object({ checkoutId: CheckoutId })
  .passthrough();

export interface CapturedEvent {
  checkoutId: string;
}

export function parsePaymentCaptured(payload: unknown): Parsed<CapturedEvent> {
  return run(PaymentCaptured, payload) as Parsed<CapturedEvent>;
}

/**
 * The types Cart acts on. Everything else — including Cart's own
 * `checkout.completed` — is ignored and logged (contract §6 rule 4).
 *
 * `payment.failed` IS ABSENT ON PURPOSE, and it is the one decision in this file
 * worth arguing with. Releasing a hold when a payment fails would return stock
 * quickly, which sounds strictly better. It is not: Payments' own note in
 * `shared/commerce/ports.ts` records that `failed → captured` is a real
 * transition, because a provider lets a customer retry a failed attempt on the
 * same reference. Releasing on failure hands the last unit to somebody else
 * while the first customer is still typing their card number. The 15-minute TTL
 * reclaims an abandoned checkout, and that is the mechanism for it.
 */
export const CONSUMED_TYPES: readonly CommerceEventType[] = ['payment.captured'];

export function isConsumed(type: string): boolean {
  const known = asCommerceEventType(type);
  return known !== null && CONSUMED_TYPES.includes(known);
}

/*
 * The assignability check contract §6 asks for without saying so: if Payments
 * narrows `PaymentCapturedPayload`, this stops compiling rather than parking
 * every capture at runtime. A type-only statement — it emits nothing.
 */
type _CapturedIsAssignable =
  import('../../../../shared/commerce/events').PaymentCapturedPayload extends CapturedEvent
    ? true
    : never;
const _capturedIsAssignable: _CapturedIsAssignable = true;
void _capturedIsAssignable;
