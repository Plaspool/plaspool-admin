/**
 * The errors this subsystem adds, and what each one costs a client.
 *
 * Contract §10: "Reuse the four in `server/repo/errors.ts`. Add new classes only
 * for genuinely new *client behaviour*, and when you do, say which HTTP status
 * and which client retry policy it implies."
 *
 * REUSED UNCHANGED, so they are not restated here: `NotFoundError` (404 `gone`),
 * `BadRequestError` (400 `bad_request`). Both already mean exactly what they
 * mean for a cart.
 *
 * NOT REUSED, and this is the only reason new classes exist: `StaleWriteError`
 * and `PreconditionFailedError` both carry a `Post` in a non-optional field
 * (`post: Post` on the precondition error). A cart is not a post, and widening
 * those types would edit `server/repo/errors.ts` — a file this subsystem does
 * not own (contract §2 R1) and which three other agents also depend on. So the
 * two shapes are mirrored here over a `CartSnapshot`, with the SAME status codes
 * and the SAME body keys, which is what keeps the existing client retry policy
 * correct without a line of client change:
 *
 * | Class                      | Status | Body                                                | Client policy |
 * |----------------------------|--------|-----------------------------------------------------|---------------|
 * | `CartStaleWriteError`      | 409    | `{ error:'stale_write', expected, actual, cart }`     | STOP, resolve |
 * | `CartPreconditionError`    | 409    | `{ error:'precondition_failed', operation, cart }`    | STOP, refused |
 * | `NotImplementedError`      | 501    | `{ error:'not_implemented', feature }`                | STOP, permanent |
 *
 * All three are 4xx/501 rather than 5xx on purpose. Spec §8's rule is that a 500
 * is TRANSIENT by the client's retry policy — retried five times with backoff —
 * so a permanent condition returned as a 500 is a request re-sent for thirty
 * seconds that can never succeed. Both prior gauntlets have an instance of that
 * bug (Part 2a Round 1 #1 and #3).
 *
 * DELIBERATELY ABSENT: an "insufficient stock" error. Brief §8 and the agent
 * prompt both make that a RETURN VALUE WITH A NUMBER IN IT, not an exception —
 * "only 2 left" is information the customer acts on, and an exception forces
 * every caller to reconstruct the number from a message.
 */

/** The cart as it is handed back inside a 409, so the client can re-render. */
export interface CartSnapshot {
  id: string;
  status: string;
  revision: number;
  currency: string;
}

/**
 * 409 `{ error:'stale_write', expected, actual, cart }`.
 *
 * The CAS lost: the stored cart moved on from the revision this write derived
 * from. Carries both sides and the current cart so the client re-renders with no
 * second round trip, exactly as `StaleWriteError` does for posts.
 */
export class CartStaleWriteError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly cart: CartSnapshot | null;

  constructor(expected: number, actual: number, cart: CartSnapshot | null = null) {
    super(`Stale cart write: based on revision ${expected}, store is at ${actual}`);
    this.name = 'CartStaleWriteError';
    this.expected = expected;
    this.actual = actual;
    this.cart = cart;
  }
}

/**
 * 409 `{ error:'precondition_failed', operation, cart }`.
 *
 * The transition was REFUSED, not lost: the cart is already in a state the
 * operation cannot act on — freezing a converted cart, adding a line to a cart
 * that is converting. A different message from `stale_write` and a different
 * action in the UI, which is why `server/repo/errors.ts` keeps the same two
 * apart and why this file does too.
 */
export class CartPreconditionError extends Error {
  readonly operation: string;
  readonly cart: CartSnapshot;

  constructor(operation: string, cart: CartSnapshot) {
    super(`Cannot ${operation}: the cart is ${cart.status}`);
    this.name = 'CartPreconditionError';
    this.operation = operation;
    this.cart = cart;
  }
}

/**
 * 501 `{ error:'not_implemented', feature }`.
 *
 * A route whose SHAPE is fixed by the brief but whose implementation needs
 * something this deployment does not have — magic-link delivery needs a mailer,
 * and there is none.
 *
 * 501 and not 503: 503 reads as "try again shortly" and a client that retries it
 * will retry forever, because nothing about this deployment is going to change
 * between attempts. 501 is permanent and names the missing feature, so the
 * failure is legible in a log rather than being an anonymous 500 — and so the
 * route cannot quietly pretend to have worked, which is the failure mode
 * GAUNTLET keeps recording as "a claim in the copy the code did not honour".
 */
export class NotImplementedError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`not implemented: ${feature}`);
    this.name = 'NotImplementedError';
    this.feature = feature;
  }
}
