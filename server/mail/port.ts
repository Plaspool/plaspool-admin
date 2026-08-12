/**
 * Outbound mail, as a PORT.
 *
 * The same seam `ShopCartDeps.deliverMagicLink` uses, and for the same reason
 * spelled out in `server/shop/cart/routes/customer.ts`: a route that has to
 * deliver a credential to an address must NOT be testable by handing the
 * credential back in its own response body. Injecting the transport means the
 * suite drives the real route with a fake that records what was sent, and the
 * default is a transport that refuses rather than one that pretends.
 */

/** One message. `text` and `html` are both required: no client sees only one. */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;

  /**
   * Throw if this transport could not possibly deliver. OPTIONAL, and additive
   * to the interface the brief specifies — a fake mailer simply omits it.
   *
   * IT EXISTS TO CLOSE AN ENUMERATION ORACLE, which is the whole reason it is
   * not just left to `send` to discover. `POST /api/auth/forgot` answers 202 for
   * an address with no account, because anything else turns the endpoint into a
   * list of who has one. If the only place a missing `RESEND_API_KEY` surfaced
   * were inside `send`, then on an unconfigured deployment a KNOWN address would
   * 501 and an UNKNOWN one would 202 — the oracle rebuilt out of the failure
   * mode instead of the success one.
   *
   * So the route asks this question BEFORE it looks the user up, and an
   * unconfigured deployment answers 501 for every address alike. A misconfigured
   * server that is loudly broken for everybody is the acceptable outcome; one
   * that is quietly broken only for real accounts is not.
   */
  assertConfigured?(): void;
}

/**
 * 501 `{ error: 'not_implemented', feature }` — permanent, so the client's
 * retry policy stops rather than re-sending for thirty seconds (spec §8).
 *
 * Carries the NAMES of the missing variables and never their values, matching
 * `server/env.ts`.
 */
export class MailNotConfiguredError extends Error {
  readonly feature: string;

  constructor(missing: readonly string[]) {
    super(`mail delivery is not configured: ${missing.join(', ')}`);
    this.name = 'MailNotConfiguredError';
    this.feature = 'mail-delivery';
  }
}
