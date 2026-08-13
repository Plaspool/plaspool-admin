import {
  BadRequestError,
  PreconditionFailedError,
  StaleWriteError,
} from '../repo/errors';
import type { Post } from '../../shared/types';
import type { DbMarketingReturnRequest } from './schema';

/**
 * Marketing's domain errors — the eleven rows of spec §Error catalogue that the
 * shared table in `server/middleware/errors.ts` has no name for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY CLASS HERE EXTENDS A SHARED ONE, and that is the safety property rather
 * than a stylistic tic (spec D7, and the `server/shop/catalog/errors.ts` idiom
 * these follow). `server/marketing/app.ts` renders each of them with the code
 * and the payload the catalogue freezes — but an error that ESCAPES that handler
 * still lands on the global `toResponse`, and there it has to become a 4xx.
 *
 * The reason is the client's retry policy, stated at the top of
 * `server/middleware/errors.ts`: a 5xx is retried five times over ~30 seconds
 * and a 4xx stops immediately. Every condition named in this file is PERMANENT
 * for the request that caused it — a return that is already awarded is still
 * already awarded thirty seconds later — so a 500 would spend half a minute
 * re-asking a question with one answer, and in the `already_awarded` case would
 * re-POST an inspection five times. Subclassed, the worst case is a correct
 * status with a blunter code.
 *
 * WHICH BASE, AND WHY:
 *
 * - the nine CONFLICTS extend `PreconditionFailedError` (409). Every one of them
 *   is the same sentence — "the state you are writing against is not the state
 *   you think it is" — which is exactly what that class is for. Fallback body
 *   `{error:'precondition_failed', operation}` names the attempted operation,
 *   so even the degraded answer is actionable.
 * - the two DUPLICATES and `BelowMinimumError` extend `BadRequestError` (400)
 *   carrying the field name in `detail`, which is the `DuplicateSkuError`
 *   precedent: the fallback lands on the same input the UI would highlight.
 *   The catalogue upgrades the duplicates to 409, because "already taken" is a
 *   conflict with state rather than a malformed field and the two need different
 *   words in a form.
 * - `StaleMarketingWriteError` extends `StaleWriteError`, so a CAS loss reaching
 *   the global handler is still the 409 with `expected` and `actual` that every
 *   conflict banner in this application already knows how to render.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The seven lifecycle statuses, taken from the COLUMN rather than restated.
 *
 * `marketing_return_requests.status` carries a CHECK naming exactly these
 * (migration 0011), so deriving the type from the declaration means a status
 * added to the database and a status the code can name cannot diverge — there is
 * one list, and it is the one the database enforces.
 */
export type ReturnStatus = DbMarketingReturnRequest['status'];

/**
 * What an admin may do to a return next (spec §Types `ReturnAction`).
 *
 * NO COLUMN TO DERIVE THIS FROM — it is computed, not stored: A4's
 * `allowedActionsFor(status)` serves it on every list row and on the detail so
 * the UI renders only what the server says is legal (spec D4). Declared HERE
 * because `InvalidTransitionError` is the first thing that needs to name one,
 * and a separate module for a seven-member union would be a file whose whole
 * content is this line.
 *
 * `collect` is the wire value; the UI renders it "Picked up" (spec D4). Display
 * labels are the client's business and never travel on the wire.
 */
export type ReturnAction =
  | 'schedule'
  | 'collect'
  | 'receive'
  | 'inspect'
  | 'reject'
  | 'cancel'
  | 'note';

/**
 * The revisioned entities a CAS write can lose against, by the NAME the payload
 * uses (spec §Error catalogue: `stale_write` carries `expected, actual,
 * <entity>`).
 *
 * A union rather than a free string so a route cannot invent `banners` where the
 * client reads `banner` and leave a conflict banner rendering nothing.
 */
export type MarketingEntity = 'program' | 'settings' | 'request' | 'banner' | 'discount';

/**
 * The CAS lost, and the caller gets the row that beat it — under its own name.
 *
 * The shared class carries a `Post` because spec §4.3 froze that shape for the
 * blog. Marketing has five revisioned entities and none of them is a post, so
 * the payload travels in `current` and the renderer spells it out under
 * `entity`: `{error:'stale_write', expected, actual, program}` for a program,
 * `…, banner}` for a banner. That is the `StaleProductWriteError` arrangement
 * with one more entity than it needed.
 *
 * CARRYING THE ROW IS NOT OPTIONAL. Spec D7: "every 409 carries the re-read
 * entity so no UI needs a second fetch" — the conflict notice renders "Load
 * theirs" straight out of this payload, and a client that had to re-GET would
 * show a third state (the one true at the time of the SECOND read) as if it were
 * what it had lost to.
 */
