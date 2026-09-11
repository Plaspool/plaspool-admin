/**
 * A deterministic, in-process `PaymentProvider`. No network, no clock, no
 * randomness.
 *
 * WHY THIS IS NOT "A MOCK". `03-payments.md` §2 forbids offering a mock as a
 * co-equal alternative to a real provider, and this is not one: the real
 * provider was chosen through marketplace discovery and lives in
 * `paystack.ts`. This exists so that the ninety per cent of the subsystem that
 * is NOT the provider — the intent ladder, the dedupe, the out-of-order
 * resolution, the refund sum-check, every concurrency property this brief asks
 * to be proved — can be tested without a network, which §2 requires in the same
 * paragraph.
 *
 * IT DELIBERATELY MISBEHAVES ON DEMAND. A fake that only succeeds proves the
 * happy path and hides every branch that matters here. `program()` queues
 * outcomes so a test can say "this call times out, the next succeeds" and then
 * assert that the retry reused the key and charged once.
 *
 * IT COUNTS CALLS. `calls` is the assertion surface for the property that
 * matters most in this subsystem: not what was returned, but HOW MANY TIMES the
 * provider was asked.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from './scrub';
import { providerEventIdOf } from './paystack';
import type { ProviderErrorCode } from './scrub';
import type {
  CreateIntentRequest,
  PaymentProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderIntent,
  ProviderIntentStatus,
  ProviderRefund,
  ProviderRefundStatus,
  RefundRequest,
} from './types';

/**
 * One queued outcome. `ok` runs the normal path; `fail` throws before it.
 *
 * `field` MIRRORS `ProviderError.field` (admin#30 review): a test that queues
 * `{ code: 'invalid_request' }` with no `field` exercises the common case — a
 * 4xx Paystack returns for a reason that is NOT the email (a disabled
 * currency, an amount below the minimum) — and `field: 'email'` exercises the
 * one Paystack message this codebase positively recognises.
 */
export type FakeOutcome =
  | { kind: 'ok' }
  | { kind: 'fail'; code: ProviderErrorCode; field?: 'email' | null };

export interface FakeProviderOptions {
  /** Mirrors Paystack unless a test is exercising the other shape. */
  capabilities?: Partial<ProviderCapabilities>;
  /** The HMAC key for `parseWebhook`. Any non-empty string. */
  secretKey?: string;
  /** Optional name override. Defaults to 'fake'. */
  name?: string;
}

const DEFAULTS: ProviderCapabilities = {
  separateCapture: false,
  remoteCancel: false,
  partialRefunds: true,
  currencies: ['NGN', 'USD'],
};

