/**
 * Epoch milliseconds → something a person reads, and it CANNOT THROW.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS EXISTS TO DOWNGRADE.
 *
 * `Intl.DateTimeFormat.prototype.format` throws `RangeError: Invalid time
 * value` on an invalid date — it does not return `"Invalid Date"` the way
 * `Date.prototype.toString` does. So `WHEN.format(new Date(row.placedAt))`
 * against a row whose `placedAt` is `undefined` is not a blank cell. It is a
 * render-time exception, which React escalates to the nearest error boundary,
 * which on this app is a whole-screen "This screen ran into a problem".
 *
 * That is exactly how `/shop/orders` died in production: one mistyped client
 * type (`Page<ShopOrder>` over a `{ order, lines }` payload — see
 * `api-shop.ts`), one `undefined` field, and the entire orders surface was
 * unreachable. The wrong type was the bug; the throwing formatter is what
 * turned a wrong column into an outage.
 *
 * A date this app cannot render is a defect either way. The question is only
 * whether the operator sees FIVE ORDERS WITH ONE ODD-LOOKING COLUMN — and can
 * still pack them, and can still report it — or an error page and no shop. This
 * module chooses the first, everywhere, by construction.
 *
 * DATES WERE ONLY HALF OF THAT SCREEN, AND THE OTHER HALF LIVES WITH MONEY.
 * "Everywhere" was written here and was true of one column: the same order row
 * that survives a broken `placedAt` still took `/shop/orders` to its error
 * boundary through a broken `grandTotal`, because `formatMinor` throws
 * `MoneyShapeError` and a throw during render is a throw during render whatever
 * kind of value provoked it. `safeFormatMinor` in `api-shop.ts` is the money
 * twin of `safeFormat` below and returns the same constant. It is NOT in this
 * file, and that is deliberate: formatting an amount needs the currency's
 * exponent, its grouping and its symbol, all of which already live beside
 * `formatMinor`, and a second copy of that knowledge here would be exactly the
 * duplication `api-shop.ts`'s own money header exists to refuse. The
 * PLACEHOLDER is shared; the formatters stay where their subject matter is.
 *
 * IT IS NOT A LICENCE TO PASS RUBBISH IN. `isRenderable` is exported so a test
 * can assert on the decision directly, and callers that genuinely must know
 * (rather than display) should check the number themselves.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * THE PLACEHOLDER, FOR ANY VALUE THIS APP CANNOT RENDER — a date, an amount, and
 * whatever the next kind turns out to be. An EN DASH, not "Invalid Date" and not
 * an empty string.
 *
 * Empty reads as "this row has no value", which for `fulfilledAt` on an unshipped
 * order is TRUE and must stay distinguishable from "this value is broken" — so
 * absent and unrenderable deliberately look different: callers pass `null` for
 * absent and get whatever they asked for, while a broken value gets this.
 *
 * ONE CONSTANT, NOT ONE PER KIND OF VALUE. It was named for dates while dates
 * were the only thing that could fail to render. Money joining it could have
 * been a second constant beside this one holding the same two characters — and
 * that is a second thing to keep in step and the first one to be missed the day
 * somebody decides an em dash reads better. The operator cannot tell a broken
 * date from a broken total in the table either, and does not need to: the answer
 * to both is "report this row", not "read it differently". `api-shop.ts`
 * imports this rather than declaring its own.
 */
export const UNRENDERABLE = '––';

/**
 * Is this a number `new Date()` can turn into a date `Intl` will format?
 *
 * The three ways it fails, all of which have reached a screen in this codebase's
 * lifetime: `undefined`/`null` from a field that was not on the payload, `NaN`
 * from `Number(someString)`, and a finite number outside the ±8.64e15 ms the
 * ECMAScript time range allows (`Date` clamps nothing — it produces `NaN`).
 */
export function isRenderable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

/** `Intl.DateTimeFormat.format`, made total. */
export function safeFormat(fmt: Intl.DateTimeFormat, value: unknown): string {
  return isRenderable(value) ? fmt.format(new Date(value)) : UNRENDERABLE;
}

/**
 * The same value as an ISO string for a `<time datetime>` attribute, or
 * `undefined` so the attribute is omitted rather than written empty.
 */
export function isoAttr(value: unknown): string | undefined {
  return isRenderable(value) ? new Date(value).toISOString() : undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "4 minutes", "3 hours", "6 days" — the AGE of something, unsigned and
 * unqualified, for a caller that supplies its own "ago" or "waiting".
 *
 * NOT `Intl.RelativeTimeFormat`, and that is a deliberate refusal rather than an
 * oversight. `RelativeTimeFormat` renders a value you have already bucketed, so
 * it does not save the bucketing — and its output ("in 3 hours", "3 hours ago")
 * carries a direction this caller does not always want: on a kanban card the
 * number is how long the parcel has been WAITING, and "3 hours ago" describes
 * the payment while the operator is reading it as the delay.
 *
 * Rounds DOWN, everywhere. An order that has waited 47 hours has waited "1 day",
 * not "2 days" — an ageing badge that overstates is one that cries wolf, and
 * this one drives a colour that means "chase this".
 */
export function ageLabel(from: unknown, now: number): string {
  if (!isRenderable(from) || !Number.isFinite(now)) return UNRENDERABLE;
  const ms = now - from;
  /*
   * EVERY NEGATIVE `ms` LANDS HERE, AND THAT IS THE WHOLE HANDLING OF SKEW. A
   * `from` in the future is the browser's clock disagreeing with the server's
   * epoch rather than a story to tell, so the least this can say is the right
   * amount to say — and `ms < MINUTE` is already true of every number below
   * zero.
   *
   * An explicit `if (ms < 0) return 'just now'` used to sit on the next line,
   * where it could never run. A dead branch that states an intent is worse than
   * no branch at all: it reads as the line that implements the intent, so the
   * line actually implementing it looks incidental and survives only until
   * somebody reorders the ladder. The intent is pinned by `when.test.ts`'s
   * "clock that runs backwards" case instead, where it cannot rot unnoticed.
   */
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  return plural(Math.floor(ms / DAY), 'day');
}

/** Whole days waited, floored; `null` when the input cannot be read. */
export function ageDays(from: unknown, now: number): number | null {
  if (!isRenderable(from) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - from) / DAY));
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
