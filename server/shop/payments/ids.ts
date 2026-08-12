import { randomBytes } from 'node:crypto';

/**
 * Prefixed, client-safe, monotonic ids (contract §10).
 *
 * ULID-SHAPED, AND THE SORT ORDER IS LOAD-BEARING FOR ONE OF THEM. Contract §6
 * describes `commerce_events.id` as "ULID-ish, monotonic", and a consumer
 * draining the outbox orders by it: if id order is not time order, a consumer
 * that resumes from "the last id I processed" skips events. A UUIDv4 would be
 * unique and useless for that.
 *
 * 48 bits of epoch-milliseconds, base32, then 80 bits of randomness. Crockford's
 * alphabet, which is base32 with `I`, `L`, `O` and `U` removed so that an id
 * read aloud off a dashboard or copied out of a log cannot be transcribed into
 * a different one.
 *
 * WITHIN one millisecond, order is random rather than monotonic. That is the
 * ordinary ULID trade and it is fine here for the reason the outbox already has
 * to be safe against: contract §6 rule 2 makes consumers idempotent on
 * `(consumer, eventId)`, because at-least-once is the guarantee. A consumer that
 * needed a total order would be a consumer relying on something the delivery
 * model does not promise.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_BYTES);
  let out = '';
  for (const byte of bytes) {
    // Two base32 characters per byte: 4 high bits, 4 low bits, each widened
    // into the 32-character alphabet. Wasteful of entropy per character and
    // deliberately simple — 80 bits of randomness is the budget, not 8 × 5.
    out += CROCKFORD[byte >> 3] + CROCKFORD[((byte & 0b111) << 2) % 32];
  }
  return out;
}

/**
 * `<prefix>_<26 chars>`.
 *
 * @param now injected rather than read from `Date.now()` so a test can pin the
 * time half and assert the ordering property directly, instead of sleeping.
 */
export function mintId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${encodeTime(now)}${encodeRandom()}`;
}

/** A payment intent. `pi_` is fixed by contract §10. */
export const intentId = (now?: number): string => mintId('pi', now);

/** An outbox event. `evt_` is fixed by contract §10. */
export const eventId = (now?: number): string => mintId('evt', now);

/**
 * A refund, and a row of the raw provider log.
 *
 * Neither prefix is in contract §10's list, which enumerates the CLIENT-FACING
 * aggregates and stops. These follow the same convention rather than inventing
 * a second one; if §10 is ever extended, `rfd` and `pev` are the names to add.
 */
export const refundId = (now?: number): string => mintId('rfd', now);
export const paymentEventId = (now?: number): string => mintId('pev', now);

/**
 * The provider-facing reference for an intent. DERIVED, never random.
 *
 * This is the provider-side half of idempotency (`03-payments.md` §5). Paystack
 * has no `Idempotency-Key` header; what it has is a unique `reference`, and it
 * refuses one it has already seen. So a retry of a `createIntent` whose response
 * was lost must present the SAME reference — which it does automatically,
 * because the reference is a pure function of the intent id rather than
 * something minted per attempt. A random reference per attempt would turn every
 * timeout into a second transaction.
 *
 * Paystack accepts only `-`, `.`, `=` and alphanumerics; the ids minted above
 * are alphanumeric plus one `_`, so the underscore is swapped for a `-`.
 */
export function providerReferenceFor(intent: string): string {
  return intent.replace(/_/g, '-');
}
