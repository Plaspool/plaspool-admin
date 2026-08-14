import { MailNotConfiguredError } from '../mail/port';
import {
  AlreadyAwardedError,
  AreaInUseError,
  BelowMinimumError,
  DuplicateAreaError,
  DuplicateCodeError,
  DuplicateProgramKeyError,
  InsufficientBalanceError,
  InvalidTransitionError,
  OutsideServiceAreaError,
  ProgramPausedError,
  ProgramTypeMismatchError,
  RedemptionDisabledError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from './errors';

/**
 * Spec §Error catalogue, as a function — the marketing rows plus the one shared
 * error whose global rendering is wrong for this subsystem.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ITS OWN MODULE BECAUSE IT HAS TWO CALLERS AND THEY CANNOT IMPORT EACH OTHER.
 *
 * `app.ts` renders these in `onError`, one error per response. `POST
 * /returns/bulk` needs the SAME codes per ITEM — fifty transitions in one
 * request, each with its own outcome, none of which reaches an error handler
 * because the response is a 200 carrying a list of results. A bulk route that
 * imported `app.ts` would close an import cycle (`app.ts` mounts the returns
 * router), and one that spelled the codes itself would be a second catalogue
 * that drifts from the first the day a payload key changes.
 *
 * So the table lives here and both read it. There is exactly one place a
 * marketing error becomes a code.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** What a marketing error becomes on the wire, before the requestId is added. */
export interface Rendered {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Spec §Error catalogue, as a function — the eleven marketing rows plus the one
 * shared error whose global rendering is wrong for this subsystem.
 *
 * THE CODES AND THE PAYLOAD KEYS ARE A FROZEN CONTRACT, not a convention. Every
 * row here has a UI treatment written against it in the spec: `invalid_transition`
 * re-renders the true stage out of `request` and keeps a half-typed form alive
 * behind a notice; `return_already_open` links to `existingId` instead of
 * dead-ending; `below_minimum` interpolates `min` into copy built from the
 * program's own labels. A key dropped here is a screen that silently degrades to
 * "something went wrong", so `app.test.ts` asserts each body by EQUALITY rather
 * than by containment — an added key fails just as loudly as a missing one.
 *
 * NOTHING ELSE IS RENDERED HERE. `unauthenticated`, `forbidden`, `gone`,
 * `bad_request`, `stale_write` (the shared shape), `rate_limited` and `internal`
 * fall through to `toResponse`, which is the one implementation the whole
 * application shares — so a marketing route cannot grow its own dialect of the
 * rows every other route already answers. `rate_limited` in particular MUST fall
 * through: `toResponse` is where the `Retry-After` HEADER is set, and the public
 * intake's countdown reads it.
 */
export function renderMarketingError(err: unknown): Rendered | null {
  /*
   * 400, not 409. Nothing about the stored state refused this — the number in
   * the box is too small and a bigger one would be accepted. `min` travels
   * because the copy is interpolated from the PROGRAM's labels ("at least 4
   * canisters") and the client cannot know the minimum of a program it has not
   * fetched.
   */
  if (err instanceof BelowMinimumError) {
    return { status: 400, body: { error: 'below_minimum', detail: err.detail, min: err.min } };
  }

  /*
   * THE SIGNATURE 409. `request` is the re-read row, which is what lets the UI
   * auto-heal: it re-renders the true stage from the payload, says so in a
   * toast, and preserves mid-edit inputs behind a `.notice` rather than wiping
   * them to refetch (spec D7). Without the payload every conflict costs a second
   * round trip AND shows a third state — the one true at the time of that second
   * read — as though it were what the write lost to.
   */
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: {
        error: 'invalid_transition',
        status: err.status,
        action: err.action,
        request: err.request,
      },
    };
  }

  /*
   * The shared `stale_write` shape with the entity under its own name —
   * `program`, `settings`, `request`, `banner` or `discount` — because marketing
   * has five revisioned entities and none of them is a `post`. Same arrangement
   * as `StaleProductWriteError` in `server/shop/app.ts`, one entity wider.
   */
  if (err instanceof StaleMarketingWriteError) {
    return {
      status: 409,
      body: {
        error: 'stale_write',
        expected: err.expected,
        actual: err.actual,
        [err.entity]: err.current,
      },
    };
  }

  /*
   * A SUCCESS THE CLIENT MUST NOT MISREAD AS A FAILURE (spec D5). An inspection
   * replayed after a flaky connection answers this, and the screen refetches and
   * toasts "already recorded" — which is what makes retrying an inspection safe
   * to offer at all. `entryId` gives the success path the ledger row to link to.
   */
  if (err instanceof AlreadyAwardedError) {
    return { status: 409, body: { error: 'already_awarded', entryId: err.entryId } };
  }

  if (err instanceof ReturnAlreadyOpenError) {
    return {
      status: 409,
      body: { error: 'return_already_open', existingId: err.existingId, status: err.status },
    };
  }

  /* No payload, deliberately: the public storefront learns nothing about which
   * programs exist or why one is closed, and the admin's treatment is one link
   * to the status toggle regardless of which program refused. */
  if (err instanceof ProgramPausedError) {
    return { status: 409, body: { error: 'program_paused' } };
  }

  /* Reachable only by a race, and the wire carries no message BY DESIGN — spec
   * §Error catalogue makes the copy the client's, keyed on the code. */
  if (err instanceof ProgramTypeMismatchError) {
    return { status: 409, body: { error: 'program_type_mismatch' } };
  }

  if (err instanceof InsufficientBalanceError) {
    return { status: 409, body: { error: 'insufficient_balance', balance: err.balance } };
  }

  if (err instanceof RedemptionDisabledError) {
    return { status: 409, body: { error: 'redemption_disabled' } };
  }

  /*
   * 409 AND NOT THE 400 THE BASE CLASS WOULD GIVE. "That key is taken" is a
   * conflict with state; "that key has a capital letter in it" is a malformed
   * field. Collapsed into one answer the form can only say "the key was
   * refused", which sends somebody to inspect characters in a key whose sole
   * problem is that it exists — the defect `DuplicateSkuError` was raised for.
   *
   * NO `detail` KEY, unlike the shop's rendering of the same shape: the
   * catalogue freezes the extras as `key` alone and the client keys its inline
   * error off the CODE. An extra field here is a contract drift that no test on
   * the frontend would notice.
   */
  if (err instanceof DuplicateProgramKeyError) {
    return { status: 409, body: { error: 'duplicate_program_key', key: err.key } };
  }

  if (err instanceof DuplicateCodeError) {
    return { status: 409, body: { error: 'duplicate_code', code: err.code } };
  }

  /*
   * THE SERVICE-AREA GATE, ON THE WIRE. `served` is the list of places we
   * collect from RIGHT NOW, read on every refusal — an owner switching a
   * district off at nine must change the sentence at nine, and a served set the
   * client had cached would keep promising a van.
   *
   * Absent, unknown and switched-off all answer this, because to the person
   * reading it they are one sentence: "not there — try one of these".
   */
  if (err instanceof OutsideServiceAreaError) {
    return { status: 409, body: { error: 'outside_service_area', served: err.served } };
  }

  /* The count is the whole payload's job: it turns "cannot switch that off" into
   * "move these four first", which is an action rather than a wall. */
  if (err instanceof AreaInUseError) {
    return { status: 409, body: { error: 'area_in_use', open: err.open } };
  }

  /*
   * 409 AND NOT THE 400 THE BASE CLASS WOULD GIVE, the `duplicate_program_key`
   * argument exactly: "that area already exists" is a conflict with state, and
   * "that name has a stray character in it" is a malformed field. Collapsed into
   * one answer, a form can only say the name was refused — which sends somebody
   * hunting for characters in a name whose sole problem is that it is already
   * there.
   */
  if (err instanceof DuplicateAreaError) {
    return {
      status: 409,
      body: { error: 'duplicate_area', region: err.region, name: err.areaName },
    };
  }

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * THE ONE SHARED ERROR THIS SUBSYSTEM RE-RENDERS, and it is re-rendered
   * because the global answer is wrong HERE specifically.
   *
   * `server/middleware/errors.ts` maps `MailNotConfiguredError` to
   * `501 {error:'not_implemented', feature:'mail-delivery'}`. That is right for
   * the password-reset route, where an unconfigured mailer means the FEATURE is
   * unavailable and the caller can do nothing. It is wrong for the sweep, where
   * an unconfigured mailer means the deployment has queued mail it cannot
   * deliver yet and the admin has a setup step to perform — spec D6 makes that a
   * persistent ops banner ("email transport not configured — N notifications
   * queued"), never a retry loop, and Stream B keys that banner on
   * `mail_not_configured`.
   *
   * The `feature` key is dropped with it: A7's test pins the body as exactly
   * `{error:'mail_not_configured', requestId}`, because a second field naming
   * the same condition is a second thing to keep in step.
   *
   * The status stays 501. It is a configuration problem rather than a caller
   * problem, and it is permanent for this request — so the client's retry policy
   * stops, which is the whole point of not being a 500.
   * ═════════════════════════════════════════════════════════════════════════
   */
  if (err instanceof MailNotConfiguredError) {
    return { status: 501, body: { error: 'mail_not_configured' } };
  }

  return null;
}