export class StaleMarketingWriteError extends StaleWriteError {
  readonly entity: MarketingEntity;
  /** The stored row, wire-shaped by the route that re-read it. */
  readonly current: object | null;

  constructor(
    expected: number,
    actual: number,
    entity: MarketingEntity,
    current: object | null,
  ) {
    /*
     * `post` on the base is deliberately null, exactly as
     * `StaleProductWriteError` leaves it. A program cast to a `Post` would put
     * the right data under a name whose fields it does not have, and a consumer
     * reading `body.post.excerptSource` would get `undefined` rather than an
     * error. Null is the honest value for "there is no post here".
     */
    super(expected, actual, null as Post | null);
    this.name = 'StaleMarketingWriteError';
    this.entity = entity;
    this.current = current;
  }
}

/**
 * The base for every marketing 409, and the one place the `Post` the shared
 * class demands is faked.
 *
 * CONTAINED, the way `ProductPreconditionFailedError` contains the same cast:
 * nothing reads `.post` on a marketing error, because the renderer that handles
 * these reads their own fields, and the global fallback only ever serialises it
 * — where `{}` is a strictly better answer than a return request masquerading as
 * a blog post. `operation` is the honest half of that fallback: it names what
 * was attempted, which is what a degraded client can still act on.
 */
export abstract class MarketingConflictError extends PreconditionFailedError {
  protected constructor(operation: string) {
    super(operation, {} as Post);
  }
}

/**
 * The action is not legal from the status the row is actually in — including the
 * brief's headline case, "cannot award before inspection".
 *
 * IT CARRIES THE RE-READ REQUEST, which is what makes the UI treatment in the
 * catalogue possible: the screen re-renders the true stage from `request`,
 * toasts "this return is now received", and — the part that makes it worth the
 * payload — keeps whatever the admin had half-typed behind a `.notice` instead
 * of wiping the form to refetch (spec D7).
 *
 * `request` is `object` rather than a named row type on purpose. A4 owns the
 * database row and A5 owns the wire shape it is serialised into, and this file
 * predates both; `object` still refuses `null`, `undefined` and a bare string,
 * which are the three ways this payload could arrive empty and leave the client
 * with a conflict it cannot render.
 */
export class InvalidTransitionError extends MarketingConflictError {
  readonly status: ReturnStatus;
  readonly action: ReturnAction;
  readonly request: object;

  constructor(status: ReturnStatus, action: ReturnAction, request: object) {
    super(action);
    this.name = 'InvalidTransitionError';
    this.status = status;
    this.action = action;
    this.request = request;
  }
}

/**
 * This email already has a return in flight (the partial unique on
 * `marketing_return_requests`, spec D4).
 *
 * IT CARRIES THE EXISTING ID SO THE UI CAN LINK TO IT. Without that the admin
 * dead-ends: "this customer already has an open return" and no way to reach it
 * except to go back and search. Spec §Error catalogue makes the link the
 * treatment — `?id=<existingId>` — and the public storefront copy is the softer
 * "you already have a return in progress".
 *
 * Flagged to the owner in spec D4: if concurrent returns per customer should be
 * allowed, the index is dropped and this error stops being reachable. It is a
 * business rule wearing an index, not an invariant.
 */
export class ReturnAlreadyOpenError extends MarketingConflictError {
  readonly existingId: string;
  readonly status: ReturnStatus;

  constructor(existingId: string, status: ReturnStatus) {
    super('create');
    this.name = 'ReturnAlreadyOpenError';
    this.existingId = existingId;
    this.status = status;
  }
}

/**
 * Fewer units than the program's `min_units_per_return`.
 *
 * A 400 AND NOT A 409: nothing about the stored state refused this, the number
 * in the box is simply too small, and the fix is to type a bigger one. It
 * carries `min` because the message is interpolated from the PROGRAM's labels —
 * "at least 4 canisters", "at least 3 crates", whatever this deployment calls
 * the thing being sent back — and the client cannot know the minimum of a
 * program it has not fetched (spec §Error catalogue, and the intake dialog's
 * error home in §UI). Even the EXAMPLES in this comment are renameable words:
 * no noun a customer reads may be written down in server source.
 *
 * `detail` is `qtyDeclared` on the base class, so a fallback through the global
 * handler still lands the inline error on the right input; only the interpolated
 * copy is lost.
 */
export class BelowMinimumError extends BadRequestError {
  readonly min: number;

  constructor(min: number) {
    super('qtyDeclared');
    this.name = 'BelowMinimumError';
    this.min = min;
  }
}

