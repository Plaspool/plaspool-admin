import type { PaymentProviderName } from '../../data/api-shop';
import { ApiError } from '../../data/errors';

/**
 * PAYMENT GATEWAYS ON AN ORDER — their names, and what to say when one does
 * not refund. Kept beside the screens, like `courier-copy.ts`, so the refund
 * window and the cancel window cannot drift into two wordings of one answer.
 */

const GATEWAY_NAMES: Record<PaymentProviderName, string> = {
  paystack: 'Paystack',
  flutterwave: 'Flutterwave',
};

/**
 * The gateway's name, or `null` for a value this screen does not know — never
 * a guess. The order page said "Paystack" on every order, including the first
 * one Flutterwave took.
 */
export function gatewayName(provider: string | null | undefined): string | null {
  return provider === 'paystack' || provider === 'flutterwave' ? GATEWAY_NAMES[provider] : null;
}

/**
 * What a failed refund or cancel says about the money: `refused` (nothing was
 * sent), `unconfirmed` (it may have been, so the amount is held), or `null`
 * when the failure was not the gateway's. An outcome this screen does not know
 * reads as `unconfirmed` — the direction that cannot pay anyone twice.
 */
export function refundFailureOf(cause: unknown): 'refused' | 'unconfirmed' | null {
  if (!(cause instanceof ApiError) || cause.code !== 'refund_failed') return null;
  const outcome = (cause.body as { outcome?: unknown } | undefined)?.outcome;
  return outcome === 'refused' ? 'refused' : 'unconfirmed';
}

/**
 * The sentence for a failed refund or cancel.
 *
 * `422 refund_failed` means the gateway did not refund
 * (`server/shop/payments/refund-failure.ts`). Its body carries enumerated facts
 * and never the gateway's own words, so every sentence here is ours. `refused`
 * means nothing was sent. `unconfirmed` means money MAY have moved: the amount
 * is held (owner's rule, 2026-09-15) and the order page carries the note that
 * settles it, so the sentence points there. Anything else keeps the message
 * this screen always showed.
 */
export function describeRefundError(cause: unknown): string {
  const outcome = refundFailureOf(cause);
  if (!outcome) return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';

  const body = ((cause as ApiError).body ?? {}) as { provider?: unknown; code?: unknown };
  const name = gatewayName(typeof body.provider === 'string' ? body.provider : null) ?? 'The payment gateway';

  if (outcome === 'refused') {
    if (body.code === 'auth') return `${name} didn’t accept the shop’s secret key, so no money was sent.`;
    if (body.code === 'rate_limited') return `${name} is busy, so no money was sent. Try again in a minute.`;
    return `${name} refused this refund, so no money was sent.`;
  }
  return `${name} didn’t confirm this refund, so the money is held. See the note on this order.`;
}

/**
 * The note on an order holding a refund nobody could confirm. Names the gateway
 * the owner has to go and look at, because that dashboard is the only place the
 * answer is.
 */
export function heldRefundNote(gateway: string | null, amount: string, when: string): string {
  return gateway
    ? `${gateway} didn’t confirm the ${amount} refund from ${when}. The money is held so it can’t be refunded twice. Check this payment in your ${gateway} dashboard, then say what happened.`
    : `The payment gateway didn’t confirm the ${amount} refund from ${when}. The money is held so it can’t be refunded twice. Check this payment with the gateway, then say what happened.`;
}

/** The confirmation behind "It went through" and "It didn’t go through". */
export const RESOLVE_REFUND_COPY = {
  sent: {
    title: 'Mark the refund as sent?',
    confirm: 'Mark as sent',
    body: (gateway: string | null, amount: string) =>
      `Only do this if ${gateway ? `your ${gateway} dashboard` : 'the payment gateway'} shows the ${amount} refund. The order will show it as refunded, and the customer gets the refund email.`,
    done: 'Refund marked as sent',
  },
  not_sent: {
    title: 'Mark the refund as not sent?',
    confirm: 'Mark as not sent',
    body: (gateway: string | null, amount: string) =>
      `Only do this if ${gateway ? `your ${gateway} dashboard` : 'the payment gateway'} shows no refund for this payment. The ${amount} is released, so it can be refunded again.`,
    done: 'Refund marked as not sent. The money can be refunded again.',
  },
} as const;

/** The sentence when settling a held refund is refused. */
export function describeResolveError(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'refund_still_sending') {
    return 'This refund was sent less than a minute ago. Wait a minute, then try again.';
  }
  if (cause instanceof ApiError && cause.code === 'refund_not_unconfirmed') {
    return 'This refund has already been settled. Close this to see where it stands.';
  }
  return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
}
