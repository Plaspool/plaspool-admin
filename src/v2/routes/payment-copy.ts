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
 * The sentence for a failed refund or cancel.
 *
 * `422 refund_failed` means the gateway did not refund
 * (`server/shop/payments/refund-failure.ts`). Its body carries enumerated facts
 * and never the gateway's own words, so every sentence here is ours. `outcome`
 * decides the advice: `refused` means nothing was sent; `unconfirmed` means
 * money MAY have moved, so the owner looks at the gateway before trying again.
 * Anything else keeps the message this screen always showed.
 */
export function describeRefundError(cause: unknown): string {
  if (!(cause instanceof ApiError) || cause.code !== 'refund_failed') {
    return cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
  }
  const body = (cause.body ?? {}) as { provider?: unknown; outcome?: unknown; code?: unknown };
  const known = gatewayName(typeof body.provider === 'string' ? body.provider : null);
  const name = known ?? 'The payment gateway';

  if (body.outcome === 'refused') {
    if (body.code === 'auth') return `${name} didn’t accept the shop’s secret key, so no money was sent.`;
    if (body.code === 'rate_limited') return `${name} is busy, so no money was sent. Try again in a minute.`;
    return `${name} refused this refund, so no money was sent.`;
  }
  return known
    ? `${known} didn’t confirm this refund. Check the payment in your ${known} dashboard before trying again.`
    : 'The payment gateway didn’t confirm this refund. Check the payment there before trying again.';
}