export class FakeProvider implements PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /** Every call, in order, with the idempotency key it carried. */
  readonly calls: { op: string; ref: string; key: string | null; amount: number | null }[] = [];

  readonly #secretKey: string;
  readonly #intents = new Map<string, ProviderIntent>();
  readonly #refunds = new Map<string, ProviderRefund>();
  readonly #queued = new Map<string, FakeOutcome[]>();
  #refundSeq = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.name = options.name ?? 'fake';
    this.capabilities = { ...DEFAULTS, ...options.capabilities };
    this.#secretKey = options.secretKey ?? 'fake-secret-key';
  }

  /** Queue outcomes for the next N calls to `op`, consumed in order. */
  program(op: keyof PaymentProvider, ...outcomes: FakeOutcome[]): void {
    this.#queued.set(op, [...(this.#queued.get(op) ?? []), ...outcomes]);
  }

  /** How many times `op` was actually invoked — the double-charge assertion. */
  countOf(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /**
   * Move a charge, as a customer completing (or failing) a payment would.
   *
   * `paid` overrides what the gateway will then VERIFY was paid — an
   * underpayment, or the wrong currency — so the charge check (1140) can be
   * driven through `fetchIntent` exactly as a real verification reaches it.
   */
  settle(
    reference: string,
    status: ProviderIntentStatus,
    paid?: { amount?: number; currency?: string },
  ): void {
    const intent = this.#intents.get(reference);
    if (intent) this.#intents.set(reference, { ...intent, status, ...paid });
  }

  #gate(op: string): void {
    const next = this.#queued.get(op)?.shift();
    if (next?.kind === 'fail') {
      throw new ProviderError({
        code: next.code,
        provider: this.name,
        operation: op,
        field: next.field ?? null,
      });
    }
  }

  createIntent(req: CreateIntentRequest): Promise<ProviderIntent> {
    this.calls.push({ op: 'createIntent', ref: req.reference, key: null, amount: req.amount });
    this.#gate('createIntent');
    /*
     * The DUPLICATE-REFERENCE behaviour, mirrored from Paystack, because it is
     * what a retry of a lost `createIntent` actually hits. A fake that happily
     * created a second transaction under the same reference would let a
     * double-charge bug pass its tests.
     */
    const existing = this.#intents.get(req.reference);
    if (existing) {
      throw new ProviderError({
        code: 'duplicate_reference',
        provider: this.name,
        operation: 'createIntent',
      });
    }
    const intent: ProviderIntent = {
      providerIntentId: req.reference,
      status: 'requires_payment',
      amount: req.amount,
      currency: req.currency,
      authorizationUrl: `https://checkout.fake.test/${req.reference}`,
      failureReason: null,
    };
    this.#intents.set(req.reference, intent);
    return Promise.resolve(intent);
  }

  capture(providerIntentId: string, key: string): Promise<ProviderIntent> {
    this.calls.push({ op: 'capture', ref: providerIntentId, key, amount: null });
    if (!this.capabilities.separateCapture) {
      return Promise.reject(
        new ProviderError({ code: 'unsupported', provider: this.name, operation: 'capture' }),
      );
    }
    this.#gate('capture');
    return this.#settled(providerIntentId, 'captured', 'capture');
  }

  cancel(providerIntentId: string, key: string): Promise<ProviderIntent> {
    this.calls.push({ op: 'cancel', ref: providerIntentId, key, amount: null });
    if (!this.capabilities.remoteCancel) {
      return Promise.reject(
        new ProviderError({ code: 'unsupported', provider: this.name, operation: 'cancel' }),
      );
    }
    this.#gate('cancel');
    return this.#settled(providerIntentId, 'cancelled', 'cancel');
  }

  #settled(reference: string, status: ProviderIntentStatus, op: string): Promise<ProviderIntent> {
    const intent = this.#intents.get(reference);
    if (!intent) {
      return Promise.reject(
        new ProviderError({ code: 'invalid_request', provider: this.name, operation: op }),
      );
    }
    const next = { ...intent, status };
    this.#intents.set(reference, next);
    return Promise.resolve(next);
  }

  fetchIntent(providerIntentId: string): Promise<ProviderIntent> {
    this.calls.push({ op: 'fetchIntent', ref: providerIntentId, key: null, amount: null });
    this.#gate('fetchIntent');
    const intent = this.#intents.get(providerIntentId);
    return intent
      ? Promise.resolve(intent)
      : Promise.reject(
          new ProviderError({
            code: 'invalid_request',
            provider: this.name,
            operation: 'fetchIntent',
          }),
        );
  }

  refund(req: RefundRequest, key: string): Promise<ProviderRefund> {
    this.calls.push({ op: 'refund', ref: req.providerIntentId, key, amount: req.amount });
    this.#gate('refund');
    /*
     * NO DEDUPE ON `key`, exactly like Paystack: two calls make two refunds.
     * That is the hazard `shop_refunds.idempotency_key` exists to stop, and a
     * fake that deduped here would make the test that proves it vacuous.
     */
    this.#refundSeq += 1;
    const refund: ProviderRefund = {
      providerRefundId: `fkr_${this.#refundSeq}`,
      status: 'pending',
      amount: req.amount,
      currency: req.currency,
    };
    this.#refunds.set(refund.providerRefundId, refund);
    return Promise.resolve(refund);
  }

  /** Move a refund along, as the provider's async pipeline would. */
  settleRefund(providerRefundId: string, status: ProviderRefundStatus): void {
    const refund = this.#refunds.get(providerRefundId);
    if (refund) this.#refunds.set(providerRefundId, { ...refund, status });
  }

  /**
   * The same verify-then-parse shape as the real adapter, with the same HMAC.
   *
   * Kept faithful rather than stubbed out: the webhook route's tests drive THIS
   * method, so if it accepted an unsigned body the route's signature tests would
   * pass against a provider that checks nothing.
   */
  parseWebhook(raw: Uint8Array, headers: Headers): Promise<ProviderEvent> {
    const signature = headers.get('x-paystack-signature');
    const expected = createHmac('sha512', this.#secretKey).update(raw).digest();
    const provided = signature ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return Promise.reject(
        new ProviderError({
          code: 'signature_invalid',
          provider: this.name,
          operation: 'parseWebhook',
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return Promise.reject(
        new ProviderError({
          code: 'malformed_response',
          provider: this.name,
          operation: 'parseWebhook',
        }),
      );
    }

    const body = (parsed ?? {}) as { event?: unknown; data?: Record<string, unknown> };
    const event = typeof body.event === 'string' ? body.event : '';
    const data = body.data ?? {};
    const id = data.id;

    return Promise.resolve({
      /*
       * THE REAL DERIVATION, imported rather than re-implemented.
       *
       * This started out as its own rule — `${event}:${data.id}` — and a route
       * test caught the divergence: two `charge.success` bodies for one
       * reference deduped in production and did not here, so every webhook test
       * was validating a rule the deployed system does not use. A fake is
       * allowed to be simpler than the thing it stands in for; it is not allowed
       * to disagree with it about the property under test, and dedupe identity
       * is precisely what these tests are for.
       */
      providerEventId: providerEventIdOf(event, data, raw),
      type: event,
      providerIntentId:
        typeof data.reference === 'string'
          ? data.reference
          : typeof data.transaction_reference === 'string'
            ? data.transaction_reference
            : null,
      providerRefundId: event.startsWith('refund.') ? String(id ?? '') || null : null,
      intentStatus: event === 'charge.success' ? 'captured' : null,
      refundStatus: event.startsWith('refund.') ? fakeRefundStatus(data.status) : null,
      failureReason: null,
      amount: typeof data.amount === 'number' ? data.amount : null,
      currency: typeof data.currency === 'string' ? data.currency : null,
      payload: parsed,
    });
  }
}

function fakeRefundStatus(status: unknown): ProviderRefundStatus {
  if (status === 'processed') return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'pending';
}