/**
 * The program is paused (or the settings name no default one, which is the same
 * condition from the caller's side: there is nothing accepting returns).
 *
 * NO PAYLOAD, deliberately. The public storefront must not learn which programs
 * exist or why one is closed — it hides the form and says "returns are paused".
 * The admin's treatment needs no payload either: it links to the program status
 * toggle, which is one screen regardless of which program refused.
 */
export class ProgramPausedError extends MarketingConflictError {
  constructor() {
    super('create');
    this.name = 'ProgramPausedError';
  }
}

/**
 * A return was created against an `adhoc` program — one that awards points by
 * hand and has no units to count.
 *
 * REACHABLE ONLY BY A RACE (the client filters the Select to `unit_return`
 * programs), which is precisely why the wire carries no message: spec §Error
 * catalogue makes the copy the CLIENT's, keyed on the code — "That program
 * doesn't take returns". A message field would be a second place to word it.
 */
export class ProgramTypeMismatchError extends MarketingConflictError {
  constructor() {
    super('create');
    this.name = 'ProgramTypeMismatchError';
  }
}

/**
 * The inspection already happened — a replay, not a mistake.
 *
 * THE CLIENT TREATS THIS AS SUCCESS (spec D5, and the catalogue's UI treatment):
 * refetch the detail, toast "already recorded", move on. That is what makes the
 * offline-retry story safe — the admin presses "Record & award" on a flaky
 * connection, the request lands twice, and the second answer is this rather than
 * a second award. The partial unique on `marketing_ledger` is the backstop that
 * makes double-awarding impossible even if this check were deleted (spec D3).
 *
 * `entryId` points at the ledger row the FIRST inspection wrote, so the success
 * path has something to link to.
 */
export class AlreadyAwardedError extends MarketingConflictError {
  readonly entryId: string;

  constructor(entryId: string) {
    super('inspect');
    this.name = 'AlreadyAwardedError';
    this.entryId = entryId;
  }
}

/**
 * The debit is larger than the balance.
 *
 * IT CARRIES THE LIVE BALANCE because the client's copy quotes it ("this
 * customer has 40") and because the number it was showing is by definition
 * stale — the debit that just failed proves somebody read the balance before
 * something else changed it. The guard itself is the `WHERE balance >= x` in the
 * debit statement (spec D3), so this error reports a refusal that already
 * happened rather than performing a check of its own.
 */
export class InsufficientBalanceError extends MarketingConflictError {
  readonly balance: number;

  constructor(balance: number) {
    super('debit');
    this.name = 'InsufficientBalanceError';
    this.balance = balance;
  }
}

/**
 * `redeem()` was called while redemption is switched off.
 *
 * DISTINCT FROM `quote()` RETURNING NULL, which is the ordinary way a disabled
 * deployment is discovered: checkout asks for a quote, gets null, and hides the
 * widget entirely. Reaching this means a redeem arrived without a live quote —
 * a race with the settings toggle, or a client that skipped the quote — and the
 * settings page is the fix path, not the cart.
 */
export class RedemptionDisabledError extends MarketingConflictError {
  constructor() {
    super('redeem');
    this.name = 'RedemptionDisabledError';
  }
}

/**
 * The program key is taken (`marketing_programs_key_uq`).
 *
 * THE KEY IS THE ONE THING ABOUT A PROGRAM THAT CANNOT BE RENAMED (spec D2a) —
 * the PATCH schema has no `key` field at all — so a collision at CREATE time is
 * the only moment this can be raised, and the only moment a human can still
 * choose differently. It carries the key so the form names what collided rather
 * than echoing what is currently in the input, which by then may have been
 * retyped.
 *
 * `BadRequestError` underneath with `detail: 'key'`, the `DuplicateSkuError`
 * arrangement: a mount without marketing's `onError` still answers a
 * retry-stopping 4xx aimed at the right field, and the catalogue upgrades it to
 * the 409 that "already exists" actually is.
 */
export class DuplicateProgramKeyError extends BadRequestError {
  readonly key: string;

  constructor(key: string) {
    super('key');
    this.name = 'DuplicateProgramKeyError';
    this.key = key;
  }
}

/** The discount code is taken. The same shape, and the same argument, as
 * `DuplicateProgramKeyError` — codes are normalised UPPERCASE before the
 * uniqueness is tested (contract #25), so `save10` and `SAVE10` collide. */
export class DuplicateCodeError extends BadRequestError {
  readonly code: string;

  constructor(code: string) {
    super('code');
    this.name = 'DuplicateCodeError';
    this.code = code;
  }
}
