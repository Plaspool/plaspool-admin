/**
 * The provider-error seam. Nothing a provider throws reaches the rest of this
 * application without passing through here.
 *
 * WHAT THIS IS FOR, in the words of the incident it descends from. GAUNTLET II
 * Part 1 Round 1: `createUser` threw an error whose `message` AND `stack`
 * carried the account email and a live scrypt password hash, reachable by an
 * entirely ordinary sequence. Round 2: **the fix was one method wide** —
 * `guardDb` documented itself as the universal seam and intercepted only
 * `db.execute`, while `insert`/`select`/`update`/`delete`/`query.*` leaked
 * exactly the same values past it.
 *
 * A payments adapter is that hazard with worse contents. The values in flight
 * here are a live secret key (`sk_live_…`, which is total account
 * compromise — it can charge, refund and read every customer), a customer
 * email, and, if a provider ever echoes a request back in an error, a card
 * number and a CVC.
 *
 * SO THE ORIGINAL ERROR IS DISCARDED, NOT SANITISED — the same decision
 * `server/db/client.ts` documents for `DbError`, for the same reason. There is
 * no list of fields to strip that stays correct: a `fetch` rejection carries
 * the URL in `message`, an `AggregateError` carries N nested causes, a JSON
 * parse failure quotes the input, and the next provider SDK will invent a
 * property nobody has thought of. What survives is an ENUMERATED CODE and an
 * HTTP status — facts about the shape of the failure that cannot contain a
 * value, and which are what a log actually needs to identify it.
 *
 * AND THE SEAM IS THE WHOLE INTERFACE, NOT ONE METHOD. `scrubbedProvider()`
 * wraps every method of `PaymentProvider` through a proxy driven by
 * `PROVIDER_METHODS`, which is typed `Record<keyof PaymentProvider, true>` — so
 * adding a method to the interface without adding it there is a COMPILE error,
 * and `scrub.test.ts` drives every entry in it. That is the structural answer
 * to "the fix was one method wide": the list cannot fall behind the interface.
 */
import type { PaymentProvider } from './types';

/**
 * The shape of a provider failure, enumerated.
 *
 * EVERY ARM DECIDES A RETRY POLICY, and that is the point of enumerating them
 * rather than passing a message through. Contract §10: a 500 is retried five
 * times with backoff, so a permanent failure returned as a 500 is a request
 * retried forever that can never succeed — and on this subsystem the request
 * being retried is a CHARGE.
 */
export type ProviderErrorCode =
  /** Could not reach the provider at all. Safe to retry WITH THE SAME KEY. */
  | 'network'
  /** Sent, no answer. THE DANGEROUS ONE — see `isIndeterminate`. */
  | 'timeout'
  /** 401/403. The secret key is wrong or revoked. Permanent until a human acts. */
  | 'auth'
  /** 4xx. Malformed or unacceptable request. Permanent — never retry. */
  | 'invalid_request'
  /** The provider already has this reference. Permanent, and usually a success. */
  | 'duplicate_reference'
  /** 429. Retryable, after the provider's own delay. */
  | 'rate_limited'
  /** 5xx. The provider is unwell. Retryable. */
  | 'provider_unavailable'
  /** The instrument was refused. Permanent for this attempt. */
  | 'declined'
  /** A webhook body whose signature did not verify. Never retried, never parsed. */
  | 'signature_invalid'
  /** 2xx whose body was not the shape the contract promises. Permanent. */
  | 'malformed_response'
  /** This provider cannot do that at all — e.g. Paystack and a separate capture. */
  | 'unsupported'
  | 'unknown';

/** Codes for which re-sending the same idempotency key is safe and useful. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'network',
  'timeout',
  'rate_limited',
  'provider_unavailable',
]);

/**
 * Codes where WE DO NOT KNOW whether the operation happened.
 *
 * This is the case `03-payments.md` §5 singles out: "a provider call that
 * succeeded while the response was lost; only a key makes that recoverable." A
 * timeout is not a failure — it is an absence of information — and code that
 * treats it as a failure and moves on will refund twice, charge twice, or
 * report a customer unpaid who has paid. Callers must reconcile (re-send the
 * same key, or read the provider's own record) rather than assume.
 */
const INDETERMINATE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'timeout',
  'network',
]);

export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function isIndeterminate(code: ProviderErrorCode): boolean {
  return INDETERMINATE.has(code);
}

