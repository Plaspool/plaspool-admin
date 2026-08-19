import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_METHODS,
  ProviderError,
  isIndeterminate,
  isRetryable,
  scrubProviderError,
  scrubbedProvider,
} from './scrub';
import type { PaymentProvider } from './types';

/**
 * THE SCRUB, AND SPECIFICALLY THAT IT IS NOT ONE METHOD WIDE.
 *
 * `03-payments.md` §8 asks for "a scrub test asserting no provider error path
 * can emit a secret or a PAN", and the agent prompt sharpens it: "test that the
 * scrub is not one method wide". That wording is not rhetorical. GAUNTLET II
 * Part 1 Round 1 found an error carrying a live password hash; Round 2 found
 * the fix — `guardDb` — intercepted only `db.execute` while five sibling APIs
 * leaked identically, latent at HEAD and live the moment any later task used
 * the query builder. The docstring said "the universal seam" the whole time.
 *
 * So the central test below is driven from `PROVIDER_METHODS`, which is typed
 * `Record<keyof PaymentProvider, true>`. Adding a method to `PaymentProvider`
 * without adding it there does not compile; adding it there puts it in this
 * test automatically. The list cannot fall behind the interface, which is the
 * property `guardDb`'s hand-maintained list could not have.
 */

/** Values that must never survive a trip through the scrub. */
const SECRETS = {
  secretKey: 'sk_live_9f3a1c7e5b2d8046af19c3e75b0d2a84',
  pan: '4084084084084081',
  cvc: '408',
  email: 'victim@example.com',
} as const;

/**
 * Everything `console.error(err)` could possibly print.
 *
 * `inspect` with a deep depth and `showHidden`, PLUS the stack, PLUS a
 * JSON round trip. `middleware/errors.ts` logs named fields for exactly this
 * reason — a future error type carrying a `params` property must not be able to
 * re-open the leak by being handed to a logger whole — and this asserts the
 * property from the other side.
 */
function everythingPrintable(err: unknown): string {
  return [
    inspect(err, { depth: 10, showHidden: true }),
    err instanceof Error ? (err.stack ?? '') : '',
    err instanceof Error ? err.message : '',
    JSON.stringify(err, Object.getOwnPropertyNames(Object(err))),
  ].join('\n');
}

function expectNoSecrets(err: unknown, label: string): void {
  const text = everythingPrintable(err);
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(text, `${label} leaked ${name}`).not.toContain(value);
  }
}

/**
 * An error shaped like the ones that actually leak.
 *
 * Modelled on `DrizzleQueryError`, which carried the interpolated parameters in
 * its own `message` AND its `stack` AND a `params` array AND a `cause` holding
 * the driver's own message. Every one of those channels is populated here, so a
 * scrub that cleaned three of the four would fail this test.
 */
function leakyError(): Error {
  const cause = new Error(
    `Key (email)=(${SECRETS.email}) rejected; card ${SECRETS.pan} cvc ${SECRETS.cvc}`,
  );
  const err = new Error(
    `Failed request: POST /transaction/initialize\n` +
      `authorization: Bearer ${SECRETS.secretKey}\n` +
      `params: ${SECRETS.email},${SECRETS.pan}`,
    { cause },
  );
  Object.assign(err, {
    params: [SECRETS.email, SECRETS.pan, SECRETS.cvc],
    response: { body: `{"key":"${SECRETS.secretKey}"}` },
    config: { headers: { authorization: `Bearer ${SECRETS.secretKey}` } },
  });
  return err;
}

/** A provider whose every method fails the same way. */
function leakyProvider(mode: 'throw' | 'reject'): PaymentProvider {
  const fail = () => {
    if (mode === 'throw') throw leakyError();
    return Promise.reject(leakyError());
  };
  return {
    name: 'leaky',
    capabilities: { separateCapture: false, remoteCancel: false, partialRefunds: true },
    createIntent: fail,
    capture: fail,
    cancel: fail,
    refund: fail,
    fetchIntent: fail,
    parseWebhook: fail,
  } as unknown as PaymentProvider;
}

/** The methods, derived from the compile-checked list. */
const METHOD_NAMES = (Object.keys(PROVIDER_METHODS) as (keyof PaymentProvider)[]).filter(
  (k) => k !== 'name' && k !== 'capabilities',
);

async function invoke(provider: PaymentProvider, method: keyof PaymentProvider): Promise<unknown> {
  const fn = provider[method] as (...args: unknown[]) => unknown;
  // Arguments are shaped loosely on purpose: every implementation under test
  // fails before reading them, and the point is the failure path.
  return await fn.call(provider, {}, 'key');
}

