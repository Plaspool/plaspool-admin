import { BadRequestError } from '../../repo/errors';

/**
 * Customer-facing order numbers (brief §3): `2026-000042-K`.
 *
 * `ord_01H…` is not acceptable on an invoice, and neither is a random string —
 * brief §3 is explicit that the number has to survive being read over the phone.
 * So: a year, a zero-padded sequence, and a check character.
 *
 * THE SEQUENCE COMES FROM A POSTGRES SEQUENCE, NOT `MAX(...) + 1`. That is the
 * same race GAUNTLET II Part 2a measured on slugs — every concurrent writer reads
 * the same taken set and picks the same next candidate; at N=25 it produced 22
 * failures. `nextval` is atomic and never returns a value twice. It also does not
 * roll back, so a lost insert burns a number rather than handing it to somebody
 * else: gaps in an invoice sequence are ordinary, duplicates are not.
 *
 * THE NUMBER IS BUILT HERE AND NOT IN SQL, deliberately. The check character could
 * be computed by a plpgsql function, which would let the whole insert be one
 * statement — but it would be a SECOND IMPLEMENTATION of this arithmetic, and
 * `server/repo/query.ts` records what that costs: two copies of a sort key that
 * disagree become a page boundary that skips rows, with no error anywhere. One
 * implementation, called with a value the database minted.
 *
 * WHAT THE NUMBER IS NOT: an authorization token. It is sequential by construction
 * and therefore guessable, which is why every lookup is scoped by the resolved
 * customer id in the SQL or by a signed single-order token (brief §6). Brief §3
 * offers exactly this trade — "keep the sequence but require the email or a token
 * to look one up" — and it is the trade taken.
 */

/**
 * 23 characters, prime count, and the three worst confusions removed: no `I`
 * (reads as 1), no `O` (reads as 0), no `Z` (reads as 2).
 *
 * PRIME IS WHAT MAKES THE PROPERTY PROVABLE rather than plausible. With a prime
 * modulus and distinct non-zero positional weights:
 *
 * - every single-digit substitution changes the weighted sum, because `w · δ ≢ 0
 *   (mod 23)` when `0 < |δ| ≤ 9` and `0 < w ≤ 11` — both are below 23, so neither
 *   factor can be a zero divisor;
 * - every transposition of two ADJACENT DISTINCT digits changes it too, by
 *   `(w_i − w_{i+1})(d_{i+1} − d_i) = ±(d_{i+1} − d_i)`, which is non-zero mod 23
 *   for the same reason.
 *
 * A composite modulus loses both guarantees (with 24, `w · δ` is 0 whenever
 * `w · δ` is a multiple of 24 — e.g. weight 8, δ 3). `order-number.test.ts`
 * censuses both classes exhaustively rather than trusting this paragraph.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXY';

const MODULUS = ALPHABET.length; // 23

/** Six digits carries a million orders a year before the format has to change. */
const SEQUENCE_DIGITS = 6;

/**
 * `2026` + `000042` → the check character for `2026000042`.
 *
 * Weights start at 2 rather than 1 so that no position is weighted 1 — a weight of
 * 1 on the last digit would make the check character equal to that digit's
 * contribution alone in a way that reads as a pattern.
 */
export function checkCharacter(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += (digits.charCodeAt(i) - 48) * (i + 2);
  }
  return ALPHABET[sum % MODULUS];
}

export function formatOrderNumber(year: number, sequence: number): string {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError('an order number needs a four-digit year');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError('an order number needs a non-negative sequence');
  }
  const padded = String(sequence).padStart(SEQUENCE_DIGITS, '0');
  return `${year}-${padded}-${checkCharacter(`${year}${padded}`)}`;
}

export interface ParsedOrderNumber {
  year: number;
  sequence: number;
}

/**
 * `null` for anything that is not an order number this module produced.
 *
 * NULL AND NOT A THROW, because the value arrives in a URL path and the malformed
 * case is ordinary rather than exceptional. `requireOrderNumber` is the half that
 * has to answer a request.
 *
 * The sequence is deliberately NOT length-limited beyond the padding: a shop that
 * outgrows six digits should keep working, and `2026-1000000-x` still parses. What
 * is refused is anything whose check character does not match, which is what stops
 * a mistyped number becoming a lookup against somebody else's order.
 */
export function parseOrderNumber(value: string): ParsedOrderNumber | null {
  const match = /^(\d{4})-(\d{6,})-([A-Z])$/.exec(value);
  if (!match) return null;
  const [, yearText, sequenceText, check] = match;
  if (checkCharacter(`${yearText}${sequenceText}`) !== check) return null;
  const year = Number(yearText);
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) return null;
  return { year, sequence };
}

/**
 * The order number, or a 400.
 *
 * A 400 AND NOT A 404, and the distinction is load-bearing rather than pedantic.
 * `2026-000042-Q` when the real one ends `K` is a MALFORMED REQUEST — the check
 * character proves it was mistyped, without touching the database. Answering 404
 * would mean a typo and a genuine miss are the same answer, and a client would
 * have no way to tell "you typed it wrong" from "that order is not yours".
 *
 * It also removes a database round trip from the enumeration path: 22 of every 23
 * guessed numbers are refused before a query runs.
 */
export function requireOrderNumber(value: string): string {
  if (parseOrderNumber(value) === null) throw new BadRequestError('orderNumber');
  return value;
}