/**
 * A provider failure with every value removed.
 *
 * READ THE FIELD LIST AS A WHITELIST. There is no `cause`, no `body`, no
 * `response`, no `request`, no `detail` — not because those are stripped, but
 * because this object is CONSTRUCTED rather than derived, so a field can only
 * be here if somebody wrote it here. `Error.captureStackTrace` re-roots the
 * stack at this constructor, so the driver's stack — which is where
 * `DrizzleQueryError` hid its parameters — is not inherited either.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** Which adapter. A name, never a key. */
  readonly provider: string;
  /** Which adapter method. A method name, never an argument. */
  readonly operation: string;
  /** The HTTP status, when there was one. A number cannot carry a secret. */
  readonly status: number | null;
  readonly retryable: boolean;
  /** True when the operation's outcome is UNKNOWN, not known-failed. */
  readonly indeterminate: boolean;

  constructor(meta: {
    code: ProviderErrorCode;
    provider: string;
    operation: string;
    status?: number | null;
  }) {
    /*
     * The message is BUILT FROM THE ENUMERATED FIELDS, never passed in. A
     * `message` parameter is how a caller re-opens this: one
     * `new ProviderError({ ... }, err.message)` at a call site nobody reviews
     * and the response body is back in the log.
     */
    super(
      `${meta.provider}.${meta.operation} failed: ${meta.code}` +
        (meta.status != null ? ` (http ${meta.status})` : ''),
    );
    this.name = 'ProviderError';
    this.code = meta.code;
    this.provider = meta.provider;
    this.operation = meta.operation;
    this.status = meta.status ?? null;
    this.retryable = isRetryable(meta.code);
    this.indeterminate = isIndeterminate(meta.code);
    Error.captureStackTrace?.(this, ProviderError);
  }
}

/**
 * Turn anything at all into a `ProviderError`.
 *
 * An already-scrubbed `ProviderError` passes through unchanged — it was built
 * from enumerated fields and re-wrapping it would only lose the specific code
 * the adapter had already worked out. Everything else is DISCARDED and replaced
 * with `unknown`, including — deliberately — a `TypeError` from a bug in the
 * adapter itself. That costs some debuggability on a code path that has never
 * been the hard part, and it buys the property that there is no shape of thrown
 * value whose text can reach a log through this function.
 */
export function scrubProviderError(
  err: unknown,
  provider: string,
  operation: string,
): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError({ code: 'unknown', provider, operation });
}

/**
 * EVERY method of `PaymentProvider`.
 *
 * Typed `Record<keyof PaymentProvider, true>` on purpose: adding a method to
 * the interface and forgetting it here does not compile. That is the mechanical
 * guarantee that this seam cannot become one method wide the way `guardDb` did
 * — there, the interface was Drizzle's and could not be enumerated, so the list
 * was hand-maintained and fell behind.
 */
export const PROVIDER_METHODS: Record<keyof PaymentProvider, true> = {
  name: true,
  capabilities: true,
  createIntent: true,
  capture: true,
  cancel: true,
  refund: true,
  fetchIntent: true,
  parseWebhook: true,
};

/** The methods — the data properties (`name`, `capabilities`) are not wrapped. */
const NON_METHODS: ReadonlySet<string> = new Set(['name', 'capabilities']);

type AnyFn = (...args: never[]) => unknown;

/**
 * Wrap a provider so that no method of it can reject with anything but a
 * `ProviderError`.
 *
 * Both halves matter and the second is the one that gets forgotten: the `try`
 * catches a SYNCHRONOUS throw (an adapter that validates an argument before
 * awaiting anything), and the `.catch` catches the REJECTION (every network
 * failure). A wrapper with only the try/catch looks correct, passes a test that
 * throws synchronously, and lets every real provider error straight through.
 */
export function scrubbedProvider(inner: PaymentProvider): PaymentProvider {
  const wrapped = Object.create(null) as Record<string, unknown>;

  for (const key of Object.keys(PROVIDER_METHODS)) {
    if (NON_METHODS.has(key)) {
      wrapped[key] = inner[key as keyof PaymentProvider];
      continue;
    }
    const method = inner[key as keyof PaymentProvider] as AnyFn;
    wrapped[key] = (...args: never[]) => {
      try {
        const out = method.apply(inner, args);
        return out instanceof Promise
          ? out.catch((err: unknown) => {
              throw scrubProviderError(err, inner.name, key);
            })
          : out;
      } catch (err) {
        throw scrubProviderError(err, inner.name, key);
      }
    };
  }

  return wrapped as unknown as PaymentProvider;
}