describe('the scrub covers EVERY method of PaymentProvider, not one of them', () => {
  it('enumerates a method for each entry in the interface', () => {
    /*
     * A canary on the canary. If `PaymentProvider` gains a method,
     * `PROVIDER_METHODS` fails to compile until it is listed — and once listed
     * it appears here. This assertion exists so that a future reader can see
     * the count move rather than wondering whether the loop below is empty.
     */
    expect(METHOD_NAMES).toEqual([
      'createIntent',
      'capture',
      'cancel',
      'refund',
      'fetchIntent',
      'parseWebhook',
    ]);
  });

  for (const mode of ['throw', 'reject'] as const) {
    it(`converts a ${mode} from every method into a ProviderError with nothing in it`, async () => {
      /*
       * BOTH MODES, and the second is the one a naive wrapper misses. A
       * `try`/`catch` around a call catches a SYNCHRONOUS throw and lets every
       * asynchronous rejection — i.e. every real network failure — straight
       * through, while passing any test that only throws synchronously.
       */
      const wrapped = scrubbedProvider(leakyProvider(mode));
      for (const method of METHOD_NAMES) {
        const err = await invoke(wrapped, method).then(
          () => new Error('did not reject'),
          (e: unknown) => e,
        );
        expect(err, `${method} should have failed`).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).operation).toBe(method);
        expectNoSecrets(err, `${mode} from ${method}`);
      }
    });
  }

  it('leaves the raw error leaking, so the assertions above are not vacuous', () => {
    /*
     * THE CONTROL. Without this, a bug that made `everythingPrintable` return
     * '' would make every assertion above pass against a scrub that does
     * nothing. Part 2b's finding was precisely this shape: 254 tests green
     * against guards that had been replaced with `true`.
     */
    const text = everythingPrintable(leakyError());
    expect(text).toContain(SECRETS.secretKey);
    expect(text).toContain(SECRETS.pan);
    expect(text).toContain(SECRETS.cvc);
    expect(text).toContain(SECRETS.email);
  });

  it('does not wrap a successful return value', async () => {
    const inner = {
      name: 'ok',
      capabilities: { separateCapture: true, remoteCancel: true, partialRefunds: true },
      fetchIntent: () => Promise.resolve({ providerIntentId: 'ref_1' }),
    } as unknown as PaymentProvider;
    await expect(scrubbedProvider(inner).fetchIntent('ref_1')).resolves.toEqual({
      providerIntentId: 'ref_1',
    });
  });

  it('passes the data properties through untouched', () => {
    const inner = leakyProvider('reject');
    const wrapped = scrubbedProvider(inner);
    expect(wrapped.name).toBe('leaky');
    expect(wrapped.capabilities).toEqual(inner.capabilities);
  });
});

describe('ProviderError itself', () => {
  it('builds its message from enumerated fields and accepts no free text', () => {
    const err = new ProviderError({
      code: 'invalid_request',
      provider: 'paystack',
      operation: 'refund',
      status: 400,
    });
    expect(err.message).toBe('paystack.refund failed: invalid_request (http 400)');
    expect(err.stack).not.toContain('sk_live');
    // No channel exists for a body, a request or a cause — asserted rather than
    // assumed, because "there is no field for it" is the whole guarantee.
    expect(Object.keys(err).sort()).toEqual([
      'code',
      // Enumerated (`'email' | null`), and only ever set by matching a
      // provider message against a known field name — never carrying it
      // (admin#30 review).
      'field',
      'indeterminate',
      // `Error.name`, set by convention. Not the provider's name — that is
      // `provider`, and neither can hold a value.
      'name',
      'operation',
      'provider',
      'retryable',
      'status',
    ]);
    expect((err as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it('re-scrubbing an already-scrubbed error keeps its specific code', () => {
    const original = new ProviderError({
      code: 'duplicate_reference',
      provider: 'paystack',
      operation: 'createIntent',
    });
    expect(scrubProviderError(original, 'paystack', 'other')).toBe(original);
  });

  it('discards even a plain TypeError, because there is no safe shape to trust', () => {
    const scrubbed = scrubProviderError(new TypeError(SECRETS.secretKey), 'paystack', 'capture');
    expect(scrubbed.code).toBe('unknown');
    expectNoSecrets(scrubbed, 'TypeError');
  });

  it('discards a thrown non-Error — a string, an object, anything', () => {
    for (const thrown of [SECRETS.secretKey, { key: SECRETS.secretKey }, [SECRETS.pan], null]) {
      expectNoSecrets(scrubProviderError(thrown, 'paystack', 'refund'), `thrown ${typeof thrown}`);
    }
  });
});

describe('the retry policy each code implies', () => {
  it('marks transport failures retryable and refusals permanent', () => {
    /*
     * Contract §10: a 500 is retried five times with backoff, so a permanent
     * failure returned as one is a request retried forever that can never
     * succeed. On this subsystem the request being retried is a charge.
     */
    expect(isRetryable('network')).toBe(true);
    expect(isRetryable('rate_limited')).toBe(true);
    expect(isRetryable('provider_unavailable')).toBe(true);
    expect(isRetryable('invalid_request')).toBe(false);
    expect(isRetryable('declined')).toBe(false);
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('duplicate_reference')).toBe(false);
  });

  it('marks a timeout INDETERMINATE — the case that decides double charges', () => {
    /*
     * `03-payments.md` §5: "The dangerous case is a provider call that
     * succeeded while the response was lost." A timeout is not a failure, it is
     * an absence of information, and code that treats it as a failure will
     * refund twice.
     */
    expect(isIndeterminate('timeout')).toBe(true);
    expect(isIndeterminate('network')).toBe(true);
    expect(isIndeterminate('declined')).toBe(false);
    expect(isIndeterminate('invalid_request')).toBe(false);
  });
});
